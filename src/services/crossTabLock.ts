/**
 * 跨标签页生成锁：防止两个浏览器标签页同时对同一本书跑写章管线，
 * 避免互相覆盖终稿（R5）。
 *
 * 原理：
 * - localStorage 同步"抢占"（read-check-write + 写后复核，缩小并发竞态窗口）；
 * - BroadcastChannel 广播 start / heartbeat / end，实现"他人正在生成"的即时感知；
 * - 条目带时间戳，超过 STALE_MS 无心跳视为页面已死，自动让锁（崩溃恢复）；
 * - 任何异常（隐私模式 / 旧浏览器）降级为"允许"，不阻断单机单页使用。
 */

export interface CrossTabHolder {
  projectId: string;
  /** 例如 单章三步 / Auto-Pilot */
  holder: string;
  at: number;
  token: string;
}

const LS_KEY = 'novel-studio:cross-tab-lock';
const CHANNEL_NAME = 'novel-studio:cross-tab';
/** 锁有效期：超过该时长没有心跳视为页面已死，允许其他页接管 */
const STALE_MS = 75_000;
/** 心跳间隔 */
const HEARTBEAT_MS = 15_000;

type LockMessage =
  | { type: 'start' | 'heartbeat'; holder: CrossTabHolder }
  | { type: 'end'; projectId: string; token: string };

function readLs(): CrossTabHolder | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CrossTabHolder;
    if (!parsed || typeof parsed.projectId !== 'string' || typeof parsed.token !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLs(h: CrossTabHolder | null) {
  try {
    if (h) localStorage.setItem(LS_KEY, JSON.stringify(h));
    else localStorage.removeItem(LS_KEY);
  } catch {
    // 隐私模式等场景：忽略，锁退化为仅 BroadcastChannel 提示
  }
}

class CrossTabLock {
  private channel: BroadcastChannel | null = null;
  private own: CrossTabHolder | null = null;
  private heartbeatTimer: number | null = null;

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as LockMessage);
      } catch {
        this.channel = null;
      }
    }
  }

  private onMessage(msg: LockMessage | null | undefined) {
    if (!msg) return;
    if (msg.type === 'end') {
      const cur = readLs();
      if (cur && cur.token === msg.token) writeLs(null);
      return;
    }
    if (msg.type === 'start' || msg.type === 'heartbeat') {
      if (!msg.holder || msg.holder.token === this.own?.token) return;
      const cur = readLs();
      // 只刷新"对方"的条目，不覆盖自己的锁
      if (!cur || cur.token !== msg.holder.token) writeLs(msg.holder);
    }
  }

  /** 是否已有其他标签页正在生成该书（fresh 窗口内） */
  isActiveElsewhere(projectId: string): { active: boolean; holder?: string } {
    const cur = readLs();
    if (!cur) return { active: false };
    if (Date.now() - cur.at > STALE_MS) return { active: false };
    if (cur.projectId === projectId && cur.token !== this.own?.token) {
      return { active: true, holder: cur.holder };
    }
    return { active: false };
  }

  /**
   * 抢占跨标签锁；失败说明其他标签页正在生成同一本书。
   * 自己已持有（重复调用）视为成功。
   */
  acquire(projectId: string, holder: string): boolean {
    const now = Date.now();
    const cur = readLs();
    if (cur) {
      const fresh = now - cur.at <= STALE_MS;
      if (cur.token === this.own?.token) return true; // 本页已持有
      if (fresh && cur.projectId === projectId) return false; // 他页持有且新鲜
      // 过期锁 / 别的书 → 接管
    }

    this.own = {
      projectId,
      holder,
      at: now,
      token: `${now}-${Math.random().toString(36).slice(2, 10)}`,
    };
    writeLs(this.own);

    // 写后复核：若被其他页并发覆盖，则放弃（收窄竞态窗口）。
    // storage 不可读/被清空（隐私模式、异常）时视为降级允许——
    // 既然锁写不进去，其他页也写不进去，强行失败只会让单机单页也无法使用。
    const after = readLs();
    if (after && after.token !== this.own.token) {
      this.own = null;
      return false;
    }

    this.post({ type: 'start', holder: this.own });
    if (this.heartbeatTimer == null) {
      this.heartbeatTimer = window.setInterval(() => {
        if (!this.own) return;
        this.own = { ...this.own, at: Date.now() };
        writeLs(this.own);
        this.post({ type: 'heartbeat', holder: this.own });
      }, HEARTBEAT_MS);
    }
    return true;
  }

  release() {
    if (this.heartbeatTimer != null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.own) {
      this.post({ type: 'end', projectId: this.own.projectId, token: this.own.token });
      const cur = readLs();
      if (cur && cur.token === this.own.token) writeLs(null);
      this.own = null;
    }
  }

  private post(msg: LockMessage) {
    try {
      this.channel?.postMessage(msg);
    } catch {
      // BroadcastChannel 不可用时静默降级
    }
  }
}

/** 单例 */
export const crossTabLock = new CrossTabLock();
