// 途中メッセージから「大事なこと」を拾う 1段目：ルールでの粗い拾い出し。
// 文単位で判定し、最初に当たった種類を付ける（優先順は KINDS の並び）。
// 2段目の Haiku 分類（llm.mjs）が使えるときは、そちらの結果で置き換える。

export const KINDS = {
  question: { label: "確認", order: 0 },
  skip: { label: "スキップ", order: 1 },
  risk: { label: "懸念", order: 2 },
  assumption: { label: "仮定", order: 3 },
  discovery: { label: "発見", order: 4 },
};

const RULES = [
  [
    "question",
    /(ますか|ですか|でしょうか|ましょうか)[？?]|確認(して|を)?(ください|お願い)|ご確認|教えてください|ご判断|どちらに(しますか|しましょう)|should I\b|do you want|would you like|let me know|please confirm|which (one|option) /i,
  ],
  [
    "skip",
    /スキップ|未実行|未対応|未実装|未完了|後回し|対象外|省略し|見送|できませんでした|失敗(し|して|した|しま)|通りませんでした|TODO|skipp|not (yet )?(run|implemented|covered|tested)|couldn'?t|could not|unable to|out of scope|left (it|this|that) |still failing|failed/i,
  ],
  [
    "risk",
    /懸念|リスク|注意(が|点|して|すべき)|危険|破壊的|互換性|壊れ(る|ます|かね)|怪しい|気になる|副作用|本番(に|で)影響|warning|\brisk|caution|breaking change|side effect|security|race condition/i,
  ],
  [
    "assumption",
    /仮定|前提(と|に)し|想定し|ことにしました|ことにします|にしておきました|判断しました|決めました|代わりに|暫定|デフォルト(で|値)|仕様に(ない|ありません|記載)|明記されていない|指定がない|assum|instead of|\binstead\b|decided to|went with|defaulting to|for now/i,
  ],
  [
    "discovery",
    /見つかりました|見つけました|判明|発見|原因は|原因が|実は|ことが(分|わ)かりました|turns out|found that|root cause|I noticed|it appears that/i,
  ],
];

const MAX_PER_BLOCK = 4;
const MAX_LEN = 160;

export function splitSentences(text) {
  const noCode = String(text).replace(/```[\s\S]*?```/g, "\n");
  return noCode
    .split(/\n+|(?<=[。！？])|(?<=[.!?])\s+/)
    .map((s) =>
      s
        .replace(/^\s*([-*+]|\d+\.)\s+/, "")
        .replace(/^#+\s*/, "")
        .replace(/\*\*/g, "")
        .trim(),
    )
    .filter((s) => s.length >= 6);
}

export function extractByRules(text) {
  const out = [];
  const seen = new Set();
  for (const s of splitSentences(text)) {
    for (const [kind, re] of RULES) {
      if (re.test(s)) {
        const t = s.length > MAX_LEN ? s.slice(0, MAX_LEN - 1) + "…" : s;
        if (!seen.has(t)) {
          seen.add(t);
          out.push({ kind, text: t, by: "rule" });
        }
        break;
      }
    }
    if (out.length >= MAX_PER_BLOCK) break;
  }
  return out;
}
