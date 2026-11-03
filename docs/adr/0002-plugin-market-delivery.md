# ADR 0002：社区插件市场（dsh-market）的交付方式与数据卷属主

- 状态：已采纳
- 日期：2026-11-03
- 相关代码：`deepseek-harness/Dockerfile`（`dsh-market` 阶段）、`deepseek-harness/docker-entrypoint.sh`、
  `deepseek-harness/web-market.cordis.patch.yml`、`deepseek-harness/web-desktop.cordis.patch.yml`、
  `deepseek-harness/test-market.mjs`
- 相关文档：[`deepseek-harness/deploy/README.md`](../../deepseek-harness/deploy/README.md) §10.7、
  [`deepseek-harness/deploy/SYNC-UPSTREAM.md`](../../deepseek-harness/deploy/SYNC-UPSTREAM.md) §5

## 1. 背景

用户要在 1Panel 的 DeepSeek Harness 部署里使用社区插件市场 **dsh-market**（npm 包 `dshmarket`，
第三方 MIT，仓库 `dsh-market/dsh-market`）。它是标准 DSH bundle：`package.json` 声明
`dsh.bundle.patch` 与 Web 客户端（`dsh.client.platform = "web"`），自带 `cordis.patch.yml`
插入 `dsh-market` 行，提供插件目录、一键安装/更新、收藏、分组、主题等能力。

它有两种装配方式：作为 **profile 依赖**（`dsh plugin add dshmarket`，pnpm 写进
`$DSH_HOME/profiles/<name>/node_modules`），或作为 **镜像内容**（构建期装进镜像，
由 entrypoint 通过 `--patch` overlay 挂载）。

早期实现（`9d861ca`，与市场无关的桌面集成先用了同一模式）把镜像内的插件**软链进
`/data/dsh/profiles/web/node_modules`**，以便 loader 从 profile 目录解析行里的裸包名。该实现
有以下问题：

- entrypoint 以 **root** 运行，`install -d -o node … "$(dirname "$link")"` 只对末级目录
  `chown`（coreutils `install.c` 的 `make_ancestor()` 对父目录只做 `mkdir`），新卷上
  `profiles/`、`profiles/web/`、`node_modules/` 会留成 root:root → DSH 以 node 初始化 profile
  失败；旧卷则 `node_modules` root-owned，`dsh plugin add` / 市场安装 `EACCES`；
- 数据卷里混入镜像内容的软链，升级镜像后 profile 副本与镜像副本的优先级需要额外规则。

## 2. 约束

1. `/data/dsh` 是宿主机 bind mount（`DSH_DATA_DIR`），跨容器重建保留，但可能带着旧镜像/root
   操作留下的属主；entrypoint 是唯一能在启动时修复它的进程（有 CAP_CHOWN）。
2. DSH 进程以 `node`（1000）运行；`dsh plugin` 与市场安装社区插件时写 profile / pnpm store，
   这些路径必须对 node 可写。
3. 镜像要"开箱即有"插件市场：新主机、空数据卷、离线环境不应对市场本体做网络安装。
4. 社区插件与市场状态属于用户态，必须落在数据卷里，跨容器重建保留。
5. 不能让同一行 id 被插入两次（loader 的 `insert` 是追加，重复 id 会得到两个插件实例）。
6. 市场自身在 host 进程内执行第三方代码；版本必须可固定、可审计。

## 3. 候选方案

| 编号 | 方案 | 形态 |
| --- | --- | --- |
| A | 运行时 profile 安装 | 首启/手工 `dsh plugin add dshmarket`，市场在数据卷 |
| B | 镜像内容 + 启动时软链进 profile | 构建期装进镜像，entrypoint 软链，overlay 插入行 |
| C | 独立 market 镜像变体 | 像 `runzhliu/deepseek-harness-docker` 的 `Dockerfile.market` 那样单出镜像 |
| D | 镜像内容 + overlay 绝对路径 | 构建期装进镜像，overlay 行直接写镜像内绝对路径，**不写 profile** |

## 4. 评估

| 维度 | A 运行时安装 | B 镜像内容 + 软链 | C 独立镜像变体 | D 绝对路径行 |
| --- | --- | --- | --- | --- |
| 空数据卷/新主机开箱可用 | ❌ 需出网 + pnpm | ✅ | ✅ | ✅ |
| 离线可用 | ❌ | ✅ | ✅ | ✅ |
| 数据卷是否被镜像内容污染 | 插件都在卷里 | ❌ 软链 + 属主问题 | ❌ 同 B | ✅ 完全不用写卷 |
| 属主耦合 | 需要 profile 可写 | ❌ 启动时依赖 root 写卷 | ❌ | ✅ 与启动无关 |
| 市场自更新 | ✅ 原生支持 | ⚠️ 镜像层不可写；可切回 profile 安装 | ✅ | ⚠️ 同 B |
| 版本可复现 | ❌ 取决于何时安装 | ✅ `DSH_MARKET_VERSION` 固定 | ✅ | ✅ |
| 搬运/一致性 | 中 | 中（软链规则 + 优先级） | 高（多镜像 tag） | 低（overlay 即清单） |
| 对本仓既有模式 | 不一致 | 与桌面/browser-use 曾用方式一致 | 一致 | 统一为一种方式 |

> D 的可行性已实测：overlay 行写 `/opt/.../index.js`、`…/dsh-browser-use/lib/index.js`、
> `…/dshmarket/lib/index.js` 时，DSH 启动无 "did not activate" 告警，`/desktop/vnc.html` 200、
> `/dsh-market/status` 正常，且 Web 客户端 roster 里出现 `browser-desktop/client.js` 与
> `dshmarket/client.js`（client-modules 会从行所指文件最近的 `package.json` 读取 `dsh.client`）。

## 5. 决定

采用 **D**，并保留数据卷属主修复（供运行时安装使用）：

1. **构建期**：`dsh-market` 阶段用 `npm pack` + `npm install --ignore-scripts` 把
   `dshmarket@${DSH_MARKET_VERSION}` 装到 `/opt/dshmarket`（先脱离 DSH 发布树，避免 npm prune
   DSH 自己的包），再 `COPY` 到 `…/dsh/node_modules/dshmarket`（与 browser-use 同策略，
   它的 `@deepseek-ai/*` peer 从 DSH 安装目录解析）。
2. **overlay**：`web-desktop.cordis.patch.yml` 与 `web-market.cordis.patch.yml` 的行名改为镜像内
   **绝对路径**；`DSH_DESKTOP_ENABLED=0` / `DSH_MARKET_ENABLED=0` 时 `disabled`；市场的
   `config.allowRestart: false`（容器生命周期由 entrypoint 管）。
3. **entrypoint**：不再创建/软链 profile 内的镜像内容；只
   - `prepare_dsh_volume` 以 node 属主建 `/data/dsh`、`home`、`pnpm-store`；
   - 启动时修复旧卷里 root 写脏的 `/data/dsh/profiles`、`chrome-profile`、
     `home/.npm`、`home/.local/share/pnpm`（发现非 node 文件才 `chown -R -h`，`-h` 不碰镜像内容）；
   - 检测 profile 是否声明 `dshmarket`：声明了就不再追加镜像 overlay（避免 `dsh-market` 行重复）。
4. **共享 pnpm store**：镜像 `ENV npm_config_store_dir=/data/dsh/pnpm-store`，entrypoint 以 node
   属主创建；市场装社区插件与 `dsh plugin` 使用同一个持久、可写的 store。
5. **测试**：`test-market.mjs` 断言包身份/bundle 声明/Web 客户端/overlay 绝对路径与镜像文件存在性；
   `--dump-config` 组合两个 overlay；构建期用 DSH 的 `evaluatePluginCompatibility` 校验
   dshmarket 与当前 DSH 的 peer/engines 兼容性；entrypoint `--self-test` 验证"新卷 + root 属主旧卷"
   两种输入都归 node。

## 6. 后果

正面：

- 新部署开箱有市场，无需网络安装；镜像版本可复现、可审计；
- 数据卷只存用户态（profile/社区插件/缓存），不再出现镜像内容的软链，也不再有"镜像插件需要
  profile 可写"的启动耦合；
- 桌面、Browser Use 与市场统一为同一种"镜像内容 + overlay 绝对路径"装配方式；
- profile 属主修复仍覆盖旧卷，`dsh plugin` / 市场安装不受历史 root 文件影响。

负面/代价：

- 市场自身升级 = 重建镜像；镜像层对 node 只读，市场 UI 的自更新会失败。需要自更新时，
  按 README §10.7 切回 profile 安装（`dsh plugin add dshmarket`），entrypoint 会自动让位；
- overlay 行是绝对路径：镜像内布局变化必须同步改 overlay（`test-market.mjs` 会断言路径存在）；
- 依赖 Cordis loader 的路径行与 client-modules 的"最近 package.json"发现规则；DSH 升级后由
  构建期 `--dump-config`、`test-market.mjs` 与部署冒烟兜底；
- 市场在 host 进程内加载第三方代码，信任边界等同 owner（README §9/§10.7 已写明）。

## 7. 回归要点

- 升级 DSH 版本时：`dshmarket` 的 peer 范围（`^0.2.1-rc.1` 这类预发布区间）不一定覆盖新的
  `0.2.2-alpha.x`，必须复核并同步调整 `DSH_MARKET_VERSION`；构建期兼容性断言会先失败。
- 不要同时保留"镜像内置 + profile 已安装"两份：entrypoint 的检测是为了让 profile 副本优先，
  而不是让两者同时挂载；迁移时按 README §10.7 移除 profile 依赖再重启。
- 上游同步：`docker-entrypoint.sh` 与 `Dockerfile` 在冲突表内，保留本 ADR 的属主修复、market
  阶段与绝对路径 overlay；`web-market.cordis.patch.yml` 是 fork 新增文件，上游不会产生冲突。
