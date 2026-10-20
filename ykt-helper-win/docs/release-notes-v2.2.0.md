# 雨课堂助手 v2.2.0 · 自动更新

这是本项目的第二个 Release，也是首次功能更新。本次新增便携版应用内更新，后续升级可以直接在助手内完成。

## 本次更新

- **自动检查新版**：程序启动后自动检查，运行期间每 6 小时检查一次，顶部版本按钮也支持手动检查。
- **应用内下载更新**：发现新版后点击下载，完成后点击“重启更新”，确认后自动替换程序。
- **保留本地数据**：更新时保留登录状态、模型配置和 `ykt-helper-data` 文件夹。
- **校验与回滚**：校验更新包大小和 SHA-256，拒绝危险压缩路径；普通文件替换失败时尝试恢复原程序。
- **项目首页新增版本更新记录**：今后每次发布的变化都会在 README 中记录。

## 下载和首次升级

下载本页附件 **`YuketangHelper-v2.2.0-Windows-x64-Portable.zip`**，解压后运行 **`YuketangHelper.exe`**，无需安装 Node.js 或其他开发环境。

**v2.1.0 及更早版本需要手动升级一次**：关闭旧程序，将旧目录中的 `ykt-helper-data` 文件夹保留并放在新版程序旁，再启动新版。之后可使用应用内更新。

`update-win32-x64.json` 是客户端自动更新使用的清单，普通用户只需下载 ZIP。自动检查和下载需要能够访问 GitHub；确认重启前，程序不会自动中断正在进行的课堂或课程任务。

## 验证情况

42 套测试全部通过，389 项测试通过、1 项跳过。已验证便携包生成、实际更新包校验及预解压、中文路径、程序改名、本地数据保留和文件复制失败回滚。

## 致谢与使用说明

感谢 [ZaytsevZY/yuketang-helper-auto](https://github.com/ZaytsevZY/yuketang-helper-auto)、[Niuwh/yuketang-jiaoben](https://github.com/Niuwh/yuketang-jiaoben)、[hotwords123/yuketang-helper](https://github.com/hotwords123/yuketang-helper)、[OneTHU](https://github.com/smartThise/OneTHU)。本项目仅供技术学习与研究交流，请遵守学校规定和学术诚信要求。
