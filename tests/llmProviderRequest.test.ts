import { describe, it, expect } from 'vitest';
import {
  resolveEndpoint,
  buildProviderRequest,
  parseNonStreamResponse,
  extractStreamEvent,
  readUpstreamStreamError,
} from '../server/llmProviderRequest';

describe('llmProviderRequest · 端点解析', () => {
  it('OpenAI 兼容：根地址 / 空尾 / /v1 / 完整路径均可归一', () => {
    expect(resolveEndpoint('https://api.openai.com', 'openai')).toBe(
      'https://api.openai.com/v1/chat/completions'
    );
    expect(resolveEndpoint('https://api.deepseek.com/', 'deepseek')).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    );
    expect(resolveEndpoint('https://x.example.com/v1', 'custom')).toBe(
      'https://x.example.com/v1/chat/completions'
    );
    expect(resolveEndpoint('https://x.example.com/v1/chat/completions', 'custom')).toBe(
      'https://x.example.com/v1/chat/completions'
    );
  });

  it('Anthropic：根地址 / /v1 / 完整路径归一到 /v1/messages', () => {
    expect(resolveEndpoint('https://api.anthropic.com', 'anthropic')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(resolveEndpoint('https://api.anthropic.com/v1/', 'anthropic')).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(resolveEndpoint('https://gw.example.com/v1/messages', 'anthropic')).toBe(
      'https://gw.example.com/v1/messages'
    );
  });
});

describe('llmProviderRequest · 请求构建', () => {
  const baseInput = {
    baseURL: 'https://api.example.com',
    model: 'test-model',
    messages: [
      { role: 'system', content: '你是小说编辑' },
      { role: 'user', content: '写一段' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '继续' },
    ],
    temperature: 0.7,
    maxTokens: 4096,
    stream: true,
  };

  it('Anthropic：x-api-key + anthropic-version 头，system 提到顶层，messages 仅 user/assistant', () => {
    const r = buildProviderRequest({ ...baseInput, provider: 'anthropic', apiKey: 'sk-ant-1' });
    expect(r.endpoint).toBe('https://api.example.com/v1/messages');
    expect(r.headers['x-api-key']).toBe('sk-ant-1');
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    expect(r.headers.Authorization).toBeUndefined();
    expect(r.payload.system).toBe('你是小说编辑');
    expect(r.payload.messages).toEqual([
      { role: 'user', content: '写一段' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '继续' },
    ]);
    expect(r.payload.max_tokens).toBe(4096);
  });

  it('Anthropic：无 system 消息时不发 system 字段', () => {
    const r = buildProviderRequest({
      ...baseInput,
      provider: 'anthropic',
      apiKey: 'k',
      messages: [{ role: 'user', content: '你好' }],
    });
    expect('system' in r.payload).toBe(false);
  });

  it('OpenAI 系：Bearer 头 + 原样 messages + max_tokens', () => {
    const r = buildProviderRequest({ ...baseInput, provider: 'deepseek', apiKey: 'sk-1' });
    expect(r.endpoint).toBe('https://api.example.com/v1/chat/completions');
    expect(r.headers.Authorization).toBe('Bearer sk-1');
    expect(r.headers['x-api-key']).toBeUndefined();
    expect(r.payload.messages).toEqual(baseInput.messages);
    expect(r.payload.max_tokens).toBe(4096);
  });

  it('本地服务：Key 为空时不带 Authorization 头', () => {
    const r = buildProviderRequest({ ...baseInput, provider: 'local', apiKey: '' });
    expect(r.headers.Authorization).toBeUndefined();
    expect(r.endpoint).toBe('https://api.example.com/v1/chat/completions');
  });
});

describe('llmProviderRequest · 响应解析', () => {
  it('Anthropic 非流式：拼接 text 块，stop_reason=max_tokens 对齐为 length', () => {
    const r = parseNonStreamResponse('anthropic', {
      content: [
        { type: 'text', text: '第一段' },
        { type: 'tool_use', id: 't1' },
        { type: 'text', text: '第二段' },
      ],
      stop_reason: 'max_tokens',
    });
    expect(r.text).toBe('第一段第二段');
    expect(r.finishReason).toBe('length');
  });

  it('Anthropic 非流式：end_turn 保持原样', () => {
    const r = parseNonStreamResponse('anthropic', {
      content: [{ type: 'text', text: '完' }],
      stop_reason: 'end_turn',
    });
    expect(r.finishReason).toBe('end_turn');
  });

  it('OpenAI 系非流式：choices.message.content', () => {
    const r = parseNonStreamResponse('openai', {
      choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
    });
    expect(r.text).toBe('正文');
    expect(r.finishReason).toBe('stop');
  });

  it('流式：OpenAI delta 帧', () => {
    const r = extractStreamEvent({ choices: [{ delta: { content: '续' } }] });
    expect(r.chunk).toBe('续');
    expect(r.finishReason).toBeUndefined();
  });

  it('流式：Anthropic content_block_delta 与 message_delta', () => {
    expect(extractStreamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: '段' } }).chunk).toBe('段');
    expect(
      extractStreamEvent({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }).finishReason
    ).toBe('length');
    expect(
      extractStreamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }).finishReason
    ).toBe('end_turn');
  });

  it('流式：ping / 未知帧返回空增量不抛错', () => {
    expect(extractStreamEvent({ type: 'ping' })).toEqual({ chunk: '', reasoning: '', finishReason: undefined });
    expect(extractStreamEvent({})).toEqual({ chunk: '', reasoning: '', finishReason: undefined });
  });

  it('流式：错误帧（Anthropic event:error / OpenAI error 对象）被识别并可构造上抛错误', () => {
    const anthropic = readUpstreamStreamError({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    expect(anthropic).toBeInstanceOf(Error);
    expect(anthropic!.message).toContain('Overloaded');
    const openai = readUpstreamStreamError({ error: { message: 'rate limit exceeded' } });
    expect(openai).toBeInstanceOf(Error);
    expect(openai!.message).toContain('rate limit');
    const str = readUpstreamStreamError({ error: 'quota exhausted' });
    expect(str!.message).toContain('quota exhausted');
    // 普通帧 → null
    expect(readUpstreamStreamError({ choices: [{ delta: { content: 'x' } }] })).toBeNull();
    expect(readUpstreamStreamError({})).toBeNull();
  });

  it('流式：OpenAI 系思考模型 delta.reasoning_content 单独透出，不计入正文', () => {
    const r = extractStreamEvent({ choices: [{ delta: { reasoning_content: '用户想要…' } }] });
    expect(r.reasoning).toBe('用户想要…');
    expect(r.chunk).toBe('');
    // 部分网关用 reasoning 字段
    expect(extractStreamEvent({ choices: [{ delta: { reasoning: '推理中' } }] }).reasoning).toBe('推理中');
    // 正文与思考同帧到达时两者都保留
    const both = extractStreamEvent({ choices: [{ delta: { content: '答', reasoning_content: '想' } }] });
    expect(both.chunk).toBe('答');
    expect(both.reasoning).toBe('想');
  });

  it('流式：Anthropic thinking_delta 透出思考增量', () => {
    const r = extractStreamEvent({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先想一下' } });
    expect(r.reasoning).toBe('先想一下');
    expect(r.chunk).toBe('');
  });
});
