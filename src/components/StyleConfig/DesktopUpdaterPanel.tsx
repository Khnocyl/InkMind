import React, { useEffect, useState } from 'react';
import {
  RefreshCw,
  Sparkles,
  CheckCircle2,
  ExternalLink,
  AlertTriangle,
  Download,
  RotateCw,
} from 'lucide-react';
import {
  desktopUpdaterBridge,
  formatBytes,
  probeDesktopUpdater,
  type DesktopUpdaterEvent,
} from '../../services/desktopUpdater';
import { GITHUB_RELEASES_URL } from '../../services/appUpdate';

type Phase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'latest'
  | 'installing'
  | 'error';

interface ViewModel {
  phase: Phase;
  version?: string;
  releaseNotes?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  errorMsg?: string;
}

interface DesktopUpdaterPanelProps {
  /** 主进程探测到的真实安装版本（app.getVersion()） */
  currentVersion: string;
}

/**
 * Electron 安装版专属的「应用内下载 + 覆盖安装」更新流程：
 * 检查 → 下载（进度条）→ 重启并安装。任何一步失败均保留
 * 「前往 GitHub 手动下载」兜底入口。
 */
export const DesktopUpdaterPanel: React.FC<DesktopUpdaterPanelProps> = ({ currentVersion }) => {
  const [state, setState] = useState<ViewModel>({ phase: 'idle' });

  // 页面刷新会错过主进程已广播的事件：挂载时从 probe 快照恢复面板状态
  useEffect(() => {
    let cancelled = false;
    probeDesktopUpdater()
      .then((r) => {
        if (cancelled) return;
        if (r.phase === 'downloaded') {
          setState((prev) =>
            prev.phase === 'idle'
              ? { phase: 'downloaded', version: r.downloadedVersion || prev.version }
              : prev
          );
        } else if (r.phase === 'available' && r.available?.version) {
          setState((prev) =>
            prev.phase === 'idle'
              ? {
                  phase: 'available',
                  version: r.available!.version,
                  releaseNotes: r.available!.releaseNotes,
                }
              : prev
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const bridge = desktopUpdaterBridge;
    if (!bridge) return;
    const applyEvent = (ev: DesktopUpdaterEvent) => {
      switch (ev.type) {
        case 'checking':
          setState({ phase: 'checking' });
          break;
        case 'available':
          setState({
            phase: 'available',
            version: ev.version,
            releaseNotes: ev.releaseNotes,
          });
          break;
        case 'not-available':
          setState({ phase: 'latest', version: ev.version });
          break;
        case 'progress':
          setState((prev) => ({
            ...prev,
            phase: 'downloading',
            percent: ev.percent,
            transferred: ev.transferred,
            total: ev.total,
            bytesPerSecond: ev.bytesPerSecond,
          }));
          break;
        case 'downloaded':
          setState((prev) => ({ ...prev, phase: 'downloaded', version: ev.version }));
          break;
        case 'error':
          setState((prev) => ({ phase: 'error', version: prev.version, errorMsg: ev.message }));
          break;
      }
    };
    return bridge.onState(applyEvent);
  }, []);

  const handleCheck = async () => {
    const bridge = desktopUpdaterBridge;
    if (!bridge) return;
    setState({ phase: 'checking' });
    try {
      const res = await bridge.check();
      // ok 时由主进程广播 available / not-available 事件驱动状态；
      // 检查期主进程会拦截冗长原始报错，这里只收到一句短提示。
      if (!res.ok) {
        setState((prev) => ({
          phase: 'error',
          version: prev.version,
          errorMsg: res.message || '检查更新失败',
        }));
      }
    } catch (err) {
      setState((prev) => ({
        phase: 'error',
        version: prev.version,
        errorMsg: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const handleDownload = () => {
    const bridge = desktopUpdaterBridge;
    if (!bridge) return;
    setState((prev) => ({ ...prev, phase: 'downloading', percent: prev.percent ?? 0 }));
    bridge.download();
  };

  const handleInstall = () => {
    const bridge = desktopUpdaterBridge;
    if (!bridge) return;
    setState((prev) => ({ ...prev, phase: 'installing' }));
    bridge.install();
  };

  const isChecking = state.phase === 'checking';
  const isBusy = state.phase === 'downloading' || state.phase === 'installing';

  return (
    <div className="space-y-4 animate-fadeIn">
      {/* 主操作行：检查更新按钮（下载中/安装中禁止操作） */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="text-xs text-slate-500 dark:text-slate-400">
          当前安装版本 v{currentVersion || '…'} · 新版本将在软件内直接下载，完成后自动重启覆盖安装。
        </div>
        <button
          type="button"
          disabled={isChecking || isBusy}
          onClick={handleCheck}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold rounded-xl bg-black text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-950 dark:hover:bg-slate-200 disabled:opacity-50 transition shadow-sm cursor-pointer shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
          {isChecking ? '正在检测最新版本…' : '立即检查更新'}
        </button>
      </div>

      {state.phase === 'latest' && (
        <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/70 text-emerald-900 flex items-start gap-3 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-200">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-bold text-sm">当前已是最新版本 (v{currentVersion})</div>
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              您的客户端已是官方最新版本，无需更新。祝您长篇小说创作灵感泉涌！
            </p>
          </div>
        </div>
      )}

      {(state.phase === 'available' || state.phase === 'downloading') && (
        <div className="p-4 rounded-xl border border-indigo-200 bg-indigo-50/70 text-indigo-950 space-y-3 dark:border-indigo-800/60 dark:bg-indigo-950/30 dark:text-indigo-200">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <Sparkles className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold text-sm">发现新版本：v{state.version}</div>
                <p className="text-xs text-indigo-700 dark:text-indigo-300 mt-0.5">
                  {state.phase === 'downloading'
                    ? '安装包正在后台下载，可随时保持当前工作，完成后一键重启升级。'
                    : '可直接在软件内下载并自动覆盖安装，无需手动操作安装包。'}
                </p>
              </div>
            </div>
            {state.phase === 'available' && (
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition shadow shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                下载更新
              </button>
            )}
          </div>

          {state.phase === 'downloading' && (
            <div className="space-y-1.5">
              <div className="h-2.5 w-full rounded-full bg-indigo-100 overflow-hidden dark:bg-indigo-950/60">
                <div
                  className="h-full rounded-full bg-indigo-600 dark:bg-indigo-400 transition-all"
                  style={{ width: `${Math.min(100, Math.max(0, state.percent ?? 0))}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-indigo-700 dark:text-indigo-300">
                <span className="font-semibold">{(state.percent ?? 0).toFixed(1)}%</span>
                <span>
                  {formatBytes(state.transferred)} / {formatBytes(state.total)}
                  {state.bytesPerSecond ? ` · ${formatBytes(state.bytesPerSecond)}/s` : ''}
                </span>
              </div>
            </div>
          )}

          {state.releaseNotes && (
            <div className="bg-white/80 border border-indigo-100 rounded-lg p-3 text-xs text-slate-700 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono dark:bg-slate-900/90 dark:border-indigo-900/60 dark:text-slate-200">
              {state.releaseNotes}
            </div>
          )}
        </div>
      )}

      {state.phase === 'downloaded' && (
        <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/70 text-emerald-950 space-y-3 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-200">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold text-sm">新版本 v{state.version} 已下载完成</div>
                <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-0.5">
                  点击按钮后应用将自动退出、覆盖安装并重新启动；若暂时不重启，退出应用时也会自动完成安装。
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleInstall}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition shadow shrink-0 cursor-pointer"
            >
              <RotateCw className="w-3.5 h-3.5" />
              重启并安装更新
            </button>
          </div>
        </div>
      )}

      {state.phase === 'installing' && (
        <div className="p-4 rounded-xl border border-sky-200 bg-sky-50/70 text-sky-950 flex items-start gap-3 dark:border-sky-800/60 dark:bg-sky-950/30 dark:text-sky-200">
          <RefreshCw className="w-5 h-5 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5 animate-spin" />
          <div>
            <div className="font-bold text-sm">正在退出并安装新版本…</div>
            <p className="text-xs text-sky-700 dark:text-sky-300 mt-0.5">
              安装器正在覆盖升级，应用将自动重启。若长时间未响应，请手动重新打开 InkMind。
            </p>
          </div>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="p-4 rounded-xl border border-amber-200 bg-amber-50/70 text-amber-900 flex items-start justify-between gap-3 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-200">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-bold text-sm">应用内更新失败</div>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5 break-all">
                {state.errorMsg || '下载或检查过程出现异常，可重试或改为手动下载。'}
              </p>
            </div>
          </div>
          <a
            href={GITHUB_RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-bold text-amber-800 hover:underline shrink-0 dark:text-amber-300"
          >
            前往 GitHub 手动下载
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}
    </div>
  );
};
