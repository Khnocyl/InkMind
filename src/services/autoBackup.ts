/**
 * 章末自动备份（落磁盘，经本地 server /api/backup）。
 *
 * 动机：作品数据只在浏览器 IndexedDB——清浏览器数据/换浏览器即清零。
 * 每次章节管线成功落盘后调度一次备份；多章连写（Auto-Pilot）在窗口期
 * 内合并为一次（去抖取最新）；失败静默（备份绝不打断写作），下次章末重试。
 */
import type { BookProject } from '../types/novel';

/** 去抖窗口：连写多章只备份一次（取窗口结束时的最新全书） */
const DEFAULT_DELAY_MS = 15_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let getter: (() => BookProject | null) | null = null;
let sending = false;
// flush 撞上「发送中」时挂起一次补发，发送完成后冲刷最新状态（否则静默丢失）
let refireAfterSend = false;

export function scheduleAutoBackup(
  projectGetter: () => BookProject | null,
  delayMs: number = DEFAULT_DELAY_MS
): void {
  getter = projectGetter;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void fire();
  }, delayMs);
}

/** 立即冲刷挂起的备份（页面隐藏/退出前可调用） */
export function flushAutoBackup(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  void fire();
}

async function fire(): Promise<void> {
  if (sending) {
    refireAfterSend = true; // 发送中：发送完成后补发，避免本次冲刷被静默丢弃
    return;
  }
  if (!getter) return;
  const project = getter();
  if (!project?.id || !project.chapters) return;
  sending = true;
  try {
    const res = await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        title: project.title,
        payload: project,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      console.warn('[autoBackup] 服务端备份失败:', data.error);
    }
  } catch (err) {
    console.warn('[autoBackup] 备份请求失败（下次章末自动重试）:', err);
  } finally {
    sending = false;
    if (refireAfterSend) {
      refireAfterSend = false;
      void fire();
    }
  }
}
