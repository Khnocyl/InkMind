const { contextBridge, ipcRenderer } = require('electron');

try {
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.classList.add('is-electron');
  }
  window.addEventListener('DOMContentLoaded', () => {
    document.documentElement.classList.add('is-electron');
  });
} catch {
  // ignore
}

// 透明无边框窗口（Windows）：长内容重排 + 滚动后合成器可能不刷新点击命中区域，
// 表现为「画面正常但点击无响应」。滚动时节流请求主进程强制重绘一帧。
// capture 阶段监听以覆盖所有内部滚动容器（scroll 事件不冒泡）。
let lastScrollRepaintAt = 0;
try {
  window.addEventListener(
    'scroll',
    () => {
      const now = Date.now();
      if (now - lastScrollRepaintAt < 400) return;
      lastScrollRepaintAt = now;
      try {
        ipcRenderer.send('window-request-repaint');
      } catch {
        // ignore
      }
    },
    true
  );
} catch {
  // ignore
}

contextBridge.exposeInMainWorld('electronWindow', {
  isElectron: true,
  minimize: () => ipcRenderer.send('window-minimize'),
  toggleMaximize: () => ipcRenderer.send('window-maximize-toggle'),
  close: () => ipcRenderer.send('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChange: (callback) => {
    const handler = (_event, isMaximized) => {
      if (typeof callback === 'function') {
        callback(Boolean(isMaximized));
      }
    };
    ipcRenderer.on('window-maximize-change', handler);
    return () => {
      ipcRenderer.removeListener('window-maximize-change', handler);
    };
  },
});

// 应用内自动更新（仅 Electron 安装版可用，具体以 probe().supported 为准）
contextBridge.exposeInMainWorld('electronUpdater', {
  probe: () => ipcRenderer.invoke('updater:probe'),
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.send('updater:download'),
  install: () => ipcRenderer.send('updater:install'),
  onState: (callback) => {
    const handler = (_event, state) => {
      if (typeof callback === 'function') {
        callback(state);
      }
    };
    ipcRenderer.on('updater:state', handler);
    return () => {
      ipcRenderer.removeListener('updater:state', handler);
    };
  },
});
