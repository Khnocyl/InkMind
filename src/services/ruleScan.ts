import { proseWords } from './proseWords';
import type { StyleConfig } from '../types/novel';
import { scoreOpeningEcho } from './antiEcho';
import {
  mergeAiTasteIntoRuleHits,
  mergeExtendedBlacklist,
  isWhitelistExempt,
  scanAiTastePatterns,
  type AiTasteReport,
} from './aiTasteScan';

export type RuleHitKind =
  | 'blacklist'
  | 'sublimation'
  | 'tell'
  | 'pattern'
  | 'echo'
  | 'length';
export type RuleHitSeverity = 'error' | 'warn';
export type { AiTasteReport };

export interface RuleHit {
  kind: RuleHitKind;
  severity: RuleHitSeverity;
  /** 命中的规则短语或模式名 */
  phrase: string;
  count: number;
  /** 文中片段样例 */
  sample?: string;
  suggestion: string;
}

export interface RuleScanResult {
  /** 无 error 级命中则为 true */
  passed: boolean;
  /** 0–100，仅供参考；error 越多越低 */
  score: number;
  hits: RuleHit[];
  blacklistHits: number;
  sublimationHits: number;
  tellHits: number;
  patternHits: number;
  summary: string;
}

/** 内置章末升华 / 说教模式（可与用户黑名单叠加） */
export const DEFAULT_SUBLIMATION_PATTERNS: string[] = [
  '命运的齿轮',
  '命运的转轮',
  '在这茫茫天地间',
  '在这片茫茫天地间',
  '或许这就是',
  '也许这就是',
  '不禁感慨',
  '不禁想到',
  '人生如梦',
  '天道无情',
  '这一刻他终于明白',
  '这一刻她终于明白',
  '为接下来的风暴埋下',
  '埋下了深远的伏笔',
  '不知未来究竟会向何处',
  '而这，或许只是',
  '这一切，才刚刚开始',
  '真正的考验才刚刚开始',
  '他知道，从今往后',
  '她知道，从今往后',
];

/** Show-don't-tell 弱模式：直接贴情绪标签 */
export const DEFAULT_TELL_PATTERNS: string[] = [
  '感到一阵',
  '感到非常',
  '感到十分',
  '心里感到',
  '心中感到',
  '不由得感到',
  '气氛变得',
  '气氛变得极其',
  '眼神里露出',
  '眼中露出',
  '露出了震惊',
  '露出震惊',
  '显得十分',
  '显得非常',
  '内心充满了',
  '心中充满了',
];

/**
 * 将黑名单条目转为可匹配器。
 * 支持省略号通配：`不仅……还……` / `宛如...一般` → 中间允许少量字符。
 */
function buildMatchers(
  phrases: string[]
): { phrase: string; test: (text: string) => { count: number; sample?: string } }[] {
  return phrases
    .map((p) => p.trim())
    .filter(Boolean)
    .map((phrase) => {
      if (/……|\.\.\.|…/.test(phrase)) {
        const parts = phrase.split(/……|\.\.\.|…/).filter((s) => s.length > 0);
        if (parts.length >= 2) {
          const escaped = parts.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          const source = escaped.join('.{0,24}?');
          try {
            const re = new RegExp(source, 'g');
            return {
              phrase,
              test: (text: string) => {
                const matches = text.match(re);
                const count = matches?.length ?? 0;
                return { count, sample: matches?.[0] };
              },
            };
          } catch {
            // fall through to literal
          }
        }
      }

      return {
        phrase,
        test: (text: string) => {
          if (!phrase) return { count: 0 };
          let count = 0;
          let idx = 0;
          let first: string | undefined;
          while (idx < text.length) {
            const found = text.indexOf(phrase, idx);
            if (found === -1) break;
            count += 1;
            if (!first) first = phrase;
            idx = found + phrase.length;
          }
          return { count, sample: first };
        },
      };
    });
}

function scanPhraseList(
  text: string,
  phrases: string[],
  kind: RuleHitKind,
  severity: RuleHitSeverity,
  suggestion: string
): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const m of buildMatchers(phrases)) {
    const { count, sample } = m.test(text);
    if (count > 0) {
      hits.push({
        kind,
        severity,
        phrase: m.phrase,
        count,
        sample,
        suggestion,
      });
    }
  }
  return hits;
}

/**
 * 章末窗口内检测升华句：取全文最后一段窗口。
 */
function scanEndingSublimation(
  text: string,
  enabled: boolean,
  extraBlacklist: string[]
): RuleHit[] {
  if (!enabled || !text.trim()) return [];

  const endingWindow = Math.min(400, Math.max(120, Math.floor(text.length * 0.15)));
  const ending = text.slice(-endingWindow);
  const hits: RuleHit[] = [];

  const patterns = [
    ...DEFAULT_SUBLIMATION_PATTERNS,
    ...extraBlacklist.filter((p) => /命运|天地|伏笔|感慨|天道|考验才刚刚/.test(p)),
  ];

  hits.push(
    ...scanPhraseList(
      ending,
      patterns,
      'sublimation',
      'error',
      '章末疑似升华/说教：请截断在具体动作、对白或道具变化上，删去命运总结。'
    )
  );

  const endingTellRe =
    /([他她](终于)?(明白|意识到|懂得)了?[，,]?.{0,20}(道理|意义|真相|重要))/g;
  const tellMatches = ending.match(endingTellRe);
  if (tellMatches?.length) {
    hits.push({
      kind: 'sublimation',
      severity: 'error',
      phrase: '章末「明白/意识到…道理」句式',
      count: tellMatches.length,
      sample: tellMatches[0],
      suggestion: '删去章末顿悟说教，改用具体动作或未完成的物理悬念收束。',
    });
  }

  return hits;
}

export interface RuleScanResultWithTaste extends RuleScanResult {
  aiTaste?: AiTasteReport;
}

export interface RuleScanOptions {
  /** 上一章全文（或至少开篇），用于开篇同质检测 */
  previousProse?: string | null;
  /** 本章目标字数（去空白）；不足 90% 记 length 命中 */
  targetWordCount?: number | null;
  /** 最低达标比例，默认 0.9 */
  wordCountMinRatio?: number;
}

/**
 * 对正文做规则机检（不调 LLM）。
 * - 黑名单：error（含扩展套话表，白名单豁免）
 * - 禁升华开启时章末升华：error
 * - Show-don't-tell 弱模式：warn
 * - AI 味扩展：句式 B / 节奏 D / 解释腔 G（默认 warn，可配置）
 * - 开篇与上章前段同质：error（有 previousProse 时）
 */
export function ruleScanProse(
  prose: string,
  styleConfig: StyleConfig,
  options?: RuleScanOptions
): RuleScanResultWithTaste {
  const text = prose || '';
  const blacklist = mergeExtendedBlacklist(styleConfig);
  const whitelist = [
    ...(styleConfig.deslopWhitelist || []),
    ...(styleConfig.aiTasteWhitelist || []),
  ];

  const hits: RuleHit[] = [];

  const blHits = scanPhraseList(
    text,
    blacklist,
    'blacklist',
    'error',
    '命中套话黑名单：请改写该处，使用具体动作/感官细节替代。'
  );
  // 白名单豁免黑名单命中（与 mergeExtendedBlacklist 同一收紧口径，防短词静默击穿）
  hits.push(
    ...blHits.filter((h) => {
      if (!whitelist.length) return true;
      if (isWhitelistExempt(h.phrase, whitelist)) return false;
      if (h.sample && isWhitelistExempt(h.sample, whitelist)) return false;
      return true;
    })
  );

  hits.push(...scanEndingSublimation(text, !!styleConfig.forbidEndingSublimation, blacklist));

  if (styleConfig.enforceShowDontTell !== false) {
    hits.push(
      ...scanPhraseList(
        text,
        DEFAULT_TELL_PATTERNS,
        'tell',
        'warn',
        '直接情绪标签：改为微动作/生理反馈（指节发白、冷汗浸透等）。'
      )
    );
  }

  // 连章开篇同质（第2章前段像第1章）
  if (options?.previousProse?.trim()) {
    const echo = scoreOpeningEcho(options.previousProse, text);
    if (echo.flagged) {
      hits.push({
        kind: 'echo',
        severity: 'error',
        phrase: `开篇同质${echo.score}`,
        count: 1,
        sample: echo.currOpeningPreview.slice(0, 80),
        suggestion:
          echo.detail +
          (echo.sharedPhrases.length
            ? ` 避开：${echo.sharedPhrases.slice(0, 5).join('、')}`
            : '') +
          '。改写前 300 字：换时间点/冲突切口/对话入场，勿重铺上章环境。',
      });
    } else if (echo.score >= 28) {
      hits.push({
        kind: 'echo',
        severity: 'warn',
        phrase: `开篇偏近${echo.score}`,
        count: 1,
        sample: echo.currOpeningPreview.slice(0, 60),
        suggestion: '开篇与上章略近，可再拉开场景切口或信息差。',
      });
    }
  }

  // 字数不足（相对目标）
  const targetWords =
    typeof options?.targetWordCount === 'number' && options.targetWordCount > 0
      ? Math.round(options.targetWordCount)
      : 0;
  if (targetWords > 0) {
    const ratio = options?.wordCountMinRatio ?? 0.9;
    const minWords = Math.round(targetWords * ratio);
    const currentWords = proseWords(text);
    if (currentWords < minWords) {
      const deficit = minWords - currentWords;
      const severe = currentWords < targetWords * 0.7;
      hits.push({
        kind: 'length',
        severity: severe ? 'error' : 'warn',
        phrase: `字数不足${currentWords}/${targetWords}`,
        count: 1,
        sample: `当前 ${currentWords} 字，最低 ${minWords}，差 ${deficit}`,
        suggestion: `本章未达字数目标（${currentWords}/${targetWords}，最低 ${minWords}）。请续写中后段冲突/对白/阻力，禁止空话注水。`,
      });
    }
  }

  // AI 味扩展（deslop Gate B/D/G 等）
  const aiTaste = scanAiTastePatterns(text, styleConfig);
  const mergedHits = mergeAiTasteIntoRuleHits(hits, aiTaste);

  const map = new Map<string, RuleHit>();
  for (const h of mergedHits) {
    const key = `${h.kind}::${h.phrase}`;
    const prev = map.get(key);
    if (!prev || h.count > prev.count) map.set(key, h);
  }
  const merged = [...map.values()];

  const blacklistHits = merged
    .filter((h) => h.kind === 'blacklist')
    .reduce((s, h) => s + h.count, 0);
  const sublimationHits = merged
    .filter((h) => h.kind === 'sublimation')
    .reduce((s, h) => s + h.count, 0);
  const tellHits = merged.filter((h) => h.kind === 'tell').reduce((s, h) => s + h.count, 0);
  const patternHits = merged
    .filter((h) => h.kind === 'pattern')
    .reduce((s, h) => s + h.count, 0);

  const errorHits = merged.filter((h) => h.severity === 'error');
  // 重度 AI 味可选阻断
  const passed = errorHits.length === 0 && !aiTaste.blockGreen;

  let score = 100;
  for (const h of merged) {
    if (h.severity === 'error') score -= 12 * Math.min(h.count, 3);
    else score -= 3 * Math.min(h.count, 3);
  }
  score = Math.min(score, aiTaste.score + 10);
  score = Math.max(0, Math.min(100, score));

  const parts: string[] = [];
  if (passed) {
    parts.push('规则机检通过');
    if (tellHits > 0) parts.push(`情绪标签 ${tellHits}`);
    if (aiTaste.tier !== 'clean') parts.push(aiTaste.summary);
  } else {
    if (blacklistHits > 0) parts.push(`黑名单 ${blacklistHits} 处`);
    if (sublimationHits > 0) parts.push(`章末升华 ${sublimationHits} 处`);
    const echoHits = merged.filter((h) => h.kind === 'echo').length;
    if (echoHits > 0) parts.push(`开篇同质 ${echoHits}`);
    const lengthHits = merged.filter((h) => h.kind === 'length');
    if (lengthHits.length > 0) parts.push(lengthHits[0].phrase);
    if (aiTaste.blockGreen) parts.push(`AI味重度阻断`);
    else if (patternHits > 0) parts.push(`句式/结构 ${patternHits}`);
    parts.push('未通过');
  }

  return {
    passed,
    score,
    hits: merged,
    blacklistHits,
    sublimationHits,
    tellHits,
    patternHits,
    summary: parts.join(' · '),
    aiTaste,
  };
}

/** 将机检结果压成 audit 友好的短语列表 */
export function ruleScanHitPhrases(result: RuleScanResult): string[] {
  return result.hits.map((h) => (h.count > 1 ? `${h.phrase}×${h.count}` : h.phrase));
}
