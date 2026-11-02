# 与上游同步（1Panel-dev/runtime）

本仓库 `kjeung/runtime` 是上游 `1Panel-dev/runtime` 的 fork，默认分支 **`plain-http`**：

```
1Panel-dev/runtime : dev ──(merge/rebase)──▶ kjeung/runtime : plain-http
                                             ├── deepseek-harness/   改造后的镜像源码
                                             ├── deepseek-harness/deploy/   部署编排与文档
                                             ├── .github/workflows/  构建 + 每日同步 workflow
                                             └── （上游其它镜像源码原样保留）
```

只有**一个**仓库：部署文件在 `deepseek-harness/deploy/`，镜像源码在 `deepseek-harness/`，compose 的构建上下文是仓库根。

## 1. remotes 约定

```bash
git remote -v
# origin   = https://github.com/kjeung/runtime.git      （本仓库）
# upstream = https://github.com/1Panel-dev/runtime.git  （上游）
```

没有 `upstream` 时：

```bash
git remote add upstream https://github.com/1Panel-dev/runtime.git
```

## 2. 自动化（已启用）

`.github/workflows/sync-upstream.yml`：

- 每天 **03:17 UTC** + 手动 `workflow_dispatch`；
- `fetch upstream dev`；`plain-http` 已包含就结束；
- 否则把 `upstream/dev` **merge** 到 `sync/upstream-<sha>`，跑自检后 push，并向 `plain-http` 开 **PR**
  （PR 列出上游新提交、dsh 版本漂移警告、合并后要做的事）；
- merge 冲突时中止并开 **issue**「upstream dev@<sha> needs a manual merge」；
- 已有 open PR/issue 时不重复开。

为什么用 merge：rebase 后的分支与 `plain-http` 没有祖先关系，PR 合并会产生重复提交；merge 可 fast-forward。
想要线性历史时本地跑 `deepseek-harness/deepseek-harness/deploy/scripts/sync-upstream.sh`（rebase），之后的 rebase 会自动丢掉 merge 提交，两种方式可共存。

> 定时工作流只在**默认分支**运行，所以本仓库默认分支是 `plain-http`（不是上游的 `dev`）。
> 副作用：网页 **Sync fork** 等价于「merge upstream/dev 进 plain-http」，与工作流同一模型。

**合并 PR 之后**：不需要再同步任何「部署仓库」——`deepseek-harness/deploy/` 就在同一分支里。
直接重新构建即可：

```bash
git pull
cd deepseek-harness/deploy && docker compose build && docker compose up -d
```

## 3. 手动同步（一行命令）

```bash
deepseek-harness/deploy/scripts/sync-upstream.sh            # fetch + rebase + 自检/测试 + 重新导出 patches
deepseek-harness/deploy/scripts/sync-upstream.sh --push     # 再 force-with-lease 推 plain-http
deepseek-harness/deploy/scripts/sync-upstream.sh --skip-tests
```

脚本做的事：

1. `git fetch upstream dev`；
2. 若上游前进：把 `plain-http` **rebase** 到 `upstream/dev`（冲突时停下并给出指引）；
3. 自检 + 14 个代理测试（本机无 dsh 包时跳过；镜像构建期还会跑）；
4. 重新导出 `deepseek-harness/deploy/patches/image-source.diff`、`plain-http.bundle`，更新 `deepseek-harness/deploy/patches/BASE`；
5. `--push` 时 `git push --force-with-lease origin plain-http`。

脚本不会自动解决冲突，也**不会**自动改 `DSH_VERSION`。
脚本需要**完整历史**（浅克隆 `git fetch --unshallow` 后再用）；纯部署用浅克隆没问题。

## 4. 冲突处理（可预期，集中在这几个文件）

| 文件 | 冲突原因 | 处理原则 |
|---|---|---|
| `deepseek-harness/Dockerfile` | 上游改 Caddy 阶段/版本、包列表 | **删除**上游新增的 Caddy 相关行；保留本分支的 node-proxy COPY、8080、`/healthz` |
| `deepseek-harness/docker-entrypoint.sh` | 上游改认证/证书逻辑 | 保留本分支：无用户名密码、无 CA、启动 node-proxy；保留 uid/gid、就绪等待、`--trusted-host`、`ONEPANEL_DSH_AUTH_PROXY` |
| `deepseek-harness/test-runtime.mjs` | 上游改 Caddy 测试 | 保留 PDF 用例 + 本分支代理用例 |
| `deepseek-harness/patch-dsh-authenticated-settings.mjs` | 上游/DSH 改补丁字符串 | 见第 5 节 |
| `deepseek-harness/patch-dsh-manifest-sse.mjs` | 上游/DSH 改 Web index 或 HMR SSE | 见第 5 节 |
| `.github/workflows/deepseek-harness-release.yml` | 上游改 tag/输入 | 保留：独立镜像仓库名、`:<dshVersion>` + `:plain` 别名、context |
| `deepseek-harness/deploy/**` | 上游没有这个目录 | 一般不会冲突 |

`deepseek-harness/Caddyfile` 已删除；上游若修改它，保持删除即可。

## 5. dsh 版本升级（最需要注意的一步）

上游 workflow 的 `dshVersion` 默认值变化时，脚本与同步 workflow 都会打印警告。升级前：

1. **补丁可能失效**：`patch-dsh-authenticated-settings.mjs` 用精确字符串匹配修改 `isAuthenticated()` 和 PDF worker，
   `patch-dsh-manifest-sse.mjs` 用精确字符串匹配修改 Web index 的 manifest link 与 HMR SSE 的 close handler；
   DSH 源码形状一变，镜像构建期（`Dockerfile` 里执行这两个脚本）会直接失败——这是 fail-fast。
   需要在 `deepseek-harness/` 里更新对应匹配字符串。
2. **行为可能变化**：DSH 的 WebSocket 路径、`/api` 栅栏、gzip、300 MiB 上限都依赖 DSH 实现，
   升级后必须重跑端到端（见下）再发布。
3. 更新默认版本：`deepseek-harness/deploy/docker-compose.yml` 的 `DSH_VERSION`、`deploy/.env.example`、
   `.github/workflows/deepseek-harness-release.yml` 的 `dshVersion` 默认值，保持三者一致。
3.5 **桌面集成也要复核**（与 dsh 版本绑定）：
   - `deepseek-harness/plugins/dsh-browser-desktop/index.js` 依赖 `ctx.webServer.register({kind:'prefix'})` 与
     `ctx.webServer.registerUpgrade({path})`（`@deepseek-ai/dsh-host-webserver`）。这两个 API 消失或语义变化时，
     构建期的插件导入测试与 `node -e` 断言会失败，必须按新 API 改写静态路由与 RFB 桥接的挂载方式。
   - `deepseek-harness/web-desktop.cordis.patch.yml` 依赖 `insert` + `disabled: !!js …` 的 patch 语义；
     插件名 `@1panel/dsh-browser-desktop` 必须仍能由 `$DSH_HOME/profiles/web/node_modules` 的软链解析。
   - Browser Use 两个包必须与 `DSH_VERSION` 同版本安装（Dockerfile 的 `browser-use` 阶段），
     且 Playwright MCP 的 `mode: attach` / `endpoint` 配置键仍受支持。
   - 构建期会跑 `node --test /tmp/test-dsh-desktop.mjs`（路径几何、静态资源越权、帧编解码、真实 WS↔TCP 桥接、
     路由注册），失败即阻断发布。
4. 构建镜像并 `docker compose up -d`，确认日志出现
   `DeepSeek Harness is available at http://…:8080`。

端到端回归（本机有 dsh 时）：

```bash
# 终端 1：真实 dsh（用 deepseek-harness/deploy/prototype 的加载钩子复刻镜像补丁）
DSH_HOME=$PWD/.e2e/dsh HOME=$PWD/.e2e/dsh/home ONEPANEL_DSH_AUTH_PROXY=1 \
  node --expose-internals --import ./deepseek-harness/deploy/prototype/register.mjs \
  /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open \
  --host 127.0.0.1 --port 4599 --trusted-host 127.0.0.1:4599 example.test
# 终端 2：代理
PROXY_LISTEN_HOST=127.0.0.1 PROXY_LISTEN_PORT=8096 PROXY_BACKEND_PORT=4599 \
  PROXY_ALLOWED_HOSTS=example.test node deepseek-harness/node-proxy.mjs
# 终端 3：验证
curl -fsS -H 'Host: example.test' http://127.0.0.1:8096/healthz
curl -fsS -X POST -H 'Content-Type: application/json' -H 'Host: example.test' \
  -H 'Origin: http://example.test' \
  -d '{"type":"client-request","rpcId":"1","method":"settings/describe","payload":{"args":{}}}' \
  http://127.0.0.1:8096/api/settings/describe | head -c 120
node deepseek-harness/deploy/prototype/ws-test.mjs 8096 example.test http://example.test   # 期望 101
```

## 6. 验证同步结果

```bash
# 自动化状态
gh run list --repo kjeung/runtime --workflow sync-upstream.yml --limit 3
gh pr list --repo kjeung/runtime --base plain-http --state open
# 本地源码
git log --oneline -3
git rev-parse upstream/dev plain-http
cat deepseek-harness/deploy/patches/BASE
git status                       # 应为干净
```
