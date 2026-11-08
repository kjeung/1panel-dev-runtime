FROM caddy:2.11.4 AS caddy

FROM node:24-bookworm-slim AS dsh-builder

ARG DSH_VERSION=0.2.2-rc.1

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      g++ \
      make \
      python3 && \
    npm install --global "@deepseek-ai/dsh@${DSH_VERSION}"

COPY deepseek-harness/patch-dsh-authenticated-settings.mjs /tmp/patch-dsh-authenticated-settings.mjs
COPY deepseek-harness/patch-dsh-manifest-sse.mjs /tmp/patch-dsh-manifest-sse.mjs

RUN npm install --prefix /tmp/dsh-browser-compat --no-audit --no-fund \
      core-js@3.51.0 esbuild@0.28.2 && \
    node /tmp/patch-dsh-authenticated-settings.mjs && \
    node /tmp/patch-dsh-manifest-sse.mjs

# Official Browser Use plus its Playwright MCP provider, at exactly the DSH
# version installed above. They are installed outside DSH's package prefix
# first: adding packages directly to the published DSH tree can make npm prune
# packages that belong to DSH's generated distribution.

FROM node:24-bookworm-slim

ARG PNPM_VERSION=11.7.0

LABEL org.opencontainers.image.source="https://github.com/1Panel-dev/runtime" \
      org.opencontainers.image.url="https://github.com/deepseek-ai/deepseek-harness" \
      org.opencontainers.image.title="1Panel DeepSeek Harness" \
      org.opencontainers.image.description="DeepSeek Harness image maintained by 1Panel with HTTPS access and persistent runtime data" \
      org.opencontainers.image.vendor="1Panel"

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      ca-certificates \
      curl \
      git \
      gosu \
      openssh-client \
      ripgrep \
      tini \
      x11-utils \
    rm -rf /var/lib/apt/lists/*

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/* && \
    gh --version

COPY --from=dsh-builder /usr/local/lib/node_modules /usr/local/lib/node_modules

# The data root is the `node` user's OS home (/home/node), which is also the
# home recorded in /etc/passwd. Keeping the two identical is the whole point
# (ADR 0004): Node, git, gh and pnpm expand `~` from $HOME, while ssh, ssh-keygen,
# ssh-copy-id and scp resolve it through getpwuid() and ignore $HOME. A single
# path serves both, so a mounted volume holds every tool's state.
RUN node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      --help >/dev/null && \
    install -d -m 0700 -o node -g node /home/node && \
    install -d -m 0750 -o node -g node /workspace

RUN npm install --global "pnpm@${PNPM_VERSION}" && \
    npm cache clean --force && \
    test "$(gosu node env HOME=/home/node pnpm --version)" = "$PNPM_VERSION"

RUN install -d -m 0755 /opt/deepseek-harness && \
COPY deepseek-harness/node-proxy.mjs /usr/local/bin/dsh-node-proxy
COPY deepseek-harness/dsh /usr/local/bin/dsh
COPY deepseek-harness/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY deepseek-harness/test-runtime.mjs /tmp/test-dsh-runtime.mjs

RUN chmod 0755 /usr/local/bin/dsh /usr/local/bin/docker-entrypoint.sh && \
    dsh --help >/dev/null && \
    /usr/local/bin/docker-entrypoint.sh --self-test && \
    /usr/local/bin/dsh-node-proxy --self-test && \
    node --test /tmp/test-dsh-runtime.mjs && \
    rm /tmp/test-dsh-runtime.mjs
      node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
        web --patch /opt/deepseek-harness/web-desktop.cordis.patch.yml \
            --patch /opt/deepseek-harness/web-market.cordis.patch.yml \

# DSH_HOME is deliberately NOT set: DSH then derives `$HOME/.dsh`, which is the
# layout its own defaults and the plugin ecosystem assume (see ADR 0003).
#
# HOME is set explicitly (ADR 0004). It equals the passwd home of `node`, so
# tools that read $HOME (DSH, git, gh, pnpm) and tools that resolve the home
# through getpwuid() (ssh, ssh-keygen, ssh-copy-id, scp, sftp) land on the same
# directory. It also makes a bare `docker exec ... bash` inherit the right home
# instead of the passwd default, so ad-hoc commands never write to a stale path.
#
# The XDG_* cache/config/data paths are left at their defaults for the same
# reason: with HOME=/home/node they already resolve inside the home directory
# (`~/.cache`, `~/.config`, `~/.local/share`), and spelling them out only adds
ENV HOME=/home/node \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_NOVNC_VERSION=${NOVNC_VERSION} \

WORKDIR /workspace

# Only the forwarding proxy is published. The Chromium desktop is served from
EXPOSE 8080

# The entrypoint waits up to 60 s for the backend before starting the proxy, so the
# start period must stay above that or a cold container is briefly marked unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS --noproxy '*' --max-time 5 http://127.0.0.1:8080/healthz >/dev/null || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
