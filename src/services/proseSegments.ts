/**
 * 通用正文分段器：长文本送审/抽取时按段落边界拆段，消灭「截头去尾」中段盲区。
 * 硬伤审（aiEngine）与事实账本补抽（factLedger）共用。
 */

export interface ProseSegment {
  text: string;
  index: number;
  total: number;
}

export function splitProseForReview(
  prose: string,
  options?: { limit?: number; overlap?: number }
): ProseSegment[] {
  const limit = options?.limit ?? 7000;
  const overlap = options?.overlap ?? 400;
  const clean = (prose || '').trim();
  if (clean.length <= limit) {
    return [{ text: clean, index: 1, total: 1 }];
  }
  const parts: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + limit, clean.length);
    if (end < clean.length) {
      // 优先在段尾换行处下刀，避免切碎句子
      const cut = clean.lastIndexOf('\n', end);
      if (cut > start + limit * 0.6) end = cut;
    }
    parts.push(clean.slice(start, end));
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return parts.map((text, i) => ({ text, index: i + 1, total: parts.length }));
}
