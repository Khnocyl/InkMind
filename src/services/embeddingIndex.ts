/**
 * 真·向量语义检索（Embedding 后端）。
 *
 * 职责：写章主链路（useChapterPipeline）在记忆检索前，先经本模块用配置的
 * Embedding API 对「事实/伏笔/digest/历史章」语料做向量检索，产出与
 * semanticIndex.semanticBoostMap 同形状的打分结果；未配置/调用失败时
 * 自动降级为本地 TF-IDF（semanticIndex），写作流程不中断。
 *
 * 成本设计：
 * - 文档向量按 (projectId, 模型名) 缓存于 IndexedDB meta store，正文文本
 *   未变的文档不重复 embedding（增量只 embed 新/变更文档）；
 * - 每次检索仅 embed 1 条 query；
 * - 同一项目的并发检索共享同一个 in-flight Promise，防 Auto-Pilot 重入双打。
 */
import { getEmbeddingConfig } from './llmClient';
import {
  buildSemanticCorpus,
  semanticBoostMap,
  type SemanticBoostMaps,
} from './semanticIndex';
import type { Chapter, StoryMemory } from '../types/novel';
import { initDB, STORE_META } from './storage';
import {
  buildMemoryQueryBlob,
  retrieveMemoryForChapter,
  type MemoryQueryInput,
  type MemoryRetrievalResult,
} from './memoryRetrieval';

export type SemanticSearchMode = 'embedding' | 'local';

export interface SemanticBoostResult extends SemanticBoostMaps {
  mode: SemanticSearchMode;
  /** 本后端一次执行中实际新 embed 的文档数（0 = 全部命中缓存） */
  embeddedDocs: number;
}

// ─── 配置探测（短 TTL 缓存）────────────────────────────────────────────

const CONFIG_TTL_MS = 60_000;
let configCache: { at: number; enabled: boolean } | null = null;

/** Embedding 是否可用于检索（enabled 且解析出的 Key/BaseURL/模型齐备） */
export async function isEmbeddingSearchEnabled(): Promise<boolean> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return configCache.enabled;
  }
  try {
    const cfg = await getEmbeddingConfig();
    const enabled =
      cfg.enabled &&
      !!cfg.resolvedBaseURL &&
      cfg.resolvedHasKey &&
      !!cfg.modelName.trim();
    configCache = { at: Date.now(), enabled };
    return enabled;
  } catch {
    // 配置接口失败（后端未起等）：按未启用处理，不打断写作
    configCache = { at: Date.now(), enabled: false };
    return false;
  }
}

/** 清除配置缓存（保存向量配置后可调用以立即生效） */
export function invalidateEmbeddingConfigCache(): void {
  configCache = null;
}

// ─── Embedding API 调用 ────────────────────────────────────────────────

async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await fetch('/api/embedding/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Embedding 调用失败');
  const vectors: unknown = data.data?.vectors;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error('Embedding 返回向量数量与输入不一致');
  }
  return vectors as number[][];
}

// ─── 向量缓存（IndexedDB meta store）───────────────────────────────────

interface CachedVec {
  /** 文本哈希（djb2），变更即失效重 embed */
  h: number;
  v: Float32Array;
}
interface ProjectVecCache {
  model: string;
  entries: Record<string, CachedVec>;
}

const memCaches = new Map<string, ProjectVecCache>();
/** 同项目并发的检索请求共享执行，防止重复 embed */
const inFlight = new Map<string, Promise<SemanticBoostResult>>();

function hashText(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return h ^ text.length;
}

function cacheKey(projectId: string, model: string): string {
  return `embvec:${projectId}:${model}`;
}

async function loadVecCache(
  projectId: string,
  model: string
): Promise<ProjectVecCache> {
  const key = cacheKey(projectId, model);
  const mem = memCaches.get(key);
  if (mem) return mem;
  try {
    const db = await initDB();
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
    const parsed = value as ProjectVecCache | null;
    if (parsed && parsed.model === model && parsed.entries) {
      memCaches.set(key, parsed);
      return parsed;
    }
  } catch {
    // 缓存读失败不致命：退化为全量 embed
  }
  const fresh: ProjectVecCache = { model, entries: {} };
  memCaches.set(key, fresh);
  return fresh;
}

async function saveVecCache(projectId: string, cache: ProjectVecCache): Promise<void> {
  const key = cacheKey(projectId, cache.model);
  memCaches.set(key, cache);
  try {
    const db = await initDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put({ key, value: cache });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // 缓存写失败不致命：下次多 embed 一轮
  }
}

// ─── 向量检索本体 ──────────────────────────────────────────────────────

function cosineVec(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const EMBED_BATCH = 24;

async function semanticBoostViaEmbedding(
  query: string,
  params: {
    projectId: string;
    memory?: StoryMemory | null;
    chapters?: Chapter[];
    chapterNumber?: number;
  }
): Promise<SemanticBoostResult> {
  const cfg = await getEmbeddingConfig();
  const model = cfg.modelName.trim();
  const docs = buildSemanticCorpus({
    memory: params.memory,
    chapters: params.chapters,
    chapterNumber: params.chapterNumber,
  });
  if (!query.trim() || docs.length === 0) {
    throw new Error('空 query 或空语料');
  }

  const cache = await loadVecCache(params.projectId, model);
  const need: { idx: number; id: string; text: string }[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const hit = cache.entries[d.id];
    if (!hit || hit.h !== hashText(d.text)) {
      need.push({ idx: i, id: d.id, text: d.text });
    }
  }

  // 增量 embed 缺失文档（顺序分批，失败整体降级本地——不半混两种后端）
  for (let b = 0; b < need.length; b += EMBED_BATCH) {
    const batch = need.slice(b, b + EMBED_BATCH);
    const vectors = await embedTexts(batch.map((x) => x.text.slice(0, 4000)));
    batch.forEach((x, j) => {
      const v = vectors[j];
      if (!Array.isArray(v) || !v.length) return;
      cache.entries[x.id] = { h: hashText(x.text), v: new Float32Array(v) };
    });
  }
  if (need.length > 0) {
    await saveVecCache(params.projectId, cache);
  }

  const [queryVecRaw] = await embedTexts([query.slice(0, 2000)]);
  const queryVec = new Float32Array(queryVecRaw);

  const raw = docs.map((d) => {
    const e = cache.entries[d.id];
    return e ? cosineVec(queryVec, e.v) : 0;
  });
  // 用真实余弦相似度（负数截 0），不做 min-max 归一——
  // 归一化会让最高分恒为 1.0，与真实相似度脱钩、无关查询也推满权重。
  const norm = raw.map((s) => Math.max(0, s));

  const factBoost = new Map<string, number>();
  const threadBoost = new Map<string, number>();
  const digestBoost = new Map<string, number>();
  docs.forEach((d, i) => {
    const s = norm[i];
    if (s <= 0.02) return;
    const b = s * 10; // 量级对齐 TF-IDF 路径的语义加成
    if (d.kind === 'fact') factBoost.set(d.refId, b);
    else if (d.kind === 'thread') threadBoost.set(d.refId, b);
    else if (d.kind === 'digest') digestBoost.set(d.refId, b);
  });

  const byId = new Map((params.chapters || []).map((c) => [c.id, c]));
  const chapterHits = docs
    .map((d, i) => ({ d, s: norm[i] }))
    .filter((x) => x.d.kind === 'chapter' && x.s > 0.3)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .flatMap((x) => {
      const ch = byId.get(x.d.refId);
      return ch ? [{ chapter: ch, score: x.s }] : [];
    });

  return {
    factBoost,
    threadBoost,
    digestBoost,
    relatedChapters: chapterHits,
    mode: 'embedding',
    embeddedDocs: need.length,
  };
}

/**
 * 语义打分（带真·embedding 后端 + 本地 TF-IDF 降级）。
 * 返回形状与 semanticIndex.semanticBoostMap 一致，另带 mode 标记。
 */
export async function semanticBoostMapAsync(
  query: string,
  params: {
    projectId: string;
    memory?: StoryMemory | null;
    chapters?: Chapter[];
    chapterNumber?: number;
  }
): Promise<SemanticBoostResult> {
  const localFallback = (): SemanticBoostResult => ({
    ...semanticBoostMap(query, {
      memory: params.memory,
      chapters: params.chapters,
      chapterNumber: params.chapterNumber,
    }),
    mode: 'local',
    embeddedDocs: 0,
  });

  if (!(await isEmbeddingSearchEnabled())) return localFallback();

  // 同项目同查询去重并发（Auto-Pilot/连写重入）。
  // 键须含 query：仅按 projectId 会让不同 query 的并发检索互相串结果。
  const flightKey = `${params.projectId}\u0000${query}`;
  const existing = inFlight.get(flightKey);
  if (existing) return existing;

  const task = semanticBoostViaEmbedding(query, params)
    .catch((err) => {
      console.warn(
        `[embeddingIndex] 向量检索失败，已降级本地 TF-IDF:`,
        err instanceof Error ? err.message : err
      );
      return localFallback();
    })
    .finally(() => {
      inFlight.delete(flightKey);
    });
  inFlight.set(flightKey, task);
  return task;
}

/**
 * retrieveMemoryForChapter 的异步增强版：embedding 可用时用真·向量打分，
 * 否则与同步版完全一致。写章主链路请用本函数。
 */
export async function retrieveMemoryForChapterAsync(
  input: MemoryQueryInput & { projectId?: string }
): Promise<MemoryRetrievalResult> {
  if (!input.projectId || input.disableSemantic === true) {
    return retrieveMemoryForChapter(input);
  }
  const queryBlob = buildMemoryQueryBlob(input);
  const semantic = await semanticBoostMapAsync(queryBlob, {
    projectId: input.projectId,
    memory: input.memory,
    chapters: input.allChapters || [],
    chapterNumber: input.chapterNumber ?? input.chapter.number,
  });
  return retrieveMemoryForChapter({
    ...input,
    ...(semantic.mode === 'embedding' ? { semantic } : {}),
  });
}
