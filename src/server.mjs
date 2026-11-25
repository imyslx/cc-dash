// 小さな HTTP サーバー。外部ライブラリなし。
//   GET /                   画面
//   GET /api/sessions       一覧（ハブなら全端末分をまとめる）
//   GET /api/sessions/:key  詳細（別端末のものは中継する）
//   GET /api/stream         変更通知（Server-Sent Events）
//   POST /api/sessions/:key/open  そのセッションを VSCode で開く（この端末のセッションだけ。src/open.mjs）
// ループバック以外からのアクセスにはトークンが要る（src/auth.mjs）。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";
import { authorized, tokenFrom, COOKIE } from "./auth.mjs";
import { mergeLists, splitKey } from "./merge.mjs";
import { openUri, sessionUri } from "./open.mjs";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export function createApp(store, { peers = null, name = config.name, token = config.token, open = openUri } = {}) {
  const clients = new Set();
  let version = 0;
  const notify = () => {
    version++;
    for (const res of clients) res.write(`event: change\ndata: ${version}\n\n`);
  };
  store.on("change", notify);
  peers?.on("change", notify);
  setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25_000).unref();

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const list = () => mergeLists(store.listView(), name, peers?.peers ?? []);

  async function detail(key) {
    const { peer, id } = splitKey(key);
    if (!peer) {
      const d = store.detailView(id);
      return d && { ...d, key: id, machine: name, self: true, stale: false, ssh: null };
    }
    const p = peers?.find(peer);
    if (!p) return null;
    const d = await peers.detail(peer, id).catch(() => null);
    return d && { ...d, key, machine: peer, self: false, stale: !p.online, ssh: p.ssh };
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (!authorized(req, url, token)) return json(res, 401, { error: "unauthorized" });

    // ブラウザで /?token=... を開いたら cookie に移してから URL から消す
    if (url.searchParams.has("token") && !p.startsWith("/api/")) {
      res.writeHead(302, {
        "set-cookie": `${COOKIE}=${encodeURIComponent(tokenFrom(req, url))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
        location: p,
      });
      return res.end();
    }

    try {
      const mOpen = p.match(/^\/api\/sessions\/([^/]+)\/open$/);
      if (mOpen) {
        // 別のサイトのページから勝手に呼ばれないよう、POST と専用ヘッダーを必須にする
        // （専用ヘッダー付きの他サイトからの要求は、ブラウザが事前確認の段階で止める）
        if (req.method !== "POST" || req.headers["x-cc-dash"] !== "open") return json(res, 405, { error: "method not allowed" });
        const { peer, id } = splitKey(decodeURIComponent(mOpen[1]));
        if (peer || !store.sessions.has(id)) return json(res, 404, { error: "not found" });
        try {
          await open(sessionUri(id));
        } catch (e) {
          console.warn(`[open] ${id} を開けませんでした: ${e.message}`);
          return json(res, 500, { error: "could not open" });
        }
        console.log(`[open] ${id}`);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/sessions") return json(res, 200, list());
      if (p.startsWith("/api/sessions/")) {
        const d = await detail(decodeURIComponent(p.slice("/api/sessions/".length)));
        return d ? json(res, 200, d) : json(res, 404, { error: "not found" });
      }
      if (p === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`event: change\ndata: ${version}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const file = join(PUBLIC, normalize(p === "/" ? "/index.html" : p));
      if (!file.startsWith(PUBLIC + sep)) return json(res, 403, { error: "forbidden" });
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EISDIR") return json(res, 404, { error: "not found" });
      console.error(e);
      json(res, 500, { error: "internal error" });
    }
  });
}
