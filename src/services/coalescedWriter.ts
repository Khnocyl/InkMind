/**
 * 最新值胜出的串行写入器（R2-3）。
 *
 * 问题：App 每次 `handleUpdateAndPersistProject` 都排队一次全书 JSON 全量写，
 * Auto-Pilot / 管线收尾的突发更新会积压大量重复写（每次写最新 ref，中间态全浪费）。
 *
 * 方案：
 * - 同一时刻最多 1 个写任务在跑 + 1 个合并任务排队；
 * - 突发 N 次 schedule → 约 2 次真实 write（正在跑的那次 + 末尾合并一次）；
 * - 返回的 Promise 在该次状态「已随某次写落盘」后 resolve ——
 *   因为调用方先同步更新 state/ref，写任务执行时读到的永远是最新值，
 *   所以 resolve 时刻本次数据必已在磁盘（与旧的串行队列语义等价，甚至更快）；
 * - 永不 reject，但**必须如实回报结果**：写失败返回 { ok:false, error }，
 *   同时交给 onError（弹窗/日志）。调用方若把 resolve 当成「已落盘」就会
 *   丢数据（配额超限、跨页冲突），因此关键路径必须检查返回值。
 */
export type CoalescedWriteResult = { ok: true } | { ok: false; error: unknown };

export class CoalescedWriter {
  private tail: Promise<CoalescedWriteResult> | null = null;
  private queued: Promise<CoalescedWriteResult> | null = null;
  private readonly write: () => Promise<void>;
  private readonly onError: (e: unknown) => void;

  constructor(
    write: () => Promise<void>,
    onError: (e: unknown) => void = (e) => console.error(e)
  ) {
    this.write = write;
    this.onError = onError;
  }

  /** 请求一次写入（合并突发），返回本次数据是否已落盘（永不 reject） */
  schedule(): Promise<CoalescedWriteResult> {
    if (!this.tail) {
      // 无在跑任务：立即开始一次写
      const p = this.exec();
      this.tail = p;
      this.queued = null;
      this.attachCleanup(p);
      return p;
    }
    // 已有在跑/排队任务：合并
    if (this.queued) return this.queued; // 已有一个排队写，复用（写的是最新 ref，覆盖本次状态）
    const q = this.tail.then(() => this.exec(), () => this.exec());
    this.tail = q;
    this.queued = q;
    this.attachCleanup(q);
    return q;
  }

  /** 立即完成当前所有已排队的写（如页面隐藏/关闭前的兜底），不新增写 */
  async flush(): Promise<void> {
    const t = this.tail;
    if (t) await t;
  }

  private async exec(): Promise<CoalescedWriteResult> {
    // 本任务若为合并任务，开始执行即释放排队位（后续新调用可再排队）
    this.queued = null;
    try {
      await this.write();
      return { ok: true };
    } catch (e) {
      // 不 reject（避免 fire-and-forget 调用点产生未处理拒绝），但如实回报失败
      this.onError(e);
      return { ok: false, error: e };
    }
  }

  private attachCleanup(p: Promise<CoalescedWriteResult>): void {
    void p.then(() => {
      if (this.tail === p) this.tail = null;
      if (this.queued === p) this.queued = null;
    });
  }
}
