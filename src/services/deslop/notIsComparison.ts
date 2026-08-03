/**
 * 「不是…而是/是…」否定铺垫翻转扫描
 * 移植自 oh-story story-deslop/scripts/check-ai-patterns.js
 * 只报告，不改写。
 */

const STOP_CHARS = new Set(['。', '！', '？', '!', '?', '\n']);
const SOFT_SEPARATORS = new Set(['，', ',', '、', '；', ';', '：', ':']);
const HARD_SEPARATORS = new Set(['。', '.', '！', '!', '？', '?']);
const MAX_NEGATIVE_SPAN = 80;
const MAX_POSITIVE_SPAN = 80;

/** either-or「不是A就是B」里紧贴的「是」不是肯定项系动词 */
const COMPACT_EITHER_OR_PREV = new Set(['不', '就', '也']);
/** 「…，是吗/吧/嘛」是反问尾巴，不是翻转 */
const TAG_PARTICLES = new Set(['吗', '吧', '嘛']);

export interface NotIsFinding {
  offset: number;
  end: number;
  excerpt: string;
  message: string;
}

function startsWithAt(text: string, index: number, needle: string): boolean {
  return text.slice(index, index + needle.length) === needle;
}

function isInlineSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r';
}

function skipGap(text: string, index: number): number {
  let i = index;
  while (i < text.length && isInlineSpace(text[i]!)) i += 1;
  if (text[i] === '\n') {
    i += 1;
    while (i < text.length && isInlineSpace(text[i]!)) i += 1;
  }
  return i;
}

function findPositiveFlipEnd(candidate: string): number {
  let index = 2; // after「不是」
  let scanned = 0;
  let crossedSeparator = false;

  while (index < candidate.length && scanned <= MAX_NEGATIVE_SPAN) {
    const char = candidate[index]!;

    if (startsWithAt(candidate, index, '而是')) return index + 2;

    if (SOFT_SEPARATORS.has(char)) {
      const next = skipGap(candidate, index + 1);
      if (startsWithAt(candidate, next, '而是')) return next + 2;
      if (candidate[next] === '是' && !TAG_PARTICLES.has(candidate[next + 1] || '')) {
        return next + 1;
      }
      crossedSeparator = true;
    }

    if (HARD_SEPARATORS.has(char)) {
      const next = skipGap(candidate, index + 1);
      if (candidate[next] === '是' && !TAG_PARTICLES.has(candidate[next + 1] || '')) {
        return next + 1;
      }
      if (char !== '.') break;
      crossedSeparator = true;
    }

    if (STOP_CHARS.has(char)) break;

    if (
      char === '是' &&
      !COMPACT_EITHER_OR_PREV.has(candidate[index - 1] || '') &&
      !crossedSeparator
    ) {
      return index + 1;
    }

    index += 1;
    scanned += 1;
  }

  return -1;
}

function extractFinding(candidate: string, markerEnd: number): string {
  let end = markerEnd;
  const limit = Math.min(candidate.length, markerEnd + MAX_POSITIVE_SPAN);
  while (end < limit) {
    if (STOP_CHARS.has(candidate[end]!)) break;
    end += 1;
  }
  return candidate.slice(0, end);
}

function trimTrailingNoise(text: string): string {
  return text.replace(/[\s|）)】\]]+$/u, '');
}

function compact(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

const MSG =
  '高频 AI 对比句式；删掉否定铺垫，直接写后项，或改成动作/细节呈现。';

/**
 * 扫描全文「不是…是/而是…」翻转（含紧凑式、逗号后翻转）。
 */
export function findNotIsComparisons(text: string): NotIsFinding[] {
  const findings: NotIsFinding[] = [];
  let offset = 0;
  const input = text || '';

  while (offset < input.length) {
    const start = input.indexOf('不是', offset);
    if (start === -1) break;

    // 避免「是不是」
    if (start > 0 && input[start - 1] === '是') {
      offset = start + 2;
      continue;
    }

    const candidate = input.slice(start);
    const markerEnd = findPositiveFlipEnd(candidate);
    if (markerEnd === -1) {
      offset = start + 2;
      continue;
    }

    const raw = trimTrailingNoise(extractFinding(candidate, markerEnd));
    if (raw.length >= 4) {
      findings.push({
        offset: start,
        end: start + raw.length,
        excerpt: compact(raw),
        message: MSG,
      });
    }

    offset = start + Math.max(raw.length, 2);
  }

  return findings;
}

/** 计数 + 首条样例，供 ruleScan / aiTaste 合并 */
export function countNotIsComparisons(text: string): {
  count: number;
  sample?: string;
} {
  const list = findNotIsComparisons(text);
  return {
    count: list.length,
    sample: list[0]?.excerpt,
  };
}
