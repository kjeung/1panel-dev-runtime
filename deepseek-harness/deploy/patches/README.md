# 改造补丁（相对上游 `1Panel-dev/runtime`）

本仓库就是改造后的源码（`deepseek-harness/`，部署文件在同级的 `deepseek-harness/deploy/`），**日常部署不需要打补丁**。
这里的文件用于审计与复现：在干净的上游 checkout 上重现我们的镜像源码改动。

| 文件 | 说明 |
|---|---|
| `image-source.diff` | `git diff upstream/dev..HEAD -- deepseek-harness .dockerignore`，对上游的直接改动 |
| `main.bundle` | `main` 分支相对 `upstream/dev` 的 thin bundle（离线取完整分支） |
| `BASE` | 上述两者所基于的上游 `dev` 提交（完整 sha） |

## 在上游原版上复现

```bash
git clone --branch dev --filter=blob:none --sparse \
  https://github.com/1Panel-dev/runtime.git runtime
git -C runtime sparse-checkout set deepseek-harness
git -C runtime checkout "$(cat deepseek-harness/deploy/patches/BASE)"
git -C runtime apply "$OLDPWD/deepseek-harness/deploy/patches/image-source.diff"
```

## 用 bundle 取整支分支

```bash
git clone --branch dev --filter=blob:none --sparse \
  https://github.com/1Panel-dev/runtime.git runtime
git -C runtime sparse-checkout set deepseek-harness
git -C runtime checkout "$(cat deepseek-harness/deploy/patches/BASE)"
git -C runtime fetch "$OLDPWD/deepseek-harness/deploy/patches/main.bundle" main:main
git -C runtime checkout main
```

## 重新生成

```bash
deepseek-harness/deploy/scripts/sync-upstream.sh          # 同步上游后自动重新导出
```

## 上游更新

见 [../SYNC-UPSTREAM.md](../SYNC-UPSTREAM.md)。
