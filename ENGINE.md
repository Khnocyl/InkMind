# Novel Studio 写作引擎

个人项目，引擎按 **InkOS 多 agent 管线**重做（不是 Vite 模板那一层）。

## 架构

```
UI (App / Canvas)
    │
    ▼
App.runChapterPipeline  ← 锁章、写前意图、快照、落盘
    │
    ▼
engine/pipeline.ts
    ├── Planner   分镜
    ├── Writer    正文
    ├── Validator 确定性写后校验
    ├── Auditor   硬伤/文笔/机检
    ├── Reviser   修复环
    └── Settler   recap + 记忆回写
    │
    ▼
services/aiEngine + llmClient → Express /api/llm
```

## 目录

- `src/engine/` — 管线与 agents
- `src/services/aiEngine.ts` — LLM 原子能力（仍可被局部改写/AI修调用）
- `server/` — Express + 多模型配置

## 跑起来

```bash
npm run dev
# 浏览器打开 Vite 端口；先在「风格与引擎」配好 LLM
```

写一章时状态条会出现 `[Planner]` / `[Writer]` / `[Auditor]` / `[Reviser]` / `[Settler]`。

## 和真·InkOS 的差别

| | 本引擎 | InkOS core |
|--|--------|------------|
| 落盘 | IndexedDB 项目 | `books/*/story` 文件树 |
| Agent | 轻量编排 + 现有 prompt | 完整 prompt pack / rule stack |
| 审稿维度 | 硬伤+文笔+机检+写后规则 | 30+ 结构维度 ContinuityAuditor |

后续若要更深，可把 `Auditor` 换成直接调 InkOS ContinuityAuditor，或 book 目录双向同步。
