import { describe, it, expect } from 'vitest';
import { sanitizeMaxTokens } from '../server/llmService';

describe('llmService · sanitizeMaxTokens（输出预算清洗）', () => {
  it('留空 / 0 / 负数 / 非数字 → null（回落默认 8192）', () => {
    expect(sanitizeMaxTokens(undefined)).toBeNull();
    expect(sanitizeMaxTokens(null)).toBeNull();
    expect(sanitizeMaxTokens('')).toBeNull();
    expect(sanitizeMaxTokens(0)).toBeNull();
    expect(sanitizeMaxTokens('0')).toBeNull();
    expect(sanitizeMaxTokens(-5)).toBeNull();
    expect(sanitizeMaxTokens('abc')).toBeNull();
    expect(sanitizeMaxTokens(NaN)).toBeNull();
  });

  it('正数取整放行，封顶 100 万', () => {
    expect(sanitizeMaxTokens(16384)).toBe(16384);
    expect(sanitizeMaxTokens('8192')).toBe(8192);
    expect(sanitizeMaxTokens(1024.9)).toBe(1024);
    expect(sanitizeMaxTokens(99999999)).toBe(1_000_000);
  });
});
