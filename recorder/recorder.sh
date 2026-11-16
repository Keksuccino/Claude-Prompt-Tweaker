#!/bin/bash
# Runs the API recorder (record.py inside mitmproxy) as a launchd agent of the logged-in user.
#
#   recorder.sh start   installs and starts it; it starts again at every login and whenever it exits
#   recorder.sh retire  keeps the running one for the sessions that use it, but it neither restarts nor starts at login
#   recorder.sh stop    stops it now: sessions started while recording was on lose their connection
#   recorder.sh status  says whether it is installed and running
#
# Each command prints one JSON line for Claude Tweaker. Sessions reach the recorder through the HTTPS_PROXY that Claude
# Tweaker writes into ~/.claude/settings.json, so it must keep running while any such session does: hence the agent,
# which launchd restarts. record.py is copied to the main drive, so a recordings folder on a drive that is not mounted
# yet only stops the recording, never the proxy.

set -u

LABEL="com.keksuccino.claude-tweaker.recorder"
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${CLAUDE_TWEAKER_RECORDER_PORT:-18777}"
RECORDINGS="${CLAUDE_TWEAKER_RECORDINGS:-$(dirname "$HERE")/.recordings}"
STATE="$HOME/.claude/prompt-tweaker"
INSTALLED="$STATE/recorder"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-tweaker-recorder.log"
CA="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"
DOMAIN="gui/$(id -u)"

fail() {
  printf '{"ok":false,"error":"%s"}\n' "$1"
  exit 1
}

is_running() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q "state = running"
}

is_listening() {
  nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1
}

# The agent's definition. `keep` is true while recording is on: launchd restarts it and starts it at login.
write_plist() {
  local keep="$1" mitmdump="$2"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$mitmdump</string>
    <string>--quiet</string>
    <string>--listen-host</string><string>127.0.0.1</string>
    <string>--listen-port</string><string>$PORT</string>
    <string>--set</string><string>allow_hosts=^api\.anthropic\.com(:443)?\$</string>
    <string>--set</string><string>termlog_verbosity=warn</string>
    <string>--set</string><string>recordings=$RECORDINGS</string>
    <string>-s</string><string>$INSTALLED/record.py</string>
  </array>
  <key>RunAtLoad</key><$keep/>
  <key>KeepAlive</key><$keep/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
}

write_state() {
  mkdir -p "$STATE"
  printf '{"dir":"%s","port":%s,"proxy":"http://127.0.0.1:%s","ca":"%s"}\n' "$RECORDINGS" "$PORT" "$PORT" "$CA" > "$STATE/recorder.json"
}

start() {
  local mitmdump
  mitmdump="$(command -v mitmdump || true)"
  [ -z "$mitmdump" ] && [ -x /opt/homebrew/bin/mitmdump ] && mitmdump=/opt/homebrew/bin/mitmdump
  [ -z "$mitmdump" ] && fail "mitmproxy is not installed (brew install mitmproxy)"
  mkdir -p "$INSTALLED" "$RECORDINGS" || fail "could not create the recordings folder $RECORDINGS"
  cp "$HERE/record.py" "$INSTALLED/record.py" || fail "could not install record.py"
  write_plist true "$mitmdump"
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  launchctl bootstrap "$DOMAIN" "$PLIST" || fail "launchd did not take the recorder"
  # mitmproxy makes its certificate authority on its first start; sessions need it to trust the recorder.
  for _ in $(seq 1 100); do
    is_listening && [ -f "$CA" ] && break
    sleep 0.1
  done
  is_listening || fail "the recorder did not start listening on port $PORT (see $LOG)"
  [ -f "$CA" ] || fail "mitmproxy made no certificate at $CA"
  write_state
  status
}

retire() {
  local mitmdump
  mitmdump="$(command -v mitmdump || echo /opt/homebrew/bin/mitmdump)"
  [ -f "$PLIST" ] && write_plist false "$mitmdump"
  # The running agent keeps its loaded definition; the rewritten one applies from the next login, where it no longer
  # starts. Until then it stays up for the sessions started while recording was on.
  status
}

stop() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  [ -f "$PLIST" ] && mv "$PLIST" "$STATE/recorder/$LABEL.plist.off"
  # mitmproxy closes its port a moment after launchd stops it.
  for _ in $(seq 1 50); do
    is_listening || break
    sleep 0.1
  done
  status
}

status() {
  local running=false listening=false installed=false
  [ -f "$PLIST" ] && installed=true
  is_running && running=true
  is_listening && listening=true
  printf '{"ok":true,"installed":%s,"running":%s,"listening":%s,"port":%s,"dir":"%s"}\n' "$installed" "$running" "$listening" "$PORT" "$RECORDINGS"
}

case "${1:-status}" in
  start) start ;;
  retire) retire ;;
  stop) stop ;;
  status) status ;;
  *) fail "unknown command: $1 (start, retire, stop or status)" ;;
esac
