// 2段目：Haiku で「大事なこと」を分類し、セッションの1行要約を作る（任意。CC_DASH_LLM=1 で有効）。
// ローカルの claude CLI を `claude -p --model haiku` で呼ぶので、API キーの管理は不要。
// 結果は本文のハッシュをキーにキャッシュし、同じ文章で二度呼ばない。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { config } from "./config.mjs";
import { KINDS } from "./highlights.mjs";

const sha1 = (s) => createHash("sha1").update(s).digest("hex");

const CLASSIFY_PROMPT = `以下は、AIコーディングエージェントが作業の途中でユーザーに向けて残したメッセージです。
ユーザーが読み流すと後で困る「大事なこと」だけを抜き出してください。

種類:
- assumption: 指示にないことを自分で決めた・仮定を置いた
- risk: 懸念、リスク、副作用、互換性の問題
- skip: やらなかったこと、未完了、スキップ、失敗したまま
- question: ユーザーへの確認・判断の依頼
- discovery: 作業の前提を変えるような発見

単なる進捗報告（「〜を確認します」「〜を実装しました」）は含めないでください。
出力は JSON 配列のみ。各要素は {"kind": "<種類>", "text": "<60字以内の日本語>"}。該当がなければ [] だけを出力。

---
`;

const SUMMARY_PROMPT = `以下は、ユーザーがAIコーディングエージェントに出した依頼を古い順に並べたものです。
このセッションが「何の作業か」を、40字以内の日本語1文で書いてください。説明文だけを出力し、前置きや記号は付けないでください。

---
`;

export class LlmWorker {
  constructor(onResult) {
    this.onResult = onResult;
    this.queue = [];
    this.queued = new Set();
    this.running = false;
    this.cache = {};
    this.disabled = false;
    try {
      this.cache = JSON.parse(readFileSync(config.llmCacheFile, "utf8"));
    } catch {}
    mkdirSync(config.llmWorkdir, { recursive: true });
  }

  cached(key) {
    return this.cache[key];
  }

  // 途中メッセージの分類を予約。キャッシュ済みなら即座に返す
  classify(text, cb, priority = false) {
    const key = "h:" + sha1(text);
    if (key in this.cache) return cb(this.cache[key]);
    this.enqueue({ key, prompt: CLASSIFY_PROMPT + text.slice(0, 4000), parse: parseHighlights, cb }, priority);
  }

  summarize(prompts, cb) {
    const picked = prompts.length > 12 ? [prompts[0], ...prompts.slice(-11)] : prompts;
    const body = picked.map((p, i) => `${i + 1}. ${p.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
    const key = "s:" + sha1(body);
    if (key in this.cache) return cb(this.cache[key]);
    this.enqueue({ key, prompt: SUMMARY_PROMPT + body, parse: (s) => s.trim().split("\n")[0].slice(0, 60) || null, cb }, true);
  }

  enqueue(job, priority) {
    if (this.disabled || this.queued.has(job.key)) return;
    this.queued.add(job.key);
    priority ? this.queue.unshift(job) : this.queue.push(job);
    this.pump();
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length && !this.disabled) {
      const job = this.queue.shift();
      try {
        const out = await runClaude(job.prompt);
        const val = job.parse(out);
        if (val !== undefined) {
          this.cache[job.key] = val;
          this.save();
          job.cb(val);
          this.onResult?.();
        }
      } catch (err) {
        if (err.code === "ENOENT") {
          console.warn("[llm] claude コマンドが見つからないため Haiku 分類を無効にします");
          this.disabled = true;
        } else {
          console.warn("[llm] 失敗:", err.message);
        }
      } finally {
        this.queued.delete(job.key);
      }
    }
    this.running = false;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        writeFileSync(config.llmCacheFile, JSON.stringify(this.cache));
      } catch {}
    }, 1000);
  }
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    // cwd を専用ディレクトリにし、CC_DASH_INTERNAL で自分のフックを黙らせる。
    // こうしないと、要約のための呼び出し自体がダッシュボードに新しいセッションとして出てしまう（ADR-0003）
    const p = spawn("claude", ["-p", "--model", config.llmModel, "--output-format", "text"], {
      cwd: config.llmWorkdir,
      env: { ...process.env, CC_DASH_INTERNAL: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32", // Windows の claude は claude.cmd（引数は固定値のみなので安全）
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 90_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.slice(0, 200)}`));
    });
    p.stdin.end(prompt);
  });
}

export function parseHighlights(out) {
  const s = out.indexOf("[");
  const e = out.lastIndexOf("]");
  if (s < 0 || e < s) return undefined;
  try {
    const arr = JSON.parse(out.slice(s, e + 1));
    if (!Array.isArray(arr)) return undefined;
    return arr
      .filter((x) => x && KINDS[x.kind] && typeof x.text === "string" && x.text.trim())
      .slice(0, 5)
      .map((x) => ({ kind: x.kind, text: x.text.trim().slice(0, 120), by: "llm" }));
  } catch {
    return undefined;
  }
}
