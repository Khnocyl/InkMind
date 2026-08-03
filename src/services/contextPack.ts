import type { Chapter, ChapterRecap, StoryMemory } from '../types/novel';
import { formatAntiEchoPromptBlock, takeContentOpening } from './antiEcho';
import {
  formatDigestsForPrompt,
  longformInjectionBudget,
  selectRelevantDigests,
} from './longformMemory';

/** 写前注入的前情包：优先上章 recap + 正文尾段（可选近章链） */
export interface PreviousContextPack {
  /** 注入 Prompt 的完整文本 */
  text: string;
  /** 是否第一章（无前情） */
  isFirstChapter: boolean;
  /** 直接承接的上一章序号 */
  sourceChapterNumber: number | null;
  sourceChapterTitle: string | null;
  hasSummary: boolean;
  /** 是否注入了上章 recap */
  hasRecap: boolean;
  hasContentTail: boolean;
  summaryChars: number;
  recapChars: number;
  tailChars: number;
  /** 近章摘要条数（不含「直接上一章」主摘要时的附加链） */
  recentSummaryCount: number;
  /** 中远程 digest 段数 */
  digestCount?: number;
  /** 是否注入了上章开篇反复读块 */
  hasOpeningAntiEcho?: boolean;
  /** UI 短说明 */
  preview: string;
}

export interface BuildPreviousContextOptions {
  /** 上章正文末尾字数，默认 500 */
  tailChars?: number;
  /** 再往前额外带几章「一句话梗概」，默认 2（不含上一章本身）；长篇自动加大 */
  extraRecentSummaries?: number;
  /** 书级记忆（含滚动 digest，百章中远程） */
  storyMemory?: StoryMemory | null;
  /** 检索词（意图/标题），用于选中远程 digest */
  queryTerms?: string[];
}

function sortChapters(chapters: Chapter[]): Chapter[] {
  return [...chapters].sort((a, b) => a.number - b.number);
}

function stripWhitespaceLength(s: string): number {
  return s.replace(/\s+/g, '').length;
}

/** 取正文末尾 tailChars 个字符（按 Unicode 码点，避免截断奇怪） */
function takeContentTail(content: string, tailChars: number): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  if (trimmed.length <= tailChars) return trimmed;
  return trimmed.slice(-tailChars);
}

function oneLineFromChapter(ch: Chapter): string {
  const recap = ch.recap?.text?.trim();
  if (recap) {
    const line = recap.replace(/\s+/g, ' ');
    return line.length > 120 ? `${line.slice(0, 120)}…` : line;
  }
  const summary = (ch.summary || '').trim().replace(/\s+/g, ' ');
  if (summary) return summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
  return '（无 recap/梗概）';
}

function formatRecapBlock(recap: ChapterRecap): string {
  const lines: string[] = [];
  lines.push(recap.text.trim());
  if (recap.keyFacts?.length) {
    lines.push('【已钉死事实】');
    recap.keyFacts.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
  }
  if (recap.endingState?.trim()) {
    lines.push(`【章末现场】${recap.endingState.trim()}`);
  }
  if (recap.openThreads?.length) {
    lines.push('【未收伏笔】');
    recap.openThreads.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  return lines.join('\n');
}

/**
 * 根据当前章节，从全书章节列表组装 previousContext。
 * 优先级：上章 recap（实际已写） > 大纲 summary；并附正文末 N 字。
 */
export function buildPreviousContextPack(
  chapters: Chapter[],
  currentChapter: Chapter,
  options: BuildPreviousContextOptions = {}
): PreviousContextPack {
  const chNum = currentChapter.number;
  const budget = longformInjectionBudget(chNum);
  const tailLimit = options.tailChars ?? budget.tailChars;
  // 200+：近章一行链反而略收，把 token 留给 mega/rolling
  const extraRecent = options.extraRecentSummaries ?? budget.extraRecentOneLiners;

  const sorted = sortChapters(chapters);
  const prev = sorted
    .filter((c) => c.number < currentChapter.number)
    .sort((a, b) => b.number - a.number)[0];

  if (!prev) {
    const text =
      '【前情】本章为开篇章，无上一章正文可承接。请从本章梗概自然起笔，勿假装已有漫长前文。';
    return {
      text,
      isFirstChapter: true,
      sourceChapterNumber: null,
      sourceChapterTitle: null,
      hasSummary: false,
      hasRecap: false,
      hasContentTail: false,
      summaryChars: 0,
      recapChars: 0,
      tailChars: 0,
      recentSummaryCount: 0,
      digestCount: 0,
      preview: '开篇章 · 无上章前情',
    };
  }

  const blocks: string[] = [];

  // 中远程：滚动/卷摘要（百章关键）
  let digestCount = 0;
  if (options.storyMemory?.spanDigests?.length && chNum >= 12) {
    const terms =
      options.queryTerms?.length
        ? options.queryTerms
        : [currentChapter.title, currentChapter.summary || '']
            .join(' ')
            .match(/[\u4e00-\u9fff]{2,4}|[a-zA-Z]{4,}/g) || [];
    const digests = selectRelevantDigests(
      options.storyMemory.spanDigests,
      terms.map(String),
      chNum,
      budget.maxDigests
    );
    digestCount = digests.length;
    const digBlock = formatDigestsForPrompt(digests, digests.length);
    if (digBlock) {
      blocks.push(digBlock);
      blocks.push('');
    }
  }

  // 近章链：优先 recap，否则 summary
  const older = sorted.filter((c) => {
    if (c.number >= prev.number) return false;
    return !!(c.recap?.text?.trim() || (c.summary || '').trim());
  });
  const recentOlder = older.slice(-extraRecent);
  if (recentOlder.length > 0) {
    blocks.push('【更早章节要点（仅供主线连贯，勿整章复述）】');
    for (const ch of recentOlder) {
      const tag = ch.recap?.text ? 'recap' : '大纲';
      blocks.push(`- 第${ch.number}章《${ch.title}》[${tag}]：${oneLineFromChapter(ch)}`);
    }
    blocks.push('');
  }

  const summary = (prev.summary || '').trim();
  const recap = prev.recap;
  const recapText = recap?.text?.trim() || '';

  blocks.push(`【直接上一章】第${prev.number}章《${prev.title}》`);

  if (recapText) {
    blocks.push('【上章章末 Recap（优先：实际已写内容，下一章必须承接）】');
    blocks.push(formatRecapBlock(recap!));
    if (summary && summary !== recapText) {
      blocks.push(`【上章写前大纲（对照，若与 recap 冲突以 recap 为准）】\n${summary}`);
    }
  } else if (summary) {
    blocks.push(`【上章剧情梗概（尚无 recap，暂用大纲）】\n${summary}`);
    blocks.push('（提示：上章未生成章末 recap，衔接可信度较低；仍请结合正文尾段。）');
  } else {
    blocks.push('【上章记忆】（缺失 recap 与大纲，请仅依据正文尾段与本章梗概衔接）');
  }

  const tail = takeContentTail(prev.content || '', tailLimit);
  if (tail) {
    const fullLen = (prev.content || '').trim().length;
    const note =
      fullLen > tailLimit
        ? `（上章正文共约 ${stripWhitespaceLength(prev.content || '')} 字，以下为末 ${tail.length} 字原文，请自然承接语气与现场，勿重复复述整段）`
        : `（以下为上章全文/已有正文，请自然承接）`;
    blocks.push(`【上章正文尾段】${note}\n……${tail}`);
  } else {
    blocks.push(
      '【上章正文尾段】（暂无正文：上章可能尚未生成。衔接时以 recap/梗概为准，勿虚构与设定矛盾的「伪前情」。）'
    );
  }

  // 上章开篇指纹：专治「第2章前段又把第1章开场写一遍」
  const prevOpening = takeContentOpening(prev.content || '', 240);
  const hasOpeningAntiEcho = prevOpening.length >= 40;
  if (hasOpeningAntiEcho) {
    blocks.push('');
    blocks.push(formatAntiEchoPromptBlock(prev.content || ''));
  } else {
    blocks.push(
      '【反开篇复读】上章开篇样本不足；仍禁止用与上章梗概相同的「环境建立→人物亮相→说明世界」模板重开。'
    );
  }

  blocks.push(
    '【衔接硬性要求】① 开头承接上一章**章末**现场与已定结果，禁止重新开书/自我介绍/重铺世界观；② 禁止把上章开篇氛围、同套景物与感官再写一遍；③ 禁止复活/改写上一章已定结果；④ 若有「已钉死事实」不得违背。'
  );

  const text = blocks.join('\n');
  const summaryChars = summary.length;
  const recapChars = recapText.length;
  const tailChars = tail.length;

  const previewParts: string[] = [`第${prev.number}章《${prev.title}》`];
  if (recapText) previewParts.push(`recap ${recapChars} 字`);
  else if (summary) previewParts.push(`梗概 ${summaryChars} 字（无recap）`);
  else previewParts.push('无 recap/梗概');
  if (tail) previewParts.push(`尾段 ${tailChars} 字`);
  else previewParts.push('无正文尾段');
  if (recentOlder.length > 0) previewParts.push(`+近 ${recentOlder.length} 章要点`);
  if (digestCount > 0) previewParts.push(`+中远摘要 ${digestCount} 段`);
  if (hasOpeningAntiEcho) previewParts.push('反开篇复读');

  return {
    text,
    isFirstChapter: false,
    sourceChapterNumber: prev.number,
    sourceChapterTitle: prev.title,
    hasSummary: !!summary,
    hasRecap: !!recapText,
    hasContentTail: !!tail,
    summaryChars,
    recapChars,
    tailChars,
    recentSummaryCount: recentOlder.length,
    digestCount,
    hasOpeningAntiEcho,
    preview: previewParts.join(' · '),
  };
}

/** 仅返回注入文本（兼容旧 previousContext?: string 调用） */
export function buildPreviousContextText(
  chapters: Chapter[],
  currentChapter: Chapter,
  options?: BuildPreviousContextOptions
): string {
  return buildPreviousContextPack(chapters, currentChapter, options).text;
}
