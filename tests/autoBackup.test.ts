/**
 * 章末自动备份（autoBackup）：
 * - 去抖窗口内切书 → 必须备份调度时那本书，不能串成新书；
 * - 同一本书内 → 取窗口结束时的最新状态（新鲜度）；
 * - keepalive 仅在 body ≤ 64KiB 时启用（超限会被浏览器直接拒绝）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flushAutoBackup,
  scheduleAutoBackup,
} from '../src/services/autoBackup';
import type { BookProject } from '../src/types/novel';

function makeBook(id: string, contentSize = 10): BookProject {
  return {
    id,
    title: `书-${id}`,
    chapters: [
      {
        id: `${id}-ch1`,
        number: 1,
        title: '第一章',
        content: 'x'.repeat(contentSize),
      },
    ],
  } as unknown as BookProject;
}

function captureBodies() {
  const bodies: Array<{ projectId: string; keepalive: boolean }> = [];
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body || '{}'));
    bodies.push({
      projectId: parsed.projectId,
      keepalive: (init as { keepalive?: boolean } | undefined)?.keepalive === true,
    });
    return { ok: true, json: async () => ({ success: true }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', mock);
  return { bodies, mock };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('autoBackup · 项目绑定与 keepalive', () => {
  it('去抖窗口内切书 → 备份的是调度时那本书（不串书）', async () => {
    const { bodies } = captureBodies();
    let current = makeBook('A');
    scheduleAutoBackup(() => current);
    // 窗口内切到 B：getter 指向新书
    current = makeBook('B');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].projectId).toBe('A');
  });

  it('同一本书内 → 用窗口结束时的最新状态', async () => {
    const { bodies } = captureBodies();
    let current = makeBook('A', 10);
    scheduleAutoBackup(() => current);
    // 窗口内继续写：同一本书的新对象
    current = { ...makeBook('A', 10), title: '书-A-最新' };
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].projectId).toBe('A');
  });

  it('小体积 payload → 启用 keepalive（卸载时那一发才可能送达）', async () => {
    const { bodies } = captureBodies();
    scheduleAutoBackup(() => makeBook('A'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bodies[0].keepalive).toBe(true);
  });

  it('超过 64KiB 的 payload → 不启用 keepalive（否则请求必被浏览器拒绝）', async () => {
    const { bodies } = captureBodies();
    scheduleAutoBackup(() => makeBook('A', 80 * 1024));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].keepalive).toBe(false);
  });

  it('flushAutoBackup 立即冲刷且只发一次', async () => {
    const { bodies } = captureBodies();
    scheduleAutoBackup(() => makeBook('A'));
    flushAutoBackup();
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies).toHaveLength(1);
    // 原定时器已被清除：再推进也不会重复发送
    await vi.advanceTimersByTimeAsync(20_000);
    expect(bodies).toHaveLength(1);
  });

  it('无待冲刷任务时 flush 不发请求（切 Tab/最小化不再重复备份）', async () => {
    const { bodies } = captureBodies();
    scheduleAutoBackup(() => makeBook('A'));
    // 定时器自然到期 → 已发送一次
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bodies).toHaveLength(1);
    // 此后每次 visibilitychange=hidden 都会调 flush：不得再发
    flushAutoBackup();
    flushAutoBackup();
    await vi.advanceTimersByTimeAsync(0);
    expect(bodies).toHaveLength(1);
  });

  it('调度时无项目（getter 返回 null）→ 不发上一本书的陈旧快照', async () => {
    const { bodies } = captureBodies();
    // 先正常调度一本，让模块记住 A
    scheduleAutoBackup(() => makeBook('A'));
    // 紧接着以「无项目」重新调度：旧绑定必须被清空
    scheduleAutoBackup(() => null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(bodies).toHaveLength(0);
  });

  it('发送中 flush → 补发一次最新状态（发送期间的编辑不丢）', async () => {
    const titles: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        titles.push(JSON.parse(String(init?.body || '{}')).title);
        if (titles.length === 1) await gate;
        return { ok: true, json: async () => ({ success: true }) } as unknown as Response;
      })
    );
    let current = makeBook('A');
    scheduleAutoBackup(() => current);
    // 第一次发送开始并挂起在 gate
    await vi.advanceTimersByTimeAsync(15_000);
    expect(titles).toHaveLength(1);
    // 发送期间继续编辑同一本书，此时用户切 Tab → 应补发最新状态
    current = { ...makeBook('A'), title: '书-A-新' };
    flushAutoBackup();
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(titles).toHaveLength(2);
    expect(titles[1]).toBe('书-A-新');
  });
});
