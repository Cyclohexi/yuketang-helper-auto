# 雨课堂助手项目知识库

最后维护：2026-10-21。项目记忆入口为 [AGENTS.md](AGENTS.md)，每次同步调用[项目维护清单](ykt-helper-win/docs/project-maintenance.md)。本文记录当前事实和长期决定；已发布版本的历史说明保持原样。

## 项目与发布状态

- 当前仓库：Cyclohexi/yuketang-helper-auto；main 跟踪 origin/main。上游为 ZaytsevZY/yuketang-helper-auto。
- 本机仓库：`E:\MyProject\yuketang-helper-auto`；核心工程为 `ykt-helper-win`。
- 最新公开版本为 v2.2.0，第二个 Release，功能为自动更新。发行物只包含 Windows x64 ZIP 便携包和 `update-win32-x64.json`。
- 当前源码中的课堂 AI 预分析、提醒调整、固定 C 盘数据目录、启动器修复及维护流程属于未发布变更；源码同步不代表新 Release。公开标签与附件不可覆盖，发布必须使用更高版本号。
- 便携表示解压即可运行、无需安装；本次用户明确要求数据固定在系统用户目录，不再把“配置随 EXE 移动”作为现行规则。

## 代码架构

技术栈为 Electron、Vue 3、TypeScript、Vite、npm workspaces；开发环境要求 Node.js 24.x 和 npm 11.x。不要在文档中把未使用的 Element Plus、Pinia 或未支持的雨课堂服务器写成现有能力。

```text
yuketang-helper-auto/
├── AGENTS.md                         # 项目记忆与后续会话规则
├── README.md                         # GitHub 用户首页
├── changelog.md                      # 未发布增量与历史版本记录
├── PROJECT_KNOWLEDGE_BASE.md          # 当前架构、数据与维护事实
├── 启动雨课堂助手.bat                # ASCII + CRLF 的一键启动入口
├── static/                           # Logo 与三个实机截图
├── user-data-backups/                # 本机历史数据备份，禁止删除、不进 Git
└── ykt-helper-win/
    ├── apps/desktop/                 # main、preload、Vue renderer
    ├── apps/cli/                     # JSON CLI 与独立作业模式
    ├── packages/contracts/           # DTO、事件、Facade、IPC 契约
    ├── packages/backend/             # 业务服务、AI、课堂与作业工作流
    ├── packages/routing/             # standard、pro、changjiang 平台适配
    ├── packages/storage/             # SQLite、加密凭据、资源缓存
    ├── desktop/                      # Forge 打包入口及生成的应用体
    ├── scripts/                      # 启动、构建、版本、发布、同步检查
    ├── tests/                        # 契约测试与网络 fixture
    └── docs/                         # 专项文档、ADR、发布说明和维护清单
```

主进程持有 Backend Runtime 和系统能力；preload 暴露受限 IPC；renderer 不直接引用 Backend、Routing、Storage、Electron 或 Node。远程网页使用独立 WebContentsView，不启用 Node。

`desktop/main`、`preload`、`renderer`、`cli` 是构建复制件，不是另一套源码。`dist`、`node_modules`、下载缓存和 `desktop/out` 不进 Git。

## 数据目录与迁移

当前源码在 Windows 统一使用 `%LOCALAPPDATA%\YuketangHelper`，本机通常为 `C:\Users\wjx20\AppData\Local\YuketangHelper`。BAT、npm start 与新构建 EXE 共用；`userData` 和 `sessionData` 均指向这里。

- `storage/yuketang.sqlite`：设置、用户记录、脱敏日志及课件元数据。
- `storage/credentials.json`：Electron safeStorage 加密的凭据；密钥不写入普通设置、日志、fixture 或 Git。
- `Partitions` 等：专用 `persist:yuketang-browser` 会话及 Cookie。
- `Cache`、`Code Cache`、`GPUCache` 等：Chromium 缓存。
- `storage/resource-cache`：课件二进制资源缓存，默认总上限 256 MiB、单项 32 MiB。
- `updates`：更新下载、任务及结果；程序替换不涉及这个固定数据根目录。

`storage-profile.ts` 是唯一路径与首次迁移实现。`--portable` 和 `portable.flag` 保留便携升级识别作用，不再改变数据位置。`--debug-profile` 使用同级 `YuketangHelper-debug`，不导入正式配置，也不会先创建正式目录而阻断迁移。

固定目录不存在时，检查 EXE 旁旧 `ykt-helper-data`、Roaming 下的“雨课堂助手”、`@ykt/desktop`、`ykt-helper-win` 等旧位置。优先已有设置或用户记录的 profile，同等级选择数据库较新的 profile。只复制一个完整目录，不合并数据库；迁移期间使用独立状态标记，全部复制成功才启用新路径，原目录保留。复制中断会保留标记并阻止下次把半成品当作正式数据；此时从旧目录恢复，不能直接删除标记后使用半成品。固定目录已存在且无迁移标记时不再导入。迁移前关闭旧程序，避免会话或数据库仍在写入。

已发布 v2.2.0 及更早二进制不会因更新源码而改变数据位置。跨 Windows 用户或电脑复制数据时，系统加密的凭据可能无法解密，需要重新登录或填写密钥。Git 回退不恢复数据库；数据库结构变化须先备份并验证降级兼容。

## 功能与文档约定

首页只有“自动刷课”和“课堂自动化”两个核心板块。自动刷课包含进度定位、视频静音与倍速、讨论互动、单元流转；课件翻阅与课后 AI 作业按实际状态标记测试中。课堂自动化包含自动答题、课件下载、当前课堂课件及题目预览、提醒、自动进入、OCR、翻译和 AI 提问。

预览范围以实际获取内容为准；自动答题需要模型配置和对应开关。内置服务器为 standard、pro、changjiang；作业及考试列表与详情当前仅支持荷塘雨课堂。不要把未来计划写成已发布功能。

课堂 AI 预分析与提交分离：renderer 的 `classroom-preanalysis.ts` 在题目加载后处理 locked/available 题目，最多两路调用模型，按课堂、环境、模型及题目内容缓存；发布状态不作为缓存键。`AssistantPanel.vue` 在老师发布后按提交延迟及托管开关使用缓存答案，尚在分析时等待结果，提交前复核状态与截止时间。切换课堂、环境、模型或关闭自动生成时丢弃旧结果；关闭托管、课堂结束后取消后续自动提交。已发出的模型调用不会被强制撤销。

课堂提醒固定为九类：新题开始、考试与题组、新课件、课堂开始、课堂结束、AI 分析开始、AI 分析完成、作答成功、作答失败。分析按新增题目批次汇总总数/成功/失败；作答结果以平台提交响应为准。保留总开关、独立事件开关和系统通知/弹窗/声音设置，SQLite 读取时迁移旧 Agent 对应偏好。详见[课堂 AI 说明](ykt-helper-win/docs/classroom-ai.md)。

README 下载与三步上手前置；首次配置截图折叠，刷课截图位于刷课板块，课堂截图位于课堂自动化板块之后。最新公开版本展开，旧版本折叠，未发布变更单独标记。

保留对 ZaytsevZY/yuketang-helper-auto、Niuwh/yuketang-jiaoben、hotwords123/yuketang-helper、OneTHU 的致谢与学术研究免责声明。

## 启动、验证与同步

根 BAT 使用短的 ASCII + CRLF 入口调用带 UTF-8 BOM 的 `scripts/start-desktop.ps1`，避免 Windows cmd 的编码与路径解析问题。优先源码；缺少构建或源码更新时自动构建；没有本地 Electron 时才回退已有便携 EXE。`-CheckOnly` 只检查，`-Rebuild` 强制构建。维护时保留 `.gitattributes` 的 Windows 换行规则。

默认通过独立隐藏 PowerShell 进程启动，原 BAT 命令窗口退出，桌面程序保持正常显示。后台输出重定向到 `%LOCALAPPDATA%\YuketangHelperLauncher\logs`，失败时显示错误弹窗；`-ShowConsole` 保留前台日志，`-CheckOnly` 保留 JSON 输出。不要把桌面程序本身设为隐藏，也不要隐藏用户整个 Windows Terminal 的其他标签。

在核心工程目录执行：

```powershell
npm run sync:check
npm test
npm run build
npm start
```

同步必须核对代码及受影响文档，按维护清单提交，再核对本地与远程提交一致。不要为每次小修改重写全部文档；用户可见变化追加 changelog，数据、架构与规则变化更新本知识库，专项行为更新相应文档。新增开发文档不应被整体忽略。

测试覆盖范围随源码增长，不在知识库中硬编码测试数量。全量 lint 已知在历史 `course-brush-controller.ts` 存在问题；每次报告实际检查结果，修改文件必须通过检查，不为消除既有问题改动无关逻辑。

## 自动更新与发布

发行程序包含 portable.flag。启动 15 秒后及每 6 小时检查 GitHub 最新正式版；手动确认下载和重启，不自动降级。更新校验大小与 SHA-256、检查压缩路径、预解压、探测写入权限，替换范围限定程序文件；复制失败时尝试回滚。固定用户数据以及旧程序旁的数据目录均不属于替换集合。

发布流程详见 `docs/auto-update.md`。先验收固定提交并统一工作区与锁文件版本，运行测试与构建，再生成便携包和清单、创建标签、上传草稿并校验，最后按用户发布指令公开。公开附件不可覆盖。维护脚本为 `set-release-version.mjs`、`prepare-update-release.mjs`、`upload-release.mjs`。

## 清理边界

可清理已核验的 Electron 下载缓存、ZIP 中间产物与无用依赖。保留源码、测试、锁文件、文档、图片、Git 历史、最新本地可运行程序、正式附件及全部用户数据和备份。删除前核对绝对路径在项目范围内；不能用 `git clean -fdx` 清理仓库。历史数据备份与旧配置目录不是待删缓存。
