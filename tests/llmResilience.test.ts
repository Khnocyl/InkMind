import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backoffDelayMs,
  fetchWithTimeout,
  isRetryableError,
  TimeoutError,
  withRetry,
} from '../src/services/llmResilience';
import {
  generateJSON,
  generateStream,
  generateText,
  setActiveUsageContext,
  setBudgetConfig,
} from '../src/services/llmClient';
import {
  addUsageRecord,
  BudgetExceededError,
  loadUsageRecords,
} from '../src/services/costControl';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 构造 SSE 流的 Response mock */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
    text: async () => '',
    json: async () => ({}),
  } as unknown as Response;
}

function jsonResponse(content: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => `{"success":${status < 300}, "content": ${JSON.stringify(content)}}`,
    json: async () => ({ success: status < 300, content }),
    body: null,
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    text: async () => 'server error',
    json: async () => ({ success: false, error: 'server error' }),
    body: null,
  } as unknown as Response;
}

describe('llmResilience · 基础判定', () => {
  it('网络错误 / 超时 / 429 / 5xx 可重试', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(new TimeoutError(1000))).toBe(true);
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 502 })).toBe(true);
  });

  it('4xx（除 429）与业务错误不可重试', () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 401 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError(new Error('AI 生成请求失败'))).toBe(false);
  });

  it('退避单调递增且 ≥ 1ms', () => {
    const d1 = backoffDelayMs(600, 1);
    const d2 = backoffDelayMs(600, 2);
    const d3 = backoffDelayMs(600, 3);
    expect(d1).toBeGreaterThanOrEqual(1);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });
});

describe('llmResilience · withRetry', () => {
  it('可重试错误 → 重试后成功（fn 调用 2 次）', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, { retryDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('重试耗尽 → 抛出最终错误（fn 调用 maxRetries+1 次）', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new TypeError('fetch failed'));
    await expect(withRetry(fn, { maxRetries: 2, retryDelayMs: 1 })).rejects.toThrow(
      'fetch failed'
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('不可重试错误 → 不重试，立即抛出', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue({ status: 400 });
    await expect(withRetry(fn, { retryDelayMs: 1 })).rejects.toMatchObject({
      status: 400,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('llmResilience · fetchWithTimeout', () => {
  it('超时 → 抛 TimeoutError 且可重试', async () => {
    // 模拟真实 fetch：abort 时 reject AbortError（never-resolve 的 promise 不会理会 signal）
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
      )
    );
    await expect(
      fetchWithTimeout('/api/llm/generate', { method: 'POST' }, 30)
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('正常返回透传', async () => {
    const mock = vi.fn(async () => jsonResponse('hello'));
    vi.stubGlobal('fetch', mock);
    const res = await fetchWithTimeout('/api/llm/generate', undefined, 1000);
    expect(res.ok).toBe(true);
  });
});

describe('llmClient · generateText 重试集成', () => {
  it('500 → 200：自动重试成功', async () => {
    const mock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(jsonResponse('正文'));
    vi.stubGlobal('fetch', mock);
    const text = await generateText(
      [{ role: 'user', content: 'hi' }],
      0.7,
      { retryDelayMs: 1 }
    );
    expect(text).toBe('正文');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('400 → 不重试，直接抛错', async () => {
    const mock = vi.fn(async () => errorResponse(400));
    vi.stubGlobal('fetch', mock);
    await expect(
      generateText([{ role: 'user', content: 'hi' }], 0.7, { retryDelayMs: 1 })
    ).rejects.toThrow(/400/);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('llmClient · generateJSON 重试集成', () => {
  it('网络错误 → 重试后成功解析 JSON', async () => {
    const mock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse('{"a":1}'));
    vi.stubGlobal('fetch', mock);
    const data = await generateJSON<{ a: number }>(
      [{ role: 'user', content: 'json' }],
      0.7,
      { retryDelayMs: 1 }
    );
    expect(data).toEqual({ a: 1 });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('fenced JSON 仍可解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('```json\n{"b":2}\n```'))
    );
    const data = await generateJSON<{ b: number }>(
      [{ role: 'user', content: 'json' }],
      0.7
    );
    expect(data).toEqual({ b: 2 });
  });
});

describe('llmClient · generateStream 中断恢复', () => {
  it('首个字节前失败 → 整体重试（fetch 调用 2 次）', async () => {
    const mock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(
        sseResponse([
          'data: {"chunk":"你"}\n\ndata: {"chunk":"好"}\n\ndata: [DONE]\n\n',
        ])
      );
    vi.stubGlobal('fetch', mock);
    const progress: string[] = [];
    const text = await generateStream(
      [{ role: 'user', content: 'hi' }],
      0.7,
      undefined,
      (m) => progress.push(m),
      { retryDelayMs: 1 }
    );
    expect(text).toBe('你好');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(progress.some((p) => p.includes('重连'))).toBe(true);
  });

  it('流中途断开（已有产出）→ 返回部分内容，不再重试', async () => {
    // 第一个流：产出「甲」「乙」后 socket 断开（已产出 > 0 → 不重试）
    let partialPulls = 0;
    const enc = new TextEncoder();
    const partialStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"chunk":"甲"}\n\n'));
      },
      pull(controller) {
        partialPulls += 1;
        if (partialPulls === 1) {
          controller.enqueue(enc.encode('data: {"chunk":"乙"}\n\n'));
        } else {
          controller.error(new Error('socket hang up'));
        }
      },
    });
    const mock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: partialStream,
      text: async () => '',
    }) as unknown as Response);
    vi.stubGlobal('fetch', mock);
    const text = await generateStream(
      [{ role: 'user', content: 'hi' }],
      0.7,
      undefined,
      undefined,
      { retryDelayMs: 1 }
    );
    // 已产出「甲乙」→ 返回全部已有内容，不重试
    expect(text).toBe('甲乙');
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe('llmClient · R3-B 预算闸门与用量记录', () => {
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
    return storage;
  }

  function okFetch(content: string) {
    return vi.fn(async () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, content }),
        text: async () => '',
      } as unknown as Response)
    );
  }

  beforeEach(() => {
    mockLocalStorage();
    setBudgetConfig({ enabled: false, monthlyLimitCny: 0 });
    setActiveUsageContext(undefined);
  });

  it('预算超限 → 抛 BudgetExceededError 且不发起请求', async () => {
    setBudgetConfig({ enabled: true, monthlyLimitCny: 0.001 });
    // 先塞一条已超限记录
    addUsageRecord({ stage: 'pre', estimatedTokens: 100, estimatedCostCny: 1, promptChars: 1, completionChars: 1, ok: true });
    const mock = okFetch('你好');
    vi.stubGlobal('fetch', mock);
    await expect(
      generateText([{ role: 'user', content: 'hi' }], 0.7, { retryDelayMs: 1 })
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(mock).not.toHaveBeenCalled();
  });

  it('成功调用 + 传 usage → 记录一条 ok:true 用量', async () => {
    vi.stubGlobal('fetch', okFetch('你好世界'));
    const text = await generateText([{ role: 'user', content: '开始写作' }], 0.7, {
      usage: { projectId: 'p1', chapterNumber: 2, stage: 'engine:write', model: 'deepseek-chat' },
    });
    expect(text).toBe('你好世界');
    const records = loadUsageRecords();
    expect(records).toHaveLength(1);
    expect(records[0].ok).toBe(true);
    expect(records[0].stage).toBe('engine:write');
    expect(records[0].projectId).toBe('p1');
    expect(records[0].estimatedTokens).toBeGreaterThan(0);
  });

  it('活动上下文（setActiveUsageContext）自动归属', async () => {
    vi.stubGlobal('fetch', okFetch('测试内容'));
    setActiveUsageContext({ projectId: 'p9', chapterNumber: 5, stage: 'engine:audit' });
    await generateText([{ role: 'user', content: '审校正文' }], 0.7);
    const records = loadUsageRecords();
    expect(records).toHaveLength(1);
    expect(records[0].stage).toBe('engine:audit');
    expect(records[0].chapterNumber).toBe(5);
    // 清空上下文后调用不再记录
    setActiveUsageContext(undefined);
    await generateText([{ role: 'user', content: '外部调用' }], 0.7);
    expect(loadUsageRecords()).toHaveLength(1);
  });

  it('传 options.model → 请求体包含 model 覆盖且用量按实际模型估算', async () => {
    let sentBody: any = null;
    const mock = vi.fn(async (url: string, init?: any) => {
      sentBody = JSON.parse(init?.body || '{}');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, content: '{"ok":true}' }),
        text: async () => '',
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', mock);
    await generateJSON(
      [{ role: 'user', content: 'hi' }],
      0.7,
      { model: 'deepseek-chat', usage: { stage: 'engine:beat' } }
    );
    expect(sentBody.model).toBe('deepseek-chat');
    const records = loadUsageRecords();
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe('deepseek-chat');
  });

  it('不传 model → 请求体不含 model 字段（后端用激活配置档）', async () => {
    let sentBody: any = null;
    const mock = vi.fn(async (url: string, init?: any) => {
      sentBody = JSON.parse(init?.body || '{}');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, content: '{"ok":true}' }),
        text: async () => '',
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', mock);
    await generateJSON([{ role: 'user', content: 'hi' }], 0.7);
    expect('model' in sentBody).toBe(false);
  });
});
