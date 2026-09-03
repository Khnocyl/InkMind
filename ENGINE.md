# InkMind 写作引擎

InkMind 核心写作引擎：六阶段自研多 Agent 协作管线。

## 架构

```
UI (App / Canvas)
    │
    ▼
useChapterPipeline  ← 锁章、写前意图、快照、落盘
    │
    ▼
engine/pipeline.ts
    ├── Planner   分镜设计
    ├── Writer    正文生成
    ├── Validator 确定性写后校验
    ├── Auditor   硬伤/文笔/机检
    ├── Reviser   定点/升级修复环
    └── Settler   recap + 记忆回写
    │
    ▼
services/aiEngine + llmClient → Express /api/llm
```

## 目录

- `src/engine/` — 管线与 agents 编排
- `src/services/aiEngine.ts` — LLM 原子能力（仍可被局部改写/AI修调用）
- `server/` — Express + 多模型配置

## 跑起来

```bash
npm run dev
# 浏览器打开 Vite 端口；先在「设置」配好 LLM
```

写一章时状态条会出现 `[Planner]` / `[Writer]` / `[Auditor]` / `[Reviser]` / `[Settler]`。

