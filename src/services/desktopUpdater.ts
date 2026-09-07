/**
 * 桌面端（Electron 安装版）应用内自动更新桥接。
 * 仅当 preload 注入了 window.electronUpdater 且主进程成功加载
 * electron-updater（打包后的安装版）时可用；Web / 单文件 SEA 绿色版
 * 不具备自覆盖能力，请走 appUpdate.ts 的「检查 + 跳转下载页」路径。
 */
import type {
  DesktopUpdaterApi,
  DesktopUpdaterEvent,
  DesktopUpdaterProbeResult,
} from '../types/electron';

export type { DesktopUpdaterApi, DesktopUpdaterEvent, DesktopUpdaterProbeResult };

export const desktopUpdaterBridge: DesktopUpdaterApi | null =
  typeof window !== 'undefined' ? window.electronUpdater ?? null : null;

/** 是否具备应用内更新桥（Web/SEA 下同步返回 false，无 IPC 等待） */
export function hasDesktopUpdater(): boolean {
  return desktopUpdaterBridge != null;
}

/** 探测当前 Electron 环境是否支持应用内更新（返回真实安装版本号） */
export function probeDesktopUpdater(): Promise<DesktopUpdaterProbeResult> {
  if (!desktopUpdaterBridge) {
    return Promise.resolve({ supported: false, currentVersion: '' });
  }
  return desktopUpdaterBridge.probe().catch(() => ({ supported: false, currentVersion: '' }));
}

/** 字节数 → 用户可读体积（更新包约 120MB 量级，默认展示 MB） */
export function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}
