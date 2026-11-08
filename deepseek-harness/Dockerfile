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
FROM node:24-bookworm-slim AS browser-use

RUN mkdir -p /opt/dsh-browser-use && \
    npm install \
      --prefix /opt/dsh-browser-use \
      --package-lock=false \
      --omit=dev \
      --no-audit \
      --no-fund \
      --ignore-scripts \
      --legacy-peer-deps \
      "@deepseek-ai/dsh-browser-use@${DSH_VERSION}" \
      "@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@${DSH_VERSION}" && \
    test "$(node -p 'require("/opt/dsh-browser-use/node_modules/@deepseek-ai/dsh-browser-use/package.json").version')" = "${DSH_VERSION}" && \
    test "$(node -p 'require("/opt/dsh-browser-use/node_modules/@deepseek-ai/dsh-experimental-browser-use-playwright-mcp/package.json").version')" = "${DSH_VERSION}" && \
    npm cache clean --force

# noVNC is the browser-side VNC client. The Debian 12 package is 1.3.0, which
# cannot connect over a relative WebSocket URL (it insists on an explicit host);
# pin the upstream 1.6.0 asset tree instead so the viewer works on any origin
# and port the operator puts in front of it.
FROM node:24-bookworm-slim AS novnc

ARG NOVNC_VERSION=1.6.0
ARG NOVNC_SHA256=5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl && \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl --fail --location --retry 3 --output /tmp/novnc.tar.gz \
      "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz"; \
    printf '%s  %s\n' "${NOVNC_SHA256}" /tmp/novnc.tar.gz | sha256sum --check --strict -; \
    mkdir -p /opt/novnc; \
    tar --extract --gzip --file /tmp/novnc.tar.gz --directory /opt/novnc --strip-components=1; \
    rm -rf /opt/novnc/.github /opt/novnc/docs /opt/novnc/po /opt/novnc/snap \
      /opt/novnc/tests /opt/novnc/utils /opt/novnc/karma.conf.js /opt/novnc/eslint.config.mjs; \
    rm -f /tmp/novnc.tar.gz; \
    test -f /opt/novnc/vnc.html; \
    test -f /opt/novnc/app/ui.js; \
    test -f /opt/novnc/core/rfb.js; \
    test -f /opt/novnc/defaults.json; \
    test -f /opt/novnc/mandatory.json

FROM node:24-bookworm-slim

ARG PNPM_VERSION=11.7.0
# Re-declared so the version is recorded as image metadata as well.

LABEL org.opencontainers.image.source="https://github.com/1Panel-dev/runtime" \
      org.opencontainers.image.url="https://github.com/deepseek-ai/deepseek-harness" \
      org.opencontainers.image.title="1Panel DeepSeek Harness" \
      org.opencontainers.image.description="DeepSeek Harness image maintained by 1Panel with HTTPS access and persistent runtime data" \
      org.opencontainers.image.vendor="1Panel"

# no port of its own: x11vnc binds loopback and the Harness web server bridges
# the noVNC WebSocket, so the operator's existing TLS + authentication entry
# point stays the only way in. Noto CJK keeps Chinese pages and screenshots
# readable; fonts-liberation covers the Latin fallbacks Chromium expects.
# `websockify` is intentionally absent: the bridge lives in the plugin.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      bubblewrap \
      ca-certificates \
      chromium \
      curl \
      fonts-liberation \
      fonts-noto-cjk \
      git \
      gosu \
      openbox \
      openssh-client \
      ripgrep \
      tini \
      x11-utils \
      x11vnc \
      xvfb && \
    rm -rf /var/lib/apt/lists/*

# GitHub CLI: install the latest stable package from GitHub's official apt
# repository. This intentionally follows upstream, so a rebuild may pick up a
# newer gh; the build fails if the repository or package is unavailable.
RUN install -d -m 0755 /etc/apt/keyrings && \
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
COPY --from=browser-use /opt/dsh-browser-use/node_modules/. /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/

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
    install -d -m 0755 /usr/share/novnc

COPY --from=novnc /opt/novnc/. /usr/share/novnc/

COPY deepseek-harness/node-proxy.mjs /usr/local/bin/dsh-node-proxy
COPY deepseek-harness/dsh /usr/local/bin/dsh
COPY deepseek-harness/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY deepseek-harness/chromium-docker /usr/local/bin/chromium-docker
COPY deepseek-harness/desktop-supervisor.sh /usr/local/bin/dsh-desktop-supervisor
COPY deepseek-harness/web-desktop.cordis.patch.yml /opt/deepseek-harness/web-desktop.cordis.patch.yml
COPY deepseek-harness/web-market.cordis.patch.yml /opt/deepseek-harness/web-market.cordis.patch.yml
COPY deepseek-harness/test-runtime.mjs /tmp/test-dsh-runtime.mjs

RUN chmod 0755 /usr/local/bin/dsh /usr/local/bin/docker-entrypoint.sh && \
      /usr/local/bin/dsh-node-proxy /usr/local/bin/chromium-docker \
      /usr/local/bin/dsh-desktop-supervisor && \
    ln -s chromium-docker /usr/local/bin/chrome && \
    ln -s chromium-docker /usr/local/bin/google-chrome && \
    ln -s chromium-docker /usr/local/bin/google-chrome-stable && \
    install -d -m 0755 /opt/deepseek-harness/plugins/dsh-browser-desktop/node_modules/@deepseek-ai && \
    ln -s /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery \
      /opt/deepseek-harness/plugins/dsh-browser-desktop/node_modules/@deepseek-ai/schemastery && \
    install -d -m 0755 /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@1panel && \
    ln -s /opt/deepseek-harness/plugins/dsh-browser-desktop \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@1panel/dsh-browser-desktop && \
    dsh --help >/dev/null && \
    /usr/local/bin/docker-entrypoint.sh --self-test && \
    /usr/local/bin/dsh-node-proxy --self-test && \
    chromium-docker --version && \
    command -v Xvfb openbox x11vnc xdpyinfo >/dev/null && \
    node -e "Promise.all([import('/opt/deepseek-harness/plugins/dsh-browser-desktop/index.js'), import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-browser-use/lib/index.js'), import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-browser-use-playwright-mcp/lib/index.js')]).then(([plugin]) => { if (typeof plugin.apply !== 'function' || typeof plugin.viewerPath !== 'function') process.exit(1) })" && \
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
# a second place to keep in sync. XDG_RUNTIME_DIR stays explicit because it must
# NOT be on the volume.
ENV HOME=/home/node \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_NOVNC_VERSION=${NOVNC_VERSION} \
    DISPLAY=:99 \
    XDG_RUNTIME_DIR=/tmp/runtime-node \
    CHROME_BIN=/usr/local/bin/chromium-docker \
    CHROME_PATH=/usr/local/bin/chromium-docker \
    BROWSER=/usr/local/bin/chromium-docker \
    PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium-docker

WORKDIR /workspace

# Only the forwarding proxy is published. The Chromium desktop is served from
# /desktop on this same port; x11vnc and the DevTools endpoint stay loopback.
EXPOSE 8080

# The entrypoint waits up to 60 s for the backend before starting the proxy, so the
# start period must stay above that or a cold container is briefly marked unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS --noproxy '*' --max-time 5 http://127.0.0.1:8080/healthz >/dev/null || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
