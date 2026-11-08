# 贡献指南

感谢你愿意改进这个项目。提交前请先读下面的约定，能省掉很多来回。

## 环境

| 依赖 | 版本 |
| --- | --- |
| Windows | 10 / 11 x64 |
| Node.js | >= 22.13（推荐 22.22 LTS） |

```powershell
cd qq-agent
npm ci --ignore-scripts
npm test
```

首次运行需要配置 `.env`（参考根目录 `.env.example`），不要把 `.env` 提交上来。

## 分支与提交

- 从 `main` 开分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
- 提交信息用祈使句，说明「做了什么」，例如 `fix: 部署时端口占用回退`。
- 一个 PR 只做一件事；顺便重排全文件格式的 PR 会被要求拆分。

## PR 检查清单

- [ ] `npm test` 通过
- [ ] 改动涉及部署脚本时，在干净目录实际跑过一键部署
- [ ] 未提交 `.env`、`data/`、`qq-agent/data/`、`.runtime/`、`node_modules/`
- [ ] 涉及第三方代码或许可时，同步更新 `THIRD_PARTY_NOTICES.md`
- [ ] 面向用户的改动更新了 README 或 `docs/`

## 代码约定

- 后端保持零运行时依赖以外的引入；新增依赖请在 PR 里说明理由。
- 部署脚本里的危险操作（删除、覆盖、运行下载物）必须有校验或确认。
- 报错信息要能指导用户下一步做什么，不要只抛原始异常。

## 发布流程

1. 更新 `CHANGELOG.md`（新增 / 变更 / 修复 / 已知限制）。
2. 校验离线包：`manifest-sha256.json` 与包内文件一致。
3. 打 tag：`vX.Y.Z`，并在 Release 里附 `SHA256SUMS.txt`。
4. Release 说明直接取自 `CHANGELOG.md` 对应小节。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
