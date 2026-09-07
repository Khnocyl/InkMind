/**
 * 按 provider 构建上游 LLM 请求与解析响应的纯函数（无 fs/网络副作用，便于单测）。
 *
 * 两种协议形态：
 * - OpenAI 兼容（openai / deepseek / custom / local）：POST {base}/v1/chat/completions，
 *   Authorization: Bearer，choices[].delta.content 流式增量；
 * - Anthropic Messages（anthropic）：POST {base}/v1/messages，x-api-key +
 *   anthropic-version 头，system 提示词放顶层字段，messages 仅 user/assistant，
 *   content_block_delta.text_delta 流式增量，stop_reason 对齐 OpenAI 语义
 *   （max_tokens → length）。
 */

export type ChatProvider = 'openai' | 'deepseek' | 'custom' | 'anthropic' | 'local';

export interface ChatMessage {
  role: string;
  content: string;
}

export const ANTHROPIC_VERSION = '2023-06-01';

/** 上游流中错误帧（Anthropic event:error / OpenAI error 对象）→ 中断消费、上抛走降级链 */
export class UpstreamStreamError extends Error {
  constructor(message: string) {
    super(`上游流式响应错误: ${message}`);
    this.name = 'UpstreamStreamError';
  }
}

/** 把用户填写的 Base URL 归一成对应协议的完整请求端点 */
export function resolveEndpoint(baseURL: string, provider: ChatProvider): string {
  const base = (baseURL || '').replace(/\/+$/, '');
  if (provider === 'anthropic') {
    if (/\/v1\/messages$/i.test(base) || /\/messages$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (/\/v1\/chat\/completions$/i.test(base) || /\/chat\/completions$/i.test(base)) {
    return base;
  }
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export interface BuildRequestInput {
  provider: ChatProvider;
  baseURL: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  stream: boolean;
  apiKey: string;
}

export interface BuiltRequest {
  endpoint: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

/**
 * 构建上游请求。注意：customHeaders 的合并与危险头过滤由调用方
 * （llmService.buildSafeHeaders）负责——这里只产出受保护头。
 */
export function buildProviderRequest(input: BuildRequestInput): BuiltRequest {
  const { provider, baseURL, model, messages, temperature, maxTokens, stream, apiKey } = input;
  const endpoint = resolveEndpoint(baseURL, provider);
  const isAnthropic = provider === 'anthropic';

  let payload: Record<string, unknown>;
  if (isAnthropic) {
    // system 提示词提到顶层字段；messages 仅保留 user/assistant（Anthropic 规范）
    const systemParts: string[] = [];
    const chatMessages = messages.filter((m) => {
      if (m.role === 'system') {
        systemParts.push(m.content);
        return false;
      }
      return m.role === 'user' || m.role === 'assistant';
    });
    payload = {
      model,
      max_tokens: maxTokens,
      temperature,
      stream,
      messages: chatMessages,
    };
    if (systemParts.length) {
      payload.system = systemParts.join('\n\n');
    }
  } else {
    payload = { model, messages, temperature, stream, max_tokens: maxTokens };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isAnthropic) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  } else if (apiKey) {
    // 本地服务等允许空 Key：无 Key 时不带 Authorization，避免空 Bearer 干扰网关
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return { endpoint, headers, payload };
}

export interface ParsedChatResult {
  text: string;
  /** 对齐 OpenAI 语义：length 表示被 max_tokens 截断 */
  finishReason?: string;
}

/** 解析非流式响应体（按 provider 识别形态，未知形态回退 OpenAI 结构） */
export function parseNonStreamResponse(provider: ChatProvider, data: any): ParsedChatResult {
  // Anthropic：content 是文本块数组，stop_reason 对齐到 OpenAI 语义
  if (provider === 'anthropic' || Array.isArray(data?.content)) {
    const text = (data.content as any[])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return {
      text,
      finishReason:
        data.stop_reason === 'max_tokens' ? 'length' : (data.stop_reason || undefined),
    };
  }
  return {
    text: data?.choices?.[0]?.message?.content || '',
    finishReason: data?.choices?.[0]?.finish_reason || undefined,
  };
}

export interface StreamEventResult {
  /** 正文增量（OpenAI delta.content / Anthropic text_delta） */
  chunk: string;
  /** 思考过程增量（推理模型：reasoning_content / Anthropic thinking_delta），可为空 */
  reasoning: string;
  finishReason?: string;
}

/** 从错误帧提取一句可读错误（对象/字符串形态兼容，截断防刷屏） */
function readErrorFrame(parsed: any): string {
  const e = parsed?.error;
  if (typeof e === 'string' && e) return e.slice(0, 300);
  const m = e?.message || e?.type || '';
  return String(m || JSON.stringify(e)).slice(0, 300);
}

/** 把错误帧包装成 UpstreamStreamError（非错误帧返回 null） */
export function readUpstreamStreamError(parsed: any): UpstreamStreamError | null {
  if (parsed?.type === 'error' || parsed?.error) {
    return new UpstreamStreamError(readErrorFrame(parsed));
  }
  return null;
}

/**
 * 解析流式 SSE 的单个 data: JSON 帧（两种协议形态自适应）。
 * 无法识别的帧（ping、注释、未知事件）返回空增量。
 * 思考模型支持：推理模型的思考增量（delta.reasoning_content / delta.reasoning /
 * Anthropic thinking_delta）单独透出，供 UI 展示「思考中」进度，不计入正文。
 */
export function extractStreamEvent(parsed: any): StreamEventResult {
  let chunk = parsed?.choices?.[0]?.delta?.content || '';
  let reasoning = '';
  let finishReason: string | undefined;
  if (parsed?.choices?.[0]?.finish_reason) {
    finishReason = parsed.choices[0].finish_reason;
  }
  // OpenAI 系推理模型的思考增量（DeepSeek-R1 / GLM / MiniMax 等用 reasoning_content，
  // 部分网关用 reasoning）
  const delta = parsed?.choices?.[0]?.delta;
  if (delta && typeof delta === 'object') {
    const r = delta.reasoning_content ?? delta.reasoning;
    if (typeof r === 'string' && r) reasoning = r;
  }
  // Anthropic：content_block_delta 携带正文/思考增量，message_delta 携带 stop_reason
  if (parsed?.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
    if (!chunk) chunk = parsed.delta.text || '';
  }
  if (parsed?.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') {
    if (typeof parsed.delta.thinking === 'string' && parsed.delta.thinking) {
      reasoning = parsed.delta.thinking;
    }
  }
  if (parsed?.type === 'message_delta' && parsed.delta?.stop_reason) {
    finishReason =
      parsed.delta.stop_reason === 'max_tokens' ? 'length' : parsed.delta.stop_reason;
  }
  return { chunk, reasoning, finishReason };
}
