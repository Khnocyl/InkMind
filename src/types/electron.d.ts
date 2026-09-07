export interface ElectronWindowApi {
  isElectron: boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
}

/** 主进程广播的更新状态事件（与 electron/main.cjs sendUpdaterState 对齐） */
export type DesktopUpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes: string; releaseDate?: string }
  | { type: 'not-available'; version: string }
  | {
      type: 'progress';
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string };

export interface DesktopUpdaterProbeResult {
  supported: boolean;
  currentVersion: string;
  /** 主进程更新状态机当前阶段（页面刷新后渲染层据此恢复面板，事件广播不会重放） */
  phase?: 'idle' | 'available' | 'downloading' | 'downloaded';
  /** 最近一次「发现新版本」的信息快照（phase=available 时用于恢复展示） */
  available?: { version: string; releaseNotes?: string; releaseDate?: string } | null;
  /** 最近一次下载完成的版本号（phase=downloaded 时用） */
  downloadedVersion?: string;
}

/** preload 注入的应用内更新桥（仅 Electron 安装版 probe().supported 为 true） */
export interface DesktopUpdaterApi {
  probe: () => Promise<DesktopUpdaterProbeResult>;
  check: () => Promise<{ ok: boolean; version?: string; message?: string }>;
  download: () => void;
  install: () => void;
  onState: (callback: (event: DesktopUpdaterEvent) => void) => () => void;
}

declare global {
  interface Window {
    electronWindow?: ElectronWindowApi;
    electronUpdater?: DesktopUpdaterApi;
  }
}
