/**
 * 全书待修 → AI 局部改稿。
 * 「修第一处 / AI 修本条」调用模型按待修文案最小改动改正文，成功后自动勾完成。
 */

import type {
  Chapter,
  ChapterRevisionTodo,
  Character,
  StoryMemory,
  StyleConfig,
} from '../types/novel';
import { findProseSnippetRange } from './aiTasteScan';
import {
  extractTodoSearchHints,
  findHintRangeInContent,
} from './crossAuditActions';
import { generateText } from './llmClient';
import { formatIntentForPrompt } from './chapterIntent';
import { formatStoryMemoryForPrompt } from './storyMemory';
import { isChapterLocked, unlockChapterForRewrite } from './chapterLock';
import { toggleRevisionTodoOnChapter } from './revisionTodos';
import {
  formatStyleConstraintsForRewrite,
  getActiveStyleProfile,
} from './styleImitate';
import { ensureProseWordCount } from './wordCount';
import { proseWords } from './proseWords';

export interface AiFixRevisionResult {
  chapter: Chapter;
  replaced: boolean;
  autoMarkedDone: boolean;
  before: string;
  after: string;
  message: string;
  /** 用于画布定位 */
  focusSnippet?: string;
}

function expandToSentenceWindow(
  prose: string,
  start: number,
  end: number,
  pad = 100
): { start: number; end: number } {
  let s = Math.max(0, start - pad);
  let e = Math.min(prose.length, end + pad);
  const leftBreak = prose.lastIndexOf('。', start);
  const rightBreak = prose.indexOf('。', end);
  if (leftBreak >= 0 && start - leftBreak < 160) s = leftBreak + 1;
  if (rightBreak >= 0 && rightBreak - end < 160) e = rightBreak + 1;
  // 避免过短
  if (e - s < 24) {
    s = Math.max(0, start - 40);
    e = Math.min(prose.length, end + 80);
  }
  // 上限，控制 token
  if (e - s > 2200) {
    const mid = Math.floor((start + end) / 2);
    s = Math.max(0, mid - 1100);
    e = Math.min(prose.length, mid + 1100);
  }
  return { start: s, end: e };
}

function extractQuotedSamples(todoText: string): string[] {
  const quoted: string[] = [];
  const re = /[「『“"]([^」』”"]{2,80})[」』”"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(todoText || ''))) {
    quoted.push(m[1].trim());
  }
  quoted.sort((a, b) => b.length - a.length);
  return quoted;
}

function mergeHighlightRanges(
  ranges: { start: number; end: number }[]
): { start: number; end: number }[] {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n.start <= cur.end + 2) {
      cur.end = Math.max(cur.end, n.end);
    } else {
      out.push(cur);
      cur = { ...n };
    }
  }
  out.push(cur);
  return out;
}

/** 从待修文案定位正文改写窗口 */
export function locateRevisionFixRange(
  prose: string,
  todoText: string
): { start: number; end: number; mode: 'snippet' | 'window' } | null {
  if (!prose?.trim()) return null;
  const text = todoText || '';

  // 1) 引号内 sample（优先较长）
  const quoted = extractQuotedSamples(text);
  for (const q of quoted) {
    const r = findProseSnippetRange(prose, q);
    if (r) {
      const w = expandToSentenceWindow(prose, r.start, r.end);
      return { ...w, mode: 'snippet' };
    }
  }

  // 2) hint 关键词
  const hints = extractTodoSearchHints(text);
  const hr = findHintRangeInContent(prose, hints);
  if (hr) {
    const w = expandToSentenceWindow(prose, hr.start, hr.end, 120);
    return { ...w, mode: 'snippet' };
  }

  // 3) 无锚点：按问题类型取窗口
  const len = prose.length;
  const windowSize = Math.min(1600, Math.max(400, Math.floor(len * 0.35)));
  if (/开篇|开头|前段|首段|黄金/.test(text)) {
    return { start: 0, end: Math.min(len, windowSize), mode: 'window' };
  }
  if (/章末|收尾|结尾|升华/.test(text)) {
    return {
      start: Math.max(0, len - windowSize),
      end: len,
      mode: 'window',
    };
  }
  // 默认取正文前中段（常见 AI 味/硬伤落点）
  if (len <= windowSize) {
    return { start: 0, end: len, mode: 'window' };
  }
  const start = Math.floor(len * 0.15);
  return {
    start,
    end: Math.min(len, start + windowSize),
    mode: 'window',
  };
}

/**
 * 待修点击 → 正文红色波浪线高亮范围（可多段）。
 * 优先精确 sample/关键词；无锚点时退化为单窗口。
 */
export function locateRevisionHighlightRanges(
  prose: string,
  todoText: string
): { start: number; end: number; mode: 'snippet' | 'window' }[] {
  if (!prose?.trim()) return [];
  const text = todoText || '';
  const found: { start: number; end: number }[] = [];
  const seen = new Set<string>();

  const pushExact = (start: number, end: number) => {
    if (end <= start) return;
    // 高亮略扩一点到句读，便于看见上下文
    const w = expandToSentenceWindow(prose, start, end, 48);
    const key = `${w.start}-${w.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(w);
  };

  for (const q of extractQuotedSamples(text)) {
    if (found.length >= 10) break;
    let from = 0;
    while (from < prose.length && found.length < 10) {
      const idx = prose.indexOf(q, from);
      if (idx < 0) break;
      pushExact(idx, idx + q.length);
      from = idx + Math.max(1, q.length);
    }
  }

  if (!found.length) {
    for (const h of extractTodoSearchHints(text)) {
      if (!h || h.length < 2 || found.length >= 8) continue;
      let from = 0;
      let hits = 0;
      while (from < prose.length && hits < 3 && found.length < 8) {
        const idx = prose.indexOf(h, from);
        if (idx < 0) break;
        pushExact(idx, idx + h.length);
        hits += 1;
        from = idx + h.length;
      }
    }
  }

  if (found.length) {
    return mergeHighlightRanges(found).map((r) => ({ ...r, mode: 'snippet' as const }));
  }

  const fallback = locateRevisionFixRange(prose, text);
  if (!fallback) return [];
  return [fallback];
}

function classifyTodo(todoText: string): {
  kind: 'aitaste' | 'hard' | 'audit' | 'generic';
  actionHint: string;
} {
  const t = todoText || '';
  if (
    t.includes('[去AI') ||
    t.includes('去AI') ||
    t.startsWith('aitaste-') ||
    /套话|升华|解释腔|句式|AI味/.test(t)
  ) {
    return {
      kind: 'aitaste',
      actionHint:
        '重点清除 AI 套话、解释腔、模板句式与无根升华；改为具体动作/感官/对白。改最少。',
    };
  }
  if (
    t.includes('[硬伤') ||
    t.includes('[账本') ||
    t.includes('[本地断言') ||
    t.includes('硬伤')
  ) {
    return {
      kind: 'hard',
      actionHint:
        '按待修说明修正战力/状态/时间线/人设矛盾，与书级钉死事实对齐；不得另开支线。',
    };
  }
  if (t.includes('[跨章') || t.includes('跨章·') || t.includes('跨章')) {
    return {
      kind: 'audit',
      actionHint:
        '按跨章待修说明消解前后矛盾、称呼/设定漂移或节奏问题；只动本片段，不重写全章。',
    };
  }
  return {
    kind: 'generic',
    actionHint: '按待修说明做最小必要修改，情节结果与专有名词保持一致。',
  };
}

/** 去空白长度（与章字数口径一致）——委托唯一口径出口 */
function stripWsLen(s: string): number {
  return proseWords(s);
}

/**
 * 待修改写的等量替换字数带（治「越修越长」）：
 * 去 AI 味类收紧到 +25%（纯文风修理不该长肉），其余 +50%（修硬伤偶需多一两句交代）；
 * 下限 75%——修复是等量替换，禁止大幅压缩成稿（缩水由章级补写兜底，但源头先收紧）。
 * 锚定选区原文长度而非全章；章级区间约束见 resolveFixMaxChars 与 aiFixRevisionTodo 的补写闸。
 */
export function revisionFixBand(
  selectedChars: number,
  kind: 'aitaste' | 'hard' | 'audit' | 'generic'
): { minChars: number; maxChars: number } {
  const n = Math.max(0, Math.round(selectedChars));
  const maxRatio = kind === 'aitaste' ? 1.25 : 1.5;
  return {
    minChars: Math.max(8, Math.round(n * 0.75)),
    maxChars: Math.max(16, Math.round(n * maxRatio)),
  };
}

/**
 * 章级预算下的改写稿上限：本章余量（上限 − 选区外字数）不足时收紧到余量，
 * 但不低于等量替换（选区原长）——章节已在超写状态时不再恶化，只做等量修理。
 */
export function resolveFixMaxChars(
  bandMax: number,
  selectedWords: number,
  chapterWordsBefore: number,
  chapterMaxWords: number
): number {
  const headroom = chapterMaxWords - (chapterWordsBefore - selectedWords);
  return Math.max(selectedWords, Math.min(bandMax, headroom));
}

/** 句界截短到预算内（中文句读密集，通常能在预算内找到句界；找不到则硬截兜底） */
export function trimToSentenceBudget(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  const window = text.slice(0, Math.max(1, maxChars));
  const floor = Math.floor(maxChars * 0.4);
  for (let i = window.length - 1; i >= floor; i -= 1) {
    if ('。！？…”'.includes(window[i])) return window.slice(0, i + 1);
  }
  return window;
}

async function runTodoGuidedRewrite(input: {
  selected: string;
  todoText: string;
  chapter: Chapter;
  styleConfig: StyleConfig;
  characters?: Character[];
  storyMemory?: StoryMemory | null;
  /** 本书题材：文风档案题材不匹配时降级为只学文笔层 */
  bookGenre?: string | null;
  surroundingBefore?: string;
  surroundingAfter?: string;
  /** 章级字数契约：本章选区外字数与全章上限（传入后改写稿上限收紧到章内余量） */
  chapterWordsBefore?: number;
  chapterMaxWords?: number;
}): Promise<string> {
  const { kind, actionHint } = classifyTodo(input.todoText);
  const parts: string[] = [];
  parts.push(`【章节】第${input.chapter.number}章《${input.chapter.title}》`);
  if (input.chapter.summary?.trim()) {
    parts.push(`【本章梗概】${input.chapter.summary.trim().slice(0, 200)}`);
  }
  if (input.chapter.intent) {
    parts.push(
      `【写前意图】\n${formatIntentForPrompt(input.chapter.intent).slice(0, 500)}`
    );
  }
  if (input.storyMemory && input.characters) {
    const mem = formatStoryMemoryForPrompt(input.storyMemory, input.characters, {
      maxFacts: 8,
      maxThreads: 5,
    });
    parts.push(`【书级记忆摘要】\n${mem.slice(0, 800)}`);
  }

  // 注入用户设置的文风：仿写档案 / few-shot / 黑名单 / Show don't tell / 禁升华
  const styleBlock = formatStyleConstraintsForRewrite(input.styleConfig, {
    profileMaxChars: 1100,
    fewShotMaxChars: 280,
    blacklistMax: 22,
    bookGenre: input.bookGenre,
  });
  if (styleBlock) parts.push(styleBlock);

  if (input.surroundingBefore?.trim()) {
    parts.push(`【前文语境】…${input.surroundingBefore.trim().slice(-140)}`);
  }
  if (input.surroundingAfter?.trim()) {
    parts.push(`【后文语境】${input.surroundingAfter.trim().slice(0, 140)}…`);
  }

  const activeName = getActiveStyleProfile(input.styleConfig)?.name;
  const styleRule = activeName
    ? `改写后的文气必须服从已激活文风仿写「${activeName}」（句长、对白密度、要做/不要做）；禁止写成另一套通用 AI 网文腔。`
    : '改写须对齐下方【目标文风】few-shot / 约束；禁止滑回通用 AI 套话腔。';

  const selectedChars = stripWsLen(input.selected);
  const band = revisionFixBand(selectedChars, kind);
  // 章级字数契约：上限受本章余量约束（不低于等量替换）
  const effMax =
    input.chapterMaxWords && input.chapterWordsBefore != null
      ? resolveFixMaxChars(
          band.maxChars,
          selectedChars,
          input.chapterWordsBefore,
          input.chapterMaxWords
        )
      : band.maxChars;
  const bandHint =
    kind === 'aitaste'
      ? `不超过选区的 1.25 倍，约 ${effMax} 字`
      : `不超过选区的 1.5 倍，约 ${effMax} 字`;

  const callModel = async (msgs: { role: string; content: string }[]) => {
    const out = (await generateText(msgs, 0.55)).trim();
    if (!out) throw new Error('模型返回空结果');
    let t = out;
    if (t.startsWith('```')) {
      const lines = t.split('\n');
      if (lines[0].startsWith('```')) lines.shift();
      if (lines[lines.length - 1]?.startsWith('```')) lines.pop();
      t = lines.join('\n').trim();
    }
    return t;
  };

  const system = `你是连载小说的「待修自动精修」编辑（类型：${kind}），同时必须守住本书文风设定。
硬性规则：
1. 只输出改写后的纯正文片段，无解释、无标题、无 markdown。
2. 必须针对【待修问题】做最小必要修改；能换词不换句，能改一句不改整段；改写稿总长须与选区相当（${bandHint}），禁止借机扩写、加厚或补写场景。
3. 不得推翻书级钉死事实与写前禁止项；不得改变选区外情节；**不得新增人物、地点、道具、伏笔**——新增描写仅限无事实含量的感官与动作细节。
4. 与前后语境自然衔接；禁止新开黑名单套话与章末式升华。
5. ${actionHint}
6. **文风铁律**：${styleRule}`;

  const user = `${parts.join('\n\n')}

【待修问题】
${input.todoText.slice(0, 400)}

【任务】按待修问题改写下面选区，并严格保持本书设定文风；只输出改后正文。

【待处理选区】
${input.selected}`;

  const baseMessages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let text = await callModel(baseMessages);

  // 等量替换闸：越带（过长/过短截断）→ 带反馈重试一次
  if (stripWsLen(text) > effMax || stripWsLen(text) < band.minChars) {
    try {
      text = await callModel([
        ...baseMessages,
        {
          role: 'assistant',
          content: text.slice(0, 800),
        },
        {
          role: 'user',
          content:
            `你返回的改写稿约 ${stripWsLen(text)} 字，允许区间约 ${band.minChars}–${effMax} 字` +
            `（选区原文 ${selectedChars} 字）。请按【最小必要修改】做等量替换：` +
            '保留原有信息量、情节结果与收尾落点，不新增情节/人物/地点/道具，只输出改后正文。',
        },
      ]);
    } catch {
      // 反馈重试失败：沿用首轮结果，交由下方句界截短兜底
    }
  }

  // 终闸：仍超长 → 句界截短，杜绝「越修越长」
  if (stripWsLen(text) > effMax) {
    text = trimToSentenceBudget(text, effMax + 40);
  }
  return text;
}

/**
 * AI 修单条待修：定位片段 → 模型改写 → 替换正文 → 勾完成。
 */
export async function aiFixRevisionTodo(input: {
  chapter: Chapter;
  todo: ChapterRevisionTodo;
  styleConfig: StyleConfig;
  characters?: Character[];
  storyMemory?: StoryMemory | null;
  /** 本书题材：文风档案题材不匹配时降级为只学文笔层 */
  bookGenre?: string | null;
  /** 每章字数目标：传入后执行章级字数契约——
   *  改写稿上限受本章余量约束；修复后全章低于下限自动补写回目标（治「越修越短」） */
  targetWordCount?: number | null;
  /** 成功后是否自动标 done，默认 true */
  markDone?: boolean;
  onProgress?: (msg: string) => void;
}): Promise<AiFixRevisionResult> {
  let chapter = input.chapter;
  const todo = input.todo;
  const markDone = input.markDone !== false;

  if (todo.status === 'done') {
    return {
      chapter,
      replaced: false,
      autoMarkedDone: false,
      before: '',
      after: '',
      message: '该待修已完成',
    };
  }

  // 锁定章先解锁，便于 AI 改稿落盘
  if (isChapterLocked(chapter)) {
    input.onProgress?.(`解锁第${chapter.number}章…`);
    chapter = unlockChapterForRewrite(chapter);
  }

  const prose = chapter.content || '';
  if (!proseWords(prose)) {
    return {
      chapter,
      replaced: false,
      autoMarkedDone: false,
      before: '',
      after: '',
      message: '本章无正文，无法 AI 修',
    };
  }

  const range = locateRevisionFixRange(prose, todo.text);
  if (!range) {
    return {
      chapter,
      replaced: false,
      autoMarkedDone: false,
      before: '',
      after: '',
      message: '无法定位改写范围',
    };
  }

  const selected = prose.slice(range.start, range.end).trim();
  if (selected.length < 4) {
    return {
      chapter,
      replaced: false,
      autoMarkedDone: false,
      before: selected,
      after: '',
      message: '定位片段过短',
    };
  }

  // 章级字数契约的目标（未传/非法则不做章级约束）
  const target =
    input.targetWordCount && input.targetWordCount > 0
      ? Math.round(input.targetWordCount)
      : 0;

  input.onProgress?.(
    `AI 修第${chapter.number}章 · ${todo.text.slice(0, 28)}…（${range.mode}）`
  );

  const after = (
    await runTodoGuidedRewrite({
      selected,
      todoText: todo.text,
      chapter,
      styleConfig: input.styleConfig,
      characters: input.characters,
      storyMemory: input.storyMemory,
      bookGenre: input.bookGenre,
      surroundingBefore: prose.slice(Math.max(0, range.start - 120), range.start),
      surroundingAfter: prose.slice(
        range.end,
        Math.min(prose.length, range.end + 120)
      ),
      chapterWordsBefore: target > 0 ? stripWsLen(prose) : undefined,
      chapterMaxWords: target > 0 ? Math.round(target * 1.1) : undefined,
    })
  ).trim();

  if (!after || after === selected) {
    input.onProgress?.('改写无实质变化');
    return {
      chapter,
      replaced: false,
      autoMarkedDone: false,
      before: selected,
      after,
      message: '改写无实质变化，未替换',
    };
  }

  const rawSlice = prose.slice(range.start, range.end);
  const leadWs = rawSlice.match(/^\s*/)?.[0] || '';
  const trailWs = rawSlice.match(/\s*$/)?.[0] || '';
  let finalProse =
    prose.slice(0, range.start) + leadWs + after + trailWs + prose.slice(range.end);

  // —— 章级字数契约：修复后全章低于目标区间下限 → 自动补写回目标（治「越修越短」）——
  if (target > 0 && stripWsLen(finalProse) < Math.round(target * 0.9)) {
    input.onProgress?.(
      ` [字数契约] 修复后全章 ${stripWsLen(finalProse)} 字 < 下限 ${Math.round(
        target * 0.9
      )}，自动补写回目标 ${target}…`
    );
    try {
      const topped = await ensureProseWordCount({
        prose: finalProse,
        targetWordCount: target,
        chapter: {
          number: chapter.number,
          title: chapter.title,
          summary: chapter.summary,
        },
        beats: chapter.beats || [],
        characters: input.characters || [],
        styleConfig: input.styleConfig,
        maxRounds: 1,
        onProgress: input.onProgress,
      });
      finalProse = topped.prose;
    } catch (err: any) {
      input.onProgress?.(
        ` [字数契约] 补写失败（保留修复结果）：${err?.message || err}`
      );
    }
  }

  chapter = {
    ...chapter,
    content: finalProse,
    wordCount: proseWords(finalProse),
    contentUpdatedAt: new Date().toISOString(),
    lastModified: new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    }),
  };

  let autoMarkedDone = false;
  if (markDone) {
    chapter = toggleRevisionTodoOnChapter(chapter, todo.id);
    autoMarkedDone = true;
  }

  input.onProgress?.(
    `已 AI 修第${chapter.number}章` + (autoMarkedDone ? ' · 已勾完成' : '')
  );

  return {
    chapter,
    replaced: true,
    autoMarkedDone,
    before: selected,
    after,
    message: autoMarkedDone
      ? `AI 已改写并勾完成 · 第${chapter.number}章`
      : `AI 已改写 · 第${chapter.number}章`,
    focusSnippet: after.slice(0, 48),
  };
}

/**
 * AI 修全书第一条未完成待修（优先跨章/硬伤/去AI）。
 */
export async function aiFixFirstOpenRevision(input: {
  chapters: Chapter[];
  styleConfig: StyleConfig;
  characters?: Character[];
  storyMemory?: StoryMemory | null;
  /** 本书题材：文风档案题材不匹配时降级为只学文笔层 */
  bookGenre?: string | null;
  /** 每章字数目标（透传 aiFixRevisionTodo 的章级字数契约） */
  targetWordCount?: number | null;
  pickFirst: (chapters: Chapter[]) => {
    chapterId: string;
    todo: ChapterRevisionTodo;
  } | null;
  onProgress?: (msg: string) => void;
}): Promise<
  AiFixRevisionResult & {
    chapterId: string;
    todoId: string;
  }
> {
  const first = input.pickFirst(input.chapters);
  if (!first) {
    return {
      chapter: input.chapters[0],
      chapterId: '',
      todoId: '',
      replaced: false,
      autoMarkedDone: false,
      before: '',
      after: '',
      message: '暂无待修项',
    };
  }
  const ch = input.chapters.find((c) => c.id === first.chapterId);
  if (!ch) {
    return {
      chapter: input.chapters[0],
      chapterId: first.chapterId,
      todoId: first.todo.id,
      replaced: false,
      autoMarkedDone: false,
      before: '',
      after: '',
      message: '章节不存在',
    };
  }
  const r = await aiFixRevisionTodo({
    chapter: ch,
    todo: first.todo,
    styleConfig: input.styleConfig,
    characters: input.characters,
    storyMemory: input.storyMemory,
    bookGenre: input.bookGenre,
    targetWordCount: input.targetWordCount,
    onProgress: input.onProgress,
  });
  return {
    ...r,
    chapterId: first.chapterId,
    todoId: first.todo.id,
  };
}
