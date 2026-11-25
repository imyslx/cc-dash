// ハブ側：ほかの端末で動いている cc-dash（エージェント）の API を取りに行く（pull 型。ADR-0005）。
// 各エージェントの SSE を購読し、変更が来たら一覧を取り直す。切れたら5秒後に再接続する。
// peers.json の形：
//   [{ "name": "Mac", "url": "http://100.64.0.2:4319", "token": "...", "ssh": "yota-mac" }]
//   token を省くと CC_DASH_TOKEN を使う。ssh は VSCode の Remote-SSH で開くときのホスト名（任意）。
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { config } from "./config.mjs";

export function loadPeers(file = config.peersFile) {
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(list)) throw new Error("配列ではありません");
    return list
      .filter((p) => p && p.name && p.url)
      .map((p) => ({ name: String(p.name), url: String(p.url).replace(/\/+$/, ""), token: p.token || config.token, ssh: p.ssh || null }));
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`[peers] ${file} を読めませんでした: ${e.message}`);
    return [];
  }
}

export class Peers extends EventEmitter {
  constructor(list) {
    super();
    this.peers = list.map((p) => ({ ...p, online: false, lastOk: 0, error: null, data: null }));
  }

  start() {
    for (const p of this.peers) {
      this.fetchList(p);
      this.connect(p);
    }
    this.timer = setInterval(() => this.peers.forEach((p) => this.fetchList(p)), config.peerRefreshMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.stopped = true;
    for (const p of this.peers) p.abort?.abort();
  }

  headers(p) {
    return p.token ? { authorization: `Bearer ${p.token}` } : {};
  }

  async fetchList(p) {
    try {
      const r = await fetch(`${p.url}/api/sessions`, { headers: this.headers(p), signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(r.status === 401 ? "トークンが違います" : `HTTP ${r.status}`);
      p.data = await r.json();
      p.skew = Date.now() - p.data.now; // 端末間の時計のずれ（通信時間を含むが、表示には十分）
      p.online = true;
      p.lastOk = Date.now();
      p.error = null;
    } catch (e) {
      p.online = false;
      p.error = e.name === "TimeoutError" ? "応答なし" : e.message;
    }
    this.emit("change");
  }

  scheduleFetch(p) {
    clearTimeout(p.fetchTimer);
    p.fetchTimer = setTimeout(() => this.fetchList(p), 300);
  }

  async connect(p) {
    if (this.stopped) return;
    const abort = (p.abort = new AbortController());
    let watchdog;
    const kick = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => abort.abort(), config.peerTimeoutMs); // スリープ中の端末は TCP が切れないことがある
    };
    try {
      kick();
      const r = await fetch(`${p.url}/api/stream`, { headers: this.headers(p), signal: abort.signal });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        kick();
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const msg = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: change/m.test(msg)) this.scheduleFetch(p);
        }
      }
    } catch {
      // 下で再接続
    } finally {
      clearTimeout(watchdog);
    }
    if (this.stopped) return;
    if (p.online) {
      p.online = false;
      p.error = "接続が切れました";
      this.emit("change");
    }
    setTimeout(() => this.connect(p), 5000).unref?.();
  }

  find(name) {
    return this.peers.find((p) => p.name === name);
  }

  async detail(name, id) {
    const p = this.find(name);
    if (!p) return null;
    const r = await fetch(`${p.url}/api/sessions/${encodeURIComponent(id)}`, { headers: this.headers(p), signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    return r.json();
  }
}
