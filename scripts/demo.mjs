#!/usr/bin/env node
// 架空のセッションを生成してデモ起動する（Windows でも動くように env は JS で渡す）
//   node scripts/demo.mjs            1台分
//   node scripts/demo.mjs --hub      Mac 役のエージェント（:4320）と Windows 役のハブ（:4319）の2台構成
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = join(root, "test", "fixtures");
const main = join(root, "src", "main.mjs");
const run = (env) => spawn(process.execPath, [main], { stdio: "inherit", env: { ...process.env, ...env } });

if (!process.argv.includes("--hub")) {
  execFileSync(process.execPath, [join(fx, "make-fixtures.mjs"), fx], { stdio: "inherit" });
  run({ CC_DASH_PROJECTS_DIR: join(fx, "projects"), CC_DASH_DIR: join(fx, "data"), CC_DASH_NAME: "demo" });
} else {
  const mac = join(fx, "mac");
  const win = join(fx, "win");
  execFileSync(process.execPath, [join(fx, "make-fixtures.mjs"), mac, "mac"], { stdio: "inherit" });
  execFileSync(process.execPath, [join(fx, "make-fixtures.mjs"), win, "win"], { stdio: "inherit" });
  mkdirSync(join(win, "data"), { recursive: true });
  writeFileSync(join(win, "data", "peers.json"), JSON.stringify([{ name: "Mac", url: "http://127.0.0.1:4320", ssh: "yota-mac" }], null, 2));
  run({ CC_DASH_PROJECTS_DIR: join(mac, "projects"), CC_DASH_DIR: join(mac, "data"), CC_DASH_NAME: "Mac", CC_DASH_PORT: "4320", CC_DASH_TOKEN: "demo-token" });
  run({ CC_DASH_PROJECTS_DIR: join(win, "projects"), CC_DASH_DIR: join(win, "data"), CC_DASH_NAME: "Win", CC_DASH_PORT: "4319", CC_DASH_TOKEN: "demo-token" });
}
