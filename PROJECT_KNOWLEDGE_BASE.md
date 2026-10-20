# 雨课堂助手 (Yuketang Helper AI) - 核心知识库与 AI 协作交接文档

> 📅 **文档生成日期**：2026-10-20  
> 📌 **文档定位**：全量沉淀本项目的所有已知信息、系统架构、Git 规则、功能逻辑、改动历史与后续 AI / 开发者协作规范。请任何后续参与本项目的 AI 或开发者在执行任何改动前**完整通读此文档**。

---

## 目录 (Table of Contents)

1. [项目基本概况](#1-项目基本概况)
2. [代码架构与文件目录结构](#2-代码架构与文件目录结构)
3. [运行时数据与配置读取机制](#3-运行时数据与配置读取机制)
4. [核心功能全景解析](#4-核心功能全景解析)
5. [已完成的历史改动记录](#5-已完成的历史改动记录)
6. [Git 规范与 GitHub 发布流水线](#6-git-规范与-github-发布流水线)
7. [后续 AI 协同开发黄金铁律 (Guardrails)](#7-后续-ai-协同开发黄金铁律-guardrails)

---

## 1. 项目基本概况

### 1.1 项目背景与溯源
- **上游原作者仓库**：[ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto)  
  *原仓库提供了基于 Electron 的桌面客户端底座、雨课堂 WebSocket 旁路报文监听、课堂监控与作业解析的基础架构。*
- **当前项目仓库**：[Cyclohexi/yuketang-helper-auto](https://github.com/Cyclohexi/yuketang-helper-auto)  
  *本项目在原版基础上进行了全面二次开发与能力强化，自研了**课堂实时自动答题**、**多模态视觉 Vision AI 搜题**与**全自动智能刷课流水线**（智能自动定位、自动静音二倍速、自动讨论跟帖等）。*
- **当前发行版本**：`v2.2.0`（第二个 Release，首次功能更新：自动更新；2026-10-20）
- **核心发布物**：`YuketangHelper-v2.2.0-Windows-x64-Portable.zip`，以及客户端读取的 `update-win32-x64.json`（**仅发布绿色便携版及更新清单**）。

### 1.2 本地工作环境
- **本地代码绝对路径**：`E:\MyProject\yuketang-helper-auto`
- **主要工程目录**：`E:\MyProject\yuketang-helper-auto\ykt-helper-win`
- **桌面快捷启动批处理**：`g:\DeskBox\wjx20\学习\启动雨课堂助手.bat`
- **仓库根目录启动批处理**：`E:\MyProject\yuketang-helper-auto\启动雨课堂助手.bat`
- **开发技术栈**：
  - 运行时框架：Electron (Node.js + Chromium)
  - 渲染层框架：Vue 3 + Vite + Element Plus + Pinia
  - 开发语言：TypeScript / JavaScript
  - 测试框架：Vitest (39 套契约测试套件，368+ 测试用例全绿通过)
  - 本地代理环境：`http://127.0.0.1:10808`（用于 Git 推送与拉取 GitHub 资源）

---

## 2. 代码架构与文件目录结构

本项目采用现代 Monorepo 多包架构，核心工程位于 `ykt-helper-win/`。

### 2.1 根目录拓扑
```text
E:\MyProject\yuketang-helper-auto/
├── .vscode/                     # VSCode 工作区配置
├── static/                      # 静态资源与文档插图
│   ├── logo.png                 # 项目 Logo
│   └── desktop/                 # README 专用的三张最新实机截图
│       ├── login_and_api.png    # 1. 扫码登录与 API 配置界面
│       ├── auto_brush.png       # 2. 自动刷课控制台界面
│       └── in_class_ai.png      # 3. 课堂 AI 作答与全量题目查看界面
├── user-data-backups/           # 用户本地数据与配置的历史备份目录
├── ykt-helper-win/              # 桌面应用核心工程（详见下方）
├── .gitignore                   # Git 忽略配置
├── 启动雨课堂助手.bat           # 根目录一键启动桌面端的 Windows 批处理
├── changelog.md                 # 历史更新日志
├── LICENSE                      # MIT 开源协议
├── README.md                    # 面向用户的 GitHub 首页说明文档
└── PROJECT_KNOWLEDGE_BASE.md    # [本文档] 项目完整交接知识库
```

### 2.2 核心工程目录拓扑 (`ykt-helper-win/`)
```text
ykt-helper-win/
├── apps/
│   ├── cli/                     # 雨课堂终端命令行工具 (ykt-cli)
│   └── desktop/                 # Electron 桌面端核心源码
│       ├── main/                # 主进程源码 (TypeScript)
│       │   ├── course-brush-controller.ts  # 🌟 刷课核心控制器（状态机、目录解析与脚本注入）
│       │   ├── browser-controller.ts       # 浏览器窗口控制与网络拦截
│       │   ├── index.ts                    # Electron 主进程入口与生命周期管理
│       │   ├── cli-handler.ts              # CLI 消息转发与处理
│       │   ├── app-update-controller.ts    # 应用升级控制器（便携模式升级检查与下载）
│       │   ├── portable-update.ts          # 绿色便携模式更新检测
│       │   └── update-release.ts           # Release 版本拉取与升级
│       ├── preload/             # Electron Preload 脚本（上下文隔离与安全的 IPC 桥接）
│       └── renderer/            # Vue 3 渲染端界面源码
│           ├── src/
│           │   ├── components/  # 助手面板组件、设置弹窗、刷课悬浮条、AppUpdateControl 等
│           │   ├── views/       # 各页面视图
│           │   └── main.ts      # 渲染进程入口
├── packages/                    # Monorepo 共享包
│   ├── backend/                 # 雨课堂 API、WebSocket 旁路监听与 AI 通信引擎
│   ├── contracts/               # 契约定义（IPC 通信协议、数据类型接口定义）
│   ├── routing/                 # 多校园环境路由（普通版、荷塘雨课堂、长江雨课堂、黄河雨课堂等）
│   └── storage/                 # 本地缓存与数据存储逻辑
├── tests/                       # 自动化测试目录
│   └── contract/                # 39 套契约测试套件（严格覆盖刷课注入脚本、AI 自动化等）
├── scripts/                     # 自动化构建与便携打包脚本
│   ├── package-win-portable.mjs # 绿色版 ZIP 打包脚本
│   └── release-uploader.mjs     # GitHub Release 自动化上传脚本
├── package.json                 # 依赖声明与 npm scripts
├── vitest.config.ts             # 自动化测试配置
└── coding_plan.md               # 历史编码计划备忘
```

### 2.3 历史已清理的冗余模块
在早期版本演进中，为保持代码库纯粹与轻量，已主动清理了以下历史遗留文件（后续请勿随意加回）：
- ❌ `ykt-helper/`：旧版的 Chrome 浏览器扩展目录（已完全被 Electron 桌面端替代，避免维护双套代码）。
- ❌ `release/`：2025 年旧构建产物目录。
- ❌ `README_origin.md` / `todolist.md`：上游废弃的早期文档。
- ❌ `static/desktop/` 下的旧版截图（`main.png`, `set_class.png`, `set_model.png`, `in_class.png`），均已替换为清晰统一的最新三张截图。

---

## 3. 运行时数据与配置读取机制

这是用户此前非常关注的核心疑问，也是后续排查“配置读取”、“登录失效”问题的关键：

### 3.1 绿色便携版 (Portable) 数据沙箱机制
- **判定条件**：
  在应用可执行文件同级目录下存在 `portable.flag` 文件，或启动时携带 `--portable` 参数。
- **存储路径**：
  Electron 的 `userData` 路径会被重定向到可执行文件旁的 **`ykt-helper-data/`** 目录。
- **沙箱内包含的内容**：
  - 雨课堂网页登录的 Cookie、Session、LocalStorage；
  - 用户的模型配置（API Key、Base URL、分工模型配置）；
  - 本地 SQLite / Lowdb 数据库文件；
  - 课件缓存、题目抓取缓存与日志文件。
- **优势与原则**：
  - **绝不写入 Windows 注册表**；
  - **绝不向系统盘 `%APPDATA%` 产生垃圾文件**；
  - 用户只需将解压文件夹移动到任意电脑或移动硬盘，直接双击运行，登录状态即可完美继承。

### 3.2 开发模式与历史配置回退机制
- 若以源码开发方式（`npm start`）启动且未指定 `--portable`，Electron 会默认读取 Windows 系统盘的 `%APPDATA%\ykt-helper-win`。
- **为什么曾经“一下载解压就有配置”？**  
   开发模式可能读取系统中的历史配置。便携版通过 `portable.flag` 将数据定位到程序旁的 `ykt-helper-data`，使配置与程序目录保持一致。

---

## 4. 核心功能全景解析

### 4.1 功能一：课堂实时自动答题 + 原版功能全量保留
本项目完整保留并兼容了 [ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto) 的所有核心功能：

1. **随堂习题实时捕获与 AI 自动作答提交**：
   - 底层监听 WebSocket 课堂交互数据包，当老师发布单选题、多选题、填空题或主观题时毫秒级捕获；
   - 自动调用配置的 LLM 大模型进行题意分析与解答，自动勾选/填入并触发提交；
   - **多模态 Vision AI 视觉搜题**：针对雨课堂动态加密字体（WOFF/OTF 加密混淆导致文字复制为乱码），直接利用视窗截图，将题目图像送入视觉大模型（如 GPT-4o, Qwen-VL 等）看图解答；
   - **限时超时补交 / 强制补交**：在允许补交的课堂中，支持对未作答或已错过的题目发起一键强制补交。
2. **全量题目实时查看**：
   - 课堂左侧侧边栏直观呈现**当前课件中全部老师已展示与未展示的题目**，避免漏题。
3. **课堂与习题多维度强提醒**：
   - 发布新题目、考试开始、课程上下课等节点触发弹窗、音效与系统横幅通知；
   - **自动进入课堂**：检测到当前正在上课自动代入，防止考勤旷课。
4. **课件 (PPT) 高清管理与导出**：
   - 特殊内存/磁盘缓存加速，解决校园网幻灯片翻页卡顿痛点；
   - 支持批量导出为高清 PDF 文档或打包下载图片；支持已结课历史课程的回看与下载。
5. **课件 OCR、翻译与 AI 提问**：
   - 支持对幻灯片一键提取文字、多语言翻译及 AI 知识点答疑。
6. **开发者与 CLI 支持**：
   - 完整模拟 Chrome 环境，提供网络实验室与报文捕获；提供 `ykt-cli` 终端命令行工具。

### 4.2 功能二：全自动课程刷课流水线 (Auto-Brush Engine)
专为课外线上课程打造的无人值守全自动化流水线（以功能为导向）：

1. **🧭 自动定位进度 (Auto Navigation)**：
   - 采用零缓存动态递归算法，进入课程后自动分析全章节目录树；
   - **智能跳过进度 100% 的已完成小节**，毫秒级精确定位并自动跳转至**首个未完成的学习单元**（视频、课件或讨论区），实现智能断点续学。
2. **🔇 视频：自动二倍速 + 静音 + 自动流转**：
   - **自动静音**：视频加载后立即静音，后台挂机不打扰用户电脑操作；
   - **底层倍速防抖锁定**：雨课堂前端脚本存在定期重置播放倍速至 1.0x 的检测机制。本助手在 Electron 注入层重写并代理了 `HTMLMediaElement.prototype.playbackRate` 属性与事件，**直接在底层死锁为 2.0x 倍速（可自定义）**，阻止任何网页脚本篡改；
   - **自动切集**：视频触发 `ended` 播放结束事件后，全自动平滑跳转至下一单元。
3. **💬 自动讨论 (Auto Discussion)**：
   - 自动检测讨论区单元，**自动抓取当前课堂其他同班同学的高质量发言并复用发布**，杜绝千篇一律或无意义字符；
   - 深度兼容 Quill / Contenteditable 等现代富文本编辑器与原生文本域，拟人化键入并触发回车发送；
   - 内置异步加载等待与重试机制，避免因网络慢导致的页面误跳过。
4. **🧪 更多功能测试中**：
   - **课后作业自动答题**（联网 AI 作业作答测试中）；
   - **课件 PPT 智能模拟阅读翻页**（按安全时延逐页阅读翻动测试中）。

---

## 5. 已完成的历史改动记录

### 2026-10-20：v2.2.0 自动更新

- 新增启动 15 秒后及每 6 小时检查更新、顶部版本按钮、应用内下载及确认重启更新。
- 便携更新包含大小与 SHA-256 校验、预解压、危险路径检查、保留本地数据和普通复制失败回滚。
- 所有工作区版本统一为 2.2.0；42 套测试通过，389 项通过、1 项跳过。
- 新增 `version:set`、`release:prepare`、`release:upload` 命令。正式发行只上传便携 ZIP 和更新清单；带 `--publish` 参数时，完整上传并校验后发布。
- README 新增“版本更新记录”，本次为第二个 Release、首次功能更新。发布说明位于 `ykt-helper-win/docs/release-notes-v2.2.0.md`。
- v2.1.0 用户需要先手动升级到 v2.2.0 一次，此后使用应用内更新。
- 全量 lint 在未修改的 `course-brush-controller.ts` 中仍有 27 项既有问题；本次新增及修改代码检查通过。

在本次会话周期内，完成的重大演进与修复包括：

1. **刷课控制器逻辑修复与单测修复**：
   - 修复了 `course-brush-controller.ts` 中 `buildDetectAndJumpToFirstIncompleteScript` 缺失 `try` 块的语法错误；
   - 修复了 `buildHandleContentExtraTaskScript` 中的正则表达式转义问题；
   - 验证了所有 39 套契约测试（368 个测试用例全部绿灯通过）。
2. **统一便携发行格式**：
   - 官方发行物统一为 Windows x64 ZIP 便携包及自动更新清单。
   - 所有打包入口始终生成 `portable.flag`，程序旁的 `ykt-helper-data` 保存用户配置。
   - 项目首页、开发文档及更新流程统一围绕便携版维护。
3. **代码库与工作目录物理迁移**：
   - 将整个代码库平滑迁移至独立工程盘：`E:\MyProject\yuketang-helper-auto`；
   - 更新并重构了桌面启动批处理 `启动雨课堂助手.bat` 与用户的桌面启动脚本 `g:\DeskBox\wjx20\学习\启动雨课堂助手.bat`。
4. **GitHub 页面与 README.md 重塑**：
   - 动态徽标全部修正至个人仓库 `Cyclohexi/yuketang-helper-auto`；
   - 依据用户要求进行了多次结构精简：删除了冗长的大模型参数表格，删除了 Mermaid 思维导图；
   - 突出“功能一：原版功能全量保留与课堂自动答题”及“功能二：自动刷课助手（自动定位、自动静音二倍速、自动讨论）”；
   - 将界面预览更新为用户实机提供的 3 张高质量标注截图。
5. **关于 Fork 独立仓库的解惑与指导**：
   - 详细向用户解释了 GitHub 页面上 `28 commits ahead of and 12 commits behind` 的含义（二次开发正常领先与滞后）；
   - 明确指导用户切勿随意点击网页上的 `Sync fork`（以免引发代码冲突覆盖二次开发逻辑）；
   - 提供了通过 GitHub 官方 `Settings -> Danger Zone -> Leave fork network` 或 Support Virtual Agent 将 Fork 项目一键转化为独立顶级仓库的标准指引。

---

## 6. Git 规范与 GitHub 发布流水线

### 6.1 Git 仓库与远程配置
- **当前跟踪分支**：`main` 跟踪 `origin/main`
- **远程仓库地址**：`https://github.com/Cyclohexi/yuketang-helper-auto.git`
- **网络代理规范**：在拉取或推送远程仓库时，确保 Git 代理畅通：
  ```bash
  git config http.proxy http://127.0.0.1:10808
  git config https.proxy http://127.0.0.1:10808
  ```

### 6.2 常用开发与构建命令
在 `E:\MyProject\yuketang-helper-auto\ykt-helper-win` 目录下执行：
```bash
# 安装完整开发依赖
npm ci --include=dev --include=optional

# 运行自动化测试（改动任何核心逻辑后必须执行）
npm test

# 编译构建前端和主进程
npm run build

# 启动本地开发调试桌面端
npm start

# 打包绿色便携版并生成更新清单
npm run make:portable
npm run release:prepare

# 提交并推送版本标签后，上传草稿；明确发布使用 -- --publish
npm run release:upload
```

### 6.3 Commit 提交信息规范
项目统一遵循 Conventional Commits 格式：
- `feat:` 新增功能特性（如刷课新增某种题型支持）
- `fix:` 修复 Bug（如修复注入脚本语法、修复倍速拦截）
- `docs:` 文档更新（如更新 README、本知识库文档）
- `chore:` 构建、脚本、依赖清理等常规改动

---

## 7. 后续 AI 协同开发黄金铁律 (Guardrails)

任何后续接手的 AI 助手或开发者，**必须严格遵守以下原则，严禁违背**：

1. 📦 **只维护绿色便携版**：
   正式发行物仅使用 `YuketangHelper-*.zip` 和 `update-win32-x64.json`。打包流程、更新逻辑、首页及发布说明均以便携版为准，解压即用。
2. 🛡️ **契约测试必须全绿**：
   任何对 `course-brush-controller.ts` 或浏览器注入脚本的修改，必须运行 `npm test`，确保 39 套套件（368+ 个测试）100% 通过。严禁在测试报错的情况下强行提交代码。
3. 💾 **严格保护用户本地数据**：
   切勿删除或污染 `user-data-backups/` 目录以及任何用户本地生成的 `ykt-helper-data/` 目录。
4. ⚙️ **路径与批处理同步维护**：
   项目当前根目录位于 `E:\MyProject\yuketang-helper-auto`。如果修改了目录结构或启动参数，必须同步检查并确保 `启动雨课堂助手.bat` 能够正常拉起应用。
5. 🤝 **尊重开源归属与规范**：
   在任何对外文档或界面中，必须保留对上游先驱开源项目的致谢声明（`ZaytsevZY/yuketang-helper-auto`, `Niuwh/yuketang-jiaoben`, `hotwords123/yuketang-helper`, `OneTHU`），并保留学术研究免责声明。
6. 📖 **README 的功能分组**：
   首页当前只设置“自动刷课”和“课堂自动化”两个核心功能板块。前者包含视频、讨论及课程单元流转；后者包含自动答题、课件下载、当前课堂课件与题目预览等。以后确有新增类别时，再增加同级板块。下载和三步上手前置，最新版本展开、旧版本折叠；详细开发文档放在 `ykt-helper-win/README.md`。

---

*（本文档由 Antigravity 整理沉淀，永久存放于代码库根目录，随时可供后续 AI 与开发者快速检索与续写。）*
