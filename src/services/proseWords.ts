/**
 * 字数统计与每章字数目标的唯一出口（架构排查 A4/A5）。
 *
 * 口径（全库强制统一）：去空白字符数——中文含标点、不含空格/换行，
 * 与日更账本及编辑器显示一致。所有字数读取必须经由本模块，
 * 禁止散落 `replace(/\s+/g, '').length`（历史教训：三套口径并存 +
 * 单位错配曾导致「补写后不达标」，见 wordCount.ts 的 trimProseAddition）。
 */

/** 去空白字数（undefined/null 安全） */
export function proseWords(text: string | undefined | null): number {
  return (text || '').replace(/\s+/g, '').length;
}

/**
 * 带旧值兜底：wordCount > 0 时优先返回（沿用原 `wordCount || 内容计数` 的
 * 真值语义——wordCount 为 0/负/缺省时都回落到内容实算，防止「字段为 0 但
 * 有正文」的章被统计成 0 字）。
 * 仅限「字段可信」的字数汇总场景；质量判定（字数闸门等）请用 proseWords。
 */
export function contentWordsOrFallback(
  content: string | undefined,
  wordCount?: number
): number {
  if (typeof wordCount === 'number' && wordCount > 0) return wordCount;
  return proseWords(content);
}

export interface ChapterWordTargetConfig {
  targetWordCountPerChapter?: number;
  wordsPerChapter?: number;
}

/**
 * 每章字数目标单点解析（新键优先，旧键兼容）。
 * 未设置/非法值返回 null，调用方按「无目标」处理——
 * 全库禁止再散落 `targetWordCountPerChapter ?? wordsPerChapter ?? null`。
 * 取整沿用 writingProgress 既有 floor 语义（目标来自 UI 整数步进，实际无差）。
 */
export function resolveChapterWordTarget(
  config: ChapterWordTargetConfig | null | undefined
): number | null {
  const raw = config?.targetWordCountPerChapter ?? config?.wordsPerChapter;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}
