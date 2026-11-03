# ADR 0002：社区插件市场（dsh-market）的交付方式与数据卷属主

- 状态：已采纳
- 日期：2026-11-03
- 相关代码：`deepseek-harness/Dockerfile`（`dsh-market` 阶段）、`deepseek-harness/docker-entrypoint.sh`、
  `deepseek-harness/web-market.cordis.patch.yml`、`deepseek-harness/test-market.mjs`
- 相关文档：[`deepseek-harness/deploy/README.md`](../../deepseek-harness/deploy/README.md) §10.7、
  [`deepseek-harness/deploy/SYNC-UPSTREAM.md`](../../deepseek-harness/deploy/SYNC-UPSTREAM.md) §5

## 1. 背景

用户要在 1Panel 的 DeepSeek Harness 部署里使用社区插件市场 **dsh-market**（npm 包 `dshmarket`，
第三方 MIT，仓库 `dsh-market/dsh-market`）。它是一个标准的 DSH bundle：`package.json` 声明
`dsh.bundle.patch` 与 Web 客户端（`dsh.client.platform = "web"`），自带 `cordis.patch.yml`
插入 `dsh-market` 行，提供插件目录、一键安装/更新、收藏、分组、主题等能力。

它有两种装配方式：作为 **profile 依赖**（`dsh plugin add dshmarket`，pnpm 写进
`$DSH_HOME/profiles/<name>/node_modules`），或作为 **镜像内容**（构建期装进镜像，
启动时链入 profile）。部署实际遇到的故障发生在第二种装配的前置条件上：

- 本镜像的 `docker-entrypoint.sh` 以 **root** 启动，随后 `gosu node` 运行 dsh；
- 桌面集成提交（`9d861ca`）开始在 entrypoint 里把镜像内的插件（browser-use、桌面插件）
  软链进 `/data/dsh/profiles/web/node_modules`，用的是 `install -d -o node … "$(dirname "$link")"`；
- **`install -d` 只对自己收到的那个目录应用 `-o/-g`，它创建出来的父目录是 root 属主**
  （coreutils `install.c` 的 `make_ancestor()` 只做 `mkdir(component, DEFAULT_MODE)`，
  属性只对最终目录执行）。于是 `/data/dsh/profiles/web/node_modules` 留在 root:root，
  而 dsh 以 uid 1000 跑 pnpm，`dsh plugin add` 直接 `EACCES`。

上游两个参照实现都没有这个问题：`1Panel-dev/runtime` 的 entrypoint 从不写 profile；
`runzhliu/deepseek-harness-docker` 的 entrypoint 以 **USER node** 运行（并在镜像层
`chown -R node:node $DSH_HOME`），profile 天然是 node 属主。本仓的桌面集成把
"root entrypoint + 写 profile" 组合了进来，才暴露出这个缺陷。

## 2. 约束

1. `/data/dsh` 是宿主机 bind mount（`DSH_DATA_DIR`），跨容器重建保留，但可能带着旧镜像/root
   操作留下的属主；entrypoint 是唯一能在启动时修复它的进程（有 CAP_CHOWN）。
2. DSH 进程以 `node`（1000）运行；profile、pnpm store、`dsh plugin` 的写入都必须对 node 可写。
3. 镜像要"开箱即有"插件市场：新主机、空数据卷、离线环境不应对市场本体做网络安装。
4. 社区插件与市场状态属于用户态，必须落在数据卷里，跨容器重建保留。
5. 不能破坏既有桌面/Browser Use 的 profile 软链方式，也不能让同一行 id 被插入两次
   （loader 的 `insert` 是追加，重复 id 会得到两个插件实例）。
6. 市场自身在 host 进程内执行第三方代码；版本必须可固定、可审计。

## 3. 候选方案

| 编号 | 方案 | 形态 |
| --- | --- | --- |
| A | 运行时 profile 安装 | 首启/手工 `dsh plugin add dshmarket`，市场在数据卷 |
| B | 镜像内容 + 启动时链入 profile | 构建期装进镜像，entrypoint 软链，overlay 插入行 |
| C | 独立 market 镜像变体 | 像 `runzhliu/deepseek-harness-docker` 的 `Dockerfile.market` 那样单出镜像 |
| D | 镜像内容 + 写 profile `dsh.profile.bundles` | 构建期装进镜像，启动时改 profile 清单声明 bundle |

## 4. 评估

| 维度 | A 运行时安装 | B 镜像内容 + 软链 | C 独立镜像变体 | D 镜像内容 + bundles |
| --- | --- | --- | --- | --- |
| 空数据卷/新主机开箱可用 | ❌ 需出网 + pnpm | ✅ | ✅ | ✅ |
| 离线可用 | ❌ | ✅ | ✅ | ✅ |
| 市场自更新 | ✅ 原生支持 | ⚠️ 镜像层不可写；切回 profile 安装即可自更新 | ✅ | ⚠️ 同 B |
| 数据卷职责 | 插件+市场都在卷里 | 卷里只有用户态，镜像负责基线 | 同 B | 同 B |
| 版本可复现 | ❌ 取决于何时安装 | ✅ `DSH_MARKET_VERSION` 固定 | ✅ | ✅ |
| 与本镜像既有模式一致 | ⚠️ 与桌面/browser-use 的"镜像内容"策略不一致 | ✅ 同策略 | ✅ | ⚠️ 需要 entrypoint 改 profile 清单 |
| 重复 `dsh-market` 行风险 | 无 | 低（entrypoint 检测 profile 依赖后跳过镜像 overlay） | 同 B | 中（bundle 层与 overlay 只能留一个） |
| 运维复杂度 | 低（但要处理失败与网络） | 中（属主修复是前提） | 高（多一个镜像 tag 要发版） | 中高（启动时改用户清单，回到"root 写 profile"） |

## 5. 决定

采用 **B**，并同时修复数据卷属主：

1. **构建期**：`dsh-market` 阶段用 `npm pack` + `npm install --ignore-scripts` 把
   `dshmarket@${DSH_MARKET_VERSION}` 装到 `/opt/dshmarket`（先脱离 DSH 的发布树，避免 npm
   prune DSH 自己的包），再 `COPY` 到 `…/dsh/node_modules/dshmarket`（与 browser-use 同策略，
   它的 `@deepseek-ai/*` peer 从 DSH 安装目录解析）。
2. **entrypoint**：
   - `prepare_dsh_volume` 显式逐级创建 `/data/dsh`、`home`、`pnpm-store`、`profiles`、
     `profiles/web`、`profiles/web/node_modules`，每级都以 `-o node` 传入（不再依赖
     `install -d` 顺带创建的父目录）；
   - `repair_dsh_volume_ownership` 在启动时检查 profile 树，发现非 node 属主就
     `chown -R -h node:node`（`-h` 只改软链自身，不动镜像内被指向的文件），覆盖旧卷迁移；
   - 软链 `…/node_modules/dshmarket`，并在 profile 未声明 `dshmarket` 依赖时追加
     `web-market.cordis.patch.yml` overlay；profile 已声明时保留 profile 副本、**不**追加 overlay。
3. **overlay**：`web-market.cordis.patch.yml` 插入 `dsh-market` 行，`DSH_MARKET_ENABLED=0`
   时 `disabled`，`config.allowRestart: false`（容器生命周期由 entrypoint 管，市场的"一键重启"不适用）。
4. **共享 pnpm store**：镜像 `ENV npm_config_store_dir=/data/dsh/pnpm-store`，entrypoint 以 node
   属主创建；市场装社区插件与 `dsh plugin` 使用同一个持久、可写的 store。
5. **测试**：`test-market.mjs` 断言包身份/bundle 声明/Web 客户端/软链解析/overlay 内容；
   构建期再用 `--dump-config` 组合两个 overlay；entrypoint `--self-test` 验证"新卷 + root 属主旧卷"
   两种情况下 profile 目录最终归 node。

## 6. 后果

正面：

- 新部署开箱有市场，无需网络安装；镜像版本可复现、可审计；
- profile 与 pnpm store 的属主由 entrypoint 统一修复，`dsh plugin` 与市场安装不再受旧卷影响；
- 市场状态/社区插件留在数据卷，容器重建不丢（与用户预期一致）。

负面/代价：

- 市场自身升级 = 重建镜像；镜像层对 node 只读，市场 UI 的自更新会失败。需要自更新时，
  按 README §10.7 切回 profile 安装（`dsh plugin add dshmarket`），entrypoint 会自动让位；
- 数据卷仍可能被 root 进程写脏（例如有人以 root 跑 pnpm），每次启动的 find 检查会做一次修复；
- 市场在 host 进程内加载第三方代码，信任边界等同 owner（README §9/§10.7 已写明）。

## 7. 回归要点

- 升级 DSH 版本时：`dshmarket` 的 peer 范围（`^0.2.1-rc.1` 这类预发布区间）不一定覆盖新的
  `0.2.2-alpha.x`，必须复核并同步调整 `DSH_MARKET_VERSION`；构建期 `test-market.mjs` 与
  `--dump-config` 只能兜住装配，不判断 peer 语义。
- 不要同时保留"镜像内置 + profile 已安装"两份：entrypoint 的检测是为了让 profile 副本优先，
  而不是让两者同时挂载；迁移时按 README §10.7 移除 profile 依赖再重启。
- 上游同步：`docker-entrypoint.sh` 与 `Dockerfile` 在冲突表内，保留本 ADR 的目录属主修复与
  market 阶段；`web-market.cordis.patch.yml` 是 fork 新增文件，上游不会产生冲突。
