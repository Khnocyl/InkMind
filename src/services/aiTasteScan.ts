/**
 * AI 味扩展机检（对齐 story-deslop Gate B/D/G + 密度分级）。
 * 可复现、不调 LLM；与 ruleScan 黑名单/升华互补。
 */

import type { StyleConfig } from '../types/novel';
import type { RuleHit, RuleHitSeverity } from './ruleScan';

export type AiTasteTier = 'clean' | 'light' | 'medium' | 'heavy';

export type AiTasteGate = 'B' | 'C' | 'D' | 'E' | 'G';

export interface AiTasteMetrics {
  /** 去空白字数 */
  chars: number;
  /** 段数 */
  paragraphs: number;
  /** 句数（粗） */
  sentences: number;
  /** 段均句数 */
  avgSentencesPerPara: number;
  /** 段长方差（字数），过低=节奏过匀 */
  paraLenVariance: number;
  /** 对话句数 */
  dialogueLines: number;
  /** 说道/问道 类标签数 */
  dialogueTags: number;
  dialogueTagRatio: number;
  /** 连续排比起势段数 */
  parallelRuns: number;
  /** 解释腔命中 */
  expositionHits: number;
  /** 句式套路命中 */
  formulaHits: number;
}

export interface AiTasteReport {
  tier: AiTasteTier;
  /** 0–100，越高越干净 */
  score: number;
  hits: RuleHit[];
  metrics: AiTasteMetrics;
  summary: string;
  /** 若开启严格模式，重度可阻断绿通 */
  blockGreen: boolean;
}

/** 扩展套话（叠到默认黑名单，可被白名单豁免） */
export const EXTENDED_CLICHE_PHRASES: string[] = [
  '眼中闪过一丝',
  '眼底闪过一丝',
  '嘴角勾起一抹',
  '嘴角微微上扬',
  '不禁',
  '缓缓开口',
  '若有所思',
  '心头一紧',
  '眉头微蹙',
  '目光深邃',
  '意味深长',
  '默然不语',
  '沉默片刻',
  '空气仿佛凝固',
  '时间仿佛静止',
  '整个人都愣住了',
  '震惊得说不出话',
  '一股莫名的',
  '说不出的感觉',
  '与此同时',
  '与此同时，',
];

/** Gate G：解释腔 / 上帝感 */
const EXPOSITION_PATTERNS: { re: RegExp; phrase: string; suggestion: string }[] = [
  {
    re: /她?他?不知道的是/g,
    phrase: '她/他不知道的是',
    suggestion: '删上帝剧透，用角色当下动作呈现。',
  },
  {
    re: /殊不知/g,
    phrase: '殊不知',
    suggestion: '删旁白剧透，让读者自己拼因果。',
  },
  {
    re: /之所以[^。]{0,24}是因为/g,
    phrase: '之所以…是因为',
    suggestion: '删解释腔，用行动结果展示因果。',
  },
  {
    re: /这意味着/g,
    phrase: '这意味着',
    suggestion: '删叙述者定性，改成角色反应或物件细节。',
  },
  {
    re: /仿佛预示着/g,
    phrase: '仿佛预示着',
    suggestion: '删安排感，停在具体动作。',
  },
  {
    re: /多年以后[^。]{0,20}/g,
    phrase: '多年以后…',
    suggestion: '删时间跳跃剧透旁白（除非刻意闪前且有标记）。',
  },
  {
    re: /原来[，,]?[^。]{2,20}只是/g,
    phrase: '原来…只是',
    suggestion: '删揭底旁白，改角色发现过程。',
  },
];

/** Gate B：句式套路 */
const FORMULA_PATTERNS: {
  re: RegExp;
  phrase: string;
  severity: RuleHitSeverity;
  suggestion: string;
}[] = [
  {
    re: /不是[^。，]{1,16}[，,]?\s*而是/g,
    phrase: '不是…而是…',
    severity: 'warn',
    suggestion: '否定铺垫翻转：直接写后项，或改成动作/细节。',
  },
  {
    re: /并非[^。，]{1,16}[，,]?\s*而是/g,
    phrase: '并非…而是…',
    severity: 'warn',
    suggestion: '否定翻转句式：删铺垫，直接写事实。',
  },
  {
    re: /[^。\n]{2,20}[，,]\s*带着[^。\n]{2,16}/g,
    phrase: '…，带着…',
    severity: 'warn',
    suggestion: '万能状语：拆成短句或动作描写。',
  },
  {
    re: /声音不大[，,]?\s*却/g,
    phrase: '声音不大，却…',
    severity: 'warn',
    suggestion: 'AI 爱用声音公式：直接写音质或动作。',
  },
  {
    re: /[他她]知道[，,：:]/g,
    phrase: '他/她知道…',
    severity: 'warn',
    suggestion: '直接告知认知：改为行为展示。',
  },
  {
    re: /不容置疑|显而易见|毋庸置疑/g,
    phrase: '不容置疑/显而易见',
    severity: 'warn',
    suggestion: '书面判断词：用具体事实说话。',
  },
];

function countMatches(re: RegExp, text: string): { count: number; sample?: string } {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const r = new RegExp(re.source, flags);
  let count = 0;
  let sample: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    count += 1;
    if (!sample) sample = m[0].slice(0, 40);
    if (count > 50) break;
  }
  return { count, sample };
}

function isWhitelisted(phrase: string, sample: string | undefined, whitelist: string[]): boolean {
  if (!whitelist.length) return false;
  const blob = `${phrase}${sample || ''}`;
  return whitelist.some((w) => {
    const t = w.trim();
    return t.length >= 1 && (blob.includes(t) || phrase.includes(t));
  });
}

function filterWhitelist(hits: RuleHit[], whitelist: string[]): RuleHit[] {
  if (!whitelist.length) return hits;
  return hits.filter((h) => !isWhitelisted(h.phrase, h.sample, whitelist));
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function countSentences(para: string): number {
  const parts = para.split(/[。！？!?]+/).filter((s) => s.trim().length > 0);
  return Math.max(1, parts.length);
}

function variance(nums: number[]): number {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const v = nums.reduce((s, n) => s + (n - mean) ** 2, 0) / nums.length;
  return v;
}

/** 连续多段以相同主语+逗号结构起句 → 排比 */
function countParallelRuns(paragraphs: string[]): number {
  let runs = 0;
  let streak = 1;
  let prevKey = '';
  for (const p of paragraphs) {
    const m = p.match(/^([\u4e00-\u9fff]{1,3})([，,、])/);
    const key = m ? `${m[1]}|${m[2]}` : '';
    if (key && key === prevKey) {
      streak += 1;
      if (streak === 3) runs += 1;
    } else {
      streak = 1;
      prevKey = key;
    }
  }
  return runs;
}

/**
 * 扫描 AI 味句式 / 节奏 / 解释腔（Gate B/C/D/E/G 本地子集）。
 */
export function scanAiTastePatterns(
  prose: string,
  styleConfig?: StyleConfig | null
): AiTasteReport {
  const text = prose || '';
  const whitelist = [
    ...(styleConfig?.deslopWhitelist || []),
    ...(styleConfig?.aiTasteWhitelist || []),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const strict = styleConfig?.aiTasteStrict === true;
  const blockHeavy = styleConfig?.aiTasteBlockHeavy === true;

  const chars = text.replace(/\s+/g, '').length;
  const paragraphs = splitParagraphs(text);
  const paraLens = paragraphs.map((p) => p.replace(/\s+/g, '').length);
  const sentenceCounts = paragraphs.map(countSentences);
  const sentences = sentenceCounts.reduce((a, b) => a + b, 0);
  const avgSentencesPerPara =
    paragraphs.length > 0 ? sentences / paragraphs.length : 0;
  const paraLenVariance = variance(paraLens);

  // 对话
  const dialogueLines = (text.match(/[「“"].*?[」”"]/gs) || []).length;
  const dialogueTags = countMatches(
    /([说道]|问道|笑道|怒道|冷道|喝道|喊道|答道|叹道)/g,
    text
  ).count;
  const dialogueTagRatio =
    dialogueLines > 0 ? dialogueTags / Math.max(dialogueLines, 1) : 0;

  const parallelRuns = countParallelRuns(paragraphs);

  let hits: RuleHit[] = [];

  // Gate G
  for (const p of EXPOSITION_PATTERNS) {
    const { count, sample } = countMatches(p.re, text);
    if (count <= 0) continue;
    hits.push({
      kind: 'pattern',
      severity: strict ? 'error' : 'warn',
      phrase: `[G]${p.phrase}`,
      count,
      sample,
      suggestion: p.suggestion,
    });
  }

  // Gate B
  for (const p of FORMULA_PATTERNS) {
    const { count, sample } = countMatches(p.re, text);
    if (count <= 0) continue;
    let severity = p.severity;
    // 否定翻转多次 → 升 error
    if (
      (p.phrase.includes('不是') || p.phrase.includes('并非')) &&
      count >= 2
    ) {
      severity = 'error';
    }
    if (strict && count >= 3) severity = 'error';
    hits.push({
      kind: 'pattern',
      severity,
      phrase: `[B]${p.phrase}`,
      count,
      sample,
      suggestion: p.suggestion,
    });
  }

  // Gate D 节奏
  if (paragraphs.length >= 4 && avgSentencesPerPara > 5) {
    hits.push({
      kind: 'pattern',
      severity: 'warn',
      phrase: '[D]段均句数过高',
      count: Math.round(avgSentencesPerPara * 10) / 10,
      sample: `段均约 ${avgSentencesPerPara.toFixed(1)} 句`,
      suggestion: '打碎节奏：长短段交错，拆长句，避免段段均匀。',
    });
  }
  if (
    paragraphs.length >= 5 &&
    paraLenVariance < 80 &&
    paraLens.every((n) => n > 40)
  ) {
    hits.push({
      kind: 'pattern',
      severity: 'warn',
      phrase: '[D]段落长度过于均匀',
      count: 1,
      sample: `方差≈${Math.round(paraLenVariance)}`,
      suggestion: '加入短段/单句段，打破整齐块状节奏。',
    });
  }
  if (parallelRuns > 0) {
    hits.push({
      kind: 'pattern',
      severity: parallelRuns >= 2 ? 'error' : 'warn',
      phrase: '[D]连续排比起句',
      count: parallelRuns,
      suggestion: '打断连续排比，最多保留 1–2 个对仗。',
    });
  }

  // Gate E 对话标签
  if (dialogueLines >= 4 && dialogueTagRatio > 0.55) {
    hits.push({
      kind: 'pattern',
      severity: 'warn',
      phrase: '[E]对话标签过密',
      count: dialogueTags,
      sample: `标签/对话≈${(dialogueTagRatio * 100).toFixed(0)}%`,
      suggestion: '用动作/换行替代部分「说道/问道」。',
    });
  }

  hits = filterWhitelist(hits, whitelist);

  const formulaHits = hits
    .filter((h) => h.phrase.startsWith('[B]'))
    .reduce((s, h) => s + h.count, 0);
  const expositionHits = hits
    .filter((h) => h.phrase.startsWith('[G]'))
    .reduce((s, h) => s + h.count, 0);

  const metrics: AiTasteMetrics = {
    chars,
    paragraphs: paragraphs.length,
    sentences,
    avgSentencesPerPara,
    paraLenVariance,
    dialogueLines,
    dialogueTags,
    dialogueTagRatio,
    parallelRuns,
    expositionHits,
    formulaHits,
  };

  // 分级（参考 deslop：取最高档）
  // 用对象持有 tier：避免 TS 将 let 收窄为初始字面量，导致后续比较报“无重叠”
  const tierState: { tier: AiTasteTier } = { tier: 'clean' };
  const perK = chars > 0 ? (formulaHits + expositionHits) / (chars / 1000) : 0;

  const bump = (t: AiTasteTier) => {
    const order: AiTasteTier[] = ['clean', 'light', 'medium', 'heavy'];
    if (order.indexOf(t) > order.indexOf(tierState.tier)) tierState.tier = t;
  };

  if (perK > 15 || parallelRuns >= 2 || expositionHits >= 4) bump('heavy');
  else if (perK > 6 || parallelRuns >= 1 || expositionHits >= 2 || avgSentencesPerPara > 5)
    bump('medium');
  else if (perK > 0 || dialogueTagRatio > 0.55 || hits.some((h) => h.severity === 'warn'))
    bump('light');

  if (hits.some((h) => h.severity === 'error' && h.count >= 3)) bump('heavy');
  if (hits.some((h) => h.severity === 'error')) bump('medium');

  let score = 100;
  for (const h of hits) {
    if (h.severity === 'error') score -= 10 * Math.min(h.count, 3);
    else score -= 4 * Math.min(h.count, 3);
  }
  if (tierState.tier === 'heavy') score = Math.min(score, 55);
  if (tierState.tier === 'medium') score = Math.min(score, 75);
  score = Math.max(0, Math.min(100, score));

  const blockGreen = blockHeavy && tierState.tier === 'heavy';

  const parts: string[] = [];
  if (tierState.tier === 'clean') parts.push('AI味扩展检：干净');
  else parts.push(`AI味 ${tierState.tier}`);
  if (formulaHits) parts.push(`句式${formulaHits}`);
  if (expositionHits) parts.push(`解释腔${expositionHits}`);
  if (parallelRuns) parts.push(`排比${parallelRuns}`);
  if (blockGreen) parts.push('重度阻断');

  return {
    tier: tierState.tier,
    score,
    hits,
    metrics,
    summary: parts.join(' · '),
    blockGreen,
  };
}

/**
 * 合并扩展词表到黑名单扫描用列表（去重）；白名单条目不加入。
 */
export function mergeExtendedBlacklist(
  styleConfig: StyleConfig | null | undefined
): string[] {
  const base = [
    ...(styleConfig?.clicheBlacklist || []),
    ...(styleConfig?.customBlacklist || []),
  ];
  const wl = new Set(
    [...(styleConfig?.deslopWhitelist || []), ...(styleConfig?.aiTasteWhitelist || [])].map(
      (s) => s.trim()
    )
  );
  const extra =
    styleConfig?.useExtendedClicheList === false ? [] : EXTENDED_CLICHE_PHRASES;
  const all = [...base, ...extra];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of all) {
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    if ([...wl].some((w) => w && t.includes(w))) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 将 AI 味命中并入 ruleScan hits，并可选因重度阻断 */
export function mergeAiTasteIntoRuleHits(
  baseHits: RuleHit[],
  taste: AiTasteReport
): RuleHit[] {
  const map = new Map<string, RuleHit>();
  for (const h of [...baseHits, ...taste.hits]) {
    const key = `${h.kind}::${h.phrase}`;
    const prev = map.get(key);
    if (!prev || h.count > prev.count) map.set(key, h);
  }
  return [...map.values()];
}

export type RuleScanHitLike = {
  kind: string;
  severity: 'error' | 'warn';
  phrase: string;
  count: number;
  sample?: string;
  suggestion: string;
};

/**
 * 将机检/AI味命中写入章待修（medium/heavy 或 error 优先）。
 */
export function applyAiTasteHitsAsRevisionTodos(
  chapter: import('../types/novel').Chapter,
  hits: RuleScanHitLike[],
  options?: {
    tier?: string;
    /** 默认 true：仅 error；false 时 medium+ 也写 warn */
    errorsOnly?: boolean;
    max?: number;
  }
): { chapter: import('../types/novel').Chapter; added: number } {
  const tier = options?.tier || 'clean';
  const errorsOnly = options?.errorsOnly !== false;
  const max = options?.max ?? 12;
  const now = new Date().toISOString();

  let list = hits.filter((h) =>
    errorsOnly ? h.severity === 'error' : h.severity === 'error' || h.severity === 'warn'
  );
  // medium/heavy：即使 errorsOnly，也带上 pattern/blacklist 的 warn（最多）
  if (
    errorsOnly &&
    (tier === 'medium' || tier === 'heavy') &&
    list.length < 3
  ) {
    const extra = hits
      .filter((h) => h.severity === 'warn')
      .slice(0, 4);
    list = [...list, ...extra];
  }
  if (!list.length) {
    return { chapter, added: 0 };
  }

  const existing = [...(chapter.revisionTodos || [])];
  const keys = new Set(
    existing.map((t) => t.text.replace(/\s+/g, '').slice(0, 48))
  );
  let added = 0;
  const next = [...existing];

  for (const h of list.slice(0, max)) {
    const tag =
      h.kind === 'blacklist'
        ? '套话'
        : h.kind === 'sublimation'
          ? '升华'
          : h.kind === 'tell'
            ? '告诉式'
            : h.phrase.startsWith('[G]')
              ? '解释腔'
              : h.phrase.startsWith('[B]')
                ? '句式'
                : h.phrase.startsWith('[D]')
                  ? '节奏'
                  : h.phrase.startsWith('[E]')
                    ? '对话'
                    : 'AI味';
    const sample = h.sample ? ` 「${h.sample.slice(0, 28)}」` : '';
    const text =
      `[去AI·${tag}] ${h.phrase}${h.count > 1 ? `×${h.count}` : ''}${sample} → ${h.suggestion}`.slice(
        0,
        280
      );
    const key = text.replace(/\s+/g, '').slice(0, 48);
    if (keys.has(key)) continue;
    next.unshift({
      id: `aitaste-${chapter.number}-${h.kind}-${added}-${Date.now().toString(36)}`.slice(
        0,
        80
      ),
      text,
      status: 'open',
      createdAt: now,
    });
    keys.add(key);
    added += 1;
  }

  if (added === 0) return { chapter, added: 0 };
  return {
    chapter: {
      ...chapter,
      revisionTodos: next.slice(0, 40),
      lastModified: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    },
    added,
  };
}

/** 在正文中定位 sample/phrase 片段 */
export function findProseSnippetRange(
  content: string,
  snippet: string
): { start: number; end: number } | null {
  if (!content || !snippet?.trim()) return null;
  const s = snippet.trim();
  let idx = content.indexOf(s);
  if (idx < 0 && s.length > 8) {
    idx = content.indexOf(s.slice(0, 8));
    if (idx >= 0) {
      return { start: idx, end: Math.min(content.length, idx + Math.min(s.length, 40)) };
    }
  }
  if (idx < 0) return null;
  return { start: idx, end: idx + s.length };
}
