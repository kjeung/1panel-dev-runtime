#!/usr/bin/env bash
set -Eeuo pipefail

is_access_host() {
  node -e '
    const { isIPv4 } = require("node:net");
    const value = process.argv[1];
    // Wildcard and broadcast literals are never a browser authority; accepting
    // them would only produce a white screen (and would trust a loopback alias).
    if (value === "0.0.0.0" || value === "255.255.255.255") process.exit(1);
    const hostname = value.length <= 253 && !/^[0-9.]+$/.test(value) &&
      value.split(".").every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label));
    process.exit(isIPv4(value) || hostname ? 0 : 1);
  ' "$1"
}

# Data-volume ownership. DSH runs as `node`; every directory it writes must be
# node-owned, and `install -d` applies `-o/-g` only to the directory it is given
# (parents it creates stay root-owned), so each level is listed explicitly.
prepare_dsh_volume() {
  local root="$1"
  install -d -m 0700 -o node -g node "$root" "$root/home" "$root/pnpm-store"
  install -d -m 0755 -o node -g node \
    "$root/profiles" "$root/profiles/web" "$root/profiles/web/node_modules"
}

# A volume inherited from an older image — or touched by a root-run npm/pnpm —
# can still hold root-owned files. `dsh plugin` and the plugin market's own
# installs run as node and would fail with EACCES, so repair the profile once
# per boot. `-h` rewrites symlink ownership without changing the image-owned
# files the links point at.
repair_dsh_volume_ownership() {
  local profiles="$1"
  [[ -d "$profiles" ]] || return 0
  if [[ -n "$(find "$profiles" -xdev ! -type l ! -user node -print -quit 2>/dev/null)" ]]; then
    chown -R -h node:node "$profiles"
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  is_access_host 203.0.113.10
  is_access_host dsh.example.com
  ! is_access_host https://dsh.example.com
  ! is_access_host 203.0.113.10:10443
  ! is_access_host 203.0.113.999
  ! is_access_host 0.0.0.0
  ! is_access_host 255.255.255.255
  # The data volume must belong to node: both a fresh layout and a root-owned
  # tree left by an older image have to come out node-owned.
  if [[ "$(id -u)" == 0 ]]; then
    fixture="$(mktemp -d)"
    mkdir -p "$fixture/data/profiles/web/node_modules/@1panel"
    printf '{}\n' > "$fixture/data/profiles/web/package.json"
    prepare_dsh_volume "$fixture/data"
    repair_dsh_volume_ownership "$fixture/data/profiles"
    for path in "$fixture/data" "$fixture/data/profiles" \
                "$fixture/data/profiles/web" \
                "$fixture/data/profiles/web/node_modules" \
                "$fixture/data/profiles/web/package.json"; do
      if [[ "$(stat -c %U "$path")" != node ]]; then
        printf 'self-test: %s is not owned by node\n' "$path" >&2
        exit 1
      fi
    done
    rm -rf "$fixture"
  fi
  exit 0
fi

printf '\033[1;32m%s\033[0m\n' 'This image is maintained by 1Panel.'
printf '\033[1;33m%s\033[0m\n' 'For support or issue discussion, please visit:'
printf '\033[1;36m%s\033[0m\n' 'https://github.com/1Panel-dev/1Panel/discussions'

# DSH_ACCESS_HOST is the host name browsers use to reach the deployment. It is
# only used to fence the backend's /api requests; this container terminates no
# TLS. HTTPS_ACCESS_HOST is accepted for compatibility with older deployments.
access_host="${DSH_ACCESS_HOST:-${HTTPS_ACCESS_HOST:-}}"

if [[ -z "${DSH_ACCESS_HOST:-}" && -n "${HTTPS_ACCESS_HOST:-}" ]]; then
  printf 'HTTPS_ACCESS_HOST is deprecated; rename it to DSH_ACCESS_HOST (this container serves plain HTTP).\n' >&2
fi

if ! is_access_host "$access_host"; then
  printf 'DSH_ACCESS_HOST must be an IPv4 address or hostname without a scheme, path, or port (wildcard/broadcast addresses are rejected).\n' >&2
  exit 1
fi

if [[ "$access_host" == 127.* ]]; then
  printf 'Warning: DSH_ACCESS_HOST is a loopback address; the backend also trusts loopback Hosts, so the proxy Host allowlist adds nothing. Use the browser-facing host name.\n' >&2
fi

unset DSH_ACCESS_HOST HTTPS_ACCESS_HOST

install -d -m 0750 -o node -g node /workspace
prepare_dsh_volume /data/dsh
repair_dsh_volume_ownership /data/dsh/profiles

dsh_root=/usr/local/lib/node_modules/@deepseek-ai/dsh
plugin_root=/opt/deepseek-harness/plugins/dsh-browser-desktop
desktop_patch=/opt/deepseek-harness/web-desktop.cordis.patch.yml
market_patch=/opt/deepseek-harness/web-market.cordis.patch.yml
market_source="$dsh_root/node_modules/dshmarket"
profile_dir=/data/dsh/profiles/web
profile_manifest="$profile_dir/package.json"
profile_modules="$profile_dir/node_modules"
desktop_enabled="${DSH_DESKTOP_ENABLED:-1}"

# A profile install of the market (`dsh plugin add dshmarket`, which updates
# itself) owns its own `dsh-market` row through its bundle layer. Leave it in
# place and do not pass the image overlay, so the row is never inserted twice.
market_declared=0
if [[ -f "$profile_manifest" ]] && node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.exit(Object.hasOwn(manifest.dependencies ?? {}, "dshmarket") ? 0 : 1);
' "$profile_manifest"; then
  market_declared=1
fi

# The desktop (and the two official Browser Use packages it shares Chromium
# with) are image content, not profile dependencies: link them into the Web
# profile before the profile tree is composed, so no network install runs at
# boot. Ownership stays with `node` because the profile lives in the data
# volume and `dsh plugin` must keep working on it.
link_into_profile() {
  local link="$1" source="$2" label="$3"
  if [[ ! -e "$source" ]]; then
    printf '%s is not installed in this image; skipping %s.\n' "$label" "$link" >&2
    return 0
  fi
  install -d -m 0755 -o node -g node "$(dirname "$link")"
  if [[ -L "$link" ]]; then
    rm -f "$link"
  elif [[ -e "$link" ]]; then
    printf '%s path already exists; leaving it unchanged: %s\n' "$label" "$link" >&2
    return 0
  fi
  ln -s "$source" "$link"
}

# Linked unconditionally: the patch entries are disabled at composition time by
# DSH_DESKTOP_ENABLED=0, so a resolvable-but-disabled module is the safe state.
link_into_profile "$profile_modules/@1panel/dsh-browser-desktop" \
  "$plugin_root" 'browser desktop plugin'
link_into_profile "$profile_modules/@deepseek-ai/dsh-browser-use" \
  "$dsh_root/node_modules/@deepseek-ai/dsh-browser-use" 'official Browser Use service'
link_into_profile "$profile_modules/@deepseek-ai/dsh-experimental-browser-use-playwright-mcp" \
  "$dsh_root/node_modules/@deepseek-ai/dsh-experimental-browser-use-playwright-mcp" \
  'official Playwright Browser Use provider'

# The community plugin market is image content as well. A profile-installed
# copy takes precedence (see market_declared above); only restore missing files
# for such a profile from the image copy.
if (( market_declared )); then
  [[ -e "$profile_modules/dshmarket/package.json" ]] || \
    link_into_profile "$profile_modules/dshmarket" "$market_source" \
      'community plugin market (fallback for a broken profile dependency)'
else
  link_into_profile "$profile_modules/dshmarket" "$market_source" \
    'community plugin market'
fi

pids=()
desktop_pid=""
cleanup() {
  if (( ${#pids[@]} )); then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# The profile name comes first, then the launcher's --patch overlay (composed
# after the profile's own layer), then the Web app's own flags. Putting --patch
# before the profile name makes the launcher demand an explicit --profile.
dsh_args=(web)
if [[ -f "$desktop_patch" ]]; then
  dsh_args+=(--patch "$desktop_patch")
fi
if [[ -f "$market_patch" ]] && [[ -e "$market_source" ]] && (( ! market_declared )); then
  dsh_args+=(--patch "$market_patch")
fi
dsh_args+=(--no-open --host 127.0.0.1 --port 3080
  --trusted-host 127.0.0.1:3080 "$access_host")

gosu node env \
  HOME=/data/dsh/home \
  DSH_HOME=/data/dsh \
  DSH_TELEMETRY_DISABLED=1 \
  ONEPANEL_DSH_AUTH_PROXY=1 \
  node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
    "${dsh_args[@]}" &
dsh_pid=$!
pids+=("$dsh_pid")

if [[ "$desktop_enabled" != "0" ]]; then
  # Chromium keeps its profile in the data volume, so logins and downloads
  # survive a container upgrade.
  export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/data/dsh/chrome-profile}"
  gosu node env HOME=/data/dsh/home \
    /usr/local/bin/dsh-desktop-supervisor &
  desktop_pid=$!
  pids+=("$desktop_pid")
fi

ready=false
for _ in {1..60}; do
  if curl -fsS --noproxy '*' --max-time 2 http://127.0.0.1:3080/ >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$dsh_pid" 2>/dev/null; then
    wait "$dsh_pid"
    exit $?
  fi
  if [[ -n "$desktop_pid" ]] && ! kill -0 "$desktop_pid" 2>/dev/null; then
    wait "$desktop_pid" || true
    printf 'The desktop supervisor exited during startup; check the container log and /tmp/dsh-desktop/.\n' >&2
    exit 1
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  printf 'DeepSeek Harness did not become ready within 60 seconds.\n' >&2
  exit 1
fi

gosu node env \
  HOME=/data/dsh/home \
  PROXY_LISTEN_HOST=0.0.0.0 \
  PROXY_LISTEN_PORT=8080 \
  PROXY_ALLOWED_HOSTS="$access_host" \
  node /usr/local/bin/dsh-node-proxy &
proxy_pid=$!
pids+=("$proxy_pid")

printf 'DeepSeek Harness is available at http://%s:8080 inside the container (plain HTTP).\n' "$access_host"
printf 'This container performs no TLS and no authentication: restrict port 8080 to the trusted reverse proxy.\n'
if [[ -n "$desktop_pid" ]]; then
  printf 'The Chromium desktop is served on the same origin at /desktop/ (RFB bridged to 127.0.0.1:5900).\n'
fi

wait_pids=("$dsh_pid" "$proxy_pid")
if [[ -n "$desktop_pid" ]]; then
  # A dead desktop supervisor must recycle the container, not linger silently.
  wait_pids+=("$desktop_pid")
fi

status=0
wait -n "${wait_pids[@]}" || status=$?
exit "$status"
