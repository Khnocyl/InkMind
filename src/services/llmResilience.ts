/**
 * R3-A 韧性层：LLM 请求统一「超时 + 重试退避 + 可重试判定」。
 * 纯函数/依赖注入，便于单测；llmClient 的 generate* 系列接入。
 */

export interface RetryOptions {
  /** 最大重试次数（默认 2，即总尝试 3 次） */
  maxRetries?: number;
  /** 基础退避毫秒（默认 600，指数 2^n + 抖动） */
  retryDelayMs?: number;
  /** 单次尝试超时毫秒（默认 120_000；0=不超时） */
  timeoutMs?: number;
}

export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 600;
/**
 * 单次尝试响应头超时（默认 240s）：
 * - 隐藏推理型模型（如 stealth 系）接受请求后可能长时间不吐首字节；
 * - 流式空闲超时按此的 75% 联动放大（180s），避免长思考被误判为连接僵死。
 */
export const DEFAULT_TIMEOUT_MS = 240_000;

/** 超时专用错误（可重试） */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`请求超时（${timeoutMs}ms）`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** 用户主动停止生成（不可重试、不计费、静默收尾） */
export class GenerationAbortedError extends Error {
  constructor() {
    super('已停止生成');
    this.name = 'GenerationAbortedError';
  }
}

export function isGenerationAborted(err: unknown): boolean {
  return (
    err instanceof GenerationAbortedError ||
    (err instanceof Error && err.name === 'GenerationAbortedError')
  );
}

/**
 * JSON 结构校验未通过（可重试）：generateJSON 的 validate 闸门抛出。
 * 与 parse 失败不同——内容已是合法 JSON 但形状/覆盖不合格，带反馈重试有较高修复概率。
 */
export class SchemaMismatchError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`AI 返回的 JSON 未通过结构校验：${detail}`);
    this.name = 'SchemaMismatchError';
    this.detail = detail;
  }
}

export function isSchemaMismatchError(err: unknown): err is SchemaMismatchError {
  return (
    err instanceof SchemaMismatchError ||
    (err instanceof Error && err.name === 'SchemaMismatchError')
  );
}

/** 是否值得重试：网络错误 / 超时 / 429 限流 / 5xx 服务端错误 / 结构校验失败。4xx（除 429）多为配置问题，重试无意义。 */
export function isRetryableError(err: unknown): boolean {
  // 用户主动中止：永不重试（必须先于其他 Abort 判定）
  if (isGenerationAborted(err)) return false;
  if (isSchemaMismatchError(err)) return true;
  if (err instanceof TimeoutError) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  const anyErr = err as { status?: number; message?: string } | null;
  if (typeof anyErr?.status === 'number') {
    return anyErr.status === 429 || anyErr.status >= 500;
  }
  const msg = String(anyErr?.message || err || '');
  return /fetch failed|network|ECONNREFUSED|ETIMEDOUT|socket hang up|temporary (failure|error)|unavailable/i.test(
    msg
  );
}

/** 指数退避 + 抖动（±25%） */
export function backoffDelayMs(baseMs: number, attempt: number): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = exp * 0.25 * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(exp + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带超时的 fetch（响应头到达前超时）+ 可选外部中止信号。
 * - 超时通过内部 AbortController 中断，抛 TimeoutError（可重试）；
 * - 外部 signal 中止（用户停止）抛 GenerationAbortedError（不可重试）；
 * - 两者任一触发都会中断同一请求。
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  if ((!timeoutMs || timeoutMs <= 0) && !signal) {
    return fetch(input, init);
  }
  const controller = new AbortController();
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new GenerationAbortedError();
      throw new TimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * 通用重试包装：fn(attempt) 抛可重试错误时按退避重试，直至 maxRetries 耗尽。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt >= maxRetries) {
        throw err;
      }
      await sleep(backoffDelayMs(baseDelay, attempt + 1));
    }
  }
  throw lastErr;
}
