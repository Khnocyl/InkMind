import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * crossTabLock 依赖浏览器环境（localStorage / window.setInterval /
 * BroadcastChannel）。测试前注入最小 stub，并用 resetModules 保证单例隔离。
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

let storage: MemoryStorage;

function stubBrowserEnv() {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    setInterval: () => 1,
    clearInterval: () => {},
  });
}

async function freshLock() {
  vi.resetModules();
  const mod = await import('../src/services/crossTabLock');
  return mod.crossTabLock;
}

describe('crossTabLock', () => {
  beforeEach(() => {
    stubBrowserEnv();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-03T12:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('首次 acquire 成功并持有', async () => {
    const lock = await freshLock();
    expect(lock.acquire('book-a', '单章三步')).toBe(true);
    expect(lock.isActiveElsewhere('book-a')).toEqual({ active: false });
  });

  it('同一本书二次 acquire 视为已持有（幂等）', async () => {
    const lock = await freshLock();
    lock.acquire('book-a', '单章三步');
    expect(lock.acquire('book-a', '单章三步')).toBe(true);
  });

  it('其他标签页（同书）持有且新鲜 → 拒绝', async () => {
    const lock = await freshLock();
    lock.acquire('book-a', '单章三步');
    // 模拟另一个标签页的锁实例：重新 import 后从 localStorage 读到同一把锁
    // 但 token 不同（模拟他页），fresh 且同书 → isActiveElsewhere 为 true
    const other = await freshLock();
    // 直接写一条"他人"的锁
    const raw = localStorage.getItem('novel-studio:cross-tab-lock');
    expect(raw).not.toBeNull();
    // acquire 同书应失败（他页持有）
    expect(other.acquire('book-a', 'Auto-Pilot')).toBe(false);
  });

  it('过期锁（超过 STALE_MS 无心跳）可被接管', async () => {
    const lock = await freshLock();
    lock.acquire('book-a', '单章三步');
    // 时间前进 80 秒（STALE_MS=75s）
    vi.setSystemTime(new Date('2026-08-03T12:01:20Z'));
    const other = await freshLock();
    expect(other.acquire('book-a', 'Auto-Pilot')).toBe(true);
  });

  it('不同书不互相阻塞', async () => {
    const lock = await freshLock();
    lock.acquire('book-a', '单章三步');
    const other = await freshLock();
    expect(other.acquire('book-b', '单章三步')).toBe(true);
  });

  it('release 后锁被清除，他页可重新获取', async () => {
    const lock = await freshLock();
    lock.acquire('book-a', '单章三步');
    lock.release();
    const other = await freshLock();
    expect(other.acquire('book-a', 'Auto-Pilot')).toBe(true);
  });

  it('localStorage 不可用（隐私模式）时降级为允许', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    const lock = await freshLock();
    expect(lock.acquire('book-a', '单章三步')).toBe(true);
  });
});
