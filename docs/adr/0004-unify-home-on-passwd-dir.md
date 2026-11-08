# ADR 0004：家目录收敛到 passwd home（`/home/node`），`$HOME` 不再与之分离

- 状态：已采纳
- 日期：2026-11-09
- 相关代码：`deepseek-harness/Dockerfile`、`deepseek-harness/docker-entrypoint.sh`、`deepseek-harness/dsh`
- 相关文档：[`deepseek-harness/deploy/README.md`](../../deepseek-harness/deploy/README.md) §3.2、§4、§10.7；
  [ADR 0003](0003-default-dsh-home-layout.md)（本 ADR 修订它）

## 1. 背景

`node` 账号的 home 有两处来源，从镜像诞生起就分叉：

- `/etc/passwd` 里是 `/home/node`（基础镜像 `node:24-bookworm-slim` 建的账号，`node:x:1000:1000::/home/node`）。镜像自带 `/home/node/.bashrc` 等 skeleton 文件；容器内 `getent passwd node` 的家目录就是它。
- 运行时 `$HOME=/data/dsh/home`，由 entrypoint 与 `dsh` 包装脚本强制注入。它是持久卷 `/data/dsh` 里被特意挪进去的一层（见 ADR 0003 的动机）。

POSIX 世界里这两处家目录**各自被不同的工具消费**，而且不互通：

| 消费者 | 解析方式 | 落点 |
| --- | --- | --- |
| shell 的 `~` 展开、`node` 的 `os.homedir()`（DSH、git、gh、npm/pnpm） | 读环境变量 `$HOME` | `/data/dsh/home` |
| `ssh`、`ssh-keygen`、`ssh-copy-id`、`scp`、`sftp` | 只认 `getpwuid()`，**完全不看 `$HOME`** | `/home/node` |

OpenSSH 侧的实证：

- `HOME=/tmp/x ssh-keygen -t ed25519` 仍提示保存为 `/home/node/.ssh/id_ed25519`，且改 `HOME` 无效；
- `HOME=/tmp/x ssh -G -o UserKnownHostsFile='%d/kh' x` 展开为 `/home/node/kh`（`%d` 即 passwd home）；
- `ssh -F /tmp/x/.ssh/config'` / `ssh -G` 证明 ssh 连 `~/.ssh/config` 也从 passwd home 读，`$HOME/.ssh/config` 被完全忽略（**未验证 ssh-keys 暂不管**）；
- 于是 `ssh-keygen` 写的是 `/home/node/.ssh`、而 `ssh-copy-id` 看的是 `$HOME/.ssh`，两边对不上：`No identities found`（`DEFAULT_PUB_ID_FILE` 与 `mktemp -d ~/.ssh/…` 都用 `$HOME`，而被 ssh 调用的 ssh 走 passwd）。

## 2. 问题

1. **工具间的数据割裂**：`~/.ssh` 在两边各一份；
   - ssh 系写进的是**容器可写层**的 `/home/node`，**不是**持久卷——容器重建即丢，密钥与 `known_hosts` 回不来；
   - `ssh-copy-id` 看的是卷内的 `$HOME/.ssh`，里面被建得永远空。生成密钥后 `ssh-copy-id` 直接报 `ERROR: No identities found`。
2. **ADR 0003 第 1 节的表述与事实不符**：“把 `HOME` 挪进同一个卷，好让 pnpm store、git/ssh 配置、gh 登录态、XDG 缓存跟着持久化”。**只有 ssh 那一项不成立**：`git`/`gh`/pnpm 确实跟随 `$HOME`，OpenSSH 从不跟随 `$HOME`。
3. 每个在 Agent 里开 shell 的人都会重复踩坑，并且这个问题藏在构建期自检看不到的地方——entrypoint 的自检只断言了 `$HOME/.dsh` 的目录形状，从不检查 `$HOME` 与 passwd home 是否一致。

## 3. 决定

把 `$HOME` 与 passwd home 收敛到同一个目录：**`/home/node`**。

为此做的改动（本分支各文件）：

1. `Dockerfile`：镜像 `ENV HOME=/home/node`；`install -d -m 0700 -o node -g node /home/node`；删除 `/data/dsh` 与 `/data/dsh/home` 的创建。镜像 ENV 首次出现 `HOME`（此前按 [image-verify.md](../../deepseek-harness/deploy/notes/image-verify.md) 的记录是"无 `HOME`"）。
2. `docker-entrypoint.sh`：`home_root=/home/node`；`prepare_dsh_volume` 只建家目录、`.dsh`、`.ssh`；`repair_ownership` 增加 `$home_root/.ssh`（并顺带 `.config`）；`CHROME_USER_DATA_DIR` 默认改为 `$home_root/chrome-profile`。
3. 新增一条**构建期自检断言**：入口脚本的 `--self-test` 读 `getent passwd node`，要求 `home_root` 与之相等，不等即构建失败。这是这条不一致线第一次被测试钉死的地方。
4. `dsh` 包装脚本的 `HOME` 从 `/data/dsh/home` 改为 `/home/node`；注释说明两个 home 收敛。
5. `docker-compose.yml`：持久卷挂载点从 `/data/dsh` 改为 `/home/node`（宿主机默认目录从 `./data/dsh` 改为 `./data/home`）。`/data/dsh` 退役，`chrome-profile` 现在是 `$HOME/chrome-profile`。
6. 纵深检查：自检还断言 `$HOME/.ssh` 的 mode 为 `0700`，避免历史上出现过的一类"权限不合规"的 SSH 问
题（`ssh-keygen` 要求 `.ssh` 目录在 home 之外不能被别人读写）。

## 4. 考虑过的替代方案

| 方案 | 为什么没选 |
| --- | --- |
| 把 `node` 的 passwd home 用 `usermod -d /data/dsh/home node` 改过去 | 只对 ssh 家族有效，且 `/data/dsh` 仍在容器层外侧占一个卷；两个 home 目录名从未分开，而且要在构建期跑 `usermod` 来"反向对齐"，方向别扭（问题本质是 `HOME` 被挪走了） |
| 把 `/home/node/.ssh` 软链到 `/data/dsh/home/.ssh` | 软链在**容器层**，重建后消失；且 ssh-copy-id 的 `mktemp -d ~/.ssh` 仍先用 `$HOME` 查密钥，找到才会再用 ssh 自己的 passwd 路径——两段路仍分开。治标 |
| 在卷的 `/data/dsh/home` 与 `/home/node` 之间加绑定挂载 | 一次容器一个挂载点很合适，但卷内的 `home/` 还要嵌一层，且需要宿主侧 bind mount 嵌套；且"ssh 读 passwd home"这条事实不会因为外层挂载改变，只有换根才真正消除 |
| 让用户每次用 `HOME=/home/node ssh-copy-id …` 绕 | 只修一次操作，且会把 key 写进容器层，容器重建丢失（即用户在第 1 题里问的"持久性"）。文档替换不是根治 |

## 5. 后果

正面：

- ssh 系工具与 Node/DSH/git/gh/pnpm **落在同一目录**，不存在两个 home；
- `~/.ssh` 的 `0600` 文件顺体系自动回卷内，密钥不再随容器重建丢失；
- `docker compose exec <新的容器> bash` 默认继承镜像的 `ENV HOME=/home/node`，老 playbook 里"exec 必须补 `-e HOME=…`"的不便消失；
- entrypoint 自检多一条 passwd 一致性断言，防止未来的构建悄悄改回分裂。

负面/代价：

- **旧部署不自动迁移**：旧卷的 `/data/dsh` 整体不会被新布局读取，`/home/node` 是新卷位置，表现为"全新部署"。
- 第 2 节指出的 ADR 0003 历史问题也随之显性化：ssh 的"跟随 $HOME"论断随现已失效。
- `/workspace` 以外的卷从 `/data/dsh` 变成 `/home/node` 挂载点后，`docker volume inspect` 与宿主机备份脚本、以及写死 `/data/dsh` 的 ops 运维脚本（如 §10.7 的 stat 检查式）需要同步改。
- `DSH_DATA_DIR` 默认宿主机目录从 `./data/dsh` 改为 `./data/home`，名称与容器路径 `/home/node` 对应，
  不再与 `chrome-profile` 混在卷根下一层（更易备份）。
- `/home/node` 被挂载后，基础镜像自带的 `.bashrc` / `.profile` 等 skeleton 文件不可见
  （挂载遮住镜像层同路径）。node 用户的 shell 若依赖这些文件，需把它们预先放进宿主机目录。
  本项目不依赖它们（入口脚本与 wrapper 均为显式注入 `HOME`）。
- 镜像 `ENV` 首次出现 `HOME`（此前 image-verify.md 的实测结论是"无 `HOME`"），为后续
  镜像作者留下一个可见面：任何新加的 root 场景脚本可能不再 fallback 到 `/root`。
  面对这个问题，结论是任何向 `/home/node` 写文件的 root 进程必须在收尾时 chown（入口的
  `repair_ownership` 已覆盖 `.dsh`/`.ssh`/`.npm`/`.local/share/pnpm`/`chrome-profile`）。
- entrypoint 一次启动即把 `/home/node` 本身 chmod 成 `0700` 并 chown 为 node，宿主机也得以按
  uid 1000 直接备份/编辑这些文件。
- 旧构建层遗留的 `/home/node/.cache`、`/home/node/.bashrc` 等属于基础镜像的 skeleton 文件，会被新卷覆盖（卷里只有入口脚本预建的 `.dsh`、`.ssh`），但仅此而已。

## 6. 回归要点

- 构建期：`docker-entrypoint.sh --self-test` 新增 passwd 一致性断言；`HOME=/tmp/dsh-config-check-home` 的 `--dump-config` 检查不变。
- 不要再把 `HOME` 改成 passwd home 以外的路径；不要把 `/data/dsh`（或任意私有命名空间）重新作为第二份卷根加回来。
- 若以后确实需要把 DSH 数据与整机 home 分卷，正确做法是给 DSH 显式定
  `DSH_HOME`（并走 ADR 0003 的那条检查），**不要**再靠改 `$HOME` 解决。

## 7. 迁移说明（本次不迁移）

本 ADR 有意不提供数据迁移：用户在 2026-11-09 已明确"后续会直接重建容器"，且旧卷的
`/data/dsh` 在新布局下**不会被读取**。旧卷顶层 `profiles/`、`.credentials.yaml`、
sessions、`chrome-profile/` 在新布局下全部失效，表现等同全新部署；需要保留的数据
请在重建前按 `deepseek-harness/deploy/RESTORE.md` 手动拷入新卷。

