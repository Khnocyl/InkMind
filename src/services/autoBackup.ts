/**
 * 章末自动备份（落磁盘，经本地 server /api/backup）。
 *
 * 动机：作品数据只在浏览器 IndexedDB——清浏览器数据/换浏览器即清零。
 * 每次章节管线成功落盘后调度一次备份；多章连写（Auto-Pilot）在窗口期
 * 内合并为一次（去抖取最新）；失败静默（备份绝不打断写作），下次章末重试。
 *
 * 切书安全：getter 通常读 `projectRef.current`，去抖窗口内切书会让「A 书的
 * 待发备份」变成 B 书。这里记住调度时的 projectId：窗口结束时若 getter 指向
 * 的还是同一本书就用最新值，否则回退到调度时捕获的快照（宁可略旧，也不串书）。
 */
import type { BookProject } from '../types/novel';

/** 去抖窗口：连写多章只备份一次（取窗口结束时的最新全书） */
const DEFAULT_DELAY_MS = 15_000;

/**
 * keepalive 受 Fetch 规范限制：body > 64KiB 时浏览器直接判定 network error。
 * 整书 JSON 常常远超该值，所以只在足够小时启用（页面卸载时那一发才可能送达）。
 */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

let timer: ReturnType<typeof setTimeout> | null = null;
let getter: (() => BookProject | null) | null = null;
/** 调度时所在的书 + 该书当时的快照（切书兜底） */
let scheduledProjectId: string | null = null;
let scheduledSnapshot: BookProject | null = null;
let sending = false;
// flush 撞上「发送中」时挂起一次补发，发送完成后冲刷最新状态（否则静默丢失）
let refireAfterSend = false;

export function scheduleAutoBackup(
  projectGetter: () => BookProject | null,
  delayMs: number = DEFAULT_DELAY_MS
): void {
  getter = projectGetter;
  const snap = projectGetter();
  // 每次调度都重新绑定：getter 返回 null（无项目）时一并清空，避免发上一本书的陈旧快照
  scheduledProjectId = snap?.id ?? null;
  scheduledSnapshot = snap ?? null;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void fire();
  }, delayMs);
}

/**
 * 立即冲刷挂起的备份（页面隐藏/退出前可调用）。
 *
 * 只有「确实有东西要发」时才发：
 * - 去抖定时器还在 → 提前发出（本次编辑需要落盘）；
 * - 有在途请求 → 交给 fire() 的 refireAfterSend 补发一次最新状态；
 * - 两者都没有 → 直接返回。此前无条件 fire()，导致每次切标签页/最小化都会
 *   把上一次的整书重发一遍：浪费带宽、刷爆服务端 20 份备份轮转配额，
 *   还会撞上 /api/backup 的限流。
 */
export function flushAutoBackup(): void {
  if (!timer && !sending) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  void fire();
}

function pickProject(): BookProject | null {
  const latest = getter?.() ?? null;
  // 窗口内切书：latest 已是另一本书 → 用调度时捕获的快照，避免把 A 的备份写成 B
  if (latest && latest.id === scheduledProjectId) return latest;
  return scheduledSnapshot;
}

async function fire(): Promise<void> {
  if (sending) {
    refireAfterSend = true; // 发送中：发送完成后补发，避免本次冲刷被静默丢弃
    return;
  }
  const project = pickProject();
  if (!project?.id || !project.chapters) return;
  sending = true;
  try {
    const body = JSON.stringify({
      projectId: project.id,
      title: project.title,
      payload: project,
    });
    // keepalive 让「页面卸载时发起」的请求有机会送达；超 64KiB 会被浏览器拒绝，
    // 因此仅在体积允许时启用（大书仍走普通 fetch，由下一次章末/隐藏事件重试）
    const keepalive = new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES;
    const res = await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      ...(keepalive ? { keepalive: true } : {}),
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
    } else {
      // 发送结束（无论成败）：释放捕获的全书引用，避免模块级变量长期驻留整本书
      // 内存；下一次 scheduleAutoBackup 会重新捕获。
      scheduledSnapshot = null;
    }
  }
}
