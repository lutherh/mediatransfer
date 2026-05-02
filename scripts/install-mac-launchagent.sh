#!/usr/bin/env bash
# Install per-user launchd agents for fully hands-off macOS boot.
#
# Two agents:
#   1. uk.4to.mediatransfer.s3mount   — mounts the Scaleway S3 bucket via
#      `rclone nfsmount` (run in supervised foreground; launchd handles
#      restarts). NFS port is pinned via RCLONE_NFS_PORT in .env.immich so
#      restarts are transparent to the kernel NFS client.
#   2. uk.4to.mediatransfer.stack     — once the mount is healthy, starts
#      the Immich + tunnel stack via `start-all.sh up`. RunAtLoad only;
#      not KeepAlive (Docker handles container restarts itself).
#   3. uk.4to.mediatransfer.queuewatchdog — every 5 min, probes Immich's
#      BullMQ workers. Catches the 2026-05-02 failure mode where the
#      microservices process bootstraps but only registers some workers,
#      leaving the container falsely (healthy). Auto-recovers via
#      `docker stop && docker start` (a plain `restart` is insufficient).
#      Skipped if IMMICH_WATCHDOG_API_KEY is not set in .env.immich.
#   4. uk.4to.mediatransfer.caffeinate — runs `caffeinate -dimsu` for the
#      lifetime of the user session so the Mac never idle-sleeps while
#      Immich/MediaTransfer/rclone are supposed to be running. KeepAlive
#      so it auto-restarts if killed.
#
# Why both? Without the stack agent, login = mount up but no Immich.
# Without the mount agent, login = Immich starts into an empty dir.
#
# OrbStack/Docker Desktop must be set to "Open at Login" separately —
# we add OrbStack as a System Events login item below.
#
# Usage:
#   ./scripts/install-mac-launchagent.sh             # install + load
#   ./scripts/install-mac-launchagent.sh --uninstall # remove everything
#   ./scripts/install-mac-launchagent.sh --status    # show state

set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "ERROR: macOS only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# rclone rc Unix domain socket — must match RC_SOCK in mount-s3.sh.
RC_SOCK="$ROOT_DIR/data/rclone-rc.sock"

# ── Helper: read a key from a .env file (kept in sync with mount-s3.sh) ──
read_env_val() {
  local file="$1" key="$2" default="${3:-}"
  local val
  val=$(grep -E "^\s*${key}\s*=" "$file" 2>/dev/null | head -1 | sed "s/^[^=]*=\s*//" | sed "s/^[\"']//;s/[\"']\s*$//" | tr -d '\r')
  echo "${val:-$default}"
}

LABEL_MOUNT="uk.4to.mediatransfer.s3mount"
LABEL_STACK="uk.4to.mediatransfer.stack"
LABEL_WATCHDOG="uk.4to.mediatransfer.queuewatchdog"
LABEL_CAFFEINATE="uk.4to.mediatransfer.caffeinate"
PLIST_MOUNT="$HOME/Library/LaunchAgents/${LABEL_MOUNT}.plist"
PLIST_STACK="$HOME/Library/LaunchAgents/${LABEL_STACK}.plist"
PLIST_WATCHDOG="$HOME/Library/LaunchAgents/${LABEL_WATCHDOG}.plist"
PLIST_CAFFEINATE="$HOME/Library/LaunchAgents/${LABEL_CAFFEINATE}.plist"
LOG_DIR="$ROOT_DIR/data/logs"
MOUNT_SCRIPT="$SCRIPT_DIR/mount-s3.sh"
START_SCRIPT="$SCRIPT_DIR/start-all.sh"
WATCHDOG_SCRIPT="$SCRIPT_DIR/immich-queue-watchdog.sh"

# Resolve absolute paths for binaries used inside launchd's minimal PATH.
RCLONE_BIN="$(command -v rclone || true)"
if [ -z "$RCLONE_BIN" ]; then
  echo "ERROR: rclone not installed. Run: brew install rclone" >&2
  exit 1
fi
DOCKER_BIN="$(command -v docker || true)"
BIN_DIR_RCLONE="$(dirname "$RCLONE_BIN")"
BIN_DIR_DOCKER="${DOCKER_BIN:+$(dirname "$DOCKER_BIN"):}"

flush_mount() {
  # Drain the vfs writeback cache before letting launchctl SIGTERM rclone.
  # Without this, in-flight writes (--vfs-cache-mode writes) are lost on
  # kill and the bytes never reach S3 -- this is how ~740 assets went
  # missing in the Apr 2026 incident.
  #
  # Skip entirely on first install when no mount yet exists, otherwise we
  # log a spurious "rc unreachable" warning.
  if ! mount | grep -Fq " $ROOT_DIR/data/immich-s3 "; then
    return 0
  fi
  # RCLONE_RC_PORT is read for legacy/fallback parity with mount-s3.sh,
  # but the rc client now talks over the Unix domain socket (RC_SOCK).
  local rc_port
  rc_port=$(read_env_val "$ROOT_DIR/.env.immich" RCLONE_RC_PORT 5573)
  : "${rc_port}"  # silence unused-var linters
  if ! command -v rclone &>/dev/null; then
    return 0
  fi
  # Liveness probe via rc/noop — a no-op method that doesn't require auth
  # configuration on the rc server. (rc/noopauth is the WRONG probe: it
  # asserts auth is set up, returning 401 when --rc-no-auth is absent
  # and the unix socket is the auth boundary, which is our case.)
  if ! rclone rc rc/noop --unix-socket "$RC_SOCK" --timeout 3s &>/dev/null; then
    echo "WARN: rclone rc unreachable at $RC_SOCK — skipping queue drain (relying on rclone SIGTERM grace period)" >&2
    return 0
  fi
  # There is NO `vfs/sync` rc method on rclone 1.x — only forget|list|
  # queue|queue-set-expiry|refresh|stats. The correct primitive is to
  # poll `vfs/queue` until it reports zero pending uploads. Earlier
  # versions called the non-existent `vfs/sync` and the `|| true` masked
  # the 404 — the actual flushing was happening via launchd's
  # ExitTimeOut=900 graceful-SIGTERM window.
  echo "Draining rclone vfs writeback queue via rc on $RC_SOCK ..."
  local deadline
  deadline=$(( $(date +%s) + 120 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local q_len
    q_len=$(rclone rc vfs/queue --unix-socket "$RC_SOCK" --timeout 5s 2>/dev/null \
      | jq -r '[.queue[]?] | length' 2>/dev/null || echo 0)
    if [ "${q_len:-0}" = "0" ]; then
      echo "  writeback queue empty"
      return 0
    fi
    echo "  $q_len item(s) still pending; sleeping 2s"
    sleep 2
  done
  echo "WARN: writeback drain timed out after 120s; relying on launchd ExitTimeOut grace" >&2
}

uninstall() {
  flush_mount
  for label in "$LABEL_CAFFEINATE" "$LABEL_WATCHDOG" "$LABEL_STACK" "$LABEL_MOUNT"; do
    if launchctl list "$label" &>/dev/null; then
      echo "Unloading $label..."
      launchctl unload "$HOME/Library/LaunchAgents/${label}.plist" 2>/dev/null || true
    fi
    rm -f "$HOME/Library/LaunchAgents/${label}.plist"
  done
  if mount | grep -Fq " $ROOT_DIR/data/immich-s3 "; then
    echo "Unmounting NFS mount..."
    "$MOUNT_SCRIPT" --unmount || true
  fi
  echo "Done. To also drop OrbStack from login items, do it via System Settings → General → Login Items."
}

status() {
  for label in "$LABEL_MOUNT" "$LABEL_STACK" "$LABEL_WATCHDOG" "$LABEL_CAFFEINATE"; do
    plist="$HOME/Library/LaunchAgents/${label}.plist"
    echo "── $label"
    [ -f "$plist" ] && echo "   plist: yes ($plist)" || echo "   plist: no"
    if launchctl list "$label" &>/dev/null; then
      pid=$(launchctl list "$label" | awk -F'=' '/"PID"/ {gsub(/[ ;]/,"",$2); print $2}')
      lastexit=$(launchctl list "$label" | awk -F'=' '/"LastExitStatus"/ {gsub(/[ ;]/,"",$2); print $2}')
      echo "   loaded: yes  pid=${pid:-none}  lastExit=${lastexit:-?}"
    else
      echo "   loaded: no"
    fi
  done
  echo "── Mount table:"
  mount | grep -E "data/immich-s3|nfs.*mounted by" | sed 's/^/   /' || echo "   (no NFS mount)"
  echo "── OrbStack login item:"
  osascript -e 'tell application "System Events" to get the name of every login item' 2>&1 | tr ',' '\n' | grep -i orbstack | sed 's/^/   /' || echo "   (not registered)"
  echo "── Docker:"
  if docker info &>/dev/null; then echo "   running"; else echo "   not running"; fi
}

case "${1:-}" in
  --uninstall|-u) uninstall ; exit 0 ;;
  --status|-s)    status ; exit 0 ;;
esac

# ── Pre-flight ──
[ -x "$MOUNT_SCRIPT" ] || { echo "ERROR: $MOUNT_SCRIPT missing/not executable" >&2; exit 1; }
[ -x "$START_SCRIPT" ] || { echo "ERROR: $START_SCRIPT missing/not executable" >&2; exit 1; }
[ -f "$ROOT_DIR/.env" ] || { echo "ERROR: .env missing" >&2; exit 1; }
[ -f "$ROOT_DIR/.env.immich" ] || { echo "ERROR: .env.immich missing" >&2; exit 1; }

mkdir -p "$LOG_DIR" "$(dirname "$PLIST_MOUNT")"

# Flush any running mount first so the writeback cache is drained.
flush_mount
# Unload any previous versions before rewriting.
for label in "$LABEL_CAFFEINATE" "$LABEL_WATCHDOG" "$LABEL_STACK" "$LABEL_MOUNT"; do
  plist="$HOME/Library/LaunchAgents/${label}.plist"
  if launchctl list "$label" &>/dev/null; then
    echo "Unloading previous $label..."
    launchctl unload "$plist" 2>/dev/null || true
  fi
done

# If a manual mount is up from `mount-s3.sh --background`, hand over to launchd.
if mount | grep -Fq " $ROOT_DIR/data/immich-s3 "; then
  echo "Found existing manual mount — unmounting before launchd takes over..."
  "$MOUNT_SCRIPT" --unmount || true
fi

# ── Mount agent (KeepAlive, supervised foreground rclone) ──
cat > "$PLIST_MOUNT" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_MOUNT}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${MOUNT_SCRIPT}</string>
    <string>--supervised</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${BIN_DIR_RCLONE}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <!-- ExitTimeOut: 15 minutes — gives rclone enough time to flush multi-GB
       writeback cache to Scaleway over slow uplinks. Default 20s loses data. -->
  <key>ExitTimeOut</key>
  <integer>900</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/s3mount.out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/s3mount.err.log</string>
</dict>
</plist>
PLIST_EOF
echo "Wrote $PLIST_MOUNT"

# ── Stack agent (RunAtLoad only — Docker manages containers) ──
cat > "$PLIST_STACK" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_STACK}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>set -e
# Wait up to 5 minutes for Docker to be ready (OrbStack starts at login).
for i in \$(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 5
done
docker info >/dev/null 2>&1 || { echo "Docker never came up" >&2; exit 1; }
# Wait up to 10 minutes for the S3 mount to be live. The mount agent
# can crash-loop briefly on stale rc sockets / EADDRINUSE, so keep this
# generous — if we exit, KeepAlive on this agent will retry anyway.
for i in \$(seq 1 120); do
  if mount | grep -Fq ' ${ROOT_DIR}/data/immich-s3 '; then break; fi
  sleep 5
done
mount | grep -Fq ' ${ROOT_DIR}/data/immich-s3 ' || { echo "S3 mount never came up" >&2; exit 1; }
exec '${START_SCRIPT}' up</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${BIN_DIR_DOCKER}${BIN_DIR_RCLONE}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <!-- Retry on non-zero exit (e.g. mount not yet up at login) but DON'T
       loop tight — ThrottleInterval enforces a 60s floor between launches.
       SuccessfulExit=false means we don't restart after the script's `exec
       start-all.sh up` finishes cleanly (start-all.sh is one-shot). -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stack.out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stack.err.log</string>
</dict>
</plist>
PLIST_EOF
echo "Wrote $PLIST_STACK"

# ── Watchdog agent (StartInterval, opt-out via missing API key) ──
WATCHDOG_API_KEY=$(read_env_val "$ROOT_DIR/.env.immich" IMMICH_WATCHDOG_API_KEY "")
# XML-escape the key before plist heredoc interpolation. Today's Immich keys are
# base64url-ish so this is defensive, but a paste error with `&`/`<`/`>` would
# otherwise produce a malformed plist that launchctl silently drops. (audit W1)
if [ -n "$WATCHDOG_API_KEY" ]; then
  WATCHDOG_API_KEY=$(printf '%s' "$WATCHDOG_API_KEY" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e "s/'/\&apos;/g" -e 's/"/\&quot;/g')
fi
if [ -z "$WATCHDOG_API_KEY" ]; then
  echo "WARN: IMMICH_WATCHDOG_API_KEY not set in .env.immich — skipping queuewatchdog agent."
  echo "      Create an API key in the Immich UI (Account Settings → API Keys) and add:"
  echo "        IMMICH_WATCHDOG_API_KEY=<key>"
  echo "      to .env.immich, then re-run this installer."
  rm -f "$PLIST_WATCHDOG"
else
  [ -x "$WATCHDOG_SCRIPT" ] || { echo "ERROR: $WATCHDOG_SCRIPT missing/not executable" >&2; exit 1; }
  cat > "$PLIST_WATCHDOG" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_WATCHDOG}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${WATCHDOG_SCRIPT}</string>
    <string>--auto-restart</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${BIN_DIR_DOCKER}${BIN_DIR_RCLONE}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>IMMICH_WATCHDOG_API_KEY</key>
    <string>${WATCHDOG_API_KEY}</string>
  </dict>

  <!-- Every 5 min. Cheap (<2s); reads /api/jobs + a single CLIENT LIST. -->
  <key>StartInterval</key>
  <integer>300</integer>

  <key>RunAtLoad</key>
  <true/>

  <!-- Non-zero exit IS the alert; don't tight-loop on it.
       launchd will fire again on the next StartInterval tick. -->
  <key>KeepAlive</key>
  <false/>

  <!-- Bound runtime: a stuck docker exec shouldn't pile up. -->
  <key>ExitTimeOut</key>
  <integer>120</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/queuewatchdog.out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/queuewatchdog.err.log</string>

  <key>LowPriorityIO</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF
  # Plist contains the API key in cleartext — restrict to user-only. (audit N1)
  chmod 600 "$PLIST_WATCHDOG"
  echo "Wrote $PLIST_WATCHDOG"
fi

# ── Caffeinate agent (keep Mac awake while logged in) ──
# `caffeinate -dimsu` prevents display, idle, disk, and system sleep, and
# asserts user activity. Equivalent to KeepingYouAwake / Amphetamine in
# "indefinite" mode. KeepAlive=true so it auto-restarts if killed.
cat > "$PLIST_CAFFEINATE" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_CAFFEINATE}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-dimsu</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/caffeinate.out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/caffeinate.err.log</string>
</dict>
</plist>
PLIST_EOF
echo "Wrote $PLIST_CAFFEINATE"

# ── OrbStack login item (so Docker socket is up at login) ──
HAS_ORBSTACK=$(osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | tr ',' '\n' | grep -ic orbstack || true)
if [ "$HAS_ORBSTACK" = "0" ]; then
  if [ -d "/Applications/OrbStack.app" ]; then
    echo "Adding OrbStack as a login item..."
    osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/OrbStack.app", hidden:true}' >/dev/null || true
  else
    echo "WARNING: /Applications/OrbStack.app not found — start it manually or install Docker Desktop and add it to login items." >&2
  fi
fi

echo "Loading agents..."
launchctl load -w "$PLIST_MOUNT"
launchctl load -w "$PLIST_STACK"
[ -f "$PLIST_WATCHDOG" ] && launchctl load -w "$PLIST_WATCHDOG"
launchctl load -w "$PLIST_CAFFEINATE"
sleep 4

echo
status
echo
echo "Logs:"
echo "  mount:      $LOG_DIR/s3mount.{out,err}.log"
echo "  stack:      $LOG_DIR/stack.{out,err}.log"
echo "  watchdog:   $LOG_DIR/queuewatchdog.{out,err}.log"
echo "  caffeinate: $LOG_DIR/caffeinate.{out,err}.log"
echo
echo "Remove with: $0 --uninstall"
