/**
 * 本地「语义」检索（无外网 embedding、无 Chroma）：
 * - 中文 n-gram + 英文词 + TF-IDF 向量余弦
 * - 覆盖：钉死事实 / 伏笔 / 章 recap / digest
 * - 写前与词项/角色索引叠加，解决「换说法捞不到」
 *
 * 非真·深度学习 embedding，但是开源长篇常用的工程折中（可后续换 API embedding）。
 */

import { proseWords } from './proseWords';
import type { Chapter, PinnedFact, StoryMemory } from '../types/novel';
import { listActiveFacts, listActiveThreads, normalizeStoryMemory } from './storyMemory';

function factValidAt(f: PinnedFact, chapterNumber: number): boolean {
  if (f.status !== 'pinned') return false;
  const from = f.validFromChapter ?? f.sourceChapterNumber ?? 0;
  if (from > chapterNumber) return false;
  if (
    f.validUntilChapter != null &&
    f.validUntilChapter > 0 &&
    chapterNumber >= f.validUntilChapter
  ) {
    return false;
  }
  return true;
}

export type SemanticDocKind = 'fact' | 'thread' | 'chapter' | 'digest';

export interface SemanticDoc {
  id: string;
  kind: SemanticDocKind;
  text: string;
  /** 关联章号（用于衰减/展示） */
  chapterNumber?: number;
  refId: string;
}

export interface SemanticHit {
  doc: SemanticDoc;
  score: number;
}

const STOP = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很',
  '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '他', '她',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
]);

/** 分词：英文词 + 中文 2～3 gram */
export function tokenize(text: string): string[] {
  const t = (text || '').toLowerCase().replace(/第\d+章/g, ' ');
  const tokens: string[] = [];
  const en = t.match(/[a-z]{3,}/g) || [];
  for (const w of en) {
    if (!STOP.has(w)) tokens.push(w);
  }
  const cn = t.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cn) {
    if (seg.length === 1) {
      if (!STOP.has(seg)) tokens.push(seg);
      continue;
    }
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= seg.length; i++) {
        const g = seg.slice(i, i + n);
        if (!STOP.has(g)) tokens.push(g);
      }
    }
    if (seg.length >= 2 && seg.length <= 6) tokens.push(seg);
  }
  return tokens;
}

function tfMap(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  const len = tokens.length || 1;
  for (const [k, v] of m) m.set(k, v / len);
  return m;
}

function cosine(
  a: Map<string, number>,
  b: Map<string, number>,
  idf: Map<string, number>
): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const wa = (a.get(k) || 0) * (idf.get(k) || 0);
    const wb = (b.get(k) || 0) * (idf.get(k) || 0);
    dot += wa * wb;
    na += wa * wa;
    nb += wb * wb;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function buildSemanticCorpus(params: {
  memory?: StoryMemory | null;
  chapters?: Chapter[];
  chapterNumber?: number;
}): SemanticDoc[] {
  const memory = normalizeStoryMemory(params.memory || undefined);
  const chNum = params.chapterNumber ?? 99999;
  const docs: SemanticDoc[] = [];

  for (const f of listActiveFacts(memory)) {
    if (params.chapterNumber != null && !factValidAt(f, chNum)) continue;
    docs.push({
      id: `fact:${f.id}`,
      kind: 'fact',
      refId: f.id,
      text: `${f.subject || ''} ${f.text} ${f.note || ''}`,
      chapterNumber: f.sourceChapterNumber ?? f.validFromChapter,
    });
  }
  for (const t of listActiveThreads(memory)) {
    docs.push({
      id: `thread:${t.id}`,
      kind: 'thread',
      refId: t.id,
      text: `${t.text} ${t.note || ''} ${t.seedExcerpt || ''}`,
      chapterNumber: t.lastTouchedChapterNumber ?? t.introducedChapterNumber,
    });
  }
  for (const d of memory.spanDigests || []) {
    if (d.toChapter >= chNum) continue;
    docs.push({
      id: `digest:${d.id}`,
      kind: 'digest',
      refId: d.id,
      text: `${d.title} ${d.summary} ${d.keyFacts.join(' ')} ${d.openHooks.join(' ')}`,
      chapterNumber: d.toChapter,
    });
  }
  for (const c of params.chapters || []) {
    if (c.number >= chNum) continue;
    const body = [
      c.title,
      c.summary,
      c.recap?.text,
      c.recap?.endingState,
      ...(c.recap?.keyFacts || []),
      ...(c.recap?.openThreads || []),
    ]
      .filter(Boolean)
      .join(' ');
    if (proseWords(body) < 20) continue;
    docs.push({
      id: `chapter:${c.id}`,
      kind: 'chapter',
      refId: c.id,
      text: body,
      chapterNumber: c.number,
    });
  }
  return docs;
}

/**
 * TF-IDF 检索。query 可用意图/梗概/标题拼接。
 */
export function semanticSearch(
  query: string,
  docs: SemanticDoc[],
  options?: { topK?: number; kind?: SemanticDocKind | SemanticDocKind[] }
): SemanticHit[] {
  const topK = options?.topK ?? 12;
  const kinds = options?.kind
    ? new Set(Array.isArray(options.kind) ? options.kind : [options.kind])
    : null;
  const pool = kinds ? docs.filter((d) => kinds.has(d.kind)) : docs;
  if (!query.trim() || pool.length === 0) return [];

  const docsTokens = pool.map((d) => tokenize(d.text));
  const df = new Map<string, number>();
  for (const toks of docsTokens) {
    const uniq = new Set(toks);
    for (const t of uniq) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = pool.length;
  const idf = new Map<string, number>();
  for (const [t, c] of df) {
    idf.set(t, Math.log(1 + N / (1 + c)) + 1);
  }

  const qVec = tfMap(tokenize(query));
  const hits: SemanticHit[] = [];
  for (let i = 0; i < pool.length; i++) {
    const score = cosine(qVec, tfMap(docsTokens[i]), idf);
    if (score > 0.02) hits.push({ doc: pool[i], score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/** 便捷：从项目材料一次搜完 */
export function semanticSearchProject(
  query: string,
  params: {
    memory?: StoryMemory | null;
    chapters?: Chapter[];
    chapterNumber?: number;
    topK?: number;
    kind?: SemanticDocKind | SemanticDocKind[];
  }
): SemanticHit[] {
  const docs = buildSemanticCorpus(params);
  return semanticSearch(query, docs, { topK: params.topK, kind: params.kind });
}

/** 相关历史章推荐（写前可贴进 prompt） */
export function recommendRelatedChapters(
  query: string,
  chapters: Chapter[],
  chapterNumber: number,
  topK = 3
): { chapter: Chapter; score: number }[] {
  const docs = buildSemanticCorpus({ chapters, chapterNumber });
  const hits = semanticSearch(query, docs, { topK: topK * 3, kind: 'chapter' });
  const out: { chapter: Chapter; score: number }[] = [];
  const byId = new Map(chapters.map((c) => [c.id, c]));
  for (const h of hits) {
    const ch = byId.get(h.doc.refId);
    if (!ch || ch.number >= chapterNumber) continue;
    out.push({ chapter: ch, score: h.score });
    if (out.length >= topK) break;
  }
  return out;
}

export function formatRelatedChaptersForPrompt(
  related: { chapter: Chapter; score: number }[]
): string {
  if (!related.length) return '';
  const lines = ['【语义相关历史章（可回读细节；勿整章复述）】'];
  for (const { chapter: c, score } of related) {
    const one =
      c.recap?.text?.replace(/\s+/g, ' ').slice(0, 100) ||
      c.summary?.replace(/\s+/g, ' ').slice(0, 100) ||
      '（无摘要）';
    lines.push(
      `- 第${c.number}章《${c.title}》·相关度${score.toFixed(2)}：${one}${one.length >= 100 ? '…' : ''}`
    );
  }
  return lines.join('\n');
}

/** 语义打分结果（TF-IDF 与真·embedding 两种后端共用同一形状） */
export interface SemanticBoostMaps {
  factBoost: Map<string, number>;
  threadBoost: Map<string, number>;
  digestBoost: Map<string, number>;
  relatedChapters: { chapter: Chapter; score: number }[];
}

/** 将语义分合并进业务打分（0～1 语义 → 加成） */
export function semanticBoostMap(
  query: string,
  params: {
    memory?: StoryMemory | null;
    chapters?: Chapter[];
    chapterNumber?: number;
  }
): SemanticBoostMaps {
  const docs = buildSemanticCorpus(params);
  const hits = semanticSearch(query, docs, { topK: 40 });
  const factBoost = new Map<string, number>();
  const threadBoost = new Map<string, number>();
  const digestBoost = new Map<string, number>();
  for (const h of hits) {
    const b = h.score * 10; // 量级对齐词项分
    if (h.doc.kind === 'fact') factBoost.set(h.doc.refId, b);
    else if (h.doc.kind === 'thread') threadBoost.set(h.doc.refId, b);
    else if (h.doc.kind === 'digest') digestBoost.set(h.doc.refId, b);
  }
  const relatedChapters = recommendRelatedChapters(
    query,
    params.chapters || [],
    params.chapterNumber ?? 99999,
    3
  );
  return { factBoost, threadBoost, digestBoost, relatedChapters };
}
