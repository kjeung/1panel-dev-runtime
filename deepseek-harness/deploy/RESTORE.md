# 环境还原清单（配置层）

> 本文件**不含任何密钥**，只记录"有哪些配置、值从哪来"。实际密钥值在
> `RESTORE.local.md`（同目录，已被 `.gitignore` 忽略，绝不入库）。
> 重建前先读本文件；照着敲时再去 `RESTORE.local.md` 抄值。

- 采集时间：2026-11-08
- 采集时的仓库提交：`0834ee3`（`main` 分支）
- 最近一次实测复核：2026-11-08（`main` @ `4e7a076`），§5.1 / §5.3 / §5.4 / §8 据实修正
- **重要**：自 ADR 0003 起镜像不再覆盖 `DSH_HOME`，数据根是 `$HOME/.dsh`；自 ADR 0004 起
  `HOME` 收敛到 `/home/node`（node 用户的 passwd home），因此数据根是 `/home/node/.dsh`。
  旧版部署的 `/data/dsh` 卷不会被读取，旧卷不会自动迁移。

---

## 1. 镜像与构建参数

| 项 | 值 | 来源 |
|---|---|---|
| 镜像名（本地构建） | `deepseek-harness:plain` | `compose.yml` 的 `image:` 默认 |
| 镜像名（CI 发布） | `kjeung/deepseek-harness-plain` | `.github/workflows/deepseek-harness-release.yml` |
| `DSH_VERSION` | `0.2.2-rc.1` | Dockerfile `ARG` / compose / workflow 三处一致 |
| `DSH_MARKET_VERSION` | `1.73.9` | 同上 |
| 运行时实际 DSH 版本 | `0.2.2-rc.1` | `dsh -V` |

> 版本随上游 `upstream/dev` 走到 `0.2.2-rc.1`（合并于 2026-11-08）。dshmarket 的 peer 范围
> 写的是 `^0.2.1-rc.1`，DSH 的兼容性检查以 `includePrerelease: true` 求值，因此 `0.2.2-rc.1`
> 仍判为兼容；再往上跨 minor 时要重新复核（`SYNC-UPSTREAM.md` §5）。

## 2. 部署入口配置（`deploy/.env`）

`deploy/.env` 不在版本库里，重建时必须重建。最小内容：

```dotenv
DSH_ACCESS_HOST=dsh.dh.ci
```

| 变量 | 本环境的值 | 说明 |
|---|---|---|
| `DSH_ACCESS_HOST` | `dsh.dh.ci` | **必填**。必须与外部反代的 Host 规则完全一致，否则 `/api` 403 白屏 |
| `DSH_HTTP_PORT` | 默认 `8080` | 只绑宿主机回环 |
| `DSH_DATA_DIR` | 默认 `./data/home` | 宿主机上的持久卷目录（挂到 `/home/node`，即整个 node 用户 home） |
| `WORKSPACE_DIR` | 默认 `./workspace` | Agent 工作区 |
| `DSH_DESKTOP_ENABLED` | 默认 `1` | Chromium 桌面 + Browser Use |
| `DSH_MARKET_ENABLED` | 默认 `1` | 插件市场入口 |
| `CHROME_USER_DATA_DIR` | 默认 `/home/node/chrome-profile` | 浏览器登录态 |

外部反代（Traefik file provider）模板见 `deploy/traefik/dynamic.yml`，其中
`Host(...)` 要改成上面 `DSH_ACCESS_HOST` 的值。

## 3. 登录账号

| 账号 | 用途 | 凭据存放位置 | 恢复方式 |
|---|---|---|---|
| DeepSeek 账号（device 登录） | DSH 自身登录 | `$DSH_HOME/.credentials.yaml` → `records.deepseek-account-platform/default` | Web UI 重新登录（issuer `https://platform.deepseek.com`） |
| GitHub `kjeung` | `gh` / git 推送 | `$HOME/.config/gh/hosts.yml` | `gh auth login`，再 `gh auth setup-git` |
| 微信 / 钉钉 / Telegram | IM 渠道（本次不在范围内） | `.credentials.yaml` 的 `im_connect_*` 键 | 见 `dsh-im-connect` 插件设置页 |

`gh` 的具体命令（`HOME` 必须带上，否则会写进容器可写层）：

```bash
docker compose exec -u node deepseek-harness gh auth login
docker compose exec -u node deepseek-harness gh auth setup-git
```

## 4. 已配置的模型接口

全部走 `@deepseek-ai/dsh-llm-pi-ai`（openai-completions 协议），配置在
**`$DSH_HOME/profiles/web/cordis.patch.yml`**。重建时把这份文件原样复制回去即可。

| provider | baseURL | API Key 环境变量名 | Key 前缀（仅用于核对） | 模型 id |
|---|---|---|---|---|
| `anytokens-cc` | `https://anytokens.cc/v1` | `ANYTOKENS_CC_API_KEY` | `sk-6e9f6…` | `gpt-6-sol`、`gpt-image-2` |
| `monk-party` | `https://monk.party/v1` | `MONK_PARTY_API_KEY` | `sk-monk-…` | `monk`、`monk-fast`、`monk-coding`、`monk-free` |
| `agnes` | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` | `sk-QmFH1…` | `agnes-video-2.5-flash`、`agnes-3.0-flash`、`agnes-image-2.1-flash`、`agnes-image-2.0-flash`、`agnes-2.5-flash`、`agnes-image-2.5-flash` |

**默认模型**：按本文件采集时记录是 `provider: trae` / `model: deepseek-v4.1-flash` /
`reasoningEffort: high`。

> **实测差异（2026-11-08 复核）**：当前卷的 `agent-default-model` 实际是
> `provider: monk-party` / `model: monk-fast`，且 `--dump-config` 里 `trae` 出现 **0 次** ——
> 说明 `trae` 并未注册。原因是它由 `dsh-our-free-model` 在**运行时**注册（bundle 行为
> `config: {}`，不走 `cordis.patch.yml`），而本卷 `.credentials.yaml` 里**没有**下面的
> `TRAE_ACCOUNT_*` 等账号凭据，插件注册不出可用 provider。
>
> 所以：`trae` 这条只适用于"凭据齐全"的还原；只恢复插件、不恢复账号凭据时，
> 默认模型会停在 `monk-party/monk-fast`（这是可用的）。别把 `cordis.patch.yml` 里的
> `provider: trae` 当成"写了就生效"——**默认模型能否工作取决于免费模型插件 + 账号凭据**。

另有账号型 provider（`our-free-model` 的免费额度通道），凭据同样在 `.credentials.yaml`：

```
QODER_ACCOUNT_F60CBA8D   TRAE_ACCOUNT_939C4AC5   CLINE_ACCOUNT_C820FDE0
LOOMY_ACCOUNT_D0451164   RACCOON_ACCOUNT_9A00D74F  MINIMAX_ACCOUNT_F3199E92
ZCODE_ACCOUNT_892C9E4D   GEMINI_ACCOUNT_7D579A96
```

免费模型插件自身设置（`$DSH_HOME/our-free-model/settings.json`）的关键项：
`hideFreeModels: true`、`probeIntervalMinutes: 15`、`aggregate.enabled: true`、
`tokenSaver.enabled: true`、推荐组合 `combo:recommended-free`
（`deepseek-v4.1-flash-free` → `glm-5.3-flash-free` → `space-bunny-free`，strategy `fallback`）。

## 5. 完整插件列表

### 5.1 Profile 依赖（装在数据卷，`$DSH_HOME/profiles/web/package.json`）

| 包 | 版本 | 说明 |
|---|---|---|
| `@michengai/dsh-archive-manager` | `1.2.4` | 归档管理 |
| `@michengai/dsh-im-connect` | `1.0.25` | IM 渠道接入（微信/钉钉/Telegram） |
| `dsh-better-sidebar` | `0.28.2` | 侧边栏增强 |
| `dsh-cost-meter` | `1.9.57` | 用量/成本统计 |
| `dsh-mattpocock-skills-deck` | `1.9.0-beta.33` | 技能套件管理（ADR 0003 的起因） |
| `dsh-our-free-model` | `github:Ebony-Vinyl/dsh-our-free-model#v2.8.3` | 免费模型聚合，注册 `trae` 等 provider。**不在 npm 上**：该包 `private: true`，npm 最高只有 `2.1.0`，必须装 GitHub 源 |
| `dsh-plugin` | `2.3.3` | 插件管理器本体 |
| `dshmarket` | `1.73.10` | 社区插件市场（profile 副本优先于镜像副本） |

> `@1panel/dsh-ctrl-enter-send` **不在此表**：它是本仓自带的镜像插件，由
> `web-ctrl-enter-send.cordis.patch.yml` 按绝对路径挂载，**不需要也不应该装进 profile**。
> 详见 §5.2。

重建时一次性装回（8 个，不含 ctrl-enter-send）：

```bash
docker compose exec -u node deepseek-harness \
  dsh plugin --profile web add \
    dshmarket@1.73.10 dsh-plugin@2.3.3 dsh-better-sidebar@0.28.2 dsh-cost-meter@1.9.57 \
    dsh-mattpocock-skills-deck@1.9.0-beta.33 \
    github:Ebony-Vinyl/dsh-our-free-model#v2.8.3 \
    @michengai/dsh-archive-manager@1.2.4 @michengai/dsh-im-connect@1.0.25
```

> **注意**：`dsh plugin add <目录>`（绝对/相对路径，不带 `link:`）时，pnpm 会**读该目录的
> `package.json`**：目录和清单都存在 → 依赖键记成包的**真实名**，一切正常；**目录不存在** →
> pnpm 读不到清单，退化成按目录名记键（`<目录名>: link:<path>`，版本 `0.0.0`）。后者会让
> bundle 行报 `availability: missing`，插件静默不加载，而 `package.json` 看起来"装好了"。
> 这也是为什么 ctrl-enter-send 不该走 profile 安装——它的路径是镜像内的，一旦 checkout 或镜像
> 变动就退化成这个静默失败态。装任何本地目录插件后都请核对：
> 1. `dsh plugin --profile web list` 里的依赖键是包的真实名；
> 2. `test -e node_modules/<真实包名>` 解析得通（不是悬空软链）。

### 5.2 镜像内置（不占数据卷，overlay 以绝对路径挂载）

| 包 | 挂载方式 |
|---|---|
| `dshmarket` | `web-market.cordis.patch.yml`，`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dshmarket/lib/index.js` |
| `@1panel/dsh-browser-desktop` | `web-desktop.cordis.patch.yml`，`/opt/deepseek-harness/plugins/dsh-browser-desktop/index.js` |
| `@1panel/dsh-ctrl-enter-send` | `web-ctrl-enter-send.cordis.patch.yml`，`/opt/deepseek-harness/plugins/dsh-ctrl-enter-send/index.js` |
| `@deepseek-ai/dsh-browser-use` | 同上（desktop overlay），attach 到 `127.0.0.1:9222` |
| `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | 同上（desktop overlay） |

镜像插件一律由 entrypoint 以 `--patch` 追加 overlay 加载，**不占数据卷、不需要 profile 依赖**。
Cordis loader 接受绝对路径，client roster 会从该 module URL 向上找到最近的 `package.json`，
读其中的 `dsh.client` 声明——所以 profile 里连软链都不需要。

两条"避免行重复"的规则（entrypoint 已实现）：

- profile 若已声明 `dshmarket` 依赖，**不再**追加 market overlay；
- profile 若已声明 `@1panel/dsh-ctrl-enter-send` 依赖，**不再**追加 ctrl-enter-send overlay。

本环境 profile 声明了 `dshmarket`（故生效的是 profile 副本），**没有**声明 ctrl-enter-send
（故生效的是镜像 overlay）。两种来源同时存在会组装出**同 id 的两行**，已在实测中确认。

### 5.3 profile 启用顺序（`dsh.profile.bundles`）

目标顺序（新建设备按 §5.1 装完 8 个插件后应有的样子）：

```
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@deepseek-ai/dsh-experimental-agent-team-profile
@deepseek-ai/dsh-experimental-plugin-market-bundle
@deepseek-ai/dsh-experimental-auto-review
@deepseek-ai/dsh-experimental-forge-bundle
dshmarket  dsh-plugin  dsh-better-sidebar  dsh-cost-meter
dsh-mattpocock-skills-deck  @michengai/dsh-archive-manager  @michengai/dsh-im-connect
dsh-our-free-model
```

即 **14 个**：6 个官方 bundle + 8 个 profile 插件。`@1panel/dsh-ctrl-enter-send`
**不在** bundle 列表里——它由镜像 overlay 加载（§5.2），不经过 profile。

> 与旧版本记录的差异，均以实测为准：
> 1. 实际启用的是 `@deepseek-ai/dsh-experimental-forge-bundle`，**不是**
>    `@deepseek-ai/dsh-experimental-tool-worktree`（后者的行已被 forge 覆盖）。
> 2. profile 插件按**安装先后**排序；`dsh-better-sidebar` 装在 `dsh-mattpocock-skills-deck` 之前。
> 3. `dsh-our-free-model` 最后安装，排在末尾；`ctrl-enter-send` 若曾被装进 profile，
>    会在这里多出一行 —— 那是旧布局的残留，重建后不应出现。

### 5.4 技能套件（`$HOME/.agents/skills`）

由 `dsh-mattpocock-skills-deck` 提供的用户级技能目录。**先区分两件事**：

- **deck 自带 27 个**，随插件装在
  `profiles/web/node_modules/dsh-mattpocock-skills-deck/bundled-skills/`，装完插件即可用，
  无需额外命令。实测清单：`ask-matt code-review codebase-design diagnosing-bugs
  domain-modeling grill-me grill-with-docs grilling handoff implement implement-spec
  improve-codebase-architecture pr prototype research retro setup-matt-pocock-skills
  tdd teach to-questionnaire to-spec to-tickets triage wait-what wayfinder wizard
  writing-for-agents`
- **用户级 38 个**装在 `$HOME/.agents/skills`，需要下面这条命令单独装。它**不是**重建的
  必需项：不装只会少若干技能，界面横幅是否出现取决于 deck 自身的 bundled-skills 是否解析到，
  后者由 §8 第 2 条（不要设 `DSH_HOME`）保证。

```bash
docker compose exec -u node deepseek-harness \
  npx -y skills@latest add mattpocock/skills -a cline -g --copy -y
```

> 旧版本记录把这两件事混写成"38 个技能由 deck 提供"，并据此把界面横幅写进 §7 自检，
> 与实际不符：deck 只自带 27 个。若 `npx skills` 因网络或注册表权限失败，跳过即可，
> 不影响插件恢复。

---

## 6. 重建步骤（照抄）

```bash
# 1. 取代码（dev 分支，含 ADR 0003/0004 的布局）
git clone -b dev https://github.com/kjeung/1panel-dev-runtime.git
cd 1panel-dev-runtime/deepseek-harness/deploy

# 2. 重建 .env（值见本文件第 2 节）
cp .env.example .env
$EDITOR .env            # 至少填 DSH_ACCESS_HOST=dsh.dh.ci

# 3. 构建并起容器
docker compose up -d --build

# 4. 确认布局（ADR 0003 的 $HOME/.dsh + ADR 0004 的 HOME=/home/node）
docker compose exec deepseek-harness ls /home/node/.dsh/profiles

# 5. 登录 + 装插件 + 装技能
#    见第 3、5 节命令；然后从 RESTORE.local.md 抄 API key 填进 Web UI 或 .credentials.yaml

# 6. 恢复模型接口配置
docker compose cp ./cordis.patch.yml deepseek-harness:/home/node/.dsh/profiles/web/cordis.patch.yml
docker compose restart deepseek-harness
```

`cordis.patch.yml` 的完整内容备份见 `RESTORE.local.md` 附录（或旧卷
`$DSH_HOME/profiles/web/cordis.patch.yml`）。

## 7. 重建后自检

| 检查 | 期望 |
|---|---|
| `docker compose ps` | `(healthy)` |
| `ls /home/node/.dsh/profiles` | 有 `web` |
| `getent passwd node` | home 是 `/home/node`（ADR 0004；镜像必须改 passwd，否则 ssh 系会落到容器层的 `/home/node` 以外的路径） |
| `dsh plugin --profile web list` | **8** 个依赖（不含 ctrl-enter-send） |
| `dsh --profile web --dump-config` | `exit 0`、stderr 为空；`# == ` 段含 §5.3 列出的 14 个 bundle 名（同一 bundle 的 patch 层会出现多次，故段数多于 14） |
| `--dump-config` 里 `ctrl-enter-send` | **恰好 1 行**，`name` 是 `file:///opt/deepseek-harness/plugins/dsh-ctrl-enter-send/index.js`（来自镜像 overlay，不是 profile 依赖） |
| `docker compose exec deepseek-harness dsh --version` | `0.2.2-rc.1` |
| 模型下拉 | 能看到 `gpt-6-sol`、`monk-*`、`agnes-*`；`trae` 系列**仅当**免费模型插件的账号凭据齐全时才出现 |
| 默认模型 | 凭据齐全时 `trae / deepseek-v4.1-flash / high`；只恢复插件时 `monk-party / monk-fast`（见 §4 实测差异） |

## 8. 已知的坑（重建时最容易踩）

1. **数据根变了**：ADR 0003 之后是 `$HOME/.dsh`，ADR 0004 之后是 `/home/node/.dsh`。旧卷的
   `/data/dsh/profiles` 不会被读取，表现等同全新部署（ADR 0004 又把挂载点从 `/data/dsh`
   挪到 `/home/node`，旧卷整体不会被读取）。
2. **不要设 `DSH_HOME`**：一旦设成不等于 `$HOME/.dsh` 的值，技能缺失横幅必然复现。
3. **`dsh` 命令不用再带 `HOME`**：ADR 0004 之后 `HOME=/home/node` 写进了镜像 ENV，
   `docker compose exec` 直接继承；`dsh` 包装脚本也会再钉一次。不要再写
   `-e HOME=/data/dsh/home`，那是已退役的旧路径。
4. **不要把镜像插件装进 profile**：`@1panel/dsh-ctrl-enter-send` 由镜像 overlay 加载
   （§5.2）。若又装进 profile，会组装出**同 id 的两行**（实测确认），且 profile 那份
   `link:` 写死绝对路径，checkout 一动就悬空、插件静默失效。自检见 §7。
5. **API key 优先级**：`.credentials.yaml` > 进程环境 > `$cwd/.env` > `$DSH_HOME/.env`。
   UI 里存过就覆盖环境变量，重建时别两处都填了又疑惑为什么没生效。
6. **pnpm store** 走官方默认 `$HOME/.local/share/pnpm/store`（即 `/home/node/.local/share/pnpm/store`）；
   `/data/dsh/pnpm-store` 已废弃，不要再建。
7. **`pnpm-workspace.yaml` 的 `allowBuilds` 占位符会让安装全部失败**（最容易踩、最难查）。
   `dsh plugin add` 装完依赖后，pnpm 若发现未放行的构建脚本，会写回
   `allowBuilds: { <pkg>: "set this to true or false" }` 并以**退出码 1 结束**。
   `dsh` 只在 pnpm 退出码为 0 时才执行 bundle 注册（`reconcile`），所以结果是：
   **依赖装进了 `package.json`，但 `dsh.profile.bundles` 一条都没加**，插件"装了却没生效"。
   更麻烦的是，下一次 `dsh plugin add` 的 reconcile 只处理**新增**依赖，已存在的会被跳过，
   于是再跑一遍也不会补上 —— 看起来"命令成功了，插件还是没出现"。
   处理：
   - 先看 `.plugin-manager/logs/operation-*/pnpm.log` 尾部与 `pnpm-workspace.yaml`；
   - 把 `<pkg>: "set this to true or false"` 改成 `true` 或 `false`（本次遇到的是
     `protobufjs`，它的 `postinstall` 只打印版本兼容警告，`dist/` 已预编译在 tarball 里，
     写 `false` 是安全的）；
   - 重跑安装，**并显式核对** `dsh.profile.bundles`；
   - 若 bundles 仍缺，用插件管理器的 `set_bundle` 逐个启用（会立刻写回 manifest 并 live 生效，
     不需要重启）。
