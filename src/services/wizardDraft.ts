import type { BookProject } from '../types/novel';

export type WizardDraftPatch = Partial<BookProject>;

/**
 * 向导草稿自动落盘。
 *
 * 背景：向导每一步的表单都只存在组件内的 useState，只有点「下一步」才会写回项目。
 * 一旦用户退出向导（工作台/书库/关窗）、切换作品或刷新页面，刚填的内容就没了
 * （用户实测：第一步写好的灵感与参数退出后回来全空）。
 *
 * 这里把各步的编辑去抖合并后写回项目，并保证：
 * - 600ms 去抖：连续击键只写一次；
 * - 串行化：同一时刻最多一个 save 在跑，期间到达的编辑合并到 pending 等待，
 *   避免并发写各自基于旧 projectRef 互相覆盖；
 * - flush()：退出/完成/切换步骤时立即落盘，最后一击不丢。
 */
export class WizardDraftSaver {
  private pending: WizardDraftPatch = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private readonly save: (patch: WizardDraftPatch) => Promise<unknown>;
  private readonly delayMs: number;

  constructor(
    save: (patch: WizardDraftPatch) => Promise<unknown>,
    delayMs = 600
  ) {
    this.save = save;
    this.delayMs = delayMs;
  }

  /** 是否还有未落盘的编辑（测试/调试用） */
  hasPending(): boolean {
    return Object.keys(this.pending).length > 0 || this.sending;
  }

  /** 合并一次编辑并去抖落盘 */
  queue(patch: WizardDraftPatch): void {
    this.pending = { ...this.pending, ...patch };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** 立即落盘挂起的编辑；无挂起内容时是空操作。可重复调用。 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.sending) return; // 在跑的那次结束时会继续冲刷剩余 pending
    if (Object.keys(this.pending).length === 0) return;
    const patch = this.pending;
    this.pending = {};
    this.sending = true;
    try {
      await this.save(patch);
    } catch (e) {
      // 落盘失败不重排（下一次编辑会带最新值重来），避免失败风暴
      console.warn('[wizardDraft] 草稿落盘失败:', e);
    } finally {
      this.sending = false;
    }
    if (Object.keys(this.pending).length > 0) await this.flush();
  }
}
