# ADR 0001：浏览器桌面（Chromium + noVNC）的访问方式

- 状态：已采纳
- 日期：2026-11-03
- 相关代码：`deepseek-harness/plugins/dsh-browser-desktop/`、`deepseek-harness/desktop-supervisor.sh`、`deepseek-harness/deploy/traefik/dynamic.yml`
- 相关文档：[`deepseek-harness/deploy/README.md`](../../deepseek-harness/deploy/README.md)

## 1. 背景

`1panel/deepseek-harness`（明文 HTTP 变体）把 DSH 的认证与 TLS 全部交给外部反向代理：
容器内只有一个 `node-proxy` 监听 `0.0.0.0:8080`，把请求原样转给 `127.0.0.1:3080` 的
`dsh web`，并用 `DSH_ACCESS_HOST` 做 Host 白名单。生产拓扑是 **Traefik + Authentik**：
Traefik 按 `Host(dsh.example.com)` 路由、`passHostHeader: true`，认证由 Authentik 的
forwardAuth 中间件完成。

现在要引入上游 `runzhliu/deepseek-harness-docker` 的可见桌面能力：Debian Chromium、
中文字体、Xvfb + Openbox、x11vnc、noVNC 客户端，以及把桌面暴露给模型与用户的
`browser_open` / Browser Use attach。桌面必须能从浏览器访问，于是产生一个绕不开的
问题：**浏览器用什么地址找到它？**

候选有三类：子域名、子路径、非标端口；还有若干"其它"做法。本 ADR 记录评估与决定。

## 2. 约束

1. 只有一个容器、一个明文 HTTP 端口（`8080`）。容器内没有认证、没有证书。
2. 认证只有一处：Traefik router 上的 Authentik forwardAuth 中间件；它必须覆盖
   **全部路径**，包括 WebSocket 升级。
3. Host 栅栏是逐字匹配的：`DSH_ACCESS_HOST` 与浏览器 `Host` 不一致就会 403；反代
   不能改写 Host，也不能丢掉端口。
4. noVNC 除了静态资源，还要一条 **WebSocket** 长连接（RFB over WebSocket）。
5. 桌面面板是 DSH UI 里的一个 iframe；用户已经在 `https://dsh.example.com` 登录。
6. 运维现实：新增 DNS 记录、证书、入口点、端口放行、Authentik application 都要走
   变更流程；企业网络对非标端口常常直接封禁。

## 3. 候选方案

| 编号 | 方案 | 形态 |
| --- | --- | --- |
| A | 子域名 | `https://novnc.dsh.example.com/…` |
| B | 子路径（同源） | `https://dsh.example.com/desktop/…` |
| C | 非标端口 | `https://dsh.example.com:6080/…` |
| D | 其它 | 独立桌面容器、原生 VNC 客户端、SSH 隧道、整站子路径 |

## 4. 评估

### 4.1 逐维度对比

| 维度 | A 子域名 | B 子路径 | C 非标端口 |
| --- | --- | --- | --- |
| Authentik 复用 | ❌ 需要新的 Application/Provider（forwardAuth 按 Host 查应用），会话 Cookie 不共享 | ✅ 同一个 Application、同一个会话 | ⚠️ 需要新的 Application（external host 含端口），会话 Cookie 共享（Cookie 不区分端口）但配置分裂 |
| 用户登录体验 | ❌ 面板里再登一次；iframe 内出现登录页 | ✅ 已登录，直接可用 | ⚠️ 通常能复用会话，但首次跳转仍落在另一个 origin |
| 第三方 Cookie | ❌ 跨源 iframe，Safari ITP / Chrome 第三方 Cookie 策略会拦 | ✅ 同源，无此问题 | ⚠️ 同 host 不同端口仍是不同 origin，属第三方上下文 |
| TLS 证书 | ❌ 要么加泛域名，要么单独签发 | ✅ 已有证书 | ✅ 已有证书（同 host） |
| DNS / 入口点 / 防火墙 | ❌ 新记录 + 新入口规则 | ✅ 无 | ❌ 新 entryPoint + 端口放行 + 云端安全组 |
| Traefik 变更 | ⚠️ 新 router（新 Host 规则） | ✅ 零变更 | ❌ 新 entryPoint + 新 router |
| WebSocket | ⚠️ 新 router 也要挂认证中间件，漏配就裸奔 | ✅ 沿用现有 router 的认证 | ⚠️ 同样要单独确认中间件覆盖 |
| Host 栅栏 / 共享密钥 | ⚠️ 桌面路径若绕过 `node-proxy`，就绕过了 `PROXY_SHARED_SECRET` 与 Host 白名单 | ✅ 仍在同一个 8080、同一套栅栏内 | ❌ 必然绕过 `node-proxy`（新端口新上游），防护要重做一遍 |
| 代码改动 | 需要给插件加"绝对 origin"模式，客户端拼绝对 URL | 复用现有路由机制（DSH `webServer` 的 prefix + upgrade 路由） | 上游默认形态（改端口号），代码最少 |
| 失效模式 | 证书/DNS/Cookie 三类问题叠加，排障面最大 | 与 DSH 同生命周期：DSH 重启桌面断线，可接受 | 端口被封时表现为"整块不可用"，且难判断是哪一层 |
| 可观测性 | 两套 access log（取决于反代配置） | 一条 `node-proxy` JSON 访问日志覆盖 | 需要第二个日志源 |

### 4.2 逐项结论

**A 子域名** 看起来"最干净"，实际代价最高。Authentik 的 forwardAuth 按请求 Host
匹配 application，因此必须新建 application/provider；Cookie 是 host-only 的，父域
`dsh.example.com` 的会话不会带到 `novnc.dsh.example.com`——就算把 Cookie 域放宽成
`.example.com`，面板是**跨源 iframe**，仍然落在第三方 Cookie 的拦截范围里（Safari
默认拦、Chrome 逐步限制）。结果就是"打开桌面面板先看到一次登录页"，而这恰好是
桌面面板最不该出现的体验。再叠加泛域名证书与 DNS 变更，A 只在"桌面要独立暴露给
另一组人、另一套认证策略"时才合理——那是一个不同的产品需求。

**B 子路径** 把桌面放在 `https://dsh.example.com/desktop/`。它就是同一个 host、同一个
端口、同一个 TLS 连接、同一个 Authentik application、同一个会话 Cookie；面板 iframe
与父页面同源，没有第三方 Cookie、没有混合内容、没有 `frame-ancestors` 冲突（企业
常在反代上加 `frame-ancestors 'self'`，跨源方案会被自己的安全头挡住）。Traefik 侧
**零变更**：现有 router 的 `Host` 规则和认证中间件天然覆盖新路径，WebSocket 升级也
走同一个 router。`node-proxy` 的 Host 白名单与可选的 `X-DSH-Proxy-Secret` 同样覆盖
它——这是 A/C 都拿不到的"顺手继承"。

代价在实现侧：桌面必须挂在 DSH 自己的 HTTP 服务上，而不是另起一个端口。DSH 0.2.1
的 `@deepseek-ai/dsh-host-webserver` 正好提供 `register({kind:'prefix'})` 与
`registerUpgrade({path})`，于是插件可以：
- 用 prefix 路由把 noVNC 1.6 静态资源挂在 `/desktop/`；
- 用 exact upgrade 路由挂 `/desktop/websockify`，在进程内把 WebSocket 帧解出来、
  通过 loopback TCP 喂给 x11vnc（`-localhost -nopw`），再反向成帧发回浏览器；
- 不再需要 `websockify`（Python）这个独立进程，也不需要第二个监听端口。

**C 非标端口** 是上游的默认形态（`desktopPort` 直接改 URL 端口），代码改动最小，
但运维代价最大：Traefik 要新增 entryPoint、宿主机/安全组要放行、云厂商与公司网络
对非标端口的态度不可控。更关键的是它**绕开了 `node-proxy`**：桌面要走新端口的新
上游，Host 白名单和共享密钥得另做一份，或者干脆没有；同时它仍是跨源 iframe，
Cookie 与 `frame-ancestors` 的问题与 A 相同。只有在"反代完全不支持按路径路由"或
"桌面必须与主站隔离到不同入口"时才选它。

**D 其它**：
- *独立桌面容器*（`network_mode: service:deepseek-harness` 共享 loopback，好让 CDP
  `127.0.0.1:9222` 仍可 attach）：拆得干净，但多一个容器、多一个入口脚本、多一处
  认证判断，而且"浏览器怎么到它"这个问题原样存在，仍然要在 A/B/C 里选一个。
- *原生 VNC 客户端直连 5900*：需要 VPN + 客户端软件，不是"零客户端"，且 5900 裸奔
  风险高。放弃。
- *SSH 隧道 + 本地 noVNC*：安全但每次使用都要建隧道，不适合产品化。放弃。
- *把整个 DSH 放到子路径*（`https://host/dsh/`）：这是另一个问题（需要
  `--public-url` + `stripPrefix`，且会影响 `/api` 的 Origin/Host 栅栏与前端绝对
  路径）。它与桌面无关，混在一起只会让两件事互相拖累。不采用。

### 4.3 安全性对比（同一信任边界）

三种方案在"谁能看桌面"上都必须由 Authentik 决定，差别在于**配置出错时的爆炸半径**：

- B：只有一条 router。认证中间件已经在 router 上，新增路径默认被覆盖；忘记配置的
  可能性最低。
- A：新 router 必须记得挂同一个中间件；漏挂就是"桌面公网可达且无认证"。
- C：新 entryPoint + 新 router，同样要记得挂中间件，且桌面流量不再经过 `node-proxy`
  的 Host 白名单与共享密钥。

桌面本身是一个**有网络身份的真实浏览器**：能读容器内的会话、能用容器的出网、能
保留登录态（`/data/dsh/chrome-profile`）。因此"默认继承现有认证"不是便利问题，而是
安全属性。

## 5. 决定

采用 **B：同源子路径**，桌面固定挂在 `<DSH 访问地址>/desktop/`，RFB 走
`/desktop/websockify`，由 DSH 进程内的桥接直连 `127.0.0.1:5900`。

具体形态：

| 项 | 值 |
| --- | --- |
| 静态资源 | `GET /desktop/*`（noVNC 1.6.0，镜像内置，带 ETag 重新校验） |
| RFB | `WSS /desktop/websockify` → 进程内 → `127.0.0.1:5900`（x11vnc） |
| 面板状态 | `GET /browser-desktop/state` |
| 打开页面 | `POST /browser-desktop/open`（同源校验） |
| 端口 | 仍然只有 `8080` |
| 反代 | 现有 router 不变；认证中间件已覆盖全部路径 |
| 关闭开关 | `DSH_DESKTOP_ENABLED=0` |

## 6. 后果

**正面**
- 一处登录、一个证书、一条 DNS、一个入口点、一条 router；桌面与 `/api` 共享同一套
  认证与同一套 Host/密钥栅栏。
- 面板同源，不受第三方 Cookie 策略影响；企业加 `frame-ancestors 'self'` 也不会坏。
- 少一个进程（无 `websockify`）、少一个容器端口、少一份需要单独审计的监听。
- 上游的 Chromium/字体/桌面体验完整保留：中文页面可读，`browser_open` 与人工接管
  操作同一个持久化浏览器。

**负面 / 取舍**
- 桌面流量与 DSH 共用一个 Node 进程与端口。RFB 是低带宽协议（1440×900 常见操作
  几十 KB/s～几 MB/s），Node 的流式转发足够；但它是"应用进程内"转发，不是内核级
  反代，极端的并发桌面不适用。
- 容器/DSH 重启会断开 VNC 会话（浏览器 profile 保留）。桌面本来就和 Harness 同
  生命周期，可接受。
- 镜像体积显著增加（Chromium + CJK 字体 + X 栈约数百 MB）。这是引入可见桌面的固有
  成本，与访问方式无关。
- 若将来确实需要子域名/独立端口，需要在插件里增加"绝对 origin"配置（当前
  `desktopPath` 被校验为同源路径）。这是有意保留的限制：先把安全默认值定死，
  真有需求时再显式开口子。

**风险控制**
- Authentik 中间件必须覆盖整个 router（本方案天然覆盖，但仍应在变更时检查）。
- 反代不要加 `buffering` / `compress` 中间件：会同时破坏桌面 WebSocket 与 SSE。
- 桌面 socket 每 30 s 发一次 WebSocket ping，避免空闲被中间层切断。
- `x11vnc` 只监听 loopback 且 `-nopw`；Chromium DevTools 只监听 `127.0.0.1:9222`；
  容器仍只发布一个回环端口。
- `DSH_DESKTOP_ENABLED=0` 可以在不支持 X 栈的宿主机上一键退回"纯 Harness"。

**验证方式**
- 构建期：`node --test test-desktop.mjs`（路径几何、静态资源越权、帧编解码、真实
  WebSocket↔TCP 桥接、路由注册）。
- 运行期：容器内 `curl -s 127.0.0.1:3080/desktop/vnc.html`、`curl -s
  127.0.0.1:9222/json/version`；经反代后确认 `/desktop/websockify` 返回 101。
  详见部署指南的"内嵌 Chromium 桌面"一节。
