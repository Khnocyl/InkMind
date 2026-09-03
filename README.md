<div align="center">

<img src="public/icon.png" alt="InkMind Logo" width="96" height="96" />

# InkMind

**本地优先的 AI 长篇小说创作工作台**

React 19 + Vite 前端 · Express 后端代理 LLM · 作品数据完全保存在本地 IndexedDB

[English](README_EN.md) · [下载安装](#下载安装) · [核心能力](#核心能力) · [快速开始](#快速开始) · [开源协议](#开源协议)

</div>

---

## 下载安装

普通创作者与小说作者无需安装 Node.js 或配置编程环境，直接下载安装桌面客户端：

可在 [Releases 页面](https://github.com/Khnocyl/InkMind/releases) 下载最新安装包：

- **Windows**：下载 `InkMind-x.x.x-win-x64-Setup.exe` 安装程序。若 Windows Defender / SmartScreen 拦截提示“未知发布者”，点击**“更多信息” → “仍要运行”**（个人开源项目暂未购买高昂企业数字证书，所有代码完全开源，安全无害）。
- **版本更新**：客户端内置更新检测功能。进入软件左侧「设置 → 常规与外观 → 关于 · 检查更新」，点击「立即检查更新」即可直连 GitHub 官方 Releases 检查最新版本与更新日志。
- **macOS / Linux**：v1.0.0 优先提供 Windows 桌面安装包；macOS 与 Linux 原生桌面包正在适配中，当前可通过下方源码方式直接运行。

## 核心能力

- **六阶段写章管线**（自研多 Agent 编排）：Planner 分镜 → Writer 流式正文 → Validator 确定性校验 → Auditor 硬伤/文笔/机检 → Reviser 修复环 → Settler 记忆回写
- **长篇记忆系统**：事实账本（factLedger）、钉死事实/伏笔债务、章 recap、跨度 digest，写前按相关度注入
- **一致性防线**：写后硬伤审（状态/战力/时间线/吃书/道具/人称）+ 本地机检 + 跨章抽检 + 记忆冲突检测
- **成本可控**：BYOK（自备 API Key，支持多配置档），月度预算闸门 + 用量看板；LLM 故障自动降级本地保守稿
- **工程兜底**：流式草稿备份、gzip 快照、schema 迁移、跨标签页锁、写入合并

## 快速开始

需要 Node.js 20+。

```bash
npm install

# 开发模式（前后端热重载）
npm run dev
# 浏览器打开 Vite 端口（默认 http://localhost:5173）

# 或：构建 + 单进程运行（Express 直接托管 dist，一个端口跑完整应用）
npm start
# 打开 http://localhost:3001

# 或：打成单文件可执行（免装 Node，给不懂开发的作者用）
npm run build:exe
# 产物在 release/：inkmind.exe + dist/ + 使用说明.txt，双击即用
```

首次使用：进入「风格与引擎」页签，配置 LLM 的 Base URL / API Key / 模型名（支持 DeepSeek、Kimi、GLM、SiliconFlow 等 OpenAI 兼容服务，可存多套配置档）。API Key 由本地服务端加密存储，不会进入前端代码或 git。

## 隐私须知

- 作品数据（章节、设定、记忆）全部存在**本地浏览器 IndexedDB**，不上传任何服务器。
- 但**写作过程中正文会发送给你配置的 LLM 服务端点**。若使用第三方中转站（非模型官方 API），等同于信任该中转站，配置页会对非官方端点显示警告。
- 可选的向量检索（Embedding）同样只调用你配置的服务；未配置时自动使用本地 TF-IDF 检索，写作流程不中断。

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式（server watch + Vite） |
| `npm start` | 构建并用单进程跑生产形态（http://localhost:3001） |
| `npm run build:exe` | 打包服务端单文件可执行（release/inkmind.exe，免装 Node） |
| `npm run electron:dist` | 打包桌面端安装包（release-electron/，生成 Windows x64 安装程序） |
| `npm run build` | 类型检查（tsc -b，含 server）+ 前端构建 |
| `npm test` | vitest 单测 |
| `npm run lint` | oxlint |

## 目录结构

- `src/engine/` — 写章管线与 agents（Planner/Writer/Validator/Auditor/Reviser/Settler）
- `src/services/` — 领域服务（记忆、事实账本、检索、成本、快照、迁移等）
- `src/hooks/` — App 级编排（管线、章节动作、Auto-Pilot、持久化）
- `src/components/` — UI（工作台 / 世界书 / 大纲 / 风格与引擎）
- `server/` — Express：LLM 代理（多配置档 + Token 鉴权）、Embedding、Doctor 诊断
- `tests/` — vitest 单测（服务层纯函数）
- `RISKS.md` — 风险清单与修复跟踪

详细引擎说明见 `ENGINE.md`。

## 开源协议

本项目基于 [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE) 协议开源。
- 欢迎个人作者与开发者自由使用、学习与二次创作；
- 任何基于本项目的衍生版本、修改版或网络服务提供者，**均必须同样遵循 AGPL-3.0 协议全量开源其源代码**，坚决维护开源社区成果，严禁未经开源的商业套壳与闭源转售。
