# 验证说明（v1.0.0）

本文件记录 v1.0.0 实际验证过的范围，避免把「验证过」误解为「全部场景可用」。

## 已验证

| 项目 | 方式 |
| --- | --- |
| 便携 Node 准备 | 缺失时使用内置 22.22.0，不访问 Node.js 官网 |
| NapCat 运行包 | 使用内置 ZIP（124,074,962 字节），SHA256 与固定发行要求一致 |
| QQ 数据隔离 | 使用项目自身 `data/qq-profile/`，不导入本机已有 QQ 登录资料 |
| 真实登录接口与二维码 | 后台登录页可显示二维码；测试账号状态为未登录 |
| 桌面快捷方式 | 首次部署自动创建并可用 |
| 重复启动保护 | 已运行时再次启动只打开后台，不重复拉起 QQ 服务 |
| QQ 服务停止与重启 | 停止后可再次启动并恢复连接 |
| 响应式登录页 | 桌面 1440px 与手机 390px 宽度 |
| 中文与含空格路径 | 在独立中文路径与含空格路径下完成部署 |
| 生产依赖 | 按 `package-lock.json` 执行 `npm ci`，不运行依赖安装脚本 |

## 未验证

| 项目 | 说明 |
| --- | --- |
| 真实 QQ 账号登录全流程 | 需账号本人扫码、设备确认与风控验证 |
| 缺少 C++ 运行库时的安装分支 | 验证机已安装运行库，未重复执行安装程序 |
| ARM Windows | 未测试 |
| Linux 部署 | 本包仅面向 Windows |
| 高 DPI 多屏混用 | 未系统验证 |

## 发布前自检

- [ ] `manifest-sha256.json` 与包内文件一致
- [ ] 包内无 `.env`、`data/`、`qq-agent/data/` 等私密产物
- [ ] `qq-agent/node_modules` 为生产依赖
- [ ] `LICENSE`、`THIRD_PARTY_NOTICES.md`、`qq-agent/LICENSE` 均在
- [ ] 管理密码文件不随包分发
- [ ] Release 页面 SHA256 与实际下载文件一致

## 复现方式

```powershell
# 1. 校验发行包
Get-FileHash .\BOT-Windows-一键部署离线整合包-v1.0.0.zip -Algorithm SHA256

# 2. 解压到干净目录后校验逐文件清单
$root = "D:\bot"
$manifest = Get-Content "$root\manifest-sha256.json" -Raw | ConvertFrom-Json
$bad = foreach ($f in $manifest) {
  $p = Join-Path $root $f.path
  if (-not (Test-Path $p)) { "MISSING $($f.path)"; continue }
  $h = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
  if ($h -ne $f.sha256) { "MISMATCH $($f.path)" }
}
if ($bad) { $bad } else { "manifest OK" }

# 3. 运行部署入口
.\一键部署启动.cmd
```
