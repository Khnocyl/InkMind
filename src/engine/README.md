# Writing Engine（自研多 Agent 创作引擎）

InkMind 的写章「脑子」：多 Agent 协作管线，UI 只负责展示与落盘。

## 阶段

| Stage | Agent | 职责 |
|-------|--------|------|
| `plan` | Planner | 分镜 / 节拍（不写正文） |
| `write` | Writer | 流式正文 + 字数补写 |
| `audit` | Auditor | 硬伤（**长章分段送审**，无中段盲区）+ 文笔 + 推进度 + 规则机检；`post_validate` 确定性校验在 Auditor 内执行 |
| `revise` | Reviser | 冲突修复环（最多 N 轮补丁）→ 仍失败升级 **beat 级重写** |
| `settle` | Settler | recap + 角色状态回写 |

`draft_only` 模式在 Writer 后结束。

### 审校体系（四路独立信号）

| 信号 | 性质 | 阻断绿通方式 |
|------|------|--------------|
| 硬伤审（LLM，>7000 字拆段带重叠逐段审） | 一致性 | error / API 失败 → 阻断 |
| 文笔审（LLM，出润色稿） | 质量 | 建议向；**润色 diff 留痕，重大改动对润色稿复硬审** |
| 推进度审（LLM，分镜完成度/主线推进/注水/伏笔触达） | 质量 | 弱推进（<60 或注水 ≥8）→ 压分 70 待人工；API 失败不阻断；**风格配置可关（省调用）** |
| 规则机检 + 确定性写后校验（零 LLM） | 硬尺 | error → 阻断 |

## 入口

```ts
import { runChapterPipeline } from './engine';

const result = await runChapterPipeline(input, {
  onProgress: ({ stage, message }) => {},
  onStreamProse: (text) => {},
  onBeats: (beats) => {},
});
```

`useChapterPipeline` 内是**应用层封装**（锁章、意图、落盘）；核心引擎由 `engine/pipeline.ts` 调度。

## 纪律

`discipline.ts`：描写克制、跨章事实、信息边界。写手 prompt 注入 + 写后确定性校验。

## 与旧 step1/2/3

底层仍复用 `services/aiEngine` 的 LLM 调用实现，编排与门槛统一在 `engine/pipeline.ts`，避免 App 里再堆过程式步骤。
