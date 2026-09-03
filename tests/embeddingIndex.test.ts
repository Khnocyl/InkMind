/**
 * embeddingIndex 单测（真·向量检索接入）：
 * 1. Embeding 未启用 / 配置接口失败 → 降级本地 TF-IDF（mode 'local'，形状与同步版一致）
 * 2. 启用且 API 正常 → mode 'embedding'，产出 boost maps；文档向量落缓存后
 *    第二次调用 embeddedDocs === 0（不重复 embed）
 * 3. Embedding API 调用失败 → 整体降级 local，不抛错（写作不中断）
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { BookProject, Chapter, StoryMemory } from '../src/types/novel';
import {
  semanticBoostMapAsync,
  invalidateEmbeddingConfigCache,
} from '../src/services/embeddingIndex';
import { semanticBoostMap } from '../src/services/semanticIndex';

function makeChapter(n: number, title: string, summary: string): Chapter {
  return {
    id: `ch-${n}`,
    number: n,
    title,
    summary,
    content: '',
  } as unknown as Chapter;
}

function makeMemory(): StoryMemory {
  return {
    pinnedFacts: [
      {
        id: 'fact-1',
        subject: '林越',
        text: '林越的佩剑「断霜」在第三折断成两截',
        status: 'pinned',
        validFromChapter: 1,
        sourceChapterNumber: 1,
      },
    ],
    plotThreads: [],
    spanDigests: [],
  } as unknown as StoryMemory;
}

function makeProject(): BookProject {
  return {
    id: 'p-emb-test',
    title: '向量检索测试书',
    chapters: [
      makeChapter(1, '雪夜', '林越在雪夜捡到断霜剑，剑身有旧裂纹'),
      makeChapter(2, '试炼', '宗门试炼开始，林越藏着断剑参赛'),
    ],
    memory: makeMemory(),
  } as unknown as BookProject;
}

type FetchHandler = (url: string, init?: RequestInit) => unknown;

function stubFetch(handler: FetchHandler) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => handler(url, init),
    }))
  );
}

const enabledConfig = {
  enabled: true,
  useSameAsLlm: false,
  baseURL: 'https://api.siliconflow.cn/v1',
  modelName: 'bge-m3',
  dimensions: null,
  hasKey: true,
  maskedKey: 'sk-****abcd',
  resolvedBaseURL: 'https://api.siliconflow.cn/v1',
  resolvedHasKey: true,
};

/** 固定向量：text 含 marker 时给高分量轴 1，否则给轴 2 */
function fakeVector(text: string): number[] {
  return text.includes('断霜') || text.includes('断剑') ? [0.9, 0.1] : [0.1, 0.9];
}

describe('embeddingIndex · 降级与真向量路径', () => {
  beforeEach(() => {
    invalidateEmbeddingConfigCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未启用 embedding → 降级本地 TF-IDF，结果形状与同步版一致', async () => {
    stubFetch(() => ({
      success: true,
      data: { ...enabledConfig, enabled: false },
    }));
    const project = makeProject();
    const res = await semanticBoostMapAsync('断霜剑的下落', {
      projectId: project.id,
      memory: project.memory,
      chapters: project.chapters,
      chapterNumber: 3,
    });
    expect(res.mode).toBe('local');
    expect(res.embeddedDocs).toBe(0);
    // 与同步 semanticBoostMap 同形状：factBoost 是 Map
    expect(res.factBoost).toBeInstanceOf(Map);
    expect(res.factBoost.size).toBeGreaterThan(0);
  });

  it('启用且 API 正常 → embedding 模式产出 boost；向量缓存后二次调用不再 embed', async () => {
    const project = makeProject();
    stubFetch((url, init) => {
      if (url.includes('/api/config/embedding')) {
        return { success: true, data: enabledConfig };
      }
      if (url.includes('/api/embedding/create')) {
        const body = JSON.parse(String(init?.body || '{}')) as { texts?: string[] };
        const texts = body.texts || [];
        return {
          success: true,
          data: { vectors: texts.map(fakeVector), model: 'bge-m3', dimensions: 2 },
        };
      }
      return { success: false, error: 'unknown' };
    });

    const first = await semanticBoostMapAsync('断霜剑的下落', {
      projectId: project.id,
      memory: project.memory,
      chapters: project.chapters,
      chapterNumber: 3,
    });
    expect(first.mode).toBe('embedding');
    expect(first.embeddedDocs).toBeGreaterThan(0);
    expect(first.factBoost.size).toBeGreaterThan(0);

    const second = await semanticBoostMapAsync('雪夜旧事', {
      projectId: project.id,
      memory: project.memory,
      chapters: project.chapters,
      chapterNumber: 3,
    });
    expect(second.mode).toBe('embedding');
    expect(second.embeddedDocs).toBe(0);
  });

  it('embedding 调用失败 → 整体降级 local，不抛错', async () => {
    stubFetch((url) => {
      if (url.includes('/api/config/embedding')) {
        return { success: true, data: enabledConfig };
      }
      return { success: false, error: 'quota exceeded' };
    });
    const project = makeProject();
    const res = await semanticBoostMapAsync('任意查询', {
      projectId: project.id,
      memory: project.memory,
      chapters: project.chapters,
      chapterNumber: 3,
    });
    expect(res.mode).toBe('local');
  });

  it('本地 TF-IDF 降级结果与 semanticBoostMap 同步版等价（语义加持仍生效）', async () => {
    stubFetch(() => ({ success: true, data: { ...enabledConfig, enabled: false } }));
    const project = makeProject();
    const params = {
      memory: project.memory,
      chapters: project.chapters,
      chapterNumber: 3,
    } as const;
    const sync = semanticBoostMap('断霜剑的下落', params);
    const async1 = await semanticBoostMapAsync('断霜剑的下落', {
      projectId: project.id,
      ...params,
    });
    expect([...async1.factBoost.entries()]).toEqual([...sync.factBoost.entries()]);
    expect(async1.relatedChapters.map((r) => r.chapter.id)).toEqual(
      sync.relatedChapters.map((r) => r.chapter.id)
    );
  });
});
