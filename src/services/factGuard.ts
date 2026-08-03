/**
 * 本地可复现「防幻觉」断言（不调 LLM）。
 * - 阵亡/重伤/闭关角色仍在行动
 * - 钉死事实被粗暴否定
 * - 写前 must-avoid 关键词粗撞
 * - recap 质量门槛（绿通附加条件）
 */

import type {
  Character,
  ChapterIntent,
  ChapterRecap,
  HardReviewIssue,
  PinnedFact,
  StoryMemory,
} from '../types/novel';
import { listActiveFacts } from './storyMemory';
import {
  ledgerHitsToHardIssues,
  reconcileProseAgainstLedger,
} from './factLedger';

export interface FactGuardHit {
  type: HardReviewIssue['type'];
  severity: 'error' | 'warn';
  description: string;
  suggestion: string;
}

export interface FactGuardResult {
  passed: boolean;
  score: number;
  summary: string;
  issues: FactGuardHit[];
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 角色名在正文中是否伴随「当下行动」动词（弱启发） */
function nameActsInProse(name: string, prose: string): boolean {
  if (!name || name.length < 1) return false;
  if (!prose.includes(name)) return false;
  const re = new RegExp(
    `${escapeReg(name)}[^。！？\\n]{0,12}(说|道|问|答|笑|吼|喝道|怒道|冷笑|拔剑|挥|杀|冲|跑|走|站|坐|睁|抬|抓|握|推|踢|打|骂|喊|低语|低喝|起身|回头|点头|摇头)`,
    'g'
  );
  return re.test(prose);
}

function isDeadStatus(status: string | undefined): boolean {
  if (!status) return false;
  return status === '已阵亡/退出' || /阵亡|身亡|已死|陨落|死亡/.test(status);
}

function isImmobileStatus(status: string | undefined): boolean {
  if (!status) return false;
  return (
    status === '闭关突破' ||
    status === '被捕受困' ||
    status === '重伤' ||
    /闭关|受困|昏迷|重伤卧床/.test(status)
  );
}

/**
 * 扫描正文：角色状态 / 钉死事实否定 / must-avoid。
 */
export function runLocalFactGuard(input: {
  prose: string;
  characters?: Character[];
  storyMemory?: StoryMemory | null;
  chapterIntent?: ChapterIntent | null;
  /** 本章绑定角色 id；空则扫全部角色卡 */
  involvedCharacterIds?: string[];
  /** 当前章号：账本对账时忽略「本章刚写入」过严项 */
  chapterNumber?: number;
}): FactGuardResult {
  const prose = input.prose || '';
  const issues: FactGuardHit[] = [];
  if (prose.replace(/\s+/g, '').length < 40) {
    return {
      passed: true,
      score: 100,
      summary: '正文过短，跳过本地事实断言',
      issues: [],
    };
  }

  const chars = input.characters || [];
  const involved = new Set(input.involvedCharacterIds || []);
  const pool =
    involved.size > 0 ? chars.filter((c) => involved.has(c.id) || prose.includes(c.name)) : chars;

  // 1) 阵亡角色行动
  for (const c of pool) {
    if (!isDeadStatus(c.status)) continue;
    if (!nameActsInProse(c.name, prose)) continue;
    // 允许明显回忆/闪回语境弱放过
    const memoryCtx = new RegExp(
      `(回忆|想起|曾几何时|当年|那时|梦中|幻象|幻觉).{0,20}${escapeReg(c.name)}|${escapeReg(c.name)}.{0,20}(的尸|遗容|墓|灵位|牌位)`
    );
    if (memoryCtx.test(prose)) {
      issues.push({
        type: '状态冲突',
        severity: 'warn',
        description: `角色「${c.name}」状态为「${c.status}」，正文有行动描写，但似含回忆/幻境语境，请确认。`,
        suggestion: '若为回忆请写清时间锚；若为活人请修正角色状态。',
      });
      continue;
    }
    issues.push({
      type: '状态冲突',
      severity: 'error',
      description: `角色「${c.name}」状态为「${c.status}」，但正文出现当下行动描写（说/打/走等）。`,
      suggestion: '改为回忆/他人转述/同名者，或修正角色卡状态后再定稿。',
    });
  }

  // 2) 重伤/闭关/受困却高强度行动（warn，避免误杀）
  for (const c of pool) {
    if (isDeadStatus(c.status) || !isImmobileStatus(c.status)) continue;
    if (!prose.includes(c.name)) continue;
    const fierce = new RegExp(
      `${escapeReg(c.name)}[^。！？\\n]{0,16}(一跃|飞身|瞬移|连斩|屠|血战|大战|杀入|横扫|碾压)`
    );
    if (fierce.test(prose)) {
      issues.push({
        type: '状态冲突',
        severity: 'warn',
        description: `角色「${c.name}」状态为「${c.status}」，正文似有高强度行动。`,
        suggestion: '补代价/限制描写，或先更新角色状态。',
      });
    }
  }

  // 3) 钉死事实粗暴否定
  const facts: PinnedFact[] = listActiveFacts(input.storyMemory || undefined).slice(-20);
  for (const f of facts) {
    const core = f.text.replace(/\s+/g, '').slice(0, 12);
    if (core.length < 4) continue;
    const head = f.text.trim().slice(0, 10);
    const negPatterns = [
      new RegExp(`并没有?${escapeReg(head.slice(0, 8))}`),
      new RegExp(`${escapeReg(head.slice(0, 6))}[^。]{0,10}(从未|不曾|并无|并不存在|纯属虚构)`),
      new RegExp(`(从未|根本没有|压根没有|并不存在).{0,6}${escapeReg(head.slice(0, 6))}`),
    ];
    if (negPatterns.some((re) => re.test(prose))) {
      issues.push({
        type: '吃书矛盾',
        severity: 'error',
        description: `正文疑似否定钉死事实：「${f.text.slice(0, 60)}」`,
        suggestion: '改写冲突句，或到书级记忆作废/更新该事实后再定稿。',
      });
    }
  }

  // 4) must-avoid：短关键词直接撞上（warn，避免整句误报）
  const avoids = (input.chapterIntent?.mustAvoid || [])
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 24);
  for (const a of avoids.slice(0, 8)) {
    // 去掉「禁止/不得」前缀后匹配实质词
    const key = a.replace(/^(禁止|不得|不要|切勿|严禁)/, '').trim();
    if (key.length < 4) continue;
    // 只对「实体词」做包含检测：纯指令句跳过
    if (/升华|说教|重新开书|战力|人设/.test(key) && key.length > 10) continue;
    if (prose.includes(key)) {
      issues.push({
        type: '其他硬伤',
        severity: 'warn',
        description: `正文出现写前禁止项关键词：「${key}」`,
        suggestion: '核对是否触碰 must-avoid；若误报可改写表述或调整禁止项。',
      });
    }
  }

  // 5) 事实账本对账（死人/道具/归属/地点）
  const ledger = input.storyMemory?.factLedger;
  if (ledger && (ledger.assertions?.length || 0) > 0) {
    const rec = reconcileProseAgainstLedger({
      prose,
      ledger,
      characters: input.characters,
      chapterNumber: input.chapterNumber,
    });
    for (const h of ledgerHitsToHardIssues(rec.issues)) {
      // 去重：描述前 40 字
      const key = h.description.replace(/\s+/g, '').slice(0, 40);
      if (issues.some((i) => i.description.replace(/\s+/g, '').slice(0, 40) === key)) {
        continue;
      }
      issues.push({
        type: h.type,
        severity: h.severity,
        description: h.description,
        suggestion: h.suggestion,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.filter((i) => i.severity === 'warn').length;
  const passed = errors === 0;
  const score = passed
    ? Math.max(70, 100 - warns * 6)
    : Math.max(25, 70 - errors * 18 - warns * 4);

  const summary = passed
    ? warns
      ? `本地断言通过（${warns} 条警告）`
      : '本地断言通过'
    : `本地断言未过：${errors} error / ${warns} warn`;

  return { passed, score, summary, issues: issues.slice(0, 20) };
}

export function factGuardHitsToHardIssues(hits: FactGuardHit[]): HardReviewIssue[] {
  return hits.map((h) => ({
    type: h.type,
    severity: h.severity,
    description: `[本地断言] ${h.description}`,
    suggestion: h.suggestion,
  }));
}

/**
 * 合并 LLM 硬伤 + 本地断言。
 * - 本地 error → 总 hard 必不通过
 * - 硬伤 API fallback 阻断时保留
 */
export function mergeHardWithLocalGuard(
  hard: {
    passed: boolean;
    score: number;
    summary: string;
    issues: HardReviewIssue[];
    source?: 'llm' | 'fallback' | 'local' | 'mixed';
  },
  local: FactGuardResult
): {
  passed: boolean;
  score: number;
  summary: string;
  issues: HardReviewIssue[];
  source: 'llm' | 'fallback' | 'local' | 'mixed';
  localGuard?: FactGuardResult;
} {
  const localIssues = factGuardHitsToHardIssues(local.issues);
  const issues = [...(hard.issues || []), ...localIssues].slice(0, 20);
  const passed = hard.passed && local.passed;
  const score = Math.min(hard.score, local.score, passed ? 100 : 68);
  const parts: string[] = [];
  if (!hard.passed) parts.push(hard.summary);
  if (!local.passed) parts.push(local.summary);
  if (passed && local.issues.length) parts.push(local.summary);
  const summary =
    parts.filter(Boolean).join('； ') ||
    (passed ? hard.summary || '硬伤与本地断言通过' : '硬伤/本地断言未过');

  let source: 'llm' | 'fallback' | 'local' | 'mixed' = hard.source || 'llm';
  if (local.issues.length && hard.source === 'llm') source = 'mixed';
  if (local.issues.length && hard.source === 'fallback') source = 'fallback';
  if (!hard.issues?.length && local.issues.length && hard.source !== 'fallback') {
    source = hard.passed ? 'mixed' : 'local';
  }

  return {
    passed,
    score,
    summary,
    issues,
    source,
    localGuard: local,
  };
}

export interface RecapQualityResult {
  ok: boolean;
  /** 不 ok 时是否应阻断自动绿通/锁定 */
  blockGreen: boolean;
  summary: string;
  reasons: string[];
}

/**
 * 章末 recap 质量：过空则不允许「机检通过」自动锁章。
 * 第 1 章较松；章数越高要求越多事实条。
 */
export function evaluateRecapQuality(
  recap: ChapterRecap | null | undefined,
  chapterNumber: number,
  prose?: string
): RecapQualityResult {
  const reasons: string[] = [];
  if (!recap) {
    return {
      ok: false,
      blockGreen: chapterNumber >= 2,
      summary: '无 recap',
      reasons: ['未生成章末 recap'],
    };
  }

  const textLen = (recap.text || '').replace(/\s+/g, '').length;
  const facts = (recap.keyFacts || []).map((f) => f.trim()).filter((f) => f.length >= 4);
  const ending = (recap.endingState || '').replace(/\s+/g, '').length;
  const proseLen = (prose || '').replace(/\s+/g, '').length;

  // 正文本身很短时放宽
  if (proseLen > 0 && proseLen < 200) {
    return {
      ok: true,
      blockGreen: false,
      summary: '正文较短，recap 门槛放宽',
      reasons: [],
    };
  }

  if (textLen < 24) {
    reasons.push(`recap 正文过短（${textLen} 字）`);
  }
  if (chapterNumber >= 2 && ending < 6) {
    reasons.push('缺少章末现场 endingState');
  }
  if (chapterNumber >= 3 && facts.length < 1) {
    reasons.push('keyFacts 为空（至少 1 条钉死级事实）');
  }
  if (chapterNumber >= 10 && facts.length < 2) {
    reasons.push(`keyFacts 仅 ${facts.length} 条（10 章起建议 ≥2）`);
  }
  if (chapterNumber >= 30 && facts.length < 3) {
    reasons.push(`keyFacts 仅 ${facts.length} 条（30 章起建议 ≥3）`);
  }

  // fallback recap 且几乎无事实：高章阻断
  if (recap.source === 'fallback' && chapterNumber >= 5 && facts.length < 1) {
    reasons.push('recap 为启发式 fallback 且无事实，记忆不可靠');
  }

  const ok = reasons.length === 0;
  // 阻断绿通：有实质缺失时（第1章仅 text 过短才挡）
  const blockGreen =
    !ok &&
    (chapterNumber >= 2 || textLen < 12) &&
    reasons.some(
      (r) =>
        r.includes('keyFacts') ||
        r.includes('过短') ||
        r.includes('fallback') ||
        r.includes('endingState')
    );

  return {
    ok,
    blockGreen,
    summary: ok
      ? `recap 合格 · 事实 ${facts.length} · ${textLen} 字`
      : `recap 偏弱：${reasons[0]}`,
    reasons,
  };
}
