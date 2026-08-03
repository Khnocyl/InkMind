# Writing Engine（InkOS 风格）

Novel Studio 的写章「脑子」：多 agent 管线，UI 只负责展示与落盘。

## 阶段

| Stage | Agent | 职责 |
|-------|--------|------|
| `plan` | Planner | 分镜 / 节拍（不写正文） |
| `write` | Writer | 流式正文 + 字数补写 |
| `post_validate` | Validator | 零 LLM：破折号、感官堆砌、报告术语… |
| `audit` | Auditor | 硬伤 + 文笔 + 规则机检 |
| `revise` | Reviser | 冲突修复环（最多 N 轮） |
| `settle` | Settler | recap + 角色状态回写 |

`draft_only` 模式在 Writer 后结束。

## 入口

```ts
import { runChapterPipeline } from './engine';

const result = await runChapterPipeline(input, {
  onProgress: ({ stage, message }) => {},
  onStreamProse: (text) => {},
  onBeats: (beats) => {},
});
```

`App.tsx` 内 `runChapterPipeline` 是**应用层封装**（锁章、意图、落盘）；真正引擎为 `runInkosStyleEngine`（`runChapterPipeline` from `./engine`）。

## 纪律

`discipline.ts` 对齐 InkOS：描写克制、跨章事实、信息边界。写手 prompt 注入 + 写后确定性校验。

## 与旧 step1/2/3

底层仍复用 `services/aiEngine` 的 LLM 调用实现，编排与门槛统一在 `engine/pipeline.ts`，避免 App 里再堆过程式步骤。
