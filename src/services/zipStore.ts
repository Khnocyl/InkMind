/**
 * 最小 ZIP 写入（仅 STORE 无压缩），足够生成 EPUB。
 * 输出 Uint8Array，浏览器可下载为 .epub。
 */

export interface ZipEntry {
  path: string;
  data: Uint8Array | string;
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function encodePath(path: string): Uint8Array {
  // UTF-8 file names; set general purpose bit 11 for UTF-8
  return new TextEncoder().encode(path.replace(/\\/g, '/'));
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/**
 * 构建无压缩 ZIP。
 * @param entries 路径用 / 分隔；EPUB 要求 mimetype 为第一项且无压缩（本实现全部 STORE，符合）
 */
export function buildZipStore(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encodePath(entry.path);
    const data = toBytes(entry.data);
    const crc = crc32(data);
    const gpFlag = 0x0800; // UTF-8

    // Local file header
    const local = concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(gpFlag),
      u16(0), // method store
      u16(0), // time
      u16(0), // date
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0), // extra
      name,
      data,
    ]);
    localParts.push(local);

    // Central directory header
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(gpFlag),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    centralParts.push(central);
    offset += local.length;
  }

  const centralDir = concat(centralParts);
  const centralOffset = offset;
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(centralOffset),
    u16(0),
  ]);

  return concat([...localParts, centralDir, end]);
}

export function downloadBytes(filename: string, data: Uint8Array, mime: string): void {
  // Copy into a fresh ArrayBuffer-backed Uint8Array for BlobPart compatibility
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const blob = new Blob([copy], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
