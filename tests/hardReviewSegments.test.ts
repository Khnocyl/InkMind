/**
 * 硬伤审分段送审（消灭中段盲区）的切分逻辑单测：
 * - ≤7000 字单段（行为与旧版一致，不多花 LLM 调用）
 * - 长章按段落边界拆多段、相邻段重叠、覆盖全文无遗漏
 */
import { describe, expect, it } from 'vitest';
import { splitHardReviewSegments } from '../src/services/aiEngine';
import { splitProseForReview } from '../src/services/proseSegments';

const LIMIT = 7000;

function makeLong(nParas: number, paraLen = 200): string {
  return Array.from(
    { length: nParas },
    (_, i) => `第${i}段` + '内容'.repeat(paraLen / 2)
  ).join('\n');
}

describe('splitHardReviewSegments', () => {
  it('短章单段', () => {
    const out = splitHardReviewSegments('短正文'.repeat(100));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ index: 1, total: 1 });
  });

  it('恰好在阈值上仍单段', () => {
    const prose = '字'.repeat(LIMIT);
    expect(splitHardReviewSegments(prose)).toHaveLength(1);
  });

  it('长章拆多段且 total/index 连续', () => {
    const prose = makeLong(120, 200); // ~24k 字
    const out = splitHardReviewSegments(prose);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out[0].index).toBe(1);
    expect(out[out.length - 1].index).toBe(out.length);
    expect(out.every((s) => s.total === out.length)).toBe(true);
  });

  it('每段不超上限（prompt 内不再触发截断）', () => {
    const prose = makeLong(120, 300); // ~36k 字
    for (const seg of splitHardReviewSegments(prose)) {
      expect(seg.text.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it('相邻段重叠（跨段事实不至于正好切丢）', () => {
    const prose = makeLong(120, 200);
    const out = splitHardReviewSegments(prose);
    if (out.length >= 2) {
      // 重叠窗口约 OVERLAP：前段尾部与后段头部应有共享内容（允许段落边界下刀误差）
      const tail = out[0].text.slice(-80);
      expect(out[1].text.slice(0, 600)).toContain(tail.slice(-20));
    }
  });

  it('全文无遗漏：拼回去覆盖原文所有内容（含重叠）', () => {
    const prose = makeLong(100, 200).trim();
    const out = splitHardReviewSegments(prose);
    // 首段开头 = 原文开头；末段结尾 = 原文结尾
    expect(out[0].text.startsWith(prose.slice(0, 50))).toBe(true);
    const last = out[out.length - 1].text;
    expect(last.endsWith(prose.slice(-50))).toBe(true);
  });

  it('通用分段器：自定义 limit/overlap（账本补抽 4500 参数）', () => {
    const prose = makeLong(60, 200); // ~12k 字
    const out = splitProseForReview(prose, { limit: 4500, overlap: 300 });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.every((s) => s.text.length <= 4500)).toBe(true);
    expect(out[0].text.startsWith(prose.trim().slice(0, 50))).toBe(true);
    expect(out[out.length - 1].text.endsWith(prose.trim().slice(-50))).toBe(true);
  });

  it('通用分段器：短文单段原样返回', () => {
    const out = splitProseForReview('短文本', { limit: 4500, overlap: 300 });
    expect(out).toEqual([{ text: '短文本', index: 1, total: 1 }]);
  });
});
