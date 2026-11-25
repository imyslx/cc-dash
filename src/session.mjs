// 1セッション分の会話記録（Claude Code の JSONL）を差分で取り込み、
// 「章（＝自分の依頼）→ その下の途中メッセージとツール呼び出し」の時系列に組み立てる。
import { extractByRules } from "./highlights.mjs";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TODO_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
// 「今ここ」の直近ツールに出しても意味がないもの
const META_TOOLS = new Set([...TODO_TOOLS, "Skill", "TaskList", "TaskGet"]);

// / と \ のどちらの区切りでも末尾を取る（Windows の会話記録を別 OS で読む場合にも備えて）
const basename = (p) => String(p).split(/[\\/]/).pop();
const ts = (e) => (e.timestamp ? Date.parse(e.timestamp) : NaN);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ユーザー発言から、Claude Code が差し込むメタ情報を取り除く
function cleanPrompt(raw) {
  let t = String(raw);
  if (/^\s*<(local-command-stdout|local-command-stderr|local-command-caveat)>/.test(t)) return null;
  if (/^Caveat: /.test(t)) return null;
  const cmd = t.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return { text: args ? `${cmd[1]} ${args}` : cmd[1], isCommand: true };
  }
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  // VSCode 拡張が差し込む、開いているファイルや選んだ範囲の情報（<ide_opened_file> / <ide_selection> など）
  t = t.replace(/<(ide_[a-z_]+)>[\s\S]*?<\/\1>/g, "").trim();
  if (!t) return null;
  return { text: t, isCommand: false };
}

// ツール呼び出しを1行で表す
export function toolBrief(name, input = {}) {
  const f = input.file_path || input.notebook_path || input.path;
  if (f) return `${name} ${basename(f)}`;
  if (input.command) return `${name}: ${clip(String(input.command).split("\n")[0], 60)}`;
  if (input.pattern) return `${name} "${clip(String(input.pattern), 40)}"`;
  if (input.url) return `${name} ${clip(String(input.url), 60)}`;
  if (input.query) return `${name} "${clip(String(input.query), 40)}"`;
  if (input.skill) return `${name} ${input.skill}`;
  if (input.description) return `${name}: ${clip(String(input.description), 50)}`;
  if (input.subject) return `${name}: ${clip(String(input.subject), 50)}`;
  return name;
}

export class Session {
  constructor(id, file, project) {
    this.id = id;
    this.file = file;
    this.project = project; // ~/.claude/projects 配下のディレクトリ名
    this.cwd = null;
    this.branch = null;
    this.title = null; // Claude Code が付けたタイトル（summary 行など）
    this.chapters = [];
    this.todos = []; // { content, status, activeForm }
    this.taskSeq = 0;
    this.skills = [];
    this.files = new Set();
    this.pendingTools = new Map(); // tool_use_id -> brief
    this.lastTool = null;
    this.lastActivity = 0;
    this.lastPromptTs = 0;
    this.lastRole = null; // 最後のエントリが user / assistant のどちらか
    this.interrupted = false;
    this.version = 0;
  }

  get prompts() {
    return this.chapters.filter((c) => !c.implicit).map((c) => c.text);
  }

  currentChapter(t) {
    if (this.chapters.length === 0) {
      this.chapters.push({ id: "c0", ts: t, text: "（セッション開始）", isCommand: false, implicit: true, items: [] });
    }
    return this.chapters[this.chapters.length - 1];
  }

  apply(entries) {
    let changed = false;
    for (const e of entries) if (this.applyOne(e)) changed = true;
    if (changed) this.version++;
    return changed;
  }

  applyOne(e) {
    if (!e || typeof e !== "object") return false;

    // タイトル系の行（バージョンによって形が違うので緩く拾う）
    if (e.type === "summary" && e.summary) {
      this.title = e.summary;
      return true;
    }
    const customTitle = e.customTitle || (e.type?.includes?.("title") ? e.title : null);
    if (typeof customTitle === "string" && customTitle) {
      this.title = customTitle;
      return true;
    }

    if (e.isSidechain) return false; // サブエージェント内部のやりとりは時系列に混ぜない
    if (e.type !== "user" && e.type !== "assistant") return false;

    const t = ts(e) || Date.now();
    if (e.cwd) this.cwd = e.cwd;
    if (e.gitBranch) this.branch = e.gitBranch;
    this.lastActivity = Math.max(this.lastActivity, t);

    const content = e.message?.content;
    if (e.type === "user") return this.applyUser(e, content, t);
    return this.applyAssistant(e, content, t);
  }

  applyUser(e, content, t) {
    this.lastRole = "user";
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    let changed = false;
    for (const b of blocks) {
      if (b.type === "tool_result") {
        this.pendingTools.delete(b.tool_use_id);
        changed = true;
        continue;
      }
      if (b.type !== "text" || e.isMeta) continue;
      if (/^\[Request interrupted/.test(b.text || "")) {
        this.interrupted = true;
        this.currentChapter(t).items.push({ type: "note", uuid: e.uuid, ts: t, text: "中断しました" });
        changed = true;
        continue;
      }
      const p = cleanPrompt(b.text);
      if (!p) continue;
      this.interrupted = false;
      this.lastPromptTs = t;
      this.chapters.push({
        id: e.uuid || `c${this.chapters.length}`,
        ts: t,
        text: p.text,
        isCommand: p.isCommand,
        items: [],
      });
      changed = true;
    }
    return changed;
  }

  applyAssistant(e, content, t) {
    this.lastRole = "assistant";
    if (!Array.isArray(content)) return false;
    const ch = this.currentChapter(t);
    let i = 0;
    for (const b of content) {
      const uuid = `${e.uuid || e.message?.id || t}:${i++}`;
      if (b.type === "text" && b.text?.trim()) {
        ch.items.push({ type: "text", uuid, ts: t, text: b.text.trim(), highlights: extractByRules(b.text) });
      } else if (b.type === "tool_use") {
        const brief = toolBrief(b.name, b.input);
        this.pendingTools.set(b.id, brief);
        if (!META_TOOLS.has(b.name)) this.lastTool = { brief, ts: t };
        this.trackTool(b.name, b.input || {});
        ch.items.push({ type: "tool", uuid, ts: t, name: b.name, brief });
      }
    }
    return true;
  }

  trackTool(name, input) {
    if (FILE_TOOLS.has(name)) {
      const f = input.file_path || input.notebook_path;
      if (f) this.files.add(f);
    }
    if (name === "Skill" && input.skill) {
      this.skills = [input.skill, ...this.skills.filter((s) => s !== input.skill)];
    }
    if (!TODO_TOOLS.has(name)) return;
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      this.todos = input.todos.map((x) => ({ id: x.id, content: x.content, status: x.status, activeForm: x.activeForm }));
    } else if (name === "TaskCreate") {
      // タスク番号は作成順の連番になる前提（ベストエフォート）
      this.todos.push({ id: String(++this.taskSeq), content: input.subject || input.description || "", status: "pending", activeForm: input.activeForm });
    } else if (name === "TaskUpdate") {
      const x = this.todos.find((t) => t.id === String(input.taskId));
      if (!x) return;
      if (input.status === "deleted") this.todos = this.todos.filter((t) => t !== x);
      else {
        if (input.status) x.status = input.status;
        if (input.subject) x.content = input.subject;
        if (input.activeForm) x.activeForm = input.activeForm;
      }
    }
  }

  // ---- 表示用の集計 ----

  // テキスト項目ごとの「大事なこと」（Haiku の結果があればそちらを優先）
  highlightsOf(item) {
    return item.llm ?? item.highlights ?? [];
  }

  allHighlights() {
    const out = [];
    for (const ch of this.chapters)
      for (const it of ch.items)
        if (it.type === "text") for (const h of this.highlightsOf(it)) out.push({ ...h, ts: it.ts, uuid: it.uuid, chapter: ch.id });
    return out;
  }

  nowInfo() {
    const done = this.todos.filter((t) => t.status === "completed").length;
    const cur = this.todos.find((t) => t.status === "in_progress");
    return {
      todoDone: done,
      todoTotal: this.todos.length,
      current: cur ? cur.activeForm || cur.content : null,
      lastTool: this.lastTool?.brief ?? null,
    };
  }

  displayTitle() {
    if (this.title) return this.title;
    const first = this.prompts[0];
    return first ? clip(first.replace(/\s+/g, " "), 40) : "（無題のセッション）";
  }
}
