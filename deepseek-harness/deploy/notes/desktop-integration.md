# 桌面集成记录（Chromium / 字体 / Xvfb / Openbox / noVNC）

> 目标：把 `runzhliu/deepseek-harness-docker` 的可见桌面能力接进本仓库的明文 HTTP 变体，
> 并回答"浏览器用哪种地址访问桌面"。访问方式的论证在
> [`docs/adr/0001-browser-desktop-access.md`](../../../docs/adr/0001-browser-desktop-access.md)，
> 日常使用在 [`../README.md`](../README.md) §10。

## 1. 上游 → 本仓库映射

| 上游 | 本仓库 | 说明 |
| --- | --- | --- |
| `Dockerfile` 里 Debian `chromium` + `fonts-noto-cjk` + X 栈 | `deepseek-harness/Dockerfile` | 换成 bookworm 的 `chromium`（apt），保留 Noto CJK 与 Liberation |
| `scripts/chromium-docker` | `deepseek-harness/chromium-docker` | 仍是 `--no-sandbox` 只作用于该进程；另加 `/dev/shm` 不足时退回磁盘共享内存 |
| `scripts/deepseek-harness-entrypoint` 的 `start_desktop` | `deepseek-harness/desktop-supervisor.sh` | 独立脚本，多一个"Xvfb 死则整体退出"的判定 |
| `scripts/dsh-web-relay.cjs`（把 dsh 暴露到容器网卡） | 不需要 | 本仓库已有 `node-proxy.mjs` 承担同样的对外入口职责 |
| `plugins/dsh-browser-desktop`（端口版） | `deepseek-harness/plugins/dsh-browser-desktop` | MIT，保留 LICENSE 与上游说明；改为同源子路径 + 进程内 RFB 桥接 |
| `websockify`（Python） | `plugins/dsh-browser-desktop/ws-bridge.js` | 少一个进程、少一个端口；行为由 `test-desktop.mjs` 覆盖 |
| `web.cordis.patch.yml`（含 `webserver` 配置） | `deepseek-harness/web-desktop.cordis.patch.yml` | 去掉 `webserver` 段：host/port 仍由入口脚本的 `--host/--port` 决定 |
| `compose.yaml` 的 `6080` 发布 | 无 | 桌面就在 `8080` 的 `/desktop/` |
| `wslpath` / `powershell.exe` / `dsh-editor.tcl` shim | 未移植 | 只用于规避 Docker Desktop 的 WSL 误判；Linux 服务器上无意义，且会多装 tk |

## 2. 已经在本机验证过的部分

> 2026-11-03 更新：镜像插件（桌面、Browser Use、dshmarket）已从"启动时软链进 profile"改为
> "overlay 行直接写镜像内绝对路径"。下表的验证记录保留为历史依据；新的验证方式见
> [`../README.md`](../README.md) §10.7 与 `test-market.mjs`。

本环境没有 Docker daemon，镜像构建只能在 CI / 目标主机上做。下列部分已在运行中的容器内实测：

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 插件在真实 DSH 中加载（非模拟） | 临时 `DSH_HOME` + overlay 绝对路径 + `dsh web --patch … --host 127.0.0.1 --port 3999`（早期验证用 profile 软链，语义等价） | 启动成功，日志无插件错误 |
| `/desktop/vnc.html` | 上述实例 `curl` | 200，`text/html`，带 ETag/nosniff |
| `/desktop/core/rfb.js`、`/desktop/defaults.json` | 同上 | 200，类型正确 |
| `/desktop`（无尾斜杠） | 同上 | 302 → `/desktop/vnc.html` |
| 路径穿越 / 符号链接逃逸 | `/desktop/../etc/passwd`、`/desktop/%2e%2e/etc/passwd`、指向外部的软链 | 全部 404 |
| `/desktop/websockify` 升级 | `curl` 手工 WebSocket 握手（带同源 `Origin`） | 101，`Sec-WebSocket-Accept` 正确 |
| 跨站 WebSocket 骑劫 | 带 `Origin: https://evil.example` 握手（直接 3080 与经 8080 两种） | 403，拿不到 RFB 握手；修前曾返回 101 |
| 缺少 `Origin` 的握手 | 同上但不带 `Origin` | 403（升级路由要求 Origin） |
| 桌面文档防嵌入 | `curl -D -` 看 `/desktop/vnc.html` | 带 `frame-ancestors 'self'` 与 `X-Frame-Options: SAMEORIGIN` |
| `/desktop` 跳转 | 同上 | 302 到配置的 viewer（含 `autoconnect` 与 `path`） |
| 声音 MIME | `/desktop/app/sounds/bell.{mp3,oga}` | `audio/mpeg` / `audio/ogg`（修前是 octet-stream） |
| x11vnc 缺席时的行为 | 同上（本机无 x11vnc） | 收到 close 帧 `1011 "desktop unavailable"`，原因不泄露内部地址 |
| `/browser-desktop/state` | 同上 | 返回同源 `desktop.path`（含 `path=/desktop/websockify`） |
| `/browser-desktop/open` 同源校验 | 跨源 `Origin` POST | 403 |
| cordis overlay 合成 | `dsh --profile web --patch … --dump-config` | 三个条目正确合入，`!!js` 表达式保留 |
| 单元测试 | `node --test test-desktop.mjs`（16 例） | 全过 |
| 入口脚本 flag 顺序 | 实测 `dsh --patch … web` 会报 `--profile required` | 已改为 `dsh web --patch …` |

## 3. 只能在构建/部署环境验证的部分

| 项 | 为什么本机不能验证 | 构建后验证方法 |
| --- | --- | --- |
| Debian `chromium` 安装与 `--version` | 无 Docker daemon、容器内无 root | 构建日志里的 `chromium-docker --version` |
| Xvfb + Openbox + x11vnc 真正出图 | 同上（无 X 栈） | `docker compose exec -T deepseek-harness curl -fsS http://127.0.0.1:9222/json/version`；打开面板看画面 |
| noVNC 真实像素流 | 同上 | 面板里看到 Chromium 窗口；拖动/输入有响应 |
| Browser Use attach | 本机没有浏览器二进制 | 新会话让 Agent 打开一个页面，确认工具可用且与面板同一浏览器 |
| CJK 字体 | 同上 | 在桌面 Chromium 打开任意中文站点，截图确认不是方块 |
| `/dev/shm` 与 `shm_size` | 同上 | 开两个复杂页面不崩渲染进程 |

## 4. 构建后 runbook

```bash
cd deepseek-harness/deploy
docker compose build --pull
docker compose up -d
docker compose logs -f            # 期望看到 desktop-supervisor: started …
docker compose ps                 # 期望 (healthy)

# 容器内（不经反代）
docker compose exec -T deepseek-harness curl -fsS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3080/desktop/vnc.html                      # 200
docker compose exec -T deepseek-harness curl -fsS \
  http://127.0.0.1:9222/json/version | head -c 120            # {"Browser":"Chrome/…"}
docker compose exec -T deepseek-harness curl -fsS \
  http://127.0.0.1:3080/browser-desktop/state

# 经反代（Host 必须是 DSH_ACCESS_HOST）
curl -fsS -o /dev/null -w '%{http_code}\n' -H 'Host: dsh.example.com' \
  http://127.0.0.1:8080/desktop/vnc.html                      # 200
curl -i -N -H 'Host: dsh.example.com' -H 'Origin: https://dsh.example.com' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://127.0.0.1:8080/desktop/websockify | head -3          # 101（升级后由 x11vnc 说话）
```

浏览器侧：登录后点侧边栏 🌐，面板应直接显示容器里的 Chromium（同源、无需二次登录）。

## 5. 已知风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 镜像体积增加约 0.4–0.5 GB（Chromium + 字体 + X 栈） | 与访问方式无关；不需要桌面时用 `DSH_DESKTOP_ENABLED=0` 关闭运行，但层仍在 |
| dsh 升级后 `webServer` 路由 API 变化 | 构建期 import 真实 `dsh-host-webserver` 断言 `register`/`registerUpgrade` + 临时 `DSH_HOME` 的 `--dump-config` + 单测；见 `SYNC-UPSTREAM.md` §5 第 3.5 条 |
| 跨站 WebSocket 骑劫（CSWSH） | 升级路由强制 `Origin` 且要求与 `Host` 同 authority；缺失即 403（构建期与实测覆盖） |
| 桌面被第三方页面 iframe | 桌面文档带 `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` |
| 桌面可读容器文件（`file:///data/dsh/…`） | 文档化为单 owner 取舍；多用户必须一人一容器 |
| 反代加 `buffering`/`compress` 破坏桌面 socket | 文档 + §6 排障表 |
| 面板与 DSH 同进程，重启即断流 | 文档化为取舍；浏览器 profile 持久化，登录态不丢 |
| 桌面无按用户隔离 | 文档化为限制：多租户请一个容器一个用户 |
| `--no-sandbox` 的 Chromium | 只作用于 `chromium-docker` 启动的浏览器进程；容器本身不加宽权限 |
| noVNC 资产来自 GitHub tag 归档 | 构建时校验 SHA256；归档变化会导致构建失败而不是静默换版本 |
