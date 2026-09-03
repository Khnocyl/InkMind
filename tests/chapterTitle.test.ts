import { describe, expect, it } from 'vitest';
import { chapterDisplayTitle } from '../src/services/chapterTitle';

describe('chapterDisplayTitle · 章名去重展示', () => {
  it('标题自带「第N章」前缀时剥离，避免「第10章 第10章 卷末高潮」重复', () => {
    expect(chapterDisplayTitle('第10章 卷末高潮')).toBe('卷末高潮');
    expect(chapterDisplayTitle('第3章 新的敌人')).toBe('新的敌人');
    expect(chapterDisplayTitle('第1章：启程')).toBe('启程');
  });

  it('标题自带中文「第一章/第二十章」或「第一回」等前缀时剥离', () => {
    expect(chapterDisplayTitle('第一章 幽冥废墟，断剑生星晷')).toBe('幽冥废墟，断剑生星晷');
    expect(chapterDisplayTitle('第二章 尸骨与朱砂密函')).toBe('尸骨与朱砂密函');
    expect(chapterDisplayTitle('第二十章·风云变幻')).toBe('风云变幻');
    expect(chapterDisplayTitle('第一百二十三章 终局之战')).toBe('终局之战');
    expect(chapterDisplayTitle('第一回 启程')).toBe('启程');
    expect(chapterDisplayTitle('第一折 序幕')).toBe('序幕');
  });

  it('标题自带「章节」或重复前缀时剥离', () => {
    expect(chapterDisplayTitle('章节1 序章')).toBe('序章');
    expect(chapterDisplayTitle('章节 序章')).toBe('序章');
    expect(chapterDisplayTitle('第1章 第一章 幽冥废墟')).toBe('幽冥废墟');
    expect(chapterDisplayTitle('第一章 第1章 幽冥废墟')).toBe('幽冥废墟');
    expect(chapterDisplayTitle('第 1 章 新增章节')).toBe('新增章节');
  });

  it('仅包含章节编号前缀时返回空字符串', () => {
    expect(chapterDisplayTitle('第一章')).toBe('');
    expect(chapterDisplayTitle('第1章')).toBe('');
    expect(chapterDisplayTitle('章节1')).toBe('');
  });

  it('纯标题原样返回（不误删正文含章序的标题）', () => {
    expect(chapterDisplayTitle('刀还在鞘里')).toBe('刀还在鞘里');
    expect(chapterDisplayTitle('半张纸条')).toBe('半张纸条');
    expect(chapterDisplayTitle('')).toBe('');
  });

  it('处理空格与全角冒号变体', () => {
    expect(chapterDisplayTitle('第 12 章 夜访')).toBe('夜访');
    expect(chapterDisplayTitle('第7章: 回响')).toBe('回响');
    expect(chapterDisplayTitle('第7章：回响')).toBe('回响');
  });
});