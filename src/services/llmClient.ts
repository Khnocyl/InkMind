import {
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  withRetry,
  type RetryOptions,
} from './llmResilience';
import {
  addUsageRecord,
  checkBudgetBeforeCall,
  estimateUsageCost,
  getActiveUsageContext,
  type LlmTier,
} from './costControl';

// R3-B：预算配置由应用层在项目加载/设置变更时注入（见 useChapterPipeline）
export { setBudgetConfig, getBudgetConfig } from './costControl';
export { isBudgetExceededError, setActiveUsageContext } from './costControl';

export interface LLMProfilePublic {
  id: string;
  name: string;
  provider: string;
  baseURL: string;
  modelName: string;
  temperature: number;
  hasKey: boolean;
  maskedKey: string;
  isActive: boolean;
  updatedAt?: string;
}

export interface BackendLLMConfig {
  provider: 'openai' | 'deepseek' | 'custom';
  baseURL: string;
  modelName: string;
  temperature: number;
  hasKey: boolean;
  maskedKey: string;
  customHeaders?: Record<string, string>;
  activeProfileId?: string;
  activeProfileName?: string;
  profiles?: LLMProfilePublic[];
}

export interface EmbeddingConfigPublic {
  enabled: boolean;
  useSameAsLlm: boolean;
  baseURL: string;
  modelName: string;
  dimensions: number | null;
  hasKey: boolean;
  maskedKey: string;
  resolvedBaseURL: string;
  resolvedHasKey: boolean;
}

export async function getLLMConfig(): Promise<BackendLLMConfig> {
  try {
    const res = await fetch('/api/config/llm');
    const data = await res.json();
    if (data.success) {
      return data.data;
    }
    throw new Error(data.error || '获取 LLM 配置失败');
  } catch (err: any) {
    console.error('Failed to get LLM config:', err);
    return {
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      modelName: 'deepseek-chat',
      temperature: 0.7,
      hasKey: false,
      maskedKey: '',
      profiles: [],
    };
  }
}

export async function saveLLMConfig(config: {
  provider: string;
  baseURL: string;
  modelName: string;
  temperature: number;
  apiKey?: string;
  customHeaders?: Record<string, string>;
  name?: string;
}): Promise<BackendLLMConfig> {
  const res = await fetch('/api/config/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (data.success) {
    return data.data;
  }
  throw new Error(data.error || '保存 LLM 配置失败');
}

export async function listLLMProfiles(): Promise<{
  activeProfileId: string;
  profiles: LLMProfilePublic[];
}> {
  const res = await fetch('/api/config/llm/profiles');
  const data = await res.json();
  if (data.success) return data.data;
  throw new Error(data.error || '获取模型配置档失败');
}

export async function upsertLLMProfile(input: {
  id?: string;
  name: string;
  provider?: string;
  baseURL: string;
  modelName: string;
  temperature?: number;
  apiKey?: string;
  activate?: boolean;
}): Promise<{ activeProfileId: string; profiles: LLMProfilePublic[] }> {
  const res = await fetch('/api/config/llm/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (data.success) return data.data;
  throw new Error(data.error || '保存配置档失败');
}

export async function activateLLMProfile(
  id: string
): Promise<{ activeProfileId: string; profiles: LLMProfilePublic[] }> {
  const res = await fetch(`/api/config/llm/profiles/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
  });
  const data = await res.json();
  if (data.success) return data.data;
  throw new Error(data.error || '启用配置档失败');
}

export async function deleteLLMProfile(
  id: string
): Promise<{ activeProfileId: string; profiles: LLMProfilePublic[] }> {
  const res = await fetch(`/api/config/llm/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const data = await res.json();
  if (data.success) return data.data;
  throw new Error(data.error || '删除配置档失败');
}

export async function getEmbeddingConfig(): Promise<EmbeddingConfigPublic> {
  const res = await fetch('/api/config/embedding');
  const data = await res.json();
  if (data.success) return data.data;
  throw new Error(data.error || '获取向量配置失败');
}

export async function saveEmbeddingConfigApi(input: {
  enabled?: boolean;
  useSameAsLlm?: boolean;
  baseURL?: string;
  modelName?: string;
  dimensions?: number | null;
  apiKey?: string;
}): Promise<EmbeddingConfigPublic> {
  const res = await fetch('/api/config/embedding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (data.success) return data.data;
  throw new Error(data.error || '保存向量配置失败');
}

export async function testEmbeddingApi(): Promise<{
  ok: boolean;
  model: string;
  dimensions: number;
  latencyMs: number;
  sampleNorm: number;
}> {
  const res = await fetch('/api/embedding/test', { method: 'POST' });
  const data = await res.json();
  if (data.success) return data.data;
  throw new Error(data.error || 'Embedding 测试失败');
}

export interface LLMModelInfo {
  id: string;
  owned_by?: string;
  created?: number;
}

export interface FetchLLMModelsResult {
  models: LLMModelInfo[];
  count: number;
  endpoint: string;
}

/**
 * 从服务商刷新可用模型名称列表。
 * 可传入表单中尚未保存的 baseURL / apiKey（掩码 Key 会被服务端忽略，改用已存密钥）。
 */
export async function fetchLLMModels(options?: {
  baseURL?: string;
  apiKey?: string;
}): Promise<FetchLLMModelsResult> {
  const res = await fetch('/api/config/llm/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseURL: options?.baseURL,
      apiKey: options?.apiKey,
    }),
  });
  const data = await res.json();
  if (data.success && data.data) {
    return data.data as FetchLLMModelsResult;
  }
  throw new Error(data.error || `拉取模型列表失败 [${res.status}]`);
}

/** 生成类请求可选参数：超时/重试覆盖默认值 + R3-B 用量记录上下文 */
export interface GenerateOptions extends RetryOptions {
  /** R3 收尾：请求级模型覆盖（透传后端 body.model，未传则用激活配置档） */
  model?: string;
  /** 用量记录上下文（R3-B）：不传则不记录 */
  usage?: {
    projectId?: string;
    chapterNumber?: number;
    stage: string;
    tier?: LlmTier;
    model?: string;
  };
}

/** 生成成功后记录估算用量（prompt + 输出），失败不计（避免重复计数） */
function recordUsageIfRequested(
  options: GenerateOptions | undefined,
  messages: { role: string; content: string }[],
  completionText: string,
  ok: boolean
): void {
  const usage = options?.usage ?? getActiveUsageContext();
  if (!usage) return;
  const promptText = (messages || []).map((m) => m.content || '').join('\n');
  // 请求级 model 覆盖优先于上下文（估算按实际调用模型计价）
  const est = estimateUsageCost(
    options?.model || usage.model,
    promptText,
    completionText
  );
  addUsageRecord({
    projectId: usage.projectId,
    chapterNumber: usage.chapterNumber,
    stage: usage.stage,
    tier: usage.tier,
    model: options?.model || usage.model,
    promptChars: promptText.length,
    completionChars: completionText.length,
    estimatedTokens: est.tokens,
    estimatedCostCny: est.costCny,
    ok,
  });
}

export async function generateJSON<T>(
  messages: { role: string; content: string }[],
  temperature = 0.7,
  options?: GenerateOptions
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // R3-B：预算闸门（超限抛 BudgetExceededError，不重试）
  checkBudgetBeforeCall();
  try {
    return await withRetry(async () => {
      const res = await fetchWithTimeout(
        '/api/llm/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages,
            temperature,
            response_format: { type: 'json_object' },
            stream: false,
            ...(options?.model ? { model: options.model } : {}),
          }),
        },
        timeoutMs
      );

      if (!res.ok) {
        const errText = await res.text();
        const err = new Error(
          `请求服务端接口出错 [${res.status}]: ${errText}`
        ) as Error & { status: number };
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'AI 生成请求失败');
      }

      let rawContent: string = data.content || '';
      rawContent = rawContent.trim();

      // Strip markdown fences if AI wrapped it in ```json ... ``` or ``` ... ```
      if (rawContent.startsWith('```')) {
        const lines = rawContent.split('\n');
        if (lines[0].startsWith('```')) {
          lines.shift();
        }
        if (lines[lines.length - 1].startsWith('```')) {
          lines.pop();
        }
        rawContent = lines.join('\n').trim();
      }

      try {
        const parsed = JSON.parse(rawContent) as T;
        recordUsageIfRequested(options, messages, rawContent, true);
        return parsed;
      } catch (err) {
        console.error('JSON Parse Error. Raw AI Response:', rawContent);
        throw new Error(
          'AI 返回的内容无法解析为有效 JSON格式。请检查模型配置或重试。'
        );
      }
    }, options);
  } catch (err) {
    recordUsageIfRequested(options, messages, '', false);
    throw err;
  }
}

export async function generateText(
  messages: { role: string; content: string }[],
  temperature = 0.7,
  options?: GenerateOptions
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // R3-B：预算闸门
  checkBudgetBeforeCall();
  try {
    return await withRetry(async () => {
      const res = await fetchWithTimeout(
        '/api/llm/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages,
            temperature,
            stream: false,
            ...(options?.model ? { model: options.model } : {}),
          }),
        },
        timeoutMs
      );

      if (!res.ok) {
        const errText = await res.text();
        const err = new Error(
          `请求服务端接口出错 [${res.status}]: ${errText}`
        ) as Error & { status: number };
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'AI 生成请求失败');
      }

      const content = (data.content || '').trim();
      recordUsageIfRequested(options, messages, content, true);
      return content;
    }, options);
  } catch (err) {
    recordUsageIfRequested(options, messages, '', false);
    throw err;
  }
}

export async function generateStream(
  messages: { role: string; content: string }[],
  temperature = 0.7,
  onChunk?: (chunk: string) => void,
  onProgress?: (msg: string) => void,
  options?: GenerateOptions
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // R3-B：预算闸门
  checkBudgetBeforeCall();
  // 流式只重试「0 字节产出」的失败（连接未建立/首个字节前断开）；
  // 已产出部分内容时返回已有文本，避免重复生成内容。
  try {
    const text = await withRetry(
      async (attempt) => {
        if (attempt > 0 && onProgress) {
          onProgress('⚠️ 连接中断，正在重连...');
        } else if (onProgress) {
          onProgress('正在建立后台安全代理流式连接...');
        }

        const { text } = await streamOnce(
          messages,
          temperature,
          onChunk,
          onProgress,
          timeoutMs,
          options?.model
        );
        return text;
      },
      { ...options, maxRetries: options?.maxRetries ?? 1 }
    );
    recordUsageIfRequested(options, messages, text, true);
    return text;
  } catch (err) {
    recordUsageIfRequested(options, messages, '', false);
    throw err;
  }
}

/** 单次流式读取：响应头前超时 + 每次 read 空闲超时；0 字节失败抛错（可重试），部分产出返回已有文本 */
async function streamOnce(
  messages: { role: string; content: string }[],
  temperature: number,
  onChunk: ((chunk: string) => void) | undefined,
  onProgress: ((msg: string) => void) | undefined,
  timeoutMs: number,
  model?: string
): Promise<{ text: string; bytesProduced: number }> {
  const res = await fetchWithTimeout(
    '/api/llm/generate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        temperature,
        stream: true,
        ...(model ? { model } : {}),
      }),
    },
    timeoutMs
  );

  if (!res.ok || !res.body) {
    const errText = await res.text();
    const err = new Error(
      `流式响应请求失败 [${res.status}]: ${errText}`
    ) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullContent = '';
  let bytesProduced = 0;
  let buffer = '';
  // 流读取空闲超时：两次数据块间隔超过该值判定连接僵死（长文生成中模型也可能停很久，给足 90s）
  const idleTimeoutMs = Math.max(30_000, Math.round(timeoutMs * 0.75));

  if (onProgress) onProgress('AI 正在高速执笔输出中...');

  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await readWithIdleTimeout(reader, idleTimeoutMs);
    } catch (err) {
      // 流中断：已有产出则返回部分（不重试），否则抛错让 withRetry 重试
      if (bytesProduced > 0) {
        if (onProgress) {
          onProgress(`⚠️ 连接中断，已保留已生成部分（${fullContent.length} 字）`);
        }
        return { text: fullContent, bytesProduced };
      }
      throw err;
    }
    const { done, value } = result;
    if (done) break;
    bytesProduced += value?.byteLength || 0;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const dataStr = trimmed.slice(6).trim();
      if (dataStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.error) {
          throw new Error(parsed.error);
        }
        const chunk = parsed.chunk || '';
        if (chunk) {
          fullContent += chunk;
          if (onChunk) {
            onChunk(chunk);
          }
        }
      } catch (e: any) {
        if (e.message && !e.message.includes('JSON')) {
          throw e;
        }
      }
    }
  }

  return { text: fullContent, bytesProduced };
}

/** 单次 reader.read() 带空闲超时 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('流式响应空闲超时（连接中断）'));
    }, idleTimeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
