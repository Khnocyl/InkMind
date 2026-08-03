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
export const DEFAULT_TIMEOUT_MS = 120_000;

/** 超时专用错误（可重试） */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`请求超时（${timeoutMs}ms）`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** 是否值得重试：网络错误 / 超时 / 429 限流 / 5xx 服务端错误。4xx（除 429）多为配置问题，重试无意义。 */
export function isRetryableError(err: unknown): boolean {
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
 * 带超时的 fetch（响应头到达前超时）。
 * 超时通过 AbortController 中断，并抛 TimeoutError（可重试）。
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(input, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new TimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
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
