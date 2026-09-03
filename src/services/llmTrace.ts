/**
 * LLM 调用轨迹（仅内存环形缓冲，不落盘）：记录发给 AI 的完整 messages 与原始响应，
 * 供「AI 调用记录」窗口排查提示词与解析问题。不含密钥，进程重启即清空。
 */

export interface LlmTraceEntry {
  id: number;
  /** 记录时刻（时:分:秒.毫秒） */
  time: string;
  kind: 'json' | 'text' | 'stream';
  /** 用量上下文里的阶段标识（如 engine:write），便于定位是哪个功能发起 */
  stage?: string;
  model?: string;
  messages: { role: string; content: string }[];
  /** AI 原始返回（截断/中止时为已产出部分；失败时为空或最后尝试的部分） */
  response: string;
  ok: boolean;
  error?: string;
  /** JSON 调用命中的 jsonRepair 修复策略（direct/fence-strip/…） */
  strategy?: string;
  durationMs: number;
}

const MAX_ENTRIES = 40;
let seq = 0;
const buffer: LlmTraceEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

/** 订阅变更（返回退订函数）；UI 用它驱动刷新 */
export function subscribeLlmTrace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 最新在前 */
export function getLlmTraceEntries(): LlmTraceEntry[] {
  return [...buffer].reverse();
}

export function clearLlmTrace(): void {
  buffer.length = 0;
  emit();
}

export function recordLlmCall(
  entry: Omit<LlmTraceEntry, 'id' | 'time'>
): void {
  seq += 1;
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  buffer.push({
    ...entry,
    id: seq,
    time: `${now.toLocaleTimeString('zh-CN', { hour12: false })}.${ms}`,
  });
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  emit();
}
