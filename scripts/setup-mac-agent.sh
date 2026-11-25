#!/bin/bash
# Mac を cc-dash のエージェントとして常駐させる（docs/multi-device.md の「1. Mac」を1本にしたもの）
#   bash scripts/setup-mac-agent.sh
# やること：
#   1. node（22以上）と Tailscale の IP を確かめる
#   2. トークンを読む（このフォルダの mac-agent.token → なければ入力を求める）
#   3. フックを登録する（~/.claude/settings.json。書き込む前にバックアップが残る）
#   4. ~/Library/LaunchAgents/dev.cc-dash.agent.plist を書いて常駐させる
#   5. Tailscale の IP で応答するか確かめる
# 外したいとき：
#   launchctl bootout gui/$(id -u)/dev.cc-dash.agent && rm ~/Library/LaunchAgents/dev.cc-dash.agent.plist
#   npm run hooks:uninstall
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="dev.cc-dash.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NAME="${CC_DASH_NAME:-Mac}"
PORT="${CC_DASH_PORT:-4319}"
DATA="$HOME/.cc-dash"
TOKEN_FILE="$ROOT/mac-agent.token"

fail() { echo "✖ $*" >&2; exit 1; }

# 1. node
NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "node が見つかりません（Node.js 22 以上が必要です）"
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 22 ] || fail "Node.js 22 以上が必要です（今: $("$NODE" -v)）"
echo "✔ node: $NODE ($("$NODE" -v))"
case "$NODE" in
  */.nvm/*) echo "  ※ nvm のバージョンごとのパスです。この Node を消すと常駐が止まります（そのときはこのスクリプトを実行し直す）" ;;
esac

# 1. Tailscale の IP（CLI がなければアプリ同梱のものを使う）
TS=""
if command -v tailscale >/dev/null 2>&1; then
  TS="tailscale"
elif [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
  TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
[ -n "$TS" ] || fail "Tailscale が見つかりません。インストールしてログインしてください"
IP="$("$TS" ip -4 2>/dev/null | head -1 || true)"
[ -n "$IP" ] || fail "Tailscale の IP を取れません。Tailscale にログインしているか確認してください"
echo "✔ Tailscale の IP: $IP"

# 2. トークン
TOKEN=""
if [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  echo "✔ トークン: $TOKEN_FILE から読みました"
else
  read -rsp "トークンを貼り付けて Enter: " TOKEN
  echo
fi
[ -n "$TOKEN" ] || fail "トークンがありません"

# 3. フック
"$NODE" "$ROOT/scripts/install-hooks.mjs"

# 4. LaunchAgent
PATH_DIRS="$(dirname "$NODE")"
CLAUDE="$(command -v claude || true)"
[ -n "$CLAUDE" ] && PATH_DIRS="$PATH_DIRS:$(dirname "$CLAUDE")"
PATH_DIRS="$PATH_DIRS:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$DATA" "$(dirname "$PLIST")"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

umask 077 # トークンを含むので本人だけが読めるようにする
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/src/main.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_DASH_HOST</key><string>$IP</string>
    <key>CC_DASH_PORT</key><string>$PORT</string>
    <key>CC_DASH_TOKEN</key><string>$TOKEN</string>
    <key>CC_DASH_NAME</key><string>$NAME</string>
    <key>PATH</key><string>$PATH_DIRS</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DATA/agent.log</string>
  <key>StandardErrorPath</key><string>$DATA/agent.err.log</string>
</dict>
</plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✔ 常駐させました: $PLIST"
echo "  ログ: $DATA/agent.log / $DATA/agent.err.log"

# 5. 応答の確認
for _ in $(seq 1 20); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 -H "Authorization: Bearer $TOKEN" "http://$IP:$PORT/api/sessions" || true)"
  [ "$CODE" = "200" ] && break
  sleep 0.5
done
[ "$CODE" = "200" ] || fail "http://$IP:$PORT が応答しません（HTTP ${CODE}）。$DATA/agent.err.log を確認してください"
echo "✔ 応答あり: http://$IP:$PORT （端末名: ${NAME}）"

[ -f "$TOKEN_FILE" ] && rm -f "$TOKEN_FILE" && echo "✔ $TOKEN_FILE を消しました（トークンは plist に入っています）"
echo
echo "完了です。macOS のファイアウォールで node への着信を聞かれたら「許可」を押してください。"
