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
