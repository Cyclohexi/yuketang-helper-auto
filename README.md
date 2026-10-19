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
    <img src="https://img.shields.io/badge/Tests-39%20Suites%20%7C%20368%20Passed-success.svg" alt="Tests">
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
  <strong>现代化雨课堂智能辅助学习客户端 · 全自动课程刷课流水线 · 多模态视觉 AI 搜题答题 · 绿色便携免安装</strong>
</p>

<p align="center">
  <a href="#-快速上手-quick-start">⚡ 快速上手</a> •
  <a href="#-核心特性与优势">✨ 核心特性</a> •
  <a href="#-大模型-ai-配置指南">🤖 AI 配置指南</a> •
  <a href="#-开发者指南">💻 开发者指南</a> •
  <a href="#-常见问题排查-faq">❓ 常见问题</a> •
  <a href="#-致谢与参考-acknowledgments">🤝 致谢参考</a> •
  <a href="#-免责声明-disclaimer">📜 免责声明</a>
</p>

---

## 📖 简介

本项目基于 [ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto) 进行深度重构与功能演进。在继承 Electron 现代化桌面客户端、雨课堂 WebSocket 旁路监听与课堂监控体系的基础上，专为课程学习打造了**全新全自动智能刷课流水线**、**智能目录扫描与断点续刷**、**课件 (PPT) 智能翻页**、**同班同学讨论发言智能复用**，以及**应对防爬加密字体的多模态 Vision AI 视觉搜题**能力。

> ⚠️ **温馨提示**：
> 1. 本项目仅供技术学习、前端逆向工程与自动化测试学术研究交流。
> 2. 使用大模型 AI 辅助答题可能消耗相应厂商的 Token / API 费用，请合理配置额度。
> 3. 本项目完全本地化运行，所有配置均存储在本地，不收集、不上报任何用户隐私与凭据。

---

## ✨ 核心特性与优势

### 1. 🎓 全自动智能刷课流水线
- **智能目录分析与断点续学**：
  进入课程后自动递归扫描整个章节树结构，精准识别视频、课件 (PPT)、讨论区及作业的完成状态。自动跳过已达成 100% 进度的章节，**秒级直达首个待学未完成单元**，杜绝从头盲刷或中途遗漏。
- **原生视频倍速防抖与锁定**：
  重构 Electron 页面注入层，针对部分课程网页脚本频繁重置播放倍速的机制进行了**深层属性代理拦截与防抖锁定**（支持 1.0x ~ 4.0x），保证播放速度稳定不跳动；支持自动静音，播放完成后无感切换下一节。
- **课件 (PPT) 智能翻阅**：
  遇到课件阅读单元时，自动按预设安全间隔进行平滑逐页翻动，模拟真实学习浏览节奏，确保达到平台阅读时长与覆盖要求。
- **讨论区智能跟帖互动**：
  自动检索当前班级讨论区已有同学的发言并智能复用，支持富文本（Quill / Contenteditable）及常规文本域的拟人化输入与回车提交；内置异步加载防护，避免因 DOM 尚未加载完成而导致的跳过或漏刷。

### 2. 🧠 多模态视觉 AI 搜题答题 (Vision AI)
- **攻克加密字体痛点**：
  面对雨课堂采用的动态 WOFF/OTF 加密混淆字体（复制文本常为乱码），直接采用**原生高清晰度题目视窗截图与视觉多模态分析技术**。
- **主流大模型全兼容**：
  支持直连或通过中转聚合平台调用主流大模型：
  - **OpenAI 兼容协议**（GPT-4o / GPT-4o-mini 等）
  - **DeepSeek**（deepseek-chat / deepseek-reasoner）
  - **月之暗面 Kimi**（Moonshot AI）
  - **阿里通义千问**（Qwen-VL 系列）
  - **智谱 GLM**、MiniMax、硅基流动等各大厂商 API

### 3. 🗂️ 绿色便携架构 (Portable & Zero-Install)
- **解压即用，零系统残留**：无需运行安装程序，不写入系统注册表，不向系统盘 AppData 散落垃圾。
- **沙箱化数据持久存储**：程序数据、用户登录态与模型配置全部存储于程序目录下的 `ykt-helper-data` 文件夹内，复制整个文件夹即可轻松跨设备迁移。

### 4. 🛡️ 工业级自动化契约测试保护
- 内置 **39 套自动化测试套件、368+ 个测试用例**（基于 Vitest）。
- 对所有注入至雨课堂 WebView 的 DOM 解析脚本、状态机跳转逻辑、事件拦截器进行严格的语法编译与契约测试校验，杜绝脚本运行时报错崩溃。

---

## ⚡ 快速上手 (Quick Start)

### 方式一：下载 Windows 绿色便携免安装版（强烈推荐普通用户）

> 💡 **无需安装 Node.js、npm 或 Python，解压即用！**

1. **前往下载**：
   在 [GitHub Releases 页面](https://github.com/Cyclohexi/yuketang-helper-auto/releases) 下载最新发行版压缩包：
   - 👉 **[点击直接下载 YuketangHelper-v2.1.0-Windows-x64-Portable.zip](https://github.com/Cyclohexi/yuketang-helper-auto/releases/download/v2.1.0/YuketangHelper-v2.1.0-Windows-x64-Portable.zip)**
2. **解压文件**：
   将下载好的 `.zip` 压缩包解压到本地任意目录（例如 `D:\Tools\YuketangHelper`）。
   > 📌 **建议**：请勿解压在带有只读属性或需管理员权限的根目录下（如 `C:\Program Files`）。
3. **启动运行**：
   打开解压后的文件夹，双击运行 **`雨课堂助手.exe`** 即可立即使用！

---

### 方式二：克隆源码一键启动

如果你已克隆本仓库到本地，在根目录直接双击运行：
- **`启动雨课堂助手.bat`**：脚本将自动定位并启动内置 Electron 桌面客户端。

---

## 📸 界面预览与操作指引

### 1. 登录与身份绑定
打开应用后，通过微信或手机号扫码登录雨课堂官方网页（支持普通雨课堂、荷塘雨课堂及长江雨课堂等多校园环境）：

<p align="center">
  <img src="./static/desktop/main.png" width="720" alt="主界面与登录" />
</p>

### 2. 配置大模型 API
在左侧菜单进入“设置”，填入您的 API Key、Base URL 与对应的模型名称：

<p align="center">
  <img src="./static/desktop/set_model.png" width="720" alt="配置模型与API" />
</p>

### 3. 选择课程与自动化刷课
在课程列表页进入待学课程，点击右上角自动化按钮，助手将全自动扫描进度并启动刷课流：

<p align="center">
  <img src="./static/desktop/set_class.png" width="720" alt="连接课堂" />
</p>

<p align="center">
  <img src="./static/desktop/in_class.png" width="720" alt="课堂辅助" />
</p>

---

## 🤖 大模型 (AI) 配置指南

本项目遵循通用 OpenAI 规范，支持目前市面几乎所有的兼容端点：

| API 提供商 | 推荐模型名 | 默认 Base URL | 获取 API Key 链接 |
| :--- | :--- | :--- | :--- |
| **DeepSeek** | `deepseek-chat` / `deepseek-reasoner` | `https://api.deepseek.com/v1` | [DeepSeek 开放平台](https://platform.deepseek.com/) |
| **月之暗面 Kimi** | `moonshot-v1-8k` / `moonshot-v1-32k` | `https://api.moonshot.cn/v1` | [Moonshot 开放平台](https://platform.moonshot.cn/) |
| **硅基流动 (SiliconFlow)** | `deepseek-ai/DeepSeek-V3` 等 | `https://api.siliconflow.cn/v1` | [硅基流动控制台](https://cloud.siliconflow.cn/) |
| **阿里云百炼** | `qwen-plus` / `qwen-max` / `qwen-vl-plus` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | [阿里云百炼平台](https://bailian.console.aliyun.com/) |
| **OpenAI 官方** | `gpt-4o` / `gpt-4o-mini` | `https://api.openai.com/v1` | [OpenAI Platform](https://platform.openai.com/) |

> 💡 **提示**：若使用视觉答题（题干包含图片或公式渲染），请确保配置的模型支持 Vision 多模态输入（如 `gpt-4o`, `qwen-vl-plus` 等）。

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

# 3. 运行自动化契约测试
npm test

# 4. 构建渲染前端
npm run build

# 5. 启动 Electron 桌面调试客户端
npm start
```

### 打包绿色免安装版

```bash
cd ykt-helper-win
npm run build:win:dir
# 生成的解压即用免安装包将位于 dist/win-unpacked/
```

---

## ❓ 常见问题排查 (FAQ)

<details>
<summary><strong>Q1: 为什么推荐绿色便携版 (Portable ZIP) 而非传统的 Setup 安装包？</strong></summary>

> **答**：传统安装包会将配置和缓存深度写入系统的 `%AppData%` 与注册表中，不仅卸载时容易残留，且在学校机房或公共电脑上往往受限于管理员权限。绿色便携版将所有运行时与数据完全封装在解压目录内的 `ykt-helper-data` 中，真正做到了“即解即用、拔盘即走、纯净无痕”。
</details>

<details>
<summary><strong>Q2: 每次关闭后重新打开需要重新扫码登录吗？</strong></summary>

> **答**：不需要。绿色便携版会将您的登录凭据和 Token 安全保存在软件同级的 `ykt-helper-data` 目录中。只要保留该目录，再次启动时会自动恢复登录态。
</details>

<details>
<summary><strong>Q3: 刷课时视频播放倍速老是被页面重置回 1 倍速怎么办？</strong></summary>

> **答**：本项目已在注入内核层深度代理了 `HTMLMediaElement.prototype.playbackRate` 属性并实现了防抖锁定逻辑，底层直接拦截雨课堂播放器的改写动作。请确保在助手设置中已勾选并设置目标倍速（建议设置为 2.0x ~ 3.0x，过高可能受网络带宽解码限制）。
</details>

<details>
<summary><strong>Q4: 讨论区单元为什么提示跳过或停留？</strong></summary>

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
