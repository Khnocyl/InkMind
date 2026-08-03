# Novel Studio 风险点清单与修复跟踪

> 状态图例：✅ 已修复 · 🔧 进行中 · ⏳ 计划中 · 📌 暂缓（需设计/需用户确认）

## 总览

| # | 风险点 | 影响 | 优先级 | 状态 |
|---|--------|------|--------|------|
| R1 | App.tsx 上帝组件（3262→802 行） | 改动易白屏、状态错乱 | P0 | ✅ |
| R2 | 持久化竞态与草稿丢失 | 刷新/崩溃丢草稿、全量写性能 | P0 | ✅ |
| R3 | LLM 强依赖与成本 | API 故障时闭环不可用、费用不可控 | P1 | ✅ |
| R4 | 数据模型演进无迁移框架 | 改 schema 时旧库缺字段出错 | P1 | ✅ |
| R5 | 多标签页并发无保护 | 两页同写一书互相覆盖 | P1 | ✅ |
| R6 | 本地文本精确替换脆弱 | 补丁静默失败/错位 | P2 | ✅ |
| R7 | 记忆多路回写一致性 | 同一事实多处存储冲突 | P1 | ✅ |
| R8 | 服务端安全边界 | 任意网页可白嫖本机 LLM 代理 | P1 | ✅ |
| R9 | 无自动化测试 | 回归全靠手工 | P2 | ✅ |
| R10 | server watch 只盯 3 个文件 | 新增 server 文件不触发重启 | P2 | ✅ |

## 详情与修复方案

### R1 · App.tsx 上帝组件（P0 · ✅ 已修复）
- **现状**：3262 行同时承担状态、业务编排、落盘；已有防御注释（hooks 顺序、projectRef 防闭包）。
- **已完成**（累计 -2460 行，3262 → 802）：
  1. **useProjectPersistence**（`src/hooks/useProjectPersistence.ts`）：落盘路径收敛——CoalescedWriter（R2-3）+ `handleUpdateAndPersistProject`（styleConfig 档案保护合并 + 落盘），deps 传 ref/setter；
  2. **useChapterPipeline**（`src/hooks/useChapterPipeline.ts`，810 行）：单章全链路（分镜→正文→审校→修复→recap→记忆→终态），函数体零改动搬移，9 个 deps 接线；
  3. **useAutoPilot**（`src/hooks/useAutoPilot.ts`，207 行）：AP 连写循环 + 停机条件 + 周期抽检，`autoPilotAbortRef` 收进 hook，`isAutoPilotingRef` 由 App 持有共享；`styleConfig` 派生提前到条件 return 之前（hooks 顺序红线）。
  4. **useProjectActions**（`src/hooks/useProjectActions.ts`，473 行）：项目生命周期 + 导入导出域——`resolveWizardEntry` / `openProjectInWorkspace` / `refreshProjectsList` / `initWorkspace` / `tryRecoverStyleProfiles` / 选书 / 建书 / 删书 / JSON / Markdown / EPUB 导出 / .novel.json 导入，函数体零改动搬移，11 个 deps 接线；exhaustive-deps 补全（setter 进 deps）。
  5. **useChapterActions**（`src/hooks/useChapterActions.ts`，1077 行）：章节动作域——CRUD（增/删/清空/清正文/更新）+ 锁定 / 写前意图 / 跨章抽检 / 待修 / AI 修 / AI 味扫描 / 批量去味 / 意图生成 / 解锁重写，23 个 handler 函数体零改动搬移，16 个 deps 收敛为 props；渲染派生（`previousContextPack`）与编排胶水（`handleStartThreeStepWorkflow`，依赖 `runChapterPipeline`）留在 App（hooks 顺序红线：调用插在 useAutoPilot 之后、`if (!currentProject)` 之前）。
  6. **JSX 容器拆分**（本轮 -86 行）：`WorkspaceTab`（`src/components/Workspace/WorkspaceTab.tsx`，245 行，纯透传 ChapterSidebar/WritingCanvas/AIWorkflowPanel，~50 props 收敛为一个容器）+ `WorldBibleTab`（`src/components/WorldBible/WorldBibleTab.tsx`，116 行，子页签头部 + 角色/设定/记忆三管理器）；App 主 return 仅剩 TopNav + 四个标签页容器 + 两个模态窗。
  - 迁移后清理 App.tsx 未使用导入（tsc noUnusedLocals 兜底）；hooks 目录建立。
- **验证**：`tsc -b` 0 错误；45/45 测试通过；`vite build` + `oxlint` 全绿（12 个既有低危 warning 未动）；App.tsx 及新 hook/组件均正常 transform，无循环依赖。
- **收尾**：全部 handler 已按域收敛进 4 个 hook（persistence/pipeline/autopilot/projectActions/chapterActions）；JSX 拆为容器 + 展示组件；App.tsx 从 3262 → 802 行（-75%），职责从「上帝组件」退化为「状态声明 + hooks 编排 + 顶层组合」。

### R2 · 持久化竞态与草稿丢失（P0 · ✅ 已修复）
- **现状**：流式中间态只写内存 state 不打盘；`saveProject` 为全书 JSON 全量写；快照每书 30 份全量拷贝。
- **已完成**：
  - 跨标签锁（R5）避免两页互相覆盖；
  - **R2-1 流式草稿备份与恢复**：新增 `src/services/draftBackup.ts`（IndexedDB meta store，key=`draft:{projectId}:{chapterId}`），`onStreamProse` 800ms 去抖落盘、管线 finally 冲刷、页面隐藏兜底写；终稿/draft_only 落盘后清除备份；打开书时自动检测（草稿比项目内容新且不一致 → confirm 恢复为「正文草稿」），已被终稿覆盖的备份自动清理，超 7 天自动清理。失败路径（catch）同时给项目内容写 `contentUpdatedAt`，保证恢复判断准确。
  - **R2-2 快照体积优化**：快照载荷改 **gzip 压缩**（`CompressionStream`，中文 JSON 压 5~10x）存 `projectGz` 字段；`readSnapshotProject` 兼容 v1（`project` 明文）与 v2；启动 4s 后后台幂等迁移旧明文快照；快照上限改**项目级可配置**（`getSnapshotCap`/`setSnapshotCap`，meta store key=`snapshot-cap:{projectId}`，默认仍 30）；环境不支持压缩时降级明文。新增 `tests/snapshots.test.ts`（8 例）。
  - **R2-3 全书写入防抖/合并**：新增 `src/services/coalescedWriter.ts` —— 最新值胜出的串行写入器（同一时刻最多 1 在跑 + 1 排队，突发 N 次更新 → 约 2 次真实写）；`await` 语义不变（状态先同步进 ref，写时读最新，resolve 即已落盘）；写失败不 reject 交给 onError，队列可继续。App `persistQueueRef` 串行队列替换为 `CoalescedWriter`。新增 `tests/coalescedWriter.test.ts`（6 例：串行/突发合并/最新值/错误恢复/无陈旧队列/flush）。
- **待办**：无（脏字段级合并需改存储 schema，收益低，暂不纳入）。

### R3 · LLM 强依赖与成本（P1 · ✅ A 韧性 + B 成本控制 完成）
- **现状**：单章全链路几乎每步调 LLM；无超时/重试/预算；正文执笔失败 → 整章无产出；硬伤审 API 失败故意阻断定稿（防幻觉设计）。
- **R3-A 韧性（✅）**：
  1. **统一韧性层** `src/services/llmResilience.ts`：`fetchWithTimeout`（AbortController 超时）+ `withRetry`（指数退避+抖动）+ `isRetryableError`（网络/超时/429/5xx 可重试，4xx 配置问题不重试）。
  2. **llmClient 接入**：`generateJSON`/`generateText`/`generateStream` 全部带默认超时（120s）+ 重试（默认 2 次）；流式「0 字节失败整体重连、已有产出保留部分内容不重复生成」+ 流读取空闲超时（防僵死连接）。
  3. **降级链 · 正文**：`writerAgent` 执笔失败 → `buildConservativeProse`（`src/services/conservativeProse.ts` 纯函数本地模板稿，含 beats/角色/设定/前情/收束，确定性输出）→ 标记 `conservative`，pipeline 强制不自动锁章，`Chapter.conservativeDraft` 存盘，UI 提示重跑正式稿。
  4. **降级链 · 审校**（复用既有机制）：`runHardReview` API 失败 → fallback（防幻觉不绿通）+ 本地断言 `runLocalFactGuard` 仍执行；`ruleScan`/`aiTasteScan` 纯本地机检照跑——闭环产出可用稿、不静默绿通。
- **R3-B 成本控制（✅）**：
  1. **估算与记录** `src/services/costControl.ts`：`estimateTokens`（CJK≈1 token/字，拉丁≈0.25，宁高勿低）+ `estimateCostCny`（deepseek/kimi/glm/gpt/claude 价目表，未知模型默认档）+ 用量记录持久化（localStorage，上限 5000 条）+ `getUsageSummary` 今日/本月聚合。
  2. **预算闸门**：`checkBudgetBeforeCall` 在 llmClient 三个 generate 前置——超限抛 `BudgetExceededError`（不重试），调用方降级（writerAgent 提示「本月 LLM 预算已超限，已降级本地保守稿」）。
  3. **用量归属**：显式 `options.usage` 优先；引擎级活动上下文 `setActiveUsageContext`（pipeline report 随阶段推进，finally 清理，防污染管线外调用）；成功/失败各记一条。
  4. **复杂度分级** `classifyChapterTier`：beats/角色/设定/目标字数/修订轮/复杂情节 → c0~c3 建议档位（模型级切换需后端支持 body.model 覆盖，已记录待办）。
  5. **看板**：`src/components/UsageBadge.tsx` 挂 TopNav——本月调用数/token/费用/上限，超限红显，30s 自动刷新 + 点击刷新。
  6. **配置**：`StyleConfig.llmBudgetEnabled` / `llmMonthlyBudgetCny`（元，0=不限）；pipeline 启动时注入 `setBudgetConfig`。
- **验证**：新增 `tests/costControl.test.ts` 21 例 + llmResilience 追加 4 例集成，159/159 全绿；tsc/lint/build 通过。
- **残留/后续**：~~tier 自动路由的「实际切换模型」~~ ✅ 已支持——后端 `/api/llm/generate` 接受 body.model 覆盖（callLLMService 透传）、llmClient 三 generate 支持 `options.model`；**~~预算配置项 UI~~** ✅ 已在 StyleAndEngineManager 增加「💰 LLM 成本预算」卡片（开关 + 月度上限）。后续如要按章复杂度自动切模型，可在 pipeline 按 `classifyChapterTier` 结果传 `options.model`（调用方显式传入才生效，不会意外换模型）。

### R4 · 数据模型演进无迁移框架（P1 · ✅ 已修复）
- **现状**：IndexedDB `DB_VERSION=2` 固定，项目 JSON 无 schema version，缺字段容错散落在多处 normalize。
- **修复**（`src/services/migrations.ts` + `storage.ts` 接入 + `BookProject.schemaVersion`）：
  1. **迁移注册表**：`CURRENT_SCHEMA_VERSION=1`；`migrateProjectToLatest` 逐级 vN→vN+1 纯函数迁移，无 version 存量数据 → v1（打版本标记，字段兼容仍由读取层 normalize 承担）；版本超前/非法值安全处理；缺迁移函数时抛错而非静默。
  2. **加载接入**：`loadProject` 检测到需迁移 → 迁移前自动快照（reason=`migration`，动态 import 避开 storage↔snapshots 循环依赖）→ 迁移后落盘 → 返回新版本。
  3. **快照类型**：`SnapshotReason` 新增 `'migration'` 分支 + label。
- **验证**：新增 `tests/migrations.test.ts` 5 例（存量迁移/已最新/超前/非法值/字段保持），113/113 全绿；tsc/lint/build 通过。
- **约定**：平时新增可选字段只走 normalize 不递增版本；结构性变更才递增并注册迁移。

### R5 · 多标签页并发无保护（P1 · ✅ 已修复）
- **修复**：新增 `src/services/crossTabLock.ts`（localStorage 抢占 + BroadcastChannel 心跳 + 75s 过期自动解锁），接入 `handleStartThreeStepWorkflow` 与 `handleStartAutoPilot` 的加锁/解锁点。页面崩溃后最长 75s 自动让锁。
- **验证**：两个标签页同时启动「三步」/Auto-Pilot 时，后者被阻止并提示。

### R6 · 本地文本精确替换脆弱（P2 · ✅ 已修复）
- **修复**：`applyLocalPatches` 返回 `failedDetails`（未命中原文片段 + 原因），`runConflictFixLoop` 在进度消息中展示失败条数与示例片段，避免「静默失败」。
- **残留风险**：用户手改正文导致模型所见与本地不一致时补丁仍会失败——已可见、可人工处理。

### R7 · 记忆多路回写一致性（P1 · ✅ 已修复）
- **现状**：同一事实可能同时在 recap、pinnedFacts、factLedger、角色卡、实体表中；死亡/道具归属已有双向同步（`syncDeathsBidirectional` / `syncLedgerEntitiesToMemory`），但章末 recap 的 keyFacts 是纯追加，与旧钉死事实矛盾时静默入库。
- **修复**（`src/services/memoryConsistency.ts` + `useChapterPipeline` 接入）：
  1. **detectRecapConflicts**：新 keyFacts vs 旧 pinnedFacts 矛盾检测——同主语（公共前缀 ≥2 字）下的生死反转（死↔复/假死）与归属冲突（归 A↔归 B）→ warn（合法反转需正文显式，不硬阻断）。
  2. **detectLedgerCharacterConflicts**：账本死亡断言 vs 角色卡状态不一致 → info 提示（方向约定：账本权威，章末同步会覆盖角色卡；提示避免静默覆盖）。
  3. **pipeline 接入**：章末回写前检测，冲突 → `statusMessage` 提示 + 记入 `memoryAudit.logicConflicts`（类型 `吃书矛盾`），不阻断流程。
- **验证**：新增 `tests/memoryConsistency.test.ts` 9 例，113/113 全绿；tsc/lint/build 通过。
- **说明**：设计稿的 B（写前预检）已由既有机制覆盖——正文生成后的审校阶段 `auditLog.hardReview`（含 `reconcileProseAgainstLedger` 账本对账）即「写后落盘前拦截」，故未重复实现。

### R8 · 服务端安全边界（P1 · ✅ 已修复）
- **已完成**：
  1. **CORS 白名单**：默认放行本机 localhost/127.0.0.1 任意端口（开发/预览），可用 `CORS_ORIGINS` 环境变量扩展（如局域网 IP），`CORS_ALLOW_LOCAL=false` 可关闭本机通配只信白名单。
  2. **R8-2 API Token 鉴权**：所有 `/api/*`（除 `/api/health` 探活）需 `x-api-token` 或 `Authorization: Bearer <token>`；token 首次启动自动生成于 `.novel-data/api-token`（32 字节 hex，gitignore 已覆盖），`API_TOKEN` 环境变量可显式指定；`sha256` 摘要后 `timingSafeEqual` 恒定时间比较（防时序侧信道/长度泄露）；Vite 代理转发时自动注入 `x-api-token`，前端代码无感；token 文件读写失败时降级为仅 CORS 保护并告警。
- **验证**（curl 实测）：health 无 token 200；config 无 token 401；带 x-api-token 200；错误 token 401；Bearer 200；经 Vite 代理(5173)无显式 token 200（注入生效）。
- **残留**：若将端口暴露到局域网/公网，还应配 HTTPS + 更强凭据轮换；本机场景已足够。

### R9 · 无自动化测试（P2 · ✅ 已修复）
- **现状**：`npm run build` 此前为**红色**——存在 11 处存量类型错误（`MemoryManager.tsx`×3、`aiTasteActions.ts`×4、`aiTasteScan.ts`×3、`aiEngine.ts`×1）。项目平时靠 dev 模式运行（esbuild/tsx 不做类型检查）所以一直没暴露。
- **已完成**：
  - **R9-1** 11 处类型错误已全部修复，`npm run build`（`tsc -b && vite build`）已**转绿**。修复方式均为纯类型层改动，不改运行时行为（详见 `git log` / 上轮总结）。
  - **R9-2 引入 vitest（v4.1.10，与 vite 8.1.5 兼容）+ 31 个单测全部通过**：
    - `tests/textDiff.test.ts`（8）— applyLocalPatches（命中/未命中/空 before/多补丁/failedDetails）、diffProseBlocks；
    - `tests/crossTabLock.test.ts`（7）— 幂等 acquire、他页同书拒绝、过期锁接管、异书不阻塞、release 后重获、隐私模式降级；
    - `tests/ruleScan.test.ts`（7）— 黑名单/白名单豁免/升华开关/tell/干净文本/开篇同质；
    - `tests/longformMemory.test.ts`（9）— selectRelevantDigests（未来块过滤/queryTerms 加权/近块优先/配额/max）、formatDigestsForPrompt。
  - **测试驱动发现并修复 1 个真实 bug**：`crossTabLock` 隐私模式（localStorage 抛错）下，写后复核把「读不到锁」误判为抢占失败 → 降级失效，单机单页也无法使用。已修复：storage 不可读/被清空时视为降级允许。
  - **R9-3 补三个服务单测（新增 54 个，累计 99 个）**：
    - `tests/factGuard.test.ts`（19）— runLocalFactGuard（过短跳过/阵亡行动 error/回忆语境降 warn/闭关高强度 warn/钉死事实否定 error/已作废事实豁免/must-avoid 命中与空表）、factGuardHitsToHardIssues 前缀、mergeHardWithLocalGuard（本地 error 必不通过/source 合并）、evaluateRecapQuality（无 recap 分章阻断/短正文放宽/过短/缺 keyFacts 阶梯/fallback 阻断/合格通过）；
    - `tests/draftBackup.test.ts`（10）— 空正文不写、wordCount 去空白、clear 精确清除、draft: 前缀过滤、脏 value 过滤、projectId 过滤 + updatedAt 倒序、超期/非法时间清理、去抖合并（fake timers）、flush 立即冲刷；
    - `tests/aiTasteScan.test.ts`（25）— 干净文本 clean/100、Gate G 解释腔/白名单过滤/heavy 级、blockHeavy 阻断、Gate B 句式/否定翻转升 error/strict 升 error、Gate D 排比 warn/双组升 error、Gate E 对话标签过密、mergeExtendedBlacklist（默认/白名单/关闭扩展表）、mergeAiTasteIntoRuleHits 取最大 count、applyAiTasteHitsAsRevisionTodos（errorsOnly/标签映射/去重/medium 补充/max 截断）、findProseSnippetRange（精确/降级/未命中/空入参）。
    - 测试中修正 1 处实现理解：`countParallelRuns` 的 runs 仅在 streak 恰好为 3 时 +1，故「连续 4 段」只有 1 run，≥2 需两组独立排比（测试按真实行为构造，未改实现）。
- **验证**：`npm test` 99/99 通过（9 个测试文件）；`tsc -b` 0 错误；oxlint 12 个既有 warning 不变、0 errors；`vite build` 326ms 转绿。
- **收尾**：核心服务层已有覆盖——textDiff / crossTabLock / ruleScan / longformMemory / coalescedWriter / snapshots / factGuard / draftBackup / aiTasteScan。

### R10 · server watch 只盯 3 个文件（P2 · ✅ 已修复）
- **修复**：`package.json` 的 server 脚本改为 `tsx watch --watch-path ./server ./server/index.ts`，新增 server 文件也会触发重启。

## 本次会话已完成
- [x] R5 跨标签生成锁（新增 `crossTabLock.ts` + App 接入）
- [x] R6 局部补丁失败可见化（`textDiff.ts` + `aiEngine.ts`）
- [x] R8 CORS 白名单（`server/index.ts`，env 可配置）
- [x] R10 server 全目录热重载（`package.json`）
- [x] R9-1 存量类型错误清零（4 文件 11 处，`npm run build` 转绿）
- [x] R2-1 流式草稿备份与恢复（新增 `draftBackup.ts` + App 接入，P0 项）
- [x] R9-2 引入 vitest + 31 个单测；测试驱动修复 crossTabLock 隐私模式降级 bug
- [x] R2-2 快照 gzip 压缩 + 旧快照后台迁移 + 项目级上限可配置（新增 8 个单测）
- [x] R2-3 全书写入合并（新增 `coalescedWriter.ts`，突发写合并；新增 6 个单测）—— R2 全项收尾 ✅
- [x] R8-2 API Token 鉴权（server 中间件 + Vite 代理注入 + curl 实测 6 项）—— R8 全项收尾 ✅
- [x] R1 拆分第一步：落盘/管线/Auto-Pilot 三个 hook（App.tsx 3262→2197，-1065 行；逻辑零改动，45 测试全绿）
- [x] R1 拆分第二步：项目生命周期+导入导出域 → `useProjectActions`（App.tsx 2197→1819，-378 行；逻辑零改动，45 测试全绿）
- [x] R1 拆分第三步：章节动作域 → `useChapterActions`（App.tsx 1819→888，-931 行；逻辑零改动，45 测试全绿）
- [x] R1 拆分第四步：JSX 容器拆分 → `WorkspaceTab` / `WorldBibleTab`（App.tsx 888→802；45 测试全绿）—— R1 全项收尾 ✅
- [x] R9-3 补 factGuard / draftBackup / aiTasteScan 单测（新增 54 个；99/99 全绿）—— R9 全项收尾 ✅
- [x] R3 收尾：预算配置 UI 表单 + 后端 body.model 覆盖（llmService/index.ts 透传 + llmClient `options.model`；新增 2 测，160/160）+ git init 首次提交（bef4051，139 文件）—— **全部风险项闭环 ✅**
- [x] R4 schema 迁移框架（`migrations.ts` + storage 接入 + 迁移前快照；新增 5 测，104/104）—— R4 全项收尾 ✅
- [x] R7 记忆回写一致性（`memoryConsistency.ts` 冲突检测 + pipeline 接入；新增 9 测，113/113）—— R7 全项收尾 ✅
- [x] R3-A LLM 韧性（`llmResilience.ts` 超时/重试/流式恢复 + `conservativeProse.ts` 保守稿降级链；新增 21 测，134/134）—— R3-A 收尾 ✅
- [x] R3-B 成本控制（`costControl.ts` 估算/预算闸门/分级 + `UsageBadge` 看板；新增 25 测，159/159）—— **R3 全项收尾 ✅**

## 下一步建议顺序
1. 收尾项：StyleAndEngineManager 加预算配置表单（`llmBudgetEnabled`/`llmMonthlyBudgetCny`，小，半轮）；后端 `/api/llm/generate` 支持 body.model 覆盖（让 tier 分级真正切模型）
2. 可选：git init + 首次提交（当前仍无 git 仓库）
