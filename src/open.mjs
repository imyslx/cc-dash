// セッションを VSCode で開く（この端末のセッションだけ）。
// Claude Code の VSCode 拡張は vscode://anthropic.claude-code/open?session=<ID> を受け付け、そのセッションのタブを開く
// （拡張 2.1.331 の URI ハンドラで確認。中では `--resume <ID>` で再開する）。
// ブラウザのリンクで開かず、サーバーが OS に開かせるのは、VSCode の中のブラウザから外部アプリを呼べないため。
import { spawn } from "node:child_process";
import { join } from "node:path";

export const sessionUri = (id) => `vscode://anthropic.claude-code/open?session=${encodeURIComponent(id)}`;

// 起動した環境の PATH に System32 が入っていないことがあるので、rundll32 は場所を省かずに指定する
const RUNDLL32 = join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe");

// OS に URI を開かせる。起動できたら resolve、できなければ reject（呼び出し側で「開けなかった」と返すため）
export function openUri(uri, platform = process.platform) {
  const [cmd, args] =
    platform === "win32"
      ? [RUNDLL32, ["url.dll,FileProtocolHandler", uri]] // cmd の start を通さないので & などの解釈を気にしなくてよい
      : platform === "darwin"
        ? ["open", [uri]]
        : ["xdg-open", [uri]];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    p.once("error", reject);
    p.once("spawn", () => {
      p.unref();
      resolve();
    });
  });
}
