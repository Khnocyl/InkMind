# 代码复审报告（2026-10-01）

## 审查范围与方式

- **先说一个前提更正**：`git log --since=2026-09-18` 返回空——**09-16（`b408756`）之后没有任何提交**。
  所谓「最近提交的代码」实际是**工作区存量**（当前 38 modified + 11 已暂存新增 + 6 untracked）。
- `CODE_REVIEW_2026-09-25.md` 已覆盖到 **09-27**（含「七、加审」节）。
  故本轮用文件修改时间定位增量，审 **09-28 那一批**：
  `server/llmService.ts`(+200/−…) · `server/index.ts` · `server/doctor.ts` ·
  `src/services/draftBackup.ts`(+102) · `snapshots.ts`(+41) · `storyMemory.ts`(+52) ·
  `chapterRewriteMerge.ts`(+68) · `llmClient.ts`(+22) · `aiEngine.ts`(+8) ·
  `src/hooks/useChapterPipeline.ts`(+25) · `package.json` —— 合计 **+423/−103**，及配套测试。
- **基线门禁**：`tsc -b` 0 错误 · `vitest` **889/889**（75 文件）· `oxlint` 0 errors / **18 warnings** · `vite build` ✓

---

## 一、结论：这批工作质量高，主线清晰

主题是**「保护生成期间的用户编辑不被整对象的整表覆盖」**，同时顺手修掉了
09-14 / 09-25 报告里的多项遗留。逐条回源码核验，以下**属实**：

| 位置 | 修复内容 | 核验 |
|---|---|---|
| `llmClient.ts` | 「是否已有产出」判据由 `bytesProduced > 0` 改为 `fullContent.length > 0`。前者统计 SSE 原始字节，**帧头 / `[DONE]` / `{"error":…}` 错误帧都计入** → 上游报错但字节数 > 0 时会被误判成「已有产出」，错误帧被当成功 resolve 并记 `ok:true` | ✅ 判据与注释一致，确为真 bug |
| `chapterRewriteMerge.ts` | 新增 `mergeCharacterStatesFromPipeline(latest, produced, baseline)`：**三方合并**，仅覆盖 `PIPELINE_OWNED_CHARACTER_FIELDS`（status / realmOrTitle / currentLocation / secretNotes / lastMemory*）；`p && p[k]===b[k]` 时保留用户值；`baselineById.has(p.id) → continue`（**用户删掉的角色不复活**） | ✅ 双向都正确 |
| `storyMemory.ts` | 新增 `mergeMemoryUserAdditions`：生成期间用户新钉的事实 / 新伏笔 / 手补断言不被覆盖 | ✅ 但见 P3-1 |
| `aiEngine.ts` | 两处 catch 补 `isGenerationAborted(err) → throw`：中止不再被降级成启发式兜底（否则会把正文末段当事实**写成假 recap**、或按关键词**猜角色状态写进角色卡**） | ✅ 中止路径确会污染记忆 |
| `draftBackup.ts` | 超期草稿**不再无条件删**：先 `rescueUncoveredDraft`（终稿未覆盖 → 固化成快照）再清；`loadProject` 抛错**不吞**（区分「查无此书」与「读取失败」） | ✅ 与注释一致 |
| `snapshots.ts` | `pre_restore` 从「永不淘汰」拆出独立上限 `MAX_PRE_RESTORE_SNAPSHOTS = 3`，不再吃满 30 份配额（反复回滚会以 QuotaExceededError 反噬正常保存） | ✅ 自伤型风险的修正 |
| `server/doctor.ts` | 不再报密钥长度（只报「已配置」）——**正是 09-14 报告「待复核」项的建议** | ✅ |
| `server/index.ts` | CSP `connect-src` 放行 `https://api.github.com`（打包后检查更新必然失败） | ✅ 见第三节 |

测试配套到位：`draftBackup.test.ts` 18 例（含「抢救失败 → 保留草稿」「读取抛错 ≠ 项目已删」）、
`chapterRewriteMerge.test.ts` 16 例、`storyMemoryMerge.test.ts` 6 例。

---

## 二、发现的问题

### P2-1 · SSE 缓冲仍无上限（09-14 报告 F 项**只修了一半**）—— ✅ **已修复**

**位置**：`server/llmService.ts:1354-1370`

```ts
let buffer = '';
...
buffer += decoder.decode(value, { stream: true });   // ← 无任何长度检查
const lines = buffer.split('\n');
buffer = lines.pop() || '';
```

**问题**：若上游（用户可自配的 baseURL）持续发**不含换行**的流，`buffer` 会无界增长 → 进程 OOM。
同一批次**新增了** `readErrorBodySnippet(response, limit = 400)` 管住错误体读取，
**却没给这条同样无界的读取加上限**——同一类问题修了一个漏了一个。

威胁模型：需要恶意 / 异常的上游端点。应用自己会警告「非官方端点」，属真实场景。
同处已加的 `try/finally` 解决了「并发槽悬挂」是另一回事，与缓冲上限无关。

**修法（已实施）**：把切帧逻辑抽成**纯函数**便于测试，并加上限——
- `server/llmProviderRequest.ts` 新增 `MAX_SSE_BUFFER_CHARS = 1_000_000` 与
  `splitSseChunk(buffer, chunk, maxChars)`：返回 `{ lines, rest }`，`rest` 超限即抛错
- `llmService.ts` 流式循环改调 `splitSseChunk`，抛出的错由既有 `finally` 释放 reader 后走降级链
- `tests/llmProviderRequest.test.ts` +6 例（共 21）：跨块拼接、超限抛错、边界不误伤、
  **单块很大但有换行不受限**（限制只针对未切完的尾段）、默认上限有限
- **已验证有牙齿**：去掉守卫 → 「超长且无换行的尾段 → 抛错」失败

---

### P3-1 · 记忆合并只保「新增」，不保「修改 / 删除」——与同批的角色合并**口径不一致** —— ✅ **已修复**

**位置**：`src/services/storyMemory.ts` `mergeMemoryUserAdditions(latest, produced)`

只有 **2 个参数，没有 baseline**，所以做不到 `mergeCharacterStatesFromPipeline` 那样的三方合并。
注释已自认：「用户在生成期间对**已有条目**的删 / 改不会被保留（produced 里仍有该 id，故以管线为准）」。

**问题不是「已知取舍」本身，而是同批两个同类问题解法不一致**：
- 角色卡 → 三方合并，**用户的删/改被保住**（`baselineById.has(p.id) → continue`）
- 记忆（钉死事实 / 伏笔 / 账本断言）→ 按 id 并集，**用户的删/改被覆盖回来**

用户视角：生成期间在记忆面板删掉一条错钉的事实，生成结束后它**又回来了**，且无提示。

**修法（已实施）**：与角色表同口径的三方合并——
- 新增 `mergeCollectionById`：管线新增（baseline 无、latest 无）→ 保留；
  用户在生成期间删除（baseline 有、latest 无）→ **不复活**；
  用户改过而管线没动（`deepEqual(produced, baseline)`）→ 保留用户版本；
  管线真改过 → 以管线为准（保证本章 recap / 账本更新生效）。
- 新增 `deepEqual`（结构化深比较，忽略键顺序）判断「管线是否动过」。
- 覆盖 `pinnedFacts` / `openThreads` / `factLedger.assertions`（键 `id`）与
  `pendingHookResolves`（键 `threadId`）；`authorNotes` 是纯用户字段 → 编辑过就以用户为准。
- `useChapterPipeline` 在生成开始处捕获 `beatsMemory`（与 `beatsChars` 对角色表同口径）作 baseline。
- 不传 baseline 时**降级为旧的并集行为**，兼容既有调用方。
- 测试 `storyMemoryMerge` 6→14（+8）。**已验证有牙齿**：强制走降级路径 → 5 条失败。

---

## 三、已核验「**不是**问题」的点

| 疑点 | 结论 |
|---|---|
| CSP 只放行 `api.github.com`，够吗？ | **够**。`appUpdate.ts` 里唯一的 fetch 就是 `https://api.github.com/repos/.../releases/latest`；`https://github.com/...` 只是 `GITHUB_RELEASES_URL` 外链常量，不走 fetch；桌面端下载经 `desktopUpdaterBridge` 交 Electron 主进程，CSP 不适用 |
| `rescueUncoveredDraft` 会不会把「读取失败」当「项目已删」而丢稿？ | **不会**。`loadProject` 未加 `.catch(()=>null)`，异常交由外层 catch 保留草稿；且测试有专例锁定 |
| `MAX_PRE_RESTORE_SNAPSHOTS = 3` 是否过小？ | 属取舍（注释：「保留最近 3 份足够撤销一次错误回滚」），非缺陷 |
| `package.json` 加 `esbuild` 依赖有风险吗？ | 仅新增依赖，未改构建脚本行为，`vite build` 通过 |

---

## 四、优先级建议

1. ~~**P2-1**（SSE 缓冲上限）~~ —— ✅ **已修**（`splitSseChunk` + 6 例测试，含牙齿验证）。
2. ~~**P3-1**（记忆合并补 baseline）~~ —— ✅ **已修**（三方合并 + 8 例测试，含牙齿验证）。
3. 其余无阻塞项。

**本报告全部问题已修复。** 另外本轮把 09-16 以来积压的 49 个工作区文件整理为
**10 个主题提交**（C1–C9 + P3-1），每个提交实现与测试同组，可 bisect。

---

*审查产物：本文件 + P2-1 / P3-1 的修复
（`server/llmProviderRequest.ts` / `server/llmService.ts` / `src/services/storyMemory.ts` /
`src/hooks/useChapterPipeline.ts` / `tests/llmProviderRequest.test.ts` / `tests/storyMemoryMerge.test.ts`）。
基线（修复后）：TSC 0 · vitest **903/903**（75 文件）· oxlint 0 errors/18 warnings · vite build ✓*
