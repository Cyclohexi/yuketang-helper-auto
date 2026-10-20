<p align="center">
  <a href="https://github.com/Cyclohexi/yuketang-helper-auto/releases">
    <img src="https://img.shields.io/github/v/release/Cyclohexi/yuketang-helper-auto?color=brightgreen&label=Release" alt="Latest Release">
  </a>
  <a href="https://github.com/Cyclohexi/yuketang-helper-auto/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"/>
  </a>
  <a href="#">
    <img src="https://img.shields.io/badge/Platform-Windows%2010%2F11%20x64-blue.svg" alt="Platform">
  </a>
  <a href="#">
    <img src="https://img.shields.io/badge/Tests-42%20Suites%20%7C%20389%20Passed-success.svg" alt="Tests">
  </a>
  <a href="https://github.com/Cyclohexi/yuketang-helper-auto/pulls">
    <img src="https://img.shields.io/badge/PRs-Welcome-brightgreen.svg" alt="PRs Welcome">
  </a>
</p>

<p align="center">
  <img src="./static/logo.png" width="128" alt="Logo" />
</p>

<h1 align="center">雨课堂助手 (Yuketang Helper AI)</h1>

<p align="center">
  <strong>现代化雨课堂智能全能客户端 · 课堂实时自动答题 · 全自动课程刷课流水线 · 绿色便携免安装</strong>
</p>

<p align="center">
  <a href="#version-history">📝 版本更新记录</a> •
  <a href="#-快速上手-quick-start">⚡ 快速上手</a> •
  <a href="#-功能一课堂助手与原版核心功能">🎯 功能一：课堂助手与原版功能</a> •
  <a href="#-功能二自动刷课助手">⚡ 功能二：自动刷课助手</a> •
  <a href="#-界面预览与操作指引">📸 界面预览</a> •
  <a href="#-开发者指南">💻 开发者指南</a> •
  <a href="#-常见问题排查-faq">❓ 常见问题</a> •
  <a href="#-致谢与参考-acknowledgments">🤝 致谢参考</a> •
  <a href="#-免责声明-disclaimer">📜 免责声明</a>
</p>

---

## 📖 简介

本项目基于 [ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto) 进行二次开发与功能增强。

项目**全量保留了原项目的所有核心功能**（课堂监控、习题弹窗/声音提醒、自动进入上课、课件/幻灯片批量管理与高清下载、文字 OCR 识别与翻译、AI 提问答疑、开发者网络实验室、雨课堂 CLI 等），并全新研发了**全自动刷课助手**（自动定位、自动静音二倍速、自动讨论、自动切换切集等）。

> ⚠️ **温馨提示**：
> 1. 本项目仅供技术学习、前端逆向工程与自动化测试学术研究交流。
> 2. 使用大模型 AI 辅助答题可能消耗相应厂商的 Token / API 费用，请合理配置额度。
> 3. 本项目完全本地化运行，所有配置均存储在本地，不收集、不上报任何用户隐私与凭据。

---

<a id="version-history"></a>

## 📝 版本更新记录

每次发布的更新内容都会在这里记录，最新版本排在最前面。完整发行文件见 [GitHub Releases](https://github.com/Cyclohexi/yuketang-helper-auto/releases)。

### v2.2.0 · 自动更新（2026-10-20）

**第二个 Release，也是首次功能更新。**

- **新增自动检查更新**：程序启动后检查新版，运行期间每 6 小时再次检查，也可点击顶部版本按钮手动检查。
- **支持应用内下载和重启更新**：发现新版后直接在助手内下载，确认重启后完成替换，无需每次打开 GitHub 下载。
- **保留本地数据**：更新时保留登录状态、模型配置和 `ykt-helper-data` 中的数据。
- **增加更新包校验与失败回滚**：下载后校验文件大小和 SHA-256，普通文件替换失败时尝试恢复原程序。
- **继续提供 Windows x64 ZIP 便携版**：解压即可使用。

> **旧版用户注意**：v2.1.0 及更早版本没有更新功能，需要先手动升级到 v2.2.0 一次。升级前关闭旧程序，将原来的 `ykt-helper-data` 文件夹保留并放在新版程序旁；后续版本即可使用应用内更新。

[下载 v2.2.0 便携版](https://github.com/Cyclohexi/yuketang-helper-auto/releases/download/v2.2.0/YuketangHelper-v2.2.0-Windows-x64-Portable.zip) · [本次发布说明](https://github.com/Cyclohexi/yuketang-helper-auto/releases/tag/v2.2.0)

### v2.1.0 · 首个 Release（2026-10-18）

首个公开发行版本，提供课堂助手与课程自动化功能，包括自动定位未完成单元、视频静音及倍速播放、讨论区互动等，并提供 Windows x64 便携包。

[查看 v2.1.0](https://github.com/Cyclohexi/yuketang-helper-auto/releases/tag/v2.1.0)

---

## 🎯 功能一：课堂助手与原版核心功能

本项目全量保留了原开源项目 [ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto) 的所有完备功能：

1. **习题与课堂提醒** :bell:
   - 在发布新题目、考试开始、课程开始/结束等雨课堂事件发生时进行实时提醒
   - 支持自定义提醒方式：弹窗、声音和桌面系统通知，复原软件原生提醒体验
   - 支持自动检测并直接进入正在上课的课堂

2. **查看与下载课件幻灯片** :receipt:
   - 支持在课程开始后查看课件/习题表，包括已经结束的课程
   - 支持对课件进行批量化管理和高清 PDF / 图片格式下载导出
   - 对课件进行了特殊缓存处理，极大缓解切换课件卡顿问题

3. **AI 辅助学习与自动答题** :robot:
   - 支持对课件内容进行文字识别（OCR）、自定义语言翻译
   - 支持对课件内容直接发起 AI 提问与答疑
   - 支持对课堂随堂习题内容进行提问和 **AI 自动答题与提交**
   - 支持在允许时间范围内对错过的习题进行**补交 / 强制补交**
   - 支持多模态 Vision 视觉答题，攻克加密字体混淆难题

4. **模拟与开发者工具** :gear:
   - 支持模拟 Chrome 浏览器真实环境与请求特征
   - 为开发者提供了模拟事件、网络实验室和诊断工具
   - 内置强大的雨课堂终端 CLI 工具 (`ykt-cli`)，便于脚本调用与自动化调度

---

## ⚡ 功能二：自动刷课助手

以功能为导向的全新自动化课程流转引擎，省时省心：

- **🧭 自动定位进度**：进入课程后自动分析目录树，智能跳过已完成项，直接秒级定位并跳转到当前最新未完成的学习节点，无需手动翻找。
- **🎬 视频学习**：
  - **自动二倍速**：稳定维持 2 倍速快速播放，底层防抖锁定，不受网页脚本限制。
  - **自动静音**：视频加载后自动静音，后台挂机不打扰工作与休息。
  - **自动播放与切换**：视频播放完毕后自动顺畅跳转至下一节。
- **💬 自动讨论**：自动检测讨论区，自动提取并复用同班同学优质发言进行发表互动，杜绝漏刷与千篇一律。
- **🧪 更多功能测试中**：
  - **自动答题**（课后作业 / 习题 AI 自动作答与提交测试中）
  - **自动翻阅课件**（课件 PPT 智能逐页翻阅与模拟停留测试中）

---

## ⚡ 快速上手 (Quick Start)

自 v2.2.0 起，便携版支持应用内更新：启动后自动检查，顶部版本按钮可下载并重启更新，保留本地数据。现有旧版用户需要先手动更新到 v2.2.0 一次，后续可直接在应用内更新。维护者发布流程见[自动更新说明](ykt-helper-win/docs/auto-update.md)。

### 方式一：下载 Windows 绿色便携免安装版（强烈推荐普通用户）

> 💡 **无需安装 Node.js、npm 或 Python，解压即用！**

1. **前往下载**：
   在 [GitHub Releases 页面](https://github.com/Cyclohexi/yuketang-helper-auto/releases) 下载最新发行版：
   - 👉 **[点击直接下载 YuketangHelper-v2.2.0-Windows-x64-Portable.zip](https://github.com/Cyclohexi/yuketang-helper-auto/releases/download/v2.2.0/YuketangHelper-v2.2.0-Windows-x64-Portable.zip)**
2. **解压文件**：
   将下载好的 `.zip` 压缩包解压到本地任意目录（例如 `D:\Tools\YuketangHelper`）。
   > 📌 **建议**：请勿解压在带有只读属性或需管理员权限的根目录下（如 `C:\Program Files`）。
3. **启动运行**：
   打开解压后的文件夹，双击运行 **`YuketangHelper.exe`**（或已改名的 `雨课堂助手.exe`）即可立即使用！数据将自动保存在同目录的 `ykt-helper-data` 文件夹内，绿色便携纯净。

---

### 方式二：克隆源码一键启动

如果你已克隆本仓库到本地，在根目录直接双击运行：
- **`启动雨课堂助手.bat`**：脚本将自动定位并启动内置 Electron 桌面客户端。

---

## 📸 界面预览与操作指引

### 1. 扫码登录与 API 配置
打开应用后，支持选择不同雨课堂服务器节点（雨课堂、荷塘雨课堂、长江雨课堂、黄河雨课堂等），通过微信或雨课堂 APP 扫码即可完成登录；点击顶部“模型”面板（AI Profile），选择模型厂商、填入 Base URL 与 API Key，即可一键配置大模型推理服务，并支持为文本分析、多模态视觉（VLM）、OCR 与翻译单独指定分工模型。

<p align="center">
  <img src="./static/desktop/login_and_api.png" width="820" alt="扫码登录与模型API配置" />
</p>

### 2. 课程全自动刷课
进入课程学习日志页面，右侧助手面板将呈现“自动刷课 & AI 作业联网”控制台。点击 **【启动自动刷课】** 即可开启全自动化流转：系统全自动扫描并定位未完成节点、**自动开启静音并锁定 2.0x 倍速播放**、**讨论区智能提取同班同学发言跟帖**，视频播放完毕后自动进入下一节。

<p align="center">
  <img src="./static/desktop/auto_brush.png" width="820" alt="课程全自动刷课控制台" />
</p>

### 3. 课堂题目自动检测、AI 作答与全量查看（支持强制补交）
在上课过程中，系统自动监听捕获随堂新题并实时唤起 AI 解析与**自动答题提交**。左侧课件栏直观列出**当前课堂中全部老师已展示及未展示的题目**；不仅支持一键采纳 AI 建议作答，还可在题目超时或错过后一键点击 **【强制补交】**，课堂答题全把控。

<p align="center">
  <img src="./static/desktop/in_class_ai.png" width="820" alt="课堂题目检测、AI答题与题目全量查看" />
</p>

---

## 🤖 大模型 (AI) 配置说明

本项目遵循标准 OpenAI 协议规范，支持任何兼容 OpenAI 接口的模型与服务提供商（包括 DeepSeek、月之暗面 Kimi、通义千问、硅基流动等）。

在客户端右上角“模型”设置中填入对应厂商的 **Base URL** 与 **API Key**，即可直接调用。如果需要使用视觉答题能力，建议配置支持多模态输入（Vision）的模型。

---

## 💻 开发者指南

### 工程目录结构

```text
yuketang-helper-auto/
├── ykt-helper-win/            # 核心工程（Electron 主进程 + Vue 3 渲染端 + 刷课引擎）
│   ├── src/
│   │   ├── main/             # Electron 主进程源码
│   │   │   ├── course-brush/ # 自动化刷课状态机、目录解析与脚本生成器
│   │   │   └── ai/           # 多模态视觉答题与大模型交互
│   │   ├── renderer/         # 前端界面 (Vue 3 + Vite + Element Plus)
│   │   └── preload/          # 安全隔离注入脚本
│   └── tests/                # 刷课注入脚本与状态机契约测试 (Vitest)
├── static/                   # 界面截图与静态资源
└── 启动雨课堂助手.bat         # Windows 本地开发快速拉起脚本
```

### 本地编译与调试

```bash
# 1. 进入主工程目录
cd ykt-helper-win

# 2. 安装项目依赖
npm ci --include=dev --include=optional

# 3. 运行自动化测试 (42 Suites | 389 Passed)
npm test

# 4. 构建渲染前端
npm run build

# 5. 启动 Electron 桌面调试客户端
npm start
```

### 打包绿色免安装版

```bash
cd ykt-helper-win
npm run make:portable
npm run release:prepare
# 便携包和更新清单位于 desktop/out/release/v<版本>/
```

---

## ❓ 常见问题排查 (FAQ)

<details>
<summary><strong>Q1: 便携版如何使用，数据保存在哪里？</strong></summary>

> **答**：下载 ZIP 并解压，双击 `YuketangHelper.exe` 即可使用。登录状态、模型配置和缓存保存在程序旁的 `ykt-helper-data` 文件夹中；移动程序或首次手动升级时，请一并保留这个文件夹。
</details>

<details>
<summary><strong>Q2: 每次关闭后重新打开需要重新扫码登录吗？</strong></summary>

> **答**：不需要。绿色便携版会将您的登录凭据和 Token 安全保存在软件同级的 `ykt-helper-data` 目录中。只要保留该目录，再次启动时会自动恢复登录态。
</details>

<details>
<summary><strong>Q3: 自动刷课时视频播放倍速老是被页面重置回 1 倍速怎么办？</strong></summary>

> **答**：本项目已在注入内核层深度代理了 `HTMLMediaElement.prototype.playbackRate` 属性并实现了防抖锁定逻辑，底层直接拦截雨课堂播放器的改写动作。请确保在助手设置中已勾选并设置目标倍速（建议设置为 2.0x ~ 3.0x，过高可能受网络带宽解码限制）。
</details>

<details>
<summary><strong>Q4: 自动讨论区单元为什么提示跳过或停留？</strong></summary>

> **答**：讨论区互动功能会自动检索本班同课堂其他同学的发言并智能复用发布。如果该门课程刚开课、讨论区暂无任何同学发表评论，系统会在等待超时后安全跳过，以防死循环或提交空内容违规。
</details>

<details>
<summary><strong>Q5: AI 答题提示“网络连接失败”或“API Key 无效”？</strong></summary>

> **答**：请核对设置中的 **Base URL** 是否完整（通常需要以 `/v1` 结尾，末尾无需多余斜杠），并确认 API 账户是否有充足的可用额度。若直连受限，可在软件中开启网络代理。
</details>

---

## 🤝 致谢与参考 (Acknowledgments)

本项目由衷感谢开源社区的探索与无私奉献，尤其向以下先驱项目及作者致以诚挚敬意：

1. **[ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto)**
   - 感谢原作者开源的桌面客户端架构底座，提供了 Electron 桌面工程体系、雨课堂 WebSocket 旁路监听、作业/考试详情还原以及加密字体解析的基础。
2. **[Niuwh/yuketang-jiaoben](https://github.com/Niuwh/yuketang-jiaoben)**
   - 感谢作者“风之子”开源的雨课堂刷课助手油猴脚本，为本项目的课程刷课自动化逻辑、PPT 翻页判定、讨论区互动交互及 DOM 选择器适配提供了宝贵的参考与启发。
3. **[hotwords123/yuketang-helper](https://github.com/hotwords123/yuketang-helper)**
   - 感谢雨课堂助手扩展的早期奠基工作。
4. **[OneTHU](https://github.com/smartThise/OneTHU)**
   - 感谢社区早期对清华雨课堂接口协议反向工程的探索。

---

## 📜 免责声明 (Disclaimer)

1. **用途限制**：本项目仅供前端逆向工程、Electron 桌面应用架构、自动化契约测试及多模态 AI 视觉辅助等学术与技术研究交流使用。
2. **规范诚信**：严禁将本项目用于任何违背学术诚信、学校管理规章制度的行为，严禁用于任何商业牟利、代刷代考或非法用途。
3. **责任界定**：任何个人或组织使用本项目所产生的一切直接或间接后果，均由使用者自行承担，本项目作者及贡献者不承担任何法律责任或连带责任。
4. **知识产权**：“雨课堂”是清华大学及学堂在线相关权利人的注册商标，本项目仅为第三方开源学习工具，与雨课堂官方无任何关联或商业合作。

---

<p align="center">
  Made with ❤️ by Open Source Contributors • Licensed under <a href="LICENSE">MIT</a>
</p>
