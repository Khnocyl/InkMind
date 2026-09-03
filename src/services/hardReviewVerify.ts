/**
 * 硬伤指控 · 引用核验（防幻觉硬伤，纯函数无 IO，可单测）。
 *
 * 背景（万古烬天 ch1 误报案例）：LLM 硬伤审曾把「门从外闩死 vs 杂役开门」
 * （正文明写"门栓被从外头拨开"，逻辑自解）与「明日迁柴房提前执行」（正文
 * 根本没有迁居情节）判为 error，直接把本章打到 42 分永久卡死。
 *
 * 本模块把「定罪」从 LLM 单方判断改为两段式：
 *   LLM 指控（必须附逐字引文 A/B） → 本模块确定性核验 → 未命中引文即降级存疑
 *
 * 核验只做「引文是否逐字存在」，不做语义判断（语义合理解释由 P1 辩护人二次
 * 意见承担）。核验通过 ≠ 一定是硬伤，但核验不通过 = 一定不可作为 error 计分。
 */

import type { HardReviewIssue, HardReviewResult, HardIssueVerifyResult } from '../types/novel';

/** 归一化引文的最小有效长度：低于此值的"引文"不足以定位指控 */
const MIN_QUOTE_LENGTH = 6;

/**
 * 归一化：去所有空白（含全角）、统一弯引号/破折号/省略号、拉丁小写。
 * 只做无损字符规整，不做任何"内容补全"——引文命中即逐字，未命中即未命中。
 */
export function normalizeForMatch(input: string): string {
  return String(input || '')
    .replace(/\s+/g, '')
    .replace(/[“”«»「」『』]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/——+/g, '—')
    .replace(/–+/g, '—')
    .replace(/……+/g, '…')
    .replace(/。\s*。/g, '。')
    .toLowerCase();
}

/** 引文是否在目标文本中逐字命中（归一化后 substring 匹配） */
export function containsQuote(haystack: string, quote: string): boolean {
  const h = normalizeForMatch(haystack);
  const q = normalizeForMatch(quote);
  if (!q) return false;
  if (q.length < MIN_QUOTE_LENGTH) return false;
  return h.includes(q);
}

/**
 * 核验单条硬伤指控。
 * ctx 传入与审校 LLM 完全相同的上下文原文（本章全文 + 记忆块 + 意图块 + 前情），
 * 保证「LLM 看得到 ⇒ 核验也查得到；LLM 引不到 ⇒ 指控即幻觉」。
 */
export function verifyHardIssue(
  issue: HardReviewIssue,
  ctx: {
    chapterContent: string;
    memoryBlock?: string;
    intentBlock?: string;
    previousContext?: string;
  }
): HardIssueVerifyResult {
  // ── 证据 A：指控位置必须能在本章正文中逐字定位 ──
  const quoteA = (issue.evidenceA?.quote || '').trim();
  if (!quoteA) {
    return {
      status: 'no-evidence',
      reasons: ['未提供本章逐字引文（evidenceA），指控无法核验'],
    };
  }
  if (!containsQuote(ctx.chapterContent, quoteA)) {
    return {
      status: 'quote-a-miss',
      reasons: [
        '引文A未命中本章正文：' + quoteA.slice(0, 40),
        '常见原因：转述/概括/拼接而非逐字摘录，或把他人行为安到错误角色头上',
      ],
    };
  }

  // ── 证据 B：冲突依据必须能在其声称的来源中逐字定位 ──
  const quoteB = (issue.evidenceB?.quote || '').trim();
  if (!quoteB) {
    return {
      status: 'evidence-b-miss',
      reasons: ['未提供冲突依据的逐字引文（evidenceB），无法确认违反了哪条事实'],
    };
  }
  const source = issue.evidenceB?.source || 'memory';
  const haystackB =
    source === 'chapter'
      ? ctx.chapterContent
      : [source === 'intent' ? '' : ctx.previousContext, ctx.memoryBlock, ctx.intentBlock]
          .filter(Boolean)
          .join('\n');
  if (!haystackB || !haystackB.trim()) {
    return {
      status: 'quote-b-miss',
      reasons: [`引文B来源(${source})为空，指控的冲突基准不存在`],
    };
  }
  if (!containsQuote(haystackB, quoteB)) {
    return {
      status: 'quote-b-miss',
      reasons: [
        '引文B未命中其声称的来源(' + source + ')：' + quoteB.slice(0, 40),
        '常见原因：凭记忆改写事实原文、用省略号拼接、或引用了已被重写作废的旧稿记忆',
      ],
    };
  }

  return { status: 'verified', reasons: ['引文A/B均逐字命中'] };
}

/**
 * 对硬伤审结果做引用核验（只核验+降级，**不改分数/passed**）：
 * - error 未通过核验 → 降级为 warn（保留 originalSeverity 与 verify 供 UI 展示）
 * 分数与 passed 的最终收口由 finalizeHardReviewScoring 依「剩余已核实 error 数」确定性计算。
 */
export function verifyHardIssues(
  result: HardReviewResult,
  ctx: {
    chapterContent: string;
    memoryBlock?: string;
    intentBlock?: string;
    previousContext?: string;
  }
): {
  result: HardReviewResult;
  verifiedErrors: number;
  downgraded: number;
} {
  let verifiedErrors = 0;
  let downgraded = 0;
  const issues: HardReviewIssue[] = (result.issues || []).map((issue) => {
    if (issue.severity !== 'error') return issue;
    const verify = verifyHardIssue(issue, ctx);
    if (verify.status === 'verified') {
      verifiedErrors += 1;
      return { ...issue, verify };
    }
    downgraded += 1;
    return {
      ...issue,
      severity: 'warn' as const,
      originalSeverity: 'error' as const,
      verify,
    };
  });
  return { result: { ...result, issues }, verifiedErrors, downgraded };
}

/**
 * 计分收口（确定性锚点，消除 LLM 打分方差）：
 * - 0 项已核实 error 且发生过「指控降级」→ 「仅 warn 疑点」锚点带（80-90），passed 复位
 *   （曾有指控但全是幻觉 → 误报不卡章）；LLM 从未列出指控的显式未过（hardPassed=false
 *   且 issues 为空）是其保守立场，**不代为翻转**
 * - 1 项 → 55-70；2 项及以上 → ≤54（与审校 prompt 锚点一致）
 */
export function finalizeHardReviewScoring(
  result: HardReviewResult,
  options?: { passRescue?: boolean }
): HardReviewResult {
  const errors = (result.issues || []).filter((i) => i.severity === 'error').length;
  let { score, passed } = result;
  if (errors === 0) {
    if (options?.passRescue) {
      score = Math.max(score, 80);
      passed = true;
    }
  } else if (errors === 1) {
    score = Math.max(55, Math.min(score, 70));
    passed = false;
  } else {
    score = Math.min(score, 54);
    passed = false;
  }
  return { ...result, score, passed };
}

/**
 * 便捷封装（无辩护人路径）：引用核验 + 计分收口。
 * aiEngine 主链路用 verifyHardIssues → 辩护人复核 → finalizeHardReviewScoring。
 */
export function applyHardReviewVerification(
  result: HardReviewResult,
  ctx: {
    chapterContent: string;
    memoryBlock?: string;
    intentBlock?: string;
    previousContext?: string;
  }
): {
  result: HardReviewResult;
  verifiedErrors: number;
  downgraded: number;
} {
  const step = verifyHardIssues(result, ctx);
  const hadDowngrades = step.downgraded > 0;
  const finalized = finalizeHardReviewScoring(step.result, { passRescue: hadDowngrades });
  const summary = hadDowngrades
    ? `${finalized.summary}（引用核验：${step.downgraded} 项指控未能逐字命中原文/记忆，已降级为存疑，不计硬伤）`.trim()
    : finalized.summary;
  return {
    result: { ...finalized, summary },
    verifiedErrors: step.verifiedErrors,
    downgraded: step.downgraded,
  };
}
