import { describe, expect, it } from 'vitest';
import {
  contentWordsOrFallback,
  proseWords,
  resolveChapterWordTarget,
} from '../src/services/proseWords';

describe('proseWords · 唯一字数口径', () => {
  it('去空白统计：中文含标点、去空格与换行', () => {
    expect(proseWords('你好，世界。\n\n 第二段！')).toBe(10);
    expect(proseWords('   ')).toBe(0);
  });

  it('undefined / null / 空串安全', () => {
    expect(proseWords(undefined)).toBe(0);
    expect(proseWords(null)).toBe(0);
    expect(proseWords('')).toBe(0);
  });

  it('contentWordsOrFallback：字段非负优先，否则按内容', () => {
    expect(contentWordsOrFallback('一二三四五', 99)).toBe(99);
    expect(contentWordsOrFallback('一二三四五', -1)).toBe(5);
    expect(contentWordsOrFallback('一二三四五', 0)).toBe(5); // 0 按真值语义回落内容实算
    expect(contentWordsOrFallback('一二三四五', undefined)).toBe(5);
    expect(contentWordsOrFallback(undefined, undefined)).toBe(0);
  });
});

describe('resolveChapterWordTarget · 单点解析', () => {
  it('新键优先，旧键兼容', () => {
    expect(
      resolveChapterWordTarget({ targetWordCountPerChapter: 2000, wordsPerChapter: 3000 })
    ).toBe(2000);
    expect(resolveChapterWordTarget({ wordsPerChapter: 3000 })).toBe(3000);
  });

  it('未设置 / 非法值 → null', () => {
    expect(resolveChapterWordTarget(undefined)).toBeNull();
    expect(resolveChapterWordTarget(null)).toBeNull();
    expect(resolveChapterWordTarget({})).toBeNull();
    expect(resolveChapterWordTarget({ targetWordCountPerChapter: 0 })).toBeNull();
    expect(resolveChapterWordTarget({ targetWordCountPerChapter: -5 })).toBeNull();
    expect(
      resolveChapterWordTarget({ targetWordCountPerChapter: Number.NaN })
    ).toBeNull();
  });

  it('小数向下取整（沿用 writingProgress 既有语义）', () => {
    expect(resolveChapterWordTarget({ wordsPerChapter: 1999.6 })).toBe(1999);
  });
});
