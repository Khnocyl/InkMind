/**
 * 拆书：导入成品小说（本地 TXT/MD 或 URL 抓取）→ 反推结构 / 设定 / 写法。
 *
 * 产物是一本真实可打开的模板书（BookProject，deconstructMeta 标记）：
 * 逐章拆解写 chapter.summary / beats / deconstruct，全书综合归并出
 * characters / settings。可基于模板书开新书或当写作参照。
 *
 * 站点无关的中性能力：URL 抓取只调 server 的 /api/fetch-article（收紧版
 * SSRF 校验 + 限速 + 体积上限），本服务不内置任何站点适配，不绕过任何访问控制。
 */
import { generateJSON } from './llmClient';
import { fetchWithTimeout } from './llmResilience';
import { proseWords } from './proseWords';
import { initDB, STORE_META, DECONSTRUCT_JOB_PREFIX, getDefaultStyleConfig } from './storage';
import {
  buildDeconstructChapterPrompt,
  buildDeconstructSynthesisPrompt,
} from './prompts';
import type {
  BookProject,
  Chapter,
  ChapterDeconstruct,
  Character,
  CharacterRelation,
  CharacterRole,
  PlotBeat,
  SettingCategory,
  Volume,
  WorldSetting,
} from '../types/novel';

// ─── 中文数字解析 ────────────────────────────────────────────────────────

const CN_DIGIT: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 「十二」→12、「一百零三」→103、「两千五百」→2500；阿拉伯数字直接转。 */
export function parseCnNumber(text: string): number {
  const t = (text || '').trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  let result = 0;
  let current = 0;
  for (const ch of t) {
    if (ch in CN_DIGIT) {
      current = CN_DIGIT[ch];
    } else if (ch === '十') {
      result += (current || 1) * 10;
      current = 0;
    } else if (ch === '百') {
      result += (current || 1) * 100;
      current = 0;
    } else if (ch === '千') {
      result += (current || 1) * 1000;
      current = 0;
    } else if (ch === '万') {
      result = (result + current) * 10000;
      current = 0;
    }
    // 零 与未知字符跳过
  }
  return result + current;
}

// ─── 切章 ────────────────────────────────────────────────────────────────

export interface SplitChapter {
  title: string;
  content: string;
  /** 所属卷标题（无卷结构的书为空） */
  volumeTitle?: string;
  charCount: number;
  /**
   * 抓取/提取失败的占位章（URL 目录页批量抓取时单章失败，或该页根本不是正文）。
   * 仅供预览列表展示失败原因，**不得进入模板书、不得送 LLM 拆解**。
   */
  failed?: boolean;
  /** 失败原因（展示给用户，用于区分「网站页有问题」与「我们这边出问题」） */
  failReason?: string;
  /**
   * 「内容可能不完整」的警告（如章内分页没能合并）。
   * 与 failed 不同：这一章**能**进模板书，但正文可能缺后半段。
   */
  warning?: string;
}

/** 判定「这一页不像正文章节」的字数下限（去空白后）。反爬页/JS 空壳/404 页都远低于此 */
export const MIN_CHAPTER_CHARS = 60;

const countNonSpace = (text: string): number => proseWords(text);

/**
 * 拆解输入体检：这段文本像不像「一章正文」。
 * 抓取侧（预览前拦下垃圾章）与拆解侧（调模型前拦下白烧）共用同一判据，
 * 避免两处标准不一致。原因文案要能让人区分「网站页有问题」与「我们这边有问题」。
 */
export function assessDeconstructInput(text: string): {
  ok: boolean;
  charCount: number;
  reason?: string;
} {
  const charCount = countNonSpace(text);
  if (charCount === 0) {
    return {
      ok: false,
      charCount,
      reason: '正文为空——该页可能是 JS 动态渲染、反爬拦截页或错误页（我们只做静态 HTML 提取）',
    };
  }
  if (charCount < MIN_CHAPTER_CHARS) {
    return {
      ok: false,
      charCount,
      reason:
        `正文过短（仅 ${charCount} 字）——该页可能是 JS 渲染/反爬拦截页/目录页，` +
        `或正文不在可提取的 HTML 里`,
    };
  }
  return { ok: true, charCount };
}

/** 旧版导入在抓取失败的章里留下的占位正文（报告体检要能把它认出来） */
const PLACEHOLDER_BODY_RE = /^【抓取失败[:：]/;

/** 章节正文是否像正文章节（不含旧版占位）；报告用它把「没抓到」与「拆解失败」分开 */
export function hasUsableChapterBody(content: string | undefined): boolean {
  const text = (content || '').trim();
  if (!text || PLACEHOLDER_BODY_RE.test(text)) return false;
  return countNonSpace(text) >= MIN_CHAPTER_CHARS;
}

const CHAPTER_HEADING_RE =
  /^(第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回折话集]|Chapter\s+\d{1,5})(?=[\s:：·\-._]|$)(.*)$/i;
const NUMBERED_HEADING_RE = /^(\d{1,4})\s*[、.．]\s*(\S.*)?$/;
const VOLUME_HEADING_RE =
  /^(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*卷|卷\s*[0-9零一二三四五六七八九十百千万两]+)[\s:：·\-._]*(.*)$/;

/**
 * 把整本 TXT/MD 文本切成章。
 * 识别「第N章/节/回/话」「Chapter N」「N、标题」（短行防误伤正文列表）与卷标题；
 * 全文无任何章标题时按 ~4000 字段落在段落边界兜底分块。
 */
export function splitChapters(raw: string): SplitChapter[] {
  const text = (raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];

  const lines = text.split('\n');
  const splits: SplitChapter[] = [];
  let currentTitle = '';
  let currentVolume: string | undefined;
  let buffer: string[] = [];
  let sawHeading = false;

  // ── 预扫描：纯「1、标题」编号的书（没有任何「第N章」）────────────────────
  // 此前 NUMBERED_HEADING_RE 只在 sawHeading 为真时才生效，而这类书永远没有正式章标题
  // → 一章都切不出，最后整本被 4000 字硬切（切断场景）。
  // 判别要够保守：≥3 条递增编号（从 1 起）且相邻标题平均间距 ≥20 行，
  // 正文里的短列表（连着几行 1、2、3，间距 1-2）不会误触发。
  const hasFormalHeading = lines.some(
    (l) => l.trim().length <= 60 && CHAPTER_HEADING_RE.test(l.trim())
  );
  const numberedIdx: number[] = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.length <= 30 && NUMBERED_HEADING_RE.test(t)) numberedIdx.push(i);
  });
  let numberedOnly = false;
  if (!hasFormalHeading && numberedIdx.length >= 3) {
    const nums = numberedIdx.map((i) => Number(lines[i].trim().match(NUMBERED_HEADING_RE)![1]));
    const ascendingFrom1 = nums[0] === 1 && nums.every((n, k) => k === 0 || n === nums[k - 1] + 1);
    const gaps = numberedIdx.slice(1).map((v, k) => v - numberedIdx[k]);
    const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
    numberedOnly = ascendingFrom1 && avgGap >= 20;
  }

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content || splits.length > 0) {
      splits.push({
        title: currentTitle,
        content,
        volumeTitle: currentVolume,
        charCount: proseWords(content),
      });
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const volumeMatch = line.match(VOLUME_HEADING_RE);
    if (volumeMatch && line.length <= 40) {
      flush();
      sawHeading = true;
      currentVolume = (volumeMatch[1] || '').trim() || line;
      currentTitle = '';
      continue;
    }
    const chapterMatch = line.match(CHAPTER_HEADING_RE);
    if (chapterMatch && line.length <= 60) {
      flush();
      sawHeading = true;
      currentTitle = line;
      continue;
    }
    // 「123、标题」形态：纯编号书（numberedOnly）或已出现过正式章标题时才认（防正文列表误伤）
    const numberedMatch = line.match(NUMBERED_HEADING_RE);
    if (numberedMatch && (numberedOnly || sawHeading) && line.length <= 30) {
      flush();
      currentTitle = line;
      continue;
    }
    buffer.push(rawLine);
  }
  flush();

  // 无任何章标题 → 段落边界兜底分块
  if (!sawHeading && splits.length === 1 && splits[0].charCount > 6000) {
    return chunkByParagraphs(text);
  }
  // 首块可能是书名/前言（标题为空且很短）：并入下一章
  if (splits.length > 1 && !splits[0].title && splits[0].charCount < 800) {
    const first = splits.shift()!;
    splits[0].content = `${first.content}\n\n${splits[0].content}`.trim();
    splits[0].charCount = proseWords(splits[0].content);
  }
  return splits.filter((s) => s.charCount > 0 || s.title);
}

function chunkByParagraphs(text: string): SplitChapter[] {
  const paras = text.split(/\n\s*\n|\n/).filter((p) => p.trim());
  const out: SplitChapter[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  for (const p of paras) {
    buf.push(p);
    bufLen += proseWords(p);
    if (bufLen >= 4000) {
      const content = buf.join('\n');
      out.push({
        title: `片段 ${out.length + 1}`,
        content,
        charCount: proseWords(content),
      });
      buf = [];
      bufLen = 0;
    }
  }
  if (buf.length) {
    const content = buf.join('\n');
    out.push({
      title: `片段 ${out.length + 1}`,
      content,
      charCount: proseWords(content),
    });
  }
  return out;
}

// ─── 模板书组装 ──────────────────────────────────────────────────────────

/**
 * 由切章结果组装模板书项目（真实可打开的 BookProject）。
 * 章节统一「精修定稿 + 锁定」：导入的是成品文本，防止被流水线/Auto-Pilot 覆盖。
 */
export function createTemplateProject(input: {
  splits: SplitChapter[];
  source: 'file' | 'url';
  sourceName: string;
  suggestedTitle?: string;
}): BookProject {
  const now = new Date().toISOString();
  const stamp = Date.now().toString(36);
  const splits = input.splits;

  // 卷分组：按切章时记录的卷标题；无卷结构的书归入「正文」一卷
  const volumeTitles: string[] = [];
  for (const s of splits) {
    const v = s.volumeTitle || '';
    if (v && !volumeTitles.includes(v)) volumeTitles.push(v);
  }
  const hasVolumes = volumeTitles.length > 0;
  const volumes: Volume[] = [];
  const chapters: Chapter[] = [];
  let currentVolumeId = '';
  let currentVolumeNumber = 0;
  const wordCounts = splits.map((s) => s.charCount).filter((n) => n > 0);
  const avgWords = wordCounts.length
    ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
    : 3000;

  // 按「卷标题首次出现顺序」建卷，并用 Map 去重：同一卷标题再次出现（乱序/重复）
  // 时沿用已建卷、只扩 endChapter。此前用 `indexOf` 与当前卷号比较后无条件 push，
  // 卷标题乱序（1→2→1）会产出**重复 id** 的卷。
  const volumeByTitle = new Map<string, Volume>();

  splits.forEach((s, i) => {
    const number = i + 1;
    if (hasVolumes) {
      const vTitle = s.volumeTitle || volumeTitles[0];
      let vol = volumeByTitle.get(vTitle);
      if (!vol) {
        vol = {
          id: `vol-dec-${stamp}-${volumeByTitle.size + 1}`,
          number: volumeByTitle.size + 1,
          title: vTitle,
          summary: '',
          startChapter: number,
          endChapter: number,
        };
        volumeByTitle.set(vTitle, vol);
        volumes.push(vol);
      } else {
        vol.endChapter = number;
      }
      currentVolumeId = vol.id;
      currentVolumeNumber = vol.number;
    }
    chapters.push({
      id: `ch-dec-${stamp}-${number}`,
      number,
      title: s.title || `第${number}章`,
      summary: '',
      wordCount: s.charCount,
      status: '精修定稿',
      content: s.content,
      volumeId: hasVolumes ? currentVolumeId : undefined,
      volumeNumber: hasVolumes ? currentVolumeNumber : undefined,
      involvedCharacterIds: [],
      involvedSettingIds: [],
      beats: [],
      lastModified: now,
      contentUpdatedAt: now,
      locked: true,
      lockedAt: now,
    });
  });

  if (!hasVolumes) {
    volumes.push({
      id: `vol-dec-${stamp}-1`,
      number: 1,
      title: '正文',
      summary: '',
      startChapter: 1,
      endChapter: chapters.length,
    });
  }

  const title = (input.suggestedTitle || input.sourceName || '拆书模板').trim();
  return {
    id: `proj-dec-${stamp}`,
    title,
    subtitle: '拆书模板',
    genre: '待综合判定',
    synopsis: '',
    config: {
      inspiration: '',
      genre: '待综合判定',
      targetChapterCount: chapters.length,
      targetWordCountPerChapter: avgWords,
      totalChapters: chapters.length,
      wordsPerChapter: avgWords,
      writingStyle: '',
      customParameters: {},
    },
    wizardStep: 'ready',
    characters: [],
    settings: [],
    volumes,
    chapters,
    currentChapterId: chapters[0]?.id || '',
    styleConfig: getDefaultStyleConfig(),
    createdAt: now,
    createdDate: now.slice(0, 10),
    lastModified: now,
    deconstructMeta: {
      source: input.source,
      sourceName: input.sourceName,
      importedAt: now,
    },
  };
}

// ─── 逐章拆解（LLM）────────────────────────────────────────────────────

const SOURCE_LIMIT = 6000;

/** 超长章截头留尾：拆解结构不需要精读全文，控 token 成本 */
export function clampSourceText(content: string): string {
  if (content.length <= SOURCE_LIMIT) return content;
  const tailLen = 1500;
  return `${content.slice(0, SOURCE_LIMIT - tailLen)}\n……（中段略）……\n${content.slice(-tailLen)}`;
}

// ─── 文风参考源抽样（拆书模板书 → 仅本书的文风注入）──────────────────────

/** 参考源抽样默认：10 章 / 约 4200 字（与 buildStyleAnalyzePrompt 的 4500 字上限对齐） */
export const STYLE_SAMPLE_CHAPTERS = 10;
export const STYLE_SAMPLE_MAX_CHARS = 4200;

/**
 * 为「本书参考源」抽样正文：首/中/尾均匀取样，跳过没正文的章。
 *
 * 为什么必须抽样：`buildStyleAnalyzePrompt` 只取样本的**首 2200 + 尾 2200 字**，
 * 整本书直接丢进去 = 只学了全书第一段与最后一段；抽样之后统计指纹与 LLM 指南口径才一致。
 * 纯本地、可复现（同一本书 + 同一参数 → 同一份样本）。
 */
export function sampleProseForStyle(
  chapters: Chapter[],
  options?: { chapterCount?: number; maxChars?: number }
): { text: string; chapterNumbers: number[]; charCount: number } {
  const count = Math.max(2, Math.min(40, options?.chapterCount ?? STYLE_SAMPLE_CHAPTERS));
  const maxChars = Math.max(
    1200,
    Math.min(4400, options?.maxChars ?? STYLE_SAMPLE_MAX_CHARS)
  );
  const usable = chapters.filter((c) => hasUsableChapterBody(c.content));
  if (!usable.length) return { text: '', chapterNumbers: [], charCount: 0 };

  // 预算内最多取几章：每章至少 MIN_PER_CHAPTER 字，且**总预算不得超过 maxChars**。
  // 两者冲突时以总预算为准——它对齐 buildStyleAnalyzePrompt 的首尾各 2200 字上限；
  // 超预算时 prompt 只会取到样本首尾、中段被静默丢弃，均匀抽样就白做了。
  // （此前 per 的 200 字下限会突破预算：{chapterCount:40, maxChars:1200} → 总量 8000。）
  // 截断标记 '……' 连同两侧换行占 4 字符，需从配额里预留，否则每章会略微超出。
  const MIN_PER_CHAPTER = 200;
  const SEPARATOR_CHARS = 4;
  const budgetCount = Math.max(
    2,
    Math.floor(maxChars / (MIN_PER_CHAPTER + SEPARATOR_CHARS))
  );
  const takeCount = Math.min(count, budgetCount);

  const picked: Chapter[] = [];
  if (usable.length <= takeCount) {
    picked.push(...usable);
  } else {
    // 均匀取样（含首尾）：step=(n-1)/(count-1)，四舍五入后去重
    const seen = new Set<number>();
    for (let i = 0; i < takeCount; i += 1) {
      const idx = Math.round((i * (usable.length - 1)) / (takeCount - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      picked.push(usable[idx]);
    }
  }

  const per = Math.max(
    MIN_PER_CHAPTER,
    Math.floor(maxChars / picked.length) - SEPARATOR_CHARS
  );
  const parts: string[] = [];
  const chapterNumbers: number[] = [];
  let charCount = 0;
  for (const c of picked) {
    const body = (c.content || '').trim();
    if (!body) continue;
    let piece = body;
    if (body.length > per) {
      // 单章也截头留尾：首段给起手式与语感，尾段给收束/钩子习惯
      const head = Math.floor(per * 0.6);
      piece = `${body.slice(0, head)}\n……\n${body.slice(-(per - head))}`;
    }
    parts.push(piece);
    chapterNumbers.push(c.number);
    charCount += proseWords(piece);
  }
  return { text: parts.join('\n\n'), chapterNumbers, charCount };
}

/**
 * 逐章拆解数据的字段版本。**新增/改动逐章字段时必须 +1**：
 * 断点续跑以「数据是否完整」而非「是否存在」为判据，旧书才会被识别为待补齐，
 * 而不是永远停留在旧字段上（`v` 缺省 = 1，即新增 emotion 之前的版本）。
 */
export const DECONSTRUCT_SCHEMA_VERSION = 2;

/** 章节拆解数据是否已含当前 schema 的全部字段（缺 `v` 或版本低 → 待补齐） */
export function isDeconstructComplete(d: ChapterDeconstruct | undefined): boolean {
  return !!d && (d.v ?? 1) >= DECONSTRUCT_SCHEMA_VERSION;
}

/** 尚待处理的章节数：缺拆解，或拆解数据版本落后于当前 schema（补齐模式的处理量） */
export function countPendingDeconstruct(chapters: Chapter[]): number {
  return chapters.filter((c) => !isDeconstructComplete(c.deconstruct)).length;
}

interface RawChapterDeconstruct {
  summary?: unknown;
  beats?: unknown;
  characterNames?: unknown;
  newSettings?: unknown;
  foreshadowPlant?: unknown;
  foreshadowPayoff?: unknown;
  hookType?: unknown;
  hookStrength?: unknown;
  payoffType?: unknown;
  emotion?: unknown;
}

const asStringArray = (v: unknown, max = 20): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => String(x || '').trim())
        .filter(Boolean)
        .slice(0, max)
    : [];

/**
 * 防御性 normalize：LLM 返回的拆解对象 → ChapterDeconstruct + summary/beats。
 * 字段缺失/类型不对时给安全默认值，绝不把 undefined 混进类型系统。
 */
export function normalizeDeconstructed(
  raw: unknown
): (ChapterDeconstruct & { summary: string; beats: PlotBeat[] }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawChapterDeconstruct;
  const summary = String(r.summary || '').trim();
  if (!summary) return null;
  const rawBeats = Array.isArray(r.beats) ? r.beats : [];
  const beats: PlotBeat[] = rawBeats
    .map((b, i) => {
      const obj = (b && typeof b === 'object' ? b : {}) as { order?: unknown; description?: unknown };
      const description = String(obj.description || '').trim();
      if (!description) return null;
      const order = Number.isFinite(Number(obj.order)) ? Number(obj.order) : i + 1;
      return { id: `beat-dec-${Date.now().toString(36)}-${i}`, order, description };
    })
    .filter((b): b is PlotBeat => !!b);
  const hookStrength = Number(r.hookStrength);
  return {
    summary: summary.slice(0, 400),
    beats,
    characterNames: asStringArray(r.characterNames, 30),
    newSettings: asStringArray(r.newSettings, 12),
    foreshadowPlant: asStringArray(r.foreshadowPlant, 12),
    foreshadowPayoff: asStringArray(r.foreshadowPayoff, 12),
    hookType: String(r.hookType || '').trim().slice(0, 16) || undefined,
    hookStrength:
      Number.isFinite(hookStrength) ? Math.min(10, Math.max(0, Math.round(hookStrength))) : undefined,
    payoffType: String(r.payoffType || '').trim().slice(0, 16) || undefined,
    emotion: clampEmotion(r.emotion),
    analyzedAt: new Date().toISOString(),
    v: DECONSTRUCT_SCHEMA_VERSION,
  };
}

/** 情绪张力收敛到 -9~+9；空值/非法值返回 undefined（不虚构中性值 0） */
export function clampEmotion(v: unknown): number | undefined {
  // 必须先排空值再 Number()：Number(null) / Number('') / Number([]) 都得 0，
  // 否则模型返回 "emotion": null 会被静默写成「0 = 平稳推进」，
  // 与「不虚构中性值」的承诺相反，还会污染均值与峰谷。
  if (v == null || typeof v === 'boolean' || Array.isArray(v)) return undefined;
  if (typeof v === 'string' && !v.trim()) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(9, Math.max(-9, Math.round(n)));
}

/**
 * 导入侧归一：外部 JSON 里的 `deconstruct` 透传并收敛（不信任其类型与范围）。
 * 全空对象返回 undefined —— 否则「有 deconstruct 但一个字段都没有」会污染
 * 「已拆解 N 章」统计，也会让断点判据误以为本章已拆完。
 */
export function normalizeChapterDeconstruct(raw: unknown): ChapterDeconstruct | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as RawChapterDeconstruct & { v?: unknown; analyzedAt?: unknown };
  const hookStrength = Number(r.hookStrength);
  const out: ChapterDeconstruct = {
    hookType: String(r.hookType || '').trim().slice(0, 16) || undefined,
    hookStrength: Number.isFinite(hookStrength)
      ? Math.min(10, Math.max(0, Math.round(hookStrength)))
      : undefined,
    payoffType: String(r.payoffType || '').trim().slice(0, 16) || undefined,
    emotion: clampEmotion(r.emotion),
    foreshadowPlant: asStringArray(r.foreshadowPlant, 12),
    foreshadowPayoff: asStringArray(r.foreshadowPayoff, 12),
    newSettings: asStringArray(r.newSettings, 12),
    characterNames: asStringArray(r.characterNames, 30),
    analyzedAt: String(r.analyzedAt || '').trim() || undefined,
    v: Number.isFinite(Number(r.v)) ? Math.round(Number(r.v)) : undefined,
  };
  const meaningful =
    !!out.hookType ||
    !!out.payoffType ||
    out.hookStrength != null ||
    out.emotion != null ||
    !!out.analyzedAt ||
    !!out.foreshadowPlant?.length ||
    !!out.foreshadowPayoff?.length ||
    !!out.newSettings?.length ||
    !!out.characterNames?.length;
  return meaningful ? out : undefined;
}

/** 逐章拆解：LLM 反推一章的结构数据（generateJSON + validate 闸门） */
export async function deconstructChapterLLM(options: {
  chapterNumber: number;
  chapterTitle: string;
  content: string;
  knownCharacters?: string[];
  signal?: AbortSignal;
}): Promise<ChapterDeconstruct & { summary: string; beats: PlotBeat[] }> {
  // 先体检再调模型：空/超短正文必然拆不出东西，提前失败能给出**明确原因**
  // （否则模型返回不完整、报「缺少有效 summary」，用户无从判断是网站问题还是我们这边的问题），
  // 也避免白烧一次调用与几秒等待。
  const intake = assessDeconstructInput(options.content);
  if (!intake.ok) {
    throw new Error(`第${options.chapterNumber}章无法拆解：${intake.reason}`);
  }
  const messages = buildDeconstructChapterPrompt({
    chapterNumber: options.chapterNumber,
    chapterTitle: options.chapterTitle,
    sourceText: clampSourceText(options.content),
    knownCharacters: options.knownCharacters,
  });
  const res = await generateJSON<RawChapterDeconstruct>(messages, 0.3, {
    signal: options.signal,
    validate: (v) => {
      if (!v || typeof v !== 'object') return '返回不是 JSON 对象';
      if (!String(v.summary || '').trim()) return '缺少 summary';
      if (!Array.isArray(v.beats) || v.beats.length === 0) return 'beats 数组缺失或为空';
      return null;
    },
  });
  const normalized = normalizeDeconstructed(res);
  if (!normalized) {
    throw new Error(
      `第${options.chapterNumber}章拆解结果缺少有效 summary（模型返回不完整或本章正文不成立）`
    );
  }
  return normalized;
}

// ─── 全书综合（LLM）────────────────────────────────────────────────────

const CHARACTER_ROLES: CharacterRole[] = ['主角', '重要配角', '反派', '势力首领', '神秘路人'];
const SETTING_CATEGORIES: SettingCategory[] = [
  '力量与境界体系',
  '世界地理势力',
  '功法神兵道具',
  '天道禁忌与法则',
  '核心历史伏笔',
];

export interface BookSynthesis {
  suggestedTitle: string;
  genre: string;
  synopsis: string;
  characters: Character[];
  settings: WorldSetting[];
}

interface RawSynthesis {
  suggestedTitle?: unknown;
  genre?: unknown;
  synopsis?: unknown;
  characters?: unknown;
  settings?: unknown;
}

/** 逐章摘要压缩为综合输入（超长书均匀抽样控 token） */
export function buildChapterDigests(chapters: Chapter[], maxLines = 240): string[] {
  const withData = chapters.filter((c) => c.deconstruct || c.summary);
  const step = withData.length > maxLines ? withData.length / maxLines : 1;
  const lines: string[] = [];
  for (let i = 0; i < withData.length; i += step) {
    const c = withData[Math.floor(i)];
    const d = c.deconstruct;
    lines.push(
      `${c.number}｜${(c.summary || '').slice(0, 60)}｜` +
        `${(d?.characterNames || []).join('/') || '—'}｜` +
        `${(d?.newSettings || []).join('/') || '—'}`
    );
  }
  return lines;
}

/** 全书综合：归并人物卡/世界观 + 题材判断（一次 LLM 调用） */
export async function synthesizeBookLLM(options: {
  bookTitle: string;
  chapters: Chapter[];
  signal?: AbortSignal;
}): Promise<BookSynthesis> {
  const messages = buildDeconstructSynthesisPrompt({
    bookTitle: options.bookTitle,
    chapterDigests: buildChapterDigests(options.chapters),
  });
  const res = await generateJSON<RawSynthesis>(messages, 0.3, {
    signal: options.signal,
    validate: (v) => {
      if (!v || typeof v !== 'object') return '返回不是 JSON 对象';
      if (!Array.isArray(v.characters) || v.characters.length === 0) return 'characters 缺失或为空';
      if (!Array.isArray(v.settings)) return 'settings 缺失';
      return null;
    },
  });
  const stamp = Date.now().toString(36);
  const characters: Character[] = [];
  for (const [i, c] of (Array.isArray(res.characters) ? res.characters : []).entries()) {
    const name = String((c as any)?.name || '').trim();
    if (!name || characters.length >= 20) continue;
    const role: CharacterRole = CHARACTER_ROLES.includes((c as any)?.role)
      ? ((c as any).role as CharacterRole)
      : '重要配角';
    characters.push({
      id: `char-dec-${stamp}-${i}`,
      name: canonicalCharName(name),
      alias: '',
      role,
      status: '活跃',
      realmOrTitle: String((c as any)?.realmOrTitle || '').trim().slice(0, 30),
      currentLocation: '',
      personality: String((c as any)?.personality || '').trim().slice(0, 120),
      appearance: '',
      background: String((c as any)?.background || '').trim().slice(0, 300),
      relations: [],
      secretNotes: '',
    });
  }
  const settings: WorldSetting[] = [];
  for (const [i, s] of (Array.isArray(res.settings) ? res.settings : []).entries()) {
    const name = String((s as any)?.name || '').trim();
    if (!name || settings.length >= 20) continue;
    const category: SettingCategory = SETTING_CATEGORIES.includes((s as any)?.category)
      ? ((s as any).category as SettingCategory)
      : '世界地理势力';
    settings.push({
      id: `set-dec-${stamp}-${i}`,
      category,
      name: name.slice(0, 40),
      description: String((s as any)?.description || '').trim().slice(0, 400),
      hardRules: [],
      tags: [],
      isActive: true,
    });
  }
  resolveCharacterRelations(characters, Array.isArray(res.characters) ? res.characters : []);

  return {
    suggestedTitle: String(res.suggestedTitle || options.bookTitle || '').trim().slice(0, 60),
    genre: String(res.genre || '').trim().slice(0, 30) || '未分类',
    synopsis: String(res.synopsis || '').trim().slice(0, 300),
    characters,
    settings,
  };
}

/** 人物卡名字的最大长度（综合与映射必须用同一截断口径，否则 >24 字的人名匹配不上） */
const CHAR_NAME_MAX = 24;

/** 人名归一化：映射/解析时两侧统一按此截断，避免「卡名被截短、逐章名是全名」匹配不上 */
const canonicalCharName = (n: string): string => n.slice(0, CHAR_NAME_MAX);

/**
 * 把模型输出的角色关系按「对方角色名」解析为 targetId 并回填。
 * 未知名 / 自指 / 重复关系跳过；intimacy 收敛到 -100~100；每人最多 8 条。
 * （若模型用了列表外的名字，该条丢弃——宁缺毋滥，不虚构关系对象。）
 */
export function resolveCharacterRelations(
  characters: Character[],
  rawCharacters: unknown[]
): void {
  const byName = new Map(characters.map((c) => [canonicalCharName(c.name), c]));
  for (const rc of rawCharacters) {
    const selfName = canonicalCharName(String((rc as { name?: unknown })?.name || '').trim());
    const self = byName.get(selfName);
    if (!self) continue;
    const rawList = Array.isArray((rc as { relations?: unknown })?.relations)
      ? ((rc as { relations: unknown[] }).relations)
      : [];
    const relations: CharacterRelation[] = [];
    for (const r of rawList) {
      if (relations.length >= 8) break;
      const targetName = canonicalCharName(
        String((r as { name?: unknown })?.name || '').trim()
      );
      const relation = String((r as { relation?: unknown })?.relation || '').trim();
      if (!relation) continue;
      const target = byName.get(targetName);
      if (!target || target.id === self.id) continue;
      if (relations.some((x) => x.targetId === target.id)) continue;
      const intimacy = Number((r as { intimacy?: unknown })?.intimacy);
      relations.push({
        targetId: target.id,
        relation: relation.slice(0, 30),
        intimacy: Number.isFinite(intimacy)
          ? Math.min(100, Math.max(-100, Math.round(intimacy)))
          : 0,
      });
    }
    self.relations = relations;
  }
}

/** 综合后把人物名映射为角色 id，回填各章 involvedCharacterIds */
export function applyCharacterIdMapping(project: BookProject): void {
  const byName = new Map<string, string>();
  for (const c of project.characters) {
    byName.set(canonicalCharName(c.name), c.id);
  }
  for (const ch of project.chapters) {
    const names = ch.deconstruct?.characterNames || [];
    ch.involvedCharacterIds = names
      .map((n) => byName.get(canonicalCharName(n)))
      .filter((id): id is string => !!id);
  }
}

// ─── URL 抓取（走 server 中性代理，站点无关）────────────────────────────

export interface FetchedPage {
  html: string;
  finalUrl: string;
}

/** 经 server /api/fetch-article 抓取一个 URL（SSRF 校验/限速/体积上限都在服务端） */
export async function fetchArticleViaServer(
  url: string,
  signal?: AbortSignal
): Promise<FetchedPage> {
  const res = await fetchWithTimeout(
    '/api/fetch-article',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    },
    45_000,
    signal,
    45_000
  );
  const data = await res.json();
  if (!res.ok || !data?.success) {
    throw new Error(data?.error || `抓取失败（HTTP ${res.status}）`);
  }
  return { html: String(data.data?.html || ''), finalUrl: String(data.data?.finalUrl || url) };
}

const ANCHOR_RE = /<a\b[^>]*href\s*=\s*["']([^"'#\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const TAG_RE = /<[^>]+>/g;

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(TAG_RE, '')
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

/** 正文粗提取：去 script/style/标签 → 纯文本段落（readability-lite） */
export function extractMainText(html: string): string {
  const text = decodeEntities(
    stripTags(
      html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(br|\/p|\/div|\/h[1-6]|\/li)[^>]*>/gi, '\n')
    )
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

// ─── 站点导航/页脚清洗（站点无关：只认通用导航词与声明句式）────────────────

/** 分页标记：第(1/3)页 / 1/3页 / （2／5） */
const PAGINATION_RE = /^第?\s*[（(]?\s*\d{1,4}\s*[/／]\s*\d{1,4}\s*[)）]?\s*页?$/;

/** 纯网址行（站点水印常单独占一行） */
const URL_LINE_RE = /^(https?:\/\/\S+|www\.\S+|[a-z0-9-]+(\.[a-z0-9-]+){1,3}\/?)$/i;

/** 长分隔线（站点装饰用；要求 ≥8 个，避免误伤正文里的 * / —— 分场符） */
const RULE_LINE_RE = /^[-=_~*#—－·※]{8,}$/;

/**
 * 页脚/声明类整句。只在**短行**上判（见 `isSiteChromeLine`），且**只用几乎不可能
 * 出现在正文里的措辞**——早先版本收录了「扫码/公众号/手机版/域名/手机阅读」这类词，
 * 会让现代都市题材的正文句子（如「他扫码付了钱。」）被误删，已剔除。
 */
const SITE_SENTENCE_RE =
  /(本站|本网站|网站地图|内容(均)?(来自|收集于|整理于)互联网|如有侵权|尽快删除|请(及时)?(告知|联系我们)|免费阅读|无弹窗|无广告|最快更新|最新章节|txt下载|书友群|读者群|求月票|求推荐票|投推荐票|请记住.{0,8}(网址|域名)|访问.{0,10}(网址|域名|本站)|本章未完|点击下一页|翻页继续)/i;

/** 短行里出现完整网址：正文极少带域名，这是很强的站点水印信号 */
const INLINE_URL_RE = /(https?:\/\/|www\.)\S{3,}/i;

/** 站点名整行（「九库小说网」这类）：短行 + 明确的站点后缀，且不含句读 */
const SITE_NAME_LINE_RE =
  /^[\u4e00-\u9fa5A-Za-z0-9]{2,12}(小说网|小说网|文学网|中文网|阅读网|读书网|书城|书屋|书院|书吧)$/;

/** 站点导航/分类/阅读器控件词汇：用于识别「首页玄幻武侠都市历史网游科幻言情其他排行完本」这类**没有分隔符**的导航条 */
const NAV_VOCAB = [
  '首页', '玄幻', '武侠', '都市', '历史', '网游', '科幻', '言情', '其他', '排行', '完本', '分类',
  '书架', '阅读', '搜索', '投票', '推荐', '下载', '手机版', '目录', '章节', '全文', '免费',
  '登录', '注册', '顶部', '底部', '上一章', '下一章',
];

/** 句子句读：命中即认为这行是正文（导航条与控件行不会带句读） */
const SENTENCE_PUNCT_RE = /[。！？；：，、"""'']/;

/** 章节导航词：整行只由这些词组成才算导航行（单出现「目录」二字不会误伤正文句子） */
const NAV_TOKEN_RE =
  /^(上一章|下一章|上章|下章|上一页|下一页|上一节|下一节|上一篇|下一篇|返回目录|回目录|章节目录|本书目录|目录|存书签|加入书签|收藏本书|收藏|推荐本书|投推荐票|打赏|举报|关闭|顶部|返回顶部|首页|书页|阅读|继续阅读|立即阅读|下载|全文阅读|手机阅读|电脑阅读|搜索|字体|换手|关灯|开灯|护眼|换肤|书架|top)$/i;

/**
 * 导航行分隔符：空格/全角空格、竖线、间隔号、各类逗号分号斜杠、括号书名号引号、破折号。
 * **`-` 必须写在字符类末尾**：写成 `—-－` 会被当成 Unicode 范围 U+2014–U+FF0D，
 * 把整个汉字区都算作分隔符 → 导航词被拆成空 token 而整行漏判。
 */
const NAV_SPLIT_RE = /[\s\u3000|｜·・,，、;；/／+＋*＊【】[\]()（）<>《》「」『』"'—－-]+/;

/**
 * 一行是不是站点导航/页脚（宁漏不误：整行皆导航词，或短声明句）。
 * `pageTitle` 是页面 `<title>`：正文页首行常是它（形如「书名_书名_第N节：xxx_某小说网」），
 * 那不是正文，留着会被当成章节标题、也污染拆解输入。
 */
export function isSiteChromeLine(raw: string, pageTitle?: string): boolean {
  const line = (raw || '').trim();
  if (!line) return false;
  if (PAGINATION_RE.test(line) || URL_LINE_RE.test(line) || RULE_LINE_RE.test(line)) return true;
  if (pageTitle && pageTitle.length >= 8 && line.includes(pageTitle)) return true;
  if (line.length <= 80 && (SITE_SENTENCE_RE.test(line) || INLINE_URL_RE.test(line))) return true;
  if (line.length <= 20 && SITE_NAME_LINE_RE.test(line)) return true;
  // 没有分隔符的导航条（「首页玄幻武侠都市历史网游科幻言情其他排行完本」）：
  // 分词拆不开，只能数命中了几个导航/分类词——命中 ≥3 且整行无句读才算
  if (line.length <= 40 && !SENTENCE_PUNCT_RE.test(line)) {
    if (NAV_VOCAB.filter((w) => line.includes(w)).length >= 3) return true;
  }
  // 先把分页标记「第(1/3)页」「1/3」整体抠掉再分词：分隔符类里含括号与斜杠，
  // 不先抠掉的话它会被拆成「第 / 1/3 / 页」三段，整行就判不出来了
  const rest = line.replace(/第?\s*[（(]?\s*\d{1,4}\s*[/／]\s*\d{1,4}\s*[)）]?\s*页?/g, ' ');
  const tokens = rest.split(NAV_SPLIT_RE).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => NAV_TOKEN_RE.test(t));
}

/**
 * 清掉抓取/导入正文里的站点导航与页脚：
 * 「第(1/3)页 上一章 目录 存书签 下一章」「本站所有收录的内容均来自互联网…」
 * 「网站地图」这类。它们会被当成章节标题/正文喂给拆解模型，也留在模板书里。
 *
 * **行级判断**（不做事内替换），所以含「目录」「上一章」的正常句子不会被吃掉。
 */
export function stripSiteChrome(
  text: string,
  opts: { pageTitle?: string } = {}
): { text: string; removedLines: number } {
  const lines = (text || '').split('\n');
  const kept = lines.filter((l) => !isSiteChromeLine(l, opts.pageTitle));
  return {
    text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    removedLines: lines.length - kept.length,
  };
}

// ─── 章节内分页（长章被站点拆成 X.html / X_2.html / X_3.html）──────────────

/** 正文里的「第(1/3)页」页内分页标记（括号可省） */
const PAGE_MARK_RE = /第\s*[（(]?\s*(\d{1,3})\s*[/／]\s*(\d{1,3})\s*[)）]?\s*页/;

/** 「本章未完，请点击下一页继续阅读」这类**说明本页不是全章**的提示 */
const INCOMPLETE_HINT_RE = /(本章未完|本章未结束|点击下一页|翻页继续|下一页继续阅读|未完待续请|请翻页)/;

export interface ChapterPaginationInfo {
  /** 页面自报的「第 a/b 页」（无标记时 a=1,b=1） */
  page: number;
  total: number;
  /** 可补抓的后续页地址（推导失败时为空） */
  urls: string[];
  /** 页面里有「本章未完/点击下一页」提示（说明这页不含全章正文） */
  incompleteHint: boolean;
}

/**
 * 从页面锚点里认出「本章的其它页」：同目录 + 文件名是 `<当前基名>[_-]N`。
 * 这是**没有「第(a/b)页」标记**时的第二信号（例如第 2 页只挂在「下一页」链接上）。
 * 只认同基名——章节 id 相邻的「下一章」（1089357.html）不会被误当成同章页。
 */
function siblingPageUrls(html: string, pageUrl: string): string[] {
  let cur: URL;
  try {
    cur = new URL(pageUrl);
  } catch {
    return [];
  }
  const slash = cur.pathname.lastIndexOf('/');
  const dir = cur.pathname.slice(0, slash + 1);
  const base = cur.pathname.slice(slash + 1).replace(/\.[a-z]+$/i, '');
  const baseCore = base.replace(/[_-]\d{1,3}$/, '');
  if (!baseCore) return [];
  const found = new Map<number, string>();
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const href = m[1];
    if (/^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (abs.pathname.slice(0, abs.pathname.lastIndexOf('/') + 1) !== dir) continue;
    const name = abs.pathname.slice(abs.pathname.lastIndexOf('/') + 1);
    const nm = name.match(/^(.+?)[_-](\d{1,3})\.(html?|xhtml)$/i);
    if (!nm || nm[1] !== baseCore) continue;
    const n = Number(nm[2]);
    if (n >= 2 && !found.has(n)) found.set(n, abs.toString());
  }
  return [...found.keys()].sort((a, b) => a - b).map((n) => found.get(n)!);
}

/**
 * 章节内分页体检：页数标记 + 可补抓的后续页 + 「本章未完」提示。
 *
 * 为什么必须做：不少站点把长章拆成 `X.html`、`X_2.html`、`X_3.html`，
 * 只抓第一页会**静默丢掉后 2/3 的正文**——句子看着完整，极难察觉。
 * 站点无关且**宁缺不猜**：只有确证有分页（标记 b>1 或锚点里存在同章其它页）才给地址。
 */
export function analyzeChapterPagination(
  html: string,
  pageUrl: string,
  maxPages = 20
): ChapterPaginationInfo {
  const text = stripTags(html);
  const incompleteHint = INCOMPLETE_HINT_RE.test(text);
  const m = text.match(PAGE_MARK_RE);
  const total = m ? Number(m[2]) : 1;
  const page = m ? Number(m[1]) : 1;

  let urls: string[] = [];
  const marked = Number.isFinite(total) && total > 1 && total <= maxPages;
  if (marked) {
    // 主信号：按「名字_N」模板构造 2..b（页码模板是站点最常见的约定）
    let u: URL | null = null;
    try {
      u = new URL(pageUrl);
    } catch {
      u = null;
    }
    if (u) {
      const slash = u.pathname.lastIndexOf('/');
      const dir = u.pathname.slice(0, slash + 1);
      const fileName = u.pathname.slice(slash + 1);
      const pm = fileName.match(/^(.*?)(?:_(\d+))?(\.[a-z]+)$/i);
      if (pm) {
        const [, base, , ext] = pm;
        const self = u.toString();
        for (let n = 2; n <= total; n += 1) {
          const cand = new URL(u.toString());
          cand.pathname = `${dir}${base}_${n}${ext}`;
          cand.search = '';
          const url = cand.toString();
          if (url !== self) urls.push(url);
        }
      }
    }
  }
  // 补充信号：页面锚点里的同章其它页（含未标页数、或模板不匹配的情况）
  for (const u of siblingPageUrls(html, pageUrl)) {
    if (!urls.includes(u) && u !== pageUrl) urls.push(u);
  }
  urls = urls.filter((u) => u !== pageUrl).slice(0, maxPages);

  return { page, total: marked ? total : 1, urls, incompleteHint };
}

/**
 * 从「第(a/b)页」标记与当前 URL 推导**本章后续页**的候选地址。
 * 薄封装：多数调用方只关心地址列表。
 * 含未标页数时从锚点认出的同章其它页（sibling 信号）——不能只取 total>1 时的构造结果，
 * 否则「只有下一页链接、没有页数标记」的站点会被静默丢掉后续页。
 */
export function deriveChapterPageUrls(html: string, pageUrl: string, maxPages = 20): string[] {
  return analyzeChapterPagination(html, pageUrl, maxPages).urls;
}

// ─── 目录页分页（大书目录被拆成 index_1..index_N）────────────────────────

/** 「数字页」形态：index_2.html / page/2 / list_3 / 2.html（页号最多 3 位） */
const PAGE_NUM_HREF_RE = /^(?:index[_-]?|page[_-]?|list[_-]?|catalog[_-]?)?(\d{1,3})(?:\.html?|\/)?$/i;

/** 翻页符/页号锚文本（与 href 形态一起构成双信号，避免把章节链接当页） */
const PAGE_TEXT_RE = /^(\d{1,3}|[»›>≫≫]+|下一页|下页|末页|尾页|最后一页)$/;

/** 按模板自动补齐目录页的上限（防止某站点给出离谱页数时疯狂请求） */
const MAX_GENERATED_TOC_PAGES = 200;

export interface TocPagination {
  /** 除当前页之外的其余目录页（按页号升序） */
  pageUrls: string[];
  /** 识别到的最大页号；没识别出分页时为 null */
  totalPages: number | null;
  /** 当前 URL 自身是第几页 */
  currentPage: number;
}

/**
 * 从目录页 HTML 里找出「其余目录页」的链接。
 *
 * 为什么需要：大书目录常被拆成 `index_1.html … index_24.html`，而页面上的章节列表
 * 只有当前页那几十章（还可能夹一个置顶的「最新章节」块）——只抓第一页会**少掉大半本书**，
 * 且那几十条最新章会混进正文顺序里。
 *
 * 站点无关：只认「与当前 URL 同目录 + 纯数字页号」，并要求**页号锚文本或 page 前缀**这一
 * 第二信号，否则 1091755.html 这样的章节 id 会被误当成页码。
 */
export function extractTocPageUrls(html: string, pageUrl: string): TocPagination {
  const base = new URL(pageUrl);
  const dir = base.pathname.replace(/[^/]*$/, '');
  const baseName = base.pathname.slice(dir.length);
  const baseMatch = baseName.match(PAGE_NUM_HREF_RE);
  const currentPage = baseMatch ? Number(baseMatch[1]) : 1;

  const found = new Map<number, string>();
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const href = m[1];
    if (/^(javascript:|mailto:|tel:)/i.test(href)) continue;
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    // ?page=N 形态：同路径 + page 查询参数
    if (abs.pathname === base.pathname) {
      const qp = abs.searchParams.get('page');
      if (qp && /^\d{1,3}$/.test(qp) && !found.has(Number(qp))) {
        found.set(Number(qp), abs.toString());
      }
      continue;
    }
    if (abs.pathname.replace(/[^/]*$/, '') !== dir) continue;
    const tail = abs.pathname.slice(dir.length);
    const pm = tail.match(PAGE_NUM_HREF_RE);
    if (!pm) continue;
    const text = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
    const hasPrefix = /^(index[_-]?|page[_-]?|list[_-]?|catalog[_-]?)/i.test(tail);
    // 双信号：href 自带 page 前缀，或锚文本就是页号/翻页符
    if (!hasPrefix && !PAGE_TEXT_RE.test(text)) continue;
    const num = Number(pm[1]);
    if (num >= 1 && !found.has(num)) found.set(num, abs.toString());
  }

  const nums = [...found.keys()].sort((a, b) => a - b);
  const totalPages = nums.length ? Math.max(...nums) : null;

  // 分页控件常只列「1 2 3 > »」（前几页 + 末页），中间页不会出现在 HTML 里。
  // 用已认出的页地址当模板补齐 1..totalPages，否则「共 24 页」却只抓 3 页，照样缺章。
  if (totalPages && totalPages > 1 && totalPages <= MAX_GENERATED_TOC_PAGES) {
    const sample = found.get(nums.find((n) => n > 1) ?? 1);
    if (sample) {
      const sampleUrl = new URL(sample);
      const slash = sampleUrl.pathname.lastIndexOf('/');
      const dir = sampleUrl.pathname.slice(0, slash + 1);
      const pm = sampleUrl.pathname.slice(slash + 1).match(/^(.*?)(\d{1,3})(\.[a-z]+)?$/i);
      const usesQueryPage = sampleUrl.searchParams.has('page');
      if (pm || usesQueryPage) {
        for (let n = 1; n <= totalPages; n += 1) {
          if (found.has(n)) continue;
          const u = new URL(sample);
          if (usesQueryPage) {
            u.searchParams.set('page', String(n));
          } else if (pm) {
            u.pathname = `${dir}${pm[1]}${n}${pm[3] ?? ''}`;
            u.search = '';
          }
          found.set(n, u.toString());
        }
      }
    }
  }

  const finalNums = [...found.keys()].sort((a, b) => a - b);
  return {
    pageUrls: finalNums.filter((n) => n !== currentPage).map((n) => found.get(n)!),
    totalPages: finalNums.length ? Math.max(...finalNums) : null,
    currentPage,
  };
}

// ─── 题目顺序（倒序目录页会让「第一章」变成最新章节）──────────────────────

/** 题名里的章号：第12章 / 第 十二 章 / 第012回 / Chapter 3；解析不出返回 null */
export function chapterNumberFromTitle(title: string): number | null {
  const t = (title || '').trim();
  const cn = t.match(/第\s*([0-9零一二三四五六七八九十百千万两]+)\s*[章节回折话集]/);
  if (cn) {
    const n = parseCnNumber(cn[1]);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const en = t.match(/chapter\s+(\d{1,5})/i);
  return en ? Number(en[1]) : null;
}

export interface TitleOrderResult<T> {
  items: T[];
  /** 是否真的重排过（只在能**确证**顺序不对时才动手） */
  reordered: boolean;
  /** 重排方式：sort=按章号排序；reverse=整体反转（章号有重复时用，保序） */
  mode: 'sort' | 'reverse' | null;
  /** 重排后最早一项的章号（题名解析不出来则为 null） */
  firstNumber: number | null;
  total: number;
  /** 题名里能解析出章号的条数 */
  numberedCount: number;
  /** 章号有重复（常见于「分卷各自从第 1 章编号」）——此时不做全排序，避免打乱卷序 */
  hasDuplicateNumbers: boolean;
}

/**
 * 按题名章号把「目录/切章结果」排成阅读顺序。
 *
 * 为什么需要：不少站点目录页是**倒序**（最新章节排在最前），而模板书是按数组顺序
 * 编号（第 1..N 章）——照文档顺序抓，结果就是「第一章 = 最新章节」。
 *
 * 只改**顺序**、不改章号：全应用依赖「章号连续」的假设。两种手法：
 *  - 章号**唯一**且不是升序 → 直接按章号排序（乱序也能修好）；
 *  - 章号**有重复**但整体**非递增**（如 `第12章(下)/(上)` 这种同章分页）→ **整体反转**：
 *    反转能保持同章内的相对顺序（上/下不会被对调），而排序会把它们搅混。
 * 其余情况（分卷各自从第 1 章编号后被打乱等）一律**原样返回**。
 */
export function sortByTitleChapterNumber<T extends { title: string }>(
  items: T[]
): TitleOrderResult<T> {
  const numbers = items.map((it) => chapterNumberFromTitle(it.title));
  const numbered = numbers.filter((n): n is number => n !== null);
  const base = {
    items,
    reordered: false,
    mode: null,
    firstNumber: numbered.length ? numbered[0] : null,
    total: items.length,
    numberedCount: numbered.length,
    hasDuplicateNumbers: new Set(numbered).size !== numbered.length,
  };
  if (items.length < 2 || numbered.length !== items.length) return base;

  const ascending = numbered.every((n, i) => i === 0 || n > numbered[i - 1]);
  if (ascending) return base; // 已经是阅读顺序
  const unique = new Set(numbered).size === numbered.length;

  if (unique) {
    const sorted = items
      .map((it, i) => ({ it, n: numbered[i] }))
      .sort((a, b) => a.n - b.n)
      .map((x) => x.it);
    return {
      ...base,
      items: sorted,
      reordered: true,
      mode: 'sort',
      firstNumber: chapterNumberFromTitle(sorted[0].title),
      hasDuplicateNumbers: false,
    };
  }

  // 章号有重复：只在「整体非递增且确有下降」时反转（否则可能是分卷，动了就毁卷序）
  const nonIncreasing = numbered.every((n, i) => i === 0 || n <= numbered[i - 1]);
  const hasDecrease = numbered.some((n, i) => i > 0 && n < numbered[i - 1]);
  if (nonIncreasing && hasDecrease) {
    const reversed = [...items].reverse();
    return {
      ...base,
      items: reversed,
      reordered: true,
      mode: 'reverse',
      firstNumber: chapterNumberFromTitle(reversed[0].title),
    };
  }
  return base;
}

/**
 * 合并多页目录的章节链接：按 URL 去重后按题名章号排成阅读顺序。
 *
 * 去重是必需的：分页目录的第 1 页常带一个置顶「最新章节」块，那些章在后面的目录页里
 * 还会再出现一次；重复项会让章号不再唯一，排序保护就会放弃排序（顺序又乱了）。
 */
export function mergeChapterLinks(
  pages: { url: string; title: string }[][]
): TitleOrderResult<{ url: string; title: string }> {
  const seen = new Set<string>();
  const merged: { url: string; title: string }[] = [];
  for (const list of pages) {
    for (const l of list) {
      if (seen.has(l.url)) continue;
      seen.add(l.url);
      merged.push(l);
    }
  }
  return sortByTitleChapterNumber(merged);
}

const LINK_TITLE_RE = /^(第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回折话集]|Chapter\s+\d{1,5})/i;

const PAGE_TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/** 从抓取的 HTML 里取 <title> 作为模板书的初始标题（综合完成后由模型推断的书名覆盖） */
export function extractPageTitle(html: string): string {
  const m = html.match(PAGE_TITLE_RE);
  if (!m) return '';
  const t = decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim();
  return t.slice(0, 60);
}

/** 从目录页 HTML 提取章节链接（站点无关：只认「第N章/Chapter N」形态的链接文本） */
export function extractChapterLinks(
  html: string,
  pageUrl: string
): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  const seen = new Set<string>();
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const href = m[1];
    const text = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
    if (!text || !LINK_TITLE_RE.test(text)) continue;
    if (/^(javascript:|mailto:|tel:)/i.test(href)) continue;
    try {
      const abs = new URL(href, pageUrl).toString();
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push({ url: abs, title: text });
    } catch {
      // 相对路径解析失败：跳过该链接
    }
  }
  return out;
}

/**
 * 兜底抽取目录链接：当页面的锚文本**不是**「第N章」形态时
 * （`1、开局`、`【序】`、只有标题没有章号、章节标题在别处而链接只是个序号……），
 * 改用「同一目录下、文件名是纯数字 id」的**最大同构链接块**当目录。
 *
 * 站点无关：只看链接结构（同目录 + 数字文件名 + 成组出现），不认任何站点。
 * 宁少不滥：同组至少 5 条、URL 唯一、标题非空才采用。调用方（预览页）会让用户核对前几条。
 */
export function extractChapterLinksLoose(
  html: string,
  pageUrl: string
): { url: string; title: string }[] {
  const groups = new Map<string, { url: string; title: string }[]>();
  const seen = new Set<string>();
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const href = m[1];
    if (/^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
    const text = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let abs: URL;
    try {
      abs = new URL(href, pageUrl);
    } catch {
      continue;
    }
    const slash = abs.pathname.lastIndexOf('/');
    const dir = abs.pathname.slice(0, slash + 1);
    const base = abs.pathname.slice(slash + 1);
    // 纯数字 id 且 ≥3 位：3 位以上才是内容 id，2 位以下多半是分页
    if (!/^\d{3,}\.(html?|xhtml)$/i.test(base)) continue;
    const url = abs.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const list = groups.get(dir) ?? [];
    list.push({ url, title: text });
    groups.set(dir, list);
  }
  let best: { url: string; title: string }[] = [];
  for (const list of groups.values()) {
    if (list.length > best.length) best = list;
  }
  return best.length >= 5 ? best : [];
}

// ─── 节奏统计与报告（纯本地，零 LLM）────────────────────────────────────

export interface RhythmPoint {
  chapterNumber: number;
  words: number;
  hookStrength?: number;
  hookType?: string;
  payoffType?: string;
  emotion?: number;
}

export interface RhythmStats {
  points: RhythmPoint[];
  deconstructedCount: number;
  totalCount: number;
  avgWords: number;
  maxWords: number;
  minWords: number;
  avgHook: number;
  /** 相邻两个爽点章之间的章数间隔 */
  payoffGaps: number[];
  /**
   * 按章序的逐章情绪；无情绪值的章记 null（**不删**）。
   * 删掉会让曲线中间有洞却看着连续，也会让「≤N 章才画」的门槛拿有值章数比总章数。
   */
  emotionSeries: { chapterNumber: number; emotion: number | null }[];
  /** 有情绪值的章数（emotionSeries 中非 null 的个数） */
  emotionCoveredCount: number;
  avgEmotion?: number;
  emotionPeak?: { chapterNumber: number; emotion: number };
  emotionTrough?: { chapterNumber: number; emotion: number };
}

const isPayoff = (t?: string) => !!t && t !== '无';

export function buildRhythmStats(chapters: Chapter[]): RhythmStats {
  const points: RhythmPoint[] = chapters.map((c) => ({
    chapterNumber: c.number,
    words: c.wordCount || proseWords(c.content),
    hookStrength: c.deconstruct?.hookStrength,
    hookType: c.deconstruct?.hookType,
    payoffType: c.deconstruct?.payoffType,
    emotion: c.deconstruct?.emotion,
  }));
  const deconstructed = chapters.filter((c) => c.deconstruct);
  const words = points.map((p) => p.words).filter((n) => n > 0);
  const hooks = deconstructed
    .map((c) => c.deconstruct?.hookStrength)
    .filter((n): n is number => typeof n === 'number');
  const payoffChapters = chapters
    .filter((c) => isPayoff(c.deconstruct?.payoffType))
    .map((c) => c.number);
  const payoffGaps: number[] = [];
  for (let i = 1; i < payoffChapters.length; i += 1) {
    payoffGaps.push(payoffChapters[i] - payoffChapters[i - 1]);
  }
  // 序列必须覆盖**全部章**（含未拆解章，记 null）：此前从「已有 deconstruct 的章」构建，
  // 断点续跑/失败留下的缺口会被静默抹掉——曲线看着连续，`emotionSeries.length` 也退化成
  // 「已拆章数」，于是 `partial` 判据失真：上面报告里 100/500 章的书会被当成整本结论。
  const emotionSeries = chapters.map((c) => ({
    chapterNumber: c.number,
    emotion: typeof c.deconstruct?.emotion === 'number' ? c.deconstruct.emotion : null,
  }));
  // 均值/峰谷只在**有值**的章上算（null 是「没有数据」，不是「0」）
  const withEmotion = emotionSeries.filter(
    (e): e is { chapterNumber: number; emotion: number } => e.emotion !== null
  );
  const emotionCoveredCount = withEmotion.length;
  const avgEmotion = withEmotion.length
    ? Math.round(
        (withEmotion.reduce((a, b) => a + b.emotion, 0) / withEmotion.length) * 10
      ) / 10
    : undefined;
  const emotionPeak = withEmotion.length
    ? withEmotion.reduce((a, b) => (b.emotion > a.emotion ? b : a))
    : undefined;
  const emotionTrough = withEmotion.length
    ? withEmotion.reduce((a, b) => (b.emotion < a.emotion ? b : a))
    : undefined;
  return {
    points,
    deconstructedCount: deconstructed.length,
    totalCount: chapters.length,
    avgWords: words.length ? Math.round(words.reduce((a, b) => a + b, 0) / words.length) : 0,
    maxWords: words.length ? Math.max(...words) : 0,
    minWords: words.length ? Math.min(...words) : 0,
    avgHook: hooks.length
      ? Math.round((hooks.reduce((a, b) => a + b, 0) / hooks.length) * 10) / 10
      : 0,
    payoffGaps,
    emotionSeries,
    emotionCoveredCount,
    avgEmotion,
    emotionPeak,
    emotionTrough,
  };
}

/** Markdown 表格单元格转义：换行折成空格、竖线转义，避免梗概把表格撑破 */
const cell = (s: string, max: number): string =>
  (s || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
    .slice(0, max);

/** 非表格行里的单行字段：模型偶尔把换行塞进书名/性格，会破掉「一行一条」的版面 */
const oneLine = (s: string | undefined): string => (s || '').replace(/\r?\n/g, ' ').trim();

const fmtSigned = (n: number): string => (n > 0 ? `+${n}` : String(n));

/**
 * 情绪曲线的 8 级字符。用纯 ASCII 而不是方块字符 ▁▂▃▄▅▆▇█：
 * 报告在等宽字体里渲染，方块字符常缺字形 → 反而显示成一排豆腐块。
 */
const EMOTION_LEVELS = ['.', '-', '=', '+', '*', '#', '%', '@'];

/** 无情绪数据的章在曲线里的占位符（不是 ▄/0，避免把「不知道」画成「平稳」） */
export const EMOTION_GAP_CHAR = '·';

/** 曲线单行可容纳的最大字符数，超过则按段取均值降采样 */
export const EMOTION_CURVE_MAX_CHARS = 120;

/** 情绪伪曲线：-9~+9 → 8 级字符，每章一个字符；无数据章画占位符以保持章序对齐 */
export function emotionSparkline(series: { emotion: number | null }[]): string {
  return series
    .map((p) => {
      if (typeof p.emotion !== 'number') return EMOTION_GAP_CHAR;
      const level = Math.round(((p.emotion + 9) / 18) * (EMOTION_LEVELS.length - 1));
      return EMOTION_LEVELS[level] ?? EMOTION_LEVELS[3];
    })
    .join('');
}

/**
 * 情绪曲线（可降采样）：章数超过 maxChars 时按 `ceil(n / maxChars)` 段取「段内有值章的均值」，
 * 保证曲线长度 ≤ maxChars、章序仍被覆盖（此前超 60 章直接不画曲线 → 数百章的网文等于没这功能）。
 */
export function emotionCurve(
  series: { emotion: number | null }[],
  maxChars = EMOTION_CURVE_MAX_CHARS
): { text: string; bucketSize: number } {
  if (series.length <= maxChars) return { text: emotionSparkline(series), bucketSize: 1 };
  const size = Math.ceil(series.length / maxChars);
  const buckets: { emotion: number | null }[] = [];
  for (let i = 0; i < series.length; i += size) {
    const vals = series
      .slice(i, i + size)
      .map((s) => s.emotion)
      .filter((n): n is number => n !== null);
    buckets.push({
      emotion: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null,
    });
  }
  return { text: emotionSparkline(buckets), bucketSize: size };
}

/** 拆解报告（Markdown）：可直接复制保存，或粘进作者笔记 */
export function formatDeconstructReport(project: BookProject): string {
  const stats = buildRhythmStats(project.chapters);
  const meta = project.deconstructMeta;
  // 预先建索引：此前在遍历里对每章做 chapters.find → O(n²)（2000 章约 400 万次比较）
  const summaryByNumber = new Map(project.chapters.map((c) => [c.number, c.summary || '']));
  const lines: string[] = [];
  lines.push(`# 拆书报告：${oneLine(project.title)}`);
  lines.push('');
  lines.push(
    `- 来源：${meta?.source === 'url' ? 'URL' : '本地文件'} · ${oneLine(meta?.sourceName) || '—'}` +
      `（导入于 ${meta?.importedAt?.slice(0, 10) || '—'}）`
  );
  lines.push(`- 题材判断：${oneLine(project.genre) || '—'}`);
  lines.push(
    `- 章节数：${stats.totalCount}（已拆解 ${stats.deconstructedCount}）· ` +
      `平均 ${stats.avgWords} 字/章（${stats.minWords}~${stats.maxWords}）`
  );
  if (stats.avgHook > 0) lines.push(`- 平均章末钩子强度：${stats.avgHook}/10`);
  // 没拆成功的章必须在报告里点名并**分开归因**：否则那些行「梗概为空 + 全是 —」看着像内容丢了，
  // 用户无从判断是网站页没抓到正文，还是我们这边拆解失败。
  const missing = project.chapters.filter((c) => !c.deconstruct);
  if (missing.length) {
    const shown = missing.slice(0, 20).map((c) => c.number).join('、');
    lines.push(
      `- ⚠️ 未拆解章节：第 ${shown} 章${missing.length > 20 ? ' …' : ''}` +
        `（共 ${missing.length} 章，不计入上面的统计）`
    );
    const placeholder = missing.filter((c) =>
      /^【抓取失败[:：]/.test((c.content || '').trim())
    );
    const emptyBody = missing.filter(
      (c) => !placeholder.includes(c) && !hasUsableChapterBody(c.content)
    );
    const brokenLlm = missing.length - placeholder.length - emptyBody.length;
    if (placeholder.length) {
      lines.push(
        `  - ${placeholder.length} 章正文是「抓取失败」占位（旧版导入残留）→ 重新抓取或删掉这些章`
      );
    }
    if (emptyBody.length) {
      lines.push(
        `  - ${emptyBody.length} 章正文为空/过短 → **抓取侧**没拿到正文（该页可能是 JS 渲染或反爬拦截页）`
      );
    }
    if (brokenLlm) {
      lines.push(`  - ${brokenLlm} 章正文正常但拆解失败 → 模型返回不完整，点「继续」可重试`);
    }
  }
  if (stats.payoffGaps.length) {
    const avgGap = Math.round(
      stats.payoffGaps.reduce((a, b) => a + b, 0) / stats.payoffGaps.length
    );
    lines.push(`- 爽点节奏：平均每 ${avgGap} 章一个爽点（共 ${stats.payoffGaps.length + 1} 个）`);
  }
  if (stats.emotionCoveredCount) {
    const partial = stats.emotionCoveredCount < stats.emotionSeries.length;
    lines.push(
      `- 情绪走向：均值 ${fmtSigned(stats.avgEmotion ?? 0)} · ` +
        `峰值 第${stats.emotionPeak!.chapterNumber}章（${fmtSigned(stats.emotionPeak!.emotion)}） · ` +
        `低谷 第${stats.emotionTrough!.chapterNumber}章（${fmtSigned(stats.emotionTrough!.emotion)}）` +
        // 只对部分章有数据时必须标注样本量，否则均值/峰谷会被误读为整本书的结论
        (partial ? `（${stats.emotionCoveredCount}/${stats.emotionSeries.length} 章有情绪值）` : '')
    );
    // 逐章一个字符；章数太多时按段取均值降采样，而不是干脆不画
    const curve = emotionCurve(stats.emotionSeries);
    lines.push(
      `- 情绪曲线（左→右为章序，${EMOTION_LEVELS[0]}=-9 ${EMOTION_LEVELS[EMOTION_LEVELS.length - 1]}=+9` +
        (curve.bucketSize > 1 ? `，每 ${curve.bucketSize} 章取均值` : '') +
        (partial ? `，${EMOTION_GAP_CHAR}=无情绪数据` : '') +
        `）：${curve.text}`
    );
  }
  lines.push('');
  lines.push('## 逐章拆解');
  lines.push('');
  lines.push('| 章 | 字数 | 钩子 | 爽点 | 情绪 | 梗概 |');
  lines.push('|---|---|---|---|---|---|');
  for (const p of stats.points) {
    const hook =
      p.hookStrength != null ? `${p.hookType || '钩子'}·${p.hookStrength}` : '—';
    lines.push(
      `| ${p.chapterNumber} | ${p.words} | ${cell(hook, 20)} | ${cell(p.payoffType || '—', 20)} | ` +
        `${p.emotion != null ? fmtSigned(p.emotion) : '—'} | ` +
        `${cell(summaryByNumber.get(p.chapterNumber) || '', 50)} |`
    );
  }
  if (project.characters.length) {
    lines.push('');
    lines.push('## 主要人物');
    lines.push('');
    const nameById = new Map(project.characters.map((c) => [c.id, c.name]));
    for (const c of project.characters) {
      const rel = (c.relations || [])
        .map((r) => {
          const target = nameById.get(r.targetId);
          return target ? `${target}（${r.relation}）` : null;
        })
        .filter(Boolean)
        .slice(0, 4)
        .join('、');
      lines.push(
        `- **${oneLine(c.name)}**（${oneLine(c.role)}）${c.realmOrTitle ? `· ${oneLine(c.realmOrTitle)}` : ''}：${oneLine(c.personality)}` +
          (rel ? `；关系：${rel}` : '')
      );
    }
  }
  if (project.settings.length) {
    lines.push('');
    lines.push('## 核心设定');
    lines.push('');
    for (const s of project.settings) {
      lines.push(`- **${oneLine(s.name)}**（${oneLine(s.category)}）：${oneLine(s.description)}`);
    }
  }
  lines.push('');
  lines.push('> 仅限个人学习分析使用；拆解结果请勿分发。');
  return lines.join('\n');
}

// ─── 断点续跑任务索引（meta store；逐章结果本体在模板书章节里）──────────

export interface DeconstructJob {
  projectId: string;
  title: string;
  /** 已拆解章数（含失败的跳过数不计） */
  done: number;
  total: number;
  /** 综合阶段是否完成 */
  synthesisDone: boolean;
  updatedAt: string;
}

async function putMetaValue(key: string, value: unknown): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('meta 写入失败'));
    tx.onabort = () => reject(tx.error || new Error('meta 写入事务中止'));
  });
}

export async function saveDeconstructJob(job: DeconstructJob): Promise<void> {
  await putMetaValue(`${DECONSTRUCT_JOB_PREFIX}${job.projectId}`, job);
}

export async function deleteDeconstructJob(projectId: string): Promise<void> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).delete(`${DECONSTRUCT_JOB_PREFIX}${projectId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('meta 删除失败'));
    tx.onabort = () => reject(tx.error || new Error('meta 删除事务中止'));
  });
}

/** 未完成的拆书任务（供拆书工作台「继续拆解」列表） */
export async function listDeconstructJobs(): Promise<DeconstructJob[]> {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const out: DeconstructJob[] = [];
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      const key = String(cursor.key || '');
      if (key.startsWith(DECONSTRUCT_JOB_PREFIX)) {
        const v = cursor.value as DeconstructJob | undefined;
        if (v && v.projectId && typeof v.total === 'number') {
          out.push(v);
        }
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error || new Error('meta 读取失败'));
  });
}
