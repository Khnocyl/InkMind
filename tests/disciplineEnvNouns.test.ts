import { describe, it, expect } from 'vitest';
import { envNounCount } from '../src/engine/discipline';

describe('envNounCount 环境名词计数', () => {
  it('子串不重复计数：「月光」不再叠加「月」', () => {
    // 月光/窗/门 = 3（旧实现把 月光+月+窗+门 算成 4，正常开篇被误判堆砌）
    expect(envNounCount('月光洒落窗前，门还开着。')).toBe(3);
  });

  it('同一词多处出现只计 1（按种类计数）', () => {
    expect(envNounCount('山外有山，河水绕着山流转。')).toBe(2);
  });

  it('长词优先：雪原 命中后不再计 雪', () => {
    expect(envNounCount('雪原上落着细雪。')).toBe(1);
  });

  it('无环境名词时为 0，正常句子不高估', () => {
    expect(envNounCount('他一拳砸在桌上，账单飞了出去。')).toBe(0);
    expect(envNounCount('')).toBe(0);
  });
});
