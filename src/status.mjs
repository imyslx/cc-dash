// 状態の札は「経過時間」ではなく「誰の番か」で決める（ADR-0002）。
//   waiting  … 返事待ち（あなたの番）。reason: reply / permission / interrupted
//   working  … 作業中（Claude の番で、動いている）
//   stalled  … 止まっている（Claude の番なのに一定時間動きがない）
//   idle     … 区切り（長時間触っていない）
//   closed   … 終了（SessionEnd を受け取った）
import { config } from "./config.mjs";

export const STATUS_ORDER = { waiting: 0, stalled: 1, working: 2, idle: 3, closed: 4 };

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

  // Stop が今回の依頼より後に来ていれば、Claude の番は終わっている
  if (h.stopTs && h.stopTs >= turnStart) return withIdle({ status: "waiting", reason: "reply", since: h.stopTs }, now);

  const hasHook = h.promptTs || h.stopTs || h.startedTs;
  if (!hasHook) {
    // フック未導入のセッション：会話記録だけで推定
    const claudeTurn = session.pendingTools.size > 0 || session.lastRole === "user";
    if (!claudeTurn) return withIdle({ status: "waiting", reason: "reply", since: lastAct }, now);
  }

  if (turnStart === 0 && lastAct === 0) return { status: "idle", since: 0 };
  if (now - lastAct > config.idleMs) return { status: "idle", since: lastAct };
  if (now - lastAct > config.stallMs) return { status: "stalled", since: lastAct };
  return { status: "working", since: turnStart || lastAct };
}

function withIdle(st, now) {
  if (now - st.since > config.idleMs) return { status: "idle", since: st.since };
  return st;
}
