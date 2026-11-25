import { homedir, hostname } from "node:os";
import { join } from "node:path";

const env = process.env;
const DATA_DIR = env.CC_DASH_DIR || join(homedir(), ".cc-dash");

export const config = {
  name: env.CC_DASH_NAME || hostname().split(".")[0], // 端末名（カードに出す）
  projectsDir: env.CC_DASH_PROJECTS_DIR || join(homedir(), ".claude", "projects"),
  dataDir: DATA_DIR,
  eventsFile: join(DATA_DIR, "events.jsonl"),
  llmCacheFile: join(DATA_DIR, "llm-cache.json"),
  pinsFile: join(DATA_DIR, "pins.json"), // ピン留め（src/pins.mjs）
  llmWorkdir: join(DATA_DIR, "llm-workdir"),
  peersFile: env.CC_DASH_PEERS_FILE || join(DATA_DIR, "peers.json"), // ハブとして集約する相手（ADR-0005）
  host: env.CC_DASH_HOST || "127.0.0.1", // 既定はローカル専用。エージェントは Tailscale の IP を指定する
  token: env.CC_DASH_TOKEN || null, // ループバック以外からのアクセスに必須
  port: Number(env.CC_DASH_PORT || 4319),
  recentDays: Number(env.CC_DASH_RECENT_DAYS || 3), // 一覧に出す会話記録の更新日数
  pollMs: 1500,
  stallMs: 3 * 60 * 1000, // Claude の番なのに3分動きがない → 止まっている
  idleMs: 6 * 60 * 60 * 1000, // 6時間触っていない → 区切り
  agentWaitMs: 60 * 60 * 1000, // サブエージェントの報告を待つ上限（実測：起動→報告は268件で最大28分・2026-11-25）
  waitWarnMs: 30 * 60 * 1000, // 返事待ちが30分を超えたら時刻を赤く
  gitCheckMs: 20 * 1000,
  peerRefreshMs: 30 * 1000,
  peerTimeoutMs: 60 * 1000, // この間 SSE に何も来なければ切れたとみなす（スリープ対策）
  llm: env.CC_DASH_LLM === "1" || process.argv.includes("--llm"),
  llmModel: env.CC_DASH_LLM_MODEL || "haiku",
  llmBackfillMs: 24 * 60 * 60 * 1000, // 起動時に Haiku に回すのは直近24時間分だけ
};
