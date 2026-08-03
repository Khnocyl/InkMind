import React, { useMemo, useState } from 'react';
import type { Chapter, ProjectConfig, StyleConfig } from '../../types/novel';
import { computeBookMetrics, pct } from '../../services/writingMetrics';
import { computeBookProgress } from '../../services/writingProgress';
import {
  computeWritingActivity,
  heatClass,
  heatLevel,
} from '../../services/writingActivity';
import { evaluateDailyGoal } from '../../services/dailyWordLog';
import type { CrossAuditRemindStatus } from '../../services/crossAuditRemind';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Bell,
  Target,
  Flame,
  CheckCircle2,
} from 'lucide-react';

interface WritingDashboardProps {
  chapters: Chapter[];
  projectConfig?: ProjectConfig | null;
  styleConfig?: StyleConfig | null;
  activeChapterId?: string;
  crossAuditRemind?: CrossAuditRemindStatus | null;
  onRunCrossAudit?: () => void;
  dailyWordLog?: Record<string, number> | null;
}

export const WritingDashboard: React.FC<WritingDashboardProps> = ({
  chapters,
  projectConfig,
  styleConfig,
  activeChapterId,
  crossAuditRemind,
  onRunCrossAudit,
  dailyWordLog,
}) => {
  const [open, setOpen] = useState(true);
  const summary = useMemo(
    () => computeBookMetrics(chapters, { projectConfig, styleConfig }),
    [chapters, projectConfig, styleConfig]
  );
  const progress = useMemo(
    () =>
      computeBookProgress({
        chapters,
        config: projectConfig ?? undefined,
      }),
    [chapters, projectConfig]
  );
  const activity = useMemo(() => computeWritingActivity(chapters, { days: 28 }), [chapters]);
  const daily = useMemo(
    () => evaluateDailyGoal(dailyWordLog, styleConfig?.dailyWordTarget ?? 3000),
    [dailyWordLog, styleConfig?.dailyWordTarget]
  );
  const active = summary.chapters.find((c) => c.chapterId === activeChapterId);

  return (
    <div className="p-4 border-b border-slate-200 bg-white space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between"
      >
        <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
          <Activity size={14} className="text-fuchsia-600" />
          写作仪表盘
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono text-slate-600">
            健康 {summary.avgHealth} · 均章 {summary.avgWords}字
          </span>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div className="space-y-2 text-[10px]">
          {(progress.targetWords != null || progress.targetChapters != null) && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-indigo-950 flex items-center gap-1">
                  <Target size={11} className="text-indigo-600" />
                  目标进度
                </span>
                <span className="font-mono text-indigo-900">{progress.wordLabel}</span>
              </div>
              {progress.wordPct != null && (
                <div className="h-1.5 rounded-full bg-indigo-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-indigo-500 transition-all"
                    style={{ width: `${Math.min(100, Math.max(2, progress.wordPct))}%` }}
                  />
                </div>
              )}
              <div className="text-indigo-900/80 flex flex-wrap gap-x-2">
                <span>{progress.chapterLabel}</span>
                {progress.openTodos > 0 && (
                  <span className="text-rose-700 font-semibold">待修 {progress.openTodos}</span>
                )}
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-1.5">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <div className="text-slate-500">全书字数</div>
              <div className="text-sm font-bold text-slate-900 font-mono">
                {summary.totalWords.toLocaleString()}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <div className="text-slate-500">有正文</div>
              <div className="text-sm font-bold text-slate-900 font-mono">
                {summary.withContent}/{summary.chapterCount}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <div className="text-slate-500">对话占比</div>
              <div className="text-sm font-bold text-slate-900 font-mono">
                {pct(summary.avgDialogueRatio)}
              </div>
            </div>
          </div>

          {/* 今日日更目标（账本净增） */}
          {daily.target != null && (
            <div
              className={`rounded-lg border p-2 space-y-1.5 ${
                daily.met
                  ? 'border-emerald-300 bg-emerald-50/70'
                  : 'border-orange-300 bg-orange-50/60'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-900 flex items-center gap-1">
                  {daily.met ? (
                    <CheckCircle2 size={11} className="text-emerald-600" />
                  ) : (
                    <Flame size={11} className="text-orange-600" />
                  )}
                  今日日更目标
                </span>
                <span className="font-mono text-slate-800">
                  {daily.todayWords.toLocaleString()}/{daily.target.toLocaleString()}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-white/80 overflow-hidden border border-slate-100">
                <div
                  className={`h-full rounded-full transition-all ${
                    daily.met ? 'bg-emerald-500' : 'bg-orange-400'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(2, daily.pct ?? 0))}%` }}
                />
              </div>
              <p className="text-[9px] text-slate-600 leading-relaxed">
                {daily.met
                  ? '✅ 今日已达标，可继续加码或休息。'
                  : `还差 ${daily.remaining.toLocaleString()} 字。手改/流水线写章会自动记账。`}
              </p>
            </div>
          )}

          {/* 日更热力（按章 contentUpdatedAt / 锁定日归因） */}
          <div className="rounded-lg border border-orange-200 bg-orange-50/50 p-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-orange-950 flex items-center gap-1">
                <Flame size={11} className="text-orange-600" />
                日更 · 近28天
              </span>
              <span className="font-mono text-orange-900">
                连续 {activity.streak} 天
                {activity.wordsLast7 > 0
                  ? ` · 近7日 ${activity.wordsLast7.toLocaleString()}字`
                  : ''}
              </span>
            </div>
            <div className="flex flex-wrap gap-0.5">
              {activity.days.map((d) => {
                const lv = heatLevel(d.words, activity.maxDayWords);
                return (
                  <div
                    key={d.date}
                    title={`${d.date} · ${d.words}字 · ${d.chapters}章`}
                    className={`w-2.5 h-2.5 rounded-sm border ${heatClass(lv)} ${
                      lv >= 3 ? 'border-transparent' : ''
                    }`}
                  />
                );
              })}
            </div>
            <p className="text-[9px] text-orange-900/60 leading-relaxed">
              热力按章「正文更新日 / 锁定日 / recap 日」归因；今日目标按净增账本，更准。
            </p>
          </div>

          {crossAuditRemind?.due && (
            <div className="rounded-lg border border-cyan-300 bg-cyan-50 px-2 py-1.5 space-y-1">
              <div className="flex gap-1 text-cyan-950">
                <Bell size={11} className="shrink-0 mt-0.5 text-cyan-700" />
                <span>{crossAuditRemind.message}</span>
              </div>
              {onRunCrossAudit && (
                <button
                  type="button"
                  onClick={onRunCrossAudit}
                  className="text-[10px] font-bold text-cyan-800 underline underline-offset-2 hover:text-cyan-950"
                >
                  去跑跨章抽检 →
                </button>
              )}
            </div>
          )}

          {summary.alerts.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 space-y-0.5">
              {summary.alerts.map((a, i) => (
                <div key={i} className="flex gap-1 text-amber-950">
                  <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                  <span>{a}</span>
                </div>
              ))}
            </div>
          )}

          {active && active.wordCount > 0 && (
            <div className="rounded-lg border border-fuchsia-100 bg-fuchsia-50/40 p-2 space-y-1">
              <div className="font-bold text-slate-900">
                本章 · 第{active.number}章 健康 {active.healthScore}
              </div>
              <div className="font-mono text-slate-600">
                {active.wordCount}字
                {active.targetWords != null
                  ? ` / 目标${active.targetWords}（${
                      active.targetDelta! >= 0 ? '+' : ''
                    }${active.targetDelta}）`
                  : ''}
                {' · '}
                对话{pct(active.dialogueRatio)} · 均句{active.avgSentenceLen}字 · 注水
                {active.paddingScore}
              </div>
              {active.flags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {active.flags.map((f) => (
                    <span
                      key={f}
                      className="px-1.5 py-0.5 rounded border border-fuchsia-200 bg-white text-fuchsia-900"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="max-h-36 overflow-y-auto space-y-1">
            {summary.chapters
              .filter((c) => c.wordCount > 0)
              .slice(-12)
              .reverse()
              .map((c) => (
                <div
                  key={c.chapterId}
                  className={`flex items-center justify-between gap-2 px-2 py-1 rounded border ${
                    c.chapterId === activeChapterId
                      ? 'border-fuchsia-300 bg-fuchsia-50'
                      : 'border-slate-100 bg-slate-50'
                  }`}
                >
                  <span className="truncate text-slate-800">
                    {c.number}. {c.title}
                  </span>
                  <span className="font-mono text-slate-600 shrink-0">
                    {c.wordCount} · H{c.healthScore}
                    {c.paddingScore >= 40 ? ' · 水' : ''}
                  </span>
                </div>
              ))}
            {summary.withContent === 0 && (
              <p className="text-slate-400 text-center py-2">写完章节后显示逐章指标</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
