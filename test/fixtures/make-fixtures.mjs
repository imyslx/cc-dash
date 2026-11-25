// デモとテスト用に、架空の会話記録とフックのイベントを「今」を基準に生成する。
//   node test/fixtures/make-fixtures.mjs [出力先ディレクトリ]
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] || dirname(fileURLToPath(import.meta.url)));
const variant = process.argv[3] || "mac"; // mac: 実装用の Mac 役 / win: 設計用の Windows 役
const projects = join(root, "projects");
const data = join(root, "data");
rmSync(projects, { recursive: true, force: true });
rmSync(join(data, "events.jsonl"), { force: true });
mkdirSync(data, { recursive: true });

const NOW = Date.now();
const min = (m) => NOW - m * 60_000;
const iso = (t) => new Date(t).toISOString();
let seq = 0;
const uid = () => `u${++seq}`;
const events = [];

function session(id, cwd, branch, build) {
  const lines = [];
  const base = { sessionId: id, cwd, gitBranch: branch, version: "2.1.0" };
  const api = {
    user: (t, text) => lines.push({ ...base, type: "user", uuid: uid(), timestamp: iso(t), message: { role: "user", content: text } }),
    say: (t, text) => lines.push({ ...base, type: "assistant", uuid: uid(), timestamp: iso(t), message: { role: "assistant", content: [{ type: "text", text }] } }),
    tool: (t, name, input, result = "ok") => {
      const tid = `toolu_${uid()}`;
      lines.push({ ...base, type: "assistant", uuid: uid(), timestamp: iso(t), message: { role: "assistant", content: [{ type: "tool_use", id: tid, name, input }] } });
      if (result !== null)
        lines.push({ ...base, type: "user", uuid: uid(), timestamp: iso(t + 2000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: result }] } });
    },
    title: (s) => lines.push({ type: "summary", summary: s, leafUuid: "x" }),
    ev: (t, event, extra = {}) => events.push({ ts: t, event, session_id: id, cwd, ...extra }),
  };
  build(api);
  const dir = join(projects, cwd.replace(/[/\\.:]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const todos = (items) => ({ todos: items.map(([content, status, activeForm]) => ({ content, status, activeForm })) });

if (variant === "mac") {
// 1) 返事待ち：仮定・スキップ・確認が混ざっている
session("a1b2c3d4-0001", "/Users/yota/work/ec-api", "feat/inventory-cache", (s) => {
  s.title("在庫API のキャッシュ層追加");
  s.ev(min(75), "SessionStart", { source: "startup" });
  s.ev(min(74), "UserPromptSubmit");
  s.user(min(74), "在庫APIが遅いのでキャッシュ入れたい。設計案ちょうだい");
  s.say(min(73), "既存の在庫取得処理とDBアクセスを確認します。");
  s.tool(min(73), "Read", { file_path: "/Users/yota/work/ec-api/src/inventory/service.ts" });
  s.tool(min(72), "Grep", { pattern: "getStock\\(" });
  s.say(min(71), "商品詳細ページで同じ在庫クエリが3回呼ばれていることが分かりました。まずはここを1回にまとめるだけでも効果があります。");
  s.say(min(69), "Redis 案とインメモリ案を比較しました。複数台構成なので Redis 案をおすすめします。どちらにしますか？");
  s.ev(min(69), "Stop");
  s.ev(min(60), "UserPromptSubmit");
  s.user(min(60), "Redis案でOK、実装して");
  s.tool(min(59), "TodoWrite", todos([["キャッシュ層の作成", "in_progress", "キャッシュ層を作成中"], ["無効化処理", "pending", "無効化処理を実装中"], ["単体テスト", "pending", "単体テストを追加中"], ["結合テスト", "pending", "結合テストを実行中"]]));
  s.tool(min(58), "Skill", { skill: "tdd" });
  s.say(min(57), "TTL は仕様に記載がないので、暫定で5分にしておきました。");
  s.tool(min(56), "Write", { file_path: "/Users/yota/work/ec-api/src/inventory/cache.ts" });
  s.tool(min(54), "Edit", { file_path: "/Users/yota/work/ec-api/src/inventory/service.ts" });
  s.say(min(52), "無効化は在庫更新APIからのみ行うことにしました。CSV の一括インポートは今回の対象外です。");
  s.tool(min(51), "TodoWrite", todos([["キャッシュ層の作成", "completed", ""], ["無効化処理", "completed", ""], ["単体テスト", "in_progress", "単体テストを追加中"], ["結合テスト", "pending", "結合テストを実行中"]]));
  s.tool(min(49), "Bash", { command: "npm test -- inventory" }, "12 passed");
  s.say(min(47), "単体テストを12件追加し、すべて通りました。");
  s.tool(min(46), "Bash", { command: "npm run test:e2e -- stock" }, "Error: connect ECONNREFUSED 127.0.0.1:6379");
  s.say(min(45), "E2E テスト1件はローカルに Redis がないため実行できず、スキップしています。CI では通る想定です。");
  s.tool(min(44), "Skill", { skill: "code-review" });
  s.tool(min(43), "TodoWrite", todos([["キャッシュ層の作成", "completed", ""], ["無効化処理", "completed", ""], ["単体テスト", "completed", ""], ["結合テスト", "in_progress", "結合テストを実行中"]]));
  s.say(min(42), "実装はここまでです。1点確認させてください：在庫0件のときもキャッシュしますか？ 売り切れ直後の再入荷が遅れて見えるリスクがあります。");
  s.ev(min(42), "Stop");
});

// 2) 作業中：Todo 進行中、直近にツール呼び出し
session("b2c3d4e5-0002", "/Users/yota/work/shop-assistant", "feat/recommend-mcp", (s) => {
  s.title("商品レコメンドの MCP ツール追加");
  s.ev(min(20), "UserPromptSubmit");
  s.user(min(20), "商品レコメンドの MCP ツールに、サイズ在庫のフィルタを足して");
  s.tool(min(19), "TodoWrite", todos([["スキーマ確認", "completed", ""], ["フィルタ実装", "in_progress", "サイズ在庫フィルタを実装中"], ["ツール定義の更新", "pending", ""], ["動作確認", "pending", ""], ["README 更新", "pending", ""]]));
  s.say(min(15), "在庫APIのレスポンスにサイズ別の在庫数が含まれていないことが判明しました。代わりに SKU 単位のエンドポイントを使います。");
  s.tool(min(12), "Edit", { file_path: "/Users/yota/work/shop-assistant/mcp/tools/recommend.ts" });
  s.tool(min(1), "Bash", { command: "pnpm vitest run mcp/tools" }, null);
});

// 3) 許可待ち
session("c3d4e5f6-0003", "/Users/yota/work/chat-apps", "main", (s) => {
  s.title("ChatGPT Apps のデプロイ設定");
  s.ev(min(9), "UserPromptSubmit");
  s.user(min(9), "staging にデプロイできるようにして");
  s.say(min(8), "デプロイ前に環境変数の差分を確認します。本番の値を誤って参照しないよう注意が必要です。");
  s.tool(min(6), "Bash", { command: "gcloud run deploy shop-mcp --region asia-northeast1" }, null);
  s.ev(min(6), "Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
});

// 4) 止まっている：Claude の番なのに10分動きがない
session("d4e5f6a7-0004", "/Users/yota/work/search-service", "fix/vector-index", (s) => {
  s.title("ベクトルインデックスの再構築バッチ");
  s.ev(min(25), "UserPromptSubmit");
  s.user(min(25), "インデックス再構築のバッチが途中で落ちるのを直して");
  s.say(min(18), "メモリ不足で落ちていました。バッチサイズを 1000 から 200 に下げます。");
  s.tool(min(11), "Bash", { command: "node scripts/rebuild-index.js --batch 200" }, null);
});

// 5) 見出しが同じセッション（区別用の添え字が付く）
session("e5f6a7b8-0005", "/Users/yota/work/ec-api", "feat/inventory-cache-v2", (s) => {
  s.title("在庫API のキャッシュ層追加");
  s.ev(min(130), "UserPromptSubmit");
  s.user(min(130), "前回のキャッシュ案、別ブランチで試作だけして");
  s.say(min(125), "試作しました。本番には入れない前提で、エラー処理は省略しています。");
  s.ev(min(125), "Stop");
});

// 6) 区切り：8時間前
session("f6a7b8c9-0006", "/Users/yota/work/docs", "main", (s) => {
  s.title("ADR テンプレートの整理");
  s.ev(min(500), "UserPromptSubmit");
  s.user(min(500), "ADR のテンプレートを整えて");
  s.say(min(495), "テンプレートを整理しました。");
  s.ev(min(495), "Stop");
});

}

if (variant === "win") {
  // Windows 役：VS Code 拡張で設計作業
  session("w1a2b3c4-0101", "C:\\Users\\yota\\design\\shop-assistant-ux", "main", (s) => {
    s.title("レコメンド画面の情報設計");
    s.ev(min(30), "UserPromptSubmit");
    s.user(min(30), "レコメンド画面のワイヤーの構成案を3つ出して");
    s.tool(min(29), "TodoWrite", todos([["既存画面の確認", "completed", ""], ["構成案を作成", "completed", ""], ["比較表を作成", "completed", ""]]));
    s.tool(min(27), "Read", { file_path: "C:\\Users\\yota\\design\\shop-assistant-ux\\docs\\persona.md" });
    s.say(min(24), "ペルソナ資料に、サイズで迷うユーザーの記述が見当たらないため、在庫サイズの表示は優先度を下げて仮定しています。");
    s.say(min(22), "3案を作りました。A案はおすすめ重視、B案は比較重視、C案は在庫重視です。どの案をベースに詰めますか？");
    s.ev(min(22), "Stop");
  });
  session("w2b3c4d5-0102", "C:\\Users\\yota\\design\\search-proposal", "main", (s) => {
    s.title("検索基盤の提案資料");
    s.ev(min(4), "UserPromptSubmit");
    s.user(min(4), "提案資料の構成をアップデートして、保守範囲の章を足して");
    s.tool(min(3), "TodoWrite", todos([["現行構成の確認", "completed", ""], ["保守範囲の章を追加", "in_progress", "保守範囲の章を書いています"], ["全体の見直し", "pending", ""]]));
    s.tool(min(1), "Edit", { file_path: "C:\\Users\\yota\\design\\search-proposal\\proposal.md" }, null);
  });
}

events.sort((a, b) => a.ts - b.ts);
writeFileSync(join(data, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`fixtures: ${projects}`);
