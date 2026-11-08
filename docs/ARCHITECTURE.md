# 架构说明

## 组件与数据流

```text
浏览器（管理后台 8080）
   │  HTTP + 会话 Cookie
   ▼
gateway.js ── 管理认证、静态资源、反向代理
   │
   ▼
qq-agent（业务后端 3210）
   │  OneBot v11
   ├── HTTP API   127.0.0.1:3000
   └── WebSocket  127.0.0.1:3001
           │
           ▼
      NapCat（QQ 协议端，WebUI 6099）
           │
           ▼
        腾讯 QQ 服务
```

模型调用方向相反：`qq-agent` → 你配置的 OpenAI 兼容接口。

## 进程与入口

| 入口 | 作用 |
| --- | --- |
| `一键部署启动.cmd` | 首次部署：检查 Node / C++ 运行库、安装依赖、准备 NapCat、生成配置、启动并创建快捷方式 |
| `启动管理后台.cmd` | 日常启动：已运行则打开后台，未运行则拉起整套服务 |
| `start.mjs` | Node 启动入口，读取 `.env` 后启动 `gateway.js` |
| `gateway.js` | 管理认证与后台代理，默认 8080 |
| `qq-agent/src/server.js` | 业务后端，默认 3210 |

部署辅助脚本位于 `scripts/`：`windows-deployment.mjs`（主流程编排）、`bootstrap-windows.ps1`（环境检查与依赖安装）、`prepare-vcredist.ps1`（C++ 运行库）、`extract-archive.ps1`（NapCat 解压）、`create-shortcut.ps1`（快捷方式）、`run-windows.mjs` / `windows-process.mjs`（进程生命周期）、`open-browser.mjs`（打开后台）。

## 端口

| 服务 | 默认端口 | 绑定 |
| --- | --- | --- |
| 管理入口 | 8080 | 回环地址 |
| 业务后端 | 3210 | 回环地址 |
| OneBot HTTP | 3000 | 回环地址 |
| OneBot WebSocket | 3001 | 回环地址 |
| NapCat WebUI | 6099 | 回环地址 |

首次部署遇到端口占用会选择附近空闲端口，以启动输出与生成的配置为准。

## 数据布局

| 路径 | 内容 | 是否随发行包分发 |
| --- | --- | --- |
| `data/admin-password.txt` | 首次运行随机生成的管理密码 | 否 |
| `data/qq-profile/` | 独立的 QQ 登录资料 | 否 |
| `qq-agent/data/` | 配置、SQLite 数据库、消息、会话、素材 | 否 |
| `.runtime/` | 便携 Node、NapCat 与下载缓存 | 离线包内置，源码仓库忽略 |
| `qq-agent/node_modules/` | 生产依赖 | 离线包内置，源码仓库忽略 |

## 安全边界

1. **凭据隔离**：发行包不含账号、密钥、人设、聊天记录与登录缓存；QQ 数据保存在项目自身目录，不改动本机已有 QQ。
2. **回环绑定**：内部服务默认只监听 `127.0.0.1`，不直接暴露到互联网。
3. **管理认证**：首次运行生成随机管理密码，所有写操作需要已认证的会话。
4. **安装校验**：Node 与 NapCat 下载后校验 SHA256；C++ 运行库校验 Microsoft 签名；校验失败的文件不执行。
5. **不绕过风控**：验证码、设备确认等必须由账号本人完成。

## 与上游的关系

本项目是 Kondius 原项目（QQ Agent）的独立衍生版：在其基础上重写了 Windows 部署链路、后台界面与部分功能模块。上游代码许可保留于 `qq-agent/LICENSE`，第三方组件声明见 `THIRD_PARTY_NOTICES.md`。
