/**
 * 文本文件解码（全应用的「读用户 TXT/MD」唯一出口）。
 *
 * 为什么需要独立模块：`File.text()` 一律按 UTF-8 解码，而国内小说站另存的 TXT
 * 绝大多数是 GBK/GB18030 —— 直接 `file.text()` 会得到满屏「锟斤拷」。这是**静默失败**：
 * 不报错，只是内容全成乱码，然后被拿去拆书 / 当灵感 / 学文风。
 *
 * 判据顺序：BOM → UTF-8 严格解码（失败即抛）→ GB18030/BIG5 严格解码 → 兜底。
 * 用 `fatal: true` 是刻意的：它能可靠区分「真的是 UTF-8」与「碰巧能解但其实是别的编码」。
 */

export interface DecodedText {
  text: string;
  /** 实际采用的编码（展示给用户，便于判断是否有乱码） */
  encoding: string;
}

/** 按字节智能解码。同时支持 Uint8Array 与 Blob/File。 */
export function decodeTextBytes(input: Uint8Array | ArrayBuffer): DecodedText {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const strict = (enc: string): string | null => {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(b);
    } catch {
      return null;
    }
  };
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    // BOM 由解码器自行剥离（ignoreBOM 默认 false）
    return { text: new TextDecoder('utf-8').decode(b), encoding: 'UTF-8 (BOM)' };
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(b), encoding: 'UTF-16LE' };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(b), encoding: 'UTF-16BE' };
  }
  const utf8 = strict('utf-8');
  if (utf8 != null) return { text: utf8, encoding: 'UTF-8' };
  // 非 UTF-8：gb18030 是国内小说 TXT 的主流（gbk 在 WHATWG 里就是它的别名，无需单列）
  for (const enc of ['gb18030', 'big5'] as const) {
    const t = strict(enc);
    if (t != null) return { text: t, encoding: enc.toUpperCase() };
  }
  return {
    text: new TextDecoder('utf-8').decode(b),
    encoding: '未知（按 UTF-8 容错解码，可能有乱码）',
  };
}

/** 读本地文件（浏览器 File/Blob）并智能解码 */
export async function readTextFileSmart(file: File | Blob): Promise<DecodedText> {
  return decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
}
