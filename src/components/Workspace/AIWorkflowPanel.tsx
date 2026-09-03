import React, { useState } from 'react';
import type { AIWorkflowPanelProps, WorkflowGroup } from '../Workflow/types';
import {
  CheckCircle,
  Sparkles,
  Square,
  RefreshCw,
  PenLine,
  ShieldCheck,
  Layers,
} from 'lucide-react';
import { shouldConfirmPrewrite } from './PrewriteCheckPanel';
import { WriteGroup } from '../Workflow/WriteGroup';
import { AuditGroup } from '../Workflow/AuditGroup';
import { BookGroup } from '../Workflow/BookGroup';
import { isChapterLocked, lockReason } from '../../services/chapterLock';
import { isIntentConfirmed } from '../../services/chapterIntent';
import { chapterDisplayTitle } from '../../services/chapterTitle';

/**
 * 右栏 AI 工作流（简约化 IA）：
 * 常驻区 4 件套 = 状态行（章名+锁定态）/ 进度条（5 阶段）/ 主按钮（写这一章 ↔ 停止生成）/
 * 三分组标签（写作/审校/全书，带徽标）。原 18 张平铺卡片按组收纳进 Workflow/ 子组件。
 * 分组切换用 display（hidden）而非条件卸载，保持子组件内部状态；生成期间冻结分组视图。
 */
export const AIWorkflowPanel: React.FC<AIWorkflowPanelProps> = ({
  chapter, characters, settings, styleConfig,
  projectConfig, storyMemory, allChapters,
  isGenerating, isAutoPiloting = false,
  autoPilotProgress = { done: 0, target: 0 },
  activeStep, statusMessage, previousContextPack,
  onStartThreeStepWorkflow,
  onStartAutoPilot, onStopAutoPilot, onStopGeneration,
  onUpdateStyleConfig, onUpdateBeats: _onUpdateBeats,
  projectId, snapshotRefreshToken = 0,
  onManualSnapshot, onRestoreSnapshot,
  onLockChapter, onUnlockChapter,
  onGenerateChapterIntent, onSaveChapterIntent,
  crossAuditReport, crossAuditBusy, onRunCrossAudit,
  crossAuditRemind, onDismissCrossAuditRemind,
  onJumpChapter, onOpenForRewrite, onJumpAuditIssue,
  onFixFirstRevision,
  onAiFixAllRevisionTodos, onStopAiFixAll, aiFixAllRunning = false,
  onAiFixRevisionTodo, onRerunHardReview,
  onClearDoneRevisionTodos, onMarkAllRevisionTodosDone, onToggleRevisionTodo,
  onLocateInProse, onScanAiTasteChapter, onScanAiTasteBook,
  onDeslopHit, onBatchDeslopChapter, onBatchDeslopBook, onExportAiTasteCsv,
  aiTasteScanBusy = false, aiTasteScanMessage = null, dailyWordLog,
  gapReport = null, gapFilling = false, gapProgress, gapSummary = null,
  onScanGaps, onStartGapFilling, onStopGapFilling,
}) => {
  // 当前分组（默认「写作」，不持久化）
  const [activeGroup, setActiveGroup] = useState<WorkflowGroup>('write');
  const locked = isChapterLocked(chapter);
  const pack = previousContextPack || null;
  // 分组徽标：审校=本章 open 待修数；全书=gapReport 缺口章数（无则不显示）
  const auditBadgeCount = (chapter.revisionTodos || []).filter(
    (t) => t.status === 'open'
  ).length;
  const bookBadgeCount = gapReport?.gapChapters ?? 0;

  const guardAndStart = (kind: 'single' | 'autopilot') => {
    // Auto-Pilot 永不覆盖锁定章（由选章逻辑跳过）；此处仅提示
    if (kind === 'autopilot' && locked) {
      window.alert(
        `当前章已定稿锁定，Auto-Pilot 会自动跳过锁定章，只写未完成章节。\n\n${lockReason(chapter)}`
      );
    }
    // 单章：写前大纲未确认则强提示（仍可强行写）
    if (kind === 'single' && !isIntentConfirmed(chapter.intent)) {
      const ok = window.confirm(
        '写前大纲尚未确认（目标/禁止/钩子）。\n\n建议先「AI 生成大纲」并点「确认大纲」再开写。\n\n仍要强行开写吗？'
      );
      if (!ok) return;
    }
    const { needConfirm, message, report } = shouldConfirmPrewrite(
      chapter,
      characters,
      settings,
      styleConfig,
      pack,
      projectConfig,
      storyMemory
    );
    if (needConfirm) {
      const header =
        kind === 'autopilot'
          ? `【Auto-Pilot 写前体检 ${report.score}分】\n`
          : `【单章写前体检 ${report.score}分】\n`;
      if (!window.confirm(header + message)) return;
    }
    if (kind === 'single') onStartThreeStepWorkflow();
    else onStartAutoPilot?.();
  };

  const canStopNow = isAutoPiloting ? !!onStopAutoPilot : !!onStopGeneration;
  const groupTabs: {
    key: WorkflowGroup;
    label: string;
    icon: React.FC<{ size?: number }>;
    badge: number;
    badgeClass: string;
  }[] = [
    { key: 'write', label: '写作', icon: PenLine, badge: 0, badgeClass: '' },
    {
      key: 'audit',
      label: '审校',
      icon: ShieldCheck,
      badge: auditBadgeCount,
      badgeClass: 'bg-[#be123c] text-white',
    },
    {
      key: 'book',
      label: '全书',
      icon: Layers,
      badge: bookBadgeCount,
      badgeClass: 'bg-[#b45309] text-white',
    },
  ];

  return (
    <aside className="w-80 bg-white border-l border-neutral-200 flex flex-col h-full shrink-0 overflow-y-auto text-black select-none rounded-br-[28px]">
      {/* 常驻区 ①：状态行（章名 + 锁定态）+ 进度条（5 阶段） */}
      <div className="px-4 pt-3.5 pb-3 border-b border-slate-200 bg-white sticky top-0 z-10 shadow-sm space-y-2">
        <div className="flex items-center justify-between gap-2">
          {(() => {
            const displayTitle = chapterDisplayTitle(chapter.title);
            const label = displayTitle
              ? `第${chapter.number}章 ${displayTitle}`
              : `第${chapter.number}章`;
            return (
              <span
                className="text-xs font-bold text-slate-900 truncate"
                title={label}
              >
                {label}
              </span>
            );
          })()}
          {locked ? (
            <span className="text-[10px] font-bold text-emerald-800 bg-emerald-50 border border-emerald-300 px-1.5 py-0.5 rounded-full shrink-0">
              已锁定
            </span>
          ) : (
            <span className="text-[10px] text-slate-500 shrink-0">未锁定</span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {chapter.status === '校验通过' && !chapter.memoryAudit?.ruleScanBlocked && !locked && (
            <span className="text-[10px] bg-emerald-50 border border-emerald-300 text-emerald-800 px-2 py-0.5 rounded-full font-bold flex items-center space-x-1">
              <CheckCircle size={10} className="text-emerald-600" />
              <span>自检达标</span>
            </span>
          )}
          {(chapter.status === '待人工确认' || chapter.memoryAudit?.ruleScanBlocked) && (
            <span className="text-[10px] bg-amber-50 border border-amber-300 text-amber-900 px-2 py-0.5 rounded-full font-bold">
              待人工确认
            </span>
          )}
        </div>
        <div>
          <div className="flex justify-between text-[11px] text-slate-600 mb-1">
            <span>执行进度:</span>
            <span className="font-mono font-bold text-neutral-800">
              {activeStep === 0
                ? '待开始'
                : activeStep >= 5
                  ? '记忆回写 5/5'
                  : activeStep === 4
                    ? '修复环 4/5'
                    : `第 ${activeStep}/5 阶段`}
            </span>
          </div>
          <div className="w-full bg-slate-200 h-[5px] rounded-full overflow-hidden">
            <div
              className="h-full transition-all duration-500"
              style={{
                width: `${(Math.min(activeStep, 5) / 5) * 100}%`,
                backgroundColor: 'var(--app-button-primary-bg)',
              }}
            />
          </div>
          {activeStep !== 0 && (
            <p className="text-[11px] text-slate-600 mt-1.5 leading-relaxed">
              {activeStep === 1 && '💡 正在拆分分镜...'}
              {activeStep === 2 && '✍️ 正在写作正文...'}
              {activeStep === 3 && '🛡️ 审校与机检...'}
              {activeStep === 4 && '🔧 修复问题...'}
              {activeStep === 5 && '🧠 更新角色状态...'}
            </p>
          )}
        </div>
      </div>

      {/* 常驻区 ②：主按钮（写这一章 ↔ 停止生成） */}
      <div className="px-4 pt-3">
        {isGenerating ? (
          <button
            type="button"
            disabled={!canStopNow}
            onClick={isAutoPiloting ? onStopAutoPilot : onStopGeneration}
            className="w-full py-3 px-4 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-2 border border-rose-300 bg-white text-rose-700 hover:bg-rose-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              isAutoPiloting
                ? '停止 Auto-Pilot：中断当前章并停机（草稿保留）'
                : '停止生成：中断当前章的全部 AI 调用（已产出部分保留为草稿）'
            }
          >
            <Square size={13} />
            <span>停止生成</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => guardAndStart('single')}
            className="w-full py-3 px-4 text-white rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-2 shadow-md transform hover:-translate-y-0.5 bg-black hover:bg-neutral-800"
          >
            <Sparkles size={15} />
            <span>{locked ? '重写本章（将先解锁）' : '✨ 写这一章'}</span>
          </button>
        )}
      </div>

      {/* 常驻区 ③：生成中状态（mono 状态消息通道） */}
      {isGenerating && (
        <div className="mx-4 mt-2.5 py-[9px] px-[11px] bg-slate-50 border border-slate-200 rounded-xl space-y-2">
          <div className="flex items-center space-x-2 font-bold text-slate-900 text-xs">
            <RefreshCw size={13} className="animate-spin" />
            <span>
              {isAutoPiloting
                ? `Auto-Pilot ${autoPilotProgress.done}/${autoPilotProgress.target}`
                : `推理中 [阶段 ${Math.min(activeStep, 5)}/5]`}
            </span>
          </div>
          {isAutoPiloting && autoPilotProgress.target > 0 && (
            <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
              <div
                className="h-full transition-all duration-500"
                style={{
                  width: `${Math.min(100, (autoPilotProgress.done / autoPilotProgress.target) * 100)}%`,
                  backgroundColor: 'var(--app-button-primary-bg)',
                }}
              />
            </div>
          )}
          <div className="text-[11px] text-slate-800 font-mono leading-relaxed bg-white p-2.5 rounded-lg border border-slate-200 shadow-inner">
            {statusMessage || '正在连通服务端后端接口进行推理...'}
          </div>
        </div>
      )}
      {isGenerating && (
        <div className="mx-4 mt-2 py-2 px-[11px] bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
          <div className="flex items-center justify-between text-[10.5px]">
            <span className="text-slate-500">流式草稿备份</span>
            <span className="text-[9.5px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-[1px]">
              已产出实时保留
            </span>
          </div>
          <div className="flex items-center justify-between text-[10.5px]">
            <span className="text-slate-500">崩溃恢复</span>
            <span className="text-[10px] text-slate-500">重开书自动询问</span>
          </div>
        </div>
      )}

      {/* 常驻区 ④：三分组标签（生成中禁点防误触） */}
      <div
        className={`px-4 pt-3 ${isGenerating ? 'opacity-45 pointer-events-none' : ''}`}
        aria-disabled={isGenerating}
      >
        <div className="flex gap-[3px] bg-slate-100 border border-slate-200 rounded-[9px] p-[3px]">
          {groupTabs.map(({ key, label, icon: Icon, badge, badgeClass }) => (
            <button
              key={key}
              type="button"
              disabled={isGenerating}
              onClick={() => setActiveGroup(key)}
              className={`flex-1 flex items-center justify-center gap-1.5 text-[11px] font-semibold py-1.5 rounded-[7px] transition-colors disabled:cursor-not-allowed ${
                activeGroup === key
                  ? 'bg-[#111111] text-white'
                  : 'text-slate-600 hover:bg-slate-200/70'
              }`}
            >
              <Icon size={12} />
              <span>{label}</span>
              {badge > 0 && (
                <span
                  className={`min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold inline-flex items-center justify-center ${badgeClass} ${
                    activeGroup === key ? 'ring-2 ring-[#111111]' : ''
                  }`}
                >
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 分组视图：display 切换（hidden）保持子组件状态；生成期间冻结为进度视图 */}
      <div className={isGenerating ? 'hidden' : ''}>
        <div className={activeGroup === 'write' ? '' : 'hidden'}>
          <WriteGroup
            chapter={chapter}
            characters={characters}
            settings={settings}
            styleConfig={styleConfig}
            isGenerating={isGenerating}
            isAutoPiloting={isAutoPiloting}
            locked={locked}
            onLockChapter={onLockChapter}
            onUnlockChapter={onUnlockChapter}
            onStartAutoPilot={onStartAutoPilot}
            onLaunchAutoPilot={() => guardAndStart('autopilot')}
            onUpdateStyleConfig={onUpdateStyleConfig}
            onGenerateChapterIntent={onGenerateChapterIntent}
            onSaveChapterIntent={onSaveChapterIntent}
          />
        </div>
        <div className={activeGroup === 'audit' ? '' : 'hidden'}>
          <AuditGroup
            chapter={chapter}
            allChapters={allChapters}
            styleConfig={styleConfig}
            isGenerating={isGenerating}
            isAutoPiloting={isAutoPiloting}
            locked={locked}
            aiTasteScanBusy={aiTasteScanBusy}
            aiTasteScanMessage={aiTasteScanMessage}
            onRerunHardReview={onRerunHardReview}
            onJumpChapter={onJumpChapter}
            onOpenForRewrite={onOpenForRewrite}
            onFixFirstRevision={onFixFirstRevision}
            onAiFixAllRevisionTodos={onAiFixAllRevisionTodos}
            onStopAiFixAll={onStopAiFixAll}
            aiFixAllRunning={aiFixAllRunning}
            onAiFixRevisionTodo={onAiFixRevisionTodo}
            onClearDoneRevisionTodos={onClearDoneRevisionTodos}
            onMarkAllRevisionTodosDone={onMarkAllRevisionTodosDone}
            onToggleRevisionTodo={onToggleRevisionTodo}
            onLocateInProse={onLocateInProse}
            onScanAiTasteChapter={onScanAiTasteChapter}
            onScanAiTasteBook={onScanAiTasteBook}
            onDeslopHit={onDeslopHit}
            onBatchDeslopChapter={onBatchDeslopChapter}
            onBatchDeslopBook={onBatchDeslopBook}
            onExportAiTasteCsv={onExportAiTasteCsv}
          />
        </div>
        <div className={activeGroup === 'book' ? '' : 'hidden'}>
          <BookGroup
            chapter={chapter}
            allChapters={allChapters}
            characters={characters}
            settings={settings}
            styleConfig={styleConfig}
            projectConfig={projectConfig}
            storyMemory={storyMemory}
            previousContextPack={pack}
            isGenerating={isGenerating}
            isAutoPiloting={isAutoPiloting}
            dailyWordLog={dailyWordLog}
            crossAuditReport={crossAuditReport}
            crossAuditBusy={crossAuditBusy}
            onRunCrossAudit={onRunCrossAudit}
            crossAuditRemind={crossAuditRemind}
            onDismissCrossAuditRemind={onDismissCrossAuditRemind}
            onJumpAuditIssue={onJumpAuditIssue}
            onFixFirstRevision={onFixFirstRevision}
            projectId={projectId}
            snapshotRefreshToken={snapshotRefreshToken}
            onManualSnapshot={onManualSnapshot}
            onRestoreSnapshot={onRestoreSnapshot}
            gapReport={gapReport}
            gapFilling={gapFilling}
            gapProgress={gapProgress}
            gapSummary={gapSummary}
            onScanGaps={onScanGaps}
            onStartGapFilling={onStartGapFilling}
            onStopGapFilling={onStopGapFilling}
          />
        </div>
      </div>
      {!isGenerating && (
        <div className="mt-auto px-4 py-3 text-center text-[10px] text-slate-500 leading-relaxed border-t border-slate-100 rounded-br-[28px]">
          审校{' '}
          {auditBadgeCount > 0 ? (
            <b className="text-[#be123c]">{auditBadgeCount} 条待处理</b>
          ) : (
            '无待办'
          )}{' '}
          · 全书{' '}
          {bookBadgeCount > 0 ? (
            <b className="text-[#b45309]">{bookBadgeCount} 章缺口</b>
          ) : (
            '无缺口'
          )}
          <br />
          点击分组标签查看
        </div>
      )}
    </aside>
  );
};
