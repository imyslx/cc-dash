// 会話記録とフックのイベントログを定期的に差分で読み、セッションの状態をメモリ上に持つ。
// 永続化はしない（起動時に JSONL から作り直せるため。ADR-0004）。
import { EventEmitter } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, basename } from "node:path";
import { config } from "./config.mjs";
import { JsonlTail } from "./jsonl.mjs";
import { Session } from "./session.mjs";
import { foldEvent, computeStatus, STATUS_ORDER } from "./status.mjs";
import { KINDS } from "./highlights.mjs";
import { LlmWorker } from "./llm.mjs";

export class Store extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.tails = new Map();
    this.events = new JsonlTail(config.eventsFile);
    this.hook = {};
    this.git = new Map(); // cwd -> { dirty, checkedAt }
    this.statusSnapshot = "";
    this.version = 0;
    this.llm = config.llm ? new LlmWorker(() => this.bump()) : null;
  }

  bump() {
    this.version++;
    this.emit("change", this.version);
  }

  start() {
    const tick = async () => {
      try {
        await this.poll();
      } catch (e) {
        console.warn("[store]", e.message);
      }
      this.timer = setTimeout(tick, config.pollMs);
    };
    return tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async poll() {
    let changed = false;

    for (const ev of await this.events.readNew()) {
      if (ev.session_id) foldEvent(this.hook, ev);
      changed = true;
    }

    const files = await this.listTranscripts();
    for (const { file, project, id } of files) {
      let tail = this.tails.get(file);
      if (!tail) this.tails.set(file, (tail = new JsonlTail(file)));
      const entries = await tail.readNew();
      if (!entries.length) continue;
      let s = this.sessions.get(id);
      if (!s) this.sessions.set(id, (s = new Session(id, file, project)));
      if (s.apply(entries)) {
        changed = true;
        this.scheduleLlm(s);
      }
    }

    this.refreshGit();

    // 時間経過だけで札が変わる（作業中 → 止まっている など）ので毎回比べる
    const snap = [...this.sessions.values()].map((s) => `${s.id}:${this.statusOf(s).status}`).join("|");
    if (snap !== this.statusSnapshot) {
      this.statusSnapshot = snap;
      changed = true;
    }
    if (changed) this.bump();
  }

  async listTranscripts() {
    const out = [];
    const cutoff = Date.now() - config.recentDays * 86400_000;
    let dirs = [];
    try {
      dirs = await readdir(config.projectsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = join(config.projectsDir, d.name);
      let names = [];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const file = join(dir, n);
        if (!this.tails.has(file)) {
          // 初めて見るファイルは、最近更新されたものだけ取り込む
          try {
            if ((await stat(file)).mtimeMs < cutoff) continue;
          } catch {
            continue;
          }
        }
        out.push({ file, project: d.name, id: basename(n, ".jsonl") });
      }
    }
    return out;
  }

  isInternal(s) {
    if (!s.cwd) return false;
    const norm = (p) => (process.platform === "win32" ? p.replace(/\//g, "\\").toLowerCase() : p);
    return norm(s.cwd).startsWith(norm(config.llmWorkdir));
  }

  visibleSessions() {
    return [...this.sessions.values()].filter((s) => !this.isInternal(s) && s.chapters.length > 0);
  }

  statusOf(s) {
    return computeStatus(s, this.hook[s.id]);
  }

  // ---- git の未コミット確認（閉じてよいか判定用） ----
  refreshGit() {
    const now = Date.now();
    const cwds = new Set(this.visibleSessions().map((s) => s.cwd).filter(Boolean));
    for (const cwd of cwds) {
      const g = this.git.get(cwd);
      if (g && (g.pending || now - g.checkedAt < config.gitCheckMs)) continue;
      this.git.set(cwd, { ...(g || {}), pending: true, checkedAt: now });
      execFile("git", ["status", "--porcelain"], { cwd, timeout: 5000 }, (err, stdout) => {
        const dirty = err ? null : stdout.split("\n").filter(Boolean).length;
        const prev = this.git.get(cwd)?.dirty;
        this.git.set(cwd, { dirty, checkedAt: Date.now(), pending: false });
        if (prev !== dirty) this.bump();
      });
    }
  }

  // ---- Haiku（任意） ----
  scheduleLlm(s, priority = false) {
    if (!this.llm || this.isInternal(s)) return;
    const since = Date.now() - config.llmBackfillMs;
    for (const ch of s.chapters)
      for (const it of ch.items) {
        if (it.type !== "text" || it.llm !== undefined || it.text.length < 20) continue;
        if (!priority && it.ts < since) continue;
        this.llm.classify(it.text, (v) => (it.llm = v), priority);
      }
    const prompts = s.prompts;
    if (prompts.length && s._summaryFor !== prompts.length) {
      s._summaryFor = prompts.length;
      this.llm.summarize(prompts, (v) => (s.summary = v));
    }
  }

  // ---- API 用のビュー ----
  listView() {
    const now = Date.now();
    const list = this.visibleSessions().map((s) => this.cardView(s, now));
    // 見出しが重なるカードだけ、ブランチや今の作業を添えて見分ける
    const count = {};
    for (const c of list) count[c.title] = (count[c.title] || 0) + 1;
    for (const c of list) if (count[c.title] > 1) c.titleSuffix = c.branch || c.now.current || c.now.lastTool || c.id.slice(0, 8);
    list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity);
    return { version: this.version, now, llm: !!this.llm, waitWarnMs: config.waitWarnMs, sessions: list };
  }

  cardView(s, now) {
    const st = this.statusOf(s);
    const hl = s.allHighlights();
    const counts = Object.fromEntries(Object.keys(KINDS).map((k) => [k, 0]));
    for (const h of hl) counts[h.kind]++;
    const lastCh = s.chapters[s.chapters.length - 1];
    const openQuestion = hl.some((h) => h.kind === "question" && h.chapter === lastCh?.id);
    const dirty = s.cwd ? this.git.get(s.cwd)?.dirty ?? null : null;
    const closable = closableOf(st, dirty, openQuestion);
    const prompts = s.prompts;
    return {
      id: s.id,
      title: s.displayTitle(),
      summary: s.summary || null,
      progress: prompts.length ? `依頼 ${prompts.length}件 ・ 最後：${oneLine(prompts[prompts.length - 1], 50)}` : "",
      status: st.status,
      reason: st.reason || null,
      since: st.since,
      lastActivity: s.lastActivity,
      cwd: s.cwd,
      project: s.project,
      branch: s.branch,
      skills: s.skills.slice(0, 2),
      now: s.nowInfo(),
      counts,
      highlights: hl.slice(-3).reverse(),
      dirty,
      closable,
    };
  }

  detailView(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    this.scheduleLlm(s, true); // 開いたセッションは古いものも優先して分類
    const card = this.cardView(s, Date.now());
    const chapters = s.chapters.map((ch) => {
      // 最後のテキスト（その後にツール呼び出しがないもの）を「返答」、それ以外を「途中メッセージ」とする
      let lastText = -1;
      ch.items.forEach((it, i) => {
        if (it.type === "text") lastText = i;
      });
      const toolAfter = ch.items.slice(lastText + 1).some((it) => it.type === "tool");
      return {
        id: ch.id,
        ts: ch.ts,
        text: ch.text,
        isCommand: ch.isCommand,
        implicit: !!ch.implicit,
        items: groupTools(ch.items).map((it) =>
          it.type === "text"
            ? { type: "text", uuid: it.uuid, ts: it.ts, text: it.text, final: it.index === lastText && !toolAfter, highlights: s.highlightsOf(it) }
            : it,
        ),
      };
    });
    return { ...card, chapters, files: [...s.files], todos: s.todos };
  }
}

function closableOf({ status, reason }, dirty, openQuestion) {
  if (status === "working" || status === "stalled") return { ok: false, why: "作業中" };
  if (status === "waiting" && reason === "permission") return { ok: false, why: "許可待ち" };
  if (status === "waiting" && openQuestion) return { ok: false, why: "確認に未回答" };
  if (dirty > 0) return { ok: false, why: `未コミット ${dirty}件` };
  return { ok: true, why: dirty === null ? "git 外" : "" };
}

// 連続するツール呼び出しを1行にまとめる（時系列が縦に長くなりすぎないように）
function groupTools(items) {
  const out = [];
  items.forEach((it, index) => {
    if (it.type === "tool") {
      const prev = out[out.length - 1];
      if (prev?.type === "tools") {
        prev.list.push(it.brief);
        prev.tsEnd = it.ts;
      } else out.push({ type: "tools", uuid: it.uuid, ts: it.ts, tsEnd: it.ts, list: [it.brief] });
    } else out.push({ ...it, index });
  });
  return out;
}

const oneLine = (s, n) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
