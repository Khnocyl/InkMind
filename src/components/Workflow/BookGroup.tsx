import React, { useState } from 'react';
import type {
  Chapter,
  Character,
  WorldSetting,
  StyleConfig,
  ProjectConfig,
  StoryMemory,
  CrossChapterAuditReport,
} from '../../types/novel';
import type { PreviousContextPack } from '../../services/contextPack';
import type { GapReport } from '../../services/gapScanner';
import type { GapFillProgress, GapFillSummary } from '../../hooks/useGapFiller';
import type { CrossAuditRemindStatus } from '../../services/crossAuditRemind';
import type { AutoPilotWriteMode } from '../../services/autoPilot';
import { WritingDashboard } from '../Workspace/WritingDashboard';
import { GapScanPanel } from '../Workspace/GapScanPanel';
import { CrossChapterAuditPanel } from '../Workspace/CrossChapterAuditPanel';
import { SnapshotPanel } from '../Workspace/SnapshotPanel';
import { PrewriteCheckPanel } from '../Workspace/PrewriteCheckPanel';
import {
  ChevronDown,
  ChevronUp,
  Crosshair,
  Camera,
  Stethoscope,
} from 'lucide-react';

interface BookGroupProps {
  chapter: Chapter;
  allChapters?: Chapter[];
  characters: Character[];
  settings: WorldSetting[];
  styleConfig: StyleConfig;
  projectConfig?: ProjectConfig | null;
  storyMemory?: StoryMemory | null;
  previousContextPack?: PreviousContextPack | null;
  isGenerating: boolean;
  isAutoPiloting: boolean;
  dailyWordLog?: Record<string, number> | null;
  crossAuditReport?: CrossChapterAuditReport | null;
  crossAuditBusy?: boolean;
  onRunCrossAudit?: (useLlm: boolean) => Promise<void> | void;
  crossAuditRemind?: CrossAuditRemindStatus | null;
  onDismissCrossAuditRemind?: () => void;
  onJumpAuditIssue?: (
    issue: import('../../types/novel').CrossChapterIssue,
    preferredChapterNumber?: number
  ) => void;
  onFixFirstRevision?: () => void;
  projectId?: string;
  snapshotRefreshToken?: number;
  onManualSnapshot?: () => Promise<void> | void;
  onRestoreSnapshot?: (snapshotId: string) => Promise<void> | void;
  gapReport?: GapReport | null;
  gapFilling?: boolean;
  gapProgress?: GapFillProgress;
  gapSummary?: GapFillSummary | null;
  onScanGaps?: () => void;
  onStartGapFilling?: (chapterIds: string[], writeMode: AutoPilotWriteMode) => void;
  onStopGapFilling?: () => void;
}

/**
 * 右栏分组「全书」：仪表盘 / 缺口扫描常驻，跨章抽检 / 快照 / AI 调用记录 / 写前体检
 * 收入折叠行。全书操作不打断当前章（原显隐条件原样保留）。
 */
export const BookGroup: React.FC<BookGroupProps> = ({
  chapter,
  allChapters,
  characters,
  settings,
  styleConfig,
  projectConfig,
  storyMemory,
  previousContextPack,
  isGenerating,
  isAutoPiloting,
  dailyWordLog,
  crossAuditReport,
  crossAuditBusy,
  onRunCrossAudit,
  crossAuditRemind,
  onDismissCrossAuditRemind,
  onJumpAuditIssue,
  onFixFirstRevision,
  projectId,
  snapshotRefreshToken = 0,
  onManualSnapshot,
  onRestoreSnapshot,
  gapReport = null,
  gapFilling = false,
  gapProgress,
  gapSummary = null,
  onScanGaps,
  onStartGapFilling,
  onStopGapFilling,
}) => {
  const [crossAuditOpen, setCrossAuditOpen] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [prewriteOpen, setPrewriteOpen] = useState(false);
  const pack = previousContextPack || null;

  return (
    <>
      {/* 仪表盘 */}
      {allChapters && allChapters.length > 0 && (
        <WritingDashboard
          chapters={allChapters}
          projectConfig={projectConfig}
          styleConfig={styleConfig}
          activeChapterId={chapter.id}
          crossAuditRemind={crossAuditRemind}
          onRunCrossAudit={onRunCrossAudit ? () => onRunCrossAudit(true) : undefined}
          dailyWordLog={dailyWordLog}
        />
      )}

      {/* 全书缺口扫描 + 批量补跑 */}
      {onScanGaps && onStartGapFilling && onStopGapFilling && (
        <GapScanPanel
          report={gapReport}
          filling={gapFilling}
          progress={gapProgress}
          summary={gapSummary}
          busy={isGenerating || isAutoPiloting}
          onScan={onScanGaps}
          onStartFilling={onStartGapFilling}
          onStopFilling={onStopGapFilling}
        />
      )}

      {/* 折叠行：跨章抽检 / 快照 / AI 调用记录 / 写前体检 */}
      <div className="p-4 border-b border-slate-200 bg-white space-y-2">
        {onRunCrossAudit && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setCrossAuditOpen((v) => !v)}
              className="w-full flex items-center justify-between text-[11px] font-semibold text-slate-700"
            >
              <span className="flex items-center gap-1.5">
                <Crosshair size={12} className="text-slate-500" />
                跨章抽检
              </span>
              {crossAuditOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {crossAuditOpen && (
              <CrossChapterAuditPanel
                report={crossAuditReport}
                busy={!!crossAuditBusy || isGenerating || isAutoPiloting}
                onRun={onRunCrossAudit}
                remind={crossAuditRemind}
                onDismissRemind={onDismissCrossAuditRemind}
                onJumpIssue={onJumpAuditIssue}
                onFixFirst={onFixFirstRevision}
              />
            )}
          </div>
        )}

        {projectId && onManualSnapshot && onRestoreSnapshot && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setSnapshotOpen((v) => !v)}
              className="w-full flex items-center justify-between text-[11px] font-semibold text-slate-700"
            >
              <span className="flex items-center gap-1.5">
                <Camera size={12} className="text-slate-500" />
                快照
              </span>
              {snapshotOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {snapshotOpen && (
              <SnapshotPanel
                projectId={projectId}
                refreshToken={snapshotRefreshToken}
                busy={isGenerating || isAutoPiloting}
                onManualSnapshot={onManualSnapshot}
                onRestore={onRestoreSnapshot}
              />
            )}
          </div>
        )}

        {/* AI 调用记录入口已移至顶栏，此处不再展示 */}

        {/* 写前体检 */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setPrewriteOpen((v) => !v)}
            className="w-full flex items-center justify-between text-[11px] font-semibold text-slate-700"
          >
            <span className="flex items-center gap-1.5">
              <Stethoscope size={12} className="text-slate-500" />
              写前体检
            </span>
            {prewriteOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {prewriteOpen && (
            <PrewriteCheckPanel
              chapter={chapter}
              characters={characters}
              settings={settings}
              styleConfig={styleConfig}
              previousContextPack={pack}
              projectConfig={projectConfig}
              storyMemory={storyMemory}
            />
          )}
        </div>
      </div>
    </>
  );
};
