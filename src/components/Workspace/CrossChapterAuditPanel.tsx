import React, { useState } from 'react';
import type { CrossChapterAuditReport, CrossChapterIssue } from '../../types/novel';
import type { CrossAuditRemindStatus } from '../../services/crossAuditRemind';
import {
  Radar,
  Loader2,
  AlertTriangle,
  XCircle,
  Info,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Bell,
  ExternalLink,
  Wrench,
} from 'lucide-react';

interface CrossChapterAuditPanelProps {
  report?: CrossChapterAuditReport | null;
  busy?: boolean;
  onRun: (useLlm: boolean) => Promise<void> | void;
  /** 到期提醒（每 N 章） */
  remind?: CrossAuditRemindStatus | null;
  onDismissRemind?: () => void;
  /**
   * 点击 issue / 章号跳转。
   * preferredChapterNumber：点了具体「第N章」芯片时传入。
   */
  onJumpIssue?: (issue: CrossChapterIssue, preferredChapterNumber?: number) => void;
  /** 抽检未过后：AI 修第一条待修（优先跨章） */
  onFixFirst?: () => void;
}

function SevIcon({ s }: { s: 'error' | 'warn' | 'info' }) {
  if (s === 'error') return <XCircle size={13} className="text-red-600 shrink-0" />;
  if (s === 'warn') return <AlertTriangle size={13} className="text-amber-600 shrink-0" />;
  return <Info size={13} className="text-sky-600 shrink-0" />;
}

export const CrossChapterAuditPanel: React.FC<CrossChapterAuditPanelProps> = ({
  report,
  busy = false,
  onRun,
  remind,
  onDismissRemind,
  onJumpIssue,
  onFixFirst,
}) => {
  const [open, setOpen] = useState(false);
  const [useLlm, setUseLlm] = useState(true);
  const due = !!remind?.due;

  return (
    <div className="p-4 border-b border-slate-200 bg-white space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between"
      >
        <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
          <Radar size={14} className="text-cyan-600" />
          跨章连贯抽检
          {due && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300 font-bold flex items-center gap-0.5">
              <Bell size={10} />
              到期
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5">
          {report && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${
                report.score >= 80
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : report.score >= 60
                    ? 'bg-amber-50 text-amber-900 border-amber-200'
                    : 'bg-red-50 text-red-800 border-red-200'
              }`}
            >
              {report.score}分 · {report.issues.length}项
            </span>
          )}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div className="space-y-2">
          {due && remind && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 space-y-1.5">
              <div className="flex items-start gap-1.5 text-[10px] text-amber-950 leading-relaxed">
                <Bell size={12} className="shrink-0 mt-0.5 text-amber-700" />
                <span className="font-medium">{remind.message}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRun(true)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-black text-white text-[11px] font-bold hover:bg-neutral-800 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Radar size={11} />}
                  立即抽检
                </button>
                {onDismissRemind && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onDismissRemind}
                    className="px-2 py-1 rounded-md border border-black bg-black text-white text-[11px] font-bold hover:bg-neutral-800 disabled:opacity-50"
                  >
                    再写 {remind.interval} 章后提醒
                  </button>
                )}
              </div>
            </div>
          )}

          {!due && remind && remind.chaptersWithContent > 0 && (
            <p className="text-[10px] text-slate-500 leading-relaxed">{remind.message}</p>
          )}

          {!remind && (
            <p className="text-[10px] text-slate-500 leading-relaxed">
              检查近章是否遗忘伏笔、角色状态矛盾、与钉死事实冲突、主线停滞等。建议每 3～5 章跑一次。
              {onJumpIssue ? ' 点问题可跳转相关章。' : ''}
            </p>
          )}

          {due && (
            <p className="text-[10px] text-slate-500 leading-relaxed">
              检查近章是否遗忘伏笔、角色状态矛盾、与钉死事实冲突、主线停滞等。
              {onJumpIssue ? ' 点问题可跳转相关章。' : ''}
            </p>
          )}

          <label className="flex items-center gap-2 text-[10px] text-slate-600">
            <input
              type="checkbox"
              checked={useLlm}
              onChange={(e) => setUseLlm(e.target.checked)}
              disabled={busy}
            />
            使用模型加深（关闭则仅本地启发，更快）
          </label>

          <button
            type="button"
            disabled={busy}
            onClick={() => onRun(useLlm)}
            className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-bold py-2 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Radar size={13} />}
            {busy ? '抽检中…' : due ? '运行跨章抽检（建议）' : '运行跨章抽检'}
          </button>

          {report && (
            <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2.5 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-[11px] font-bold text-slate-900">{report.summary}</div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    第{report.rangeFrom}–{report.rangeTo}章 · {report.source} ·{' '}
                    {new Date(report.generatedAt).toLocaleString()}
                  </div>
                </div>
                {report.issues.length === 0 ? (
                  <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
                ) : null}
              </div>

              {report.issues.length === 0 ? (
                <p className="text-[10px] text-emerald-800">未发现明显跨章风险。</p>
              ) : (
                <>
                {onFixFirst &&
                  report.issues.some((i) => i.severity === 'error' || i.severity === 'warn') && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={onFixFirst}
                      className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-bold py-1.5 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                    >
                      <Wrench size={12} />
                      AI修第一处
                    </button>
                  )}
                <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                  {report.issues.map((iss) => {
                    const chNums =
                      iss.chapterNumbers && iss.chapterNumbers.length
                        ? iss.chapterNumbers
                        : [report.rangeTo];
                    const clickable = !!onJumpIssue;
                    return (
                      <li
                        key={iss.id}
                        className={`text-[10px] p-2 rounded-lg border leading-relaxed flex gap-1.5 ${
                          iss.severity === 'error'
                            ? 'bg-red-50/80 border-red-100'
                            : iss.severity === 'warn'
                              ? 'bg-amber-50/70 border-amber-100'
                              : 'bg-white border-slate-200'
                        } ${clickable ? 'hover:ring-1 hover:ring-cyan-300/80 transition-shadow' : ''}`}
                      >
                        <SevIcon s={iss.severity} />
                        <div className="min-w-0 flex-1">
                          {clickable ? (
                            <button
                              type="button"
                              onClick={() => onJumpIssue?.(iss, chNums[0])}
                              className="w-full text-left font-semibold text-slate-900 hover:text-cyan-900"
                              title="跳转相关章并定位待修"
                            >
                              [{iss.kind}] {iss.title}
                              <ExternalLink
                                size={10}
                                className="inline ml-1 text-cyan-700 align-text-top"
                              />
                            </button>
                          ) : (
                            <div className="font-semibold text-slate-900">
                              [{iss.kind}] {iss.title}
                            </div>
                          )}
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {chNums.map((n) =>
                              clickable ? (
                                <button
                                  key={n}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onJumpIssue?.(iss, n);
                                  }}
                                  className="inline-flex items-center px-1.5 py-0.5 rounded border border-black bg-black text-white font-semibold hover:bg-neutral-800"
                                  title={`跳转第${n}章`}
                                >
                                  第{n}章
                                </button>
                              ) : (
                                <span
                                  key={n}
                                  className="inline-flex px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-600"
                                >
                                  第{n}章
                                </span>
                              )
                            )}
                          </div>
                          <div className="text-slate-700 mt-0.5">{iss.detail}</div>
                          {iss.suggestion && (
                            <div className="text-slate-500 mt-0.5">→ {iss.suggestion}</div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
