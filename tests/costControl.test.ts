import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  addUsageRecord,
  BudgetExceededError,
  checkBudgetBeforeCall,
  classifyChapterTier,
  estimateCostCny,
  estimateTokens,
  estimateUsageCost,
  formatUsageSummary,
  getMonthCostCny,
  getUsageSummary,
  isBudgetExceededError,
  loadUsageRecords,
  setBudgetConfig,
} from '../src/services/costControl';

function mockLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal('localStorage', storage);
  return { store, storage };
}

describe('costControl · estimateTokens', () => {
  it('CJK 字符 ≈ 1 token/字', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
  it('拉丁字符 ≈ 0.25 token/字符', () => {
    expect(estimateTokens('abcd')).toBe(1); // 4 * 0.25 = 1
  });
  it('空白不计入', () => {
    expect(estimateTokens('  \n\t ')).toBe(1); // 至少 1
  });
  it('空串至少 1 token', () => {
    expect(estimateTokens('')).toBe(1);
  });
  it('混合文本', () => {
    const n = estimateTokens('你好 hello 世界');
    // 4 CJK + 5 latin*0.25 ≈ 5.25 → ceil 6
    expect(n).toBe(6);
  });
});

describe('costControl · estimateCostCny', () => {
  it('deepseek-chat 按 ¥2/百万输入、¥8/百万输出', () => {
    // 1M 输入 token → ¥2；1M 输出 token → ¥8
    expect(estimateCostCny('deepseek-chat', 1_000_000, 0)).toBeCloseTo(2, 5);
    expect(estimateCostCny('deepseek-chat', 0, 1_000_000)).toBeCloseTo(8, 5);
  });
  it('未知模型用默认价', () => {
    // 默认 ¥4/百万输入、¥12/百万输出
    expect(estimateCostCny('my-custom-model', 1_000_000, 0)).toBeCloseTo(4, 5);
    expect(estimateCostCny('my-custom-model', 0, 1_000_000)).toBeCloseTo(12, 5);
  });
  it('大小写不敏感匹配', () => {
    expect(estimateCostCny('DeepSeek-Chat', 1_000_000, 0)).toBeCloseTo(2, 5);
  });
  it('estimateUsageCost 综合估算', () => {
    const est = estimateUsageCost('deepseek-chat', '你好世界', '世界');
    expect(est.tokens).toBeGreaterThanOrEqual(6); // 4 + 2
    expect(est.costCny).toBeGreaterThan(0);
  });
});

describe('costControl · classifyChapterTier', () => {
  it('简单章 → c0', () => {
    const r = classifyChapterTier({ beatCount: 2, characterCount: 1, settingCount: 1 });
    expect(r.tier).toBe('c0');
  });
  it('常规章 → c1', () => {
    const r = classifyChapterTier({ beatCount: 5, characterCount: 3, settingCount: 2 });
    expect(r.tier).toBe('c1');
  });
  it('中高复杂度 → c2', () => {
    const r = classifyChapterTier({
      beatCount: 8, // +2
      characterCount: 4, // +1
      settingCount: 6, // +1 → 总分 4 → c2
    });
    expect(r.tier).toBe('c2');
  });
  it('高复杂度 → c3', () => {
    const r = classifyChapterTier({
      beatCount: 10,
      characterCount: 8,
      settingCount: 8,
      targetWordCount: 3000,
      revisionRounds: 2,
      hasComplexPlot: true,
    });
    expect(r.tier).toBe('c3');
  });
});

describe('costControl · 用量记录与汇总', () => {
  beforeEach(() => {
    mockLocalStorage();
    setBudgetConfig({ enabled: false, monthlyLimitCny: 0 });
  });

  it('addUsageRecord 落盘并可读回', () => {
    addUsageRecord({
      projectId: 'p1',
      chapterNumber: 3,
      stage: 'engine:write',
      estimatedTokens: 1200,
      estimatedCostCny: 0.05,
      promptChars: 100,
      completionChars: 500,
      ok: true,
    });
    const records = loadUsageRecords();
    expect(records).toHaveLength(1);
    expect(records[0].stage).toBe('engine:write');
    expect(records[0].chapterNumber).toBe(3);
  });

  it('getUsageSummary 按今日/本月聚合', () => {
    // 用当前时间写两条（同月）
    addUsageRecord({ stage: 'a', estimatedTokens: 1000, estimatedCostCny: 0.1, promptChars: 1, completionChars: 1, ok: true });
    addUsageRecord({ stage: 'b', estimatedTokens: 2000, estimatedCostCny: 0.2, promptChars: 1, completionChars: 1, ok: true });
    const summary = getUsageSummary();
    expect(summary.month.calls).toBe(2);
    expect(summary.month.tokens).toBe(3000);
    expect(summary.month.costCny).toBeCloseTo(0.3, 5);
    // 今日必然包含刚写入的两条
    expect(summary.today.calls).toBe(2);
    expect(getMonthCostCny()).toBeCloseTo(0.3, 5);
  });

  it('历史月份不计入本月', () => {
    const store = new Map<string, string>();
    const old = JSON.stringify([
      {
        id: 'x',
        ts: '2026-06-15T10:00:00.000Z',
        stage: 'old',
        estimatedTokens: 999,
        estimatedCostCny: 9.99,
        promptChars: 1,
        completionChars: 1,
        ok: true,
      },
    ]);
    store.set('novel_studio_llm_usage_v1', old);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    });
    const summary = getUsageSummary();
    expect(summary.month.calls).toBe(0);
    expect(summary.monthKey).not.toBe('2026-06');
  });
});

describe('costControl · 预算闸门', () => {
  beforeEach(() => {
    mockLocalStorage();
    setBudgetConfig({ enabled: false, monthlyLimitCny: 0 });
  });

  it('未启用时不拦截', () => {
    expect(() => checkBudgetBeforeCall()).not.toThrow();
  });

  it('未超限时不拦截', () => {
    setBudgetConfig({ enabled: true, monthlyLimitCny: 100 });
    addUsageRecord({ stage: 'x', estimatedTokens: 100, estimatedCostCny: 5, promptChars: 1, completionChars: 1, ok: true });
    expect(() => checkBudgetBeforeCall()).not.toThrow();
  });

  it('超限时抛 BudgetExceededError', () => {
    setBudgetConfig({ enabled: true, monthlyLimitCny: 10 });
    addUsageRecord({ stage: 'x', estimatedTokens: 100, estimatedCostCny: 12, promptChars: 1, completionChars: 1, ok: true });
    try {
      checkBudgetBeforeCall();
      expect.unreachable('应抛出预算超限错误');
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect(isBudgetExceededError(err)).toBe(true);
      const e = err as BudgetExceededError;
      expect(e.usedCny).toBeCloseTo(12, 5);
      expect(e.limitCny).toBe(10);
    }
  });

  it('预算为 0 视为不限', () => {
    setBudgetConfig({ enabled: true, monthlyLimitCny: 0 });
    expect(() => checkBudgetBeforeCall()).not.toThrow();
  });
});

describe('costControl · formatUsageSummary', () => {
  it('生成可读摘要（含/不含上限）', () => {
    const summary = {
      today: { calls: 1, tokens: 100, costCny: 0.01 },
      month: { calls: 3, tokens: 500, costCny: 0.12 },
      monthKey: '2026-08',
    };
    const s1 = formatUsageSummary(summary);
    expect(s1).toContain('3 次调用');
    expect(s1).toContain('¥0.12');
    expect(s1).toContain('今日 1 次');
    const s2 = formatUsageSummary(summary, 20);
    expect(s2).toContain('上限 ¥20.00');
  });
});
