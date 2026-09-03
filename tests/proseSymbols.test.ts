import { describe, expect, it } from 'vitest';
import { normalizeProseSymbols } from '../src/services/deslop/normalizePunctuation';

describe('deslop · normalizeProseSymbols 正文符号清洗', () => {
  it('删除与章节元信息重复的 markdown 章节标题行', () => {
    const input = '# 第一章 · 雨夜订单\n\n雨是从下午四点开始落的。';
    const r = normalizeProseSymbols(input);
    expect(r.changed).toBe(true);
    expect(r.text).toBe('雨是从下午四点开始落的。');
    expect(r.findings[0]?.type).toBe('md-heading-chapter');
  });

  it('数字章节标题行同样整行删除；其余标题只去 # 记号保留文字', () => {
    const r = normalizeProseSymbols(
      '# 第12章 试炼\n\n## 场景一：入口\n\n他推门而入。'
    );
    expect(r.text).toContain('场景一：入口');
    expect(r.text).not.toContain('#');
    expect(r.text).not.toContain('第12章 试炼');
  });

  it('去除 **加粗** 与 *斜体* 与 `代码` 记号，只留内容', () => {
    const r = normalizeProseSymbols(
      '**「跨江加急·江州二桥北方向」**\n\n*预计配送时长 22 分钟*\n\n备注 `加价 80 元`。'
    );
    expect(r.changed).toBe(true);
    expect(r.text).not.toContain('**');
    expect(r.text).not.toContain('*预计');
    expect(r.text).not.toContain('`');
    expect(r.text).toContain('「跨江加急'.replace('「', '\u201C'));
    expect(r.findings.some((f) => f.type === 'md-emphasis')).toBe(true);
  });

  it('直角引号「」统一为中文双引号“”，『』→‘’', () => {
    const r = normalizeProseSymbols('「你怎么到这么快的。」「嗯。」他说『好』。');
    expect(r.changed).toBe(true);
    expect(r.text).toBe('\u201C你怎么到这么快的。\u201D\u201C嗯。\u201D他说\u2018好\u2019。');
    expect(r.findings.find((f) => f.type === 'quote-style')?.count).toBe(6);
  });

  it('干净正文原样通过（changed=false，零 findings）', () => {
    const clean = '\u201C雨有点大。\u201D他抹了把脸。\n\n护目镜糊成一团。';
    const r = normalizeProseSymbols(clean);
    expect(r.changed).toBe(false);
    expect(r.findings).toHaveLength(0);
    expect(r.text).toBe(clean);
  });

  it('不碰省略号与破折号（文风层豁免不受影响）', () => {
    const withStyle = '他停下……\u201C别过来。\u201D';
    const r = normalizeProseSymbols(withStyle);
    expect(r.text).toBe(withStyle);
  });

  it('组合污染一次清干净且不产生多余空行', () => {
    const dirty =
      '**「跨江加急·4.3 公里」**\n\n# 第一章 · 雨夜订单\n\n雨是从下午四点开始落的。\n\n「骑手？」\n\n「嗯。」';
    const r = normalizeProseSymbols(dirty);
    expect(r.changed).toBe(true);
    expect(r.text.startsWith('\u201C跨江加急·4.3 公里\u201D')).toBe(true);
    expect(r.text).toContain('\u201C骑手？\u201D');
    expect(r.text).not.toMatch(/\n{3,}/);
    expect(r.text).not.toContain('#');
    expect(r.text).not.toContain('**');
  });

  it('空串与 null 安全', () => {
    expect(normalizeProseSymbols('').text).toBe('');
    expect(normalizeProseSymbols(undefined as unknown as string).text).toBe('');
  });
});
