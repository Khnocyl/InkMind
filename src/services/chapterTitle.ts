/**
 * 章节标题去重展示：标题若已自带「第N章/第一章/章节」等前缀，
 * 先剥离前缀，由各 UI 统一拼「第N章 标题」，避免「第1章 第一章 幽冥废墟」这类重复。
 */
export function chapterDisplayTitle(title: string): string {
  const t = (title || '').trim();
  return t
    .replace(
      /^(?:第\s*[0-9零一二三四五六七八九十百千万]+\s*[章节回折话集]?[\s:：\-_·]*|章节\s*[0-9零一二三四五六七八九十百千万]*[\s:：\-_·]*)+/,
      ''
    )
    .trim();
}