# CI 说明

`.github/workflows/release.yml` 只能通过 `git push` 更新 ——
GitHub 的 Git API 对该路径写入要求 token 带 **`workflow` scope**，
否则一律返回 404（不会给 403，刻意模糊化）。

当前用于同步的 token 只有 `gist` / `read:org` / `repo`，因此本文件
停在最后一次 `git push` 的版本。更新方式：

    gh auth refresh -h github.com -s workflow

然后重新执行同步即可。Windows 打包产物（`npm run dist`）不依赖 CI，
本地可直接跑。
