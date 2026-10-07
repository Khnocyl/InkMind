# 代码复审报告（2026-09-18）

## 审查范围与方式

- **范围**：`CODE_REVIEW_2026-09-14.md` 之后的两个提交
  - `51bfd0d feat(deconstruct): 拆书工作台审查修复 + 并发会话存量改动入库`（2919 行 / 20 文件）
  - `b408756 feat(style): 拆书模板书文风作为「本书参考源」注入（不进档案库）`（734 行 / 10 文件）
  - 重点在后者：**全新功能**，且是用户直接接触面最大的一处
- **方式**：逐条回源码核验。**关键结论用探针脚本实证**（构造「参考源 + 带硬规的档案档案」的
  StyleConfig，实际调用 `resolveStyleHardRules` 与 `buildPrewriteCheckReport` 对比），不靠阅读推断。
- **基线门禁**：`tsc -b` 0 错误 · `vitest` **806/806**（66 文件）· `oxlint` 0 errors / 19 warnings · `vite build` ✓

---

## 一、先说结论：这个功能的设计与实现整体是好的

需求是「拆书只负责拆，拆出来的文风不进档案库；要用时只注入到我在写的那本书」。
核验下来这几条关键约束**都成立**：

| 约束 | 核验结果 |
|---|---|
| 参考源不进档案库 | ✅ 6 个 `upsertGlobalStyleProfiles` 调用点全是显式动作或只处理 `styleProfiles` 字段；参考源在独立的 `referenceProfile` 字段，不会漏进全局库 |
| 注入点全部走统一入口 | ✅ 5 处全改（`prompts.ts` ×3 = 写稿/字数补写/文笔润色、`localRewrite` = 局部精修、`revisionAiFix` = AI 修待修），与提交说明一致 |
| 陈旧整表覆盖不冲掉该字段 | ✅ `mergeStyleConfigPreserve` 已按「patch 显式带才覆盖」处理；且 `importStyleProfile`/`setActiveStyleProfile`/`removeStyleProfile`/`updateStyleProfile` **全部 `...styleConfig` 展开**，字段安全 |
| 外部脏数据不污染注入链路 | ✅ `normalizeReferenceProfile` 形状不合格即丢弃，并显式处理了 `Number(null)/Number('')→0`（会凭空多出「第 0 章」）这个坑 |
| 来源书被删不影响注入 | ✅ 快照内嵌，只有「重新分析」需要源书 |

`sampleProseForStyle` 的抽样设计也有充分理由（`buildStyleAnalyzePrompt` 只取样本首尾各 2200 字，
整本丢进去等于只学第一段与最后一段）——**这个判断是对的**。

---

## 二、发现的问题

### P2-1 · 写前检查显示的约束 ≠ 实际生效的约束

**位置**：`src/services/prewriteCheck.ts:351-372`

```js
if (referenceProfile) {
  push({ id: 'style_imitate', label: '文风参考源', ... });   // 只报参考源
} else if (activeStyleProfile) {
  const hr = activeStyleProfile.hardRules;
  push({ ... 硬规对白≥X% ... 平台硬规机检 开 ... });          // 硬规只在这个分支显示
}
```

**问题**：本系统其实有**两个独立的轴**——

1. **文风指南**：走 `resolveInjectionProfile`，参考源优先（正确）；
2. **硬规与标点豁免**：走 `resolveStyleHardRules` / `resolveAllowEmDash`，
   仍读 `getActiveStyleProfile`（**档案库**），在 `auditorAgent`(:55,:335) /
   `reviserAgent`(:112) / `prompts.ts:1167` 全部生效。

而写前检查把这两轴**当成一个二选一**来显示。于是设了参考源后：
档案档案声明的 `hardRules`（如「硬规对白≥30%」「平台硬规机检 开」）**仍在机检生效，
但写前检查完全不显示**。用户可能因为一条自己看不见的硬规被判不通过。

**实证**（探针脚本，构造「参考源 + 带硬规档案」）：

```
注入档案 = 某书·文风（参考源）          ← 正确
硬规(机检用) = {"dialogueRatioMin":0.3,"forbidEndingSublimation":true}
写前检查显示 = 「文风参考源…」           ← 完全没提硬规
结论：硬规机检实际生效 = 是 ；写前检查显示 = 否 （❌ 不一致）
```

**建议改法**：把 `else if` 拆开，参考源分支之后**补一条档案硬规的提示**（不要二选一）。
语义上推荐「硬规仍以档案声明为准」而不是「设参考源就关掉硬规」——后者会**静默放宽**约束。
顺带 `styleBits`（第 343-344 行）同理：参考源生效时也应带上档案硬规的标记。

> 这条正好撞在提交说明自己写下的原则上：「设了却看不见 = 等于没设」。
> 该原则对参考源成立，对**仍然生效的硬规**同样成立。

---

### P3-1 · `handleClearReference` 缺错误处理（与兄弟处理器不一致）

**位置**：`src/components/StyleConfig/StyleImitatePanel.tsx:181-184`

```js
const handleClearReference = async () => {
  await onUpdateStyleConfig((prev) => clearReferenceProfile(prev));
  setRefMsg('已清除本书参考源');
};
```

同一区块的另两个处理器 `handleAnalyzeReference`、`handleSaveReferenceAsProfile` **都有
try/catch/finally**，只有它没有；而调用处是 `onClick={() => void handleClearReference()}`
（第 346 行）。落盘失败（如 rev 冲突 `ProjectConflictError`）时会：
未处理的 Promise rejection + **用户看不到任何反馈** + 成功文案也不会出现。

**建议改法**：补 `try/catch/finally`，失败时 `setRefMsg(\`❌ 清除失败：…\`)`。

---

### P3-2 · `sampleProseForStyle` 的 `maxChars` 上限可被 `per` 下限突破（潜在）

**位置**：`src/services/bookDeconstruct.ts` `sampleProseForStyle`

```js
const per = Math.max(200, Math.floor(maxChars / picked.length));
```

当 `chapterCount` 较大而 `maxChars` 较小时（如 `{chapterCount: 40, maxChars: 1200}`）：
`per = max(200, 30) = 200`，总量 `40 × 200 = 8000`，**突破声明的 1200 上限 6.7 倍**。

**当前不可达**：唯一调用方是 `StyleImitatePanel.tsx:146` 的 `sampleProseForStyle(project.chapters)`
（全默认：10 章 / 4200 字 → per=420 → 合计 4200 ✓）。现有测试也只覆盖默认参数。
属**埋雷**而非现存 bug。

**建议改法**：`per` 下限之外再加一层总量收敛（如 `per = Math.min(per, Math.floor(maxChars / picked.length))`
仅在会超限时收紧，或抽样后按总预算二次截断）。

---

## 三、已核验「**不是**问题」的点（避免后人重复怀疑）

| 疑点 | 核验结论 |
|---|---|
| `resolveStyleHardRules`/`resolveAllowEmDash` 没改走 `resolveInjectionProfile`，是不是漏改？ | **不是**。`analyzeReferenceStyle` 产出的 `StyleProfile` **不含 `hardRules` / `punctuationTolerance`**（只有指纹/指南/doList/dontList/authorStyle），参考源本就没有硬规可注入；继续读档案库是正确语义。真正的问题只是**显示**（见 P2-1） |
| 仍用 `getActiveStyleProfile` 的 4 处（`ProjectWizard` ×3、`plannerAgent`、`outlineGenerate` ×2）是不是漏改？ | **不是**。都是**结构层**（大纲/分镜/向导），参考源快照不产出 `structureGuide`，按设计不走 |
| 参考源会不会顺带进了全局档案库？ | **不会**。见第一节 |
| 参考源字段会不会被别的写路径整表冲掉？ | **不会**。4 个 style 助手函数全部 `...styleConfig` 展开 |
| 导出/导入往返会不会丢？ | **不会**。`normalizeStyleConfig` 已接入 `normalizeReferenceProfile`，且有往返测试 |

---

## 四、修复记录（✅ 已全部修复并验证）

| # | 修法 | 牙齿验证 |
|---|---|---|
| P2-1 | `prewriteCheck.ts`：拆开 `else if`。参考源分支后**新增一条** `style_hard_rules`（「硬规（来自激活档案）」），说明「参考源只接管文风指南；硬规与标点豁免仍按档案 X 机检」；`styleBits` 同步补「硬规「X」仍生效」 | 回退后测试报 `expected '…' to contain '硬规对白≥30%'` ✅ |
| P3-1 | `StyleImitatePanel.tsx` `handleClearReference` 补 `try/catch/finally` + `refBusy` 防重入，失败提示 `❌ 清除失败：…`（与两个兄弟处理器对齐） | 纯 UI 错误处理，无单测（与另两个处理器同样未覆盖） |
| P3-2 | `bookDeconstruct.ts` `sampleProseForStyle`：新增 `SEPARATOR_CHARS = 4`（截断标记 `……` 连换行的开销）同时作用于 `budgetCount` 与 `per`，使 **总字数 ≤ maxChars 精确成立**；预算不足时按预算缩减章数（仍保首尾均匀覆盖、至少 2 章） | 回退后测试报 `expected 1212 to be less than or equal to 1200` ✅ |

新增 3 例测试（`tests/styleReferenceSource.test.ts`，15 → 18）：
- 预算极紧（`{chapterCount:40, maxChars:1200}`）不突破上限
- 设了参考源且档案声明硬规 → 写前检查**同时**出现「文风参考源」与「硬规对白≥30%」
- 只有参考源、档案无硬规 → 不出现多余的硬规条目（防过度显示）

门禁：`TSC 0` · `vitest` **809/809**（66 文件）· `oxlint` 0 errors / 19 warnings · `vite build` ✓

---

## 五、优先级建议（原）

1. **建议改**：P2-1（写前检查与实际生效不一致）——它会让用户被看不见的规则判不通过，属「困惑型」缺陷。
2. **顺手改**：P3-1（一行 try/catch，与兄弟处理器对齐）。
3. **排后**：P3-2（当前不可达，属埋雷）。

另：`tests/styleReferenceSource.test.ts` 15 例覆盖了抽样/优先级/归一化/合并保护/往返，
但**没有一例覆盖 `prewriteCheck` 的显示**——P2-1 正落在空白处。修 P2-1 时应补一例
（「设了参考源且档案声明硬规 → 写前检查必须同时提到两者」）。

---

*审查产物：本文件 + 上述 3 处修复（`prewriteCheck.ts` / `StyleImitatePanel.tsx` / `bookDeconstruct.ts` + 3 例新测试）。
基线：TSC 0 · vitest 809/809（66 文件）· oxlint 0 errors/19 warnings · vite build ✓*
