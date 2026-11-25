import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Mac 役（エージェント）と Windows 役（ハブ）を同じプロセス内で別ポートに立てる
const dir = mkdtempSync(join(tmpdir(), "cc-dash-multi-"));
const fx = fileURLToPath(new URL("./fixtures/make-fixtures.mjs", import.meta.url));
execFileSync(process.execPath, [fx, join(dir, "mac"), "mac"]);
execFileSync(process.execPath, [fx, join(dir, "win"), "win"]);

process.env.CC_DASH_PROJECTS_DIR = join(dir, "win", "projects");
process.env.CC_DASH_DIR = join(dir, "win", "data");
const { Store } = await import("../src/store.mjs");
const { config } = await import("../src/config.mjs");
const { createApp } = await import("../src/server.mjs");
const { Peers } = await import("../src/peers.mjs");
const { authorized } = await import("../src/auth.mjs");

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// エージェント（Mac）
config.projectsDir = join(dir, "mac", "projects");
config.eventsFile = join(dir, "mac", "data", "events.jsonl");
const macStore = new Store();
await macStore.poll();
const macSrv = createApp(macStore, { name: "Mac", token: "t0ken" });
const macPort = await listen(macSrv);

// ハブ（Windows）
config.projectsDir = join(dir, "win", "projects");
config.eventsFile = join(dir, "win", "data", "events.jsonl");
const winStore = new Store();
await winStore.poll();
const peers = new Peers([{ name: "Mac", url: `http://127.0.0.1:${macPort}`, token: "t0ken", ssh: "yota-mac" }]);
await Promise.all(peers.peers.map((p) => peers.fetchList(p)));
const hub = createApp(winStore, { peers, name: "Win" });
const hubPort = await listen(hub);

after(() => {
  peers.stop();
  macSrv.close();
  hub.close();
  macSrv.closeAllConnections?.();
  hub.closeAllConnections?.();
});

test("ハブは自分と Mac のセッションを1つの一覧にまとめる", async () => {
  const list = await (await fetch(`http://127.0.0.1:${hubPort}/api/sessions`)).json();
  const machines = new Set(list.sessions.map((s) => s.machine));
  assert.deepEqual([...machines].sort(), ["Mac", "Win"]);
  assert.deepEqual(list.machines.map((m) => [m.name, m.online]), [["Win", true], ["Mac", true]]);
  const mac = list.sessions.find((s) => s.machine === "Mac" && s.id.startsWith("a1b2"));
  assert.equal(mac.key, `Mac::${mac.id}`);
  assert.equal(mac.ssh, "yota-mac");
  assert.equal(list.sessions[0].status, "waiting"); // 返事待ちが先頭
});

test("ハブは Mac のセッション詳細を中継する", async () => {
  const r = await fetch(`http://127.0.0.1:${hubPort}/api/sessions/${encodeURIComponent("Mac::a1b2c3d4-0001")}`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.machine, "Mac");
  assert.equal(d.chapters.length, 2);
});

test("Windows のパスの会話記録も読める", async () => {
  const list = await (await fetch(`http://127.0.0.1:${hubPort}/api/sessions`)).json();
  const w = list.sessions.find((s) => s.id.startsWith("w1a2"));
  assert.equal(w.cwd, "C:\\Users\\yota\\design\\shop-assistant-ux");
  assert.equal(w.status, "waiting");
  assert.ok(w.counts.assumption >= 1);
});

test("トークン：ループバックは素通し、それ以外は一致したときだけ通す", () => {
  const req = (addr, auth) => ({ socket: { remoteAddress: addr }, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  assert.equal(authorized(req("127.0.0.1"), null, "x"), true);
  assert.equal(authorized(req("100.64.0.3"), null, "x"), false);
  assert.equal(authorized(req("100.64.0.3", "y"), null, "x"), false);
  assert.equal(authorized(req("100.64.0.3", "x"), null, "x"), true);
  assert.equal(authorized(req("100.64.0.3", "x"), null, null), false); // トークン未設定なら外からは常に拒否
});

test("Mac が落ちたらオフラインとして残す", async () => {
  macSrv.closeAllConnections?.();
  await new Promise((r) => macSrv.close(r));
  await peers.fetchList(peers.peers[0]);
  const list = await (await fetch(`http://127.0.0.1:${hubPort}/api/sessions`)).json();
  assert.equal(list.machines.find((m) => m.name === "Mac").online, false);
  assert.ok(list.sessions.filter((s) => s.machine === "Mac").every((s) => s.stale));
});
