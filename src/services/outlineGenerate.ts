/**
 * 向导「分卷 + 拆章」多轮生成。
 * 单次 LLM 调用无法稳定吐出 100+ 章完整梗概，故：
 * 1) 先生成覆盖全书的分卷骨架
 * 2) 再按卷分批（默认每批 ≤20 章）逐章补全
 * 3) 仍缺章时用卷摘要做占位补齐，保证章数 = 目标
 */

import type { Chapter, Character, ProjectConfig, StyleConfig, Volume, WorldSetting } from '../types/novel';
import { generateJSON, isSchemaMismatchError } from './llmClient';
import { formatStyleStructureForPrompt, getActiveStyleProfile } from './styleImitate';
import {
  buildOutlineChaptersBatchPrompt,
  buildOutlineVolumesPrompt,
  resolveOutlineTotalChapters,
  suggestVolumeCount,
} from './prompts';

/** 每批最多拆多少章（过大易截断 JSON） */
export const OUTLINE_CHAPTER_BATCH_SIZE = 20;

export interface OutlineVolumeDraft {
  number: number;
  title: string;
  summary: string;
  startChapter: number;
  endChapter: number;
  majorBeats?: string[];
  chapters?: OutlineChapterDraft[];
}

export interface OutlineChapterDraft {
  number: number;
  title: string;
  summary: string;
  involvedCharacterNames?: string[];
  involvedSettingNames?: string[];
}

export interface GenerateFullOutlineOptions {
  config: ProjectConfig;
  title: string;
  synopsis: string;
  characters: Character[];
  settings: WorldSetting[];
  /** 进度文案 */
  onProgress?: (msg: string) => void;
  /** 文风档案（作家方法论结构层，可选） */
  styleConfig?: StyleConfig | null;
  /** 覆盖默认批大小 */
  batchSize?: number;
}

export interface GenerateFullOutlineResult {
  volumes: Volume[];
  chapters: Chapter[];
  totalTarget: number;
  /** 模型真实写出梗概的章数（非占位） */
  detailedCount: number;
  /** 占位补齐章数 */
  placeholderCount: number;
  batchesRun: number;
}

function clampInt(n: unknown, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.floor(v);
}

// ── 结构校验闸门：把「parse 成功但内容残缺」拦在下游之前，转成带反馈的重试 ──

/** 拆章批次最低可用覆盖率：低于该比例疑似重度截断，触发反馈重试 */
const CHAPTER_BATCH_MIN_COVER = 0.6;

type LooseRecord = Record<string, unknown>;

/** 分卷骨架形状校验：volumes 数组非空且元素为对象（区间错乱交给 normalizeVolumeRanges 修复） */
export function validateVolumesDraft(value: unknown): string | null {
  const volumes = (value as LooseRecord | null)?.volumes;
  if (!Array.isArray(volumes) || volumes.length === 0) {
    return '缺少 volumes 数组或为空';
  }
  return null;
}

/**
 * 拆章批次覆盖校验工厂：from..to 中至少 60% 章号有可用条目（标题/摘要任一非空）。
 * 重度截断/空批次判不合格 → 上层带反馈重试后仍失败则走原有占位补齐兜底。
 */
export function makeChapterBatchValidator(
  fromChapter: number,
  toChapter: number
): (value: unknown) => string | null {
  const expected = toChapter - fromChapter + 1;
  return (value: unknown): string | null => {
    const chapters = (value as LooseRecord | null)?.chapters;
    if (!Array.isArray(chapters) || chapters.length === 0) {
      return `chapters 缺失或为空（应输出第 ${fromChapter}-${toChapter} 章）`;
    }
    const usable = new Set<number>();
    for (const c of chapters) {
      if (!c || typeof c !== 'object') continue;
      const rec = c as LooseRecord;
      const num =
        typeof rec.number === 'number'
          ? Math.floor(rec.number)
          : Number(String(rec.number));
      if (!Number.isFinite(num) || num < fromChapter || num > toChapter) continue;
      const hasContent =
        (typeof rec.title === 'string' && rec.title.trim().length > 0) ||
        (typeof rec.summary === 'string' && rec.summary.trim().length > 0);
      if (hasContent) usable.add(num);
    }
    if (usable.size === 0) {
      return `chapters 均无有效内容（number 需落在 ${fromChapter}-${toChapter} 且含标题或摘要）`;
    }
    const minCover = Math.max(1, Math.ceil(expected * CHAPTER_BATCH_MIN_COVER));
    if (usable.size < minCover) {
      const missing: number[] = [];
      for (let n = fromChapter; n <= toChapter && missing.length <= 10; n++) {
        if (!usable.has(n)) missing.push(n);
      }
      return (
        `章节覆盖不足：仅 ${usable.size}/${expected} 章` +
        `（如缺第 ${missing.join('、')} 章${missing.length > 10 ? ' 等' : ''}），` +
        '疑似输出被截断，请完整输出区间内全部章号'
      );
    }
    return null;
  };
}

/** 把模型返回的卷区间规范为连续覆盖 1..totalCh */
export function normalizeVolumeRanges(
  raw: OutlineVolumeDraft[] | undefined | null,
  totalCh: number
): OutlineVolumeDraft[] {
  const volCountHint = suggestVolumeCount(totalCh);
  let list = (raw || [])
    .map((v, i) => ({
      number: clampInt(v.number, i + 1),
      title: (v.title || `第${i + 1}卷`).trim(),
      summary: (v.summary || '').trim(),
      startChapter: clampInt(v.startChapter, 0),
      endChapter: clampInt(v.endChapter, 0),
      majorBeats: Array.isArray(v.majorBeats) ? v.majorBeats.map(String) : [],
    }))
    .filter((v) => v.title);

  if (list.length === 0) {
    // 均匀切片
    const per = Math.ceil(totalCh / volCountHint);
    for (let i = 0; i < volCountHint; i++) {
      const start = i * per + 1;
      if (start > totalCh) break;
      const end = Math.min(totalCh, (i + 1) * per);
      list.push({
        number: i + 1,
        title: `第${i + 1}卷`,
        summary: `第 ${start}–${end} 章叙事弧`,
        startChapter: start,
        endChapter: end,
        majorBeats: [],
      });
    }
  }

  // 按 start 排序并重编号
  list.sort((a, b) => a.startChapter - b.startChapter || a.number - b.number);
  list = list.map((v, i) => ({ ...v, number: i + 1 }));

  // 若区间无效，按等分重写
  const invalid = list.some(
    (v) =>
      v.startChapter < 1 ||
      v.endChapter < v.startChapter ||
      v.endChapter > totalCh + 50
  );
  if (invalid || list[0].startChapter !== 1) {
    const n = list.length || volCountHint;
    const per = Math.ceil(totalCh / n);
    list = list.slice(0, n).map((v, i) => {
      const start = i * per + 1;
      const end = Math.min(totalCh, (i + 1) * per);
      return {
        ...v,
        number: i + 1,
        startChapter: start,
        endChapter: Math.max(start, end),
      };
    });
  }

  // 强制铺满 1..totalCh：拉伸最后一卷 / 修正间隙
  list[0].startChapter = 1;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) {
      list[i].startChapter = list[i - 1].endChapter + 1;
    }
    if (list[i].endChapter < list[i].startChapter) {
      list[i].endChapter = list[i].startChapter;
    }
  }
  // 若总跨度不足 totalCh：拉长最后一卷
  const last = list[list.length - 1];
  if (last.endChapter < totalCh) {
    last.endChapter = totalCh;
  }
  // 若超出：从后往前压缩
  if (last.endChapter > totalCh) {
    last.endChapter = totalCh;
  }
  for (let i = list.length - 2; i >= 0; i--) {
    if (list[i].endChapter >= list[i + 1].startChapter) {
      list[i].endChapter = list[i + 1].startChapter - 1;
    }
    if (list[i].endChapter < list[i].startChapter) {
      list[i].endChapter = list[i].startChapter;
      list[i + 1].startChapter = list[i].endChapter + 1;
    }
  }
  // 再次保证末卷到 totalCh
  list[list.length - 1].endChapter = totalCh;
  list = list.filter((v) => v.startChapter <= totalCh && v.endChapter >= v.startChapter);
  if (list.length === 0) {
    return [
      {
        number: 1,
        title: '第一卷',
        summary: '全书主线',
        startChapter: 1,
        endChapter: totalCh,
        majorBeats: [],
      },
    ];
  }
  list[0].startChapter = 1;
  list[list.length - 1].endChapter = totalCh;
  return list;
}

/** 把一批模型章节对齐到 from..to */
export function normalizeChapterBatch(
  raw: OutlineChapterDraft[] | undefined | null,
  fromChapter: number,
  toChapter: number
): OutlineChapterDraft[] {
  const expected = toChapter - fromChapter + 1;
  const byNum = new Map<number, OutlineChapterDraft>();
  for (const c of raw || []) {
    const num = clampInt(c.number, 0);
    if (num < fromChapter || num > toChapter) continue;
    byNum.set(num, {
      number: num,
      title: (c.title || `第${num}章`).trim(),
      summary: (c.summary || '').trim(),
      involvedCharacterNames: c.involvedCharacterNames,
      involvedSettingNames: c.involvedSettingNames,
    });
  }
  // 仅当 number 字段整体失效（无一命中区间）才按数组顺序回填；
  // 否则缺号章置为占位——位置回填会把后一章内容错配给缺号章
  const useOrderedFallback = byNum.size === 0;
  const ordered = (raw || []).filter((c) => c && (c.title || c.summary));
  const out: OutlineChapterDraft[] = [];
  for (let n = fromChapter; n <= toChapter; n++) {
    const hit = byNum.get(n);
    if (hit && hit.summary.length >= 20) {
      out.push(hit);
      continue;
    }
    const idx = n - fromChapter;
    const fallback = useOrderedFallback ? ordered[idx] : undefined;
    if (fallback && (fallback.summary || fallback.title)) {
      out.push({
        number: n,
        title: (fallback.title || `第${n}章`).trim(),
        summary: (fallback.summary || '待补充梗概').trim(),
        involvedCharacterNames: fallback.involvedCharacterNames,
        involvedSettingNames: fallback.involvedSettingNames,
      });
    } else {
      out.push({
        number: n,
        title: `第${n}章 待补全`,
        summary: '',
      });
    }
  }
  // 保证长度
  while (out.length < expected) {
    const n = fromChapter + out.length;
    out.push({ number: n, title: `第${n}章 待补全`, summary: '' });
  }
  return out.slice(0, expected);
}

function resolveCharIds(
  names: string[] | undefined,
  characters: Character[],
  fallback: string[]
): string[] {
  if (!names?.length) return fallback;
  // 精确匹配（名字/别名）→ 包含式模糊匹配（模型偶发带称号/修饰）→ 兜底
  const exact = (n: string) =>
    characters.find((c) => c.name === n || c.alias?.includes(n))?.id;
  const fuzzy = (n: string) =>
    characters.find(
      (c) =>
        n.includes(c.name) ||
        c.name.includes(n) ||
        (c.alias ? n.includes(c.alias) || c.alias.includes(n) : false)
    )?.id;
  const ids = names
    .map((n) => exact(n) || fuzzy(n))
    .filter((id): id is string => !!id);
  return ids.length ? ids : fallback;
}

function resolveSettingIds(
  names: string[] | undefined,
  settings: WorldSetting[],
  fallback: string[]
): string[] {
  if (!names?.length) return fallback;
  const ids = names
    .map((n) => settings.find((s) => s.name === n)?.id)
    .filter((id): id is string => !!id);
  return ids.length ? ids : fallback;
}

function makeBatches(start: number, end: number, batchSize: number): [number, number][] {
  const batches: [number, number][] = [];
  for (let from = start; from <= end; from += batchSize) {
    const to = Math.min(end, from + batchSize - 1);
    batches.push([from, to]);
  }
  return batches;
}

/**
 * 多轮生成完整分卷 + 目标章数的章节梗概。
 */
export async function generateFullOutline(
  options: GenerateFullOutlineOptions
): Promise<GenerateFullOutlineResult> {
  const {
    config,
    title,
    synopsis,
    characters,
    settings,
    styleConfig,
    onProgress,
    batchSize = OUTLINE_CHAPTER_BATCH_SIZE,
  } = options;

  const totalTarget = resolveOutlineTotalChapters(config);
  // 兜底挂全书角色：模型未给 involvedCharacterNames 时不应只剩前两个角色
  // （右栏「设定/角色状态切片」与写前注入依赖这份清单，缺了就只剩主角）
  const defaultCharIds = characters.map((c) => c.id);
  const defaultSettingIds = settings.slice(0, 2).map((s) => s.id);

  const styleBlock = formatStyleStructureForPrompt(
    getActiveStyleProfile(styleConfig ?? null),
    config.genre
  );

  onProgress?.(`规划分卷骨架（全书 ${totalTarget} 章）…`);
  const volMessages = buildOutlineVolumesPrompt(config, title, synopsis, characters, settings, styleBlock);
  let volRes: { volumes?: OutlineVolumeDraft[] } | undefined;
  try {
    volRes = await generateJSON<{ volumes: OutlineVolumeDraft[] }>(volMessages, 0.65, {
      validate: validateVolumesDraft,
    });
  } catch (err) {
    // 分卷骨架校验重试后仍不合格：降级为等分切卷（normalizeVolumeRanges 兜底），不整段失败
    if (!isSchemaMismatchError(err)) throw err;
    console.warn('分卷骨架未通过结构校验（已带反馈重试），改用等分切卷:', err.message);
    onProgress?.('⚠️ 分卷骨架质量不佳，已自动等分切卷');
  }
  const volumeDrafts = normalizeVolumeRanges(volRes?.volumes, totalTarget);

  // 若模型在卷对象里内嵌了 chapters（偶发），先吸收
  const chapterMap = new Map<number, OutlineChapterDraft>();
  for (const v of volRes?.volumes || []) {
    for (const c of v.chapters || []) {
      const n = clampInt(c.number, 0);
      if (n >= 1 && n <= totalTarget && (c.summary || c.title)) {
        chapterMap.set(n, {
          number: n,
          title: c.title || `第${n}章`,
          summary: c.summary || '',
          involvedCharacterNames: c.involvedCharacterNames,
          involvedSettingNames: c.involvedSettingNames,
        });
      }
    }
  }

  let batchesRun = 0;
  const previousTail: { number: number; title: string; summary: string }[] = [];

  for (const vol of volumeDrafts) {
    const batches = makeBatches(vol.startChapter, vol.endChapter, batchSize);
    for (const [from, to] of batches) {
      // 跳过已有足够梗概的段
      let need = false;
      for (let n = from; n <= to; n++) {
        const existing = chapterMap.get(n);
        if (!existing || (existing.summary || '').trim().length < 40) {
          need = true;
          break;
        }
      }
      if (!need) {
        for (let n = from; n <= to; n++) {
          const e = chapterMap.get(n)!;
          previousTail.push({ number: n, title: e.title, summary: e.summary });
        }
        while (previousTail.length > 4) previousTail.shift();
        continue;
      }

      batchesRun += 1;
      onProgress?.(
        `拆章 ${from}–${to} / ${totalTarget} · ${vol.title}（第 ${batchesRun} 批）…`
      );

      try {
        const messages = buildOutlineChaptersBatchPrompt({
          config,
          title,
          synopsis,
          characters,
          settings,
          volume: vol,
          fromChapter: from,
          toChapter: to,
          previousTail: previousTail.slice(-3),
          totalChapters: totalTarget,
          styleStructureBlock: styleBlock,
        });
        const batchRes = await generateJSON<{ chapters: OutlineChapterDraft[] }>(messages, 0.7, {
          validate: makeChapterBatchValidator(from, to),
          // 大批次生成本高：原始 + 反馈重试共 2 次；仍不合格由外层占位补齐兜底
          maxRetries: 1,
        });
        const normalized = normalizeChapterBatch(batchRes.chapters, from, to);
        for (const c of normalized) {
          const prev = chapterMap.get(c.number);
          // 更长的 summary 优先
          if (!prev || (c.summary || '').length >= (prev.summary || '').length) {
            chapterMap.set(c.number, c);
          }
          previousTail.push({
            number: c.number,
            title: c.title,
            summary: c.summary,
          });
        }
        while (previousTail.length > 4) previousTail.shift();
      } catch (err: any) {
        // 单批失败不整崩：该段留空，后面占位补齐
        console.warn(`拆章批次 ${from}-${to} 失败:`, err?.message || err);
        onProgress?.(
          `⚠️ 第 ${from}–${to} 章本批失败，将占位补齐后可手动改：${err?.message || err}`
        );
      }
    }
  }

  // 组装 Volume / Chapter 实体
  const stamp = Date.now();
  const volumes: Volume[] = volumeDrafts.map((v, idx) => ({
    id: `vol-${stamp}-${idx + 1}`,
    number: v.number,
    title: v.title,
    summary: v.summary,
    startChapter: v.startChapter,
    endChapter: v.endChapter,
  }));

  const volByChapter = (num: number): Volume => {
    const hit = volumes.find((v) => num >= v.startChapter && num <= v.endChapter);
    return hit || volumes[volumes.length - 1];
  };

  let detailedCount = 0;
  let placeholderCount = 0;
  const chapters: Chapter[] = [];

  for (let n = 1; n <= totalTarget; n++) {
    const draft = chapterMap.get(n);
    const vol = volByChapter(n);
    const hasDetail = !!(draft && (draft.summary || '').trim().length >= 40);
    if (hasDetail) {
      detailedCount += 1;
    } else {
      placeholderCount += 1;
    }

    const summary = hasDetail
      ? draft!.summary.trim()
      : `【待补全】属「${vol.title}」。卷要旨：${(vol.summary || '').slice(0, 100)}。请在此补写第 ${n} 章冲突、人物动作与章末钩子。`;

    const title = draft?.title?.trim() || `第${n}章 ${hasDetail ? '' : '（待补全）'}`.trim();

    chapters.push({
      id: `chap-${stamp}-${n}`,
      number: n,
      title,
      summary,
      wordCount: 0,
      status: '大纲待拆',
      content: '',
      volumeId: vol.id,
      volumeNumber: vol.number,
      involvedCharacterIds: resolveCharIds(
        draft?.involvedCharacterNames,
        characters,
        defaultCharIds
      ),
      involvedSettingIds: resolveSettingIds(
        draft?.involvedSettingNames,
        settings,
        defaultSettingIds
      ),
      beats: [],
      lastModified: new Date().toISOString(),
    });
  }

  onProgress?.(
    `拆章完成：目标 ${totalTarget} 章 · 详案 ${detailedCount} · 占位 ${placeholderCount} · 批次 ${batchesRun}`
  );

  return {
    volumes,
    chapters,
    totalTarget,
    detailedCount,
    placeholderCount,
    batchesRun,
  };
}

/**
 * 占位章判定：标题含「待补全」、摘要以【待补全】开头、或摘要不足 40 字。
 * 与向导第五步（OutlineReviewStep）共用同一规则，避免判定两处漂移。
 */
export function isPlaceholderChapter(chap: Pick<Chapter, 'title' | 'summary'>): boolean {
  return (
    /待补全/.test(chap.title || '') ||
    /【待补全】/.test(chap.summary || '') ||
    (chap.summary || '').trim().length < 40
  );
}

export interface FillPlaceholderChaptersOptions {
  config: ProjectConfig;
  title: string;
  synopsis: string;
  characters: Character[];
  settings: WorldSetting[];
  /** 现有分卷（结构不变，仅用于组织批次与提供卷上下文） */
  volumes: Volume[];
  /** 现有章节（含占位章）；按 number 回填，其余章原样引用不重建 */
  chapters: Chapter[];
  /** 进度文案 */
  onProgress?: (msg: string) => void;
  /** 覆盖默认批大小 */
  /** 文风档案（作家方法论结构层，可选） */
  styleConfig?: StyleConfig | null;
  batchSize?: number;
}

export interface FillPlaceholderChaptersResult {
  /** 新章节数组：仅占位章被替换，其余章保持原引用与内容 */
  chapters: Chapter[];
  /** 本次成功补齐（新详案 ≥40 字）的章数 */
  filledCount: number;
  /** 仍未补齐的占位章数（含失败批次与模型未给详案） */
  remainingCount: number;
  batchesRun: number;
}

/**
 * 无损增量补齐占位章梗概：
 * 保留现有分卷结构与用户已改内容，仅对 isPlaceholderChapter 命中的章
 * 按卷分批调用 LLM 补写详案；单批失败只告警跳过，不影响其余批次。
 */
export async function fillPlaceholderChapters(
  options: FillPlaceholderChaptersOptions
): Promise<FillPlaceholderChaptersResult> {
  const {
    config,
    title,
    synopsis,
    characters,
    settings,
    volumes,
    chapters,
    styleConfig,
    onProgress,
    batchSize = OUTLINE_CHAPTER_BATCH_SIZE,
  } = options;

  const styleBlock = formatStyleStructureForPrompt(
    getActiveStyleProfile(styleConfig ?? null),
    config.genre
  );

  const placeholderNums = new Set<number>();
  for (const c of chapters) {
    if (isPlaceholderChapter(c)) placeholderNums.add(c.number);
  }
  const totalPlaceholders = placeholderNums.size;
  if (totalPlaceholders === 0) {
    onProgress?.('当前大纲没有占位章，无需补齐');
    return { chapters, filledCount: 0, remainingCount: 0, batchesRun: 0 };
  }

  // 占位章按所属卷归组（卷用现有值；找不到卷的组跳过补齐，保持原样）
  const chapByNum = new Map<number, Chapter>(chapters.map((c) => [c.number, c]));
  const groups: { vol?: Volume; nums: number[] }[] = [];
  for (const n of [...placeholderNums].sort((a, b) => a - b)) {
    const chap = chapByNum.get(n)!;
    const vol =
      volumes.find((v) => v.id === chap.volumeId || v.number === chap.volumeNumber) ||
      volumes.find((v) => n >= v.startChapter && n <= v.endChapter);
    let g = groups.find((x) => x.vol === vol);
    if (!g) {
      g = { vol, nums: [] };
      groups.push(g);
    }
    g.nums.push(n);
  }

  // 衔接上下文：所有已有详案章（含本次已补齐的），取「批前最近 3 个」
  const contextByNum = new Map<number, { number: number; title: string; summary: string }>();
  for (const c of chapters) {
    if (!isPlaceholderChapter(c)) {
      contextByNum.set(c.number, { number: c.number, title: c.title, summary: c.summary });
    }
  }
  const prevTail = (from: number) =>
    [...contextByNum.keys()]
      .filter((n) => n < from)
      .sort((a, b) => a - b)
      .slice(-3)
      .map((n) => contextByNum.get(n)!);

  let batchesRun = 0;
  let filledCount = 0;
  const filledByNum = new Map<number, Chapter>();

  for (const group of groups) {
    if (!group.vol) {
      console.warn(`占位章 ${group.nums.join(',')} 找不到所属卷，跳过补齐（保持原样）`);
      continue;
    }
    const batches = makeBatches(group.nums[0], group.nums[group.nums.length - 1], batchSize);
    for (const [from, to] of batches) {
      batchesRun += 1;
      onProgress?.(`补齐占位章 ${from}–${to} · ${group.vol.title}（第 ${batchesRun} 批）…`);
      try {
        const messages = buildOutlineChaptersBatchPrompt({
          config,
          title,
          synopsis,
          characters,
          settings,
          volume: group.vol,
          fromChapter: from,
          toChapter: to,
          previousTail: prevTail(from),
          totalChapters: resolveOutlineTotalChapters(config),
          styleStructureBlock: styleBlock,
        });
        // 追加约束：只为指定章号区间输出，不得改写其他章
        messages.push({
          role: 'user',
          content: `本次仅需为第 ${from} 至第 ${to} 章输出 chapters JSON；其余章节不要输出、不要改写。严格只输出合法 JSON。`,
        });
        // 占位补齐专用校验：按「批内占位章号」的覆盖率判定。
        // 原整批覆盖闸门（≥60% 全区间）与「只输出所需章节」的追加指令矛盾：
        // 占位章稀疏时模型按需输出会被误判截断 → 重试耗尽 → 占位永远补不齐。
        const batchPlaceholderNums = group.nums.filter((n) => n >= from && n <= to);
        const placeholderValidator = (value: unknown): string | null => {
          const chapters = (value as LooseRecord | null)?.chapters;
          if (!Array.isArray(chapters) || chapters.length === 0) {
            return `chapters 缺失或为空（应输出第 ${batchPlaceholderNums.join('、')} 章）`;
          }
          const usable = new Set<number>();
          for (const c of chapters) {
            if (!c || typeof c !== 'object') continue;
            const rec = c as LooseRecord;
            const num =
              typeof rec.number === 'number'
                ? Math.floor(rec.number)
                : Number(String(rec.number));
            if (!Number.isFinite(num) || !batchPlaceholderNums.includes(num)) continue;
            const hasContent =
              (typeof rec.title === 'string' && rec.title.trim().length > 0) ||
              (typeof rec.summary === 'string' && rec.summary.trim().length > 0);
            if (hasContent) usable.add(num);
          }
          if (usable.size === 0) {
            return `占位章 ${batchPlaceholderNums.join('、')} 均无有效条目（需含标题或摘要）`;
          }
          const minCover = Math.max(
            1,
            Math.ceil(batchPlaceholderNums.length * CHAPTER_BATCH_MIN_COVER)
          );
          if (usable.size < minCover) {
            const missing = batchPlaceholderNums.filter((n) => !usable.has(n)).slice(0, 10);
            return (
              `占位章覆盖不足：仅 ${usable.size}/${batchPlaceholderNums.length} 章` +
              `（缺第 ${missing.join('、')} 章），请完整输出`
            );
          }
          return null;
        };
        const batchRes = await generateJSON<{ chapters: OutlineChapterDraft[] }>(messages, 0.7, {
          validate: placeholderValidator,
          maxRetries: 1,
        });
        const normalized = normalizeChapterBatch(batchRes.chapters, from, to);
        for (const draft of normalized) {
          if (!placeholderNums.has(draft.number)) continue; // 非占位章一律不碰
          const newSummary = (draft.summary || '').trim();
          if (newSummary.length < 40) continue; // 无详案（不足 40 字）不采用
          const original = chapByNum.get(draft.number)!;
          // 只有原标题含「待补全」时才采纳模型标题，避免覆盖用户手改标题
          const newTitle =
            original.title.includes('待补全') && draft.title?.trim()
              ? draft.title.trim()
              : original.title;
          const replaced: Chapter = {
            ...original,
            title: newTitle,
            summary: newSummary,
            status: '细纲就绪',
            involvedCharacterIds: resolveCharIds(
              draft.involvedCharacterNames,
              characters,
              original.involvedCharacterIds
            ),
            involvedSettingIds: resolveSettingIds(
              draft.involvedSettingNames,
              settings,
              original.involvedSettingIds
            ),
            lastModified: new Date().toISOString(),
          };
          filledByNum.set(draft.number, replaced);
          filledCount += 1;
          // 已补齐章进入衔接上下文，供后续批接续
          contextByNum.set(draft.number, {
            number: draft.number,
            title: newTitle,
            summary: newSummary,
          });
        }
      } catch (err: any) {
        console.warn(`补齐占位章批次 ${from}-${to} 失败:`, err?.message || err);
        onProgress?.(
          `⚠️ 第 ${from}–${to} 章本批失败（保持原占位，可稍后重试）：${err?.message || err}`
        );
      }
    }
  }

  const nextChapters = chapters.map((c) =>
    placeholderNums.has(c.number) && filledByNum.has(c.number) ? filledByNum.get(c.number)! : c
  );
  const remainingCount = totalPlaceholders - filledCount;

  onProgress?.(
    `占位章补齐完成：成功 ${filledCount} / 剩余 ${remainingCount} / 批次 ${batchesRun}`
  );

  return { chapters: nextChapters, filledCount, remainingCount, batchesRun };
}
