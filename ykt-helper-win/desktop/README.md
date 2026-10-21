# Electron 发行包体

此目录是 Electron Forge 的完整应用目录。`npm run prepare:desktop` 会把桌面端和 CLI 的构建结果同步到这里；这些生成目录不提交到 Git。

- `npm run make:portable`：生成 ZIP Portable 包。

便携包始终包含 `portable.flag`。v2.2.1 起使用固定目录 `%LOCALAPPDATA%\YuketangHelper` 保存配置、会话与缓存，源码和 EXE 共用，标记不再决定数据路径。首次迁移复制旧目录并保留原件；`--debug-profile` 使用独立的 `YuketangHelper-debug`。v2.2.0 及更早包保持原有行为。

应用根目录提供 `ykt.cmd`，用于连接正在运行的桌面端 CLI 服务。正式发布时只上传便携 ZIP 和 `update-win32-x64.json` 更新清单；本地构建不会覆盖 GitHub 已公开的附件。

2026-10-22 修订的 v2.2.1 便携包包含下载稳定性修复：4 MiB 分段、自动重连与跨启动续传，最终仍校验完整包的大小和 SHA-256。原 v2.2.1 及更早包的旧更新器不会因附件替换而自动修复；已安装原 v2.2.1 的用户须手动下载替换一次，旧版下载失败时同样手动升级并保留原有数据。详细策略见 [自动更新说明](../docs/auto-update.md)。

同一修订包还修复安装交接：通过系统独立启动安装器，核对任务就绪后才退出，替换完成后正常显示新版窗口，并保留持久安装日志。正式附件位于 `out/release/v2.2.1/`；旧附件备份位于 `out/release-backups/v2.2.1-original-20261022/`。临时测试包已清理，用户数据和验证报告保留。
