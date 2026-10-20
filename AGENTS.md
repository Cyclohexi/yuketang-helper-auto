# 项目记忆与维护入口

本文件随 Git 同步，是本项目后续会话的持久维护规则。开始工作先读取本文件；涉及架构、数据或发布时再读取 `PROJECT_KNOWLEDGE_BASE.md`。当前用户指令优先于历史记录。

## 每次同步都要调用

用户要求“同步项目”“同步 GitHub”“提交/推送”时，先读取 `ykt-helper-win/docs/project-maintenance.md`，在核心工程执行 `npm run sync:check`。按改动范围同步代码、测试和受影响文档，再一起提交。推送后核对本地与远程提交一致；如有用户未提交修改，先保留，不能覆盖。

- 用户可见功能与使用变化：`README.md`、`changelog.md`。
- 启动、依赖、构建、调试变化：`ykt-helper-win/README.md`。
- 数据路径、架构、维护约定变化：`PROJECT_KNOWLEDGE_BASE.md` 与相关开发文档。
- 打包与自动更新变化：`ykt-helper-win/docs/auto-update.md`、`ykt-helper-win/desktop/README.md`。
- CLI、作业或字体行为变化：对应的 `docs/cli-assignments.md`、`assignment-detail.md`、`font-policy.md` 等专项文档。
- 正式发布：对应版本发布说明、更新日志、README 版本记录、工作区版本号及锁文件。

## 已确定的项目规则

1. Windows 数据固定在 `%LOCALAPPDATA%\YuketangHelper`，BAT、源码和 EXE 共用。`--portable` 与 `portable.flag` 只保留发行及升级识别作用，不改变数据路径。`--debug-profile` 使用独立的 `YuketangHelper-debug`，不导入真实配置。
2. 首次迁移复制旧数据，保留原目录；不得删除用户数据、历史备份、凭据、登录会话。数据不进入 Git。清理仅限已核验的生成目录和无用依赖。
3. 只发行 Windows x64 ZIP 便携程序与 `update-win32-x64.json`，不恢复安装包流程。便携指无需安装，配置固定在系统用户目录。
4. 同步源码不等于发布。已公开的 Release、标签和附件保持不变；新发布使用递增版本号及新标签。
5. 一项功能一个提交或独立分支；新建分支使用 `codex/` 前缀。需要原目录不受影响时使用独立 worktree。Git 回退不恢复数据库，涉及数据结构变更须先备份并检查兼容性。
6. 核心逻辑变化运行 `npm test` 与 `npm run build`，修改文件通过 lint。全量 lint 如遇既有问题，报告实际结果，不为此改动无关功能。启动脚本必须实际验证。
7. README 保持“自动刷课”“课堂自动化”两个核心板块，保留上游致谢及学术研究免责声明。未发布的功能明确标记，不能写成已发布能力。

项目事实见知识库；完整同步清单与命令见 `ykt-helper-win/docs/project-maintenance.md`。不在本文件记录密钥、个人数据或每次测试的流水账。
