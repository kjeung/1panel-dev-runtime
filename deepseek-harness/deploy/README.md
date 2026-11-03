# DeepSeek Harness 部署指南（明文 HTTP 版，docker compose）

> 本仓库是 1Panel 官方镜像 `1panel/deepseek-harness` 的**改造版**：移除了 Caddy、TLS 与登录认证，
> 改用一个 Node 转发进程，专供「外部反向代理已负责登录认证 + TLS」的部署。
> 镜像源码在仓库根的 `deepseek-harness/`，本目录只放部署编排与文档；
> 可行性论证与实测见 `reports/node-proxy-feasibility.md`。

## 0. 结论与架构

只需要一个容器。容器内**没有登录、没有证书、没有 Caddy**：

```
浏览器 ──HTTPS──▶ 你的外部反向代理（认证 + 证书）
                     │  Host: dsh.example.com 原样透传、Origin 透传、WS 升级
                     ▼
              容器 0.0.0.0:8080  Node 转发（无认证，只做 Host 白名单 + 转发）
                     ▼
              容器 127.0.0.1:3080  dsh web（DSH 自身认证已被补丁旁路）
                     ├── /api、/plugins/…  DSH 自身
                     └── /desktop/…        noVNC 资源 + RFB 桥接 ──▶ 127.0.0.1:5900 x11vnc
                                                                      └─▶ :99 Xvfb + Openbox ──▶ Chromium
```

镜像内置一个可见的 Chromium 桌面（Debian Chromium、Noto CJK 中文字体、Xvfb + Openbox、
x11vnc、noVNC）。它**不额外开端口**，就挂在同一个 8080 的 `/desktop/` 上，
因此复用同一个域名、证书、Traefik router 与 Authentik 会话；为什么这样选（而不是
子域名或非标端口）见 [`docs/adr/0001-browser-desktop-access.md`](../../docs/adr/0001-browser-desktop-access.md)，
用法见本文 [§10](#10-内嵌-chromium-桌面novnc)。

镜像还内置社区插件市场 **dsh-market**（`dshmarket`，第三方 MIT 插件，构建参数
`DSH_MARKET_VERSION` 固定版本），入口在 DSH 的「插件」页；`DSH_MARKET_ENABLED=0`
可关闭入口。交付方式与数据卷边界见 [§10.7](#107-社区插件市场dsh-market)，理由见
[`docs/adr/0002-plugin-market-delivery.md`](../../docs/adr/0002-plugin-market-delivery.md)。

**安全边界完全在容器外**：任何能连到 8080 的人，只要发 `Host: <你的域名>` 就是 owner 全权
（能改设置、读凭据、执行 Agent 命令）。因此：

- compose 默认只把 8080 发布到**宿主机 127.0.0.1**，不要改成 `0.0.0.0`；
- 外部反代与容器分离部署时，用独立 docker 网络 + `expose`，不要发布端口；
- 可选开启 `PROXY_SHARED_SECRET`，让外部反代带一个共享密钥头（纵深防御，不是认证）。

## 1. 前置条件

- Docker Engine 24+ 与 Compose V2
- 一个外部反向代理，**必须**满足：
  - 保留原始 `Host`（含端口）：nginx 用 `$http_host`，不要用 `$host`
  - 透传 `Origin`、`Sec-Fetch-Site`、`Cookie`（DSH 用 Origin 做 CSRF 判定）
  - 支持 WebSocket 升级（`/api/remote.mux`）
  - 不缓冲响应（SSE `/plugins/events`、导出 ZIP、流式输出）
  - 请求体上限 ≥ 300 MiB（DSH 的上限；nginx 默认 1 MiB 会先 413）
- 一个浏览器实际访问的 IPv4 或域名（`DSH_ACCESS_HOST`），不要带协议/端口
- 容器需要能出网访问模型 API

## 2. 快速开始

本仓库**就是改造后的完整源码**（默认分支 `plain-http`，基于上游 `1Panel-dev/runtime`），
不需要再打补丁、也不需要第二个仓库：

```bash
git clone https://github.com/kjeung/runtime.git
cd runtime/deepseek-harness/deploy

cp .env.example .env
vi .env                 # 只需改 DSH_ACCESS_HOST
docker compose up -d --build
docker compose logs -f
```

- compose 的构建上下文是**仓库根**（`context: ../..`），Dockerfile 为 `deepseek-harness/Dockerfile`；
  仓库里还包含上游其它镜像源码，首次 build 会多传几十 MB 上下文，属正常。
- 只想用已构建镜像：设置 `DSH_IMAGE=…`，并删掉 compose 里的 `build:` 与 `pull_policy:` 段。
- 想在上游原版上复现改造：`patches/image-source.diff` 是相对上游的镜像源码改动
  （基线见 `patches/BASE`），用法见 [patches/README.md](patches/README.md)。
- 本地覆盖文件已在 `.gitignore` 里忽略：`.env`、`*.local.yml`、`compose.local.yml`、
  `docker-compose.local.yml`、`docker-compose.override.yml`、`data/`、`workspace/`、`.run/`。

### 本机定制放哪：`docker-compose.local.yml`

入库的 `docker-compose.yml` / `docker-compose.traefik.yml` 只放通用配置。**本机差异**（容器名、网络、端口、
数据目录、资源限制、基础文件没有转发的环境变量）放到 `docker-compose.local.yml`——它已在 `.gitignore` 里，
`git pull` 不会再和你本机的改动冲突（也就不会再有 stash/pop 冲突）。

```bash
cp docker-compose.local.yml.example docker-compose.local.yml
vi docker-compose.local.yml          # 只取消你要改的项
docker compose -f docker-compose.yml -f docker-compose.traefik.yml \
               -f docker-compose.local.yml up -d --build
```

> 一旦用了 `-f`，Compose **不会**再自动加载 `docker-compose.override.yml`：必须像上面这样把每个文件
> 都显式列出，并把 `docker-compose.local.yml` 放在最后，覆盖才会生效。
>
> 如果已经卡在冲突里：`git checkout HEAD -- docker-compose.yml` 取回入库版本，再把你的本机差异搬进
> `docker-compose.local.yml`，最后 `git add` 并 `git stash drop`（stash 在 pop 冲突后仍会保留）。

**为什么 `docker-compose.local.yml` 只写差异、不抄两个入库文件的全文？** 因为 `-f` 是层层叠加，
入库文件仍然参与合并：

| 字段类型 | 合并规则 |
| --- | --- |
| mapping（`environment`、`logging`、`build.args`…） | 按 key 合并，后者覆盖前者 |
| sequence（`ports`、`volumes`、`dns`…） | 追加；其中 `ports` 唯一键是 `{ip,target,published,protocol}`、`volumes` 是容器内 `target`，同一键合并/替换而不是重复 |
| `command` / `entrypoint` / `healthcheck.test` | 整体替换 |
| 要删除 / 要整体替换 | `!reset`（Compose ≥ 2.24）/ `!override`（≥ 2.24.4） |

所以"换宿主机端口"不能直接写 `ports:`（会变成 8080、8081 同时发布），要用
`ports: !override`；"不发布端口"用 `ports: !reset []`——模板里已经按这个写法注释好。
用 `docker compose … config` 可以随时查看合并后的最终模型。

若确实需要"单文件自包含"（例如平台只接受一个 compose 文件），不要手工维护副本，生成快照：

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml \
               -f docker-compose.local.yml config > merged.yml
```

`config` 会做变量插值（快照里含有真实密钥，别提交/外传），也不随 `git pull` 更新——上游改了
compose 就得重新生成，这正是默认使用差异文件的原因。

不想每次敲三个 `-f`：可以把文件列表写进 `.env`（Compose 支持从 `.env` 读取这些预定义变量），
之后在 `deploy/` 下直接 `docker compose up -d`：

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.traefik.yml:docker-compose.local.yml
```

> Linux/macOS 用 `:` 分隔；Windows 用 `;`（或自定义 `COMPOSE_PATH_SEPARATOR`）。

上游更新后如何同步见 [SYNC-UPSTREAM.md](SYNC-UPSTREAM.md)：仓库自带每日自动 PR，
也可以本地 `scripts/sync-upstream.sh` 手动 rebase（需要完整历史；浅克隆请先 `git fetch --unshallow`）。

日志出现下面两行即就绪：

```
DeepSeek Harness is available at http://dsh.example.com:8080 inside the container (plain HTTP).
This container performs no TLS and no authentication: restrict port 8080 to the trusted reverse proxy.
```

构建完成后先做一次宿主机冒烟（`Host` 换成你的 `DSH_ACCESS_HOST`）：

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' \
  -H 'Host: dsh.example.com' http://127.0.0.1:8080/     # 期望 200
docker compose exec -T deepseek-harness \
  curl -fsS http://127.0.0.1:8080/healthz               # {"ok":true,"backend":200}
```

然后在外部反代里加一条站点，回源 `http://127.0.0.1:8080`：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $http_host;          # 关键：保留原始 Host（含端口）
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;    # WebSocket（/api/remote.mux）
    proxy_set_header Connection "upgrade";
    proxy_buffering off;                       # 不要缓冲流式响应
    proxy_read_timeout 3600s;
    client_max_body_size 300m;                 # DSH /api 上限 300 MiB
    # 可选：只把反代自身的认证 Cookie 发到浏览器，回源时剥掉，减少泄漏面
    # proxy_set_header Cookie "";
}
```

> 若启用了 `PROXY_SHARED_SECRET`，再补一行 `proxy_set_header X-DSH-Proxy-Secret "<同一个值>";`。

### 用 Traefik（file provider 动态配置）

仓库已带两份示例，按拓扑二选一：

| 拓扑 | 做法 | 动态配置里的 service URL |
|---|---|---|
| **A. Traefik 也是容器（推荐）** | 用 `docker-compose.traefik.yml` 叠加启动，8080 不再发布到宿主机，app 加入 `traefik` 网络 | `http://deepseek-harness:8080` |
| B. Traefik 用 host 网络/直连宿主机回环 | 保持默认 compose（只发布 `127.0.0.1:8080`） | `http://127.0.0.1:8080` |

> 拓扑 A 需要 **Compose ≥ 2.24**（用到 `!reset` 清除基础文件的 `ports:`）。
> 旧版本直接编辑 `docker-compose.yml`：删掉 `ports:` 段，改成 `expose: ["8080"]` 并加入 `traefik` 网络。

```bash
# 拓扑 A
docker network create traefik 2>/dev/null || true
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d --build
```

把 `traefik/dynamic.yml` 挂进 Traefik（或用你自己的 file provider 目录）：

```yaml
# Traefik 容器
volumes:
  - ./traefik/dynamic.yml:/etc/traefik/dynamic/dsh.yml:ro
```

Traefik **static** 侧需要 file provider 与长连接超时（按需调整）：

```yaml
providers:
  file:
    directory: /etc/traefik/dynamic
    watch: true
entryPoints:
  websecure:
    address: ":443"
    transport:
      respondingTimeouts:
        readTimeout: 0s          # 允许 300 MiB 大上传
        writeTimeout: 0s         # 允许长时间流式响应
        idleTimeout: 180s
```

然后修改 `traefik/dynamic.yml` 里的三处：`Host(...)` → 你的 `DSH_ACCESS_HOST`、`certResolver` → 你的解析器、
`dsh-auth` → 你现有的认证中间件（forwardAuth/OIDC/basicAuth 均可）。

Traefik 侧必须注意的点：

| 项 | 设置 |
|---|---|
| Router 规则 | `Host(...)` 必须与 `DSH_ACCESS_HOST` **逐字一致** |
| Host 透传 | `loadBalancer.passHostHeader: true`（默认就是 true，别关） |
| TLS | 在 router 上 `tls.certResolver`；容器内仍是明文 |
| 认证 | 认证中间件必须覆盖**所有路径**，包括 WebSocket `/api/remote.mux` |
| 缓冲 | **不要**加 `buffering` 中间件；也建议不要加 `compress`（SSE/流式会受影响） |
| 请求体 | Traefik 默认不限制；不要加小的 `maxRequestBodyBytes`（DSH 上限 300 MiB） |
| 健康检查 | 优先用容器自带 healthcheck。若要启用 Traefik `healthCheck`：路径用 `/healthz` **并且**设置 `PROXY_SHARED_SECRET` 后在 healthCheck 里带 `X-DSH-Proxy-Secret`（`/healthz` 只接受回环来源或带密钥的请求，否则 403 → 后端被摘除） |
| WebSocket | Traefik 原生支持，无需额外 header；确认中间件没有改写 `Upgrade` |
| 超时 | 长流式不要给 `responseHeaderTimeout` 设小值（示例配置为 `0s`） |

验证（DNS 指向 Traefik 后）：

```bash
# 页面（认证中间件会先拦截）
curl -fsS -o /dev/null -w '%{http_code}
' https://dsh.example.com/

# WebSocket 升级（带上你认证后的 Cookie；期望 101）
curl -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket'   -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='   -b "$AUTH_COOKIE" https://dsh.example.com/api/remote.mux | head -3
```

Traefik 排障要点：

| 现象 | 原因 |
|---|---|
| 404 | Router 未匹配：`Host` 规则与访问域名不一致、entryPoint 不对，或动态配置未加载（看 Traefik dashboard/日志） |
| 502 | Service URL 错或网络不通：拓扑 A 的 app 不在 `traefik` 网络，或拓扑 B 未发布 `127.0.0.1:8080` |
| 403 `forbidden` | `passHostHeader: false`，或反代改写了 Host/端口 |
| 401/302 登录页反复出现 | 认证中间件没覆盖 WebSocket 路径，或会话 Cookie 没透传 |
| 流式卡住/一次性出现 | 加了 `buffering`/`compress` 中间件，或超时过小 |
| 后端被标 unhealthy | Traefik healthCheck 打了 `/healthz` 但没带 `X-DSH-Proxy-Secret` |

## 3. 环境变量

### 3.1 必填（1 个）

| 变量 | 示例值 | 默认值 | 填写帮助 |
|---|---|---|---|
| `DSH_ACCESS_HOST` | `dsh.example.com` / `203.0.113.10` | 无，必填 | 浏览器实际访问的 **IPv4 或主机名**。禁止 `https://`、端口、路径；不支持 IPv6、下划线、结尾点、前导零 IP；中文域名用 punycode。它同时是 dsh 的 `--trusted-host`（`/api` 的 Host 白名单）与转发进程的 Host 允许列表。**与实际访问地址不一致 → `/api` 返回 403 `forbidden`，页面白屏。** |

本变体只读取 `DSH_ACCESS_HOST`。旧 Caddy 变体的 `HTTPS_ACCESS_HOST`、`DSH_AUTH_USERNAME`、
`DSH_AUTH_PASSWORD` 与 `/data/caddy` 已移除：它们不会被 compose 转发，也不会被入口脚本读取；
旧 `.env` / compose 必须按本文档重写，不存在兼容回退。

### 3.2 镜像内置（一般不改）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_HOME` | `/data/dsh` | DSH 数据根（profiles、settings、凭据、会话、日志）。必须持久化。 |
| `DSH_TELEMETRY_DISABLED` | `1` | 任意非空值都表示关闭遥测；写 `0` 也关闭。 |
| `HOME` | `/data/dsh/home` | 入口脚本设置，落在 `/data/dsh` 卷内。 |
| `ONEPANEL_DSH_AUTH_PROXY` | `1` | 入口脚本写死。它配合镜像补丁让 DSH 跳过自身浏览器认证。**删掉它 → `GET /` 401，容器起不来。** |
| `PROXY_LISTEN_HOST` / `PROXY_LISTEN_PORT` / `PROXY_ALLOWED_HOSTS` | `0.0.0.0` / `8080` / 由 `DSH_ACCESS_HOST` 派生 | 入口脚本传给转发进程，一般不用管。 |

### 3.3 可选：转发进程

| 变量 | 示例值 | 默认值 | 填写帮助 |
|---|---|---|---|
| `PROXY_SHARED_SECRET` | 随机 32 字节 | 空=不校验 | 设置后，转发进程要求请求带 `X-DSH-Proxy-Secret` 且值相同，否则 403；该头不会被转发给 DSH。适合外部反代能注入固定头时做纵深防御。 |
| `PROXY_ACCESS_LOG` | `1` / `0` | `1` | JSON 行访问日志（时间、来源、方法、路径、状态、耗时、字节数）。只记 pathname，不含 query，避免 token 泄漏。 |

### 3.4 应用层可选（dsh 自己读取）

| 变量 | 示例值 | 默认值 | 填写帮助 |
|---|---|---|---|
| `DSH_PERMISSION_MODE` | `workspace-write` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access`；只有 danger 时审批为 `never`。 |
| `DSH_TOOLS_MODE` | `native` | `native` | 或 `ptc`。 |
| `DEEPSEEK_API_KEY` | `sk-…` | 空 | 不想进 UI 填 Key 时用；**UI 保存的优先级更高**（写入 `/data/dsh/.credentials.yaml`）。 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | 同左 | 接私有网关时改。 |
| `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` | `http://10.0.0.2:3128` | 空=直连 | 容器出网需代理时；不支持 SOCKS。 |

> `DSH_*` 属于 bootstrap 变量，只能来自容器进程环境，写进 `$DSH_HOME/.env` 无效。
> 注意：compose 只转发 `environment:` 里显式列出的变量。`PROXY_SHARED_SECRET`、`PROXY_ACCESS_LOG`
> 已默认转发；上表里的 `DSH_PERMISSION_MODE`、`DEEPSEEK_API_KEY` 等在 compose 中是注释行，
> 在 `.env` 里设置后还需取消 compose 中对应注释，否则不会进入容器。

**内嵌桌面（镜像内置，compose 已转发）**：

| 变量 | 示例值 | 默认值 | 说明 |
|---|---|---|---|
| `DSH_DESKTOP_ENABLED` | `1` / `0` | `1` | 置 `0` 完全不启动 Xvfb/Chromium，也不注册 `/desktop/`；Harness 本身照常可用。 |
| `DSH_BROWSER_USE_ENABLED` | `1` / `0` | `1` | 模型侧 Browser Use 工具（attach 到同一个 Chromium）。`DSH_DESKTOP_ENABLED=0` 时一并失效。 |
| `DSH_DESKTOP_WIDTH` / `DSH_DESKTOP_HEIGHT` | `1440` / `900` | 同左 | 虚拟桌面分辨率；越大 RFB 流量越大。 |
| `DSH_DESKTOP_DEPTH` | `24` | `24` | Xvfb 色深。 |
| `CHROME_USER_DATA_DIR` | `/data/dsh/chrome-profile` | 同左 | 浏览器 profile（登录态、Cookie）落在持久卷内。 |

**社区插件市场（镜像内置，compose 已转发）**：

| 变量 | 示例值 | 默认值 | 说明 |
|---|---|---|---|
| `DSH_MARKET_ENABLED` | `1` / `0` | `1` | 置 `0` 只关闭市场行：插件包仍在镜像里，但不再挂载、不出入口；Harness 本身不受影响。 |

### 3.5 部署侧变量（只影响 compose，不进容器）

| 变量 | 示例值 | 默认值 | 说明 |
|---|---|---|---|
| `DSH_HTTP_PORT` | `8081` | `8080` | 宿主机回环监听端口，映射到容器 8080。 |
| `DSH_IMAGE` | `kjeung/deepseek-harness-plain:0.2.1-rc.5` | `deepseek-harness:plain` | 使用已构建镜像时设置，并删掉 compose 的 `build:` + `pull_policy:` 段。**不要指向 Caddy 版 `1panel/deepseek-harness:<版本>`。** |
| `DSH_VERSION` | `0.2.1-rc.5` | `0.2.1-rc.5` | 构建参数，决定镜像内 dsh 版本。 |
| `DSH_MARKET_VERSION` | `1.73.9` | `1.73.9` | 构建参数，决定镜像内置的 dshmarket 版本；独立于 DSH 版本升级，DSH 换 minor 时复核 peer 范围。 |
| `DSH_DATA_DIR` / `WORKSPACE_DIR` | `./data/dsh` / `./workspace` | 同左 | 持久化目录。 |

### 3.6 镜像内置 GitHub CLI（gh）

镜像内置官方 `gh`：构建时从 GitHub 官方 apt 源安装**最新稳定版**，不固定小版本，平时不需要手动更新。
同一份 Dockerfile 在不同时间重建可能得到不同的 `gh`；需要可复现构建时请自行锁版本。
可直接在容器或 Agent shell 里执行 `gh --version`、`gh auth status`。已有部署要重新
`docker compose build && docker compose up -d`（或拉取包含它的新镜像）才会带上它；只 `up -d` 不会更新镜像。

`gh` 的登录态默认写在 `$HOME/.config/gh/hosts.yml`；本镜像 `HOME=/data/dsh/home` 在持久卷内，
所以登录一次后重启、重建容器都还在。推荐用 token 非交互登录（不依赖浏览器回调）：

```bash
# token 从标准输入读入，不留在 shell history；建议用最小权限的 fine-grained PAT
docker compose exec -T -u node -e HOME=/data/dsh/home deepseek-harness \
  gh auth login --hostname github.com --git-protocol https --with-token < github-token.txt

# 让 git 的 HTTPS 凭据也走 gh（写入 /data/dsh/home/.gitconfig）
docker compose exec -u node -e HOME=/data/dsh/home deepseek-harness gh auth setup-git
docker compose exec -u node -e HOME=/data/dsh/home deepseek-harness gh auth status
```

`gh auth login --web` 也可以用：它走**设备码流程**（终端显示一次性代码，在浏览器打开 GitHub 页面输入），
不依赖 localhost 回调，因此不受 3.7 的官方账号登录限制影响。

注意：

- **不要**把 `GH_TOKEN` / `GITHUB_TOKEN` 写进 compose 指望 Agent 能用：DSH 启动子进程时会剔除名字含
  `KEY`/`PASSWORD`/`SECRET`/`TOKEN` 的环境变量（`dsh-subprocess` 的 `scrubbedParentEnv`），
  Agent 的 shell 看不到它们。请用 `gh auth login` 把凭据落盘。
- token 在 `/data/dsh` 卷里是明文（`0600`），能读该卷的人或 Agent 都能拿到。请用 fine-grained PAT，
  只勾选需要的仓库与权限，不要放全账号 classic token；`/data/dsh` 按高敏感卷保护。
- Agent 的默认文件策略是 `workspace-write`：`gh` 读 `~/.config/gh` 没问题，但在工作区外写缓存/配置可能被
  沙箱拒绝；`gh pr view`、`gh api`、`git clone` 这类只读/工作区内写入的命令不受影响。
- `gh auth setup-git` 只覆盖 HTTPS。要 SSH 访问私有仓库，请另行挂载只读 deploy key/SSH key；
  它同样对 Agent 可见。

### 3.7 为什么在 Docker 里登录不了 DeepSeek 官方账号

DSH 的官方账号登录是 PKCE 浏览器流程：Host 在 `/oauth/callback` 等回调，并把
`redirect_uri = <浏览器 origin>/oauth/callback` 发给 Platform。上游
`@deepseek-ai/dsh-deepseek-account-platform` 的 `loginOrigin()` 只接受三种浏览器 origin：

- `http://localhost:<port>`
- `http://127.0.0.1:<port>`
- `http://[::1]:<port>`

端口必须显式；`https://`、域名、局域网 IP、带路径的反代一律拒绝。上游 README 把它写成
known limitation：非 loopback 的反向代理不受支持，只有带显式端口的 `localhost`、`127.0.0.1`
或 `[::1]` 可用。

本部署的浏览器地址是 `https://dsh.example.com`（或 `http://<局域网IP>:8080`），
`window.location.origin` 不是 loopback，所以点“登录”时 Host 在发出 `auth_init` 之前就返回
`protocol` 错误：预打开的标签页被关闭，对话框显示“登录失败”。这不是反代少传了哪个头，
改 `Host`/`Origin`/`X-Forwarded-*` 都不会修好；把回调强行固定成 loopback，又会落到浏览器所在机器的
`localhost`，而不是容器。

三个常见现象可以这样区分：

- **点“登录”后标签页立刻关闭/提示失败**：就是上面的 origin 校验拒绝，最常见。
- **标签页能打开，但 Platform 页面一直加载不出来**：客户端到 `platform.deepseek.com` 的网络/DNS/代理问题；
  登录页是浏览器加载的，容器的出网不参与，先修客户端网络。
- **批准后跳到 `http://localhost:...` 报错**：回调落到了客户端本机，不是容器；属于同一条 loopback 限制。

**推荐做法：改用 API Key。** 首次引导页选“添加 API Key”，或进 Settings → Models 填 DeepSeek API Key；
它写入 `/data/dsh/.credentials.yaml`（`0600`），随 `/data/dsh` 持久化，且优先于环境变量。
纯自动化部署可用 compose 的 `DEEPSEEK_API_KEY`（见 3.4）。官方账号登录换来的也是平台 API Key/额度，
API Key 是这条链路上受支持的等价入口。

如果只是要账号下的额度/Key：直接在客户端浏览器打开 `https://platform.deepseek.com` 登录，创建 API Key，
再回 DSH 的 Settings → Models 粘贴即可；这一步不经过 DSH 的回调，因此不受本限制影响。

不要通过 fork 改 `loginOrigin()` 来接受域名：这是上游的登录安全边界，不属于受支持配置，升级也会失效。

**如果必须用官方账号登录**（例如只能用账号余额）：可以用“手动回传回调”完成。它不改 DSH 源码，
也不需要本地端口转发：在浏览器里发起一个 loopback 回调的登录，把 Platform 重定向出的 callback URL
复制到容器里用 `curl` 执行。这条链路依赖 DSH 内部 RPC，属于未支持操作；已在 `0.2.1-rc.5` +
本地 mock Platform 上验证，DSH 升级后可能失效。

1. 在 DSH 页面打开 DevTools Console，执行下面的脚本。它先用 loopback 作为 `callbackOrigin` 发起登录：

   ```js
   const rpc = async (method, args) => {
     const rpcId = crypto.randomUUID()
     const response = await fetch(`/api/${method}`, {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
     })
     const body = await response.json()
     if (!body.result?.ok) throw new Error(JSON.stringify(body.result?.error ?? body))
     return body.result.value
   }

   const current = await rpc('account/getState', {})
   if (current.status === 'credential-stored') throw new Error('already signed in')
   if (current.attempt && !['failed', 'cancelled', 'expired'].includes(current.attempt.phase)) {
     await rpc('account/cancelSignIn', { attemptId: current.attempt.id })
   }

   await rpc('account/startSignIn', {
     client: {
       version: '0.2.1-rc.5', // 换成 dsh --version 的当前值
       locale: navigator.language,
       timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
     },
     callbackOrigin: 'http://127.0.0.1:3080',
     loginSource: 'web',
   })

   let view
   for (let i = 0; i < 50; i++) {
     view = await rpc('account/getState', {})
     if (view.attempt?.authorizeUrl) break
     await new Promise((resolve) => setTimeout(resolve, 200))
   }
   if (!view.attempt?.authorizeUrl) throw new Error(JSON.stringify(view))
   console.log(view.attempt.authorizeUrl)
   ```

2. 控制台会打印 `authorizeUrl`。在浏览器新标签打开它，完成 DeepSeek 授权。

3. Platform 会跳到 `http://127.0.0.1:3080/oauth/callback?code=...&state=...`；浏览器打不开是正常的。
   复制完整 URL（或在 DevTools Network 里看 302 的 `Location`），在容器内执行：

   ```bash
   docker compose exec -T deepseek-harness \
     curl -i 'http://127.0.0.1:3080/oauth/callback?code=...&state=...'
   ```

4. 看到 `302` 且 `location` 指向 `platform.deepseek.com/dsh/authorized` 即成功；回到 DSH 页面，
   登录对话框应关闭，不关就刷新。凭据已写入 `/data/dsh/.credentials.yaml`。

注意：callback URL 含一次性 `code`/`state`，不要在日志或聊天里传播；默认 10 分钟内完成；
脚本会先取消旧的登录 attempt，但不要在点击“登录”产生失败 attempt 后直接执行。

## 4. 数据、备份与恢复

| 容器路径 | 内容 | 必须持久化 |
|---|---|---|
| `/data/dsh` | `profiles/`、`settings.yaml`、`.credentials.yaml`（API Key）、会话记录、`logs/`、`attachments/`、`HOME` | ✅ |
| `/workspace` | Agent 工作区（`workspaceRoot`），项目代码 | ✅（业务数据） |

备份：

```bash
docker compose stop
tar czf dsh-backup-$(date +%F).tar.gz data/ workspace/
docker compose start
```

恢复后修正属主：

```bash
chown -R 1000:1000 data/dsh workspace
docker compose up -d
```

入口脚本每次启动会以 root 把这两个挂载点的**顶层**目录 chown 成 1000:1000 并设 0700/0750；
此外会把 DSH 以 node 身份写入的目录（`/data/dsh/profiles`、`/data/dsh/chrome-profile`、
`/data/dsh/home/.npm`、`/data/dsh/home/.local/share/pnpm`）在发现非 `node` 文件时递归 chown
（`-h` 不改镜像内容），保证 `dsh plugin`、插件市场安装与桌面能正常工作。NFS/SMB/只读卷无法
chown，会启动失败。

## 5. 运维

```bash
docker compose ps                 # (healthy) 才算就绪
docker compose logs -f            # 入口脚本 + dsh + 转发进程（JSON 访问日志）
docker compose exec deepseek-harness dsh --version

# 容器内健康检查（等价于 compose healthcheck；/healthz 只接受回环来源）
docker compose exec -T deepseek-harness \
  curl -fsS http://127.0.0.1:8080/healthz        # {"ok":true,"backend":200}

# 宿主机冒烟：经发布端口访问（Host 必须是 DSH_ACCESS_HOST）
curl -fsS -o /dev/null -w '%{http_code}\n' \
  -H 'Host: dsh.example.com' http://127.0.0.1:8080/   # 200
```

- **健康检查**：`/healthz` 同时探测转发进程与后端 dsh，但**只接受来自回环的请求**
  （或带 `X-DSH-Proxy-Secret` 的请求），外部扫描拿不到后端状态。
  因此：在容器内 `curl 127.0.0.1:8080/healthz` 可用；**从宿主机经发布端口访问会得到 403**
  （Docker DNAT 后来源不是回环），请改用上面的 `Host` 冒烟命令，或带 secret：
  `curl -H "X-DSH-Proxy-Secret: $PROXY_SHARED_SECRET" http://127.0.0.1:8080/healthz`。
  入口脚本先等 dsh 就绪（最多 60 s）再起转发，所以 compose 把 `start_period` 放宽到 180 s。
- **进程模型**：`tini` 是 PID 1，dsh 与转发进程任一退出整个容器即退出 → `restart: unless-stopped` 必需。
- **优雅退出**：SIGTERM → 转发进程立即停止接收新连接并断开 WebSocket，随后最多等 5 s 让普通响应/流收尾，然后退出 0；
  `stop_grace_period: 30s` 足够。长时间运行的 Agent 任务会被中断（重启前请确认没有关键任务）。
- **升级（含 dsh 版本升级，务必看风险）**：只改小版本（同一 dsh）时 `docker compose build && docker compose up -d` 即可，升级前备份。
  升级 **dsh 版本**不是改个数字：镜像构建期补丁用精确字符串匹配 DSH 的 `isAuthenticated()`、Web index 的 manifest link 与 HMR SSE 的 close handler，DSH 源码一变构建就会失败；
  DSH 的 WebSocket 路径、`/api` 栅栏、gzip、300 MiB 上限也可能变化。完整清单见
  [SYNC-UPSTREAM.md §5](SYNC-UPSTREAM.md#5-dsh-版本升级最需要注意的一步)，要点：
  1. 同步上游并重新应用/修正 `patch-dsh-authenticated-settings.mjs` 与 `patch-dsh-manifest-sse.mjs` 的匹配字符串；
  2. 三处版本号保持一致：`docker-compose.yml` 的 `DSH_VERSION`、`.env.example`、`.github/workflows/deepseek-harness-release.yml` 默认值；
     社区插件市场版本 `DSH_MARKET_VERSION` 独立升级，但 DSH 换 minor 时要复核 dshmarket 的 peer 范围并同步调整；
  3. 构建后跑端到端（`/healthz`、settings、WebSocket、SSE），再发布。

## 6. 排障

| 现象 | 原因与处理 |
|---|---|
| 页面白屏、`/api` 403 `forbidden` | `DSH_ACCESS_HOST` 与浏览器地址不一致（含端口差异）；或外部反代改写了 Host（用了 `$host` 丢端口）。 |
| `401 unauthorized`、容器起不来、日志 `did not become ready` | 镜像补丁丢失或被去掉（`ONEPANEL_DSH_AUTH_PROXY`/`isAuthenticated` 补丁）。必须保留。 |
| 点“登录 DeepSeek 账号”后标签页关闭、提示“登录失败” | 官方账号登录只支持 loopback HTTP（`localhost`/`127.0.0.1`/`[::1]` + 显式端口），当前是域名或局域网 IP 访问，Host 在发起登录前就拒绝。改用 API Key；必须用账号时按 3.7 的手动回传回调临时登录。 |
| 宿主机 `curl http://127.0.0.1:8080/healthz` 返回 403 | 这是设计行为：`/healthz` 只允许回环来源，经 Docker 端口映射后来源不是回环。在容器内执行，或带 `X-DSH-Proxy-Secret`，或改用 `Host` 冒烟。 |
| 502 | 两种来源：① 后端 dsh 未起/连接失败——容器 stderr 有 `upstream error`；② 客户端在响应前取消（刷新页面、关闭标签、`fetch` abort）——旧版代理会误记 502，现改为 499 且不写 stderr。只有同时看到 stderr 的 `upstream error` 才是真故障。 |
| `499` 且约每 120–125 s 一次（`/plugins/events`） | 外部反代把空闲 SSE 当读超时切断。把该站点的 `proxy_read_timeout` 提到 3600s、`proxy_buffering off`；若前面还有 Cloudflare/LB，需允许 SSE 并依赖应用心跳。 |
| UI 能打开但永远不刷新、任务无输出 | 外部反代没有转发 WebSocket 升级（缺 `Upgrade`/`Connection` 头）。 |
| 桌面面板空白或一直“正在连接” | 三种原因：① 反代没转发 `/desktop/websockify` 的 WebSocket 升级；② 反代加了 `buffering`/`compress`；③ 容器内 x11vnc 没起（`docker compose logs` 里有 `desktop-supervisor` 记录，细节在 `/tmp/dsh-desktop/*.log`）。 |
| `/desktop/vnc.html` 返回 404 | `DSH_DESKTOP_ENABLED=0`，或运行的是不含桌面的旧镜像；确认 `docker compose exec -T deepseek-harness curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/desktop/vnc.html`。 |
| 面板刚打开就断开，日志反复 `chromium exited; restarting` | `/dev/shm` 太小导致渲染进程崩溃；compose 已设 `shm_size: 1gb`，自定义部署请保留。也可能是 `CHROME_USER_DATA_DIR` 不可写（NFS/权限）。 |
| 桌面里中文显示成方块 | 镜像缺 `fonts-noto-cjk`：确认用的是本仓库构建的镜像，而不是上游其它镜像。 |
| 面板 `403 forbidden` | 与其他路径一样：反代改写了 Host（白名单不匹配），或开了 `PROXY_SHARED_SECRET` 但反代没带 `X-DSH-Proxy-Secret`。 |
| 面板打开即断、日志 `rejected a cross-origin WebSocket upgrade` | 桌面 WebSocket 的 Origin 栅栏拒绝：反代改写了 Host，或手工冒烟没带 `Origin`。浏览器正常访问不受影响。 |
| 镜像构建失败：`unexpected browser proxy authentication source shape` / `unexpected PDF worker source shape` / `unexpected web manifest link source shape` / `unexpected HMR SSE close handler source shape` | dsh 版本变了，构建期补丁的精确字符串不再匹配。按 [SYNC-UPSTREAM.md §5](SYNC-UPSTREAM.md#5-dsh-版本升级最需要注意的一步) 更新 `patch-dsh-authenticated-settings.mjs` / `patch-dsh-manifest-sse.mjs`，再跑端到端验证。 |
| 流式输出变成一次性出现 | 外部反代或中间层缓冲了响应（`proxy_buffering off`、别加 gzip 中间件）。 |
| 上传文件 413 | 外部反代 `client_max_body_size` 太小（需 ≥300 MiB）。 |
| 请求返回 400 `Host must not end with a dot` | 上游反代发来了 FQDN 尾点 Host（`dsh.example.com.`）。DSH 会 403 这种 Host，所以这里提前 400；请让反代用 `$http_host`（不带结尾点）。 |
| 偶发 502（空闲后首次请求） | 先排除客户端取消（见上表 502 行：`ms` 与取消时刻吻合、`bytes=0`、无 stderr）。若确属空闲复用，多层 keep-alive 都可能：外部反代↔容器，或容器内转发进程↔dsh。转发进程已把上游连接池空闲超时设成 4 s（低于 dsh 的 ~5 s）以避免复用被后端关掉的连接；若仍出现，先看访问日志的 `status`/`ms` 定位是哪一跳。 |
| 端口被占用 | 改 `DSH_HTTP_PORT`。 |
| 数据目录在 NFS/SMB 上启动失败 | 入口脚本要 chown/改权限，此类文件系统不支持；改用本地盘或 named volume。 |
| 插件页没有「插件市场」入口 | `DSH_MARKET_ENABLED=0`，或运行的是不含 dshmarket 的旧镜像；确认 `docker compose exec -T deepseek-harness curl -fsS http://127.0.0.1:3080/dsh-market/status` 有 JSON（`"restart":false`）。 |
| `/dsh-market/status` 404 | 市场行没挂载（同上）；或该请求打到了外部反代的其它站点。 |
| 市场里装社区插件报 `EACCES` / `permission denied` | 数据卷里残留 root 属主的 profile 文件（旧镜像或 root 身份跑过 `npm/pnpm`）。重建到含属主修复的镜像后重启即可；临时处理：`docker compose exec -u root deepseek-harness chown -R -h node:node /data/dsh/profiles`。 |
| Agent 报沙箱不可用 | 容器内 bwrap 需要非特权 user namespace；DSH 会回退 landlock，两者都不可用时受限命令失败。仅在自建环境考虑 `seccomp=unconfined`，需自行验证。 |

## 7. 安全建议（重要）

1. 容器内**没有任何认证**：不要发布 8080 到不可信网络，也不要让它出现在公网 LB 的后端列表里。
2. 外部反代是唯一认证点；请确保它对**所有路径**生效，包括 `/api/remote.mux` 的 WebSocket。
3. 外部反代自身的 CSRF 防护请保留：DSH 的 Origin 栅栏依赖反代透传 `Origin`，它是第二道防线。
4. 建议外部反代认证后剥离自己的会话 Cookie 再回源（DSH 用不到），减少凭据进入容器网络。
5. 可开启 `PROXY_SHARED_SECRET`；它挡不住能直连端口的人，但能拦住误配置的旁路。
6. 不要把宿主机根目录、`/var/run/docker.sock`、`~/.ssh` 挂进 `/workspace`；Agent 在该目录内默认可写可执行。
7. DSH 仍是开发者预览版，升级前备份；`/workspace` 不要放敏感数据。
8. `gh` 的 token（`/data/dsh/home/.config/gh/hosts.yml`）与 DSH 的 `.credentials.yaml` 都在 `/data/dsh`；
   能读该卷的人或 Agent 等于拿到这些凭据，请按 root 级敏感数据保护。

## 8. 与旧 Caddy 变体的关系（不兼容）

本变体**不是**旧 `1panel/deepseek-harness`（Caddy + TLS + basic_auth）的兼容升级：容器内的
TLS 与认证被删除，统一交给外部反向代理；端口从 8443 变为 8080；环境变量只剩本文档列出的项。
旧变体的 `HTTPS_ACCESS_HOST`、`DSH_AUTH_USERNAME`、`DSH_AUTH_PASSWORD` 与 `/data/caddy`
均不再读取或创建，也没有兼容回退——沿用旧配置启动不会得到旧行为。

| 项 | 旧 Caddy 变体 | 本变体 |
|---|---|---|
| 认证 | Caddy `basic_auth` + 入口校验 | 无（外部反代负责） |
| TLS | Caddy `tls internal`，8443 | 无，容器内 HTTP 8080 |
| 反向代理 | Caddy | `node-proxy.mjs`（只用 Node 内置模块，无第三方依赖） |
| 健康检查 | `curl 127.0.0.1:3080/` | `curl 127.0.0.1:8080/healthz`（同时验证后端） |
| 访问日志 | 无 | JSON 行（可关）：时间、来源（**反代地址**，不是真实客户端 IP）、方法、pathname（不含 query）、状态、耗时、字节，WebSocket 升级也记一条 |
| 安全响应头 | Caddy 注入 `nosniff` / `Referrer-Policy` | 转发进程注入同样两个头 |
| 跨站 `/api` 403 | Caddy `@unsafe_api` | DSH 原生 Host/Origin 栅栏（等价且多一层 Host 白名单） |
| settings 端点 | Caddy 改写 Host/删 Origin | 原样透传（实测无需改写） |

**发布标签**：本变体与 Caddy 版行为不同，**不要**推到 `1panel/deepseek-harness:<版本>` 或 `:latest`。
本仓库工作流默认发布到 `kjeung/deepseek-harness-plain`（`:<dshVersion>` + `:plain` 别名，
一次构建、多 tag 同 digest）；工作流会拒绝官方镜像名（见 `.github/workflows/deepseek-harness-release.yml`），
自有仓库请用 `imageName` 输入覆盖。

## 9. 已知限制

- **真实客户端 IP 不可得**：容器内没有认证也没有受信代理链，`X-Forwarded-For` 等头会被**剥离**（防伪造），
  访问日志的 `remote` 是外部反代地址。需要真实 IP 请在外层反代记录。
- **半关闭客户端（只发 FIN）**：Node `http.Server` 平台行为，客户端可能收不到响应；nginx/traefik 默认不会半关闭上游。
- **后端无响应头时**：转发进程 120 s 后返回 504；后端开始发响应后不再设超时（LLM/SSE 可以长时间流式输出）。
- **后端 `Server` / `X-Powered-By` 头**会被剥离；错误响应统一为 `bad gateway` / `gateway timeout` /
  `forbidden` 等通用文本，详细原因只写容器日志，避免泄露内部地址。
- **重复 Host、尾点 Host** 直接 400（DSH 对尾点是 403，这里提前给出明确错误）。
- **DeepSeek 官方账号浏览器登录只支持 loopback HTTP**（见 3.7）；通过域名/局域网 IP/反代访问的 Docker
  部署无法完成该登录，请使用 API Key，或按 3.7 的手动回传回调临时登录。
- **内嵌桌面与 DSH 同生命周期**：容器或 DSH 重启会断开当前的 VNC 会话（浏览器 profile 与登录态保留在
  `/data/dsh/chrome-profile`）。这是"桌面挂在同一个进程上"的固有取舍，见 ADR 0001。
- **一个容器一个桌面**：没有按用户隔离，Authentik 之后的所有使用者看到的是同一个 Chromium 和同一套
  Cookie。需要多租户隔离时，应一个用户/一个任务一个容器。
- **桌面只支持同源子路径**：`desktopPath` 被校验为同源路径，故意不支持子域名或独立端口（见 ADR 0001）。
  确需改地址时，要在插件里新增"绝对 origin"模式并重新评估认证与 Cookie。
- **插件市场会安装任意社区插件**：dshmarket 在宿主进程内加载第三方 bundle，能执行与 DSH 同等权限的代码；
  安装前请确认来源，并保持 `/data/dsh` 按 root 级敏感数据保护（见 §10.7）。
- **内置市场版本随镜像**：市场自身的升级要重建镜像（改 `DSH_MARKET_VERSION`）；社区插件与市场收藏等状态
  由市场写入 profile（`/data/dsh` 卷），跨容器重建保留。
- **市场里的安装/更新需要出网**：社区插件目录与 tarball 走外部网络；纯离线环境只能使用已内置的插件。


## 10. 内嵌 Chromium 桌面（noVNC）

镜像默认启动一个可见的 Chromium 桌面，并把它作为面板嵌进 Harness UI：

- **Debian Chromium** 跑在 `:99` 的 Xvfb 上，Openbox 提供窗口管理（amd64/arm64 都由 Debian 提供）；
- **Noto CJK** 与 Liberation 字体，中文页面和截图不会变成方块；
- **x11vnc** 只监听 `127.0.0.1:5900`、`-nopw`，不对外；
- **noVNC 1.6.0** 静态资源由 DSH 的 HTTP 服务在 `/desktop/` 提供，RFB 走
  `/desktop/websockify` 的 WebSocket，由插件在进程内桥接到 x11vnc；
- **Browser Use**（`@deepseek-ai/dsh-browser-use` + Playwright MCP，`mode: attach`）接到
  同一个 Chromium 的 `127.0.0.1:9222`，模型操作与人工接管共享标签页、Cookie 和登录态；
- **`browser_open`** 让模型把一个 URL 打开到这套浏览器里并弹出面板。

### 10.1 为什么没有第二个端口

见 [ADR 0001](../../docs/adr/0001-browser-desktop-access.md)：子域名要新增 DNS、证书和
Authentik 应用，面板还会变成跨源 iframe（第三方 Cookie 会被浏览器拦）；非标端口要新增
Traefik entryPoint、放行端口，而且必然绕开 `node-proxy` 的 Host 白名单与共享密钥。
子路径把桌面放在同一个 origin，认证、证书、会话 Cookie、访问日志与栅栏全部复用。

### 10.2 访问与验证

面板入口是 Harness UI 侧边栏的 🌐 按钮；直接地址是
`https://<DSH_ACCESS_HOST>/desktop/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1&path=/desktop/websockify`。

容器内冒烟（不经反代，直接问 dsh 本体）：

```bash
docker compose exec -T deepseek-harness curl -fsS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3080/desktop/vnc.html          # 200

docker compose exec -T deepseek-harness curl -fsS http://127.0.0.1:9222/json/version | head -c 120

docker compose exec -T deepseek-harness curl -fsS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3080/desktop/defaults.json     # 200
```

经反代冒烟（Host 必须是 `DSH_ACCESS_HOST`；开了 `PROXY_SHARED_SECRET` 还要带
`X-DSH-Proxy-Secret`）：

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' -H 'Host: dsh.example.com' \
  http://127.0.0.1:8080/desktop/vnc.html          # 200

curl -i -N -H 'Host: dsh.example.com' -H 'Origin: https://dsh.example.com' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://127.0.0.1:8080/desktop/websockify | head -3   # 期望 HTTP/1.1 101
```

> 桌面 WebSocket 与 DSH 自己的 `/api` 升级一样有 **Origin 栅栏**：`Origin` 必须与 `Host`
> 同 authority（host+port），**缺失 `Origin` 直接 403**。所以上面的手工冒烟必须带
> `Origin`；浏览器正常访问不受影响。反代若改写了 `Host`（例如用 `$host` 丢掉端口），
> 桌面会像 `/api` 一样 403。

### 10.3 资源与日志

- Chromium 渲染进程用 `/dev/shm`，compose 设了 `shm_size: 1gb`。`/dev/shm` 不足时
  `chromium-docker` 会自动加 `--disable-dev-shm-usage` 退回磁盘共享内存。
- 桌面由 `desktop-supervisor.sh` 托管：Chromium / Openbox / x11vnc 退出后原地重启；
  Xvfb 退出则 supervisor 以非 0 退出，容器按 `restart: unless-stopped` 重建。
- 桌面进程日志在容器内 `/tmp/dsh-desktop/{xvfb,openbox,x11vnc,chromium}.log`；启动/重启/退出
  事件打到容器 stderr，即 `docker compose logs`。
- 关闭桌面：`DSH_DESKTOP_ENABLED=0` 后 `docker compose up -d`（不需要重建镜像）。
- 备份注意：`/data/dsh/chrome-profile` 会随手用增长（缓存、下载、登录态），`tar czf` 打包 `data/`
  会把它一起带走；不打算保留浏览器登录态时，可以停容器后先删掉该目录再备份。
- 本机验证边界与构建后的 runbook 见 [`notes/desktop-integration.md`](notes/desktop-integration.md)。

### 10.4 安全

- 能访问 `/desktop/websockify` 的人就拥有容器里的这个浏览器：能读它的 Cookie、用它出网、
  操作它打开的页面。认证边界与 Harness UI 完全相同，所以反代中间件必须覆盖 `/desktop`
  前缀**以及** WebSocket 升级。
- 桌面 WebSocket 还有一层与 `/api` 同等的 **Origin 栅栏**：`Origin` 的 host+port 必须等于
  `Host`，缺失 `Origin` 直接拒绝。这挡住跨站 WebSocket 骑劫（别的网页借浏览器既有
  凭据打开桌面 socket）。注意它**不能**替代认证：同源页面（含被 XSS 的 Harness 页面）仍可连。
- 桌面文档带 `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`，只有同源的
  Harness UI 能把它嵌进 iframe；别处的点击劫持因此不成立。
- 桌面里的 Chromium 以 `node` 身份运行，地址栏可以直接打开 `file:///data/dsh/…`
  （含 `.credentials.yaml`、`home/.config/gh/hosts.yml`）以及 `/workspace`：能打开桌面的人
  就有 node 级的读权限。单 owner 场景可接受；多用户场景必须一人一容器（见 §9 已知限制）。
- “认证后剥离反代自己的会话 Cookie 再回源”的建议同样适用于桌面路径。
- 浏览器 profile 在 `/data/dsh/chrome-profile`，与 DSH 凭据同属高敏感数据，按 `/data/dsh` 的
  权限与备份流程处理。
- `x11vnc` 只有 `-localhost -nopw`，Chromium DevTools 只有 `127.0.0.1:9222`，容器仍然只发布
  一个回环端口。

### 10.5 与上游镜像的差异

| 项 | `runzhliu/deepseek-harness-docker` | 本镜像 |
| --- | --- | --- |
| 桌面端口 | 发布 `6080`（noVNC） | 无，挂在 `/desktop/` |
| RFB 传输 | `websockify`（Python 进程） | 插件内 WebSocket↔TCP 桥接 |
| noVNC 资源 | Debian `novnc` 包 | 固定 1.6.0，镜像内置（bookworm 的 1.3.0 需要显式 host） |
| 面板 URL | 改端口（`desktopPort`） | 同源路径，无端口概念 |
| 认证 | DSH 自身 token/cookie 或 Caddy LAN 网关 | 外部反代（与本镜像既有模型一致） |
| 插件市场 | 独立的 `Dockerfile.market` 变体（构建期装 dshmarket，约定为 profile 层，`allowRestart:false`） | 默认内置，overlay 以绝对路径挂载，`DSH_MARKET_ENABLED=0` 可关闭 |

### 10.6 Browser Use 的两个限制

`mode: attach` 的浏览器**不是**“每个 Session 一套”，升级或排障时要知道：

- **一个 provider 实例内，同一时刻只有一个活跃 Session 拥有这个浏览器。** 其他 Session
  暂时没有 Browser Use 工具（面板与 `browser_open` 仍可用）；要让新会话接手，新建或
  恢复一个 Session。
- **Chromium 重启后 provider 不会自动重连。** `desktop-supervisor.sh` 会原地重启 Chromium，
  noVNC 面板会自动重连并恢复画面，但模型侧工具要新建/恢复 Session 才会回来。

模型自动化与人工接管共享同一个浏览器的标签页、Cookie 与登录态：这既是特性（人工完成
登录后模型接着用），也是风险（没有按用户隔离，见 §10.4 与 §9）。

### 10.7 社区插件市场（dsh-market）

镜像内置第三方插件市场 [`dshmarket`](https://www.npmjs.com/package/dshmarket)（dsh-market，MIT），
版本由构建参数 `DSH_MARKET_VERSION` 固定（默认 `1.73.9`）。它提供目录浏览/搜索、一键安装与更新、
收藏、分组、主题等能力，入口在 DSH 的**插件**页（插件市场页签；也可在侧边栏加一行）。

**交付方式：镜像内容 + overlay 绝对路径。** 构建期把 dshmarket 装进 DSH 安装目录
（`…/dsh/node_modules/dshmarket`），`web-market.cordis.patch.yml` 用绝对路径行直接挂载：
Cordis loader 接受路径行，客户端 roster 从该文件最近的 `package.json` 读取 `dsh.client`，
因此**不需要把镜像内容软链进数据卷的 profile**（桌面与 Browser Use 也改为同一方式）。
数据卷只保留用户态：

| 内容 | 位置 | 容器重建后 |
|---|---|---|
| 市场本体 | 镜像层 | 随镜像（升级市场 = 重建镜像） |
| 社区插件、收藏/分组/备注（`state.json`） | `/data/dsh/profiles/web/…` | 保留 |
| pnpm store（市场与 `dsh plugin` 共用） | `/data/dsh/pnpm-store`（node 属主） | 保留 |

> 镜像插件不再依赖 profile 可写；profile 的 node 属主只在 `dsh plugin` / 市场安装社区插件时需要。
> 入口脚本仍会修复旧卷里被 root 写脏的 profile、chrome-profile 与 npm/pnpm 缓存。

**与 profile 安装的关系。** 如果卷里曾执行过 `dsh plugin --profile web add dshmarket`，profile 副本
优先：entrypoint 检测到 `package.json.dependencies.dshmarket` 后不再追加镜像的 `dsh-market` 行
（避免同一行 id 出现两次），市场继续走自更新通道。要切回镜像版本：

```bash
docker compose exec -T -u node deepseek-harness dsh plugin --profile web remove dshmarket
docker compose restart
```

**关闭**：`DSH_MARKET_ENABLED=0` 后 `docker compose up -d`（不需要重建镜像）；市场行被禁用、入口消失。

**验证**：

```bash
# 市场自带的 host 路由；restart 必须是 false（容器生命周期由 entrypoint 管）
docker compose exec -T deepseek-harness \
  curl -fsS http://127.0.0.1:3080/dsh-market/status

# overlay 行确实指向镜像内的绝对路径，且数据卷目录归 node（装社区插件的前提）
docker compose exec -T deepseek-harness \
  sed -n '/id: dsh-market/,/allowRestart/p' /opt/deepseek-harness/web-market.cordis.patch.yml
docker compose exec -T deepseek-harness sh -c \
  'stat -c "%U:%G %n" /data/dsh/profiles /data/dsh/chrome-profile 2>/dev/null || true'
```

**安全**：社区插件在 DSH 宿主进程内执行，权限与 owner 相同（可读 `/data/dsh` 凭据、写 `/workspace`）。
市场默认不允许依赖构建脚本，安装前会展示来源；仍建议只装可信来源，并把 `/data/dsh` 按与
`.credentials.yaml` 同级的敏感数据保护。市场本身不上报数据，但浏览目录/安装必然会访问 npm、GitHub 等外部源。

## 许可证

本仓库衍生自 1Panel 的 [`runtime`](https://github.com/1Panel-dev/runtime) 项目，其许可证为
**GPL-3.0**（见仓库根 [`LICENSE`](../../../LICENSE)，原样保留）。本仓库新增的 Node 反向代理、部署编排与文档
同样以 GPL-3.0 分发。

- 以源码或镜像形式分发本项目的任何修改版时，请保留仓库根目录的 `LICENSE`（即 `../../../LICENSE`）与版权声明，
  并提供对应源码（即本仓库或其 fork）。
- 若只是在内网自用、不对外分发镜像，则无需额外动作。

## 附录：文件清单与验证

| 文件 | 用途 |
|---|---|
| `docker-compose.yml` | 单容器编排（构建/镜像二选一、健康检查、日志轮转、优雅退出） |
| `.env.example` | 全部环境变量示例与注释 |
| `docker-compose.local.yml.example` | 本机覆盖模板（容器名、外部网络、端口、数据目录、资源、未转发的变量）；复制为 `docker-compose.local.yml` 使用，该文件不入库 |
| `../` | 改造后的镜像源码（Dockerfile、entrypoint、node-proxy.mjs、构建期测试） |
| `patches/` | 相对上游的镜像源码 diff + bundle（基线见 `patches/BASE`）+ 复现说明 |
| `scripts/sync-upstream.sh` | 一键同步上游：rebase → 测试 → 重新导出 patches → 推送 |
| `../chromium-docker` | Chromium 启动包装：`--no-sandbox` 仅限该进程；`/dev/shm` 太小时退回磁盘共享内存 |
| `../desktop-supervisor.sh` | Xvfb / Openbox / x11vnc / Chromium 的托管与原地重启 |
| `../plugins/dsh-browser-desktop/` | noVNC 静态服务 + RFB WebSocket 桥接 + `browser_open` + 面板 |
| `../web-desktop.cordis.patch.yml` | 把桌面与 Browser Use 插件插入 web profile 的 overlay |
| `../web-market.cordis.patch.yml` | 把镜像内置的 dshmarket 插入 web profile 的 overlay（`DSH_MARKET_ENABLED` 控制） |
| `../test-market.mjs` | 构建期测试：包身份、客户端声明、overlay 绝对路径与镜像内文件存在性 |
| [`../../docs/adr/0001-browser-desktop-access.md`](../../docs/adr/0001-browser-desktop-access.md) | 桌面访问方式（子域名/子路径/端口）的论证与决定 |
| [`../../docs/adr/0002-plugin-market-delivery.md`](../../docs/adr/0002-plugin-market-delivery.md) | 插件市场交付方式（镜像内容 vs 运行时安装）与数据卷属主修复的论证 |
| [`notes/desktop-integration.md`](notes/desktop-integration.md) | 上游映射、已验证/未验证项、构建后 runbook、风险清单 |
| `reports/node-proxy-feasibility.md` | 可行性报告与实测数据 |
| `notes/implementation-fixes.md` | 独立评审发现的问题与修复/接受记录 |
| `notes/` | 镜像核查、环境变量审计、Caddy 对照、方案对比 |

镜像内改动已通过构建期测试：`node --test test-runtime.mjs` 覆盖转发进程（Host/Origin 透传、
Authorization 剥除、安全头注入、Host 白名单 403、流式不缓冲、WebSocket 101、502、共享密钥、
健康检查、4 MB 上传）；`node --test test-desktop.mjs` 覆盖桌面（路径几何、静态资源越权、
帧编解码、真实 WebSocket↔TCP 桥接、路由注册）；`node --test test-market.mjs` 覆盖插件市场
（包身份与 bundle 声明、Web 客户端声明、overlay 绝对路径与镜像内文件存在性、`DSH_MARKET_ENABLED`）。
入口脚本的 `--self-test` 还会验证数据卷目录与属主修复（新卷与 root 属主旧卷两种输入）。
