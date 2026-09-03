/**
 * InkMind 桌面端主进程（Electron）：
 * - 单实例锁；
 * - 随机空闲端口 + 127.0.0.1 启动现有 Express server（build/electron/server.cjs，
 *   由 scripts/build-electron.mjs 用 esbuild 打包）；
 * - 数据目录 NOVEL_APP_ROOT = userData（%APPDATA%/inkmind/.novel-data/）；
 * - 前端资源 NOVEL_DIST_DIR = 打包内的 dist/；
 * - BrowserWindow 加载 http://127.0.0.1:port（同源/token/回环安全模型原样保留）。
 */
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

app.setName('InkMind');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let PORT = 0;
let win = null;

/** 找一个从 start 起的空闲端口（探测后即释放，存在极小竞态，可接受） */
function findFreePort(start) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(findFreePort(start + 1)));
    srv.listen(start, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询 /api/health 直到 server 就绪 */
function waitForServer(url, tries = 80) {
  return new Promise((resolve) => {
    const probe = (n) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(res.statusCode === 200 || n <= 0);
      });
      req.on('error', () => {
        if (n <= 0) resolve(false);
        else setTimeout(() => probe(n - 1), 250);
      });
    };
    probe(tries);
  });
}

// ─── 桌面端无边框窗口控制 IPC ─────────────────────────────────────
ipcMain.on('window-minimize', (event) => {
  const targetWin = BrowserWindow.fromWebContents(event.sender);
  targetWin?.minimize();
});

ipcMain.on('window-maximize-toggle', (event) => {
  const targetWin = BrowserWindow.fromWebContents(event.sender);
  if (!targetWin) return;
  if (targetWin.isMaximized()) {
    targetWin.unmaximize();
  } else {
    targetWin.maximize();
  }
});

ipcMain.on('window-close', (event) => {
  const targetWin = BrowserWindow.fromWebContents(event.sender);
  targetWin?.close();
});

ipcMain.handle('window-is-maximized', (event) => {
  const targetWin = BrowserWindow.fromWebContents(event.sender);
  return targetWin?.isMaximized() ?? false;
});

function createWindow() {
  const candidateIcons = [
    path.join(__dirname, '..', 'build', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(__dirname, '..', 'dist', 'favicon.ico'),
    path.join(__dirname, '..', 'dist', 'icon.png'),
    path.join(process.resourcesPath, 'app', 'build', 'icon.ico'),
    path.join(process.resourcesPath, 'app', 'dist', 'icon.png'),
  ];
  const iconPath = candidateIcons.find((p) => fs.existsSync(p));
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'InkMind',
    icon: iconPath,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // 固定标题（页面 title 是通用的 "novel"）
  win.on('page-title-updated', (e) => e.preventDefault());

  // 外部链接一律调用系统默认浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // 窗口最大化/还原状态同步到渲染进程
  win.on('maximize', () => {
    win?.webContents.send('window-maximize-change', true);
  });
  win.on('unmaximize', () => {
    win?.webContents.send('window-maximize-change', false);
  });

  win.loadURL(`http://127.0.0.1:${PORT}`);
  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        {
          label: '打开数据目录（.novel-data）',
          click: () => shell.openPath(app.getPath('userData')),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  try {
    const port = await findFreePort(34567);
    PORT = port;
    process.env.PORT = String(port);
    process.env.HOST = '127.0.0.1';
    process.env.NOVEL_OPEN = '0'; // 窗口即 UI，禁止 server 拉起系统浏览器
    process.env.NOVEL_APP_ROOT = app.getPath('userData');
    process.env.NOVEL_DIST_DIR = path.join(__dirname, '..', 'dist');

    const serverBundle = path.join(__dirname, '..', 'build', 'electron', 'server.cjs');
    if (!fs.existsSync(serverBundle)) {
      dialog.showErrorBox(
        'InkMind — 缺少服务端产物',
        '未找到 build/electron/server.cjs。\n请先运行：npm run build && node scripts/build-electron.mjs'
      );
      app.quit();
      return;
    }
    require(serverBundle);

    const ok = await waitForServer(`http://127.0.0.1:${PORT}/api/health`);
    if (!ok) {
      dialog.showErrorBox('InkMind — 服务启动失败', '本地服务未能在预期时间内就绪，请重试。');
      app.quit();
      return;
    }
    buildMenu();
    createWindow();
    console.log(`[electron] server ready at http://127.0.0.1:${PORT}`);
  } catch (err) {
    dialog.showErrorBox('InkMind — 启动异常', String((err && err.message) || err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
