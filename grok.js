// index.mjs
import "dotenv/config";
import fs from "fs/promises";
import OpenAI from "openai";

const XAI_API_KEY = process.env.XAI_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const MODEL = process.env.XAI_MODEL || "grok-4-1-fast-reasoning";

// xAI OpenAI互換
const client = new OpenAI({
  apiKey: XAI_API_KEY,
  baseURL: "https://api.x.ai/v1",
});

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// JSTの「昨日」(YYYY-MM-DD)
function jstYesterdayYYYYMMDD() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const d = jst.getUTCDate();

  // JST今日00:00（UTCに直す）
  const jstTodayMidnightUtc = Date.UTC(y, m, d) - 9 * 60 * 60 * 1000;
  const jstYesterdayMidnightUtc = jstTodayMidnightUtc - 24 * 60 * 60 * 1000;

  // JSTに戻して日付文字列
  const jy = new Date(jstYesterdayMidnightUtc + 9 * 60 * 60 * 1000);
  const yyyy = jy.getUTCFullYear();
  const mm = String(jy.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jy.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// JSTの「今日」(YYYY-MM-DD)（フォールバック用）
function jstTodayYYYYMMDD() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function looksEmptySummary(text) {
  if (!text) return true;
  const t = text.replace(/\s+/g, "");
  // 雑判定：0件っぽい文言、または「なし」だらけ
  const keywords = ["確認されませんでした", "該当投稿なし", "検索結果0件", "活動確認できず"];
  if (keywords.some((k) => t.includes(k))) return true;
  const nashiCount = (t.match(/なし/g) || []).length;
  return nashiCount >= 6;
}

async function grokSearchAndSummarize(handles, fromDay, toDay) {
  const tools = [{
    type: "x_search",
    allowed_x_handles: handles,
    from_date: fromDay,
    to_date: toDay,
  }];

  const input = [
    {
      role: "system",
      content:
        "あなたはX投稿の日次ダイジェスト作成AI。推測しない。\n" +
        "期間指定はツールの from_date/to_date で制限されている。\n" +
        "検索クエリには since/until や時刻、JSTなどの表記を入れない。\n" +
        "ハンドルは小文字で扱う。0件なら『検索結果0件』と明記する。",
    },
    {
      role: "user",
      content: `
対象ハンドル（${handles.join(", ")}）について、JSTの ${fromDay}〜${toDay} の投稿を X Search で調べて要約して。
（この範囲の中から、直近の重要ポストを優先）

- このバッチの要点（3行）
- 重要トピック（最大5件）
- 重要ポスト（最大8件、可能ならURL）
- キーワード（最大10個）
`,
    },
  ];

  const resp = await client.responses.create({
    model: MODEL,
    input,
    tools,
    temperature: 0.2,
    max_turns: 3,
  });

  return resp.output_text ?? "";
}

async function grokMergeFinal(day, batchSummaries, label) {
  const input = [
    {
      role: "system",
      content:
        "あなたは複数ソースの要約を統合し、Discordに貼りやすい短い日次まとめを作るAI。推測しない。冗長にしない。",
    },
    {
      role: "user",
      content: `
以下は、${label} JST ${day} の「複数アカウントのX投稿」をバッチごとに要約したもの。
これらを統合して Discord に1通で送れる最終版を作って。

【出力フォーマット】
# X日次まとめ (${day} JST) ${label}

## 全体の要点（3行）

## アカウント別ハイライト（15行以内）
- @handle: 1行

## 重要トピックTOP10
- 1行ずつ

## 重要リンク（最大10）
- 箇条書き（URLがあるもの優先）

※長くなりすぎる場合は、重要トピック→リンク→ハイライトの順で削る。
※0件が多い場合は「検索結果0件のアカウントが多い」旨を1行で書く。

【バッチ要約】
${batchSummaries.map((s, i) => `--- batch ${i + 1} ---\n${s}`).join("\n\n")}
`,
    },
  ];

  const resp = await client.responses.create({
    model: MODEL,
    input,
    temperature: 0.2,
  });

  return resp.output_text ?? "";
}

async function sendToDiscord(text) {
  if (!DISCORD_WEBHOOK_URL) throw new Error("DISCORD_WEBHOOK_URL が未設定です");
  // Discordのcontentは2000文字制限があるので安全に分割（1800で刻む）
  const chunks = [];
  for (let i = 0; i < text.length; i += 1800) chunks.push(text.slice(i, i + 1800));

  for (const c of chunks) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: c }),
    });
    if (!res.ok) throw new Error(`Discord webhook error: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  if (!XAI_API_KEY) throw new Error("XAI_API_KEY が未設定です");

  const handlesRaw = await fs.readFile("./handles.txt", "utf-8");
  const handles = handlesRaw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((h) => h.replace(/^@/, "").toLowerCase()); // ← 小文字に正規化（重要）

  if (handles.length === 0) throw new Error("handles.txt が空です");
  if (handles.length > 100) throw new Error("多すぎるので分割戦略を変えよう（今は最大100想定）");

  const groups = chunk(handles, 10); // allowed_x_handles 最大10

    const fromDay = jstYesterdayYYYYMMDD();
    const toDay = jstTodayYYYYMMDD();

    const batchSummaries = [];
    for (const g of groups) {
    const s = await grokSearchAndSummarize(g, fromDay, toDay);
    batchSummaries.push(s);
    await new Promise((r) => setTimeout(r, 350));
    }

    const finalMsg = await grokMergeFinal(`${fromDay}〜${toDay}`, batchSummaries, "（直近まとめ）");
    await sendToDiscord(finalMsg);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await sendToDiscord(`⚠️ X日次まとめ 失敗\n${String(e).slice(0, 1500)}`);
  } catch {}
  process.exit(1);
});
