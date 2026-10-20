# ADR 0003：认证与凭据存储

- 状态：已接受
- 日期：2026-08-30

## 决策

网页登录 Cookie 由专用 Electron persistent session 管理。Bearer Token、API Key 等独立凭据通过 Storage 的 secrets 接口保存，当前 Windows 实现为 Electron `safeStorage` 加密的凭据文件。

SQLite、JSON 配置、普通日志和 fixture 不保存完整 Cookie、Authorization 或 API Key。M0 的 `MemoryKeyValueStore` 只用于无凭据的架构验证，不作为凭据实现。

## 影响

session partition、加密凭据 adapter 与敏感数据扫描测试已实现。Windows 凭据加密依赖系统用户，跨电脑复制后可能需要重新填写。

## 2026-10-20：统一固定数据目录

当前源码将应用与浏览器会话数据统一保存到 `%LOCALAPPDATA%\YuketangHelper`，源码、BAT 和 EXE 使用同一处，程序更新不覆盖配置。首次迁移只复制一个旧 profile 并保留原件，不混合多个数据库。测试用 `--debug-profile` 进入独立的 `YuketangHelper-debug`，不读取或迁移正式凭据。
