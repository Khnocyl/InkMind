/**
 * R3-B 成本控制：token/费用估算、用量记录、月度预算闸门、章节复杂度分级。
 *
 * 纯函数 + localStorage 持久化（不依赖 IndexedDB schema，无需迁移）。
 * 所有 LLM 调用统一走 llmClient，预算闸门与用量记录在 llmClient 内集中接入。
 */

export type LlmTier = 'c0' | 'c1' | 'c2' | 'c3';

export interface TierHint {
  tier: LlmTier;
  label: string;
}

export interface UsageRecord {
  id: string;
  /** ISO 时间戳 */
  ts: string;
  projectId?: string;
  chapterNumber?: number;
  stage: string;
  tier?: LlmTier;
  model?: string;
  promptChars: number;
  completionChars: number;
  estimatedTokens: number;
  estimatedCostCny: number;
  /** 是否成功完成（失败尝试也记录，便于看板排查） */
  ok: boolean;
}

export interface UsageSummary {
  today: { calls: number; tokens: number; costCny: number };
  month: { calls: number; tokens: number; costCny: number };
  /** 'YYYY-MM' */
  monthKey: string;
}

export interface BudgetConfig {
  enabled: boolean;
  /** 月度上限（元）；0 = 不限 */
  monthlyLimitCny: number;
}

/** 用量记录上下文：供 llmClient 在调用方未显式传 options.usage 时自动归属（引擎级） */
export interface UsageContext {
  projectId?: string;
  chapterNumber?: number;
  stage: string;
  tier?: LlmTier;
  model?: string;
}

const STORAGE_KEY = 'novel_studio_llm_usage_v1';
const MAX_RECORDS = 5000;

let budgetConfig: BudgetConfig = { enabled: false, monthlyLimitCny: 0 };
let activeUsageContext: UsageContext | undefined;

export function setActiveUsageContext(ctx?: UsageContext): void {
  activeUsageContext = ctx;
}

export function getActiveUsageContext(): UsageContext | undefined {
  return activeUsageContext;
}

/* ── 预算配置 ─────────────────────────────────────────────── */

export function setBudgetConfig(cfg: Partial<BudgetConfig>): BudgetConfig {
  budgetConfig = {
    enabled: cfg.enabled ?? budgetConfig.enabled,
    monthlyLimitCny:
      cfg.monthlyLimitCny !== undefined
        ? Math.max(0, cfg.monthlyLimitCny || 0)
        : budgetConfig.monthlyLimitCny,
  };
  return { ...budgetConfig };
}

export function getBudgetConfig(): BudgetConfig {
  return { ...budgetConfig };
}

/** 月度预算超限错误：调用方应降级（保守稿 / 本地校验），不重试 */
export class BudgetExceededError extends Error {
  usedCny: number;
  limitCny: number;
  constructor(usedCny: number, limitCny: number) {
    super(
      `本月 LLM 预算已超限：已用 ¥${usedCny.toFixed(2)} / 上限 ¥${limitCny.toFixed(2)}。请调整预算或更换更便宜的模型。`
    );
    this.name = 'BudgetExceededError';
    this.usedCny = usedCny;
    this.limitCny = limitCny;
  }
}

export function isBudgetExceededError(err: unknown): boolean {
  return err instanceof BudgetExceededError;
}

/* ── token / 费用估算（保守近似） ─────────────────────────── */

/**
 * 估算 token 数：CJK 字符 ≈ 1 token/字；其它非空白字符 ≈ 0.25 token/字符。
 * （deepseek-chat 系中文友好 tokenizer 的保守近似，宁高勿低）
 */
export function estimateTokens(text: string): number {
  const s = String(text || '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
    if (isCjk) cjk += 1;
    else if (!/\s/.test(ch)) other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other * 0.25));
}

interface PriceSpec {
  match: RegExp;
  /** 每百万 token 输入价（¥） */
  in: number;
  /** 每百万 token 输出价（¥） */
  out: number;
}

const PRICE_PER_1M: PriceSpec[] = [
  { match: /deepseek-chat/i, in: 2, out: 8 },
  { match: /deepseek-reasoner/i, in: 4, out: 16 },
  { match: /kimi|moonshot/i, in: 12, out: 30 },
  { match: /glm/i, in: 5, out: 15 },
  { match: /gpt-4\.1|gpt-4o/i, in: 20, out: 60 },
  { match: /gpt-4/i, in: 60, out: 150 },
  { match: /gpt-3\.5/i, in: 6, out: 12 },
  { match: /claude/i, in: 60, out: 200 },
];
const DEFAULT_PRICE = { in: 4, out: 12 };

/** 估算一次调用的费用（元）。model 未知时用默认价（deepseek 档附近）。 */
export function estimateCostCny(
  model: string | undefined,
  promptTokens: number,
  completionTokens: number
): number {
  const key = model || '';
  const price = PRICE_PER_1M.find((p) => p.match.test(key)) || DEFAULT_PRICE;
  return (promptTokens * price.in + completionTokens * price.out) / 1_000_000;
}

export interface UsageEstimate {
  tokens: number;
  costCny: number;
}

export function estimateUsageCost(
  model: string | undefined,
  promptText: string,
  completionText: string
): UsageEstimate {
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  return {
    tokens: promptTokens + completionTokens,
    costCny: estimateCostCny(model, promptTokens, completionTokens),
  };
}

/* ── 章节复杂度分级（tier 路由建议） ───────────────────────── */

export function classifyChapterTier(input: {
  beatCount: number;
  characterCount: number;
  settingCount: number;
  targetWordCount?: number;
  revisionRounds?: number;
  hasComplexPlot?: boolean;
}): TierHint {
  let score = 0;
  if (input.beatCount >= 8) score += 2;
  else if (input.beatCount >= 5) score += 1;
  if (input.characterCount >= 6) score += 2;
  else if (input.characterCount >= 3) score += 1;
  if (input.settingCount >= 6) score += 1;
  if ((input.targetWordCount || 0) >= 2500) score += 1;
  if ((input.revisionRounds || 0) >= 2) score += 1;
  if (input.hasComplexPlot) score += 1;

  if (score >= 5) return { tier: 'c3', label: '高复杂度（建议强模型）' };
  if (score >= 3) return { tier: 'c2', label: '中高复杂度' };
  if (score >= 1) return { tier: 'c1', label: '常规' };
  return { tier: 'c0', label: '简单（便宜档即可）' };
}

/* ── 用量记录持久化 ───────────────────────────────────────── */

export function loadUsageRecords(): UsageRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UsageRecord[]) : [];
  } catch {
    return [];
  }
}

function persistUsage(records: UsageRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)));
  } catch {
    // localStorage 不可用（隐私模式/Node 测试）→ 仅内存失效，不影响主流程
  }
}

export function addUsageRecord(
  rec: Omit<UsageRecord, 'id' | 'ts'>
): UsageRecord {
  const record: UsageRecord = {
    ...rec,
    id: `usage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
  };
  const records = loadUsageRecords();
  records.push(record);
  persistUsage(records);
  return record;
}

export function getMonthKey(ts: string): string {
  return ts.slice(0, 7);
}

export function getUsageSummary(records?: UsageRecord[]): UsageSummary {
  const list = records ?? loadUsageRecords();
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const monthKey = todayKey.slice(0, 7);
  const summary: UsageSummary = {
    today: { calls: 0, tokens: 0, costCny: 0 },
    month: { calls: 0, tokens: 0, costCny: 0 },
    monthKey,
  };
  for (const r of list) {
    if (!r.ts) continue;
    if (r.ts.slice(0, 7) === monthKey) {
      summary.month.calls += 1;
      summary.month.tokens += r.estimatedTokens || 0;
      summary.month.costCny += r.estimatedCostCny || 0;
      if (r.ts.slice(0, 10) === todayKey) {
        summary.today.calls += 1;
        summary.today.tokens += r.estimatedTokens || 0;
        summary.today.costCny += r.estimatedCostCny || 0;
      }
    }
  }
  return summary;
}

/** 本月已用金额（元） */
export function getMonthCostCny(records?: UsageRecord[]): number {
  return getUsageSummary(records).month.costCny;
}

/** 调用前预算闸门：超限抛 BudgetExceededError（调用方降级，不重试） */
export function checkBudgetBeforeCall(): void {
  if (!budgetConfig.enabled || budgetConfig.monthlyLimitCny <= 0) return;
  const used = getMonthCostCny();
  if (used >= budgetConfig.monthlyLimitCny) {
    throw new BudgetExceededError(used, budgetConfig.monthlyLimitCny);
  }
}

export function formatUsageSummary(summary: UsageSummary, limitCny?: number): string {
  const limit =
    limitCny !== undefined && limitCny > 0 ? ` / 上限 ¥${limitCny.toFixed(2)}` : '';
  return (
    `本月 ${summary.month.calls} 次调用 · 约 ${Math.round(summary.month.tokens).toLocaleString()} tokens` +
    ` · 约 ¥${summary.month.costCny.toFixed(2)}${limit}` +
    `（今日 ${summary.today.calls} 次 · ¥${summary.today.costCny.toFixed(2)}）`
  );
}
