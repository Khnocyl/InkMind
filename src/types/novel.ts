export type CharacterRole = '主角' | '重要配角' | '反派' | '势力首领' | '神秘路人';
export type CharacterStatus = '活跃' | '重伤' | '闭关突破' | '被捕受困' | '已阵亡/退出';
export type SettingCategory = '力量与境界体系' | '世界地理势力' | '功法神兵道具' | '天道禁忌与法则' | '核心历史伏笔';
export type ChapterStatus =
  | '大纲待拆'
  | '细纲就绪'
  | '正文草稿'
  | '校验精修定稿'
  | '校验通过'
  | '待人工确认'
  | '机检未通过'
  | '草稿生成中'
  | '构思中'
  | '构思大纲'
  | '精修定稿';
export type WizardStep = 'inspiration' | 'title-review' | 'characters-review' | 'world-review' | 'outline-review' | 'ready';

export interface CharacterRelation {
  targetId: string;
  relation: string;
  intimacy: number; // -100 to 100
}

export interface Character {
  id: string;
  name: string;
  alias: string;
  role: CharacterRole;
  status: CharacterStatus;
  realmOrTitle: string; // 功法境界/当前身份
  currentLocation: string; // 当前所在地
  personality: string; // 性格特征
  appearance: string; // 外貌细微细节
  background: string; // 背景经历简述
  relations: CharacterRelation[];
  secretNotes: string; // 隐藏设定与未揭露伏笔
  /** 最近一次章末状态回写来源章节号（可选） */
  lastMemoryChapterNumber?: number;
  /** 最近一次状态回写时间 ISO */
  lastMemoryUpdatedAt?: string;
}

/** 单角色章末状态 diff（只写有变化的字段） */
export interface CharacterStatePatch {
  characterId: string;
  characterName: string;
  status?: CharacterStatus;
  realmOrTitle?: string;
  currentLocation?: string;
  /** 追加到 secretNotes 的短注（不覆盖原文） */
  secretNotesAppend?: string;
  reason?: string;
}

/** 章末记忆回写日志 */
export interface MemoryWriteLog {
  appliedCount: number;
  source: 'llm' | 'fallback';
  patches: {
    characterId: string;
    characterName: string;
    changedFields: string[];
    reason?: string;
  }[];
  generatedAt: string;
}

export interface WorldSetting {
  id: string;
  category: SettingCategory;
  name: string;
  description: string;
  hardRules: string[]; // 绝对不能违反的硬性约束规则
  tags: string[];
  isActive: boolean;
}

export interface PlotBeat {
  id: string;
  order: number;
  description: string; // 镜头情节点描述
  focusSense?: string; // 重点渲染感官（视觉、微动作、心理、环境等）
  expandedContent?: string;
}

/** 规则机检快照（不调 LLM，可复现） */
export interface RuleScanAudit {
  passed: boolean;
  score: number;
  summary: string;
  blacklistHits: number;
  sublimationHits: number;
  tellHits: number;
  /** 句式/节奏/解释腔等 pattern 命中次数 */
  patternHits?: number;
  /** 命中短语列表 */
  hitPhrases: string[];
  hits: {
    kind: 'blacklist' | 'sublimation' | 'tell' | 'pattern' | 'echo' | 'length';
    severity: 'error' | 'warn';
    phrase: string;
    count: number;
    sample?: string;
    suggestion: string;
  }[];
}

/** 硬伤问题类型（阻断定稿） */
export type HardIssueType =
  | '状态冲突'
  | '战力越界'
  | '时间线错乱'
  | '吃书矛盾'
  | '道具归属'
  | '人称混乱'
  | '其他硬伤';

/** 硬伤指控的证据引文（防幻觉硬伤：引文必须逐字，供确定性核验） */
export interface HardReviewEvidence {
  /** 来源：memory=书级记忆 | intent=写前意图 | previous=前情 | chapter=本章其他位置 */
  source?: 'memory' | 'intent' | 'previous' | 'chapter';
  /** 逐字引文（禁止转述/概括/省略号拼接） */
  quote?: string;
  /** 可选：引用的事实/条目 ID */
  ref?: string;
}

/** 引用核验结果（确定性代码产出，非 LLM 判断） */
export interface HardIssueVerifyResult {
  status:
    | 'verified'
    | 'quote-a-miss'
    | 'evidence-b-miss'
    | 'quote-b-miss'
    | 'no-evidence'
    | 'defense-refuted';
  reasons: string[];
}

export interface HardReviewIssue {
  type: HardIssueType;
  severity: 'error' | 'warn';
  description: string;
  suggestion: string;
  /** 指控位置证据（本章原文逐字摘录） */
  evidenceA?: HardReviewEvidence;
  /** 冲突依据证据（记忆/前情/意图原文逐字摘录） */
  evidenceB?: HardReviewEvidence;
  /** 引用核验结果：未通过核验的 error 已被降级为 warn，不参与硬伤计分 */
  verify?: HardIssueVerifyResult;
  /** 降级前的原始 severity（核验降级时保留原值供 UI 展示） */
  originalSeverity?: 'error' | 'warn';
}

/** 阶段 A：硬伤审 */
export interface HardReviewResult {
  passed: boolean;
  score: number;
  summary: string;
  issues: HardReviewIssue[];
  /** llm | fallback(API失败阻断) | local(仅本地) | mixed(LLM+本地) */
  source?: 'llm' | 'fallback' | 'local' | 'mixed';
}

/** 阶段 B：文笔审（建议向；规则机检 error 仍可阻断） */
export interface StyleReviewResult {
  score: number;
  summary: string;
  suggestions: string[];
  removedClichésList: string[];
  removedSublimationsCount: number;
  polishedApplied: boolean;
  source?: 'llm' | 'fallback';
}

/** 推进度审：本章是否真的推动了故事（区别于一致性审校） */
export interface ProgressionReviewResult {
  /** 0–100；<60 视为弱推进 */
  score: number;
  passed: boolean;
  summary: string;
  /** 分镜完成情况（未写透的 beat 序号） */
  unfinishedBeats: { order: number; reason: string }[];
  /** 本章是否推进了主线/核心冲突 */
  mainLineAdvanced: boolean;
  /** 注水度 0–10（越高越水） */
  wateriness: number;
  /** 触达的伏笔/暗线（thread 文本片段） */
  touchedThreads: string[];
  suggestions: string[];
  source: 'llm' | 'fallback';
}

export interface MemoryAuditLog {
  injectedCharacters: string[]; // 本章自动注入的角色ID列表
  injectedSettings: string[]; // 本章自动注入的设定ID列表
  /** 是否注入了上章前情（previousContext） */
  injectedPreviousContext?: boolean;
  /** 前情来源说明，如「第2章《xxx》· 尾段500字」 */
  previousContextSource?: string;
  removedClichesCount: number; // 成功拦截的AI味套话数量
  removedClichésList: string[]; // 具体拦截到的词句
  removedSublimationsCount?: number; // 成功拦截或截断的结尾升华与说教感悟数量
  logicConflicts: {
    type:
      | '状态冲突'
      | '战力越界'
      | '行文套路'
      | '时间线错乱'
      | '吃书矛盾'
      | '道具归属'
      | '人称混乱'
      | '其他硬伤';
    description: string;
    suggestion: string;
    /** hard=硬伤阻断；style=文笔软线索 */
    lane?: 'hard' | 'style';
  }[];
  /**
   * 1–100 综合分（硬伤约 55% + 文笔约 45%，机检/recap 可能压分）。
   * 绿通硬门槛：≥75；低于则不予通过、需重写。
   */
  verificationScore: number;
  /** 写后规则机检（黑名单 / 禁升华等）——文笔硬门 */
  ruleScan?: RuleScanAudit;
  /** 机检是否阻断「校验通过」 */
  ruleScanBlocked?: boolean;
  /** AI 味扩展检摘要（句式/节奏/解释腔） */
  aiTasteTier?: 'clean' | 'light' | 'medium' | 'heavy';
  aiTasteSummary?: string;
  aiTasteScore?: number;
  /** 双阶段：硬伤审 */
  hardReview?: HardReviewResult;
  /** 双阶段：文笔审 */
  styleReview?: StyleReviewResult;
  /** 硬伤是否阻断定稿 */
  hardBlocked?: boolean;
  /**
   * 润色改动摘要（审计与润色分离）：润色稿相对送审稿的字数/句子增删；
   * materiallyChanged=true 时已对润色稿复硬审，绿通以最终稿为准。
   */
  polishDiff?: {
    beforeWords: number;
    afterWords: number;
    removedSentences: number;
    addedSentences: number;
    /** 字数变化 >8% 或删句 >5 视为重大改动（触发复硬审） */
    materiallyChanged: boolean;
    note?: string;
  };
  /** 推进度审：分镜完成度 + 主线推进 + 伏笔触达（弱推进压分待人工） */
  progressionReview?: ProgressionReviewResult;
  /** 推进度弱 → 阻断自动锁章（同 recap 弱的处置） */
  progressionBlocked?: boolean;
  progressionSummary?: string;
  /**
   * recap 质量未达标时附加阻断自动锁章。
   * 仍可沉淀 recap，但 until_green 不因「机检过」而锁。
   */
  recapQualityBlocked?: boolean;
  recapQualitySummary?: string;
  /** 写前记忆检索注入摘要（与 chapter.memoryInjection 对齐） */
  memoryInjectionSummary?: string;
  memoryDebtCount?: number;
  /** 冲突修复实际执行轮数 */
  fixRounds?: number;
  /** 修复是否在机检意义上解决 */
  fixResolved?: boolean;
    /** 修复环升级档：补丁轮失败后已执行 beat 级重写 */
  beatRewriteApplied?: boolean;
  /**
   * 审校版本锚：审校完成时该章 content 的内容指纹（auditFreshness.fingerprintProse）。
   * 手改正文 / AI 修待修 / 去味后指纹失配 → isAuditStale 判过期，UI 提示「重跑本审」。
   * 旧数据缺省 = 无法证明未过期（诚实视为过期）。
   */
  auditedContentAt?: string;
  /** 最近一次审校（含重跑复核）完成时间 ISO（与 auditedContentAt 同写） */
  lastHardReviewAt?: string;
  /** 各轮修复摘要 */
  fixHistory?: {
    round: number;
    conflictCount: number;
    ruleScanPassedAfter: boolean;
    summary: string;
    /** 本轮变更摘要（模型自述） */
    changesSummary?: string[];
    /** 块级 diff 预览 */
    diffSummary?: string;
    charDelta?: number;
    /** 展示用 diff 片段（截断） */
    diffHunks?: {
      kind: 'remove' | 'add' | 'replace';
      before?: string;
      after?: string;
      label: string;
    }[];
    /** 局部补丁应用数 */
    localPatchesApplied?: number;
  }[];
  /**
   * 修复环回退记录。每轮修复前落快照，单轮净降分 ≥3 提前止损、
   * 或循环结束最终态非最高分时，回退到综合分最高的快照（同分比硬伤分）。
   * 旧数据缺省 = 未发生回退（原行为）。
   */
  revisionRollback?: {
    /** 回退前（最终态）综合分 */
    fromScore: number;
    /** 回退后（最优快照）综合分 */
    toScore: number;
    /** net-loss=单轮净降分止损；best-snapshot=循环结束择优回退 */
    reason: 'net-loss' | 'best-snapshot';
  };
  /**
   * 审稿结论不可信安全判定（硬伤审整体 API 失败无可信结论 / 硬伤审零问题
   * 但综合分与机检分背离 >25）。置位后 reviser 冻结全部自动修稿，交人工确认。
   * 旧数据缺省 = 结论可信（原行为）。
   */
  auditUnreliable?: boolean;
}

/**
 * 章末记忆产物：写完/定稿后生成，供下一章 previousContext 优先注入。
 * 与大纲 summary（写前规划）区分：recap 描述「本章实际写了什么」。
 */
export interface ChapterRecap {
  /** 120–280 字章末复盘正文 */
  text: string;
  /** 本章已钉死的事实（不得被后续推翻） */
  keyFacts: string[];
  /** 章末现场状态：人在哪、局势如何、悬念钩子 */
  endingState: string;
  /** 未收束伏笔/线索 */
  openThreads: string[];
  /** ISO 时间 */
  generatedAt: string;
  /** llm | fallback（API 失败时的启发式摘要） */
  source?: 'llm' | 'fallback';
}

/**
 * 写前章节意图（确认后再执笔，减少胡写）。
 * 与 summary（粗梗概）、beats（分镜）区分：intent 是「本章必须/禁止/钩子」控制面。
 */
export interface ChapterIntent {
  /** 本章必须完成 2–6 条 */
  mustDo: string[];
  /** 本章禁止事项 1–6 条（吃书点、人设崩、战力崩等） */
  mustAvoid: string[];
  /** 章末钩子（一句，具体可拍） */
  endingHook: string;
  /** 情绪/爽点节拍（可选 3–6） */
  emotionalBeats?: string[];
  /** 是否已人工（或 Auto-Pilot 自动）确认 */
  confirmed: boolean;
  confirmedAt?: string;
  generatedAt?: string;
  source?: 'llm' | 'manual' | 'fallback' | 'auto_pilot';
}

export interface Chapter {
  id: string;
  number: number;
  title: string;
  summary: string; // 剧情梗概（写前大纲）
  wordCount: number;
  status: ChapterStatus;
  content: string;
  volumeId?: string; // 所属卷ID
  volumeNumber?: number; // 所属卷号
  involvedCharacterIds: string[]; // 本章涉及角色
  involvedSettingIds: string[]; // 本章涉及规则设定
  beats: PlotBeat[];
  memoryAudit?: MemoryAuditLog;
  /** 章末 recap（定稿后写入，连载记忆底） */
  recap?: ChapterRecap;
  /** 本章对角色卡的状态回写记录 */
  memoryWriteLog?: MemoryWriteLog;
  /** 写前意图：目标/禁止/钩子，确认后开写 */
  intent?: ChapterIntent;
  lastModified: string;
  autoFixCount?: number; // 发生逻辑自检冲突后的自愈修改次数
  autoGenerated?: boolean;
  /**
   * 定稿锁定：为 true 时禁止流水线/Auto-Pilot 覆盖正文，正文只读。
   * 机检通过后默认锁定；「待人工」不锁。解锁后可重写。
   * 旧数据无此字段时，由 chapterLock 根据 status 推断。
   */
  locked?: boolean;
  /**
   * R3-A：正文执笔 API 失败时降级为本地保守稿（模板化、非 AI 生成）。
   * 为 true 时不应自动锁章，UI 提示用户检查配置后重跑正式稿。
   */
  conservativeDraft?: boolean;
  /** 锁定时间 ISO（可选） */
  lockedAt?: string;
  /**
   * 作者批注 / 生产备注（不进正文、不锁读写）。
   * 用于记录改稿意图、读者反馈、待修点等。
   */
  authorNotes?: string;
  /** 本章待修清单（可勾选；不进正文） */
  revisionTodos?: ChapterRevisionTodo[];
  /**
   * 正文最近一次实质更新时间（ISO）。
   * 用于日更热力 / streak；与 lastModified（常为仅时间）区分。
   */
  contentUpdatedAt?: string;
  /** 写前记忆检索快照（相关事实/伏笔/债务） */
  memoryInjection?: MemoryInjectionSnapshot;
  /** 本章写后事实快照（账本抽取） */
  factSnapshot?: ChapterFactSnapshot;
}

/** 章级待修条目 */
export type ChapterRevisionTodoStatus = 'open' | 'done';

export interface ChapterRevisionTodo {
  id: string;
  text: string;
  status: ChapterRevisionTodoStatus;
  createdAt: string;
  doneAt?: string;
  /** 自动派生运行标识：同一章后续审校运行会清理旧运行的 open 条目（手工条目无此字段，永不清理） */
  autoRunId?: string;
}

export interface Volume {
  id: string;
  number: number;
  title: string;
  summary: string;
  startChapter: number;
  endChapter: number;
}

export interface ProjectConfig {
  inspiration: string; // 用户写的最初灵感文本
  totalChapters?: number; // 生成章节总数量
  wordsPerChapter?: number; // 每章字数目标
  targetChapterCount?: number;
  targetWordCountPerChapter?: number;
  writingStyle: string; // 写作风格
  genre: string; // 题材类型
  targetAudience?: string; // 核心读者受众
  customParameters?: Record<string, any>;
}

export interface FewShotExample {
  id: string;
  title: string;
  authorStyle: string;
  content: string;
  analysis: string; // 风格要领分析
}

/**
 * 文风统计指纹（可量化特征层）
 * 句长分布、对白占比、节奏与标点密度等，供写作注入与对照。
 */
export interface StyleFingerprint {
  /** 去空白字符数 */
  charCount: number;
  sentenceCount: number;
  avgSentenceLen: number;
  medianSentenceLen: number;
  /** 句长 < 12 字占比 0–1 */
  shortSentenceRatio: number;
  /** 句长 > 40 字占比 0–1 */
  longSentenceRatio: number;
  /** 引号内文字占比 0–1（对白密度近似） */
  dialogueRatio: number;
  paragraphCount: number;
  avgParagraphLen: number;
  /** 每千字感叹号数 */
  exclamationPerK: number;
  /** 每千字问号数 */
  questionPerK: number;
  /** 平均每句逗号数 */
  commaPerSentence: number;
  /** 高频 2–3 字片语（去停用词） */
  topPhrases: string[];
  analyzedAt: string;
}

/**
 * 文风仿写档案：指纹 + LLM 风格指南 + 样本摘录。
 * 激活后注入正文/扩写 Prompt。
 */
export interface StyleProfile {
  id: string;
  name: string;
  /** 来源说明：粘贴 / 文件名 */
  sourceLabel?: string;
  fingerprint: StyleFingerprint;
  /** LLM 生成的可执行风格指南（可手改） */
  styleGuide: string;
  /** 结构层创作方法论（世界观/大纲/拆章/分镜设计时的作家大脑；与句法腔调层分离，可选） */
  structureGuide?: string;
  /** 要做 */
  doList: string[];
  /** 不要做 */
  dontList: string[];
  /** 一句话行文要诀（同步 few-shot authorStyle） */
  authorStyle: string;
  /** 代表性摘录（截自参考文，作 few-shot content） */
  sampleExcerpt: string;
  /** 多场景范文选段（语感锚定：不同场景类型的代表段落，注入时按标签展示） */
  sampleExcerpts?: { label: string; text: string }[];
  /** 风格解构说明 */
  analysis: string;
  /**
   * 标点风格偏好：'ellipsis-emphatic' 时豁免「少用省略号/禁破折号」类
   * 通用禁令（该类文风以省略号为节奏器官，通用去AI味规则会误伤）。
   */
  punctuationTolerance?: 'default' | 'ellipsis-emphatic';
  /**
   * 题材适配标签（如 ['玄幻','修真','热血']）。缺省/空 = 题材通用。
   * 书的题材与标签全部不匹配时：结构层方法论不注入，正文层降级为
   * 只学文笔层（节奏/对白/白描），题材性机制被显式禁用——防止例如
   * 「唐家三少·团战六拍」带进言情/都市书。
   */
  genreTags?: string[];
  /**
   * 题材性机制清单（如 ['团战六拍','招式喊名与口号']）。题材不匹配时
   * 这些机制被显式禁止执行，只保留文笔层。
   */
  genreMechanisms?: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 按角色路由模型：创作角色 = 管线五阶段（plan/write/audit/revise/settle）
 * + 两个管线外 LLM 任务（intent=写前意图、crossAudit=跨章抽检）。
 * 写作用强模型、审校用轻量模型。
 */
export type LlmRole =
  | 'write'
  | 'audit'
  | 'revise'
  | 'plan'
  | 'settle'
  | 'intent'
  | 'crossAudit';

/** 角色 → 配置档 id 路由表；总开关关闭时全部跟随激活档（零行为变化） */
export interface LlmRoleRouting {
  /** 总开关：true 才生效；undefined/false = 全部走激活档 */
  enabled?: boolean;
  /** 未配置的角色/档已删除的角色 → 跟随激活档 */
  routes?: Partial<Record<LlmRole, string>>;
}

export interface StyleConfig {
  clicheBlacklist: string[]; // 禁用的套话列表
  customBlacklist: string[]; // 用户额外追加
  /**
   * 破折号白名单：true 时写后校验放行「——」（文风以破折号为节奏器官的作者开启）。
   * 与激活文风档案的 punctuationTolerance='ellipsis-emphatic' 任一命中即放行。
   */
  allowEmDash?: boolean;
  /**
   * 去AI味白名单：命中片段含子串则跳过告警（功法名/绰号/专名）。
   */
  deslopWhitelist?: string[];
  /** @deprecated 同 deslopWhitelist，兼容旧字段 */
  aiTasteWhitelist?: string[];
  /** 使用内置扩展套话表（默认 true） */
  useExtendedClicheList?: boolean;
  /**
   * AI 味扩展机检（句式/节奏/解释腔）更严：部分 warn 升 error。
   * 默认 false。
   */
  aiTasteStrict?: boolean;
  /**
   * AI 味评为 heavy 时阻断绿通（默认 false，仅报告压分）。
   */
  aiTasteBlockHeavy?: boolean;
  fewShotExamples: FewShotExample[];
  selectedExampleId: string;
  /**
   * 文风仿写档案库（采样分析 → 风格指南 → 写作注入）
   */
  styleProfiles?: StyleProfile[];
  /** 当前激活的仿写档案 id；空=不注入指纹指南 */
  activeStyleProfileId?: string | null;
  enforceShowDontTell: boolean; // 是否开启“展示而非直接阐述”强约束
  forbidEndingSublimation: boolean; // 是否禁止结尾升华、哲理感悟与命运说教
  modelName?: string;
  aiProvider?: string;
  baseURL?: string;
  apiKey?: string;
  /** 按角色路由模型（默认关闭）：角色 → 配置档 id；未配置走激活档 */
  llmRoleRouting?: LlmRoleRouting;
  /** 推进度审（分镜完成度/主线推进/注水/伏笔触达）；默认开，关闭省每章 1 次 LLM 调用 */
  progressionReviewEnabled?: boolean;
  /** Auto-Pilot 本轮目标连写章数（默认 3） */
  autoPilotTargetChapters?: number;
  autoPilotMode?: boolean;
  /**
   * Auto-Pilot 写作深度：
   * - until_green：完整闭环，通过则锁定（默认）
   * - draft_only：只写分镜+正文草稿，不审校不锁定
   * - until_review：完整闭环，但即使通过也不自动锁定，一律待人工
   */
  autoPilotWriteMode?: 'until_green' | 'draft_only' | 'until_review';
  /** 机检未过是否立即停机（默认 true） */
  autoPilotStopOnFail?: boolean;
  /** 连续低于此分数的章数达到阈值则停机（默认 65） */
  autoPilotMinScore?: number;
  /** 连续低分停机阈值（默认 2） */
  autoPilotLowScoreStreakLimit?: number;
  /** 无下一章大纲时是否自动规划并新建（默认 true） */
  autoPilotCreateMissingChapters?: boolean;
  /**
   * Auto-Pilot 是否自动确认「高置信」伏笔回收建议（默认 true）。
   * AI 长跑连载用：减少人工点确认；medium/low 仍留待手确。
   */
  autoPilotAutoResolveHooks?: boolean;
  /**
   * Auto-Pilot 每写完 N 章强制跑一次本地跨章抽检（默认 5；0=关闭）。
   * 分数过低或出现 error 级问题时可停机。
   */
  autoPilotCrossAuditEvery?: number;
  /** 周期跨章抽检最低分（默认 55，低于则 AP 停机） */
  autoPilotCrossAuditMinScore?: number;
  /**
   * 章末是否用 LLM 补抽事实账本（默认 false，费 token）。
   * 启发式之后补漏死亡/道具/地点；draft_only 不生效。
   */
  autoLedgerLlmEnrich?: boolean;
  /**
   * 章末是否把账本「死亡」同步到角色卡「已阵亡/退出」（默认 true）。
   * 仅更新名字精确匹配的角色，不新建角色。
   */
  autoSyncDeathToCharacters?: boolean;
  /** 每写满 N 章有正文后提醒跨章抽检（默认 5，范围 2–20） */
  crossAuditIntervalChapters?: number;
  /**
   * 每日净增字数目标（默认 3000；0 表示关闭日更目标提示）。
   * 与 dailyWordLog 账本配合。
   */
  dailyWordTarget?: number;
  temperature?: number;
}

/** 书级权威记忆：已钉死事实（不可被后续章推翻） */
export interface PinnedFact {
  id: string;
  text: string;
  /** 来源章节号 */
  sourceChapterNumber?: number;
  /**
   * 时序有效：从该章起生效（默认=sourceChapterNumber）。
   * 写前检索可按「当前章」过滤尚未生效/已过期的事实。
   */
  validFromChapter?: number;
  /** 时序有效：到该章前有效（null/缺省=仍生效）；作废时可写入 */
  validUntilChapter?: number | null;
  /** 可选主语（角色/势力名），便于相关检索 */
  subject?: string;
  createdAt: string;
  /** pinned=生效；superseded=已被作者作废（保留痕迹） */
  status: 'pinned' | 'superseded';
  note?: string;
}

/** 未收伏笔 / 线索 */
export type PlotThreadStatus = 'open' | 'progressing' | 'resolved' | 'deferred';

export interface PlotThread {
  id: string;
  text: string;
  status: PlotThreadStatus;
  introducedChapterNumber?: number;
  lastTouchedChapterNumber?: number;
  createdAt: string;
  resolvedAt?: string;
  note?: string;
  /** 主线级伏笔：静默阈值更严（债务压力） */
  coreHook?: boolean;
  /** 埋线时的原文摘录（伏笔种子，回收时优先注入） */
  seedExcerpt?: string;
}

/**
 * 章级记忆注入快照（写前检索结果落盘，可审计「吃了哪些记忆」）。
 */
export interface MemoryInjectionSnapshot {
  generatedAt: string;
  chapterNumber: number;
  queryTerms: string[];
  selectedFactIds: string[];
  selectedThreadIds: string[];
  /** 债务伏笔（静默过久，应推进/回收/延期） */
  debtThreadIds: string[];
  /** 命中的卷/滚动摘要 id */
  selectedDigestIds?: string[];
  /** 语义相关历史章号 */
  relatedChapterNumbers?: number[];
  factCount: number;
  threadCount: number;
  debtCount: number;
  digestCount?: number;
  /** 人类可读预览 */
  preview: string;
  source: 'retrieval' | 'fallback_all';
  /** 长篇分层：hot=近章 hot+debt；warm=卷摘要；cold=检索旧事实 */
  tierHint?: string;
  /** 是否启用了本地语义（TF-IDF）加持 */
  semanticUsed?: boolean;
}

/**
 * 长篇压缩记忆：多层摘要。
 * - rolling≈10 · arc≈15（叙事弧）· mega≈50 · super≈100 · volume=分卷
 */
export type StorySpanDigestKind = 'rolling' | 'arc' | 'mega' | 'super' | 'volume';

export interface StorySpanDigest {
  id: string;
  fromChapter: number;
  toChapter: number;
  kind: StorySpanDigestKind;
  title: string;
  /** 压缩叙事；mega 更短更抽 */
  summary: string;
  /** 本段沉淀的关键事实（可与 pinned 重复，便于冷检索） */
  keyFacts: string[];
  /** 本段仍未收或曾活跃的伏笔摘要 */
  openHooks: string[];
  charactersMentioned: string[];
  updatedAt: string;
  /** heuristic=章 recap 拼装；llm=纪元润色后的压缩叙事 */
  source?: 'heuristic' | 'llm';
  /** LLM 润色时间 ISO */
  llmPolishedAt?: string;
}

/**
 * 章末模型/启发式提议回收的伏笔（需作者确认，默认不自动 resolved）。
 */
export interface HookResolveSuggestion {
  threadId: string;
  threadText: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  sourceChapterNumber: number;
  suggestedAt: string;
}

/** 世界轻量实体：地点 / 道具（吃书高发区，设定与事实追踪） */
export type WorldEntityKind = 'location' | 'item';

export interface WorldEntityState {
  id: string;
  kind: WorldEntityKind;
  name: string;
  /** 状态简述：所在/归属/损毁/封锁等 */
  status?: string;
  note?: string;
  lastChapterNumber?: number;
  updatedAt: string;
}

/**
 * 结构化事实账本断言（可对账、可注入）。
 * 比纯文本钉死事实更易做「正文 vs 账本」校验。
 */
export type FactAssertionKind =
  | 'death'
  | 'character_status'
  | 'character_location'
  | 'item_owner'
  | 'item_state'
  | 'location_state'
  | 'event'
  | 'time_anchor';

export type FactAssertionStatus = 'active' | 'superseded' | 'retracted';

export interface FactAssertion {
  id: string;
  kind: FactAssertionKind;
  /** 主体：角色名 / 道具名 / 地点名 */
  subject: string;
  /** 可读断言 */
  claim: string;
  /** 结构化取值：地点名、归属者、状态词等 */
  value?: string;
  sourceChapterNumber: number;
  createdAt: string;
  status: FactAssertionStatus;
  supersededBy?: string;
  note?: string;
}

/** 单章事实快照（章后抽取） */
export interface ChapterFactSnapshot {
  chapterNumber: number;
  chapterId?: string;
  extractedAt: string;
  source: 'heuristic' | 'llm' | 'mixed';
  assertions: FactAssertion[];
  summary?: string;
}

/** 故事时间线锚点（相对故事日，启发式） */
export interface StoryTimeAnchor {
  chapterNumber: number;
  /** 原文标签：次日清晨 / 三日后 */
  label: string;
  /** 估计故事日（从 1 起） */
  storyDay?: number;
  /** 相对上章的日增量；0=同日 */
  dayDelta?: number;
  extractedAt: string;
}

/**
 * 书级事实账本：当前有效断言 + 近章快照 + 时间线。
 * 写后对账、写前注入防吃书。
 */
export interface FactLedger {
  assertions: FactAssertion[];
  /** 最近若干章快照（默认保留 30） */
  recentSnapshots?: ChapterFactSnapshot[];
  /** 估计当前故事日游标 */
  storyDayCursor?: number;
  /** 近章时间线（默认 40） */
  timeline?: StoryTimeAnchor[];
  updatedAt?: string;
}

/**
 * 书级连载记忆（权威源，手改优先于模型）。
 * 角色「当前状态表」以 characters[] 为准。
 * 200+ 章：rolling + mega + volume 三层摘要 + 地点/道具实体 + 事实账本。
 */
export interface StoryMemory {
  pinnedFacts: PinnedFact[];
  openThreads: PlotThread[];
  /** 滚动/巨型/分卷压缩摘要 */
  spanDigests?: StorySpanDigest[];
  /** 地点状态表 */
  locations?: WorldEntityState[];
  /** 关键道具/信物归属与状态 */
  items?: WorldEntityState[];
  /** 结构化事实账本（章后快照 + 对账） */
  factLedger?: FactLedger;
  /** 滚动块大小（章），默认 10 */
  digestBlockSize?: number;
  /** 巨型块大小（章），默认 50 */
  megaBlockSize?: number;
  /** 超级总览块大小（章），默认 100，服务 300+ AI 连载 */
  superBlockSize?: number;
  /** 待确认的伏笔回收建议（写完章自动追加；AP 可自动确认 high） */
  pendingHookResolves?: HookResolveSuggestion[];
  /** 作者给全书的长期备忘（可选） */
  authorNotes?: string;
  updatedAt?: string;
}

export interface BookProject {
  id: string;
  title: string;
  subtitle: string;
  genre: string;
  synopsis: string;
  author?: string;
  totalWords?: number;
  createdDate?: string;
  createdAt?: string;
  lastModified: string;
  /**
   * 落盘修订号（跨标签页写冲突检测）：由 saveProject 在同一事务内读旧值 +1 并就地回写。
   * 写前若库中 rev 高于调用方携带值，说明他页已在我们最后一次读盘之后写过 → 拒写。
   * 缺省=0（存量数据首次保存时从 1 开始）。
   */
  rev?: number;
  /**
   * 数据模型版本（R4 迁移框架）。
   * 缺省=0（存量数据）；当前最新见 services/migrations 的 CURRENT_SCHEMA_VERSION。
   * 平时新增可选字段只走 normalize，不递增版本；结构性变更才递增并注册迁移。
   */
  schemaVersion?: number;
  wizardStep: WizardStep;
  config: ProjectConfig;
  characters: Character[];
  settings: WorldSetting[];
  volumes: Volume[];
  chapters: Chapter[];
  currentChapterId?: string;
  styleConfig: StyleConfig;
  /** 书级权威记忆：钉死事实 + 未收伏笔 */
  memory?: StoryMemory;
  /** 最近一次跨章抽检报告 */
  lastCrossAudit?: CrossChapterAuditReport;
  /**
   * 日更字数账本：YYYY-MM-DD → 当日正文净增字数。
   * 手改/流水线写章时按 delta 累计，供每日目标与热力参考。
   */
  dailyWordLog?: Record<string, number>;
}

/** 跨章连贯抽检条目 */
export interface CrossChapterIssue {
  id: string;
  severity: 'error' | 'warn' | 'info';
  kind:
    | '伏笔遗忘'
    | '角色状态'
    | '事实冲突'
    | '地点跳跃'
    | '道具归属'
    | '命名不一致'
    | '主线停滞'
    | '其他';
  title: string;
  detail: string;
  chapterNumbers?: number[];
  suggestion?: string;
}

export interface CrossChapterAuditReport {
  generatedAt: string;
  rangeFrom: number;
  rangeTo: number;
  score: number;
  summary: string;
  issues: CrossChapterIssue[];
  source: 'heuristic' | 'llm' | 'mixed';
}

export type Book = BookProject;

export interface PlotOutline {
  id: string;
  order: number;
  chapterNumber?: number;
  title?: string;
  chapterTitle: string;
  summary: string;
  keyEvents?: string[];
  involvedCharacterIds: string[];
  involvedSettingIds: string[];
  wordCountTarget?: number;
}


export interface BookProjectSummary {
  id: string;
  title: string;
  subtitle: string;
  genre: string;
  synopsis: string;
  createdDate?: string;
  createdAt?: string;
  lastModified: string;
  wizardStep: WizardStep;
  totalChapters: number;
  completedChaptersCount: number;
  totalWords: number;
}

