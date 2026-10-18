<p align="center">
  <a href="https://github.com/ZaytsevZY/yuketang-helper-auto/pulls">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">
  </a>
  <a href="https://github.com/ZaytsevZY/yuketang-helper-auto/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="license"/>
  </a>
  <a href="manifest.json">
    <img src="https://img.shields.io/badge/version-2.0.0-blue.svg" alt="版本">
  </a>
  <a href="#">
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-green.svg" alt="适配平台">
  </a>
</a>

![](./static/logo.png)

<html>
    <h1 align="center">
       雨课堂助手
    </h1>
    <h3 align="center">
       Yuketang Helper AI
    </h3>
</html>


[返回旧版](./README_origin.md)

## 简介

> Latest Version：2.1.0-preview 20261018

本项目基于 [ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto) 进行二次开发与功能增强。在保留原项目完备的 Electron 桌面客户端架构与课堂监控功能的基础上，集成了**全自动智能刷课流水线**、**章节自动顺序定位**、**课件自动翻页**、**讨论区智能互动**以及**基于大模型的视觉答题支持**。

- 本项目仅供技术学习与逆向研究参考，建议独立思考解决问题
- 本项目可能会产生 API 使用费用，请注意消费
- 本项目不会线上存储用户的任何个人信息或其他敏感信息

### 🌟 本分支新增特性与改进

1. **智能目录扫描与免缓存精确定位**：进入课程后自动分析章节树与未完成项，直接跳转至首个待学习单元（讨论、视频或作业），无需依赖旧版易失效的本地缓存。
2. **原生视频倍速防抖与锁定**：重构 Electron 页面注入逻辑，锁定 `playbackRate` 属性并拦截页面自身频繁重置倍速的死循环，稳定维持所配置倍速。
3. **讨论区智能跟帖互动**：自动检测讨论单元，提取同班同学优质评论并填充至输入框，支持富文本 contenteditable 及回车自动提交，杜绝千篇一律与漏刷。
4. **作业多模态视觉答题 (Vision AI)**：针对加密字体与复杂题型，支持原生截图直接交由多模态视觉模型解答并自动填入。
5. **全链路自动化契约测试**：为所有动态注入的浏览器脚本增加了 Vitest 语法编译与执行测试，杜绝运行时报错。

## 快速开始 (Quick Start)

### 方式一：下载 Windows 一键安装程序 (推荐普通用户)
> 💡 **无需安装 Node.js、npm 或 Git**，下载即用。

前往 [Releases 页面](https://github.com/Cyclohexi/yuketang-helper-auto/releases) 下载最新发行版：
- 📦 **一键安装包**：下载 `YuketangHelper-Setup.exe`，双击全自动安装并创建桌面快捷方式。
- 🗂️ **绿色免安装版**：下载 `YuketangHelper-Portable.zip`，解压后双击 `雨课堂助手.exe` 直接运行。

### 方式二：下载源码一键启动
如果你下载了源码压缩包或克隆了本仓库：
- 双击根目录下的 **`一键启动雨课堂助手.bat`** 即可自动运行，无需敲击任何命令。

### 方式三：开发者手动编译与开发模式
如果你是开发者并需要二次开发或调试：
```sh
cd ykt-helper-win
npm ci --include=dev --include=optional
npm run build
npm start
```

- 登录雨课堂

![](./static/desktop/main.png)

- 填入 API 并设置各功能的对应模型

![](./static/desktop/set_model.png)

- 连接需要 AI 辅助的课程

![](./static/desktop/set_class.png)

- 在其他页面选取 AI 辅助的功能

![](./static/desktop/in_class.png)

## 源代码

|文件夹|适用平台|状态|
|---|---|---|
|`ykt-helper`|Edge/Chrome 浏览器|`1.21.5` 正在更新|
|`ykt-helper-win`|Windows/macOS 独立客户端|`2.0.0-preview`正在更新|
|`ykt-helper-android`|Android 移动端|正在开发|

## 功能

1. **习题提醒** :bell: 
- 在发布新题目，考试开始，课程开始/结束等雨课堂事件发生事进行提醒
- 支持自定义提醒方式：弹窗，声音和通知，复原软件提醒体验
- 支持自动进入正在上课的课堂

2. **查看课件和幻灯片** :receipt: 
- 支持在课程开始后查看课件/习题表，包括已经结束的课程
- 支持对课件进行批量化管理和PDF/图片格式下载
- 对课件进行了特殊缓存，能够缓解切换课件卡顿问题

3. **AI辅助学习** :robot: 
- 支持对课件内容进行文字识别、自定义语言翻译
- 支持对课件内容进行AI提问
- 支持对课堂习题内容进行提问和AI答题（有风险）
- 支持在一定时间内补交习题

4. **模拟和开发** :gear:
- 支持模拟 Chrome 浏览器行为
- 为开发者提供了模拟事件、网络实验室和诊断工具

## 雨课堂 CLI

如果你有多余 token，需要使用 Codex/Claude Code 或者其他 agent 访问本项目，我们建议使用 ykt-cli。

ykt-cli 目前支持的常用命令如下：

```
  ykt status
  ykt settings get
  ykt user get --environment <standard|pro|changjiang> [--refresh]
  ykt lesson list [--environment <standard|pro|changjiang|all>] [--refresh]
  ykt lesson connect <lesson-id> --environment <standard|pro|changjiang>
  ykt presentation list --lesson <lesson-id>
  ykt slide get <slide-id> --lesson <lesson-id> [--presentation <id>]
  ykt slide read <slide-id> --lesson <lesson-id> [--presentation <id>]
  ykt problem list --lesson <lesson-id>
  ykt problem get <problem-id>
  ykt ai profile list
  ykt answer propose <problem-id> [--prompt <text>]
  ykt answer validate <problem-id> --from -
  ykt answer submit <problem-id> --from - --commit [--proposal <id>] [--confirmed-by <user|agent>] [--force-retry]
  ykt logs list [--limit <number>]
```

在源码构建版本中，推荐的使用方式形如：

```
npm run cli -- lesson list --environment all --refresh
npm run cli -- presentation list --lesson <lesson-id>
npm run cli -- slide read <slide-id> --lesson <lesson-id>
npm run cli -- answer propose <problem-id>
'["A"]' | npm run cli -- answer validate <problem-id> --from -
```

ykt-cli 是适用于 agent 的超轻量工具，我们欢迎在 ykt-cli 中实现新功能。

## 致谢与参考 (Acknowledgments)

本项目在开发过程中深度复用并参考了以下优秀开源项目的成果与思路，特此向原作者们致以诚挚的感谢：

1. **[ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto)**
   - 感谢原作者开源的桌面客户端架构底座，提供了 Electron 桌面工程体系、雨课堂 WebSocket 旁路监听、作业/考试详情还原以及加密字体解析的基础。
2. **[Niuwh/yuketang-jiaoben](https://github.com/Niuwh/yuketang-jiaoben)**
   - 感谢作者“风之子”开源的雨课堂刷课助手油猴脚本，为本项目的课程刷课自动化逻辑、PPT 翻页判定、讨论区互动交互及 DOM 选择器适配提供了宝贵的参考与启发。
3. **[hotwords123/yuketang-helper](https://github.com/hotwords123/yuketang-helper)**
   - 感谢雨课堂助手扩展的早期奠基工作，本项目已兼容其扩展能力。
4. **[OneTHU](https://github.com/smartThise/OneTHU)**
   - 感谢社区早期对清华雨课堂接口协议反向工程的探索。

---

## 免责声明 (Disclaimer)

1. 本项目仅供前端逆向工程、Electron 桌面应用架构、自动化测试及 AI 视觉辅助等学术与技术研究交流使用。
2. 严禁将本项目用于任何违背学术诚信、学校管理规章制度的行为，严禁用于任何商业牟利或恶意用途。
3. 任何个人或组织使用本项目所产生的一切直接或间接后果，均由使用者自行承担，本项目及贡献者不承担任何法律或连带责任。

---

## 附录1 API 申请方法

以Kimi API为例：

1. 访问[月之暗面开放平台](https://platform.moonshot.cn/)，进行注册登录
2. 点击左侧API keys一栏，点击创建API key，命名后会生成一串以sk开头的随机字符，就是key。保管好这个key，你可以将他复制到本地安全的地方。这个key不能再次生成或查看！如果丢了，需要重新生成新的key。（生成key不需要任何花费）
3. 充值任意金额后，这个key就可以使用了。你可以将key设置到本项目中进行使用，或使用其他方式调用。

目前支持大部分 OpenAI 协议模型，包括 GPT/Grok/DeepSeek/GLM/Kimi/MiniMax 等；不支持 Anthropic 协议的模型。

以下中转站也可以获取 API key：

|API提供商|url|购买KEY|
|---|---|---|
|硅基流动|https://api.siliconflow.cn/v1/chat/completions|[硅基流动](https://cloud.siliconflow.cn/me/models)|
|阿里云|https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions|[阿里云百炼](https://bailian.console.aliyun.com/)|
|并行科技|https://ai.paratera.com/v1/chat/completions|[清华](easycompute.cs.tsinghua.edu.cn/home) / [其他学校](https://ai.paratera.com/#/lms/api)|

可以在设置中管理所有 API key 和当前使用的 API key
