import {
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  withRetry,
  GenerationAbortedError,
  isGenerationAborted,
  SchemaMismatchError,
  type RetryOptions,
} from './llmResilience';
import { salvageJsonParse } from './jsonRepair';
import { recordLlmCall } from './llmTrace';
import type { LlmRole, LlmRoleRouting } from '../types/novel';
import { resolveRouteForRole, type RoutingProfileLike } from './llmRouting';

// 中止语义（引擎/管线使用）：活动信号上下文已在上方直接导出 + 用户中止错误类型
export { GenerationAbortedError, isGenerationAborted } from './llmResilience';
// JSON 结构校验闸门：validate 不合格抛 SchemaMismatchError（可重试、带反馈重生成）
export { SchemaMismatchError, isSchemaMismatchError } from './llmResilience';

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

/** 生成类请求可选参数：超时/重试覆盖默认值 */
export interface GenerateOptions<T = unknown> extends RetryOptions {
  /** R3 收尾：请求级模型覆盖（透传后端 body.model，未传则用激活配置档） */
  model?: string;
  /**
   * 按角色路由：请求级配置档选择（透传后端 body.profileId）。
   * 命中已保存档 → 后端整体切换该档（baseURL/Key/模型）。
   * 显式传入时优先于活动角色路由上下文。
   */
  profileId?: string;
  /** 用户中止信号：中止后抛 GenerationAbortedError（不可重试）。
   *  未显式传入时自动使用管线活动信号（setActiveAbortSignal）。 */
  signal?: AbortSignal;
  /** 结构校验闸门（仅 generateJSON）：返回错误文案表示不合格——
   *  会以「上次原始输出 + 修正指令」追加上下文重试；返回 null/undefined 视为合格。
   *  重试耗尽仍不合格则抛 SchemaMismatchError。 */
  validate?: (value: T) => string | null | undefined;
}

/** 反馈重试时回显的上一轮原始输出上限（控制 token 成本） */
const FEEDBACK_ECHO_LIMIT = 1200;

/** 构造校验失败的反馈消息对：回显上一轮原始输出（有界截断）+ 修正指令 */
function buildSchemaFeedback(
  rawContent: string,
  detail: string
): { role: string; content: string }[] {
  const head =
    rawContent.length > FEEDBACK_ECHO_LIMIT
      ? `${rawContent.slice(0, FEEDBACK_ECHO_LIMIT)}…（原文过长已截断）`
      : rawContent;
  return [
    { role: 'assistant', content: head },
    {
      role: 'user',
      content:
        `你上一次的输出未通过结构校验：${detail}。` +
        '请严格只输出一个完整合法的 JSON 对象并修复以上问题：' +
        '补齐缺失的字段与章节、不要丢章；字符串内部的半角双引号必须写成 \\" 转义；' +
        '不要输出 JSON 以外的任何文字。',
    },
  ];
}

// ── 管线活动中止信号（引擎级上下文）──
// pipeline 启动时注入、finally 清理；generate* 未显式传 signal 时自动采用，
// 免去把 signal 逐层穿过 aiEngine/agents 的全部函数签名。
let activeAbortSignal: AbortSignal | null = null;

export function setActiveAbortSignal(signal: AbortSignal | null | undefined): void {
  activeAbortSignal = signal ?? null;
}

export function getActiveAbortSignal(): AbortSignal | null {
  return activeAbortSignal;
}

/** 生效信号：显式 options 优先，否则取管线活动信号 */
function effectiveSignal(options?: { signal?: AbortSignal }): AbortSignal | undefined {
  return options?.signal ?? activeAbortSignal ?? undefined;
}

// ── 按角色路由（引擎级上下文，模式同 activeAbortSignal / activeUsageContext）──
// pipeline 每次阶段推进（report）时注入当前角色的路由目标；generate* 未显式传
// model/profileId 时自动并入请求体（profileId → 后端切换该档 baseURL/Key/模型）。
// 路由关闭（默认）时上下文恒为 null，请求路径与改造前完全一致。
export interface ActiveRoleRoute {
  profileId: string;
  /** 命中档的模型名：随请求体 model 透传，供用量计价与调用轨迹显示 */
  modelName?: string;
}

let activeRoleRoute: ActiveRoleRoute | null = null;

export function setActiveRoleRoute(route: ActiveRoleRoute | null | undefined): void {
  activeRoleRoute = route ?? null;
}

export function getActiveRoleRoute(): ActiveRoleRoute | null {
  return activeRoleRoute;
}

/**
 * 生效路由目标：显式 options 优先；显式 model（请求级模型名覆盖）时不叠加
 * 路由 profileId——调用方点名了模型，就让它落在激活档端点上。
 */
function effectiveRouteTarget(options?: {
  model?: string;
  profileId?: string;
}): { model?: string; profileId?: string } {
  if (options?.profileId) {
    return { profileId: options.profileId, model: options.model };
  }
  if (options?.model) {
    return { model: options.model };
  }
  if (activeRoleRoute?.profileId) {
    return {
      profileId: activeRoleRoute.profileId,
      model: activeRoleRoute.modelName || undefined,
    };
  }
  return {};
}

/**
 * 按角色路由（可选启用）解析配置档目标：未启用/未配置/拉取失败一律返回
 * undefined（跟随激活档）。供管线外的独立 LLM 任务（写前意图/跨章抽检）在
 * generate 调用点显式注入，避免继承管线并发运行时的阶段路由。
 */
export async function resolveRoleRouteAsync(
  routing: LlmRoleRouting | undefined | null,
  role: LlmRole
): Promise<ActiveRoleRoute | undefined> {
  if (routing?.enabled !== true) return undefined;
  if (!routing.routes?.[role]) return undefined; // 未配置：免拉档列表
  try {
    const { profiles, activeProfileId } = await listLLMProfiles();
    const target: RoutingProfileLike[] = profiles;
    return resolveRouteForRole(routing, role, target, activeProfileId);
  } catch {
    // 后端不可达等：安全降级为激活档
    return undefined;
  }
}

export async function generateJSON<T>(
  messages: { role: string; content: string }[],
  temperature = 0.7,
  options?: GenerateOptions<T>
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = effectiveSignal(options);
  // 按角色路由：显式 options 优先，其次管线活动路由上下文（默认 null = 现状）
  const routeTarget = effectiveRouteTarget(options);
  // 调用轨迹（AI 调用记录窗口）：记录最后一次尝试的 messages 与原始响应
  const traceStarted = performance.now();
  let traceMessages = messages;
  let traceResponse = '';
  let traceStrategy: string | undefined;
  try {
    // 结构校验失败后的带反馈重试：上一轮原始输出 + 修正指令（只保留最近一轮，避免历史膨胀）
    let priorExchange: { role: string; content: string }[] | undefined;
    const value = await withRetry(async () => {
      const attemptMessages =
        priorExchange && priorExchange.length > 0
          ? [...messages, ...priorExchange]
          : messages;
      traceMessages = attemptMessages;
      const res = await fetchWithTimeout(
        '/api/llm/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: attemptMessages,
            temperature,
            response_format: { type: 'json_object' },
            stream: false,
            ...(routeTarget.model ? { model: routeTarget.model } : {}),
            ...(routeTarget.profileId ? { profileId: routeTarget.profileId } : {}),
          }),
        },
        timeoutMs,
        signal
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
      traceResponse = rawContent;

      const salvaged = salvageJsonParse<T>(rawContent);
      if (!salvaged.ok) {
        console.error('JSON Parse Error. Raw AI Response:', rawContent);
        throw new Error(
          'AI 返回的内容无法解析为有效 JSON格式。请检查模型配置或重试。'
        );
      }
      traceStrategy = salvaged.strategy;

      if (
        salvaged.strategy !== 'direct' &&
        salvaged.strategy !== 'fence-strip'
      ) {
        console.warn('[jsonRepair] 使用修复策略', salvaged.strategy);
      }

      // 校验闸门：形状/覆盖不合格 → 抛 SchemaMismatchError（可重试），下轮带上反馈
      if (options?.validate) {
        const mismatch = options.validate(salvaged.value);
        if (mismatch) {
          console.warn('[schemaGate] 结构校验未通过：', mismatch);
          priorExchange = buildSchemaFeedback(rawContent, mismatch);
          throw new SchemaMismatchError(mismatch);
        }
      }

      return salvaged.value;
    }, options);
    recordLlmCall({
      kind: 'json',
      model: routeTarget.model,
      messages: traceMessages,
      response: traceResponse,
      ok: true,
      strategy: traceStrategy,
      durationMs: Math.round(performance.now() - traceStarted),
    });
    return value;
  } catch (err) {
    recordLlmCall({
      kind: 'json',
      model: routeTarget.model,
      messages: traceMessages,
      response: traceResponse,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - traceStarted),
    });
    throw err;
  }
}

export async function generateText(
  messages: { role: string; content: string }[],
  temperature = 0.7,
  options?: GenerateOptions
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = effectiveSignal(options);
  // 按角色路由：显式 options 优先，其次管线活动路由上下文（默认 null = 现状）
  const routeTarget = effectiveRouteTarget(options);
  // 调用轨迹
  const traceStarted = performance.now();
  try {
    const value = await withRetry(async () => {
      const res = await fetchWithTimeout(
        '/api/llm/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages,
            temperature,
            stream: false,
            ...(routeTarget.model ? { model: routeTarget.model } : {}),
            ...(routeTarget.profileId ? { profileId: routeTarget.profileId } : {}),
          }),
        },
        timeoutMs,
        signal
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
      return content;
    }, options);
    recordLlmCall({
      kind: 'text',
      model: routeTarget.model,
      messages,
      response: value,
      ok: true,
      durationMs: Math.round(performance.now() - traceStarted),
    });
    return value;
  } catch (err) {
    recordLlmCall({
      kind: 'text',
      model: routeTarget.model,
      messages,
      response: '',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - traceStarted),
    });
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
  const signal = effectiveSignal(options);
  // 按角色路由：显式 options 优先，其次管线活动路由上下文（默认 null = 现状）
  const routeTarget = effectiveRouteTarget(options);
  // 调用轨迹：流式记录最终拼接全文（中断时为已产出部分）
  const traceStarted = performance.now();
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
          signal,
          routeTarget
        );
        return text;
      },
      { ...options, maxRetries: options?.maxRetries ?? 1 }
    );
    recordLlmCall({
      kind: 'stream',
      model: routeTarget.model,
      messages,
      response: text,
      ok: true,
      durationMs: Math.round(performance.now() - traceStarted),
    });
    return text;
  } catch (err) {
    recordLlmCall({
      kind: 'stream',
      model: routeTarget.model,
      messages,
      response: '',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - traceStarted),
    });
    throw err;
  }
}

/** 单次流式读取：响应头前超时 + 每次 read 空闲超时；用户中止随时抛 GenerationAbortedError；0 字节失败抛错（可重试），部分产出返回已有文本 */
async function streamOnce(
  messages: { role: string; content: string }[],
  temperature: number,
  onChunk: ((chunk: string) => void) | undefined,
  onProgress: ((chunk: string) => void) | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  routeTarget?: { model?: string; profileId?: string }
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
        ...(routeTarget?.model ? { model: routeTarget.model } : {}),
        ...(routeTarget?.profileId ? { profileId: routeTarget.profileId } : {}),
      }),
    },
    timeoutMs,
    signal
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

  /** 尽力释放底层连接（中止/中断路径必须调用，否则连接悬挂到 GC、后端继续烧上游） */
  const releaseReader = async () => {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  };

  if (signal?.aborted) {
    await releaseReader();
    throw new GenerationAbortedError();
  }
  if (onProgress) onProgress('AI 正在高速执笔输出中...');

  /** 处理单行 SSE 数据（错误帧会抛出） */
  const consumeLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data: ')) return;
    const dataStr = trimmed.slice(6).trim();
    if (dataStr === '[DONE]') return;
    let parsed: any;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      // 非 JSON 行忽略（心跳/注释等）
      return;
    }
    // 服务端错误帧：类型化判断（不再靠 message 是否含 "JSON" 的脆弱启发式）
    if (parsed && typeof parsed.error === 'string' && parsed.error) {
      await releaseReader();
      throw new Error(parsed.error);
    }
    const chunk = parsed.chunk || '';
    if (chunk) {
      fullContent += chunk;
      if (onChunk) {
        onChunk(chunk);
      }
    }
    // 截断信号（server 透传 finish_reason）：length = 被 max_tokens 截断
    if (parsed.finish === 'length') {
      if (onProgress) {
        onProgress(
          `⚠️ 输出被模型上限截断（finish=length，已产出 ${fullContent.length} 字）。` +
            `补写轮会继续加厚；若仍不足请调大 NOVEL_LLM_MAX_TOKENS 或换输出上限更高的模型。`
        );
      }
    }
  };

  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await readWithIdleTimeout(reader, idleTimeoutMs, signal);
    } catch (err) {
      await releaseReader();
      // 用户主动停止：无论已产出多少都不当作成功稿
      if (isGenerationAborted(err)) throw err;
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
    for (const line of lines) await consumeLine(line);
  }

  // 流末冲刷：取出 TextDecoder 残留的半个多字节字符 + 处理 buffer 里最后一条无换行结尾的行
  buffer += decoder.decode();
  if (buffer) await consumeLine(buffer);

  return { text: fullContent, bytesProduced };
}

/**
 * 单次 reader.read() 带空闲超时 + 外部中止。
 * - 两次数据块间隔超过 idleTimeoutMs → 连接僵死，reject Error；
 * - signal 中止 → reject GenerationAbortedError（优先级高于空闲超时竞态）。
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('流式响应空闲超时（连接中断）'));
    }, idleTimeoutMs);
  });
  let abortPromise: Promise<never> | null = null;
  if (signal) {
    abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(new GenerationAbortedError());
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  try {
    return await Promise.race(
      abortPromise
        ? [reader.read(), timeoutPromise, abortPromise]
        : [reader.read(), timeoutPromise]
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
