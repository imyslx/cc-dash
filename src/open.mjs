// セッションを VSCode で開く（この端末のセッションだけ）。
// Claude Code の VSCode 拡張は vscode://anthropic.claude-code/open?session=<ID> を受け付け、そのセッションのタブを開く
// （拡張 2.1.331 の URI ハンドラで確認。中では `--resume <ID>` で再開する）。
// ブラウザのリンクで開かず、サーバーが OS に開かせるのは、VSCode の中のブラウザから外部アプリを呼べないため。
import { spawn } from "node:child_process";

export const sessionUri = (id) => `vscode://anthropic.claude-code/open?session=${encodeURIComponent(id)}`;

export function openUri(uri, platform = process.platform) {
  const [cmd, args] =
    platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", uri]] // cmd の start を通さないので & などの解釈を気にしなくてよい
      : platform === "darwin"
        ? ["open", [uri]]
        : ["xdg-open", [uri]];
  const p = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
  p.on("error", (e) => console.warn(`[open] ${cmd} を起動できません: ${e.message}`));
  p.unref();
}
