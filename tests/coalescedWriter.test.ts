import { describe, it, expect, vi } from 'vitest';
import { CoalescedWriter } from '../src/services/coalescedWriter';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('CoalescedWriter', () => {
  it('串行调用各写一次', async () => {
    const writes: number[] = [];
    const w = new CoalescedWriter(async () => {
      writes.push(1);
      await tick();
    });
    await w.schedule();
    await w.schedule();
    await w.schedule();
    expect(writes.length).toBe(3);
  });

  it('慢写期间的突发调用合并为一次排队写，且读到最新值', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const writes: string[] = [];
    let current = '';
    const w = new CoalescedWriter(async () => {
      writes.push(current);
      await gate; // 第一次写挂起，期间接收突发
    });

    current = 'v1';
    const p1 = w.schedule();
    await tick(); // 确保 W1 已开始（写入了 v1）
    current = 'v2';
    const p2 = w.schedule();
    current = 'v3';
    const p3 = w.schedule();
    current = 'v4';
    const p4 = w.schedule();

    expect(writes.length).toBe(1); // 只有 W1 在跑
    release();
    await Promise.all([p1, p2, p3, p4]);

    expect(writes.length).toBe(2); // W1 + 末尾一次合并写
    expect(writes[0]).toBe('v1');
    expect(writes[1]).toBe('v4'); // 合并写读到最新值（覆盖 v2/v3/v4）
  });

  it('连续突发：写数量远小于调用数量', async () => {
    const writes: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const w = new CoalescedWriter(async () => {
      writes.push(calls);
      if (writes.length === 1) await gate; // 只卡第一次写
    });

    const ps: Promise<void>[] = [];
    for (let i = 1; i <= 10; i++) {
      calls = i;
      ps.push(w.schedule());
    }
    release();
    await Promise.all(ps);
    // 10 次调用 → 最多 2 次写（1 次在跑 + 1 次合并）
    expect(writes.length).toBeLessThanOrEqual(2);
    expect(writes[writes.length - 1]).toBe(10); // 末次写含全部状态
  });

  it('写失败不 reject，交给 onError，队列可继续', async () => {
    const onError = vi.fn();
    let fail = true;
    const w = new CoalescedWriter(
      async () => {
        if (fail) throw new Error('boom');
        await tick();
      },
      onError
    );
    await expect(w.schedule()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    // 失败后仍可继续写
    fail = false;
    await expect(w.schedule()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('完成后不留陈旧队列（tail 已清理）', async () => {
    const writes: number[] = [];
    const w = new CoalescedWriter(async () => {
      writes.push(1);
      await tick();
    });
    await w.schedule();
    await tick();
    await w.schedule();
    expect(writes.length).toBe(2); // 若 tail 未清理，第二次会意外合并
  });

  it('flush 等待所有已排队写完成', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let done = 0;
    const w = new CoalescedWriter(async () => {
      done += 1;
      await gate;
    });
    const p = w.schedule();
    w.schedule(); // 排队写
    await tick();
    release();
    await w.flush();
    await p;
    expect(done).toBe(2);
  });
});
