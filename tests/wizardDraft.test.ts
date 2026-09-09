/**
 * 向导草稿自动落盘：去抖合并 + 串行化 + flush 不丢最后一击。
 * 回归背景：向导各步只把编辑放在 useState，退出向导即全丢（用户实测第一步）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { WizardDraftSaver } from '../src/services/wizardDraft';
import { loadProject, saveProject } from '../src/services/storage';
import type { BookProject } from '../src/types/novel';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WizardDraftSaver', () => {
  it('去抖窗口内多次编辑合并为一次落盘，且保留全部字段', async () => {
    const saved: Partial<BookProject>[] = [];
    const saver = new WizardDraftSaver(async (p) => {
      saved.push(p);
    });
    saver.queue({ title: '书名' });
    saver.queue({ synopsis: '梗概' });
    saver.queue({ title: '书名改' });
    expect(saved).toHaveLength(0); // 还没到点
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: '书名改', synopsis: '梗概' });
  });

  it('flush 立即落盘（退出向导场景），无挂起时是空操作', async () => {
    const saved: Partial<BookProject>[] = [];
    const saver = new WizardDraftSaver(async (p) => {
      saved.push(p);
    });
    saver.queue({ config: { inspiration: '灵感原文' } as never });
    await saver.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0].config).toMatchObject({ inspiration: '灵感原文' });
    await saver.flush(); // 空操作
    expect(saved).toHaveLength(1);
  });

  it('落盘进行中到达的编辑会串行补发，不互相覆盖', async () => {
    const saved: Partial<BookProject>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    const saver = new WizardDraftSaver(async (p) => {
      call += 1;
      if (call === 1) await gate;
      saved.push(p);
    });
    saver.queue({ title: 'A' });
    void saver.flush(); // 第一次落盘被 gate 挂住
    saver.queue({ synopsis: 'B' }); // 期间的新编辑
    release();
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ title: 'A' });
    expect(saved[1]).toMatchObject({ synopsis: 'B' });
  });

  it('落盘失败不抛出，也不阻塞后续编辑', async () => {
    const saved: Partial<BookProject>[] = [];
    let fail = true;
    const saver = new WizardDraftSaver(async (p) => {
      if (fail) throw new Error('QuotaExceeded');
      saved.push(p);
    });
    saver.queue({ title: 'A' });
    await expect(saver.flush()).resolves.toBeUndefined();
    fail = false;
    saver.queue({ title: 'B' });
    await saver.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: 'B' });
  });
});

describe('向导草稿 · 端到端（storage 往返）', () => {
  it('第一步的灵感与参数落盘后重新加载项目仍在（用户报的「切回来全没了」）', async () => {
    vi.useRealTimers(); // IndexedDB 回调依赖真实定时器
    const project = {
      id: 'p-wizard-draft',
      title: '未命名新书',
      genre: '玄幻',
      config: { genre: '玄幻', inspiration: '', writingStyle: '' },
      characters: [],
      settings: [],
      volumes: [],
      chapters: [],
      createdAt: '2026-08-03T00:00:00.000Z',
      lastModified: '2026-08-03T00:00:00.000Z',
    } as unknown as BookProject;
    await saveProject(project);

    // 与 ProjectWizard.updateAndSave 同构：读最新 → 合并 patch → 落盘
    const saver = new WizardDraftSaver(async (patch) => {
      const cur = (await loadProject(project.id)) ?? project;
      await saveProject({ ...cur, ...patch });
    });
    saver.queue({
      config: {
        inspiration: '我写的第一段灵感设定',
        genre: '科幻',
        totalChapters: 80,
        targetChapterCount: 80,
      } as never,
    });
    await saver.flush();

    const reloaded = await loadProject(project.id);
    expect(reloaded?.config.inspiration).toBe('我写的第一段灵感设定');
    expect(reloaded?.config.genre).toBe('科幻');
    expect(reloaded?.config.totalChapters).toBe(80);
  });
});
