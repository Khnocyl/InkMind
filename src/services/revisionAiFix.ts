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

async function runTodoGuidedRewrite(input: {
  selected: string;
  todoText: string;
  chapter: Chapter;
  styleConfig: StyleConfig;
  characters?: Character[];
  storyMemory?: StoryMemory | null;
  surroundingBefore?: string;
  surroundingAfter?: string;
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

  const system = `你是连载小说的「待修自动精修」编辑（类型：${kind}），同时必须守住本书文风设定。
硬性规则：
1. 只输出改写后的纯正文片段，无解释、无标题、无 markdown。
2. 必须针对【待修问题】做最小必要修改；能换词不换句，能改一句不改整段。
3. 不得推翻书级钉死事实与写前禁止项；不得改变选区外情节。
4. 与前后语境自然衔接；禁止新开黑名单套话与章末式升华。
5. ${actionHint}
6. **文风铁律**：${styleRule}`;

  const user = `${parts.join('\n\n')}

【待修问题】
${input.todoText.slice(0, 400)}

【任务】按待修问题改写下面选区，并严格保持本书设定文风；只输出改后正文。

【待处理选区】
${input.selected}`;

  const out = (
    await generateText(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      0.55
    )
  ).trim();

  if (!out) throw new Error('模型返回空结果');
  let text = out;
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1]?.startsWith('```')) lines.pop();
    text = lines.join('\n').trim();
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
  if (!prose.replace(/\s+/g, '').length) {
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
      surroundingBefore: prose.slice(Math.max(0, range.start - 120), range.start),
      surroundingAfter: prose.slice(
        range.end,
        Math.min(prose.length, range.end + 120)
      ),
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
  const newProse =
    prose.slice(0, range.start) + leadWs + after + trailWs + prose.slice(range.end);

  chapter = {
    ...chapter,
    content: newProse,
    wordCount: newProse.replace(/\s+/g, '').length,
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
    onProgress: input.onProgress,
  });
  return {
    ...r,
    chapterId: first.chapterId,
    todoId: first.todo.id,
  };
}
