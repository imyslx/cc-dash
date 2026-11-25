// 画面：#/ が一覧、#/s/<id> が詳細（#/s/<id>/<uuid> でその位置に飛ぶ）
const app = document.getElementById("app");
const sideEl = document.getElementById("side");
const topEl = document.querySelector(".top");
const summaryEl = document.getElementById("summary");
const notifyBtn = document.getElementById("notify");

const STATUS = {
  waiting: "返事待ち",
  working: "作業中",
  stalled: "止まっている",
  idle: "区切り",
  closed: "終了",
};
const REASON = { permission: "許可待ち", interrupted: "中断" };
const KIND = { question: "確認", skip: "スキップ", risk: "懸念", assumption: "仮定", discovery: "発見" };

let state = { list: null, detail: null, onlyImp: false, filter: null, prevStatus: new Map(), notify: false, audio: null };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hm = (t) => (t ? new Date(t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "");
const ago = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "1分未満";
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}時間${m % 60 ? (m % 60) + "分" : ""}` : `${Math.floor(h / 24)}日`;
};
const short = (p) => (p ? p.replace(/^\/(Users|home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~") : "");

// VSCode で開くボタン。この端末のセッションは、サーバーに頼んでそのセッションのタブを開く（src/open.mjs）。
// 別端末のセッションは Remote-SSH（peers.json の ssh）で作業フォルダを開く
function vscodeButton(s) {
  if (s.self) return `<button data-open="${esc(s.key)}" data-stop>VSCode ↗</button>`;
  if (!s.ssh || !s.cwd) return "";
  let path = s.cwd.replace(/\\/g, "/");
  if (!path.startsWith("/")) path = "/" + path;
  const href = `vscode://vscode-remote/ssh-remote+${encodeURIComponent(s.ssh)}${encodeURI(path)}`;
  return `<a href="${esc(href)}" data-stop><button>VSCode ↗</button></a>`;
}

async function openSession(btn) {
  const r = await fetch(`/api/sessions/${encodeURIComponent(btn.dataset.open)}/open`, { method: "POST", headers: { "x-cc-dash": "open" } }).catch(() => null);
  btn.textContent = r?.ok ? "開きました" : "開けませんでした";
  setTimeout(() => (btn.textContent = "VSCode ↗"), 2000);
}
const statusLabel = (s) => STATUS[s.status] + (s.reason && REASON[s.reason] ? `・${REASON[s.reason]}` : "");
// ヘッダーの件数を押したときの絞り込み。件数と合わせるため、オフライン端末の分は外す
const visible = (list) => (state.filter ? list.sessions.filter((s) => s.status === state.filter && !s.stale) : list.sessions);
const multi = () => (state.list?.machines?.length ?? 1) > 1;
const machineChip = (s) => (multi() ? `<span class="machine${s.stale ? " off" : ""}">${esc(s.machine)}${s.stale ? "・オフライン" : ""}</span>` : "");

function route() {
  const m = location.hash.match(/^#\/s\/([^/]+)(?:\/(.+))?/);
  return m ? { name: "detail", id: decodeURIComponent(m[1]), focus: m[2] ? decodeURIComponent(m[2]) : null } : { name: "list" };
}

async function load() {
  const r = route();
  const list = await (await fetch("/api/sessions")).json();
  checkTransitions(list);
  state.list = list;
  renderSummary(list);
  renderSide(list, r.name === "detail" ? r.id : null);
  if (r.name === "detail") {
    const res = await fetch(`/api/sessions/${encodeURIComponent(r.id)}`);
    state.detail = res.ok ? await res.json() : null;
    renderDetail(state.detail, r.focus, list);
  } else {
    renderList(list);
  }
}

// ---- 一覧 ----
function renderSummary(list) {
  const c = { waiting: 0, working: 0, stalled: 0 };
  for (const s of list.sessions) if (s.status in c) c[s.status]++;
  for (const s of list.sessions) if (s.stale) c[s.status]--; // オフライン端末の分は数えない
  const machines = (list.machines || []).length > 1
    ? `<span class="machines">${list.machines.map((m) => `<span class="mchip${m.online ? "" : " off"}" title="${esc(m.error || "")}">${esc(m.name)}${m.online ? "" : `・オフライン${m.lastOk ? `（${hm(m.lastOk)}）` : ""}`}</span>`).join("")}</span>`
    : "";
  const chip = (st) => `<button class="fchip${state.filter === st ? " on" : ""}" data-filter="${st}" title="押すと${STATUS[st]}だけに絞り込み、もう一度押すと解除">${STATUS[st]} <b>${c[st]}</b></button>`;
  const showStalled = c.stalled || state.filter === "stalled"; // 絞り込み中は 0 件でも解除できるように出しておく
  summaryEl.innerHTML = `${chip("waiting")}${chip("working")}${showStalled ? chip("stalled") : ""}${machines}`;
  document.title = c.waiting ? `(${c.waiting}) cc-dash` : "cc-dash";
  setTopHeight(); // 端末ラベルの増減でヘッダーの高さが変わることがある
}

// ---- サイドメニュー：タイトルと札だけの一覧。押すと詳細に飛ぶ ----
function renderSide(list, currentKey) {
  sideEl.innerHTML = visible(list)
    .map((s) => {
      const cls = ["nav-item", s.key === currentKey ? "current" : "", s.stale || ["idle", "closed"].includes(s.status) ? "dim" : ""].filter(Boolean).join(" ");
      return `<a class="${cls}" href="#/s/${encodeURIComponent(s.key)}" title="${esc(s.title)}"><span class="nav-title">${esc(s.title)}</span><span class="badge st-${s.status}">${statusLabel(s)}</span></a>`;
    })
    .join("");
}

// サイドメニューをヘッダーのすぐ下に留めるため、ヘッダーの高さを CSS に渡す
function setTopHeight() {
  document.documentElement.style.setProperty("--top-h", `${topEl.offsetHeight}px`);
}
window.addEventListener("resize", setTopHeight);

function renderList(list) {
  const shown = visible(list);
  const active = shown.filter((s) => !["idle", "closed"].includes(s.status));
  const rest = shown.filter((s) => ["idle", "closed"].includes(s.status));
  if (!list.sessions.length) {
    app.innerHTML = `<p class="empty">最近の Claude Code のセッションが見つかりません。<br>Claude Code を使うと、ここに出てきます。</p>`;
    return;
  }
  if (!shown.length) {
    app.innerHTML = `<p class="empty">${STATUS[state.filter]}のセッションはありません。<br>上の「${STATUS[state.filter]}」をもう一度押すと解除できます。</p>`;
    return;
  }
  app.innerHTML =
    `<div class="grid">${active.map((s) => card(s, list)).join("")}</div>` +
    (rest.length ? `<p class="section-title">区切り・終了（${rest.length}）</p><div class="grid">${rest.map((s) => card(s, list, true)).join("")}</div>` : "");
}

function card(s, list, dim = false) {
  const n = s.now;
  const pct = n.todoTotal ? Math.round((n.todoDone / n.todoTotal) * 100) : 0;
  const showNow = s.status === "working" || s.status === "stalled" || n.todoTotal > 0;
  const waitMs = list.now - s.since;
  const late = s.status === "waiting" && waitMs > list.waitWarnMs;
  const label = statusLabel(s);
  const hlCount = Object.values(s.counts).reduce((a, b) => a + b, 0);
  const timeText =
    s.status === "waiting" ? `${ago(waitMs)}待ち` : s.status === "working" ? `${ago(waitMs)}経過` : s.status === "stalled" ? `${ago(waitMs)}動きなし` : hm(s.lastActivity);

  return `<article class="card${dim || s.stale ? " dim" : ""}" data-go="#/s/${encodeURIComponent(s.key)}">
    <div class="row">
      <div style="min-width:0">
        <p class="title">${esc(s.title)}${s.titleSuffix ? `<span class="suffix">${esc(s.titleSuffix)}</span>` : ""}</p>
        <p class="meta">${machineChip(s)}${esc(short(s.cwd) || s.project)}${s.branch ? ` ・ ${esc(s.branch)}` : ""}</p>
      </div>
      <span class="badge st-${s.status}">${label}</span>
    </div>
    ${s.summary ? `<p class="line">${esc(s.summary)}</p>` : ""}
    ${s.progress ? `<p class="progress">${esc(s.progress)}</p>` : ""}
    ${
      showNow
        ? `<div class="now">
        <div class="row"><span>今ここ${n.todoTotal ? `　${n.todoDone} / ${n.todoTotal}` : ""}</span><span>${esc(n.lastTool || "")}</span></div>
        ${n.todoTotal ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}
        ${n.current ? `<div class="cur">${esc(n.current)}</div>` : ""}
      </div>`
        : ""
    }
    ${
      s.highlights.length
        ? `<div class="pins"><div class="pins-h">拾った大事なこと（${hlCount}）</div>${s.highlights
            .map((h) => `<div class="pin" data-go="#/s/${encodeURIComponent(s.key)}/${encodeURIComponent(h.uuid)}"><span class="k k-${h.kind}">${KIND[h.kind]}</span><span>${esc(h.text)}</span></div>`)
            .join("")}</div>`
        : ""
    }
    <div class="foot">
      <div class="skills">${s.skills.map((k) => `<span class="skill">${esc(k)}</span>`).join("")}</div>
      <span class="wait${late ? " late" : ""}">${timeText}</span>
    </div>
    <div class="foot" style="border:0;padding-top:0;margin-top:6px">
      <span class="${s.closable.ok ? "close-ok" : "close-ng"}">${s.closable.ok ? "閉じてよい" : `まだ（${esc(s.closable.why)}）`}</span>
      ${vscodeButton(s)}
    </div>
  </article>`;
}

// ---- 詳細 ----
function renderDetail(d, focus, list) {
  if (!d) {
    app.innerHTML = `<div class="detail"><a class="back" href="#/">← 一覧</a><p class="empty">セッションが見つかりません。</p></div>`;
    return;
  }
  const keepScroll = window.scrollY;
  const c = d.counts;
  const label = statusLabel(d);
  const chapters = d.chapters
    .map((ch) => {
      const items = ch.items.map((it) => item(it)).join("");
      const head = ch.implicit
        ? ""
        : `<div class="ch-h">依頼<span class="t">${hm(ch.ts)}</span></div><div class="ch-text${ch.isCommand ? " cmd" : ""}">${esc(ch.text)}</div>`;
      return `<section class="ch" id="ch-${esc(ch.id)}">${head}<div class="tl">${items}</div></section>`;
    })
    .join("");

  const nowLine =
    d.status === "waiting"
      ? `あなたの返事待ち（${ago(list.now - d.since)}）`
      : d.status === "working"
        ? `作業中${d.now.current ? `：${d.now.current}` : d.now.lastTool ? `：${d.now.lastTool}` : ""}`
        : d.status === "stalled"
          ? `止まっている（${ago(list.now - d.since)}動きなし）`
          : STATUS[d.status];

  app.innerHTML = `<div class="detail">
    <a class="back" href="#/">← 一覧</a>
    <div class="row" style="margin-top:6px">
      <div style="min-width:0">
        <p class="title" style="font-size:18px">${esc(d.title)}</p>
        <p class="meta">${machineChip(d)}${esc(short(d.cwd) || d.project)}${d.branch ? ` ・ ${esc(d.branch)}` : ""}</p>
        ${d.summary ? `<p class="line">${esc(d.summary)}</p>` : ""}
      </div>
      <span class="badge st-${d.status}">${label}</span>
    </div>
    <div class="stats">
      <div class="stat"><p>仮定・判断</p><b style="color:var(--warn)">${c.assumption}</b></div>
      <div class="stat"><p>スキップ・懸念</p><b style="color:var(--danger)">${c.skip + c.risk}</b></div>
      <div class="stat"><p>確認</p><b style="color:var(--accent)">${c.question}</b></div>
      <div class="stat"><p>発見</p><b style="color:var(--violet)">${c.discovery}</b></div>
    </div>
    <div class="filters">
      <button id="fAll" class="${state.onlyImp ? "" : "on"}">全部</button>
      <button id="fImp" class="${state.onlyImp ? "on" : ""}">大事なことだけ</button>
      <span style="margin-left:auto">${vscodeButton(d)}</span>
    </div>
    <div id="tl" class="${state.onlyImp ? "only-imp" : ""}">
      ${chapters}
      <div class="tl"><div class="ev now-ev"><span class="t" style="color:var(--accent)">いま</span><div class="body" style="color:var(--accent)">${esc(nowLine)}</div></div></div>
    </div>
    <div class="side">
      ${d.todos.length ? `<p><b>Todo</b>（${d.now.todoDone}/${d.now.todoTotal}）<br>${d.todos.map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "・"} ${esc(t.content)}`).join("<br>")}</p>` : ""}
      ${d.files.length ? `<p><b>触ったファイル</b>（${d.files.length}）<br>${d.files.map((f) => `<code>${esc(short(f))}</code>`).join("<br>")}</p>` : ""}
      <p>${d.closable.ok ? "閉じてよい" : `まだ閉じない：${esc(d.closable.why)}`} ・ <code>${esc(d.machine)} / ${esc(d.id)}</code></p>
    </div>
  </div>`;

  document.getElementById("fAll").onclick = () => setOnlyImp(false);
  document.getElementById("fImp").onclick = () => setOnlyImp(true);

  if (focus && state.lastFocus !== focus) {
    state.lastFocus = focus;
    const el = document.getElementById(`ev-${focus}`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.classList.add("flash");
    }
  } else {
    window.scrollTo(0, keepScroll);
  }
}

function item(it) {
  if (it.type === "tools") {
    const list = it.list.length > 4 ? [...it.list.slice(0, 3), `…ほか ${it.list.length - 3}件`] : it.list;
    return `<div class="ev tools" id="ev-${esc(it.uuid)}"><span class="t">${hm(it.ts)}</span><div class="body">${list.map(esc).join("<br>")}</div></div>`;
  }
  if (it.type === "note") return `<div class="ev imp"><span class="t">${hm(it.ts)}</span><div class="body">${esc(it.text)}</div></div>`;
  const imp = it.highlights.length > 0;
  return `<div class="ev${imp ? " imp" : ""}${it.final ? " final" : ""}" id="ev-${esc(it.uuid)}">
    <span class="t">${hm(it.ts)}${it.final ? " ・ 返答" : ""}</span>
    <div class="body${it.final ? "" : " clamp"}" data-expand>${esc(it.text)}</div>
    ${it.highlights.map((h) => `<div class="hl"><span class="k k-${h.kind}">${KIND[h.kind]}</span><span>${esc(h.text)}</span></div>`).join("")}
  </div>`;
}

function setOnlyImp(v) {
  state.onlyImp = v;
  document.getElementById("tl").classList.toggle("only-imp", v);
  document.getElementById("fAll").classList.toggle("on", !v);
  document.getElementById("fImp").classList.toggle("on", v);
}

// ---- クリック ----
// ヘッダーの件数：押すとその札だけに絞り込み、同じものをもう一度押すと解除。取り直さずに描き直す
summaryEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b || !state.list) return;
  state.filter = state.filter === b.dataset.filter ? null : b.dataset.filter;
  const r = route();
  renderSummary(state.list);
  renderSide(state.list, r.name === "detail" ? r.id : null);
  if (r.name === "list") renderList(state.list);
});

app.addEventListener("click", (e) => {
  const op = e.target.closest("[data-open]");
  if (op) return openSession(op);
  if (e.target.closest("[data-stop]")) return;
  const exp = e.target.closest("[data-expand]");
  if (exp) return exp.classList.toggle("clamp");
  const go = e.target.closest("[data-go]");
  if (go) location.hash = go.dataset.go;
});

// ---- 通知：返事待ちに変わったら、件数に関係なく1回だけ鳴らす ----
notifyBtn.onclick = async () => {
  state.audio ??= new AudioContext();
  await state.audio.resume();
  if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  state.notify = true;
  notifyBtn.textContent = "通知オン";
  notifyBtn.classList.add("on");
  beep();
};

function checkTransitions(list) {
  const newly = [];
  for (const s of list.sessions) {
    if (s.stale) continue;
    const prev = state.prevStatus.get(s.key);
    if (prev && prev !== "waiting" && s.status === "waiting") newly.push(s);
    state.prevStatus.set(s.key, s.status);
  }
  if (!newly.length || !state.notify) return;
  beep();
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    new Notification(newly.length === 1 ? `返事待ち：${newly[0].title}${multi() ? `（${newly[0].machine}）` : ""}` : `返事待ちが ${newly.length} 件増えました`);
  }
}

function beep() {
  const ctx = state.audio;
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(880, ctx.currentTime);
  o.frequency.setValueAtTime(1320, ctx.currentTime + 0.09);
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.32);
}

// ---- 更新 ----
let timer;
const reload = () => {
  clearTimeout(timer);
  timer = setTimeout(() => load().catch(console.error), 200);
};
window.addEventListener("hashchange", () => {
  state.lastFocus = null;
  window.scrollTo(0, 0);
  load().catch(console.error);
});
new EventSource("/api/stream").addEventListener("change", reload);
setInterval(reload, 30_000); // 経過時間の表示を進めるため
load().catch(console.error);
