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
const { computeStatus } = await import("../src/status.mjs");

test("札：裏で動かしたサブエージェントの報告を待っている間は、返事待ちでなく作業中", () => {
  const T = Date.parse("2026-11-25T00:00:00.000Z");
  const iso = (m) => new Date(T + m * 60_000).toISOString();
  const s = new Session("s1", "f.jsonl", "p");
  const launch = (m, toolId, agentId) => [
    { type: "assistant", uuid: `a${m}`, timestamp: iso(m), message: { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "Agent", input: { prompt: "調べて" } }] } },
    {
      type: "user",
      uuid: `r${m}`,
      timestamp: iso(m),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)` }] }] },
    },
  ];
  const handback = (m, agentId) => ({
    type: "user",
    isMeta: true,
    uuid: `h${m}`,
    timestamp: iso(m),
    message: { role: "user", content: `Another Claude session sent a message:\n<agent-message from="${agentId}">\n[Subagent hand-back] 報告です\n</agent-message>` },
  });
  s.apply([{ type: "user", uuid: "u0", timestamp: iso(0), message: { role: "user", content: "調査お願い" } }, ...launch(1, "t1", "a00000000000000aa")]);
  const hook = { promptTs: T, stopTs: T + 2 * 60_000 }; // 起動したあと、親のセッションは一区切りついた

  // 報告待ちの間は作業中。親の会話記録が動かなくても「止まっている」にしない
  const st = computeStatus(s, hook, T + 20 * 60_000);
  assert.equal(st.status, "working");
  assert.equal(st.reason, "agents");

  // 報告が届いたら待ちが消え、一区切りのあとは返事待ちに戻る。報告は依頼（章）に数えない
  s.apply([handback(15, "a00000000000000aa")]);
  assert.equal(computeStatus(s, { promptTs: T + 15 * 60_000, stopTs: T + 16 * 60_000 }, T + 20 * 60_000).status, "waiting");
  assert.deepEqual(s.prompts, ["調査お願い"]);

  // 終わったエージェントに追加の指示を送ったら、また報告待ち
  s.apply([{ type: "assistant", uuid: "sm", timestamp: iso(21), message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "SendMessage", input: { to: "a00000000000000aa", message: "続けて" } }] } }]);
  assert.equal(computeStatus(s, { promptTs: T + 15 * 60_000, stopTs: T + 22 * 60_000 }, T + 25 * 60_000).reason, "agents");

  // 止めたら待たない
  s.apply([{ type: "assistant", uuid: "ts", timestamp: iso(26), message: { role: "assistant", content: [{ type: "tool_use", id: "t3", name: "TaskStop", input: { task_id: "a00000000000000aa" } }] } }]);
  assert.equal(computeStatus(s, { promptTs: T + 15 * 60_000, stopTs: T + 27 * 60_000 }, T + 30 * 60_000).status, "waiting");

  // 報告が来ないまま上限（60分）を過ぎたら、返事待ちに戻す
  s.apply(launch(40, "t4", "a00000000000000bb"));
  const later = { promptTs: T + 15 * 60_000, stopTs: T + 41 * 60_000 };
  assert.equal(computeStatus(s, later, T + 50 * 60_000).status, "working");
  assert.equal(computeStatus(s, later, T + 101 * 60_000).status, "waiting");
});

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

test("見出し：自分で付けた名前 → AI が付けたタイトル → 最初の依頼文の順に使う", () => {
  const t = "2026-11-25T00:00:00.000Z";
  const prompt = { type: "user", uuid: "u1", timestamp: t, message: { role: "user", content: "おはようー！ これお願い" } };
  const ai = { type: "ai-title", sessionId: "s", aiTitle: "cc-dash のセットアップ" };
  const custom = { type: "custom-title", sessionId: "s", customTitle: "[P] ダッシュボード" };

  const a = new Session("a", "a.jsonl", "p");
  a.apply([prompt]);
  assert.equal(a.displayTitle(), "おはようー！ これお願い"); // タイトルの行がなければ依頼文

  const b = new Session("b", "b.jsonl", "p");
  b.apply([prompt, ai]);
  assert.equal(b.displayTitle(), "cc-dash のセットアップ"); // 挨拶ではなく AI のタイトル

  const c = new Session("c", "c.jsonl", "p");
  c.apply([prompt, ai, custom, ai]); // 名前を付けたあとも AI のタイトルは書き直され続ける
  assert.equal(c.displayTitle(), "[P] ダッシュボード");
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

test("VSCode で開く：この端末のセッションだけ、Claude Code 拡張の URI を OS に開かせる", async () => {
  const { createApp } = await import("../src/server.mjs");
  const store = new Store();
  await store.poll();
  const opened = [];
  const srv = createApp(store, { name: "demo", open: (uri) => opened.push(uri) });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const url = (key) => `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(key)}/open`;
  const post = (key, headers = { "x-cc-dash": "open" }) => fetch(url(key), { method: "POST", headers });
  try {
    const id = store.listView().sessions[0].id;
    assert.equal((await post(id)).status, 200);
    assert.deepEqual(opened, [`vscode://anthropic.claude-code/open?session=${id}`]);

    // 別のサイトのページから勝手に呼ばれないよう、POST と専用ヘッダーが要る
    assert.equal((await fetch(url(id))).status, 405);
    assert.equal((await post(id, {})).status, 405);
    // 別端末のセッションと、知らないセッションは開かない
    assert.equal((await post(`Mac::${id}`)).status, 404);
    assert.equal((await post("no-such-session")).status, 404);
    assert.equal(opened.length, 1);
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }

  // OS に開かせられなかったときは、受け付けたことにしない（画面に「開けませんでした」と出す）
  const bad = createApp(store, { name: "demo", open: () => Promise.reject(new Error("spawn rundll32 ENOENT")) });
  const badPort = await new Promise((r) => bad.listen(0, "127.0.0.1", () => r(bad.address().port)));
  try {
    const id = store.listView().sessions[0].id;
    const r = await fetch(`http://127.0.0.1:${badPort}/api/sessions/${id}/open`, { method: "POST", headers: { "x-cc-dash": "open" } });
    assert.equal(r.status, 500);
  } finally {
    bad.close();
    bad.closeAllConnections?.();
  }
});

test("ピン留め：いくつでも留められ、ファイルに残り、一覧に留めた時刻が付く", async () => {
  const { createApp } = await import("../src/server.mjs");
  const { Pins } = await import("../src/pins.mjs");
  const store = new Store();
  await store.poll();
  const file = join(dir, "pins-test.json");
  const srv = createApp(store, { name: "demo", pins: new Pins(file) });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const base = `http://127.0.0.1:${port}`;
  const pin = (key, method = "POST", headers = { "x-cc-dash": "pin" }) => fetch(`${base}/api/pins/${encodeURIComponent(key)}`, { method, headers });
  const list = async () => (await (await fetch(`${base}/api/sessions`)).json()).sessions;
  try {
    const [a, b] = (await list()).map((s) => s.key);
    assert.equal((await pin(a)).status, 200);
    assert.equal((await pin(b)).status, 200);
    const pinned = (await list()).filter((s) => s.pinned);
    assert.deepEqual(pinned.map((s) => s.key).sort(), [a, b].sort());
    assert.ok(pinned.every((s) => typeof s.pinnedAt === "number"));

    // ファイルに残るので、作り直しても同じ
    assert.deepEqual(Object.keys(new Pins(file).map).sort(), [a, b].sort());

    // 外す
    assert.equal((await pin(a, "DELETE")).status, 200);
    assert.deepEqual((await list()).filter((s) => s.pinned).map((s) => s.key), [b]);

    // 別のサイトのページから勝手に変えられないよう、専用ヘッダーが要る。知らないセッションは留めない
    assert.equal((await pin(a, "POST", {})).status, 405);
    assert.equal((await pin("no-such-session")).status, 404);
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }
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
