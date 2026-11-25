#!/usr/bin/env node
// Claude Code のフックから呼ばれ、状態変化イベントを ~/.cc-dash/events.jsonl に追記するだけのスクリプト。
// 重い処理は一切しない（Claude Code 本体を待たせないため）。失敗しても必ず exit 0 で抜ける。
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ダッシュボード自身が要約のために起動した claude -p のイベントは記録しない
if (process.env.CC_DASH_INTERNAL === "1") process.exit(0);

const dir = process.env.CC_DASH_DIR || join(homedir(), ".cc-dash");

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const e = JSON.parse(raw || "{}");

  // 必要なフィールドだけ残す（tool_input などの大きなペイロードは捨てる）
  const out = {
    ts: Date.now(),
    event: e.hook_event_name,
    session_id: e.session_id,
    transcript_path: e.transcript_path,
    cwd: e.cwd,
  };
  if (e.notification_type) out.notification_type = e.notification_type;
  if (e.message) out.message = String(e.message).slice(0, 200);
  if (e.source) out.source = e.source; // SessionStart: startup / resume / clear / compact
  if (e.reason) out.reason = e.reason; // SessionEnd
  if (e.tool_name) out.tool_name = e.tool_name;

  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "events.jsonl"), JSON.stringify(out) + "\n");
} catch {
  // ダッシュボードの都合で Claude Code を止めない
}
process.exit(0);
