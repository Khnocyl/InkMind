import React, { useCallback, useEffect, useState } from 'react';
import {
  History,
  Camera,
  RotateCcw,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Shield,
} from 'lucide-react';
import {
  listSnapshots,
  deleteSnapshot,
  snapshotReasonLabel,
  type ProjectSnapshotMeta,
  type SnapshotReason,
} from '../../services/snapshots';

interface SnapshotPanelProps {
  projectId: string;
  /** 用于列表刷新触发（如写完一章后） */
  refreshToken?: number;
  busy?: boolean;
  onManualSnapshot: () => Promise<void> | void;
  onRestore: (snapshotId: string) => Promise<void> | void;
}

function reasonBadgeClass(reason: SnapshotReason): string {
  switch (reason) {
    case 'pre_write':
      return 'bg-sky-50 text-sky-800 border-sky-200';
    case 'post_write':
      return 'bg-emerald-50 text-emerald-800 border-emerald-200';
    case 'manual':
      return 'bg-indigo-50 text-indigo-800 border-indigo-200';
    case 'pre_restore':
      return 'bg-amber-50 text-amber-900 border-amber-200';
    case 'auto_pilot_round':
      return 'bg-violet-50 text-violet-800 border-violet-200';
    case 'finalize':
      return 'bg-emerald-100 text-emerald-900 border-emerald-300';
    default:
      return 'bg-slate-50 text-slate-700 border-slate-200';
  }
}

export const SnapshotPanel: React.FC<SnapshotPanelProps> = ({
  projectId,
  refreshToken = 0,
  busy = false,
  onManualSnapshot,
  onRestore,
}) => {
  const [open, setOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [items, setItems] = useState<ProjectSnapshotMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await listSnapshots(projectId);
      setItems(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload, refreshToken]);

  const handleManual = async () => {
    if (busy || acting) return;
    setActing(true);
    setError(null);
    try {
      await onManualSnapshot();
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  };

  const handleRestore = async (id: string, label: string) => {
    if (busy || acting) return;
    const ok = window.confirm(
      `确认回滚到此快照？\n\n「${label}」\n\n将用快照覆盖当前全书（正文、角色、设定、recap）。\n回滚前会自动再备份一次当前状态，可再次回滚找回。`
    );
    if (!ok) return;
    setActing(true);
    setError(null);
    try {
      await onRestore(id);
      await reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || acting) return;
    if (!window.confirm('删除这条快照？不可恢复。')) return;
    setActing(true);
    try {
      await deleteSnapshot(id);
      await reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="border-t border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-50 transition-colors"
      >
        <span className="flex items-center gap-1.5 text-xs font-bold text-slate-900">
          <History size={14} className="text-indigo-600" />
          全书快照与回滚
          <span className="text-[10px] font-mono font-normal text-slate-500">
            ({items.length})
          </span>
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-[10px] text-slate-500 leading-relaxed flex items-start gap-1">
            <Shield size={12} className="mt-0.5 shrink-0 text-slate-400" />
            写前/写后自动备份全书；可一键回滚。每书最多保留 30 条。完整离线备份请用书库「导出 JSON」。
          </p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || acting}
              onClick={handleManual}
              className="flex-1 inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              <Camera size={12} />
              手动快照
            </button>
            <button
              type="button"
              disabled={loading || acting}
              onClick={reload}
              className="inline-flex items-center justify-center p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              title="刷新列表"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          {error && (
            <div className="text-[10px] text-red-700 bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">
              {error}
            </div>
          )}

          <div className="max-h-48 overflow-y-auto space-y-1.5 border border-slate-100 rounded-lg p-1.5 bg-slate-50/80">
            {loading && items.length === 0 && (
              <p className="text-[10px] text-slate-400 text-center py-3">加载中…</p>
            )}
            {!loading && items.length === 0 && (
              <p className="text-[10px] text-slate-400 text-center py-3">
                暂无快照。写一章或点「手动快照」即可生成。
              </p>
            )}
            {items.map((s) => (
              <div
                key={s.id}
                className="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[10px]"
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 flex-wrap">
                      <span
                        className={`px-1.5 py-0.5 rounded border font-semibold ${reasonBadgeClass(s.reason)}`}
                      >
                        {snapshotReasonLabel(s.reason)}
                      </span>
                      <span className="text-slate-400 font-mono">
                        {new Date(s.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-slate-800 font-medium mt-0.5 truncate" title={s.label}>
                      {s.label}
                    </p>
                    <p className="text-slate-500 font-mono">
                      {s.chapterCount} 章 · {(s.totalWords || 0).toLocaleString()} 字
                    </p>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      disabled={busy || acting}
                      onClick={() => handleRestore(s.id, s.label)}
                      className="p-1 rounded text-white bg-black hover:bg-neutral-800 disabled:opacity-40"
                      title="回滚到此快照"
                    >
                      <RotateCcw size={12} />
                    </button>
                    <button
                      type="button"
                      disabled={busy || acting}
                      onClick={(e) => handleDelete(s.id, e)}
                      className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                      title="删除快照"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
