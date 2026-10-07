# 代码复审报告（2026-09-14 第二轮）

## 审查方式与基线

- **4 路并行只读审查**（服务端 / 核心运行层 / 工作区 UI / 生成与拆书服务），随后**逐条回源码核验**——
  未核验的结论不进本报告主清单。
- 基线门禁：`tsc -b` 0 错误 · `vitest` **789/789**（65 文件）· `oxlint` 0 errors / 19 warnings（基线）· `vite build` 成功。
- 牙齿验证：对本轮 4 个关键修复做「回退 → 测试必须红 → 恢复」验证，全部命中。

---

## 一、本轮已修复（全部回源码核验通过）

### P0 阻断

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `useChapterActions.ts:817-886` + `revisionTodos.ts:80` | **一键修全部对失败条目死循环**：某条 AI 修失败（`replaced:false`）后 todo 仍是 open，下一轮 `pickFirstOpenRevision` 又选中同一条，循环预算全部耗在一条修不动的待修上，后续待修永远轮不到、白烧 API 调用 | 新增 `pickFirstOpenRevision(chapters, skipTodoIds)`；失败/抛错/数据缺失的 todo 记入 `skippedIds`，下轮跳过。已加单元测试（`tests/revisionTodosPick.test.ts`） |

### P1 高

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 2 | `server/llmSecurity.ts:256-271` | **伪造头即可绕过 token**：无 Origin 的 same-origin 分支 `return true` 不查 Host/IP，脚本带 `Sec-Fetch-Site: same-origin` 就能不带 token 调用全部 /api/*（LAN 部署时鉴权形同虚设） | 该分支补 `isTrustedHostname(host)` 校验。⚠️ 残余风险见「二、结构性」第 1 条 |
| 3 | `server/index.ts:658` | **fetch-article 错误体无大小上限**：恶意上游返回几 GB 的 502 body 直接 OOM（2MB 上限只管成功路径） | 错误体改限量流式读取（64KB） |
| 4 | `bookDeconstruct.ts` splitChapters | **纯「1、标题」编号的书永远切不出章**（`sawHeading` 门永远为假）→ 整本被 4000 字硬切、切断场景 | 预扫描：无「第N章」时，≥3 条递增编号（从 1 起）且相邻标题平均间距 ≥20 行才按编号切章；正文短列表（连着 1、2、3）不误判 |
| 5 | `bookDeconstruct.ts` CHAPTER_HEADING_RE | **「第四节课/第四节车厢」被误切成章**（这类搭配在正文里极常见） | 分隔符类从「可空 + 任意后续」改为前瞻断言「必须有分隔符或行尾」；`第四章`单独成行仍认，「第四节课」不认 |

### P2 中（均已核验）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 6 | `DeconstructModal.tsx` runDeconstruct abort 分支 | **停止后提示不可见**：「已停止」写进只在 running 步渲染的 runMsg，回到 select 步毫无反馈 | 新增 selectNotice 状态并在 select 步渲染 |
| 7 | `DeconstructModal.tsx` synthesize catch | **综合阶段点停止被误报「全书综合失败」** | catch 里先判 isGenerationAborted，走「已停止（任务保留可续）」分支 |
| 8 | `DeconstructModal.tsx` handleFetchToc | **loose 兜底模式下 extractTocPageUrls 把章节链接当目录页**（数字锚文本双信号成立 → 把 N 个章节页当目录页抓） | 仅在 strict（第N章形态）识别成功时才做目录分页探测 |
| 9 | `bookDeconstruct.ts` deriveChapterPageUrls | 丢弃 sibling 锚点信号（与其注释「含未标页数」矛盾，埋雷） | 直接返回 `analyzeChapterPagination().urls` |
| 10 | `DeconstructModal.tsx` handleFetchSingle | 抓取 200 字 / 拆解 60 字口径不一（低标点文本预览能过、拆解才报错） | 统一走 `assessDeconstructInput`（60 字判据） |
| 11 | `DeconstructModal.tsx` runDeconstruct 锁 | 运行中点「继续」静默无反应 | 被锁挡下时 setDoneNotice 提示 |
| 12 | `bookDeconstruct.ts` 人名截断 | 综合把卡名截 24 字、逐章名不截 → >24 字人名 `applyCharacterIdMapping`/`resolveCharacterRelations` 全部静默匹配不上 | 新增 `canonicalCharName`（统一 24 字口径），两侧同用 |

### P3 低（均已核验）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 13 | `outlineGenerate.ts:412` | 存量 `summary` 为数字时 `.trim()` 抛 TypeError，整段生成崩 | `String(existing.summary ?? '').trim()` |

---

## 二、核验通过但**建议后续处理**（结构性，改动需配套测试，本轮不盲改）

| # | 位置 | 问题（已回源码确认） | 建议改法 |
|---|---|---|---|
| A | `server/llmSecurity.ts` + 前端无 token 机制 | **LAN 部署本质风险**：前端不带 token，全靠 same-origin 豁免；Sec-Fetch-Site 可伪造 → 本机绑定回环时安全，HOST=0.0.0.0 时**LAN 内任何人可免 token 消耗 LLM 额度**（启动警告已提示「请确认已配置强鉴权」，但豁免本身即弱点） | 给前端发 token（服务端把 token 注入首页 / 设置页读取），LAN 下改为「豁免仅回环 IP，其余必须带 token」。改动涉及鉴权链路，需专门测试 |
| B | `useProjectPersistence.ts:101` + `storage.ts:177` | **浏览器构建下 rev 不贯穿新对象**：突发写时第二个项目对象 spread 旧 rev，`saveProject` 的 rev 回写只作用于入参对象 → `existingRev > callerRev` 恒真，所有后续保存永久冲突失败（桌面端被 `isDesktop` 跳过而掩盖） | 保存成功后把新 rev 沿 `projectRef.current` 链同步（同一 id 且 rev 落后时回写） |
| C | `llmClient.ts:281` + `App.tsx` / fix-all | **`activeAbortSignal`/`activeRoleRoute` 模块级单例**：并发管线（Auto-Pilot + 手动任务/一键修全部）互相串扰——点一个「停止」会 abort 掉无关调用、错路由 | 活动信号/路由按任务作用域显式传参，不用单例全局 |
| D | `useChapterActions.ts:769` + `App.tsx:672` | **一键修全部不持 `generatingLockRef`**：fix-all 运行期间主按钮仍可点「写这一章」/Auto-Pilot，与 fix-all 并发写同一章，管线终稿覆盖会吞掉修复结果 | fix-all 运行期持 generatingLockRef，或主按钮在 fixAllRunning/aiTasteScanBusy 时禁用 |
| E | `server/articleFetch.ts:45-52` | **DNS 复检与连接之间 TOCTOU**：`dns.lookup` 一次、fetch 内部又解析一次，rebinding 域名两次解析不同 IP（公网→127.0.0.1）即可打内网 | 解析后固定拨号 IP（自定义 dispatcher）再校验 |
| F | `server/llmService.ts:595/1299` | 配置 read-modify-write 无并发保护（两个并发 POST 互相覆盖）；SSE 缓冲单行无界累积（恶意 baseURL 发不换行的流撑内存） | 写路径加进程内互斥；SSE buffer 超阈值即中断 |
| G | `useChapterActions.ts:644/1221` | 单条 AI 修与三个去味入口缺防重入（双击/并发触发并发 LLM 改写） | 加 ref 级同步锁 + busy 检查（与 fix-all 一致） |
| H | `draftBackup.ts:80/158` + `snapshots.ts:464` | 草稿单槽 pending（去抖窗口内切章丢上一章草稿）；空正文不清旧备份；快照恢复与在途去抖写无协调（恢复可被旧状态盖回） | pending 按 chapterId 分槽；空内容改 clearDraftBackup；restore 前先 flush 在途写 |

## 三、待复核（审查代理报出、未逐条回源核验，先列出备查）

- `server/index.ts:294` rateBuckets 只增不删（LAN 下伪造源 IP 可让 Map 无限增长）——建议定期清扫 60s 无活动的桶
- `server/doctor.ts:111` 报告泄露密钥长度（缩小爆破信息面）——建议只报「已配置」
- `server/backupService.ts:123` 项目 id 本身以 `-8位-6位` 结尾时还原 projectId 的正则误伤——建议按已存 id 前缀匹配
- `llmResilience.ts:201` 退避 sleep 不响应 abort（退避期点停止需多等一个周期）
- `storage.ts:84` 并发 initDB() 双开连接（无 in-flight promise 缓存）
- `App.tsx:493` previousContextPack 的 useMemo 依赖整个 currentProject（每次击键都重建前情检索）
- `outlineGenerate.ts:269` normalize 要求 summary≥20 vs 闸门认标题或摘要——**判定为「接受部分输出 + 让用户在审阅页补全」的既有设计，不是 bug**（既有 schemaGate 测试锁了该契约，收紧会导致既有测试与产品行为冲突；如需改由产品决定）
- `WritingCanvas.tsx:133` 渲染期写 ref（当前非并发特性下无实害）
- `bookDeconstruct.ts` 章内分页对 `X/2.html`、`?page=N` 等其它命名不支持（宁缺不猜，会有「可能不完整」提示兜底）

## 四、给用户的优先级建议

1. **立刻能用上的修复**（本轮已改）：P0 死循环、纯编号切章、节课误切、鉴权 Host 校验——都过了门禁与牙齿验证。
2. **下一批最该做的**（结构性，风险从高到低）：A（LAN 免 token，若你会开 HOST=0.0.0.0 则**最高优先**）→ D（fix-all 与生成并发写同一章丢稿）→ C（停止按钮误杀）→ B（浏览器构建保存锁死）。
3. **可以排后的**：E-H 与第三节待复核项（多为边缘场景或资源问题）。

---
*审查产物：本文件 + 代码修复（见上表「修法」列）。门禁：TSC 0 · vitest 789/789（65 文件）· oxlint 0 errors/19 warnings · vite build ✓*
