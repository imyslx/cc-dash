import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "cc-dash-test-"));
process.env.CC_DASH_PROJECTS_DIR = join(dir, "projects");
process.env.CC_DASH_DIR = join(dir, "data");
execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/make-fixtures.mjs", import.meta.url)), dir]);

const { extractByRules } = await import("../src/highlights.mjs");
const { JsonlTail } = await import("../src/jsonl.mjs");
const { Store } = await import("../src/store.mjs");
const { parseHighlights } = await import("../src/llm.mjs");
const { Session } = await import("../src/session.mjs");
const { mergeLists } = await import("../src/merge.mjs");

test("依頼文：VSCode 拡張が差し込む <ide_…> を取り除き、見出しや依頼の件数に混ぜない", () => {
  const s = new Session("s1", "f.jsonl", "p");
  const t = "2026-11-25T00:00:00.000Z";
  s.apply([
    // 別のかたまりとして先頭に入る形
    {
      type: "user",
      uuid: "u1",
      timestamp: t,
      message: {
        role: "user",
        content: [
          { type: "text", text: "<ide_opened_file>The user opened the file a.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>" },
          { type: "text", text: "キャッシュを入れて" },
        ],
      },
    },
    // 同じかたまりの中に入る形（選んだ範囲の中身は表に出さない）
    {
      type: "user",
      uuid: "u2",
      timestamp: t,
      message: { role: "user", content: "<ide_selection>The user selected the lines 1 to 2 from a.ts:\nSECRET=x\n</ide_selection>\nここを直して" },
    },
  ]);
  assert.equal(s.displayTitle(), "キャッシュを入れて");
  assert.deepEqual(s.prompts, ["キャッシュを入れて", "ここを直して"]);
});

test("並び順：同じ札の中ではその札になった時刻で並べ、動きがあっても入れ替えない", () => {
  const card = (id, status, since, lastActivity) => ({ id, status, since, lastActivity, title: id });
  const order = (local, remote) =>
    mergeLists({ sessions: local }, "Win", [{ name: "Mac", online: true, skew: 0, data: { sessions: remote } }]).sessions.map((s) => s.key);

  const before = order([card("w1", "working", 1000, 5000)], [card("m1", "working", 2000, 6000)]);
  assert.deepEqual(before, ["Mac::m1", "w1"]); // 新しく作業を始めたほうが上
  // Win 側で動きがあって最後に動いた時刻が逆転しても、順番は変わらない
  assert.deepEqual(order([card("w1", "working", 1000, 9000)], [card("m1", "working", 2000, 6000)]), before);
  // 札が変わったときは動く（返事待ちが先頭）
  assert.deepEqual(order([card("w1", "waiting", 9000, 9000)], [card("m1", "working", 2000, 6000)]), ["w1", "Mac::m1"]);
});

test("ルール抽出：種類を拾い、ただの進捗は拾わない", () => {
  const hs = extractByRules("既存の処理を確認します。TTL は仕様に記載がないので、暫定で5分にしておきました。E2E テストはスキップしています。在庫0件のときもキャッシュしますか？");
  assert.deepEqual(
    hs.map((h) => h.kind),
    ["assumption", "skip", "question"],
  );
  assert.equal(extractByRules("ファイルを読みます。テストを実行します。").length, 0);
});

test("ルール抽出：コードブロックの中は無視する", () => {
  assert.equal(extractByRules("修正しました。\n```\n// TODO: skip this\n```").length, 0);
});

test("JSONL の差分読み：書きかけの行とマルチバイト文字の分割に耐える", async () => {
  const f = join(dir, "tail.jsonl");
  writeFileSync(f, "");
  const t = new JsonlTail(f);
  const line = JSON.stringify({ text: "日本語のメッセージ" }) + "\n";
  const buf = Buffer.from(line);
  appendFileSync(f, buf.subarray(0, 10)); // 文字の途中で切れる
  assert.deepEqual(await t.readNew(), []);
  appendFileSync(f, buf.subarray(10));
  assert.deepEqual(await t.readNew(), [{ text: "日本語のメッセージ" }]);
});

test("ストア：誰の番かで札が決まる", async () => {
  const store = new Store();
  await store.poll();
  const byTitle = Object.fromEntries(store.listView().sessions.map((s) => [s.id.slice(0, 8), s]));
  assert.equal(byTitle.a1b2c3d4.status, "waiting");
  assert.equal(byTitle.a1b2c3d4.reason, "reply");
  assert.equal(byTitle.b2c3d4e5.status, "working");
  assert.equal(byTitle.c3d4e5f6.status, "waiting");
  assert.equal(byTitle.c3d4e5f6.reason, "permission");
  assert.equal(byTitle.d4e5f6a7.status, "stalled");
  assert.equal(byTitle.f6a7b8c9.status, "idle");
  // 返事待ちが先頭に来る
  assert.equal(store.listView().sessions[0].status, "waiting");
});

test("ストア：今ここ・大事なこと・同名カードの見分け", async () => {
  const store = new Store();
  await store.poll();
  const list = store.listView().sessions;
  const a = list.find((s) => s.id.startsWith("a1b2"));
  assert.equal(a.now.todoTotal, 4);
  assert.equal(a.now.todoDone, 3);
  assert.equal(a.now.current, "結合テストを実行中");
  assert.deepEqual(a.skills, ["code-review", "tdd"]);
  assert.ok(a.counts.assumption >= 2 && a.counts.skip >= 1 && a.counts.question >= 1);
  assert.equal(a.titleSuffix, "feat/inventory-cache");
  assert.equal(a.closable.ok, false); // 最後の依頼に未回答の確認がある

  const d = store.detailView(a.id);
  assert.equal(d.chapters.length, 2);
  const last = d.chapters[1].items.filter((i) => i.type === "text").pop();
  assert.equal(last.final, true);
  assert.ok(d.chapters[1].items.some((i) => i.type === "tools" && i.list.length >= 2));
});

test("Haiku の出力を JSON 配列として読む", () => {
  assert.deepEqual(parseHighlights('結果:\n[{"kind":"skip","text":"E2E未実行"},{"kind":"bogus","text":"x"}]'), [{ kind: "skip", text: "E2E未実行", by: "llm" }]);
  assert.deepEqual(parseHighlights("[]"), []);
  assert.equal(parseHighlights("わかりません"), undefined);
});

test("フック：stdin の JSON をイベントログに1行追記する", () => {
  const hook = fileURLToPath(new URL("../hooks/hook.mjs", import.meta.url));
  execFileSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "Notification", session_id: "s1", notification_type: "permission_prompt", tool_input: { big: "x".repeat(10000) } }),
    env: { ...process.env, CC_DASH_DIR: join(dir, "hookdata") },
  });
  const line = JSON.parse(readFileSync(join(dir, "hookdata", "events.jsonl"), "utf8").trim());
  assert.equal(line.event, "Notification");
  assert.equal(line.notification_type, "permission_prompt");
  assert.equal(line.tool_input, undefined);
});
