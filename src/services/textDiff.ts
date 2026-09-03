/**
 * 轻量正文 diff：按段落/行对比，供修复环展示「改了什么」。
 * 不做 Myers 全量 diff，优先可读性与体积。
 */

export interface DiffHunk {
  /** 变更类型 */
  kind: 'equal' | 'remove' | 'add' | 'replace';
  /** 改前片段（remove/replace） */
  before?: string;
  /** 改后片段（add/replace） */
  after?: string;
  /** 预览用短标签 */
  label: string;
}

export interface ProseDiffResult {
  identical: boolean;
  /** 前后去空白字数 */
  beforeChars: number;
  afterChars: number;
  charDelta: number;
  /** 有变化的 hunk 数 */
  changeCount: number;
  hunks: DiffHunk[];
  /** 一句话摘要 */
  summary: string;
}

function splitBlocks(text: string): string[] {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  // 优先双换行段落，否则按单行
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 2) return paras;
  return t.split('\n').map((l) => l.trim()).filter(Boolean);
}

function preview(s: string, max = 48): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…`;
}

/**
 * 基于 LCS 的块级 diff（块数通常 < 80，可接受 O(n*m)）。
 */
export function diffProseBlocks(before: string, after: string, maxHunks = 24): ProseDiffResult {
  const a = splitBlocks(before);
  const b = splitBlocks(after);
  const beforeChars = proseWords(before);
  const afterChars = proseWords(after);
  const charDelta = afterChars - beforeChars;

  if (before.trim() === after.trim()) {
    return {
      identical: true,
      beforeChars,
      afterChars,
      charDelta: 0,
      changeCount: 0,
      hunks: [],
      summary: '正文无实质变化',
    };
  }

  const n = a.length;
  const m = b.length;
  // LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const raw: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'equal', before: a[i], after: b[j], label: preview(a[i], 32) });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: 'remove', before: a[i], label: `删：${preview(a[i])}` });
      i++;
    } else {
      raw.push({ kind: 'add', after: b[j], label: `增：${preview(b[j])}` });
      j++;
    }
  }
  while (i < n) {
    raw.push({ kind: 'remove', before: a[i], label: `删：${preview(a[i])}` });
    i++;
  }
  while (j < m) {
    raw.push({ kind: 'add', after: b[j], label: `增：${preview(b[j])}` });
    j++;
  }

  // 合并相邻 remove+add 为 replace
  const merged: DiffHunk[] = [];
  for (let k = 0; k < raw.length; k++) {
    const cur = raw[k];
    const next = raw[k + 1];
    if (cur.kind === 'remove' && next?.kind === 'add') {
      merged.push({
        kind: 'replace',
        before: cur.before,
        after: next.after,
        label: `改：${preview(cur.before || '')} → ${preview(next.after || '')}`,
      });
      k++;
    } else if (cur.kind !== 'equal') {
      merged.push(cur);
    }
    // equal 默认不展示，减噪；若全程只有 equal 已在 identical 处理
  }

  const changes = merged.filter((h) => h.kind !== 'equal').slice(0, maxHunks);
  const changeCount = changes.length;
  const summaryParts: string[] = [];
  if (changeCount > 0) summaryParts.push(`${changeCount} 处块级变更`);
  if (charDelta !== 0) {
    summaryParts.push(charDelta > 0 ? `+${charDelta} 字` : `${charDelta} 字`);
  }
  if (changes.length < merged.filter((h) => h.kind !== 'equal').length) {
    summaryParts.push('已截断展示');
  }

  return {
    identical: changeCount === 0 && charDelta === 0,
    beforeChars,
    afterChars,
    charDelta,
    changeCount,
    hunks: changes,
    summary: summaryParts.join(' · ') || '有微调',
  };
}

/** 单条局部补丁失败详情（供 UI/日志定位，避免"静默失败"） */
export interface LocalPatchFailure {
  /** 未命中的原文片段（截断到 60 字符） */
  before: string;
  reason: 'empty_before' | 'not_found';
}

/** 应用模型返回的局部替换（先精确匹配，失败则跳过该条并记录原因） */
export function applyLocalPatches(
  prose: string,
  patches: { before?: string; after?: string }[]
): {
  text: string;
  applied: number;
  failed: number;
  failedDetails: LocalPatchFailure[];
} {
  let text = prose;
  let applied = 0;
  let failed = 0;
  const failedDetails: LocalPatchFailure[] = [];
  for (const p of patches) {
    const before = (p.before || '').trim();
    const after = p.after ?? '';
    if (!before) {
      failed++;
      failedDetails.push({ before: '', reason: 'empty_before' });
      continue;
    }
    if (!text.includes(before)) {
      failed++;
      failedDetails.push({ before: before.slice(0, 60), reason: 'not_found' });
      continue;
    }
    // 只替换首次出现，避免误伤
    text = text.replace(before, after);
    applied++;
  }
  return { text, applied, failed, failedDetails };
}import { proseWords } from './proseWords';

