# R3 / R4 / R7 设计方案（P1 · 待确认）

> 状态：设计稿，等待确认后实施。每项给出现状事实、方案选项、推荐与工作量。
> 关联风险清单：RISKS.md R3（LLM 强依赖与成本）、R4（数据模型演进无迁移框架）、R7（记忆多路回写一致性）。

---

## R3 · LLM 强依赖与成本（P1）

### 现状事实
- 单章全链路（分镜→正文→审校→修复→recap→记忆回写）几乎每步都调 LLM（`useChapterPipeline` 810 行）。
- 已有部分本地兜底：recap fallback（启发式摘要）、intent fallback、factGuard 本地断言、aiTasteScan / ruleScan 本地机检、deslop 本地去味。
- 成本面：`StyleConfig` 已有 `modelName / aiProvider / baseURL / apiKey`；路由层有 tier c0（flash 便宜档）~ c3（强档）；**无**用量统计、无预算上限、无统一重试策略。

### 方案选项
| 选项 | 内容 | 工作量 | 收益 |
|---|---|---|---|
| **A · 韧性（推荐先做）** | `llmClient` 统一：超时 + 重试退避 + 流式中断恢复；管线级「降级链」——正文失败→本地模板续写并标记「保守稿」；审校失败→本地机检替代。目标：API 全挂时单章闭环仍能产出可用稿 | 中（2–3 轮） | 直接消除「API 故障闭环不可用」 |
| B · 成本控制 | 按章 token 估算 + 月度预算上限 + tier 自动路由（简单章走 c0/c1，复杂章走 c2/c3）+ 用量看板 | 中 | 费用可控、可观测 |
| C · 队列与断点续跑 | 管线任务持久化，API 恢复后续跑（跨会话） | 大 | 与 Auto-Pilot 循环部分重叠，边际收益低 |

### 推荐
**A 为主，B 次之，C 暂缓。** A 直接命中用户痛点（故障时不可用）；B 可复用现有 tier 路由；C 与现有 AP 循环重叠，收益低。

---

## R4 · 数据模型演进无迁移框架（P1）

### 现状事实
- IndexedDB `DB_VERSION = 2`（store 级升级已有），但**项目 JSON 无 schema version**。
- 现在靠加载时 normalize 兜底：`settings || []`、`memory` 归一化、styleProfiles 快照找回、旧快照后台迁移（`migrateLegacySnapshots`）。
- 隐患：schema 大改时无法区分「旧版本数据」与「损坏数据」，normalize 会静默吞掉结构性问题。

### 方案选项
| 选项 | 内容 | 工作量 | 风险 |
|---|---|---|---|
| **C · 组合（推荐）** | `BookProject` 加 `schemaVersion`；新增 `migrations/` 注册表（vN→vN+1 迁移函数）；加载时逐级迁移 + 迁移前自动快照 + 迁移日志；**平时新增可选字段只走 normalize，不递增 version** | 小（1–2 轮） | 低 |
| A · 仅轻量框架 | 只加 version + 迁移注册表，不做读取分支 | 小 | 中（旧数据无 version 时需默认值策略） |
| B · 仅强化 normalize | 不加 version，继续读取层兜底 | 极小 | 高（无法区分旧数据 vs 损坏数据） |

### 推荐
**C**。工作量小、风险最低；迁移前自动快照复用 `snapshots.ts` 既有能力；首个迁移示例可直接把「无 version 的存量数据」标记为 v1。

---

## R7 · 记忆多路回写一致性（P1）

### 现状事实
- 多路写入：章末 recap → `mergeRecapIntoMemory`（pinnedFacts / openThreads）；状态回写（`CharacterStatePatch` → 角色卡 status / realm / location / secretNotesAppend）；factLedger 章后快照对账；人工 MemoryManager 编辑；死亡同步走 `onPatchBible`（memory + characters 同批原子写）。
- 冲突场景：同一事实多处存储（如角色卡 status 与 pinnedFacts「已死」不一致）；LLM 回写与人工编辑竞态；factGuard 已有 `reconcileProseAgainstLedger` 对账雏形但**未接入回写路径**。

### 方案选项
| 选项 | 内容 | 工作量 | 收益 |
|---|---|---|---|
| **A · 单一事实源 + 冲突检测（推荐）** | 书级 memory（pinnedFacts / factLedger）为权威，角色卡为派生视图；把 `reconcileProseAgainstLedger` 的对账逻辑接到「章末回写」路径——回写前检测矛盾，冲突时**降级为 warn + 提示**而非静默覆盖 | 中（2 轮） | 消除静默吃书 |
| B · 写前一致性预检 | 正文生成前用 memory 钉死事实做预检（factGuard 扩展），矛盾直接阻断 | 小 | 从源头防，但需处理误报 |
| C · 审计事件流 | memoryWriteLog 扩展为可回放事件流 | 大 | 成本高，暂缓 |

### 推荐
**A + B 组合**：B 拦截源头（写前），A 兜住回写（章末），两层都只 warn 不硬阻断，避免误报伤体验。

---

## 建议实施顺序

1. **R4**（最小、纯技术债、风险最低）→
2. **R7**（中等，复用 factGuard 对账逻辑）→
3. **R3-A**（较大但收益最高）

## 顺带项：CI

当前 `E:\projects\novel` **无 git 仓库**（`git_status` 此前一直报内部错误即因此）。建议：`git init` + 首次提交 → 加 GitHub Actions（`lint + build + test`，`npm test` 已就绪 99 用例）。若需要本地 Git 而不是 GitHub，也可只做 init + 提交，CI 留待有远端时再挂。
