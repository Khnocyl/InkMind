import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearLlmTrace,
  getLlmTraceEntries,
  recordLlmCall,
  subscribeLlmTrace,
} from '../src/services/llmTrace';
import { generateJSON, generateText } from '../src/services/llmClient';

afterEach(() => {
  vi.unstubAllGlobals();
  clearLlmTrace();
});

function okFetch(content: string, status = 200) {
  return vi.fn(async () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ success: status < 300, content }),
      text: async () => '',
    } as unknown as Response)
  );
}

describe('llmTrace · 环形缓冲与订阅', () => {
  it('record 后可读取（最新在前），超上限丢最旧', () => {
    clearLlmTrace();
    for (let i = 0; i < 45; i += 1) {
      recordLlmCall({
        kind: 'text',
        messages: [{ role: 'user', content: `m${i}` }],
        response: `r${i}`,
        ok: true,
        durationMs: 1,
      });
    }
    const entries = getLlmTraceEntries();
    expect(entries).toHaveLength(40);
    expect(entries[0].response).toBe('r44');
    expect(entries[39].response).toBe('r5');
  });

  it('subscribe 在 record/clear 时被通知，退订后不再通知', () => {
    clearLlmTrace();
    let calls = 0;
    const unsub = subscribeLlmTrace(() => {
      calls += 1;
    });
    recordLlmCall({
      kind: 'text',
      messages: [],
      response: 'x',
      ok: true,
      durationMs: 1,
    });
    clearLlmTrace();
    expect(calls).toBe(2);
    unsub();
    recordLlmCall({
      kind: 'text',
      messages: [],
      response: 'y',
      ok: true,
      durationMs: 1,
    });
    expect(calls).toBe(2);
  });
});

describe('llmTrace · llmClient 埋点', () => {
  it('generateJSON 成功 → 记录 kind=json、响应原文、修复策略', async () => {
    clearLlmTrace();
    vi.stubGlobal('fetch', okFetch('```json\n{"a":1}\n```'));
    await generateJSON([{ role: 'user', content: 'hi' }], 0.7);
    const entries = getLlmTraceEntries();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.kind).toBe('json');
    expect(e.ok).toBe(true);
    expect(e.response).toContain('"a":1');
    expect(e.strategy).toBe('fence-strip');
    expect(e.messages[0].content).toBe('hi');
  });

  it('generateJSON 失败 → ok:false 且带错误信息', async () => {
    clearLlmTrace();
    // 纯垃圾文本（无任何 JSON 结构，修复链无能为力）
    vi.stubGlobal('fetch', okFetch('这不是JSON，只是普通中文段落。'));
    await expect(
      generateJSON([{ role: 'user', content: 'hi' }], 0.7, { maxRetries: 0 })
    ).rejects.toThrow();
    const entries = getLlmTraceEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].ok).toBe(false);
    expect(entries[0].error).toBeTruthy();
    expect(entries[0].response).toContain('这不是JSON');
  });

  it('generateText 成功 → 记录 kind=text 与响应', async () => {
    clearLlmTrace();
    vi.stubGlobal('fetch', okFetch('正文内容'));
    await generateText([{ role: 'user', content: 'q' }], 0.7);
    const entries = getLlmTraceEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('text');
    expect(entries[0].response).toBe('正文内容');
    expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
