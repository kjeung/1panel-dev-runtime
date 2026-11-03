# One default for the whole build: a per-stage default would let the stages
# drift apart (for example installing Browser Use for an older DSH than the
# image actually runs). Each stage re-declares the ARG without a value and
# inherits this one; `--build-arg DSH_VERSION=...` still overrides all of them.
ARG DSH_VERSION=0.2.1-rc.5
# The community plugin market is not a DSH dependency and its peer range tracks
# the DSH minor line; bump it together with DSH_VERSION (see SYNC-UPSTREAM.md §5).
ARG DSH_MARKET_VERSION=1.73.9

FROM node:24-bookworm-slim AS dsh-builder

ARG DSH_VERSION

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

ARG DSH_VERSION

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

# Community plugin market (dshmarket), shipped as image content so a fresh data
# volume has it without a network install. It is installed outside DSH's prefix
# first: adding packages directly to DSH's published, generated node_modules can
# make npm prune packages DSH owns. `--ignore-scripts` matches the Browser Use
# stage; the package needs no build step.
FROM node:24-bookworm-slim AS dsh-market

ARG DSH_MARKET_VERSION

RUN mkdir -p /opt/dshmarket && \
    npm pack --pack-destination /tmp "dshmarket@${DSH_MARKET_VERSION}" && \
    tar --extract --gzip \
      --file "/tmp/dshmarket-${DSH_MARKET_VERSION}.tgz" \
      --strip-components=1 \
      --directory /opt/dshmarket && \
    npm install \
      --prefix /opt/dshmarket \
      --package-lock=false \
      --omit=dev \
      --no-audit \
      --no-fund \
      --ignore-scripts \
      --legacy-peer-deps && \
    test "$(node -p 'require("/opt/dshmarket/package.json").version')" = "${DSH_MARKET_VERSION}" && \
    test -f /opt/dshmarket/cordis.patch.yml && \
    test "$(node -p 'require("/opt/dshmarket/package.json").dsh.bundle.patch')" = "./cordis.patch.yml" && \
    rm -f "/tmp/dshmarket-${DSH_MARKET_VERSION}.tgz" && \
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
ARG DSH_VERSION
ARG DSH_MARKET_VERSION
ARG NOVNC_VERSION=1.6.0

LABEL org.opencontainers.image.source="https://github.com/1Panel-dev/runtime" \
      org.opencontainers.image.url="https://github.com/deepseek-ai/deepseek-harness" \
      org.opencontainers.image.title="1Panel DeepSeek Harness" \
      org.opencontainers.image.description="DeepSeek Harness image maintained by 1Panel with a same-origin Chromium/noVNC desktop and the dsh-market plugin market, meant to run behind an authenticated TLS reverse proxy" \
      org.opencontainers.image.version="${DSH_VERSION}" \
      org.opencontainers.image.vendor="1Panel" \
      io.github.1panel.dsh-market-version="${DSH_MARKET_VERSION}"

# Debian Chromium plus the X stack behind the embedded desktop. The desktop has
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
COPY --from=dsh-market /opt/dshmarket /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dshmarket

RUN node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
      --help >/dev/null && \
    install -d -m 0700 -o node -g node /data/dsh /data/dsh/home && \
    install -d -m 0750 -o node -g node /workspace

RUN npm install --global "pnpm@${PNPM_VERSION}" && \
    npm cache clean --force && \
    test "$(gosu node env HOME=/data/dsh/home pnpm --version)" = "$PNPM_VERSION"

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
COPY deepseek-harness/plugins/dsh-browser-desktop /opt/deepseek-harness/plugins/dsh-browser-desktop
COPY deepseek-harness/test-runtime.mjs /tmp/test-dsh-runtime.mjs
COPY deepseek-harness/test-desktop.mjs /tmp/test-dsh-desktop.mjs
COPY deepseek-harness/test-market.mjs /tmp/test-dsh-market.mjs

RUN chmod 0755 /usr/local/bin/dsh /usr/local/bin/docker-entrypoint.sh \
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
    node --test /tmp/test-dsh-desktop.mjs && \
    node --test /tmp/test-dsh-market.mjs && \
    node -e "Promise.all([import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'), import('node:fs')]).then(([{ evaluatePluginCompatibility, pluginCompatibilityWarning }, fs]) => { const manifest = JSON.parse(fs.readFileSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dshmarket/package.json', 'utf8')); const issue = evaluatePluginCompatibility(manifest, {}); if (issue) { console.error(pluginCompatibilityWarning(issue)); process.exit(1) } })" && \
    node -e "import('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js').then(({ WebServer }) => { const proto = WebServer?.prototype; if (typeof proto?.register !== 'function' || typeof proto?.registerUpgrade !== 'function') { console.error('dsh-host-webserver lost register/registerUpgrade: the desktop routes cannot mount'); process.exit(1) } })" && \
    mkdir -p /tmp/dsh-config-check /tmp/dsh-config-check-home && \
    DSH_HOME=/tmp/dsh-config-check HOME=/tmp/dsh-config-check-home \
      node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
        web --patch /opt/deepseek-harness/web-desktop.cordis.patch.yml \
            --patch /opt/deepseek-harness/web-market.cordis.patch.yml --dump-config >/dev/null && \
    rm -rf /tmp/dsh-config-check /tmp/dsh-config-check-home && \
    rm /tmp/test-dsh-runtime.mjs /tmp/test-dsh-desktop.mjs /tmp/test-dsh-market.mjs

ENV DSH_HOME=/data/dsh \
    DSH_TELEMETRY_DISABLED=1 \
    DSH_NOVNC_VERSION=${NOVNC_VERSION} \
    npm_config_store_dir=/data/dsh/pnpm-store \
    DISPLAY=:99 \
    XDG_RUNTIME_DIR=/tmp/runtime-node \
    XDG_CACHE_HOME=/data/dsh/home/.cache \
    XDG_CONFIG_HOME=/data/dsh/home/.config \
    XDG_DATA_HOME=/data/dsh/home/.local/share \
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
