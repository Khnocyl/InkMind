# 代码复审报告（2026-09-25）

## 审查范围与方式

- **范围**：`CODE_REVIEW_2026-09-18.md` 之后**未提交的全部工作区改动**（无新提交）
  - 16 个修改文件（+359/−46）+ 2 个新服务（`projectLimits.ts` / `wizardConfig.ts`）+ 7 个新测试文件
  - 内容上分四组：① 09-18 报告 P2-1/P3-1/P3-2 的修复落盘；② 跨章抽检「检查窗口」可调（新功能）；
    ③ 事实账本死亡判定收紧 + 手动钉死优先；④ 目标章数上限单一来源 + 向导配置保全 + 召回 topK 3→6
- **方式**：4 路并行只读深审（跨章窗口端到端 / factLedger / 向导与章数上限 / 遗留问题状态核查），
  逐条回源码；关键结论用**探针脚本实证**（死亡判定 9 个中文例句实跑，非心算）。
- **基线门禁**：`tsc -b` 0 错误 · `vitest` **840/840**（72 文件，较上轮 +31 例）· `oxlint` 0 errors / 19 warnings · `vite build` ✓
- 审查后已按「建议立刻改」清单完成一轮修复（见第六节），修复后门禁 **848/848**。

---

## 一、先说结论

这批工作**整体质量高**：09-18 的三个问题（P2-1 硬规显示 / P3-1 清除参考源错误处理 / P3-2 抽样超预算）
全部修复到位且有新测试锁住（`vitest` 809→840）；跨章窗口、章数上限、向导保全三个新功能的
**动机声明逐条核实属实**（整表替换确证无 merge 层；Auto-Pilot 不读窗口有测试锁；clamp 无裸值泄漏路径）。

但 factLedger 死亡判定这组改动**有一处 P1**：注释承诺覆盖「以为」句式，词表里却没有——
探针实测「众人以为阿岚已死，原来他还活着」**仍记死亡**，并级联到角色卡自动「已阵亡/退出」
（`syncDeathsFromLedgerToCharacters`，`factLedger.ts:1441`）+ 写前 prompt 按「绝对禁止推翻」注入。
这恰是本次改动声称要消灭的事故，且无测试守卫。

---

## 二、发现的问题

### P1-1 · 死亡判定假阳性：注释承诺「以为」，词表缺席

**位置**：`src/services/factLedger.ts:279`（注释）vs `:285-286`（`DEATH_WEAKEN_RE`）

```js
// 注释：…没有弱化词（差点/险些/若/如果/诈死/**以为**/传说…）
const DEATH_WEAKEN_RE = /差点|险些|几乎|…|变故/;   // ← 没有「以为」，也没有「都当/只当/误以为」
```

**探针实证**（`extractDeathFromText` 实跑）：

| 例句 | 结果 |
|---|---|
| 「众人以为阿岚已死，原来他还活着。」 | **记 death** ❌ |
| 「世人都以为凌霄已死。」 | **记 death** ❌ |
| 「大家都当云曦已死，她却踏入山门。」 | **记 death** ❌ |

「以为/误以为/都当/只当」是小说里最高频的误导句式。假阳性 death 断言会：
① 经 `syncDeathsFromLedgerToCharacters`（`:1441`）把角色卡自动改为「已阵亡/退出」；
② 经 `formatFactLedgerForPrompt` 作为硬事实注入写前 prompt；③ 下章 `reconcileProseAgainstLedger`
把活人行动报成 error。**该句式无任何测试锁住**（`tests/factLedgerDeath.test.ts` 8 例均不含）。

**建议改法**：词表补 `以为|误以为|都当|只当|错当`；补例句测试。

### P2-1 · lead 窗口 4 字过窄：回忆/时间语境在 4 字外全部漏防

**位置**：`src/services/factLedger.ts:301` `blob.slice(Math.max(0, m.index - 4), m.index)`

**探针实证**：「三年前他亲眼看云曦死去，至今难忘。」→ lead=`他亲眼看`，无弱化词 → **记 death**。
「三年前那次大战中，X陨落」「据传闻…」等前置语境（>4 字）都防不住。注释声称覆盖「回忆杀」，
但「想起/当年/曾经」只有恰好落在前 4 字或 between 里才生效。

**建议改法**：lead 窗口 4→12，或回溯至句首/逗号后取定长；补例句测试。

### P2-2 · 大纲生成链路仍写死 500 上限：口径分裂从 UI 层转移到管线层

**位置**：`src/services/prompts.ts:297-303` `resolveOutlineTotalChapters` 返回 `Math.min(500, …)`；
消费点 `outlineGenerate.ts:362/:684`、`prompts.ts:331`。

本次改动把向导/设置页的目标章数上限放开到 5000，但用户设 3000 章后拆章只会生成 **500 章**，
`OutlineReviewStep.tsx:185-192` 显示「与目标差 -2500 章」。这正是本次改动声称消灭的
「同一字段两个口径、静默降级」，且 `projectLimits.test.ts` 的源码扫描守不住这一处。

**建议改法**：该 cap 有 token/轮次保护的合理性（5000 章 ≈ 250 批调用），不宜盲改——
要么 UI 口径对齐大纲能力上限并在提交时提示，要么提高 cap + 批次保护。需产品决策。

**→ 已处置（2026-09-25 产品决策，见第六节）**：保留 500 上限，把「全书目标」与「单次自动拆章」
两个语义拆开，上限收敛为单一来源 `OUTLINE_GENERATE_MAX_CHAPTERS`，向导滑杆与大纲审阅页如实提示。

### P3 组（factLedger，均探针实证）

| # | 问题 | 证据 |
|---|---|---|
| P3-1 | revive 窗口 10 字边界截断：「阿岚陨落，但谁都知道她还会复活归来。」→ after=`…还会复`，差 1 字记 death | `:308` 窗口改 12–14 即可覆盖 |
| P3-2 | 弱化词「变故」误吞真死：「家逢变故，林父气绝身亡。」→ lead=`逢变故，` 命中 → 漏检 | `:285` 词表权衡未在注释说明 |
| P3-3 | 主语混淆窗口 0,8→0,16 **翻倍**：「阿岚亲眼看着师尊在眼前陨落。」→ 给阿岚记 death（死者是师尊） | 旧问题但本次扩大；目睹动词（看着/亲眼见/送/埋）不在弱化表 |
| P3-4 | keyFacts 死亡路径完全未收紧（`:440-452` 裸正则、无名字锚定），回忆杀 keyFact 会产出 subject=「阿岚便是」的 death；测试用 `note==='from_text'` 过滤恰好整体排除该路径 | 非回归，但架空改动目标 |

**观察**：死亡词表 7 词（身亡/阵亡/已死/死去/陨落/毙命/气绝）**不含最常见写法「死了」「葬身/殒命/丧命/断气」**
——「阿岚死了。」不触发（HEAD 同码，非回归；`:377` 注释「X死了 / X身亡」与实际能力不符）。

**factLedger 注释不实（顺手改）**：`:567` 「手钉的 kind:'other'」——`FactAssertionKind` 无 'other'，最低 rank 手动 kind 是 'event'；`:572` 「绝不自动淘汰」言过其实——手动条目自身 >120 条时仍按章号降序淘汰（`syncDeathsFromCharactersToLedger` 批量同步即可触达）。

### P3 组（跨章窗口 / 章数上限，回源码确认）

| # | 问题 | 位置 |
|---|---|---|
| P3-5 | 面板显示不一致：本地路径存了窗口 100 → 重开面板（useLlm 默认 true）→ **输入框 100 + 标签「近 30 章」并存**（state 初始化 clamp 不带 options，标签用 effectiveWindow）。运行值永远正确、blur/再跑自愈 | `CrossChapterAuditPanel.tsx:61-63/:169/:176` |
| P3-6 | 展开着抽检折叠行时**切换书籍**：面板不卸载（`AIWorkflowPanel` 用 `hidden` 保挂载、全链路无 `key={project.id}`）→ `windowChapters` 停留 A 书值，继续运行把 A 书窗口写进 B 书 config。代码证据充分，建议实测复现 | `AIWorkflowPanel.tsx:301-302`、`App.tsx` 无 key |
| P3-7 | 设置页数字输入用 `MAX_TARGET_CHAPTERS` 常量而非 `effectiveTargetChapterMax`：存量导入值 >5000 时，用户按一下**上箭头**反被 clamp 到 5000（违反 projectLimits.ts:21-26 自 declare 的不变量） | `StyleAndEngineManager.tsx:1942/:1950` |
| P3-8 | 滑杆 step 网格盲区：非 10 倍数值真实可达（设置页 step=1 / 拆书 `chapters.length` / 导入）→ 滑块吸附 3330 而标签显示 3333，一碰静默改值；max off-grid（5999）是 `effectiveTargetChapterMax` 新引入 | `InspirationStep.tsx:500-512` |

**观察**：仪表盘按钮与提醒横幅两个快捷入口用**已保存**的 config 值，不读面板未保存输入（可辩护）；LLM 快捷入口会把本地档存的 100 clamp 成 30 并写回 config（「顺带降档」，注释已声明）；`Workflow/types.ts:55`、`WorkspaceTab.tsx:71` prop 类型仍是旧单参签名（文档滞后，运行时无害）。

---

## 三、已核验「**不是**问题」的点

| 疑点 | 核验结论 |
|---|---|
| 跨章窗口会不会有 NaN/undefined/99999 裸用？ | **不会**。全部读点过 `clampCrossAuditRecentCount`（`Number.isFinite` 拦截回落 5）；`projectTransfer` 只做类型收敛、夹取在消费方，链路完整 |
| Auto-Pilot 周期抽检会不会受窗口影响改变停机行为？ | **不会**。`useAutoPilot.ts:254` 调 `runHeuristicCrossAudit({recentCount:5})` 硬编码，不读 config；有源码正则测试锁（注：正则带尾逗号较脆，观察级） |
| `storage.ts` 会不会剥掉 `crossAuditRecentCount`？ | **不会**。无 normalizeConfig 白名单，整对象 put/get 透传，migrations 不碰 config |
| `buildWizardProjectConfig` 会不会漏字段？ | **不会**。旧 buildConfig 8 字段全保留，`...base` 新增保全；向导内唯一 config 写入口就是第 1 步，其余步骤只 patch title/characters/settings/chapters |
| `genrePackId` 显式 undefined 覆盖会不会丢已选 pack？ | **不会**。`resolveGenrePack` 永远返回 pack，实际传参恒为字符串，与旧代码逐位一致 |
| 事件账本淘汰后「重新加载不再保留」措辞是否属实？ | **属实**。`normalizeFactLedger` slice(0,120) 保留前 120 条，merge 输出 actives 恒在前 → 淘汰条目加载时被丢弃，措辞与行为一致 |
| `note==='manual'` 检测可靠吗？ | **可靠**。UI 手动路径（MemoryManager→addManualAssertion）恒写 `note:'manual'`，自动路径全为 `from_*`，supersede/淘汰均前缀拼接保留标记，slice 截断安全（拼后 33 字符 < 80/120 上限） |
| topK 3→6 会不会口径分叉？ | **不会**。三处收敛到 `RELATED_CHAPTERS_TOP_K` 单一来源，`tests/recallTopK.test.ts` 值钉 + 行为证明 + 源码扫描三重锁 |
| 09-18 的 P2-1/P3-1/P3-2 修复是否到位？ | **到位**。硬规双轴显示有 2 例新测试；清除参考源补 try/catch/finally + 防重入；抽样预算 `SEPARATOR_CHARS` 修正有边界测试（40章/1200字不超限） |

---

## 四、遗留问题状态核查（09-14 报告 A–H + 待复核，逐条回源码）

| 编号 | 状态 | 现状证据 |
|---|---|---|
| A LAN 免 token | **部分修** | `llmSecurity.ts:239-284`：脚本类调用收口到回环 IP（`isLoopbackClientIp`:283）、Sec-Fetch-Site 强校验。前端仍无 token，LAN 浏览器 same-origin 仍免 token——已转为 `SECURITY.md:39-45` 文档化接受的信任域设计 |
| B 浏览器保存锁死 | **仍在** | `storage.ts:190` rev 就地回写入参；`useProjectPersistence.ts:51-54/:111-115` 新 spread 携带陈旧 rev，无沿 projectRef 链同步。本轮改动只加了冲突时列表缓存失效（`:66-67`），不碰 rev 链 |
| C abort 单例串扰 | **仍在** | `llmClient.ts:281/:306` 模块级单例原样；5 处调用方直接写全局 |
| D fix-all 并发写章 | **仍在** | `useChapterActions.ts:779-816` 不持 generatingLockRef；主入口（`App.tsx:672`/`useAutoPilot.ts:106`）不查 fixAllRunning；按钮 disabled 只看 isGenerating |
| E DNS TOCTOU | **仍在** | `articleFetch.ts:44-61` 两次独立解析；`llmSecurity.ts:165-166` 注释自认残留 |
| F RMW 无互斥 / SSE 无界 | **半修正** | RMW 子项经核实**实际不可达**（`llmService.ts` 全同步 readFileSync→writeFileSync，Node 单线程下原子——09-14 报告该子项过度保守，可销项）；SSE 缓冲无界**仍在**（`:1300/:1309-1311` 无长度阈值） |
| G 单条修/去味防重入 | **仍在** | `:654` 只有 state 级 aiTasteScanBusy（异步，双击可穿透）；`:1243/:1404` 去味入口连 busy 都不读 |
| H 草稿单槽/快照恢复协调 | **仍在** | `draftBackup.ts:137` 单槽 pending、`:80` 空正文不清旧备份；`snapshots.ts:433-467` 恢复无 flush，`App.tsx:329-356` 调用侧同样无 |
| 待复核 1-7 | **全部仍在** | rateBuckets 只增不删（`server/index.ts:294-310`）· doctor 泄密钥长度（`doctor.ts:110-111`）· backupService 正则误伤（`:123`）· 退避不响应 abort（`llmResilience.ts:95-96/:201`）· initDB 双开（`storage.ts:84-86`）· contextPack useMemo 全量依赖（`App.tsx:493-506`，对照 `:509-517` 已窄化的同型代码，属漏改）· 渲染期写 ref（`WritingCanvas.tsx:133-141`） |

**要点**：09-14 之后的精力集中在 P0/P1 与功能上，结构性 A–H 基本原封未动。风险最高仍是
**B（浏览器构建保存锁死）** 与 **D/G（fix-all、去味与生成的并发写章）**，修复面都不大。

---

## 五、优先级建议

1. **建议立刻改**（本批工作区内，改动小）：
   - P1-1 死亡判定补「以为|误以为|都当|只当」+ 例句测试（一行词表 + 一例测试）；
   - P2-1 lead 窗口 4→12 + 测试；P3-1 revive 窗口 10→14；
   - P3-5 面板初始化 clamp 带 `{useLlm:true}`（一行）；
   - P3-7 设置页两处换 `effectiveTargetChapterMax(当前值)`（两行）。
2. **需要一点设计**：P2-2 大纲 500 cap（产品决策：对齐 UI 还是提示用户）；P3-6 切书面板 state（加 `key={project.id}` 或 effect 同步）；P3-8 step 网格对齐。
3. **结构性排期**（09-14 遗留，按风险）：B（rev 链回写）→ D/G（fix-all、去味防重入）→ C（abort 单例）→ H（草稿分槽）。
4. **提交卫生**：当前工作区混着两组无关改动（向导/章数上限组 vs 跨章窗口/账本/召回组），建议拆成两次提交，便于回溯。

---

## 六、修复记录（✅ 2026-09-25 当轮已修复并验证）

| # | 修法 | 牙齿验证 |
|---|---|---|
| P1-1 | `DEATH_WEAKEN_RE` 补 `以为\|误以为\|都当\|只当`（factLedger.ts:285），词表与注释声称的覆盖面对齐 | 回退词表 → 「误认句式」测试红 ✅ |
| P2-1 | lead 窗口 4→12 字（`m.index - 12`），罩住「三年前/据传闻/想起」等稍远引导语境 | 回退 → 「lead 4~12 字」测试红 ✅ |
| P3-1 | revive 窗口 10→14 字，修复「……她还会复活归**活**」差 1 字截断 | 回退 → 「复活预告」测试红 ✅ |
| P3-5 | 面板初始化 `clampCrossAuditRecentCount(recentCount, { useLlm: true })`，与首屏标签口径一致（CrossChapterAuditPanel.tsx） | 纯 UI 显示层，无单测（与既有处理器同口径） |
| P3-6 | BookGroup 给面板加 `key={projectId ?? 'cross-audit'}`：切书强制重挂载，内部 state 不跨书残留 | 纯 UI，无单测 |
| P3-7 | 设置页两处（max 属性 + onChange clamp）换 `effectiveTargetChapterMax(当前值)`，存量 >5000 不再被控件静默改小（StyleAndEngineManager.tsx） | 源码守卫：回退红 ✅ |
| P3-8 | projectLimits 新增 `CHAPTER_SLIDER_MIN/STEP` + `effectiveSliderChapterMax`（上限向上吸附到 20/10 网格）；向导滑杆改用，防「标签 5999、滑块只到 5990」 | 网格单测 2 例 + 源码守卫回退红 ✅ |
| P2-2 | **产品决策：保留 500 上限**（每 20 章一批 LLM 调用的成本保护），语义拆开——`prompts.ts` 上限收敛为单一来源 `OUTLINE_GENERATE_MAX_CHAPTERS`；向导滑杆在目标 >500 时显示「目标按 N 章记录（进度统计用）；自动大纲单次最多 500 章，第 501 章起需在工作台手动添加」；大纲审阅页在目标超限时补「· 自动大纲单次上限 500 章」说明，避免「与目标差 N 章」显得莫名 | `outlineCap.test.ts` 3 例（值钉 + 封顶行为 + 两处提示接线守卫）；上限改 1000 → 2 例红 ✅ |
| 注释 | `:567` kind:'other'→event 等低优先；`:572` 「绝不自动淘汰」改为「手动条目自身超上限时仍按新近淘汰」；lead/revive 窗口描述同步 | — |

新增测试 11 例（vitest 840 → **851**）：`factLedgerDeath.test.ts` +4（误认句式 / lead 12 字 / revive 14 字 / 加宽不误吞真死的正例守卫）、`projectLimits.test.ts` +4（2 处源码守卫 + 网格吸附 2 例）、`outlineCap.test.ts` +3。

**注意（存量数据）**：以上修复只管**今后的抽取**；已写入账本的错误死亡断言不会自动消失。清理顺序：**先改角色卡状态，再删账本断言**——存在「卡→账本」反向同步（`syncDeathsFromCharactersToLedger`），只删断言会被卡片状态重新钉回。

**未修（维持待决策）**：P3-2/P3-3/P3-4（「变故」假阴性、主语混淆窗口、keyFacts 路径收紧）；结构性 B/D/G/C/H 与待复核清单（09-14 遗留，需配套测试的专项）。

---

## 七、加审（同日晚）：题材包扩容 + 死亡判定二次收紧（用户后续改动）

**范围**：`genrePacks.ts`（8→25 个内置包、新增 6 个创作向维度、路由算法重写、override 归一化/合并重写）+
`GenrePackPanel.tsx`（5 个新维度编辑器）+ 新测试 `genrePacks.test.ts`（11 例）；
以及 `factLedger.ts` 死亡判定的**二次收紧**（在第六节修复之上：固定 12 字 lead 窗口 →
「当前分句+前一分句」`clauseStartBefore`；抵消词窗口按 `otherNames` 截断）+ `factLedgerDeath.test.ts` +3 例。
门禁：TSC 0 · vitest **865/865**（74 文件）· oxlint 0/19 · build ✓。

### 核验通过

| 疑点 | 结论 |
|---|---|
| 路由重写是否真修复了误路由？ | ✅ 探针实证：`科幻赛博·修仙智斗` 旧库序会命中仙侠（「修仙」在库内靠前），新位置优先 → 科幻 ✓ |
| 「仅进正文层 prompt」声明 | ✅ `formatGenrePackForPrompt` 全量渲染只在正文管线（useChapterPipeline:419）与面板预览；useChapterActions 只取附加黑名单 |
| 向后兼容 | ✅ 旧 override 不清空新维度（有测试锁）；cloneBase 防共享引用（有测试锁） |
| 死亡判定二次收紧 | ✅ 分句 lead 比固定窗口更优：`他想起往事，转身拔剑，阿岚当场身亡` 不再被上一分句误吞（新测试锁）；`镇夜复活` 不再抵消 `阿岚身亡`（otherNames 截断，新测试锁）；本人真反转仍抑制。原 7+4 例与 3 例新例全绿 |

### 发现的问题（✅ P3-A/P3-B 与观察③④⑤已于 09-27 修复并复核通过）

- **P3-A · styleNorms 部分覆盖冲掉内置值**（探针实证）：只覆盖 `paragraphLen:150` → 合并结果**只剩** paragraphLen，base 的 targetWords/dialogueRatio 全丢。原因：`normNorms` 对越界/非法字段返回 `undefined` 键（而非省略键），`{...base, ...override}` 的 spread 会让 `undefined` 覆盖 base 值。且原测试把该行为锁成 `paragraphLen` 为 undefined——与「覆盖为空即回退内置」哲学矛盾。
  **→ 已修复（09-27 复核 ✅）**：`normNorms` 改为**省略无效键**（对白比 0 亦视为非法），新增测试「部分覆盖只改给的键」+ 原测试期望改为回退内置 175；探针复核 `{paragraphLen:150}` → `{targetWords:3500, paragraphLen:150, dialogueRatio:25}` ✓。
- **P3-B · `lines()` 行首数字剥离过宽**（探针实证）：`'3天内必须回款'` → `'天内必须回款'`（重写后数组输入同样被剥）。
  **→ 已修复（09-27 复核 ✅）**：收紧为 `LIST_MARK_RE = /^\s*(?:\d{1,3}\s*[\.、）)](?!\d)|[-*·])\s*/`（1–3 位数字+分隔符、`(?!\d)` 保护小数、单项符号），新测试锁住 `'3天内必须回款'`/`'10.000灵石上限'` 保留、真列表标记照剥；探针复核 ✓。
- **观察**：① 单字 genre 行为变化——`武`/`史` 回落通用包（`g.length>=2` 门，有意行为，未改）；② `网文玄幻` → 通用包（位置语义一致，未改）；③ **已修复 ✅** 文本字段（description/pacing/beatStructure）统一「空 = 未提供 → 回退内置」（normText 收口，与列表字段一致），新增测试；④ **已修复 ✅** 文本字段补 400 字上限（MAX_TEXT_LEN 收口）；⑤ **已修复 ✅** `、` 移出分句分隔符（`DEATH_CLAUSE_SEP_RE`），顿号式回忆 `他想起当年、那场大战，阿岚已死` 不再漏防，新增测试锁定；⑥ 面板未提供 styleNorms 编辑入口，未改（低频，可后续）；⑦ prompt 增加约 15 行/章，有意取舍，未改。

---

*审查产物：本文件 + 上述 9 处修复（factLedger.ts / prompts.ts / CrossChapterAuditPanel.tsx / BookGroup.tsx / StyleAndEngineManager.tsx / InspirationStep.tsx / OutlineReviewStep.tsx / projectLimits.ts + 11 例新测试）。
门禁：TSC 0 · vitest **870/870**（74 文件）· oxlint 0 errors/18 warnings · vite build ✓*
