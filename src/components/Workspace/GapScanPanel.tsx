import React, { useEffect, useState } from 'react';
import type { GapReport, GapKind } from '../../services/gapScanner';
import { kindsToActionLabel } from '../../services/gapScanner';
import type { GapFillProgress, GapFillSummary } from '../../hooks/useGapFiller';
import { IDLE_GAP_FILL_PROGRESS } from '../../hooks/useGapFiller';
import {
  autoPilotWriteModeLabel,
  type AutoPilotWriteMode,
} from '../../services/autoPilot';
import {
  ScanSearch,
  ChevronDown,
  ChevronUp,
  Square,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';

const KIND_LABELS: Record<GapKind, string> = {
  intent_missing: '缺意图',
  intent_fallback: '意图兜底',
  beats_missing: '缺分镜',
  prose_missing: '缺正文',
};

const KIND_BADGE: Record<GapKind, string> = {
  intent_missing: 'bg-red-50 border-red-200 text-red-800',
  intent_fallback: 'bg-amber-50 border-amber-200 text-amber-900',
  beats_missing: 'bg-purple-50 border-purple-200 text-purple-800',
  prose_missing: 'bg-rose-50 border-rose-200 text-rose-800',
};

interface GapScanPanelProps {
  report: GapReport | null;
  filling: boolean;
  progress?: GapFillProgress;
  summary: GapFillSummary | null;
  /** 其他生成任务进行中（三步 / Auto-Pilot） */
  busy: boolean;
  onScan: () => void;
  onStartFilling: (chapterIds: string[], writeMode: AutoPilotWriteMode) => void;
  onStopFilling: () => void;
}

/**
 * 全书缺口扫描 + 批量补跑（折叠卡片，风格与右侧栏其他面板一致）。
 * 扫描 → 逐章勾选（默认全选缺口章，锁定章不在列表）→ 开始补跑（串行）→ 结果汇总。
 */
export const GapScanPanel: React.FC<GapScanPanelProps> = ({
  report,
  filling,
  progress = IDLE_GAP_FILL_PROGRESS,
  summary,
  busy,
  onScan,
  onStartFilling,
  onStopFilling,
}) => {
  const [open, setOpen] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [writeMode, setWriteMode] = useState<AutoPilotWriteMode>('until_review');

  // 扫描结果更新 → 默认全选缺口章（锁定章永不进入列表）
  useEffect(() => {
    if (report) {
      setCheckedIds(new Set(report.chapterGaps.map((g) => g.chapterId)));
    }
  }, [report]);

  const gapCount = report?.chapterGaps.length ?? 0;
  const checkedCount = checkedIds.size;

  const toggleAll = (checked: boolean) => {
    if (!report) return;
    setCheckedIds(
      checked
        ? new Set(report.chapterGaps.map((g) => g.chapterId))
        : new Set()
    );
  };

  const toggleOne = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startFilling = () => {
    const ids = [...checkedIds];
    if (ids.length) onStartFilling(ids, writeMode);
  };

  const barPercent = Math.min(
    100,
    (progress.current / Math.max(1, progress.total)) * 100
  );

  return (
    <div className="p-4 border-b border-slate-200 bg-white space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between"
      >
        <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
          <ScanSearch size={14} className="text-cyan-600" />
          <span>全书缺口扫描</span>
          {filling && <Loader2 size={12} className="animate-spin text-cyan-600" />}
        </span>
        <span className="flex items-center gap-1.5">
          {!filling && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${
                !report
                  ? 'bg-slate-50 text-slate-600 border-slate-200'
                  : gapCount > 0
                    ? 'bg-rose-50 text-rose-800 border-rose-200'
                    : 'bg-emerald-50 text-emerald-800 border-emerald-200'
              }`}
            >
              {!report ? '未扫描' : gapCount > 0 ? `缺口 ${gapCount} 章` : '无缺口'}
            </span>
          )}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div className="space-y-2.5">
          {/* 扫描按钮 */}
          <button
            type="button"
            disabled={filling || busy}
            onClick={onScan}
            className="w-full inline-flex items-center justify-center gap-1 text-[11px] font-bold py-1.5 px-2 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            <ScanSearch size={12} />
            扫描全书缺口
          </button>

          {/* 补跑执行中：进度条 + 当前章 + 停止 */}
          {filling ? (
            <div className="p-2.5 bg-cyan-50 border border-cyan-200 rounded-lg space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-bold text-cyan-900">
                <span className="flex items-center gap-1">
                  <Loader2 size={11} className="animate-spin" />
                  补跑中 {progress.current}/{progress.total}
                </span>
                <button
                  type="button"
                  onClick={onStopFilling}
                  className="inline-flex items-center gap-0.5 text-[11px] font-bold px-1.5 py-0.5 rounded-md border border-black bg-black text-white hover:bg-neutral-800"
                >
                  <Square size={9} />
                  停止
                </button>
              </div>
              <div className="w-full bg-cyan-100 h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-cyan-600 h-full transition-all duration-500"
                  style={{ width: `${barPercent}%` }}
                />
              </div>
              <p className="text-[10px] text-cyan-900 font-mono leading-relaxed break-words">
                {progress.message || '准备中...'}
              </p>
              {progress.stage === 'fail' && (
                <p className="text-[10px] text-rose-700">
                  失败容忍：当前章失败会继续下一章。
                </p>
              )}
            </div>
          ) : (
            <>
              {/* 结果汇总 */}
              {summary && (
                <div
                  className={`p-2.5 rounded-lg border space-y-1.5 ${
                    summary.aborted
                      ? 'bg-amber-50 border-amber-200'
                      : summary.failed > 0 || summary.warnings.length > 0
                        ? 'bg-orange-50 border-orange-200'
                        : 'bg-emerald-50 border-emerald-200'
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] font-bold">
                    <span className="flex items-center gap-1">
                      {summary.aborted ? (
                        <Square size={11} className="text-amber-700" />
                      ) : summary.failed > 0 ? (
                        <XCircle size={11} className="text-orange-700" />
                      ) : (
                        <CheckCircle2 size={11} className="text-emerald-700" />
                      )}
                      {summary.aborted
                        ? '已停止'
                        : summary.total === 0
                          ? '无需补跑'
                          : '补跑完成'}
                    </span>
                    <span className="text-[10px] font-mono text-slate-700">
                      成功 {summary.ok} · 失败 {summary.failed} · 跳过 {summary.skipped}
                    </span>
                  </div>
                  {(summary.failures.length > 0 || summary.warnings.length > 0) && (
                    <div className="max-h-32 overflow-y-auto space-y-1">
                      {summary.failures.map((f, i) => (
                        <p
                          key={`f${i}`}
                          className="text-[10px] text-rose-800 bg-white/70 border border-rose-100 rounded p-1.5 leading-relaxed"
                        >
                          <span className="font-bold">第{f.chapterNumber}章《{f.title}》</span>
                          ：{f.reason}
                        </p>
                      ))}
                      {summary.warnings.map((w, i) => (
                        <p
                          key={`w${i}`}
                          className="text-[10px] text-amber-800 bg-white/70 border border-amber-100 rounded p-1.5 leading-relaxed flex items-start gap-1"
                        >
                          <AlertTriangle size={10} className="shrink-0 mt-0.5" />
                          <span>
                            <span className="font-bold">第{w.chapterNumber}章《{w.title}》</span>
                            ：{w.reason}
                          </span>
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 无缺口 */}
              {report && gapCount === 0 && (
                <p className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5">
                  ✅ 全书 {report.totalChapters} 章均无缺口（锁定 {report.lockedChapters} 章视为认可现状）。
                </p>
              )}

              {/* 缺口列表 + 补跑配置 */}
              {report && gapCount > 0 && (
                <>
                  <div className="flex items-center justify-between text-[10px] text-slate-600">
                    <span>
                      缺口 {gapCount} 章 · 锁定 {report.lockedChapters} · 干净{' '}
                      {report.cleanChapters}
                    </span>
                    <span className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => toggleAll(true)}
                        className="text-[10px] font-bold text-cyan-700 hover:underline"
                      >
                        全选
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleAll(false)}
                        className="text-[10px] font-bold text-slate-500 hover:underline"
                      >
                        清空
                      </button>
                    </span>
                  </div>

                  <div className="max-h-44 overflow-y-auto space-y-1 pr-1">
                    {report.chapterGaps.map((g) => (
                      <label
                        key={g.chapterId}
                        className="flex items-start gap-1.5 p-1.5 bg-slate-50 border border-slate-200 rounded-lg cursor-pointer hover:bg-white"
                        title={kindsToActionLabel(g.kinds)}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-cyan-600"
                          checked={checkedIds.has(g.chapterId)}
                          onChange={() => toggleOne(g.chapterId)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] font-bold text-slate-800 truncate">
                            第 {g.chapterNumber} 章《{g.title}》
                          </span>
                          <span className="flex flex-wrap gap-1 mt-0.5">
                            {g.kinds.map((k) => (
                              <span
                                key={k}
                                className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${KIND_BADGE[k]}`}
                              >
                                {KIND_LABELS[k]}
                              </span>
                            ))}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <select
                      value={writeMode}
                      onChange={(e) =>
                        setWriteMode(e.target.value as AutoPilotWriteMode)
                      }
                      className="flex-1 px-2 py-1 border border-slate-300 rounded-lg bg-white text-[11px] font-medium text-slate-800"
                      title="补跑写作深度：完整闭环并待人工 / 完整闭环并锁定 / 只写草稿"
                    >
                      <option value="until_review">
                        {autoPilotWriteModeLabel('until_review')}
                      </option>
                      <option value="until_green">
                        {autoPilotWriteModeLabel('until_green')}
                      </option>
                      <option value="draft_only">
                        {autoPilotWriteModeLabel('draft_only')}
                      </option>
                    </select>
                    <button
                      type="button"
                      disabled={checkedCount === 0 || busy}
                      onClick={startFilling}
                      className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold py-1.5 px-2.5 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
                    >
                      <CheckCircle2 size={11} />
                      开始补跑（{checkedCount}）
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    按章号串行补跑：缺意图先补意图，再走单章管线补分镜/正文；
                    锁定章与已有有效产出的章一律跳过，不覆盖任何现有内容。
                  </p>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
