# 自动更新与发布

本项目正式发行 Windows x64 ZIP 便携版，通过同目录的 `portable.flag` 启用更新。开发模式及没有便携标记的程序不检查更新。

当前源码将 `userData` 与 `sessionData` 统一固定为 `%LOCALAPPDATA%\YuketangHelper`，与程序更新目录分开；BAT、源码和 EXE 使用同一处。首次启动且固定目录不存在时复制旧 profile，保留旧目录，后续不再覆盖固定数据。`--debug-profile` 使用独立的 `YuketangHelper-debug`，不导入真实配置；`--portable` 不再切换数据位置。已发布 v2.2.0 的数据行为保持不变，本调整尚待下次正式发布。

应用就绪 15 秒后检查一次，此后每 6 小时检查一次。顶部版本按钮支持手动检查、下载和重启更新。检查只读取本仓库 GitHub Releases 的最新正式版；不会下载预发布版，也不会降级。下载和重启都由用户点击触发，正在上课时不会自动关闭应用。

## 便携版

读取同一 Release 中的 `update-win32-x64.json`，流式下载其中指定的 ZIP，校验文件大小和 SHA-256。清单只允许指向本仓库同版本的附件。

下载完成后，隐藏的 PowerShell 辅助进程重新校验 ZIP、拒绝路径穿越和携带用户数据的压缩包、预先解压并探测安装目录写入权限。此时主应用仍在运行，安装失败不会提前关闭程序。

用户确认重启后，辅助进程等待应用退出，只替换 Electron 程序目录及文件，不触及固定用户数据目录，并继续保留程序旁旧的 `ykt-helper-data`、个人文件及其他目录。被替换的程序文件先备份；普通复制失败时回滚并重新启动旧版本。更新结果写入用户数据下的 `updates/result.json`，下次启动可读取。突然断电、磁盘损坏或回滚本身失败仍需人工从 `.ykt-update-backup-*` 恢复，不能保证这些情况下自动恢复。

重命名为“雨课堂助手.exe”的便携版也保留原可执行文件名。只读目录、受管控禁止 PowerShell 的设备会提示失败，可重新检查后重试或手动更新。需要能够访问 GitHub API 及附件下载域名；不引入第三方下载镜像。

## 发布步骤

README 更新记录、根 changelog、GitHub Release 及应用更新说明只展示本次计划进入便携版的重要用户功能、明显修复和必要升级提示。不得直接汇总全部 Git 提交；源码 BAT、个人调试、清理、项目记忆、同步检查等维护变化不作为公开条目，详见[项目维护规则](project-maintenance.md)。本次计划 v2.2.1 仅展示题目预分析及相关提醒、AI 请求失败自动重试、截止未提交自动强制补交三个功能与独立开关。先完成校验并同步源码，用户测试通过后才发布。技术细节与开发记录保留在开发文档中；历史公开发布说明保持不变。

先按[项目维护清单](project-maintenance.md)同步代码与文档，再在 `ykt-helper-win` 下运行。所有工作区包和锁文件必须采用同一个、递增的稳定版本号。v2.2.0 已公开，不能重新发布覆盖；待用户确认测试通过后，下一版使用已指定的 2.2.1：

```powershell
npm run version:set -- 2.2.1
```

构建、检查并生成便携发行包：

```powershell
npm ci --include=dev --include=optional
npm run sync:check
npm test
npm run lint
npm run prepare:desktop
npm run make:portable -w yuketang-helper-desktop-package
npm run release:prepare
```

最后一步将当前版本的以下两个文件统一放入 `desktop/out/release/v<版本>/`，并生成 ZIP 的大小和 SHA-256 校验信息：

- `YuketangHelper-v<版本>-Windows-x64-Portable.zip`
- `update-win32-x64.json`

确认代码及版本号后提交，并将对应的 `v<版本>` 标签推送到远程。为每次发布编写 `docs/release-notes-v<版本>.md`，并同步 README 的“版本更新记录”。`npm run release:upload` 使用 `GH_TOKEN` / `GITHUB_TOKEN` 或 Git 凭据，将两个文件上传到 **Release 草稿**。上传后核对 GitHub 返回的 SHA-256 和大小，只有两个附件均通过校验才可发布；上传中断时可重试并复用已校验的附件。

从已验收的固定提交构建，确认编译产物与该提交一致。Git 回退只恢复源码，不恢复数据库；测试和旧版复现使用独立 profile 或数据备份，不用旧数据库假设覆盖新数据。

默认创建草稿；明确执行 `npm run release:upload -- --publish` 时，完整上传并校验后才公开发行。脚本不会删除或覆盖已有公开版本，且拒绝发布含其他附件的草稿。

旧的 2.1.0 及更早程序没有更新代码，需要用户手动替换一次含此功能的便携版；此后可以在应用内更新。旧版 Release 缺少更新清单时，不会被当作有效的便携版更新。

## 验证范围

契约测试覆盖版本比较、同源附件约束、重复操作、网络错误、下载校验、便携更新状态和界面交互。Windows 测试实际执行 PowerShell，验证中文与引号路径、改名程序、用户数据保留、复制失败回滚和危险压缩路径。真实的“旧便携版 → GitHub 新版”升级仍应在发布草稿前，使用隔离测试目录和测试发行源验证。

参考：[Electron 更新说明](https://www.electronjs.org/docs/latest/tutorial/updates)。
