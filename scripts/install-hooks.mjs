#!/usr/bin/env node
// ~/.claude/settings.json に cc-dash のフックを登録／削除する。
//   node scripts/install-hooks.mjs              登録
//   node scripts/install-hooks.mjs --uninstall  削除
//   node scripts/install-hooks.mjs --dry-run    書き込まずに結果を表示
//   --settings <path>                           対象の settings.json を指定
// 書き込む前に settings.json.bak-<時刻> を残す。既存のフックには触らない。
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const dryRun = args.includes("--dry-run");
const si = args.indexOf("--settings");
const settingsPath = si >= 0 ? resolve(args[si + 1]) : join(homedir(), ".claude", "settings.json");

// Windows でも / 区切りで書く（フックを実行するシェルによっては \ がエスケープとして解釈されるため。node は / でも読める）
const hookPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "hook.mjs").replace(/\\/g, "/");
const command = `node "${hookPath}"`;

// 会話記録に残らない「誰の番か」の変化だけを拾う
const EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];

const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
settings.hooks ??= {};

// 自分が入れたフックの判定：今のパス、または以前別の場所から入れた cc-dash のフック
const isOurs = (h) => typeof h?.command === "string" && (h.command.includes(hookPath) || (h.command.includes("cc-dash") && h.command.includes("hook.mjs")));

for (const ev of EVENTS) {
  const groups = (settings.hooks[ev] ??= []);
  // まず自分のフックを全部外す（再インストール時の重複防止）
  for (const g of groups) g.hooks = (g.hooks || []).filter((h) => !isOurs(h));
  settings.hooks[ev] = groups.filter((g) => g.hooks.length > 0);
  if (!uninstall) settings.hooks[ev].push({ hooks: [{ type: "command", command, timeout: 5 }] });
  if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

const json = JSON.stringify(settings, null, 2) + "\n";
if (dryRun) {
  console.log(json);
  process.exit(0);
}
mkdirSync(dirname(settingsPath), { recursive: true });
if (existsSync(settingsPath)) {
  const bak = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(settingsPath, bak);
  console.log(`バックアップ: ${bak}`);
}
writeFileSync(settingsPath, json);
console.log(`${uninstall ? "削除" : "登録"}しました: ${settingsPath}`);
if (!uninstall) console.log(`フック: ${command}\n対象イベント: ${EVENTS.join(", ")}\n実行中の Claude Code には次のセッションから反映されます。`);
