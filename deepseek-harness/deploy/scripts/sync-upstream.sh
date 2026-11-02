#!/usr/bin/env bash
# Sync the plain-HTTP fork (this repository) with upstream 1Panel-dev/runtime.
#
#   upstream/dev ──rebase──▶ plain-http
#                              ├── deepseek-harness/          (image source)
#                              └── deepseek-harness/deploy/   (compose, docs, exported diff)
#
# Usage (from the repository root):
#   deepseek-harness/deploy/scripts/sync-upstream.sh              # fetch + rebase + tests + export
#   deepseek-harness/deploy/scripts/sync-upstream.sh --push       # also force-with-lease push
#   deepseek-harness/deploy/scripts/sync-upstream.sh --skip-tests
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PATCHES="$ROOT/deepseek-harness/deploy/patches"
PUSH=0
TESTS=1

die() { printf 'sync-upstream: %s\n' "$*" >&2; exit 1; }
say() { printf '\n== %s ==\n' "$*"; }

while (($#)); do
  case "$1" in
    --push) PUSH=1; shift ;;
    --skip-tests) TESTS=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

[[ -d "$ROOT/.git" ]] || die "$ROOT 不是 git 仓库"
[[ -d "$ROOT/.git/rebase-merge" || -d "$ROOT/.git/rebase-apply" ]] && \
  die "有未完成的 rebase，请先解决冲突并 git rebase --continue"

cd "$ROOT"

# A shallow clone has no merge-base with upstream, so "is upstream an ancestor?"
# cannot be answered and a rebase would try to replay an already-applied commit.
if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  die "当前是浅克隆（shallow clone），无法安全 rebase 上游。请先 git fetch --unshallow（或改用完整 clone）。"
fi

say "拉取 upstream 与 origin"
if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream https://github.com/1Panel-dev/runtime.git
fi
git fetch --quiet upstream dev
git fetch --quiet origin
UPSTREAM_SHA="$(git rev-parse upstream/dev)"
BASE_SHORT="$(git rev-parse --short "$UPSTREAM_SHA")"
echo "upstream/dev = $UPSTREAM_SHA"

[[ "$(git rev-parse --abbrev-ref HEAD)" == "plain-http" ]] || git switch plain-http

if git merge-base --is-ancestor "$UPSTREAM_SHA" HEAD; then
  say "plain-http 已包含 upstream/dev，无需 rebase"
else
  say "rebase plain-http 到 upstream/dev"
  if ! git rebase "$UPSTREAM_SHA"; then
    cat >&2 <<'EOF'

rebase 冲突，请手动解决后重新运行本脚本：
  1) git status                         # 看冲突文件
  2) 解决冲突（改动集中在 deepseek-harness/ 与 .github/workflows/）
     注意：Caddyfile 在本分支已删除；上游若修改它，确认删除仍然成立。
  3) git add <files> && git rebase --continue
  4) 重新执行 deepseek-harness/deploy/scripts/sync-upstream.sh
  更完整的原则见 deepseek-harness/deploy/SYNC-UPSTREAM.md §4
EOF
    exit 1
  fi
fi

WF="$ROOT/.github/workflows/deepseek-harness-release.yml"
WORKFLOW_DSH="$(grep -m1 'default: "' "$WF" | sed 's/.*default: "//; s/".*//')"
DOCKERFILE_DSH="$(sed -n 's/^ARG DSH_VERSION=//p' "$ROOT/deepseek-harness/Dockerfile" | head -1)"
COMPOSE_DSH="$(sed -n 's/.*DSH_VERSION:-\{0,1\}\([0-9][^} ]*\).*/\1/p' "$ROOT/deepseek-harness/deploy/docker-compose.yml" | head -1)"
if [[ -n "$WORKFLOW_DSH" && -n "$DOCKERFILE_DSH" && "$WORKFLOW_DSH" != "$DOCKERFILE_DSH" ]]; then
  printf '\n⚠ dsh 版本不一致：workflow 默认=%s，Dockerfile ARG=%s\n' "$WORKFLOW_DSH" "$DOCKERFILE_DSH"
fi
if [[ -n "$WORKFLOW_DSH" && -n "$COMPOSE_DSH" && "$WORKFLOW_DSH" != "$COMPOSE_DSH" ]]; then
  printf '⚠ dsh 版本不一致：workflow 默认=%s，compose 默认=%s\n' "$WORKFLOW_DSH" "$COMPOSE_DSH"
  printf '  升级 dsh 版本前请看 deepseek-harness/deploy/SYNC-UPSTREAM.md §5 的清单。\n'
fi

if ((TESTS)); then
  say "自检"
  node --check deepseek-harness/node-proxy.mjs
  node deepseek-harness/node-proxy.mjs --self-test
  bash deepseek-harness/docker-entrypoint.sh --self-test
  if [[ -d /usr/local/lib/node_modules/@deepseek-ai/dsh ]]; then
    say "代理测试套件（14 个用例）"
    DSH_PROXY_BIN="$ROOT/deepseek-harness/node-proxy.mjs" \
      node --test --test-name-pattern='proxy|healthz|SIGTERM' \
        deepseek-harness/test-runtime.mjs
  else
    echo "跳过代理测试：本机没有安装 @deepseek-ai/dsh（镜像构建期会跑完整测试）"
  fi
fi

say "导出镜像源码改动（相对 upstream/dev）"
mkdir -p "$PATCHES"
rm -f "$PATCHES"/*.diff "$PATCHES"/*.patch "$PATCHES"/*.bundle
git diff "upstream/dev..HEAD" -- deepseek-harness .dockerignore \
  ':(exclude)deepseek-harness/deploy' > "$PATCHES/image-source.diff"
git bundle create "$PATCHES/plain-http.bundle" "upstream/dev..HEAD" >/dev/null
printf '%s\n' "$UPSTREAM_SHA" > "$PATCHES/BASE"
printf 'baseline -> %s（%s）\n' "$PATCHES/BASE" "$UPSTREAM_SHA"
ls -1 "$PATCHES"

if ((PUSH)); then
  say "推送到 origin/plain-http"
  git push --force-with-lease origin plain-http
fi

say "完成"
printf 'upstream/dev : %s\n' "$UPSTREAM_SHA"
printf 'plain-http   : %s\n' "$(git rev-parse --short HEAD)"
printf 'patches/BASE : %s\n' "$(cat "$PATCHES/BASE")"
printf '\n部署无需额外同步：deploy 目录就在本分支，直接 git pull && cd deepseek-harness/deploy && docker compose build\n'
