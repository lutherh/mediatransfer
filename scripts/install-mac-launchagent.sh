#!/usr/bin/env bash
# Install a per-user launchd agent that auto-mounts the Scaleway S3 bucket at
# login and keeps it mounted (restarts rclone on crash).
#
# Why a launchd agent and not --background?
#   - launchd owns the process lifecycle: KeepAlive restarts rclone on crash,
#     RunAtLoad starts it at every login, and we don't need a PID file.
#   - The agent runs the mount script in FOREGROUND (no --background flag) so
#     launchd actually has a process to supervise.
#
# Usage:
#   ./scripts/install-mac-launchagent.sh             # install + load
#   ./scripts/install-mac-launchagent.sh --uninstall # unload + remove
#   ./scripts/install-mac-launchagent.sh --status    # show launchctl state

set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "ERROR: this installer is macOS only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LABEL="uk.4to.mediatransfer.s3mount"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$ROOT_DIR/data/logs"
MOUNT_SCRIPT="$SCRIPT_DIR/mount-s3.sh"

# Resolve rclone path — launchd has a minimal PATH so we hard-code it.
RCLONE_BIN="$(command -v rclone || true)"
if [ -z "$RCLONE_BIN" ]; then
  echo "ERROR: rclone is not installed. Run: brew install rclone" >&2
  exit 1
fi
RCLONE_DIR="$(dirname "$RCLONE_BIN")"

uninstall() {
  if launchctl list "$LABEL" &>/dev/null; then
    echo "Unloading launchd agent..."
    launchctl unload "$PLIST" 2>/dev/null || true
  fi
  if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    echo "Removed $PLIST"
  fi
  # launchctl unload sends SIGTERM to rclone, which stops the NFS server but
  # may leave a stale client-side mount. Clean that up too.
  if mount | grep -q "$ROOT_DIR/data/immich-s3"; then
    echo "Unmounting stale NFS mount..."
    "$MOUNT_SCRIPT" --unmount || true
  fi
  echo "Done."
}

status() {
  echo "Plist: $PLIST"
  if [ -f "$PLIST" ]; then
    echo "  installed: yes"
  else
    echo "  installed: no"
  fi
  if launchctl list "$LABEL" &>/dev/null; then
    echo "  launchd:"
    launchctl list "$LABEL" | sed 's/^/    /'
  else
    echo "  launchd: not loaded"
  fi
  echo "Mount table:"
  mount | grep -E "data/immich-s3|nfs.*mounted by" | sed 's/^/  /' || echo "  (no NFS mount)"
}

case "${1:-}" in
  --uninstall|-u) uninstall ; exit 0 ;;
  --status|-s)    status ; exit 0 ;;
esac

# Pre-flight: the mount script must already be working before we wrap it
# in launchd, otherwise debugging is a nightmare.
if [ ! -x "$MOUNT_SCRIPT" ]; then
  echo "ERROR: $MOUNT_SCRIPT is not executable" >&2
  exit 1
fi
if [ ! -f "$ROOT_DIR/.env" ] || [ ! -f "$ROOT_DIR/.env.immich" ]; then
  echo "ERROR: .env and .env.immich must exist before installing the agent" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

# If a previous version is loaded, unload it first so we can rewrite the plist.
if launchctl list "$LABEL" &>/dev/null; then
  echo "Unloading previous agent..."
  launchctl unload "$PLIST" 2>/dev/null || true
fi

# If a manual `mount-s3.sh --background` mount is already up, take it down
# so the launchd-managed rclone can claim the mount point cleanly.
if mount | grep -q "$ROOT_DIR/data/immich-s3"; then
  echo "Found existing manual mount — unmounting before launchd takes over..."
  "$MOUNT_SCRIPT" --unmount || true
fi

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${MOUNT_SCRIPT}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${RCLONE_DIR}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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

  <!-- Don't hammer launchd if rclone keeps failing (e.g. bad creds). -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/s3mount.out.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/s3mount.err.log</string>
</dict>
</plist>
PLIST_EOF

echo "Wrote $PLIST"
echo "Loading agent..."
launchctl load -w "$PLIST"

# Give rclone a moment to mount before reporting status.
sleep 3
echo
status
echo
echo "Logs:"
echo "  out: $LOG_DIR/s3mount.out.log"
echo "  err: $LOG_DIR/s3mount.err.log"
echo
echo "To remove: $0 --uninstall"
