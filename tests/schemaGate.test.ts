import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateJSON,
  isSchemaMismatchError,
  SchemaMismatchError,
} from '../src/services/llmClient';
import {
  isRetryableError,
} from '../src/services/llmResilience';
import {
  getSalvageStats,
  resetSalvageStats,
  salvageJsonParse,
} from '../src/services/jsonRepair';
import {
  makeChapterBatchValidator,
  validateVolumesDraft,
} from '../src/services/outlineGenerate';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 依次返回预设 content 的 fetch mock，并记录每次请求体 */
function mockFetchSequence(contents: string[]) {
  const bodies: Array<{ messages?: unknown[] }> = [];
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const idx = Math.min(bodies.length, contents.length - 1);
    bodies.push(JSON.parse(String(init?.body || '{}')));
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, content: contents[idx] }),
      text: async () => '',
      body: null,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { fn, bodies };
}

describe('schemaGate · SchemaMismatchError 分类', () => {
  it('isRetryableError 视为可重试', () => {
    expect(isRetryableError(new SchemaMismatchError('缺章'))).toBe(true);
  });

  it('isSchemaMismatchError 识别类型与同名错误对象', () => {
    expect(isSchemaMismatchError(new SchemaMismatchError('x'))).toBe(true);
    const named = new Error('y');
    named.name = 'SchemaMismatchError';
    expect(isSchemaMismatchError(named)).toBe(true);
    expect(isSchemaMismatchError(new Error('普通错误'))).toBe(false);
    expect(isSchemaMismatchError(null)).toBe(false);
  });
});

describe('schemaGate · generateJSON 校验闸门集成', () => {
  it('校验通过 → 单次请求成功', async () => {
    const { fn, bodies } = mockFetchSequence(['{"a":1}']);
    const data = await generateJSON<{ a: number }>(
      [{ role: 'user', content: 'q' }],
      0.7,
      { validate: (v) => (v.a === 1 ? null : 'a 不为 1') }
    );
    expect(data).toEqual({ a: 1 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(bodies[0].messages).toHaveLength(1);
  });

  it('首答校验失败 → 第二次请求带上回显与修正指令，成功收尾', async () => {
    const { fn, bodies } = mockFetchSequence([
      '{"chapters": []}',
      '{"chapters": [{"number": 1, "summary": "ok"}]}',
    ]);
    let calls = 0;
    const data = await generateJSON<{ chapters: unknown[] }>(
      [{ role: 'user', content: '拆章' }],
      0.7,
      {
        maxRetries: 1,
        validate: (v) =>
          Array.isArray(v.chapters) && v.chapters.length > 0
            ? null
            : 'chapters 缺失或为空',
      }
    ).then((r) => {
      calls += 1;
      return r;
    });
    void calls;
    expect(data.chapters).toEqual([{ number: 1, summary: 'ok' }]);
    expect(fn).toHaveBeenCalledTimes(2);
    // 第二次请求：原消息 + assistant 回显 + user 修正指令
    const msgs = bodies[1].messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: 'user', content: '拆章' });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toContain('"chapters": []');
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].content).toContain('chapters 缺失或为空');
    expect(msgs[2].content).toContain('\\"');
  });

  it('重试耗尽仍不合格 → 抛 SchemaMismatchError', async () => {
    const { fn } = mockFetchSequence(['{}']);
    await expect(
      generateJSON<Record<string, never>>(
        [{ role: 'user', content: 'q' }],
        0.7,
        {
          maxRetries: 1,
          validate: () => '始终不合格',
        }
      )
    ).rejects.toBeInstanceOf(SchemaMismatchError);
    expect(fn).toHaveBeenCalledTimes(2); // 原始 + 反馈重试各 1 次
  });

  it('超长原始输出回显被截断到上限', async () => {
    const longRaw = `{"pad":"${'x'.repeat(3000)}"}`;
    const { bodies } = mockFetchSequence([longRaw, '{"a":1}']);
    await generateJSON<{ a: number }>([{ role: 'user', content: 'q' }], 0.7, {
      maxRetries: 1,
      validate: (v) => ('a' in v ? null : '缺少 a'),
    });
    const msgs = bodies[1].messages as Array<{ role: string; content: string }>;
    expect(msgs[1].content).toContain('原文过长已截断');
    expect(msgs[1].content.length).toBeLessThan(longRaw.length);
  });
});

describe('schemaGate · salvage 命中埋点', () => {
  it('direct / repaired(byStrategy) / failures 分别计数', () => {
    resetSalvageStats();
    salvageJsonParse('{"a":1}');
    salvageJsonParse('{"recap": "说"你"好"}');
    salvageJsonParse('not json');
    const stats = getSalvageStats();
    expect(stats.direct).toBe(1);
    expect(stats.repaired).toBe(1);
    expect(stats.byStrategy['inner-quote-escape']).toBe(1);
    expect(stats.failures).toBe(1);
  });

  it('resetSalvageStats 归零且深拷贝快照不受后续影响', () => {
    resetSalvageStats();
    salvageJsonParse('[1,]');
    const snapshot = getSalvageStats();
    expect(snapshot.repaired).toBe(1);
    resetSalvageStats();
    expect(getSalvageStats().repaired).toBe(0);
    snapshot.byStrategy['trailing-comma'] = 999;
    expect(getSalvageStats().byStrategy['trailing-comma']).toBeUndefined();
  });
});

describe('schemaGate · outlineGenerate 校验器', () => {
  it('validateVolumesDraft：缺失/空 volumes 报错，正常放行', () => {
    expect(validateVolumesDraft({})).toBe('缺少 volumes 数组或为空');
    expect(validateVolumesDraft({ volumes: [] })).toBe('缺少 volumes 数组或为空');
    expect(validateVolumesDraft(null)).toBe('缺少 volumes 数组或为空');
    expect(validateVolumesDraft({ volumes: [{ number: 1 }] })).toBeNull();
  });

  const v5 = makeChapterBatchValidator(1, 5);

  it('空 chapters / 全部越界 → 报错', () => {
    expect(v5({})).toContain('chapters 缺失或为空');
    expect(v5({ chapters: [] })).toContain('chapters 缺失或为空');
    expect(v5({ chapters: [{ number: 99, title: '越界' }] })).toContain('无有效内容');
  });

  it('覆盖率 ≥60% 放行，<60% 报缺章明细（疑似截断）', () => {
    // 3/5 = 60% → 通过
    expect(
      v5({
        chapters: [
          { number: 1, title: '一' },
          { number: 2, title: '二' },
          { number: 3, title: '三' },
        ],
      })
    ).toBeNull();
    // 2/5 = 40% → 报错并给出缺失样例
    const err = v5({
      chapters: [
        { number: 1, title: '一' },
        { number: 2, title: '二' },
      ],
    }) as string;
    expect(err).toContain('章节覆盖不足');
    expect(err).toContain('仅 2/5 章');
    expect(err).toContain('第 3、4、5 章');
  });

  it('number 缺失或非数字、title/summary 全空的条目不计入覆盖', () => {
    const err = v5({
      chapters: [
        { title: '无编号' },
        { number: 'abc', summary: '非数字编号' },
        { number: 1 },
        { number: 2, title: '  ' },
        { number: 3, summary: '达标摘要' },
      ],
    }) as string;
    expect(err).toContain('章节覆盖不足');
    expect(err).toContain('仅 1/5 章');
  });
});
