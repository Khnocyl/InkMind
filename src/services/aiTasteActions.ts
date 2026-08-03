/**
 * AI 味只扫 / 命中处局部去 AI 味（不跑完整写章流水线）。
 */

import type {
  Chapter,
  Character,
  MemoryAuditLog,
  RuleScanAudit,
  StyleConfig,
  StoryMemory,
} from '../types/novel';
import {
  ruleScanProse,
  ruleScanHitPhrases,
  type RuleScanResult,
  type RuleScanResultWithTaste,
} from './ruleScan';
import { applyAiTasteHitsAsRevisionTodos, findProseSnippetRange } from './aiTasteScan';
import { runLocalRewrite, type LocalRewriteContext } from './localRewrite';
import { downloadTextFile } from './projectTransfer';

function toRuleScanAudit(result: RuleScanResult): RuleScanAudit {
  return {
    passed: result.passed,
    score: result.score,
    summary: result.summary,
    blacklistHits: result.blacklistHits,
    sublimationHits: result.sublimationHits,
    tellHits: result.tellHits,
    patternHits: result.patternHits,
    hitPhrases: ruleScanHitPhrases(result),
    hits: result.hits,
  };
}

export interface ChapterAiTasteScanRow {
  chapterId: string;
  chapterNumber: number;
  title: string;
  tier: string;
  score: number;
  summary: string;
  errorCount: number;
  warnCount: number;
  passed: boolean;
}

export interface BookAiTasteScanResult {
  scanned: number;
  chapters: Chapter[];
  rows: ChapterAiTasteScanRow[];
  heavyCount: number;
  mediumCount: number;
  failCount: number;
  todosAdded: number;
}

function emptyAuditPatch(ruleScan: RuleScanResultWithTaste): Partial<MemoryAuditLog> {
  const taste = ruleScan.aiTaste;
  return {
    ruleScan: toRuleScanAudit(ruleScan),
    ruleScanBlocked: !ruleScan.passed,
    aiTasteTier: taste?.tier,
    aiTasteSummary: taste?.summary,
    aiTasteScore: taste?.score,
    removedClichesCount: Math.max(
      0,
      ruleScan.blacklistHits + ruleScan.sublimationHits
    ),
    removedClichésList: ruleScan.hits
      .filter((h) => h.kind === 'blacklist' || h.kind === 'sublimation')
      .map((h) => (h.count > 1 ? `${h.phrase}×${h.count}` : h.phrase))
      .slice(0, 40),
  };
}

/** 对单章正文做 AI 味 + 规则机检，写回 memoryAudit（不改正文） */
export function scanChapterAiTasteOnly(
  chapter: Chapter,
  styleConfig: StyleConfig,
  options?: { writeTodos?: boolean }
): { chapter: Chapter; row: ChapterAiTasteScanRow; todosAdded: number } {
  const prose = chapter.content || '';
  const ruleScan = ruleScanProse(prose, styleConfig);
  const taste = ruleScan.aiTaste;
  const tier = taste?.tier || 'clean';
  const errorCount = ruleScan.hits.filter((h) => h.severity === 'error').length;
  const warnCount = ruleScan.hits.filter((h) => h.severity === 'warn').length;

  let next: Chapter = {
    ...chapter,
    memoryAudit: {
      ...(chapter.memoryAudit || {
        injectedCharacters: [],
        injectedSettings: [],
        removedClichesCount: 0,
        removedClichésList: [],
        logicConflicts: [],
        verificationScore: ruleScan.score,
      }),
      ...emptyAuditPatch(ruleScan),
      // 只扫时综合分取机检分，避免覆盖硬伤分时虚高
      verificationScore: Math.min(
        chapter.memoryAudit?.verificationScore ?? 100,
        ruleScan.score
      ),
    },
    lastModified: new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
  };

  let todosAdded = 0;
  if (
    options?.writeTodos &&
    (tier === 'medium' ||
      tier === 'heavy' ||
      ruleScan.hits.some((h) => h.severity === 'error'))
  ) {
    const applied = applyAiTasteHitsAsRevisionTodos(next, ruleScan.hits, {
      tier,
      errorsOnly: tier === 'light' || tier === 'clean',
      max: 10,
    });
    next = applied.chapter;
    todosAdded = applied.added;
  }

  return {
    chapter: next,
    todosAdded,
    row: {
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      title: chapter.title || '',
      tier,
      score: taste?.score ?? ruleScan.score,
      summary: ruleScan.summary,
      errorCount,
      warnCount,
      passed: ruleScan.passed,
    },
  };
}

/** 全书有正文的章只扫 AI 味 */
export function scanBookAiTasteOnly(
  chapters: Chapter[],
  styleConfig: StyleConfig,
  options?: {
    writeTodos?: boolean;
    /** 只扫有正文的章 */
    minChars?: number;
  }
): BookAiTasteScanResult {
  const minChars = options?.minChars ?? 80;
  const rows: ChapterAiTasteScanRow[] = [];
  let todosAdded = 0;
  let heavyCount = 0;
  let mediumCount = 0;
  let failCount = 0;

  const nextChapters = chapters.map((ch) => {
    const len = (ch.content || '').replace(/\s+/g, '').length;
    if (len < minChars) return ch;
    const r = scanChapterAiTasteOnly(ch, styleConfig, {
      writeTodos: options?.writeTodos,
    });
    rows.push(r.row);
    todosAdded += r.todosAdded;
    if (r.row.tier === 'heavy') heavyCount += 1;
    if (r.row.tier === 'medium') mediumCount += 1;
    if (!r.row.passed) failCount += 1;
    return r.chapter;
  });

  rows.sort((a, b) => a.chapterNumber - b.chapterNumber);

  return {
    scanned: rows.length,
    chapters: nextChapters,
    rows,
    heavyCount,
    mediumCount,
    failCount,
    todosAdded,
  };
}

/**
 * 对命中片段做局部「去AI味」并替换进正文，再复扫。
 */
export async function deslopHitInChapter(input: {
  chapter: Chapter;
  /** sample 或短语 */
  snippet: string;
  styleConfig: StyleConfig;
  characters?: Character[];
  storyMemory?: StoryMemory | null;
  /** 选区向两侧扩展字数 */
  pad?: number;
  onProgress?: (msg: string) => void;
}): Promise<{
  chapter: Chapter;
  replaced: boolean;
  before: string;
  after: string;
}> {
  const prose = input.chapter.content || '';
  const snippet = (input.snippet || '').trim();
  if (!snippet || !prose) {
    return {
      chapter: input.chapter,
      replaced: false,
      before: '',
      after: '',
    };
  }

  const range = findProseSnippetRange(prose, snippet);
  if (!range) {
    input.onProgress?.('正文中未找到该片段');
    return {
      chapter: input.chapter,
      replaced: false,
      before: snippet,
      after: '',
    };
  }

  const pad = Math.max(0, Math.min(200, input.pad ?? 80));
  // 扩到句边界附近
  let start = Math.max(0, range.start - pad);
  let end = Math.min(prose.length, range.end + pad);
  const leftBreak = prose.lastIndexOf('。', range.start);
  const rightBreak = prose.indexOf('。', range.end);
  if (leftBreak >= 0 && range.start - leftBreak < 120) start = leftBreak + 1;
  if (rightBreak >= 0 && rightBreak - range.end < 120) end = rightBreak + 1;

  const selected = prose.slice(start, end).trim();
  if (selected.length < 4) {
    return {
      chapter: input.chapter,
      replaced: false,
      before: selected,
      after: '',
    };
  }

  input.onProgress?.(`局部去AI味 · ${selected.slice(0, 20)}…`);

  const ctx: LocalRewriteContext = {
    chapter: input.chapter,
    characters: input.characters,
    styleConfig: input.styleConfig,
    storyMemory: input.storyMemory,
    surroundingBefore: prose.slice(Math.max(0, start - 100), start),
    surroundingAfter: prose.slice(end, Math.min(prose.length, end + 100)),
  };

  const { text: rewritten } = await runLocalRewrite(selected, 'remove_cliche', ctx);
  const after = rewritten.trim();
  if (!after || after === selected) {
    input.onProgress?.('改写无实质变化');
    return {
      chapter: input.chapter,
      replaced: false,
      before: selected,
      after,
    };
  }

  // 用原始 start/end 替换（selected 是 trim 过的，需对齐）
  const rawSlice = prose.slice(start, end);
  const leadWs = rawSlice.match(/^\s*/)?.[0] || '';
  const trailWs = rawSlice.match(/\s*$/)?.[0] || '';
  const newProse =
    prose.slice(0, start) + leadWs + after + trailWs + prose.slice(end);

  let next: Chapter = {
    ...input.chapter,
    content: newProse,
    wordCount: newProse.replace(/\s+/g, '').length,
    contentUpdatedAt: new Date().toISOString(),
    lastModified: new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
  };

  // 复扫
  const scanned = scanChapterAiTasteOnly(next, input.styleConfig, {
    writeTodos: false,
  });
  next = scanned.chapter;

  input.onProgress?.(
    `已替换并复扫 · AI味 ${scanned.row.tier} · ${scanned.row.summary}`
  );

  return {
    chapter: next,
    replaced: true,
    before: selected,
    after,
  };
}

export interface BatchDeslopResult {
  chapter: Chapter;
  attempted: number;
  replaced: number;
  skipped: number;
  errors: string[];
  tierBefore: string;
  tierAfter: string;
}

/**
 * 批量处理本章前 N 处 error 命中（有 sample 的优先；费 token）。
 * 每处独立局部去AI味，改完再扫下一处。
 */
export async function deslopTopErrorsInChapter(input: {
  chapter: Chapter;
  styleConfig: StyleConfig;
  characters?: Character[];
  storyMemory?: StoryMemory | null;
  /** 最多处理几处，默认 3，上限 8 */
  maxHits?: number;
  /** 是否也处理 warn（默认 false，只 error） */
  includeWarns?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<BatchDeslopResult> {
  const maxHits = Math.max(1, Math.min(8, input.maxHits ?? 3));
  let chapter = input.chapter;
  const beforeScan = scanChapterAiTasteOnly(chapter, input.styleConfig);
  chapter = beforeScan.chapter;
  const tierBefore = beforeScan.row.tier;

  const hits = (chapter.memoryAudit?.ruleScan?.hits || [])
    .filter((h) =>
      input.includeWarns ? true : h.severity === 'error'
    )
    .filter((h) => !!(h.sample || (h.kind === 'blacklist' && h.phrase)))
    // 结构类 [D] 无实体片段，跳过
    .filter((h) => !h.phrase.startsWith('[D]') && !h.phrase.startsWith('[E]'))
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
      return b.count - a.count;
    })
    .slice(0, maxHits);

  let replaced = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const snippet = (h.sample || h.phrase.replace(/^\[[A-Z]\]/, '')).trim();
    if (!snippet || snippet.length < 2) {
      skipped += 1;
      continue;
    }
    input.onProgress?.(
      `批量去味 ${i + 1}/${hits.length} · ${h.phrase.slice(0, 24)}…`
    );
    try {
      const r = await deslopHitInChapter({
        chapter,
        snippet,
        styleConfig: input.styleConfig,
        characters: input.characters,
        storyMemory: input.storyMemory,
        onProgress: input.onProgress,
      });
      if (r.replaced) {
        chapter = r.chapter;
        replaced += 1;
      } else {
        skipped += 1;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${h.phrase}: ${msg.slice(0, 80)}`);
      skipped += 1;
    }
  }

  const afterScan = scanChapterAiTasteOnly(chapter, input.styleConfig, {
    writeTodos: false,
  });
  chapter = afterScan.chapter;

  input.onProgress?.(
    `批量完成 · 成功 ${replaced} · 跳过 ${skipped} · ${tierBefore} → ${afterScan.row.tier}`
  );

  return {
    chapter,
    attempted: hits.length,
    replaced,
    skipped,
    errors,
    tierBefore,
    tierAfter: afterScan.row.tier,
  };
}

/**
 * 全书：每章最多去味 maxPerChapter 处 error（默认 1）。
 * 只处理有正文且机检有 error / medium+ 的章；顺序按章号。
 */
export async function deslopTopErrorsInBook(input: {
  chapters: Chapter[];
  styleConfig: StyleConfig;
  characters?: Character[];
  storyMemory?: StoryMemory | null;
  /** 每章最多几处，默认 1，上限 3（全书控制成本） */
  maxPerChapter?: number;
  /** 最多处理多少章，默认 20 */
  maxChapters?: number;
  /** 仅 medium/heavy 章（默认 true）；false 则凡有 error 都处理 */
  onlyMediumPlus?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<{
  chapters: Chapter[];
  chaptersTouched: number;
  totalReplaced: number;
  totalSkipped: number;
  errors: string[];
}> {
  const maxPer = Math.max(1, Math.min(3, input.maxPerChapter ?? 1));
  const maxChapters = Math.max(1, Math.min(50, input.maxChapters ?? 20));
  const onlyMed = input.onlyMediumPlus !== false;

  let list = [...input.chapters];
  const sorted = list
    .filter((c) => (c.content || '').replace(/\s+/g, '').length >= 80)
    .sort((a, b) => a.number - b.number);

  // 先轻扫，筛需要处理的章
  const candidates: Chapter[] = [];
  for (const ch of sorted) {
    const scan = scanChapterAiTasteOnly(ch, input.styleConfig);
    const tier = scan.row.tier;
    const hasErr = scan.row.errorCount > 0 || !scan.row.passed;
    if (onlyMed) {
      if (tier === 'medium' || tier === 'heavy' || hasErr) {
        candidates.push(scan.chapter);
      }
    } else if (hasErr || tier !== 'clean') {
      candidates.push(scan.chapter);
    }
    // 把扫过的 audit 写回 list
    list = list.map((c) => (c.id === ch.id ? scan.chapter : c));
  }

  const toRun = candidates.slice(0, maxChapters);
  let chaptersTouched = 0;
  let totalReplaced = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < toRun.length; i++) {
    const ch = list.find((c) => c.id === toRun[i].id) || toRun[i];
    input.onProgress?.(
      `全书去味 ${i + 1}/${toRun.length} · 第${ch.number}章《${ch.title || ''}》…`
    );
    try {
      const r = await deslopTopErrorsInChapter({
        chapter: ch,
        styleConfig: input.styleConfig,
        characters: input.characters,
        storyMemory: input.storyMemory,
        maxHits: maxPer,
        onProgress: input.onProgress,
      });
      list = list.map((c) => (c.id === ch.id ? r.chapter : c));
      if (r.replaced > 0) chaptersTouched += 1;
      totalReplaced += r.replaced;
      totalSkipped += r.skipped;
      if (r.errors.length) {
        errors.push(...r.errors.map((e) => `第${ch.number}章 ${e}`));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`第${ch.number}章: ${msg.slice(0, 80)}`);
    }
  }

  input.onProgress?.(
    `全书去味完成 · 动 ${chaptersTouched} 章 · 替换 ${totalReplaced} 处 · 跳过 ${totalSkipped}`
  );

  return {
    chapters: list,
    chaptersTouched,
    totalReplaced,
    totalSkipped,
    errors: errors.slice(0, 20),
  };
}

function csvEscape(s: string): string {
  const t = String(s ?? '').replace(/"/g, '""');
  if (/[",\n\r]/.test(t)) return `"${t}"`;
  return t;
}

/**
 * 从章节 memoryAudit 生成 AI 味 CSV（建议先全书只扫）。
 */
export function buildAiTasteCsv(
  chapters: Chapter[],
  options?: { bookTitle?: string }
): string {
  const header = [
    'chapterNumber',
    'title',
    'tier',
    'aiTasteScore',
    'ruleScore',
    'passed',
    'blacklistHits',
    'sublimationHits',
    'tellHits',
    'patternHits',
    'errorCount',
    'warnCount',
    'summary',
    'topHits',
  ].join(',');

  const sorted = [...chapters]
    .filter((c) => (c.content || '').replace(/\s+/g, '').length >= 40)
    .sort((a, b) => a.number - b.number);

  const lines = [header];
  for (const ch of sorted) {
    const rs = ch.memoryAudit?.ruleScan;
    const hits = rs?.hits || [];
    const errN = hits.filter((h) => h.severity === 'error').length;
    const warnN = hits.filter((h) => h.severity === 'warn').length;
    const top = hits
      .slice(0, 8)
      .map(
        (h) =>
          `${h.severity}:${h.phrase}${h.count > 1 ? `×${h.count}` : ''}${
            h.sample ? `(${h.sample.slice(0, 20)})` : ''
          }`
      )
      .join(' | ');
    lines.push(
      [
        ch.number,
        csvEscape(ch.title || ''),
        csvEscape(ch.memoryAudit?.aiTasteTier || ''),
        ch.memoryAudit?.aiTasteScore ?? '',
        rs?.score ?? '',
        rs ? (rs.passed ? '1' : '0') : '',
        rs?.blacklistHits ?? '',
        rs?.sublimationHits ?? '',
        rs?.tellHits ?? '',
        rs?.patternHits ?? '',
        errN,
        warnN,
        csvEscape(ch.memoryAudit?.aiTasteSummary || rs?.summary || ''),
        csvEscape(top),
      ].join(',')
    );
  }

  const title = options?.bookTitle ? `# ${options.bookTitle} AI-taste scan\n` : '';
  return `\uFEFF${title}${lines.join('\n')}\n`;
}

export function exportAiTasteCsv(
  chapters: Chapter[],
  options?: { bookTitle?: string; filename?: string }
): { filename: string; rowCount: number } {
  const content = buildAiTasteCsv(chapters, { bookTitle: options?.bookTitle });
  const base =
    options?.filename ||
    `${(options?.bookTitle || 'novel').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}_ai_taste.csv`;
  const dataLines = content.split('\n').filter((l) => l && !l.startsWith('#'));
  const rowCount = Math.max(0, dataLines.length - 1);
  downloadTextFile(base, content, 'text/csv;charset=utf-8');
  return { filename: base, rowCount };
}
