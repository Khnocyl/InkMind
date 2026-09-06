/**
 * 正文字数闸门域（架构排查 A1 拆分：自 aiEngine 抽出）。
 * 职责：字数达标判定（ensureProseWordCount 补写闭环）、句界软裁剪（trimProseAddition）、
 * 修复类操作的字数带（deriveWordBand）。字数口径来自 proseWords 唯一出口。
 */
import type { Chapter, Character, PlotBeat, StyleConfig } from '../types/novel';
import { generateStream } from './llmClient';
import { buildChapterExpandPrompt } from './prompts';
import { proseWords } from './proseWords';
import { mergeExtendedBlacklist } from './aiTasteScan';

export interface WordCountGate {
  target: number;
  min: number;
  /** 全章字数上限（超出同判不合格）：默认 target × maxRatio */
  max?: number;
  current: number;
  met: boolean;
  expandRounds: number;
}

/** 去空白字数——proseWords 的语义化别名（正文域惯用名） */
export function countProseWords(prose: string): number {
  return proseWords(prose);
}

/**
 * 句界软裁剪：当「已有正文 + 追加块」合计会越过字数上限时，
 * 把追加块在最近的句末标点处截短，使合计落回上限之内。
 * 找不到合适句界或剩余空间过小时原样放行（宁整勿碎），由调用方进度文案兜底说明。
 * 单位对齐：maxTotal 是「去空白字数」口径，裁剪按原始字符进行——
 * 用 base 的原始长/去空白长比值把上限换算到原始字符口径，
 * 避免对话多换行的章节被系统性过度裁剪（是「补写后仍不达标」的隐性根源）。
 */
export function trimProseAddition(
  base: string,
  addition: string,
  maxTotal: number
): { text: string; trimmed: boolean } {
  if (!Number.isFinite(maxTotal) || maxTotal <= 0) {
    return { text: addition, trimmed: false };
  }
  const baseRaw = base.trim().length;
  const addTrimmed = addition.trim();
  const baseNonWs = proseWords(base);
  const ratio = baseNonWs > 0 ? baseRaw / baseNonWs : 1.2;
  const maxRaw = Math.round(maxTotal * ratio);
  if (baseRaw + addTrimmed.length <= maxRaw) {
    return { text: addition, trimmed: false };
  }
  const budget = maxRaw - baseRaw;
  if (budget < 120) return { text: addition, trimmed: false };
  const window = addTrimmed.slice(0, Math.floor(budget));
  for (let i = window.length - 1; i >= 40; i -= 1) {
    const ch = window[i];
    if ('。！？…”'.includes(ch)) {
      return { text: window.slice(0, i + 1), trimmed: true };
    }
  }
  return { text: addition, trimmed: false };
}

export interface WordBand {
  low: number;
  high: number;
}

/**
 * 修复类操作（待修清单/beat 重写）的字数带：
 * 有目标字数用 target ±10%；否则相对原稿字数 ±10%（修复不该改变篇幅量级）。
 */
export function deriveWordBand(
  targetWordCount: number | null | undefined,
  baseProse: string
): WordBand {
  const anchor =
    targetWordCount && targetWordCount > 0
      ? Math.round(targetWordCount)
      : Math.max(300, countProseWords(baseProse));
  return {
    low: Math.round(anchor * 0.9),
    high: Math.round(anchor * 1.1),
  };
}

/**
 * 字数不足则续写加厚，最多 maxRounds 轮。
 * 返回拼接后的全文与达标信息。
 */
export async function ensureProseWordCount(options: {
  prose: string;
  targetWordCount: number;
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>;
  beats?: PlotBeat[];
  characters?: Character[];
  styleConfig?: StyleConfig;
  chapterIntentBlock?: string;
  minRatio?: number;
  /** 上限比例：合计超过 target × maxRatio 同判不合格并停止追写（默认 1.1） */
  maxRatio?: number;
  /** 补足目标比例：循环补写到 target × fillRatio 才收手（默认 0.95，
   *  避免「刚过 0.9 达标线就停」导致章节长期贴线下沿）；met 判定仍以 minRatio 为准 */
  fillRatio?: number;
  maxRounds?: number;
  onStream?: (chunk: string) => void;
  onProgress?: (msg: string) => void;
}): Promise<{ prose: string; gate: WordCountGate }> {
  const target = Math.max(0, Math.round(options.targetWordCount || 0));
  const minRatio = options.minRatio ?? 0.9;
  const maxRatio = options.maxRatio ?? 1.1;
  const fillRatio = options.fillRatio ?? 0.95;
  const maxRounds = options.maxRounds ?? 2;
  const min = target > 0 ? Math.round(target * minRatio) : 0;
  const max =
    target > 0 ? Math.round(target * maxRatio) : Number.POSITIVE_INFINITY;
  // 补足目标：写到 target×0.95 才收手（上限内），使成稿落在目标附近而非贴着下限
  const fillGoal =
    target > 0 ? Math.min(Math.round(target * fillRatio), max) : 0;

  let prose = (options.prose || '').trim();
  let current = countProseWords(prose);
  let expandRounds = 0;

  if (target <= 0 || min <= 0) {
    return {
      prose,
      gate: { target, min, max, current, met: true, expandRounds: 0 },
    };
  }

  // 与写稿/写后机检同口径：自定义 + 扩展套话表，白名单豁免（此前缺扩展表与白名单过滤）
  const blacklist = mergeExtendedBlacklist(options.styleConfig);

  while (current < fillGoal && expandRounds < maxRounds) {
    // 需求量朝补足目标推进，封顶到剩余余量：请求本身不允许越过上限带
    const needMore = Math.max(
      200,
      Math.min(fillGoal - current + 80, max - current)
    );
    expandRounds += 1;
    options.onProgress?.(
      ` [字数补写 ${expandRounds}/${maxRounds}] 当前 ${current} · 目标 ${target}（区间 ${min}–${max}）· 续写约 ${needMore} 字…`
    );

    const messages = buildChapterExpandPrompt({
      chapter: options.chapter,
      existingProse: prose,
      currentWords: current,
      targetWordCount: target,
      minWordCount: min,
      needMore,
      beats: options.beats,
      characters: options.characters,
      styleConfig: options.styleConfig,
      chapterIntentBlock: options.chapterIntentBlock,
      blacklist,
    });

    try {
      // 续写块单独缓冲，再拼到全文，避免 onStream 把「仅续写」当成覆盖全文
      let expandBuf = '';
      const expansion = await generateStream(
        messages,
        0.75,
        (chunk) => {
          expandBuf += chunk;
          if (options.onStream) {
            options.onStream(prose + (prose.endsWith('\n') ? '' : '\n') + expandBuf);
          }
        },
        (msg) => options.onProgress?.(` [字数补写] ${msg}`)
      );
      const add = (expansion || expandBuf || '').trim();
      if (!add || add.length < 40) {
        options.onProgress?.(
          ` [字数补写] 第 ${expandRounds} 轮几乎无输出，停止补写`
        );
        break;
      }
      // 若模型误回了全文，取比原文更长的部分或直接用新稿
      if (add.length > prose.length * 0.85 && add.includes(prose.slice(0, 80))) {
        // 重写稿同样做句界软裁，防单轮超写冲破上限
        const keptAll = trimProseAddition('', add, max);
        prose = keptAll.text.trim();
        if (keptAll.trimmed) {
          options.onProgress?.(
            ` [字数区间] 重写稿超出上限，已按句界裁至 ${max} 字内`
          );
        }
      } else {
        const kept = trimProseAddition(prose, add, max);
        prose = `${prose.trim()}\n\n${kept.text}`.trim();
        if (kept.trimmed) {
          options.onProgress?.(
            ` [字数区间] 已按句界微裁续写块，合计控制在 ${max} 字内`
          );
        }
      }
      current = countProseWords(prose);
      options.onProgress?.(
        ` [字数补写] 第 ${expandRounds} 轮后 ${current}/${target} 字（区间 ${min}–${
          Number.isFinite(max) ? max : '∞'
        }）`
      );
    } catch (err: any) {
      options.onProgress?.(
        ` [字数补写] 第 ${expandRounds} 轮失败：${err?.message || err}`
      );
      break;
    }
  }

  return {
    prose,
    gate: {
      target,
      min,
      max,
      current,
      met: current >= min,
      expandRounds,
    },
  };
}
