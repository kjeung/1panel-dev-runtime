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

# Where the user-facing state lives. The whole volume is the persistent home;
# DSH_HOME is deliberately left unset so DSH derives `$HOME/.dsh` itself, which
# is the layout its own defaults and the plugin ecosystem assume (ADR 0003).
#
# The home is /home/node — the same path /etc/passwd records for `node`. ADR 0004
# chose that after ssh/ssh-keygen/ssh-copy-id turned out to resolve `~` through
# getpwuid() and ignore $HOME, so any split between the two leaves keys, known
# hosts and ssh config outside the volume.
home_root=/home/node
dsh_home="$home_root/.dsh"
chrome_profile="$home_root/chrome-profile"

# Data-volume ownership. DSH runs as `node`; every directory it writes must be
# node-owned, and `install -d` applies `-o/-g` only to the directory it is given
# (parents it creates stay root-owned), so every managed level is listed. The
# data root is created here rather than left to DSH so a fresh volume never
# starts with root-owned parents.
#
# `.ssh` is created too: ssh-keygen refuses to run in a home without it, and the
# directory has to exist with mode 0700 before ssh will use a key from it.
prepare_dsh_volume() {
  local root="$1"
  install -d -m 0700 -o node -g node "$root" "$root/.dsh" "$root/.ssh"
}

# A volume inherited from an older image — or touched by a root-run npm/pnpm —
# can still hold root-owned files. `dsh plugin` and the plugin market's own
# installs run as node and would fail with EACCES, so repair those trees once
# per boot. `-h` rewrites symlink ownership without changing the image-owned
# files the links point at.
repair_ownership() {
  local target="$1"
  [[ -d "$target" ]] || return 0
  if [[ -n "$(find "$target" -xdev ! -type l ! -user node -print -quit 2>/dev/null)" ]]; then
    chown -R -h node:node "$target"
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
  # ADR 0004: the home must be the one /etc/passwd records for `node`. ssh and
  # its relatives resolve `~` through getpwuid() and ignore $HOME, so drifting
  # apart by even one path segment would put keys and known_hosts outside the
  # volume while Node tooling kept writing inside it.
  passwd_home="$(getent passwd node | cut -d: -f6)"
  if [[ "$passwd_home" != "$home_root" ]]; then
    printf 'self-test: the passwd home of node (%s) does not match HOME (%s)\n' \
      "$passwd_home" "$home_root" >&2
    exit 1
  fi
  # The data volume must belong to node: both a fresh layout and root-owned
  # trees left by an older image have to come out node-owned.
  if [[ "$(id -u)" == 0 ]]; then
    fixture="$(mktemp -d)"
    mkdir -p "$fixture/.dsh/profiles/web/node_modules" \
      "$fixture/chrome-profile" "$fixture/.npm"
    printf '{}\n' > "$fixture/.dsh/profiles/web/package.json"
    prepare_dsh_volume "$fixture"
    repair_ownership "$fixture/.dsh/profiles"
    repair_ownership "$fixture/chrome-profile"
    repair_ownership "$fixture/.npm"
    for path in "$fixture" "$fixture/.dsh" "$fixture/.ssh" \
                "$fixture/.dsh/profiles/web" \
                "$fixture/.dsh/profiles/web/node_modules" \
                "$fixture/.dsh/profiles/web/package.json" \
                "$fixture/chrome-profile" "$fixture/.npm"; do
      if [[ "$(stat -c %U "$path")" != node ]]; then
        printf 'self-test: %s is not owned by node\n' "$path" >&2
        exit 1
      fi
    done
    if [[ "$(stat -c %a "$fixture/.ssh")" != 700 ]]; then
      printf 'self-test: %s must be mode 0700\n' "$fixture/.ssh" >&2
      exit 1
    fi
    rm -rf "$fixture"
  fi
  # The image deliberately leaves DSH_HOME unset, so the data root is $HOME/.dsh
  # and a plugin that probes `$HOME/.dsh/profiles/<profile>/node_modules/...`
  # resolves without any symlink. Assert that exact candidate shape resolves,
  # so reintroducing a DSH_HOME override that moves the root away from
  # `$HOME/.dsh` fails at image build time. Plain directories (no -o/-g) keep
  # this assertion runnable as an unprivileged user too.
  layout_fixture="$(mktemp -d)"
  mkdir -p "$layout_fixture/.dsh/profiles/web/node_modules/dsh-mattpocock-skills-deck/bundled-skills/wayfinder"
  layout_candidate="$layout_fixture/.dsh/profiles/web/node_modules/dsh-mattpocock-skills-deck/bundled-skills/wayfinder"
  if [[ ! -d "$layout_candidate" ]]; then
    printf 'self-test: the default $HOME/.dsh layout does not resolve (%s)\n' "$layout_candidate" >&2
    exit 1
  fi
  if [[ -L "$layout_fixture/.dsh" ]]; then
    printf 'self-test: $HOME/.dsh must be a real directory, not a symlink\n' >&2
    exit 1
  fi
  rm -rf "$layout_fixture"
  exit 0
fi

printf '\033[1;32m%s\033[0m\n' 'This image is maintained by 1Panel.'
printf '\033[1;33m%s\033[0m\n' 'For support or issue discussion, please visit:'
printf '\033[1;36m%s\033[0m\n' 'https://github.com/1Panel-dev/1Panel/discussions'

# DSH_ACCESS_HOST is the host name browsers use to reach the deployment. It is
# only used to fence the backend's /api requests; this container terminates no
# TLS. It is the only accepted form: the old Caddy variant's HTTPS_ACCESS_HOST
# and DSH_AUTH_* settings are not read.
access_host="${DSH_ACCESS_HOST:-}"

if ! is_access_host "$access_host"; then
  printf 'DSH_ACCESS_HOST is required: an IPv4 address or hostname without a scheme, path, or port (wildcard/broadcast addresses are rejected).\n' >&2
  exit 1
fi

if [[ "$access_host" == 127.* ]]; then
  printf 'Warning: DSH_ACCESS_HOST is a loopback address; the backend also trusts loopback Hosts, so the proxy Host allowlist adds nothing. Use the browser-facing host name.\n' >&2
fi

unset DSH_ACCESS_HOST

install -d -m 0750 -o node -g node /workspace
prepare_dsh_volume "$home_root"
# The profile and the desktop/package caches are written by DSH and the market
# as node. Repair trees a previous image (or a root-run npm/pnpm) left behind;
# image plugins themselves are loaded by absolute path (see the overlays), so
# they never touch the data volume.
repair_ownership "$dsh_home/profiles"
repair_ownership "$chrome_profile"
repair_ownership "$home_root/.npm"
repair_ownership "$home_root/.local/share/pnpm"
repair_ownership "$home_root/.ssh"

dsh_root=/usr/local/lib/node_modules/@deepseek-ai/dsh
desktop_patch=/opt/deepseek-harness/web-desktop.cordis.patch.yml
profile_manifest="$dsh_home/profiles/web/package.json"
desktop_enabled="${DSH_DESKTOP_ENABLED:-1}"

fi

password_hash="$(caddy hash-password --algorithm argon2id --plaintext "$auth_password")"
unset HTTPS_ACCESS_HOST DSH_AUTH_USERNAME DSH_AUTH_PASSWORD auth_password

install -d -m 0700 -o node -g node /data/dsh /data/dsh/home
install -d -m 0750 -o node -g node /workspace
install -d -m 0700 -o caddy -g caddy /data/caddy /data/caddy/config

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
# DSH_HOME is intentionally omitted so DSH derives `$HOME/.dsh`; both the
# launcher and everything it spawns then agree on one data root (ADR 0003).
gosu node env \
  HOME="$home_root" \
  DSH_TELEMETRY_DISABLED=1 \
  ONEPANEL_DSH_AUTH_PROXY=1 \
  node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
    "${dsh_args[@]}" &
dsh_pid=$!
pids+=("$dsh_pid")

if [[ "$desktop_enabled" != "0" ]]; then
  # Chromium keeps its profile in the data volume, so logins and downloads
  # survive a container upgrade.
  export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-$chrome_profile}"
  gosu node env HOME="$home_root" \
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
  HOME="$home_root" \
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
