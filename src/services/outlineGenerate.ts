/**
 * 向导「分卷 + 拆章」多轮生成。
 * 单次 LLM 调用无法稳定吐出 100+ 章完整梗概，故：
 * 1) 先生成覆盖全书的分卷骨架
 * 2) 再按卷分批（默认每批 ≤20 章）逐章补全
 * 3) 仍缺章时用卷摘要做占位补齐，保证章数 = 目标
 */

import type { Chapter, Character, ProjectConfig, Volume, WorldSetting } from '../types/novel';
import { generateJSON } from './llmClient';
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
  // 若 number 乱了，按数组顺序填
  const ordered = (raw || []).filter((c) => c && (c.title || c.summary));
  const out: OutlineChapterDraft[] = [];
  for (let n = fromChapter; n <= toChapter; n++) {
    const hit = byNum.get(n);
    if (hit && hit.summary.length >= 20) {
      out.push(hit);
      continue;
    }
    const idx = n - fromChapter;
    const fallback = ordered[idx];
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
  const ids = names
    .map((n) => characters.find((c) => c.name === n || c.alias?.includes(n))?.id)
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
    onProgress,
    batchSize = OUTLINE_CHAPTER_BATCH_SIZE,
  } = options;

  const totalTarget = resolveOutlineTotalChapters(config);
  const defaultCharIds = characters.slice(0, 2).map((c) => c.id);
  const defaultSettingIds = settings.slice(0, 2).map((s) => s.id);

  onProgress?.(`规划分卷骨架（全书 ${totalTarget} 章）…`);
  const volMessages = buildOutlineVolumesPrompt(config, title, synopsis, characters, settings);
  const volRes = await generateJSON<{ volumes: OutlineVolumeDraft[] }>(volMessages, 0.65);
  const volumeDrafts = normalizeVolumeRanges(volRes.volumes, totalTarget);

  // 若模型在卷对象里内嵌了 chapters（偶发），先吸收
  const chapterMap = new Map<number, OutlineChapterDraft>();
  for (const v of volRes.volumes || []) {
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
        });
        const batchRes = await generateJSON<{ chapters: OutlineChapterDraft[] }>(messages, 0.7);
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
