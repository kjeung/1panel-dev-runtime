#!/usr/bin/env bash
# Supervise the virtual desktop that the Harness UI exposes through noVNC.
#
# The container publishes no VNC port: x11vnc binds loopback and the Harness
# web server bridges `/desktop/websockify` to it. This script owns Xvfb,
# Openbox, x11vnc and Chromium so the entrypoint has one PID (and one signal
# target) for the whole desktop. Chromium, Openbox and x11vnc are restarted in
# place; a dead Xvfb means the display is gone, so the supervisor exits and the
# container's restart policy recreates the desktop from a clean state.
#
# Logs land in $DSH_DESKTOP_LOG_DIR (default /tmp/dsh-desktop) and are also
# echoed to stderr on every restart, so `docker compose logs` shows the reason.
set -uo pipefail

display="${DISPLAY:-:99}"
width="${DSH_DESKTOP_WIDTH:-1440}"
height="${DSH_DESKTOP_HEIGHT:-900}"
depth="${DSH_DESKTOP_DEPTH:-24}"
vnc_port="${DSH_VNC_PORT:-5900}"
log_dir="${DSH_DESKTOP_LOG_DIR:-/tmp/dsh-desktop}"
runtime_dir="${XDG_RUNTIME_DIR:-/tmp/runtime-node}"
user_data_dir="${CHROME_USER_DATA_DIR:?CHROME_USER_DATA_DIR must be set by the entrypoint}"
start_url="${CHROME_START_URL:-about:blank}"

mkdir -p "$log_dir" "$runtime_dir" "$user_data_dir"
chmod 0700 "$runtime_dir"

# A container killed mid-write leaves Chromium's singleton files behind in the
# persistent profile, and the next start then refuses to open a window.
rm -f "$user_data_dir/SingletonCookie" "$user_data_dir/SingletonLock" "$user_data_dir/SingletonSocket"

declare -A pidvar=([xvfb]=xvfb_pid [openbox]=openbox_pid [x11vnc]=x11vnc_pid [chromium]=chromium_pid)
all_pids=()
xvfb_pid=""
openbox_pid=""
x11vnc_pid=""
chromium_pid=""
stopping=0

start_component() {
  local name="$1"
  case "$name" in
    xvfb)
      Xvfb "$display" -screen 0 "${width}x${height}x${depth}" -ac -nolisten tcp \
        >>"$log_dir/xvfb.log" 2>&1 &
      ;;
    openbox)
      openbox >>"$log_dir/openbox.log" 2>&1 &
      ;;
    x11vnc)
      # -localhost keeps the RFB service off every container interface: only the
      # Harness process (same loopback namespace) can reach it. Authentication
      # belongs to the reverse proxy in front of Harness, never to VNC.
      x11vnc -display "$display" -forever -shared -repeat -noxdamage \
        -rfbport "$vnc_port" -localhost -nopw >>"$log_dir/x11vnc.log" 2>&1 &
      ;;
    chromium)
      rm -f "$user_data_dir/SingletonCookie" "$user_data_dir/SingletonLock" "$user_data_dir/SingletonSocket"
      chromium-docker \
        --user-data-dir="$user_data_dir" \
        --password-store=basic \
        --remote-debugging-address=127.0.0.1 \
        --remote-debugging-port=9222 \
        --window-position=0,0 \
        --window-size="${width},${height}" \
        --no-first-run \
        --no-default-browser-check \
        --hide-crash-restore-bubble \
        "$start_url" >>"$log_dir/chromium.log" 2>&1 &
      ;;
    *)
      printf 'desktop-supervisor: unknown component %s\n' "$name" >&2
      return 1
      ;;
  esac
  local pid=$!
  printf -v "${pidvar[$name]}" '%s' "$pid"
  all_pids+=("$pid")
  printf 'desktop-supervisor: started %s (pid %s)\n' "$name" "$pid"
}

cleanup() {
  trap - TERM INT
  stopping=1
  local index pid
  for (( index=${#all_pids[@]}-1; index >= 0; index-- )); do
    pid="${all_pids[index]}"
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${all_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup TERM INT

start_component xvfb

ready=0
for _ in $(seq 1 100); do
  if xdpyinfo -display "$display" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    printf 'desktop-supervisor: Xvfb exited before %s became ready\n' "$display" >&2
    cat "$log_dir/xvfb.log" >&2
    exit 1
  fi
  sleep 0.1
done
if [ "$ready" != 1 ]; then
  printf 'desktop-supervisor: timed out waiting for virtual display %s\n' "$display" >&2
  cat "$log_dir/xvfb.log" >&2
  exit 1
fi

start_component openbox
start_component x11vnc
start_component chromium

# Restart the cheap components in place. One second between attempts doubles as
# a rate limit if a component keeps dying immediately.
while (( ! stopping )); do
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    wait "$xvfb_pid" 2>/dev/null || true
    printf 'desktop-supervisor: Xvfb exited; the virtual display is gone\n' >&2
    cleanup
    exit 1
  fi
  for name in openbox x11vnc chromium; do
    pid="${!pidvar[$name]}"
    if kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    wait "$pid" 2>/dev/null || true
    printf 'desktop-supervisor: %s exited; restarting\n' "$name" >&2
    start_component "$name"
  done
  sleep 1
done

cleanup
exit 0
