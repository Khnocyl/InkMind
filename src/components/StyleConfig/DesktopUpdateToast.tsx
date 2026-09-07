import React, { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { desktopUpdaterBridge } from '../../services/desktopUpdater';

interface DesktopUpdateToastProps {
  /** 点击「前往更新」时跳转到设置中的更新区块 */
  onOpenUpdateSection: () => void;
}

/**
 * 桌面端（Electron 安装版）启动静默检查发现新版本后，全局右下角浮出的更新提示。
 * 仅订阅主进程广播：用户在设置面板里开始下载/安装或检查结果为最新/失败时自动消失。
 */
export const DesktopUpdateToast: React.FC<DesktopUpdateToastProps> = ({
  onOpenUpdateSection,
}) => {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const bridge = desktopUpdaterBridge;
    if (!bridge) return;
    return bridge.onState((ev) => {
      if (ev.type === 'available') {
        setVersion(ev.version);
      } else if (
        ev.type === 'progress' ||
        ev.type === 'downloaded' ||
        ev.type === 'not-available' ||
        ev.type === 'error'
      ) {
        setVersion(null);
      }
    });
  }, []);

  if (!version) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-fadeIn">
      <div className="flex items-center gap-3 px-4 py-3 rounded-2xl border border-indigo-200 bg-white/95 shadow-lg backdrop-blur dark:border-indigo-800/60 dark:bg-slate-900/95">
        <Sparkles className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" />
        <div className="text-xs">
          <div className="font-bold text-slate-900 dark:text-slate-100">
            发现新版本 v{version}
          </div>
          <div className="text-slate-500 dark:text-slate-400 mt-0.5">
            可在软件内直接下载并自动覆盖安装
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            setVersion(null);
            onOpenUpdateSection();
          }}
          className="inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white transition shadow-sm cursor-pointer shrink-0"
        >
          前往更新
        </button>
        <button
          type="button"
          aria-label="关闭更新提示"
          onClick={() => setVersion(null)}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition cursor-pointer dark:hover:text-slate-200 dark:hover:bg-slate-800 shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
