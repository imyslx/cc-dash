// ループバック（同じ端末）からのアクセスは素通し。それ以外はトークン必須（ADR-0005）。
// トークンは Authorization: Bearer ヘッダー、または cookie で受け取る。
// ブラウザで別端末の画面を直接開くときは /?token=... で一度開けば cookie に入る。
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.mjs";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const COOKIE = "cc_dash_token";

export const isLoopbackAddr = (a) => LOOPBACK.has(a);
export const isLoopbackHost = (h) => h === "127.0.0.1" || h === "::1" || h === "localhost";

function same(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function tokenFrom(req, url) {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const c = (req.headers.cookie || "").split(/;\s*/).find((s) => s.startsWith(COOKIE + "="));
  if (c) return decodeURIComponent(c.slice(COOKIE.length + 1));
  return url?.searchParams.get("token") ?? null;
}

export function authorized(req, url, token = config.token) {
  if (isLoopbackAddr(req.socket.remoteAddress)) return true;
  if (!token) return false;
  const t = tokenFrom(req, url);
  return t != null && same(t, token);
}
