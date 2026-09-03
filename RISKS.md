# InkMind 风险点清单与修复跟踪

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
  3. **F1 监听绑定回环**：`app.listen` 显式绑定 `127.0.0.1`（默认），不再默认监听所有网卡；`HOST` 环境变量可显式覆盖（如 `0.0.0.0` 供局域网），非回环绑定启动时打印醒目风险提示；`PORT` 顺带 `Number()` 化以适配带 hostname 的 `listen` 重载。
  4. **F2 鉴权 fail-closed**：token 文件不可读写/生成时，不再「退化为仅 CORS 保护」（即鉴权完全关闭）；改为除 `/api/health` 外所有 `/api/*` 返回 503 并给出修复指引，仅当 `ALLOW_NO_AUTH=1` 显式开启才允许无鉴权运行（启动打印醒目警告）。`safeEqual` / `extractToken` / 同源豁免逻辑不变。
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
- [x] **字数不达标修复（用户反馈"设定章字数但写作不遵守"）**——诊断确认三层原因，全部处理：
  - **主犯：全链路从未传 max_tokens**——输出上限由服务商/中转默认值决定（常见 4096 token ≈ 2000+ 中文字截断），目标 3000 字物理写不完。修复：`callLLMService` 默认带 `max_tokens=8192`（环境变量 `NOVEL_LLM_MAX_TOKENS` 可调），流式/非流式都带
  - **截断不再无声**：流式解析 finish_reason，`length`（被截断）时 server 控制台告警 + SSE 透传 `{finish}` 帧 + 前端状态条提示（"输出被模型上限截断…调大 NOVEL_LLM_MAX_TOKENS 或换模型"）——以前截断被当成正常完成
  - **补写轮收紧**：writer/auditor 补写轮 2→3（单轮续写也受输出上限约束，约 1500-2500 字/轮）；补写 prompt 本就带精确缺口数字（"还差约 N 字"）无需改
  - 验证：231/231 全绿；tsc 0 错误；dev server 热重载健康检查 200
  - 注意：中转站可能在服务端无视/钳制 max_tokens——若状态条出现截断提示且调大无效，即中转上限，换官方端点即解
  - 执笔 prompt 增「题材优先规则」：档案的题材性机制与题材规则包冲突时以题材包为准，文笔层始终执行——即使用户在全档案下写其他题材也有兜底
  - 验证：231/231 全绿（新增拆层断言：指南不含机制名、范文无恐怖悬疑段）
- [x] **内核收尾三件（解释腔换皮 / 分数锚定 / 节奏修复链路）**：
  - **解释腔换皮正则 ×3**（Gate G 扩容）：判断句解说「(那|这)是……的(位置|道理|规矩…)」、叙述者定性「仿佛只是在陈述/说明/宣告…」（注意"只是"含"是"）、否定解说「没有做出(任何)(多余的)解释/反应/停顿」——三类换皮解释腔此前全绿漏检（你稿子的真实病例全部命中）；测试用真实病例句子做夹具 4 例 + 不误伤反例
  - **分数锚定校准**：硬伤审加打分锚点（零冲突 95-100 / 仅 warn 80-90 / 1 error 55-70 / 多 error <55，"先归类区间再给分，禁止无解释中间分"）；文笔审 styleScore 加锚（90+ 可发布 / <70 建议重写）；推进度审加"同章两读同区间"纪律——压 LLM 自报分数方差
  - **节奏修复链路接通**：极端句式单调（句均>20 字且 CV<0.6）从 warn 升 **error** → 规则机检不过 → 进修复环 → 补丁修不动触发 beat 级重写——"查得出病开不出药"的错配补上
  - 验证：230/230 全绿（+4）；tsc 0 错误；lint 12 基线；build 绿
- [x] **文风引擎第二批（语感层：「文笔的感觉」）**：
  - StyleProfile 新增 `sampleExcerpts` 多场景范文；预设补 4 段实测选段（恐怖×日常并置 / 对白立人 / 悬疑起势与物件异常收尾 / 环境白描与生活化比喻），注入时带场景标签——单段样本锚不住语感，分场景锚
  - styleGuide 增第七条「语感质感」：白描+具体名词（煤油灯/黄包车/绣图）、生活化比喻（"像一条趴着的黑狗"，禁"如寒冰般"文学腔）、环境只写一个错位细节、动作写过程链不写结果形容、对白带身份感、情绪落在身体与物件上
  - formatStyleProfileForPrompt 多段注入（≤3 段×400 字带标签）；文笔审升级为**向档案收敛**（第 10 条：偏离语感的段落改写贴齐——长句拆短/文学腔比喻改生活化/抽象名词改具体物件，附参照选段），不再只是"别破坏"
  - 新增/调整 2 例测试：226/226 全绿；tsc 0 错误；lint 12 基线；build 绿
- [x] **文风引擎第一批（《我不是戏神》写法接入 + 正面文风优先）**：
  - **内置文风档案**（`src/services/stylePresets.ts`）：「我不是戏神·黑色幽默流」——统计指纹用项目自带 analyzeStyleFingerprint 对原著抽样 12 章（1→1900 章跨全书）实测（句均 15.7 字/中位 7 字/短句 59%/对白 25%/每句 0.94 逗号），与引擎注入目标同口径；styleGuide 为六机制可执行化（短句冲锋枪节奏/恐怖×日常并置/对白扛剧情/动词优先/省略号节奏器官/章末双钩），doList/dontList 各 6/5 条，范文选段取第 1 章名场面；文风仿写面板新增「内置档案」一键导入（免 LLM 分析，导入即激活+同步 few-shot）
  - **执笔 prompt 双模重构**：激活档案时切换「正面示范优先」结构——文风档案+范文放最前并声明第一优先级，12 条铁律压缩为 4 条事实/结构红线，黑名单/Show Don't Tell/反升华喊话撤出 prompt（写后机检兜底，注意力全部让给文风）；未激活档案时保持原结构不变
  - **文风感知纪律豁免**：StyleProfile 新增 `punctuationTolerance`；'ellipsis-emphatic' 档案激活时 validatePostWrite 豁免破折号 error（Auditor/Reviser 同口径），文笔审 prompt 注入「省略号与短句为节奏器官、不得删除合并」保护条款——通用去 AI 味规则不再误伤特定文风
  - **句子级节奏机检**：aiTasteScan 新增 sentenceLenMean/sentenceLenCv/shortSentenceRatio 指标 + `[D]句式节奏单调` 检查（句均>18 字且变异系数<0.7）——补上"段长有变化但句句同构"的检测盲区（此前你稿子句均 32 字/系数 0.55 全绿）
  - 新增 `tests/stylePresets.test.ts` 5 例 + aiTasteScan 节奏 2 例：225/225 全绿；tsc 0 错误；lint 12 基线；build 绿
  - 遗留提醒：写作业余建议换 DeepSeek/GLM 官方端点（中转站 gpt-4o 是文笔上限的最大瓶颈，档案再好也补不回模型差距）
- [x] **UI 简化第一批（用户反馈「繁琐」，方案 A 渐进披露 + B 文案人话化 + C 顶栏去重）**：
  - **右栏渐进披露**：跨章抽检 / 写作仪表盘 / 写前检查默认折叠成一行状态摘要（如「健康 90 · 均章 1035字」「缺料 · 25分」）；待修清单改为「有未完成项才展开」；角色状态更新 / 章末 Recap / 设定切片三个只读信息区改为可折叠（默认收起，头部带状态徽标）——右栏从「8 块全展开、30+ 控件、9 段说明小字」降为「动作区 + 写前大纲 + 7 行摘要 + 分镜」
  - **文案人话化**：「防幻觉三步推理创作引擎」→「AI 写作」；页签「沉浸创作台/设定与角色图谱/大纲剧情链/去 AI 味与后端配置」→「写作/设定与角色/大纲/设置」；「写前上下文体检」→「写前检查」；「启动本章闭环（单章）」→「写这一章」；进度提示去术语（「正在流式生成正文（Show Don't Tell + 黑名单约束）」→「正在写作正文」）；4 个状态徽标合并进头部一枚；侧栏「记忆切片就绪」、画布长提示句收敛为 title 悬浮
  - **顶栏去重**：今日日更/双进度条/待修角标移除（仪表盘内已有），全书进度收敛为一行三段式
  - 验证：218/218 测试；tsc 0 错误；build 绿；浏览器实测前后 DOM 对比确认折叠与文案生效
- [x] **信任与体验第一批（备份/性能/编排测试）**：
  - **章末自动备份到磁盘**：`server/backupService.ts`（POST /api/backup 写 `.novel-data/backups/{projectId}-{时间戳}.novel.json`，每书保留 20 份自动修剪，projectId 白名单校验防路径穿越，9MB 上限）+ `src/services/autoBackup.ts`（章末触发、15s 去抖合并连写、失败静默下次重试）；curl 实测：写入/列表/无 token 401/非法 id 400 全过；修复列表 projectId 解析与 kept 计数两处小 bug。IndexedDB 被清不再是单点灭失
  - **性能三件套**：①流式 UI 120ms 节流（此前每 chunk 全项目 setState；首 chunk 立即上屏+尾随冲刷；草稿备份自带 800ms 去抖不受影响）②击键落盘防抖（`handleUpdateAndPersistProjectDebounced`：状态立即、落盘 400ms 窗口；破坏性操作仍走立即落盘；页面隐藏兜底冲刷）+ **书列表 TTL 缓存**（listProjects 此前每次落盘全库 getAll 反序列化所有书；3s TTL + save/delete 即刻失效）③章列表增量渲染（首屏 200 条+「显示更多」步进 200，平铺/卷分组两路径；搜索时全量显示）
  - **引擎管线集成测试**（`tests/enginePipeline.test.ts` 5 例，mock llmClient 按 prompt 标记路由）：全绿自动锁章 / 推进度弱压分待人工 / 硬伤补丁修复复检绿通 / 机检两轮修不动→beat 级重写→绿通 / 执笔失败保守稿不锁章——编排层（分段审/复硬审/升级档所在）首次有回归保护
  - 验证：218/218 测试（+5）；tsc 0 错误；oxlint 12 既有 warning；vite build 绿
- [x] **本地质量门禁（替代云端 CI，无 GitHub 依赖）**：`.githooks/`（core.hooksPath 指向仓库内目录，随仓库版本化、npm install 经 prepare 自动安装）——commit 前 `tsc -b` 增量类型检查（实测 3s 内），push 前全量测试+构建；`--no-verify` 可急事跳过。实测：干净代码过 ✓、故意类型错误拦截 exit 1 ✓、清理后恢复 ✓。此前 213 测试/strict/build 四道门只靠手动跑（R9 曾因只跑 dev 模式漏过 11 处类型错误），现在想跳都跳不过
- [x] **引擎深化收尾（2 项残留）**：
  - **推进度审开关**：`StyleConfig.progressionReviewEnabled`（默认开）；风格配置「LLM 成本预算」卡片内可关——关闭后 step3 跳过推进度审且不阻断绿通（省每章 1 次调用，代价是「水章」不再拦截）
  - **账本补抽分段**：抽通用分段器 `src/services/proseSegments.ts`（硬伤审与账本共用，参数化 limit/overlap）；`enrichSnapshotWithLlm` 弃用「头 2000 + 尾 2000」截断，改为 4500/300 分段逐段抽取 + 跨段去重合并（段间互相可见已抽断言防重复）；超长章最多 6 段防失控；部分段失败保留已抽结果；新增通用分段器 2 例测试
  - 验证：213/213 测试（+2）；tsc 0 错误；oxlint 12 既有 warning；vite build 绿
- [x] **引擎深化第一批（内核审查后 5 项）**：
  - **绿通纯函数单测**（新增 `tests/engineGates.test.ts` 31 例）：isDualReviewGreen 三重门全分支 / isVerificationScoreGreen / isHardReviewApiBlock / needsConflictFix / collectFixConflicts（软线索过滤·轮次策略·去重）/ validatePostWrite 5 规则——此前引擎核心零覆盖，改坏无信号
  - **硬伤审分段送审**：>7000 字按段落边界拆段（相邻段 400 字重叠）逐段审再合并（全过才过、分取最差、issue 标注段位）；prompt 增分段说明（段首承接不算问题）——消灭「截头去尾」中段盲区；≤7000 字行为不变不加调用；新增 `tests/hardReviewSegments.test.ts` 6 例（单段/多段/上限/重叠/全覆盖）
  - **审计与润色分离**：润色不再是无声二次执笔——`polishDiff`（字数/句子增删）留痕进 auditLog；重大改动（±8% 字数或删句>5）自动**对润色稿复硬审**，绿通以最终交付稿为准
  - **推进度审**（新增第四路审校信号）：分镜完成度/主线推进/注水度/伏笔触达；弱推进（<60 或注水≥8）压分 70 阻断自动锁章（与 recap 弱同处置）；API 失败降级不阻断（质量闸非安全闸）；通过线不信任模型自报，确定性规则推导
  - **修复升级档**：补丁轮修不动且非纯 API 阻断 → beat 级重写（只重写相关场景、其余原样保留；重写稿过短视为失败保留原文）；重写后复机检并入 fixHistory；pipeline 向 Reviser 传 beats
  - 验证：211/211 测试通过（+37）；tsc 0 错误；oxlint 12 既有 warning；vite build 绿；engine/README 阶段表同步（含 post_validate 实际位置）
- [x] **产品化第二批（安全收尾 + 单文件分发）**：
  - **主密钥机器绑定**（`server/llmService.ts`）：不再生成/读取 `.secret` 明文文件，密钥改由机器指纹（Windows MachineGuid / macOS IOPlatformUUID / Linux machine-id）+ 用户名派生；启动时一次性迁移（旧钥解密 → 机器钥重加密 → 删除 .secret），迁移失败则运行时旧钥兜底不中断；已在真实数据上验证（密文重加密 ✓、.secret 删除 ✓、二次启动纯机器钥解密 ✓）。**.novel-data 整目录被拷走也无法在别处解密**
  - **旧密文残留清理**：`server/data/` 迁移完成后连同旧 config.json/.secret 一并删除（此前只复制不删，密钥副本永久残留）
  - **单文件可执行打包（Node SEA）**：`npm run build:exe` → `release/novel-studio.exe` + `dist/` + 使用说明；esbuild 打包 server → SEA blob 注入 node.exe 副本；**免装 Node、双击即用**，exe 态自动开浏览器（NOVEL_OPEN=0 关 / =1 强制）、端口占用给出人话提示、数据自动落 exe 旁 `.novel-data/`
  - **单进程鉴权修复（重要）**：静态托管形态下前端请求不带 token（token 注入原是 Vite 代理做的）→ 全部 401。新增同源豁免：`Sec-Fetch-Site: same-origin/none` 或 Origin 同源或本机非浏览器调用放行；跨源（恶意网页）仍强制 token。实测矩阵：本机无头 200 / 跨站无 token 401 / 跨站带 token 200
  - 验证：174/174 测试；tsc -b --force 0 错误；oxlint 12 既有 warning；exe 实测从任意目录启动、静态页/鉴权/数据落位全过
  - 残留：server 端无 vitest 覆盖（llmService 会读写真实 .novel-data，需先做 DATA_DIR 环境变量隔离——收益中等暂缓）；exe 未签名（SmartScreen 可能提示"未知发布者"，属 Windows 常态）；打包脚本仅 Windows（exe 名固定 .exe；mac/linux 需按平台复制对应 node 二进制）
- [x] **产品化第一批（审查后 P0 修复）**：
  - 构建产物可用：Express 托管 `dist/` + SPA 回退（`npm start` 单进程跑完整应用）；`vite preview` 补 `/api` 代理；README 从 Vite 模板重写为产品说明
  - **向量检索真接线**：新增 `src/services/embeddingIndex.ts` —— 写章主链路（useChapterPipeline 三处检索点）经 `retrieveMemoryForChapterAsync` 走真·Embedding 向量检索（文档向量按项目+模型缓存在 IndexedDB meta store，仅新增文档与 query 调 API，同项目并发去重）；未启用/失败自动降级本地 TF-IDF，写作不中断；`MemoryQueryInput` 增 `semantic` 预计算覆盖参数（同步调用方不变）；UI 文案改为如实描述（含降级行为）；新增 `tests/embeddingIndex.test.ts` 4 例
  - 类型门禁收紧：三份 tsconfig 全开 `strict`；新增 `tsconfig.server.json` 把 `server/` 纳入 `tsc -b`（此前完全不做类型检查）；修复 3 处错误，全绿
  - 隐私警告：`StyleAndEngineManager` LLM/Embedding Base URL 命中非官方域名名单时显示「正文/设定/记忆将全文发送到该服务器」警示；保存向量配置后 `invalidateEmbeddingConfigCache()` 立即生效
  - 验证：174/174 测试通过；`tsc -b --force` 0 错误；`vite build` 绿；oxlint 12 既有 warning 不变；curl 实测单进程形态（/ 返回 index.html、/api/health 200、无 token /api/config/llm 401）
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
- [x] **F4 customHeaders 防覆盖**（`server/llmService.ts` generate 与 models 的 headers 构造）：受保护头（Authorization/Content-Type）最后强制，customHeaders 中 `Host`/`Content-Length`/`Authorization` 等危险键（大小写不敏感）被过滤，无法覆盖真实认证头
- [x] **F5 卫生项**：`.gitignore` 追加 `.env` 与 `.env.*`；`package.json`/`package-lock.json` 移除零引用死依赖 `dotenv`（全仓无 import）

## 审查驱动修复批次（取消能力 + 安全 + 数据一致性）

> 深度审查（清单外问题）后的第一批修复。全部经 tsc strict / 237 测试 / lint / build 四道门验证。

### A · 生成链路可中止（原 P0：停止按钮是假的）
- **韧性层**（`src/services/llmResilience.ts`）：`fetchWithTimeout` 新增第 4 参外部 `AbortSignal`，与超时共用内部 controller；外部中止抛新增的 `GenerationAbortedError`（**不可重试**，先于一切 Abort 判定）。超时仍抛 `TimeoutError`（可重试），两者互不误判。
- **llmClient**：`GenerateOptions.signal` 显式信号 + `setActiveAbortSignal/getActiveAbortSignal` 管线级活动信号上下文（模式同用量归属，免穿 aiEngine/agents 全部签名；嵌套安全——pipeline 退出时恢复外层信号）。中止的调用**不计费用**（成功/失败照记）；流式 `streamOnce` 重构：read 竞态加入 abort 分支、中止/中断路径一律 `reader.cancel()` 释放连接（修复悬挂连接继续烧上游）、服务端 error 帧改类型化判断（不再靠 message 含"JSON"的脆弱启发式吞错）。
- **引擎**（`src/engine/pipeline.ts` + types）：输入新增 `signal`；启动前快失败 + 每阶段边界 `throwIfAborted()`；writerAgent 对中止错误**放行不降级保守稿**；中止结果语义 = `ok:false + errorMessage:'用户已停止生成'`（非 API 失败），已流式产出部分由 App 层既有失败路径保留为草稿。
- **App 层**：App 持有共享 `generationAbortRef`；单章三步与 Auto-Pilot 各建 AbortController 传入管线；AP 停止 = 中断当前章 + 循环停机（不再"写完这章才停"，且以 user_abort 而非 api_error 收尾）；`AIWorkflowPanel` 停止按钮在单章生成时也渲染（此前仅 AP 可见）。注意 `handleStopGeneration` 必须位于条件 return 前（rules-of-hooks）。
- **服务端**（`server/index.ts` + llmService）：`/api/llm/generate` 监听 `res 'close'/'error'` → abort 上游（前端停止/页面关闭即停止后端→上游的计费流）；`callLLMService` 及 embeddings/models 三处上游 fetch 全部接 `AbortSignal.any([timeout, clientSignal])`——上游硬超时默认 10 分钟（`NOVEL_LLM_TIMEOUT_MS` 可调）、models 探测 30s。修复"前端放弃后后端仍完整跑完全额计费 / 上游挂死连接累积"。

### B · 数据一致性
- **四处陈旧快照整表回写 → 函数式更新**（`useChapterActions.ts`：AI修待修 / 本章扫描 / 本章批量去味 / 全书去味 / 单点去味共 5 处）：await 数分钟的 LLM 任务完成后改为 `(prev)=>` 按 id 合并进最新 chapters——修复任务期间用户编辑被 pre-await 快照静默回滚的数据丢失 bug（全书去味最长 20 章×多次调用，窗口最大）。
- **saveProject 以事务提交为准**（`storage.ts`）：resolve 从 `request.onsuccess` 移到 `tx.oncomplete`，commit 失败（QuotaExceededError）正确 reject，兑现"resolve 即已落盘"不变量。
- **迁移前快照顺序修正**（storage + migrations）：新增 `peekMigration` 只预检不执行；先打迁移前快照再执行 `migrateProjectToLatest`——快照保护覆盖"迁移函数本身 throw"这条最需要它的路径（此前顺序颠倒，throw 时书本直接打不开且无备份）。版本超前（降级场景）显式 console.warn。

### C · 服务端安全
- **同源豁免改 Host 本机白名单**（防 DNS rebinding）：旧逻辑比较「Origin host === Host header」——两个都是客户端可控头，rebinding 域名解析 127.0.0.1 后即绕过 token 并可把带存储密钥的请求导向攻击者端点。新逻辑：Host hostname 必须 ∈ {localhost,127.0.0.1,[::1]}（Origin 同样校验）；Sec-Fetch-Site 非 same-origin/none 一律要 token。局域网同源部署用 `TRUSTED_HOSTS` 环境变量显式加白（安全默认关闭）。

### D · 健壮性收尾
- **编排入口补 catch**：`handleGenerateChapterIntent`（此前 API 失败 = unhandled rejection，状态条永久卡在"生成写前大纲..."）、本章/全书 AI 味扫描两处 try/finally 补 catch——失败现在有明确状态提示。
- **测试 +6（237/237）**：fetchWithTimeout 外部 signal 已中止/运行中中止 → GenerationAbortedError 且不误判超时；GenerationAbortedError 不可重试（withRetry 立即抛出）；isGenerationAborted 判定；管线启动前已中止快速失败零 LLM 调用；Writer 阶段中止穿透 → 停止语义、不锁章、不降级保守稿。
- lint 基线 12 → 11 warnings（顺手清掉 llmClient 未使用 catch 绑定）。

### 遗留（下批候选，按价值排序）
- [ ] listSnapshots 全量反序列化 projectGz（meta 拆独立 store 或 key-only cursor）
- [ ] initDB 连接单例化 + onblocked 显式处理（DB_VERSION 升级防挂死）
- [ ] 重试重复计费：每次 attempt 记 ok:false 用量 + 非流式超时重试的计费风险说明
- [x] SSRF 收敛（F3）：baseURL 强制 http(s)；链路本地段（IPv4 169.254/16、IPv6 fe80::/10）与云元数据地址（169.254.169.254）始终阻断；回环/私网默认放行、`BLOCK_PRIVATE_LLM_BASE=1` 可收紧阻断；校验在保存配置与上游请求两处生效（防御纵深）；探测不同地址且未显式传有效 key 时不回退已存密钥（防密钥外泄）——见 `server/llmSecurity.ts` + `server/llmService.ts`，单测 `tests/llmSecurity.test.ts`
- [ ] projectTransfer / chapterLock 单测（数据安全最后防线零覆盖）

## 下一步建议顺序
1. 收尾项：StyleAndEngineManager 加预算配置表单（`llmBudgetEnabled`/`llmMonthlyBudgetCny`，小，半轮）；后端 `/api/llm/generate` 支持 body.model 覆盖（让 tier 分级真正切模型）——已完成，见上文 R3 收尾与本批次记录
2. ~~可选：git init + 首次提交~~ 已完成（bef4051）；后续按批次提交审查驱动修复
