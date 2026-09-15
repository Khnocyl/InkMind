import { describe, it, expect } from 'vitest';
import { decodeTextBytes, readTextFileSmart } from '../src/services/textEncoding';

/** 「中文」的 GBK 字节 */
const GBK_ZHONG_WEN = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);

/** 手工构造真正的 UTF-16LE/UTF-16BE 字节（不能拿 UTF-8 字节冒充） */
function utf16Bytes(text: string, endian: 'le' | 'be'): Uint8Array {
  const bytes: number[] = endian === 'le' ? [0xff, 0xfe] : [0xfe, 0xff];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (endian === 'le') bytes.push(code & 0xff, (code >> 8) & 0xff);
    else bytes.push((code >> 8) & 0xff, code & 0xff);
  }
  return new Uint8Array(bytes);
}

describe('textEncoding · 文本文件解码（GBK 小说 TXT 不再变乱码）', () => {
  it('UTF-8 字节照常解出', () => {
    const r = decodeTextBytes(new TextEncoder().encode('第一章 开局'));
    expect(r.encoding).toBe('UTF-8');
    expect(r.text).toBe('第一章 开局');
  });

  it('UTF-8 BOM 被剥掉', () => {
    const body = new TextEncoder().encode('第一章');
    const r = decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...body]));
    expect(r.encoding).toBe('UTF-8 (BOM)');
    expect(r.text).toBe('第一章');
  });

  it('GBK 字节不再被当 UTF-8 解成「锟斤拷」', () => {
    const r = decodeTextBytes(GBK_ZHONG_WEN);
    expect(r.text).toBe('中文');
    expect(r.encoding).toBe('GB18030');
    // 反证：修之前走的正是「宽容 UTF-8 解码」，得到的是替换字符/锟斤拷那一类
    expect(new TextDecoder('utf-8').decode(GBK_ZHONG_WEN)).not.toBe('中文');
  });

  it('UTF-16LE / UTF-16BE（带 BOM）能解', () => {
    const le = decodeTextBytes(utf16Bytes('第一章', 'le'));
    expect(le.encoding).toBe('UTF-16LE');
    expect(le.text).toBe('第一章');

    const be = decodeTextBytes(utf16Bytes('第一章', 'be'));
    expect(be.encoding).toBe('UTF-16BE');
    expect(be.text).toBe('第一章');
  });

  it('ArrayBuffer 入参也支持；空字节/垃圾字节不抛错', () => {
    const buf = new TextEncoder().encode('abc').buffer;
    expect(decodeTextBytes(buf).text).toBe('abc');
    expect(decodeTextBytes(new Uint8Array([])).text).toBe('');
    expect(() => decodeTextBytes(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).not.toThrow();
  });

  it('readTextFileSmart：Blob 也能读（File.text() 的等价替代）', async () => {
    const blob = new Blob([GBK_ZHONG_WEN]);
    const r = await readTextFileSmart(blob);
    expect(r.text).toBe('中文');
    expect(r.encoding).toBe('GB18030');
  });
});
