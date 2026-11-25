// 自分のセッションと、エージェントから取ってきたセッションを1つの一覧にまとめる。
// 別の端末のセッションには key = "<端末名>::<セッションID>" を振る。
import { compareCards } from "./status.mjs";

export const SEP = "::";

export function splitKey(key) {
  const i = key.indexOf(SEP);
  return i < 0 ? { peer: null, id: key } : { peer: key.slice(0, i), id: key.slice(i + SEP.length) };
}

export function mergeLists(local, selfName, peers = []) {
  const sessions = local.sessions.map((s) => ({ ...s, key: s.id, machine: selfName, self: true, stale: false, ssh: null }));
  for (const p of peers) {
    if (!p.data) continue;
    for (const s of p.data.sessions) {
      const k = p.skew || 0; // 相手の時計で書かれた時刻を、こちらの時計に合わせる
      sessions.push({
        ...s,
        since: s.since && s.since + k,
        lastActivity: s.lastActivity && s.lastActivity + k,
        key: `${p.name}${SEP}${s.id}`,
        machine: p.name,
        self: false,
        stale: !p.online,
        ssh: p.ssh,
      });
    }
  }

  // 端末をまたいで見出しが重なるときは、ブランチか端末名を添える
  const count = {};
  for (const s of sessions) count[s.title] = (count[s.title] || 0) + 1;
  for (const s of sessions) if (count[s.title] > 1 && !s.titleSuffix) s.titleSuffix = s.branch || s.machine;

  sessions.sort((a, b) => Number(a.stale) - Number(b.stale) || compareCards(a, b));

  return {
    ...local,
    sessions,
    machines: [
      { name: selfName, self: true, online: true },
      ...peers.map((p) => ({ name: p.name, self: false, online: p.online, lastOk: p.lastOk, error: p.error })),
    ],
  };
}
