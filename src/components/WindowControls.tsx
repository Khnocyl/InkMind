import React, { useState, useEffect } from 'react';

export const WindowControls: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const electron = typeof window !== 'undefined' ? window.electronWindow : undefined;

  useEffect(() => {
    if (!electron?.isElectron) return;
    electron.isMaximized().then(setIsMaximized).catch(() => {});
    const cleanup = electron.onMaximizeChange((maximized) => {
      setIsMaximized(maximized);
    });
    return cleanup;
  }, [electron]);

  if (!electron?.isElectron) {
    return null;
  }

  return (
    <div className="flex items-center h-full ml-1 border-l border-neutral-200 pl-1.5 mr-1.5 app-region-no-drag select-none">
      <button
        onClick={() => electron.minimize()}
        className="w-7 h-7 flex items-center justify-center rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 transition-colors"
        title="最小化"
        type="button"
        aria-label="最小化窗口"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <line x1="2" y1="8" x2="14" y2="8" />
        </svg>
      </button>

      <button
        onClick={() => electron.toggleMaximize()}
        className="w-7 h-7 flex items-center justify-center rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 transition-colors"
        title={isMaximized ? '还原' : '最大化'}
        type="button"
        aria-label={isMaximized ? '还原窗口' : '最大化窗口'}
      >
        {isMaximized ? (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4.5" y="1.5" width="10" height="10" rx="1.5" />
            <path d="M1.5 4.5v9a1 1 0 0 0 1 1h9" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="12" height="12" rx="1.5" />
          </svg>
        )}
      </button>

      <button
        onClick={() => electron.close()}
        className="w-7 h-7 flex items-center justify-center rounded-md text-neutral-500 hover:text-white hover:bg-red-500 transition-colors"
        title="关闭"
        type="button"
        aria-label="关闭窗口"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <line x1="3" y1="3" x2="13" y2="13" />
          <line x1="13" y1="3" x2="3" y2="13" />
        </svg>
      </button>
    </div>
  );
};
