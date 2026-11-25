// 状態の札は「経過時間」ではなく「誰の番か」で決める（ADR-0002）。
//   waiting  … 返事待ち（あなたの番）。reason: reply / permission / interrupted
//   working  … 作業中（Claude の番で、動いている）。reason: agents（裏で動かしたサブエージェントの報告待ち）
//   stalled  … 止まっている（Claude の番なのに一定時間動きがない）
//   idle     … 区切り（長時間触っていない）
//   closed   … 終了（SessionEnd を受け取った）
import { config } from "./config.mjs";

export const STATUS_ORDER = { waiting: 0, stalled: 1, working: 2, idle: 3, closed: 4 };

// カードの並び順：札の順 → その札になった時刻（since）の新しい順。
// 最後に動いた時刻で並べると、作業中のセッションが動くたびに入れ替わって気が散るので使わない。
// since が同じときも順番が揺れないよう、最後はキーで決める。
export function compareCards(a, b) {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    (b.since || 0) - (a.since || 0) ||
    String(a.key ?? a.id).localeCompare(String(b.key ?? b.id))
  );
}

// フックのイベント列をセッションごとの最新状態に畳み込む
export function foldEvent(state, ev) {
  const s = (state[ev.session_id] ??= {});
  switch (ev.event) {
    case "SessionStart":
      s.startedTs = ev.ts;
      s.endedTs = 0;
      break;
    case "UserPromptSubmit":
      s.promptTs = ev.ts;
      break;
    case "Stop":
      s.stopTs = ev.ts;
      break;
    case "Notification":
      s.notif = { type: ev.notification_type || "unknown", ts: ev.ts, message: ev.message };
      break;
    case "SessionEnd":
      s.endedTs = ev.ts;
      break;
  }
  return state;
}

export function computeStatus(session, hook, now = Date.now()) {
  const lastAct = session.lastActivity || 0;
  const h = hook || {};
  const turnStart = Math.max(session.lastPromptTs || 0, h.promptTs || 0);

  if (h.endedTs && h.endedTs >= lastAct - 1000) return { status: "closed", since: h.endedTs };

  // 許可待ち：確認が出たあと会話記録が増えていなければ、あなたの番
  const n = h.notif;
  if (n && (n.type === "permission_prompt" || n.type === "elicitation_dialog") && n.ts >= turnStart && lastAct <= n.ts + 2000) {
    return { status: "waiting", reason: "permission", since: n.ts };
  }

  if (session.interrupted) return withIdle({ status: "waiting", reason: "interrupted", since: lastAct }, now);

  // Stop が今回の依頼より後に来ていれば、Claude の番は終わっている。
  // ただし裏で動かしたサブエージェントの報告を待っているなら、報告が届くと Claude が続きを始めるので作業中とする。
  // その間は親の会話記録が動かないので、「止まっている」の判定はしない
  if (h.stopTs && h.stopTs >= turnStart) return withIdle(endOfTurn(session, h.stopTs, now), now);

  const hasHook = h.promptTs || h.stopTs || h.startedTs;
  if (!hasHook) {
    // フック未導入のセッション：会話記録だけで推定
    const claudeTurn = session.pendingTools.size > 0 || session.lastRole === "user";
    if (!claudeTurn) return withIdle(endOfTurn(session, lastAct, now), now);
  }

  if (turnStart === 0 && lastAct === 0) return { status: "idle", since: 0 };
  if (now - lastAct > config.idleMs) return { status: "idle", since: lastAct };
  if (now - lastAct > config.stallMs) return { status: "stalled", since: lastAct };
  return { status: "working", since: turnStart || lastAct };
}

// Claude の番が一区切りついたときの札。報告を待っているサブエージェントがいれば作業中、いなければ返事待ち。
// 報告が来ないまま終わるサブエージェントもあるので、起動から上限（config.agentWaitMs）を過ぎたものは待たない
function endOfTurn(session, since, now) {
  const agents = [...(session.bgAgents?.values() ?? [])].some((ts) => now - ts < config.agentWaitMs);
  return agents ? { status: "working", reason: "agents", since } : { status: "waiting", reason: "reply", since };
}

function withIdle(st, now) {
  if (now - st.since > config.idleMs) return { status: "idle", since: st.since };
  return st;
}
