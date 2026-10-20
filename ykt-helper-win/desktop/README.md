# Electron 发行包体

此目录是 Electron Forge 的完整应用目录。`npm run prepare:desktop` 会把桌面端和 CLI 的构建结果同步到这里；这些生成目录不提交到 Git。

- `npm run make:portable`：生成 ZIP Portable 包。

便携包始终包含 `portable.flag`，应用数据写入可执行文件旁的 `ykt-helper-data`。应用根目录提供 `ykt.cmd`，用于连接正在运行的桌面端 CLI 服务。正式发布时只上传便携 ZIP 和 `update-win32-x64.json` 更新清单。
