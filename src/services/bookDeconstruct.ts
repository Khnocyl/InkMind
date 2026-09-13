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
   * 抓取失败的占位章（URL 目录页批量抓取时单章失败）。
   * 仅供预览列表展示失败原因，**不得进入模板书、不得送 LLM 拆解**。
   */
  failed?: boolean;
}

const CHAPTER_HEADING_RE =
  /^(第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章节回折话集]|Chapter\s+\d{1,5})[\s:：·\-._]*(.*)$/i;
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
    // 「123、标题」形态：仅短行且已出现过正式章标题时才认（防正文列表误伤）
    const numberedMatch = line.match(NUMBERED_HEADING_RE);
    if (numberedMatch && sawHeading && line.length <= 30) {
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
  };
}

/** 情绪张力收敛到 -9~+9；非法值返回 undefined（不虚构中性值） */
export function clampEmotion(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(9, Math.max(-9, Math.round(n)));
}

/** 逐章拆解：LLM 反推一章的结构数据（generateJSON + validate 闸门） */
export async function deconstructChapterLLM(options: {
  chapterNumber: number;
  chapterTitle: string;
  content: string;
  knownCharacters?: string[];
  signal?: AbortSignal;
}): Promise<ChapterDeconstruct & { summary: string; beats: PlotBeat[] }> {
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
    throw new Error('拆解结果缺少有效 summary（模型返回不完整）');
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
      name: name.slice(0, 24),
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

/**
 * 把模型输出的角色关系按「对方角色名」解析为 targetId 并回填。
 * 未知名 / 自指 / 重复关系跳过；intimacy 收敛到 -100~100；每人最多 8 条。
 * （若模型用了列表外的名字，该条丢弃——宁缺毋滥，不虚构关系对象。）
 */
export function resolveCharacterRelations(
  characters: Character[],
  rawCharacters: unknown[]
): void {
  const byName = new Map(characters.map((c) => [c.name, c]));
  for (const rc of rawCharacters) {
    const selfName = String((rc as { name?: unknown })?.name || '').trim();
    const self = byName.get(selfName);
    if (!self) continue;
    const rawList = Array.isArray((rc as { relations?: unknown })?.relations)
      ? ((rc as { relations: unknown[] }).relations)
      : [];
    const relations: CharacterRelation[] = [];
    for (const r of rawList) {
      if (relations.length >= 8) break;
      const targetName = String((r as { name?: unknown })?.name || '').trim();
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
    byName.set(c.name, c.id);
  }
  for (const ch of project.chapters) {
    const names = ch.deconstruct?.characterNames || [];
    ch.involvedCharacterIds = names
      .map((n) => byName.get(n))
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
  /** 有情绪值的章节序列（按章号序），供情绪曲线 */
  emotionSeries: { chapterNumber: number; emotion: number }[];
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
  const emotionSeries = deconstructed
    .filter((c) => typeof c.deconstruct?.emotion === 'number')
    .map((c) => ({ chapterNumber: c.number, emotion: c.deconstruct!.emotion! }));
  const avgEmotion = emotionSeries.length
    ? Math.round(
        (emotionSeries.reduce((a, b) => a + b.emotion, 0) / emotionSeries.length) * 10
      ) / 10
    : undefined;
  const emotionPeak = emotionSeries.length
    ? emotionSeries.reduce((a, b) => (b.emotion > a.emotion ? b : a))
    : undefined;
  const emotionTrough = emotionSeries.length
    ? emotionSeries.reduce((a, b) => (b.emotion < a.emotion ? b : a))
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

const fmtSigned = (n: number): string => (n > 0 ? `+${n}` : String(n));

const EMOTION_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** 情绪伪曲线：-9~+9 → 8 级 Unicode 方块，每章一个字符 */
export function emotionSparkline(series: { emotion: number }[]): string {
  return series
    .map((p) => {
      const level = Math.round(((p.emotion + 9) / 18) * (EMOTION_BLOCKS.length - 1));
      return EMOTION_BLOCKS[level] ?? '▄';
    })
    .join('');
}

/** 拆解报告（Markdown）：可直接复制保存，或粘进作者笔记 */
export function formatDeconstructReport(project: BookProject): string {
  const stats = buildRhythmStats(project.chapters);
  const meta = project.deconstructMeta;
  // 预先建索引：此前在遍历里对每章做 chapters.find → O(n²)（2000 章约 400 万次比较）
  const summaryByNumber = new Map(project.chapters.map((c) => [c.number, c.summary || '']));
  const lines: string[] = [];
  lines.push(`# 拆书报告：${project.title}`);
  lines.push('');
  lines.push(
    `- 来源：${meta?.source === 'url' ? 'URL' : '本地文件'} · ${meta?.sourceName || '—'}` +
      `（导入于 ${meta?.importedAt?.slice(0, 10) || '—'}）`
  );
  lines.push(`- 题材判断：${project.genre || '—'}`);
  lines.push(
    `- 章节数：${stats.totalCount}（已拆解 ${stats.deconstructedCount}）· ` +
      `平均 ${stats.avgWords} 字/章（${stats.minWords}~${stats.maxWords}）`
  );
  if (stats.avgHook > 0) lines.push(`- 平均章末钩子强度：${stats.avgHook}/10`);
  if (stats.payoffGaps.length) {
    const avgGap = Math.round(
      stats.payoffGaps.reduce((a, b) => a + b, 0) / stats.payoffGaps.length
    );
    lines.push(`- 爽点节奏：平均每 ${avgGap} 章一个爽点（共 ${stats.payoffGaps.length + 1} 个）`);
  }
  if (stats.emotionSeries.length) {
    lines.push(
      `- 情绪走向：均值 ${fmtSigned(stats.avgEmotion ?? 0)} · ` +
        `峰值 第${stats.emotionPeak!.chapterNumber}章（${fmtSigned(stats.emotionPeak!.emotion)}） · ` +
        `低谷 第${stats.emotionTrough!.chapterNumber}章（${fmtSigned(stats.emotionTrough!.emotion)}）`
    );
    // 每章一个字符的伪曲线；章数太多时字符图失去可读性，只保留数值摘要
    if (stats.emotionSeries.length <= 60) {
      lines.push(`- 情绪曲线：${emotionSparkline(stats.emotionSeries)}`);
    }
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
        `- **${c.name}**（${c.role}）${c.realmOrTitle ? `· ${c.realmOrTitle}` : ''}：${c.personality}` +
          (rel ? ` ｜ 关系：${rel}` : '')
      );
    }
  }
  if (project.settings.length) {
    lines.push('');
    lines.push('## 核心设定');
    lines.push('');
    for (const s of project.settings) {
      lines.push(`- **${s.name}**（${s.category}）：${s.description}`);
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
