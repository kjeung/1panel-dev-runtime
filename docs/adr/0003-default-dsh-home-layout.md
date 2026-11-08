# ADR 0003：撤回 `DSH_HOME` 覆盖，回到 `$HOME/.dsh` 默认布局

- 状态：已采纳（2026-11-09 修订：见 ADR 0004 与下文「修订」节）
- 日期：2026-11-08
- 修订：2026-11-09
- 相关代码：`deepseek-harness/Dockerfile`、`deepseek-harness/docker-entrypoint.sh`、`deepseek-harness/dsh`
- 相关文档：[`deepseek-harness/deploy/README.md`](../../deepseek-harness/deploy/README.md) §3.2、§4、§10.7

## 0. 修订（2026-11-09，ADR 0004）

ADR 0004 把 `HOME` 从 `/data/dsh/home` 改成 `/home/node`（即 `node` 用户的 passwd home），
持久卷挂载点随之从 `/data/dsh` 改为 `/home/node`。因此：

- 本文所有 `/data/dsh/home/…` 路径按本量表平移：`/data/dsh/home` → `/home/node`、
  `/data/dsh/chrome-profile` → `/home/node/chrome-profile`、`/data/dsh/home/.npm` → `/home/node/.npm`，
  主机侧默认目录 `./data/dsh` → `./data/home`。
- 本文第 3 节决策条目 1、5（"`HOME` 与 `DSH_HOME` 是兄弟目录""数据根变成 `/data/dsh/home/.dsh`"）
  与第 5 节"正面"条目里关于路径的表述，按上述平移理解。

**对本文第 1 节第 13 行事实错误的勘误。**原文写道"把 `HOME` 挪进同一个卷，好让
pnpm store、git/ssh 配置、`gh` 登录态、XDG 缓存跟着持久化"。其中 "ssh 配置" 一项
**并不成立**：OpenSSH 家族（`ssh`、`ssh-keygen`、`ssh-copy-id`、`scp`、`sftp`）解析 `~`
时只看 `/etc/passwd` 的 home 目录、完全不读 `$HOME`（实测
`HOME=/tmp/x ssh-keygen -t ed25519` 的默认保存路径仍是 `/home/node/.ssh/id_ed25519`；
`HOME=/tmp/x ssh -G -o UserKnownHostsFile='%d/kh' x` 展开成 `/home/node/kh`）。
后果：密钥、`known_hosts` 落在 **容器可写层** 的 `/home/node/.ssh` 而非持久卷，
容器重建即丢失。`git` 与 `gh` 走 `$HOME`，能持久化；只有 ssh 系工具例外。
ADR 0004 即为此收敛两个 home。

## 1. 背景

本镜像自首次导入（上游 `9047506`，2026-08-13）起就设 `ENV DSH_HOME=/data/dsh`，并在
entrypoint 与 `dsh` 包装脚本里以 `HOME=/data/dsh/home DSH_HOME=/data/dsh` 成对强制注入
（封装见上游 `592a567`）。动机是让 DSH 数据直接落在持久卷根 `/data/dsh`，不必多绕一层
`home/.dsh`；同时把 `HOME` 挪进同一个卷，好让 pnpm store、git/ssh 配置、`gh` 登录态、
XDG 缓存跟着持久化。

这两个目标各自都成立，代价是**主动剪断了 DSH 的默认布局**：`HOME` 与 `DSH_HOME` 成了
兄弟目录，`$HOME/.dsh/profiles` 在本镜像里永远不存在。

## 2. 问题

`dsh-mattpocock-skills-deck@1.9.0-beta.33` 枚举自带技能时只按**默认布局**找：

```js
// lib/bootstrap.js / lib/skillDoc.js
path.join(os.homedir(), ".dsh/profiles/web/node_modules/…/bundled-skills")
path.join(os.homedir(), ".dsh/profiles/desktop/node_modules/…/bundled-skills")
```

它不读 `DSH_HOME`（`grep DSH_HOME` 在宿主侧代码零命中）。于是候选全部 miss，
`if (!bundledDir) { logger.warn("[bundled] dir not found, skip provider"); return }`
让它**静默跳过自己**：插件装得好好的，界面却一直挂着"未检测到核心技能套件"。

实测复现（`HOME=/data/dsh/home`、`DSH_HOME=/data/dsh`、cwd=`/workspace`）：全部候选 miss；
而真实目录 `/data/dsh/profiles/web/node_modules/…/bundled-skills` 存在且完好。

第一次修复（`e957399`）在 entrypoint 里加 `ensure_profile_anchor()`，把
`$HOME/.dsh/profiles` 软链到 `/data/dsh/profiles`，并在 `--self-test` 里断言该候选可解析。
补丁有效，但只是给错配的布局叠了一层桥。

## 3. 决定

**撤回 `DSH_HOME` 覆盖，连同 `e957399` 的 anchor 补丁一起删除。** 具体：

1. `Dockerfile` 不再 `ENV DSH_HOME`；entrypoint 与 `dsh` 包装脚本只注入 `HOME=/data/dsh/home`，
   `DSH_HOME` 保持未设置，由 DSH 按官方默认派生 `$HOME/.dsh`。
2. 数据根因此变成 `/data/dsh/home/.dsh`——**仍在持久卷内**，持久化结论不变。
3. 删除 `npm_config_store_dir=/data/dsh/pnpm-store`：pnpm 11 不读该变量（三组对照实测，
   store 始终落在 `$XDG_DATA_HOME/pnpm/store`），卷根那个空目录是死配置遗迹。
4. 删除 `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` 的显式设置：`HOME` 已让它们
   落在 `~/.cache`、`~/.config`、`~/.local/share`，同样在卷内；显式写只是多一处要同步。
   `XDG_RUNTIME_DIR` 保留显式（`/tmp/runtime-node`，它必须**不**在卷上）。
   `CHROME_USER_DATA_DIR` 保留：它不是 DSH/pnpm/XDG 的默认值，是 ADR 0001 的部署选择。
5. `prepare_dsh_volume` 改为建 `$root/home/.dsh`，`repair_ownership` 与 `profile_manifest`
   指向 `$HOME/.dsh/profiles`。
6. `--self-test` 与构建期 `--dump-config` 都改为断言**默认布局**：`HOME=<fixture>` 且不设
   `DSH_HOME` 时，`$HOME/.dsh/profiles` 必须出现且是真实目录（不是软链）。这样若将来有人
   重新引入 `DSH_HOME` 覆盖把数据根挪走，构建期就会失败。

## 4. 考虑过的替代方案

| 方案 | 为什么没选 |
| --- | --- |
| 保留覆盖 + anchor 软链（`e957399` 现状） | 有效但治标：布局仍是"默认之外"的，任何按 `~/.dsh` 硬编码的插件都要逐个打补丁；软链本身是数据卷里的额外结构。 |
| 把 `DSH_HOME` 做成可配置（`${DSH_HOME:-…}`） | 救不了本问题。`DSH_HOME` 的价值就是"指定数据根"，只要它的值≠`$HOME/.dsh`，那类假设就必然错。可配置只是把错配转移到"操作者填什么"，默认仍错。 |
| 改插件让它读 `DSH_HOME` | 根治方向，但要改第三方包、还要跟着上游版本走；镜像侧无权限。可另起 issue 向插件上游提。 |
| 把 `HOME` 也改成 `/data/dsh`，让 `$HOME/.dsh` = `/data/dsh/.dsh` | 仍然不等于 `/data/dsh` 的数据根；同时把 `~/.agents`（现有技能目录）、`~/.config/gh`（登录态）全部换位置，影响面更大。 |

## 5. 后果

正面：

- 数据根与 DSH 官方默认、插件生态假设三者一致，`~/.dsh/profiles` 无需任何软链；
- anchor 补丁整体作废，entrypoint 少一段启动期逻辑与一个失败模式；
- 三条死配置（`npm_config_store_dir` + 三个 `XDG_*`）清掉，缓存位置回到官方默认；
- pnpm store 落到 `$HOME/.local/share/pnpm/store`——旧卷里 492M 的真实 store 本来就在这里，
  钉死的 `/data/dsh/pnpm-store` 只有 4K 空目录。

负面/代价：

- **旧数据卷不自动迁移**：旧卷的 `/data/dsh/profiles`、`.credentials.yaml`、`sessions/` 不会
  被新布局读取，表现为"全新部署"。本项目明确不为此提供迁移脚本，出问题按重新部署处理。
- 卷内结构下移一层：DSH 数据在 `/data/dsh/home/.dsh/`，与 `chrome-profile/`、`home/` 下的
  其它缓存并列。"备份 `data/`"仍覆盖全部，但"重置 DSH 状态"变成删 `home/.dsh/`。
- 插件按 `DSH_HOME` 派生的状态目录（如 `dsh-im-connect/`、`our-free-model/`）落点随之下移，
  语义不变。
- 这是**逆着上游**的结构性分叉：`upstream/dev` 一直写着 `DSH_HOME=/data/dsh`，每次同步都会在
  `Dockerfile`、`docker-entrypoint.sh`、`dsh` 三个文件上冲突，冲突处理表已记入
  `deploy/SYNC-UPSTREAM.md`。

## 6. 回归要点

- 构建期：`docker-entrypoint.sh --self-test` 的默认布局断言、`--dump-config` 后
  `test -d "$HOME/.dsh/profiles"`、`repair_ownership` fixture 的新路径。
- 不要"顺手"把 `DSH_HOME` 加回去（包括 compose `environment:` 与 `.env`）：一旦设了且不等于
  `$HOME/.dsh`，skill-missing 横幅就会复现。
- 上游若改变默认布局（`dsh-home-paths` 的 `DSH_HOME_DIR_NAME`），本 ADR 的推导前提要重算。
