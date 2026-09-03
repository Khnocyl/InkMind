import React, { useState } from 'react';
import type { Chapter, StyleConfig, HardReviewIssue } from '../../types/novel';
import { isAuditStale } from '../../services/auditFreshness';
import { RevisionTodosPanel } from '../Workspace/RevisionTodosPanel';
import {
  ShieldCheck,
  ScanSearch,
  Loader2,
  RefreshCw,
  Layers2,
  Wand2,
  Download,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  AlertTriangle,
} from 'lucide-react';

/** 核验徽标（P2）：把每条指控的防误报核验结论显性化 */
function hardVerifyBadge(iss: HardReviewIssue): {
  text: string;
  cls: string;
  title: string;
} | null {
  const v = iss.verify;
  if (!v) return null; // 旧数据无核验记录 → 保持原样
  const reasons = (v.reasons || []).filter(Boolean).join('；');
  if (v.status === 'verified') {
    return {
      text: '✅ 引用已核实',
      cls: 'bg-emerald-50 border-emerald-200 text-emerald-700',
      title: '引文A/B均逐字命中原文/记忆（含辩护人复核）',
    };
  }
  if (v.status === 'defense-refuted') {
    return {
      text: '⚖️ 原判硬伤 · 辩护成立 → 存疑',
      cls: 'bg-amber-50 border-amber-300 text-amber-800',
      title: reasons || '辩护人复核：存在合理解释，非必然冲突',
    };
  }
  return {
    text: '⚠️ 原判硬伤 · 引用未命中 → 存疑',
    cls: 'bg-slate-100 border-slate-300 text-slate-600',
    title: reasons || '引文未能逐字命中原文/记忆，指控不可作为硬伤计分',
  };
}

const EVIDENCE_B_SOURCE_LABEL: Record<string, string> = {
  memory: '记忆',
  intent: '意图',
  previous: '前情',
  chapter: '正文',
};

interface AuditGroupProps {
  chapter: Chapter;
  allChapters?: Chapter[];
  styleConfig: StyleConfig;
  isGenerating: boolean;
  isAutoPiloting: boolean;
  /** 定稿锁定（去味等写操作禁用判断） */
  locked: boolean;
  aiTasteScanBusy: boolean;
  aiTasteScanMessage: string | null;
  onRerunHardReview?: (chapterId: string) => void | Promise<void>;
  onJumpChapter?: (chapterId: string, todoId?: string) => void;
  onOpenForRewrite?: (chapterId: string, todoId?: string) => void;
  onFixFirstRevision?: () => void;
  onAiFixAllRevisionTodos?: () => void;
  onStopAiFixAll?: () => void;
  aiFixAllRunning?: boolean;
  onAiFixRevisionTodo?: (chapterId: string, todoId: string) => void | Promise<void>;
  onClearDoneRevisionTodos?: () => void;
  onMarkAllRevisionTodosDone?: () => void;
  onToggleRevisionTodo?: (chapterId: string, todoId: string) => void;
  onLocateInProse?: (snippet: string) => void;
  onScanAiTasteChapter?: () => void | Promise<void>;
  onScanAiTasteBook?: (writeTodos?: boolean) => void | Promise<void>;
  onDeslopHit?: (snippet: string) => void | Promise<void>;
  onBatchDeslopChapter?: (maxHits?: number) => void | Promise<void>;
  onBatchDeslopBook?: (maxPerChapter?: number) => void | Promise<void>;
  onExportAiTasteCsv?: () => void;
}

/**
 * 右栏分组「审校」：审校结论卡（阶段A/阶段B/规则机检/综合分合并展示，数据源
 * 仍是 chapter.memoryAudit 各字段，逻辑不合并）+ 待修清单 + 修复环 / 去味扫描折叠行。
 * 结论卡「审校详情」折叠收纳原各明细卡（原 JSX 原样保留）。
 */
export const AuditGroup: React.FC<AuditGroupProps> = ({
  chapter,
  allChapters,
  styleConfig,
  isGenerating,
  isAutoPiloting,
  locked,
  aiTasteScanBusy,
  aiTasteScanMessage,
  onRerunHardReview,
  onJumpChapter,
  onOpenForRewrite,
  onFixFirstRevision,
  onAiFixAllRevisionTodos,
  onStopAiFixAll,
  aiFixAllRunning = false,
  onAiFixRevisionTodo,
  onClearDoneRevisionTodos,
  onMarkAllRevisionTodosDone,
  onToggleRevisionTodo,
  onLocateInProse,
  onScanAiTasteChapter,
  onScanAiTasteBook,
  onDeslopHit,
  onBatchDeslopChapter,
  onBatchDeslopBook,
  onExportAiTasteCsv,
}) => {
  const [deslopN, setDeslopN] = useState(3);
  // 重跑本审的按钮级 busy（handler 内部走 aiTasteScanBusy 互斥，这里只管转圈）
  const [hardReviewRerunning, setHardReviewRerunning] = useState(false);
  const rerunHardReview = async (chapterId: string) => {
    setHardReviewRerunning(true);
    try {
      await onRerunHardReview?.(chapterId);
    } finally {
      setHardReviewRerunning(false);
    }
  };
  /** 审校结果是否已过期（正文在审校后改过 / 旧数据无版本锚） */
  const auditStale = isAuditStale(chapter);
  // 结论卡明细折叠（默认收起，渐进披露）
  const [detailOpen, setDetailOpen] = useState(false);
  const [fixLoopOpen, setFixLoopOpen] = useState(false);
  const [deslopOpen, setDeslopOpen] = useState(false);
  const audit = chapter.memoryAudit;
  const hardErrorCount = (audit?.hardReview?.issues || []).filter(
    (iss) => iss.severity === 'error'
  ).length;
  const ruleHitCount = audit?.ruleScan ? audit.ruleScan.hits.length : 0;
  // 设计稿 03：头部语义胶囊（玫红=硬伤/阻断 · 琥珀=待办 · 松绿=通过），综合分下放 kv 行（mono）
  // hardBlocked 有两种来源：硬伤审未过 / 硬伤审已过但确定性写后校验（禁破折号等）违规——
  // 两者必须分开展示，否则会出现「80 分·无硬伤·却硬伤未过」的自相矛盾标签。
  const hardReviewFailed = audit?.hardReview?.passed === false;
  const hardFailed = !!(audit?.hardBlocked || hardReviewFailed);
  const postWriteBlocked = !hardReviewFailed && !!audit?.hardBlocked;
  const postWriteViolationCount = (audit?.logicConflicts || []).filter(
    (c) =>
      // 写后校验违规在两条路径都以 type='其他硬伤' 入 logicConflicts
      //（重跑本审: [禁止破折号]…；管线: [引擎·…] 前缀仅见于待修文本，兼容旧数据一并计）
      c.type === '其他硬伤' ||
      (typeof c.description === 'string' && c.description.startsWith('[引擎·'))
  ).length;
  const ruleFailed = !!(audit?.ruleScanBlocked || audit?.ruleScan?.passed === false);
  const verdict = hardFailed
    ? {
        tone: 'bad' as const,
        text: postWriteBlocked ? '写后校验未过' : '硬伤未过',
        title: postWriteBlocked
          ? '硬伤审已通过；但确定性写后校验（禁破折号/禁句式等）存在 error 违规。可修正文或调整文风豁免。'
          : '硬伤审未通过，未绿通；修复后可「重跑本审」复核',
      }
    : ruleFailed
      ? {
          tone: 'bad' as const,
          text: '机检未过',
          title: '规则机检未通过，未绿通；修复后可「重跑本审」复核',
        }
      : (audit?.verificationScore ?? 0) >= 75
        ? { tone: 'ok' as const, text: '绿通', title: '硬伤/机检通过且综合分 ≥ 75，可定稿' }
        : {
            tone: 'warn' as const,
            text: '未绿通',
            title: '综合分低于 75：不予通过，需重写',
          };

  return (
    <>
      {/* 审校结论卡（展示合并：阶段A硬伤 + 阶段B文笔 + 规则机检 + 综合分；对照设计稿 03 屏） */}
      <div className="p-4 border-b border-slate-200 bg-white">
        {audit ? (
          <div className="py-[9px] px-[11px] bg-white border border-slate-200 rounded-xl shadow-sm space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-900 flex items-center space-x-1.5">
                <ShieldCheck size={14} className="text-[#111111]" />
                <span>审校结论</span>
              </span>
              <span
                className={`text-[9.5px] font-bold rounded-full px-[7px] py-[1.5px] border whitespace-nowrap shrink-0 ${
                  verdict.tone === 'bad'
                    ? 'bg-rose-50 text-rose-700 border-rose-300'
                    : verdict.tone === 'warn'
                      ? 'bg-amber-50 text-amber-800 border-amber-300'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-300'
                }`}
                title={verdict.title}
              >
                {verdict.text}
              </span>
            </div>

            {/* kv 行：label 左 / 数值右（设计稿 .kv） */}
            <div className="space-y-1 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 shrink-0">阶段 A · 硬伤</span>
                {audit.hardReview ? (
                  <span
                    className={`font-bold text-right ${
                      audit.hardReview.passed ? 'text-[#111111]' : 'text-[#be123c]'
                    }`}
                    title={audit.hardReview.passed ? '硬伤审通过' : '硬伤审未通过（阻断）'}
                  >
                    {audit.hardReview.score} 分 ·{' '}
                    {hardErrorCount > 0 ? `${hardErrorCount} 项硬伤` : '无硬伤'}
                  </span>
                ) : (
                  <span className="text-slate-400">未记录</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 shrink-0">阶段 B · 文笔</span>
                {audit.styleReview ? (
                  <span className="font-bold text-right text-[#111111]">
                    {audit.styleReview.score} 分
                  </span>
                ) : (
                  <span className="text-slate-400">未记录</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 shrink-0">规则机检</span>
                {audit.ruleScan ? (
                  <span
                    className={`text-[9.5px] font-bold rounded-full px-[7px] py-[1.5px] border whitespace-nowrap ${
                      audit.ruleScan.passed === false
                        ? 'bg-amber-50 text-amber-800 border-amber-300'
                        : 'bg-emerald-50 text-emerald-700 border-emerald-300'
                    }`}
                    title={audit.ruleScan.passed ? '规则机检通过' : '机检未通过 · 禁绿通'}
                  >
                    {ruleHitCount} 命中
                  </span>
                ) : (
                  <span className="text-slate-400">未记录</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 shrink-0">写后校验</span>
                {audit.logicConflicts ? (
                  <span
                    className={`text-[9.5px] font-bold rounded-full px-[7px] py-[1.5px] border whitespace-nowrap ${
                      postWriteViolationCount > 0
                        ? 'bg-amber-50 text-amber-800 border-amber-300'
                        : 'bg-emerald-50 text-emerald-700 border-emerald-300'
                    }`}
                    title={
                      postWriteViolationCount > 0
                        ? '确定性写后校验违规（禁破折号/禁句式等）· 详见审校详情 logicConflicts'
                        : '写后校验通过（破折号/句式等确定性规则无 error）'
                    }
                  >
                    {postWriteViolationCount} 违规
                  </span>
                ) : (
                  <span className="text-slate-400">未记录</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500 shrink-0">综合</span>
                <b
                  className="font-mono font-bold text-right text-[#111111]"
                  title={
                    (audit.verificationScore ?? 0) < 75
                      ? '综合分低于 75：不予通过，需重写'
                      : '综合分 ≥ 75 且硬伤/机检通过方可绿通'
                  }
                >
                  {audit.verificationScore ?? '—'} / 100
                </b>
              </div>
            </div>

            {/* 过期徽标：设计稿 .tag.stale（琥珀底 + 虚线边） */}
            {auditStale && (
              <div className="pt-0.5">
                <span
                  className="inline-flex items-center gap-1 text-[9.5px] font-bold rounded-full px-[7px] py-[1.5px] border border-dashed border-amber-500 bg-amber-50 text-amber-800 whitespace-nowrap"
                  title="正文在审校后已改动（或旧数据缺版本锚），此结果只对应审校时的旧版本。点「重跑本审」刷新结论。"
                >
                  <AlertTriangle size={10} className="shrink-0" />
                  正文已改动 · 结果过期
                </span>
              </div>
            )}

            {/* 结论不可信徽标：硬伤审无可信结论 / 综合分与机检分严重背离 → 已冻结自动修稿 */}
            {audit.auditUnreliable && (
              <div className="pt-0.5">
                <span
                  className="inline-flex items-center gap-1 text-[9.5px] font-bold rounded-full px-[7px] py-[1.5px] border border-amber-500 bg-amber-50 text-amber-800 whitespace-nowrap"
                  title="硬伤审无可信结论（API 失败，或综合分与机检分背离 >25），AI 已冻结自动修稿，请人工通读确认。"
                >
                  <AlertTriangle size={10} className="shrink-0" />
                  结论不可信 · 已冻结自动修稿
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-0.5">
              {onRerunHardReview ? (
                <button
                  type="button"
                  disabled={isGenerating || aiTasteScanBusy || hardReviewRerunning}
                  onClick={() => void rerunHardReview(chapter.id)}
                  title="对当前正文重新执行审校（只读复核，不改动正文一个字；锁定章可用）"
                  className="flex items-center gap-1 text-[11px] font-bold py-1 px-2 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {hardReviewRerunning ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    <RefreshCw size={10} />
                  )}
                  重跑本审
                </button>
              ) : (
                <span />
              )}
              <span className="text-[10px] text-slate-500">只读复核 · 不改正文</span>
            </div>

            {/* 审校详情折叠：原明细区块原样收纳（逻辑不合并） */}
            <button
              type="button"
              onClick={() => setDetailOpen((v) => !v)}
              className="w-full flex items-center justify-between pt-1 border-t border-slate-100 text-[11px] font-semibold text-slate-600"
            >
              <span>审校详情（问题列表 · 机检命中 · 套话 · 硬伤线索）</span>
              {detailOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {detailOpen && (
              <div className="space-y-2 text-xs pt-1">
                {audit.previousContextSource && (
                  <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
                    <div className="text-[11px] font-bold text-slate-900 mb-1 flex items-center justify-between">
                      <span>写前前情注入记录</span>
                      <span className="text-[10px] text-teal-700 font-semibold">
                        {audit.injectedPreviousContext ? '已注入' : '开篇章'}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-600 leading-relaxed">
                      {audit.previousContextSource}
                    </div>
                  </div>
                )}

                {/* 双阶段：硬伤审 */}
                {audit.hardReview && (
                  <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm space-y-1.5">
                    <div className="text-[11px] font-bold text-slate-900 flex items-center justify-between">
                      <span>阶段 A · 硬伤审</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                          audit.hardReview.passed
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                            : 'bg-red-50 border-red-200 text-red-800'
                        }`}
                      >
                        {audit.hardReview.passed ? '通过' : '阻断'} · {audit.hardReview.score}分
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-700 leading-relaxed">
                      {audit.hardReview.summary}
                    </p>
                    {(audit.hardReview.issues || []).length > 0 && (
                      <ul className="max-h-48 overflow-y-auto space-y-1">
                        {audit.hardReview.issues.map((iss, i) => {
                          const badge = hardVerifyBadge(iss);
                          const evA = iss.evidenceA?.quote || '';
                          const evB = iss.evidenceB?.quote || '';
                          const evBSrc =
                            EVIDENCE_B_SOURCE_LABEL[
                              iss.evidenceB?.source || 'memory'
                            ] || '记忆';
                          return (
                            <li
                              key={i}
                              className={`text-[10px] p-1.5 rounded border leading-relaxed ${
                                iss.severity === 'error'
                                  ? 'bg-red-50/80 border-red-100 text-red-950'
                                  : 'bg-amber-50/60 border-amber-100 text-amber-950'
                              }`}
                            >
                              <span className="font-semibold">
                                [{iss.severity === 'error' ? '硬伤' : '可疑'}·
                                {iss.type}]
                              </span>{' '}
                              {iss.description}
                              {badge && (
                                <span
                                  className={`ml-1 inline-flex items-center text-[9px] font-bold rounded-full px-[6px] py-[1px] border whitespace-nowrap ${badge.cls}`}
                                  title={badge.title}
                                >
                                  {badge.text}
                                </span>
                              )}
                              {iss.suggestion && (
                                <div className="text-slate-500 mt-0.5">
                                  → {iss.suggestion}
                                </div>
                              )}
                              {(evA || evB) && (
                                <div className="mt-1 space-y-0.5 text-slate-600">
                                  {evA && (
                                    <div className="flex items-start gap-1">
                                      <span className="text-slate-400 shrink-0">
                                        据·正文
                                      </span>
                                      {onLocateInProse ? (
                                        <button
                                          type="button"
                                          onClick={() => onLocateInProse?.(evA)}
                                          className="text-left underline decoration-dotted hover:text-rose-700"
                                          title="点击在正文中定位该引文"
                                        >
                                          「{evA}」
                                        </button>
                                      ) : (
                                        <span>「{evA}」</span>
                                      )}
                                    </div>
                                  )}
                                  {evB && (
                                    <div className="flex items-start gap-1">
                                      <span className="text-slate-400 shrink-0">
                                        据·{evBSrc}
                                      </span>
                                      <span>「{evB}」</span>
                                    </div>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}

                {/* 双阶段：文笔审 */}
                {audit.styleReview && (
                  <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm space-y-1.5">
                    <div className="text-[11px] font-bold text-slate-900 flex items-center justify-between">
                      <span>阶段 B · 文笔审</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded border font-semibold bg-violet-50 border-violet-200 text-violet-800">
                        {audit.styleReview.score}分
                        {audit.styleReview.polishedApplied ? ' · 已润色' : ''}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-700 leading-relaxed">
                      {audit.styleReview.summary}
                    </p>
                    {(audit.styleReview.suggestions || []).length > 0 && (
                      <ul className="space-y-1">
                        {audit.styleReview.suggestions.map((s, i) => (
                          <li
                            key={i}
                            className="text-[10px] p-1.5 rounded border bg-violet-50/50 border-violet-100 text-slate-700"
                          >
                            建议 {i + 1}. {s}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="text-[10px] text-slate-500">
                      文笔建议不单独阻断定稿；黑名单/升华机检仍可阻断。划线精修可局部处理。
                    </p>
                  </div>
                )}

                {/* 规则机检（可复现，不靠模型自评） */}
                <div
                  className={`p-2.5 border rounded-lg shadow-sm ${
                    audit.ruleScan?.passed === false
                      ? 'bg-amber-50 border-amber-300'
                      : 'bg-white border-slate-200'
                  }`}
                >
                  <div className="text-[11px] font-bold text-slate-900 mb-1.5 flex items-center justify-between">
                    <span>规则机检 RuleScan</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                        audit.ruleScan?.passed === false
                          ? 'bg-amber-100 border-amber-300 text-amber-900'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      }`}
                    >
                      {audit.ruleScan
                        ? audit.ruleScan.passed
                          ? '通过'
                          : '未通过·禁绿通'
                        : '未记录'}
                    </span>
                  </div>
                  {audit.ruleScan ? (
                    <div className="space-y-1.5">
                      <div className="text-[11px] text-slate-700">{audit.ruleScan.summary}</div>
                      <div className="flex flex-wrap gap-1 text-[10px]">
                        <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200">
                          黑名单 {audit.ruleScan.blacklistHits}
                        </span>
                        <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200">
                          升华 {audit.ruleScan.sublimationHits}
                        </span>
                        <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200">
                          情绪标签 {audit.ruleScan.tellHits}
                        </span>
                        <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200">
                          结构 {audit.ruleScan.patternHits ?? 0}
                        </span>
                        <span className="px-1.5 py-0.5 rounded border bg-white border-slate-200 font-mono">
                          机检分 {audit.ruleScan.score}
                        </span>
                        {audit.aiTasteTier && (
                          <span
                            className={`px-1.5 py-0.5 rounded border font-bold ${
                              audit.aiTasteTier === 'heavy'
                                ? 'bg-red-50 border-red-200 text-red-900'
                                : audit.aiTasteTier === 'medium'
                                  ? 'bg-amber-50 border-amber-200 text-amber-900'
                                  : audit.aiTasteTier === 'light'
                                    ? 'bg-sky-50 border-sky-200 text-sky-900'
                                    : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                            }`}
                          >
                            AI味 {audit.aiTasteTier}
                            {audit.aiTasteScore != null ? ` · ${audit.aiTasteScore}` : ''}
                          </span>
                        )}
                      </div>
                      {audit.aiTasteSummary && audit.aiTasteTier !== 'clean' && (
                        <p className="text-[10px] text-slate-600">{audit.aiTasteSummary}</p>
                      )}
                      {audit.ruleScan.hits.length > 0 && (
                        <ul className="max-h-40 overflow-y-auto space-y-1 mt-1">
                          {audit.ruleScan.hits.map((h, i) => {
                            const locateKey = h.sample || h.phrase.replace(/^\[[A-Z]\]/, '');
                            const canLocate =
                              !!onLocateInProse &&
                              !!(h.sample || (h.phrase && !h.phrase.startsWith('[D]')));
                            return (
                              <li
                                key={i}
                                className={`text-[10px] leading-relaxed p-1.5 rounded border ${
                                  h.severity === 'error'
                                    ? 'bg-white border-amber-200 text-amber-950'
                                    : 'bg-slate-50 border-slate-200 text-slate-700'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-1">
                                  <div className="min-w-0">
                                    <span className="font-semibold">
                                      [{h.severity === 'error' ? '阻断' : '提示'}·{h.kind}]
                                    </span>{' '}
                                    {h.phrase}
                                    {h.count > 1 ? ` ×${h.count}` : ''}
                                    {h.sample && (
                                      <div className="text-slate-600 mt-0.5 font-mono truncate">
                                        「{h.sample.slice(0, 36)}」
                                      </div>
                                    )}
                                    <div className="text-slate-500 mt-0.5">{h.suggestion}</div>
                                  </div>
                                  <div className="flex flex-col gap-0.5 shrink-0">
                                    {canLocate && (
                                      <button
                                        type="button"
                                        onClick={() => onLocateInProse?.(locateKey)}
                                        className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-black bg-black text-white hover:bg-neutral-800"
                                        title="在正文中定位"
                                      >
                                        定位
                                      </button>
                                    )}
                                    {onDeslopHit &&
                                      (h.sample || h.kind === 'blacklist') &&
                                      !aiTasteScanBusy && (
                                        <button
                                          type="button"
                                          disabled={isGenerating || isAutoPiloting || locked}
                                          onClick={() =>
                                            void onDeslopHit(h.sample || locateKey)
                                          }
                                          className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50 inline-flex items-center gap-0.5"
                                          title="对该片段局部去AI味并复扫"
                                        >
                                          <Wand2 size={9} />
                                          去味
                                        </button>
                                      )}
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-500">旧章节无 ruleScan 记录，重新跑三步流程可生成。</div>
                  )}
                </div>

                <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
                  <div className="text-[11px] font-bold text-slate-900 mb-1.5 flex items-center justify-between">
                    <span>套话 / 模式命中列表</span>
                    <span className="bg-purple-50 text-purple-700 border border-purple-200 px-1.5 py-0.5 rounded text-[10px]">
                      {audit.removedClichesCount} 处
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(audit.removedClichésList || []).length === 0 && (
                      <span className="text-[10px] text-slate-500">无命中</span>
                    )}
                    {(audit.removedClichésList || []).map((item, i) => (
                      <span key={i} className="text-[10px] bg-slate-100 text-slate-700 border border-slate-200 px-1.5 py-0.5 rounded font-mono">
                        <s>{item}</s>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
                  <div className="text-[11px] font-bold text-slate-900 mb-1 flex items-center justify-between">
                    <span>硬伤冲突列表</span>
                    <span
                      className={`text-[10px] font-semibold flex items-center space-x-1 ${
                        (audit.logicConflicts || []).some(
                          (c) =>
                            c.lane === 'hard' ||
                            (!c.lane &&
                              !c.description.startsWith('[规则机检') &&
                              !c.description.startsWith('[文笔建议]'))
                        )
                          ? 'text-red-700'
                          : 'text-emerald-600'
                      }`}
                    >
                      <CheckCircle size={11} />
                      <span>
                        {(audit.logicConflicts || []).filter(
                          (c) => c.lane === 'hard' || (!c.lane && !c.description.startsWith('['))
                        ).length > 0
                          ? '有硬伤线索'
                          : '无硬伤'}
                      </span>
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600 leading-relaxed mt-1">
                    绿通 = 硬伤通过 + 规则机检通过。文笔建议不阻断。
                  </div>
                </div>

                <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
                  <div className="text-[11px] font-bold text-slate-900 mb-1 flex items-center justify-between">
                    <span>截断结尾升华与多余说教</span>
                    <span className="text-[10px] bg-neutral-100 text-neutral-700 border border-neutral-200 px-1.5 py-0.5 rounded font-mono">
                      {styleConfig.forbidEndingSublimation ? '机检生效' : '未开启'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600 leading-relaxed mt-1">
                    {styleConfig.forbidEndingSublimation
                      ? `章末升华命中 ${audit.ruleScan?.sublimationHits ?? audit.removedSublimationsCount ?? 0} 处（规则扫描，非模型自评）。`
                      : '当前允许自由总结，建议前往引擎设置开启以加强沉浸感。'}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-6 text-xs text-slate-500 bg-white border border-slate-200 rounded-lg shadow-sm">
            暂无审校数据，AI 写完本章后自动生成。
          </div>
        )}
      </div>

      {/* 待修清单 */}
      {allChapters && allChapters.length > 0 && onJumpChapter && onToggleRevisionTodo && (
        <RevisionTodosPanel
          chapters={allChapters}
          activeChapterId={chapter.id}
          onJumpChapter={onJumpChapter}
          onOpenForRewrite={onOpenForRewrite}
          onFixFirst={onFixFirstRevision}
          onFixAll={onAiFixAllRevisionTodos}
          onStopFixAll={onStopAiFixAll}
          fixAllRunning={aiFixAllRunning}
          onAiFixTodo={
            onAiFixRevisionTodo
              ? (cid, tid) => void onAiFixRevisionTodo(cid, tid)
              : undefined
          }
          onClearDone={onClearDoneRevisionTodos}
          onMarkAllDone={onMarkAllRevisionTodosDone}
          onToggleTodo={onToggleRevisionTodo}
          busy={isGenerating || isAutoPiloting || aiTasteScanBusy}
        />
      )}

      {/* 修复环折叠行（原区块内容原样收纳） */}
      <div className="p-4 border-b border-slate-200 space-y-2 bg-white">
        <button
          type="button"
          onClick={() => setFixLoopOpen((v) => !v)}
          className="w-full flex items-center justify-between"
        >
          <span className="text-[11px] font-semibold text-slate-900 flex items-center space-x-1.5">
            <RefreshCw size={13} className="text-slate-500" />
            <span>修复环（含 Diff）</span>
          </span>
          <span className="flex items-center gap-1.5">
            {audit && (audit.fixRounds !== undefined || (audit.fixHistory || []).length > 0) && (
              <span className="text-[10px] text-slate-600 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded font-semibold">
                {audit.fixResolved
                  ? `${audit.fixRounds ?? 0} 轮·已解决`
                  : `${audit.fixRounds ?? 0} 轮`}
              </span>
            )}
            {fixLoopOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>
        {fixLoopOpen && (
          <div className="space-y-2">
            {audit &&
            (audit.fixRounds !== undefined ||
              (audit.fixHistory || []).length > 0 ||
              audit.revisionRollback) ? (
              <div className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm">
                <div className="text-[11px] font-bold text-slate-900 mb-1.5 flex items-center justify-between">
                  <span>冲突修复环 · Diff (Step4)</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                      audit.fixResolved
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : (audit.fixRounds ?? 0) > 0
                          ? 'bg-amber-50 border-amber-300 text-amber-900'
                          : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    {(audit.fixRounds ?? 0) === 0
                      ? '未触发'
                      : audit.fixResolved
                        ? `${audit.fixRounds} 轮·已解决`
                        : `${audit.fixRounds} 轮·未解决`}
                  </span>
                </div>
                {/* 回退提示：修复环触发净提升止损 / 择优回退后，最终态为最高分快照 */}
                {audit.revisionRollback && (
                  <div
                    className="mb-1.5 text-[11px] font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1"
                    title={
                      audit.revisionRollback.reason === 'net-loss'
                        ? '某轮修复后综合分净下降过大，提前止损并回退到最高分快照。'
                        : '修复环结束后最终态不是最高分版本，已回退到最高分快照。'
                    }
                  >
                    ↩ 已回退到最高分版本（{audit.revisionRollback.fromScore}→
                    {audit.revisionRollback.toScore}
                    {audit.revisionRollback.reason === 'net-loss'
                      ? ' · 净提升止损'
                      : ' · 择优回退'}
                    ）
                  </div>
                )}
                {(audit.fixHistory || []).length === 0 ? (
                  <div className="text-[11px] text-slate-500">机检一次通过，无需修复。</div>
                ) : (
                  <ul className="space-y-2 max-h-56 overflow-y-auto">
                    {(audit.fixHistory || []).map((h) => (
                      <li
                        key={h.round}
                        className="text-[10px] p-2 rounded border border-slate-100 bg-slate-50 text-slate-700 space-y-1"
                      >
                        <div className="flex items-center justify-between gap-1 flex-wrap">
                          <span className="font-semibold">
                            第 {h.round} 轮 · 冲突 {h.conflictCount}
                            {h.localPatchesApplied
                              ? ` · 局部补丁 ${h.localPatchesApplied}`
                              : ''}
                          </span>
                          <span
                            className={
                              h.ruleScanPassedAfter ? 'text-emerald-700' : 'text-amber-800'
                            }
                          >
                            {h.ruleScanPassedAfter ? '机检通过' : '仍未过'}
                            {typeof h.charDelta === 'number' && h.charDelta !== 0
                              ? ` · ${h.charDelta > 0 ? '+' : ''}${h.charDelta}字`
                              : ''}
                          </span>
                        </div>
                        {h.summary ? (
                          <div className="text-slate-600 leading-relaxed">{h.summary}</div>
                        ) : null}
                        {h.diffSummary && (
                          <div className="text-slate-500 font-mono">{h.diffSummary}</div>
                        )}
                        {(h.changesSummary || []).length > 0 && (
                          <ul className="list-disc pl-3 space-y-0.5 text-slate-600">
                            {h.changesSummary!.slice(0, 4).map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        )}
                        {(h.diffHunks || []).length > 0 && (
                          <div className="space-y-1 pt-0.5">
                            {h.diffHunks!.slice(0, 6).map((dh, i) => (
                              <div
                                key={i}
                                className="rounded border border-slate-200 bg-white overflow-hidden"
                              >
                                <div className="px-1.5 py-0.5 text-[9px] font-bold text-slate-500 bg-slate-100">
                                  {dh.kind === 'replace'
                                    ? '替换'
                                    : dh.kind === 'remove'
                                      ? '删除'
                                      : '新增'}
                                </div>
                                {dh.before && (
                                  <div className="px-1.5 py-1 text-red-800/90 bg-red-50/80 leading-relaxed line-clamp-3">
                                    − {dh.before}
                                  </div>
                                )}
                                {dh.after && (
                                  <div className="px-1.5 py-1 text-emerald-900/90 bg-emerald-50/80 leading-relaxed line-clamp-3">
                                    + {dh.after}
                                  </div>
                                )}
                              </div>
                            ))}
                            {(h.diffHunks?.length || 0) > 6 && (
                              <div className="text-[9px] text-slate-400">
                                另有 {(h.diffHunks?.length || 0) - 6} 处未展开
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="text-[11px] text-slate-500 italic p-2 bg-slate-50 rounded border border-slate-200">
                暂无修复环记录，机检通过后不触发。
              </div>
            )}
          </div>
        )}
      </div>

      {/* 去味 / AI 味扫描折叠行（原按钮区块原样收纳） */}
      <div className="p-4 border-b border-slate-200 space-y-2 bg-white">
        <button
          type="button"
          onClick={() => setDeslopOpen((v) => !v)}
          className="w-full flex items-center justify-between"
        >
          <span className="text-[11px] font-semibold text-slate-900 flex items-center space-x-1.5">
            <ScanSearch size={13} className="text-violet-600" />
            <span>去味 / AI 味扫描</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] text-slate-500">本章 · 全书</span>
            {deslopOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>
        {deslopOpen && (onScanAiTasteChapter || onScanAiTasteBook) && (
          <div className="p-2.5 bg-white border border-violet-200 rounded-lg space-y-1.5 shadow-sm">
            <div className="text-[11px] font-bold text-violet-950 flex items-center gap-1">
              <ScanSearch size={13} className="text-violet-600" />
              AI 味只扫（不改正文）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {onScanAiTasteChapter && (
                <button
                  type="button"
                  disabled={aiTasteScanBusy || isGenerating || isAutoPiloting}
                  onClick={() => void onScanAiTasteChapter()}
                  className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  {aiTasteScanBusy ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <ScanSearch size={11} />
                  )}
                  扫本章
                </button>
              )}
              {onScanAiTasteBook && (
                <>
                  <button
                    type="button"
                    disabled={aiTasteScanBusy || isGenerating || isAutoPiloting}
                    onClick={() => void onScanAiTasteBook(false)}
                    className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                  >
                    扫全书
                  </button>
                  <button
                    type="button"
                    disabled={aiTasteScanBusy || isGenerating || isAutoPiloting}
                    onClick={() => void onScanAiTasteBook(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                    title="扫全书并把 medium/heavy 写入待修"
                  >
                    扫全书+待修
                  </button>
                </>
              )}
              {(onBatchDeslopChapter || onBatchDeslopBook) && (
                <label className="inline-flex items-center gap-1 text-[10px] text-slate-600 font-semibold">
                  N=
                  <select
                    value={deslopN}
                    disabled={aiTasteScanBusy}
                    onChange={(e) =>
                      setDeslopN(
                        Math.max(1, Math.min(8, Number(e.target.value) || 3))
                      )
                    }
                    className="text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-white"
                    title="本章批量去味处数；全书模式每章最多 min(N,3)"
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {onBatchDeslopChapter && (
                <button
                  type="button"
                  disabled={
                    aiTasteScanBusy || isGenerating || isAutoPiloting || locked
                  }
                  onClick={() => void onBatchDeslopChapter(deslopN)}
                  className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                  title={`对本章前 ${deslopN} 处 error 依次局部去AI味（费 token）`}
                >
                  <Layers2 size={11} />
                  本章去味×{deslopN}
                </button>
              )}
              {onBatchDeslopBook && (
                <button
                  type="button"
                  disabled={aiTasteScanBusy || isGenerating || isAutoPiloting}
                  onClick={() =>
                    void onBatchDeslopBook(Math.min(3, deslopN))
                  }
                  className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-md border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                  title="medium/heavy 章每章最多去味 min(N,3) 处，全书上限约 20 章"
                >
                  <Wand2 size={11} />
                  全书去味
                </button>
              )}
              {onExportAiTasteCsv && (
                <button
                  type="button"
                  disabled={aiTasteScanBusy}
                  onClick={onExportAiTasteCsv}
                  className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  title="导出各章 AI 味机检为 CSV（建议先扫全书）"
                >
                  <Download size={11} />
                  导出CSV
                </button>
              )}
            </div>
            {aiTasteScanMessage && (
              <p className="text-[10px] text-violet-800 leading-relaxed">{aiTasteScanMessage}</p>
            )}
          </div>
        )}
      </div>
    </>
  );
};
