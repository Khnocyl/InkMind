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
const { semverCompare, shortUpdaterError } = require('./updaterErrors.cjs');

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
        if (res.statusCode === 200) {
          resolve(true);
        } else if (n <= 0) {
          resolve(false);
        } else {
          // 非 200（如代理 502）不代表服务器没起来，继续轮询直到次数用尽
          setTimeout(() => probe(n - 1), 250);
        }
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

// 渲染层滚动请求重绘：透明无边框窗口在长内容重排 + 滚动后，Windows 合成器
// 可能不刷新命中区域（画面正常但点击落在旧坐标）。渲染层在滚动时节流发此通道，
// 强制重绘一帧。沙盒 preload 无法直接调 webContents，经 IPC 转交。
ipcMain.on('window-request-repaint', (event) => {
  try {
    if (!event.sender.isDestroyed()) event.sender.invalidate();
  } catch {
    /* ignore */
  }
});

// ─── 桌面端应用内自动更新（electron-updater）──────────────────────────
// 仅「Electron 安装版」启用：Web / 单文件 SEA 绿色版没有安装器，无法在
// 运行中自我覆盖，前端探测不到 updater 会自动回退为“跳转 GitHub Releases”。
// 网络受限环境可设置环境变量 INKMIND_UPDATE_FEED 指向镜像源（generic provider）。
let autoUpdater = null;
// 检查更新进行中标记（计数器）：静默启动检查与用户手动检查可能并发，
// 布尔值会互相踩（一方 finally 置 false 后另一方的错误不再被抑制）
let checkingActive = 0;
// 更新流程状态机（主进程侧唯一事实来源）：渲染层的 IPC 请求必须落在
// 合法状态上才执行，防止乱序调用导致重复下载或未就绪就退出安装。
// idle → (check) → available → (download) → downloading → downloaded → (install)
let updatePhase = 'idle';
// 最近一次「发现新版本 / 已下载完成」的信息快照：页面刷新后渲染层通过
// probe 重新取回，恢复更新面板状态，不必再手动检查一次
let lastAvailable = null;
let lastDownloadedVersion = '';

/** GitHub provider 的 releaseNotes 可能是字符串或 [{ note }] 数组，统一拍平成文本 */
function normalizeReleaseNotes(notes) {
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => (typeof n === 'string' ? n : (n && n.note) || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function sendUpdaterState(payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater:state', payload);
  }
}

function initAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const updater = require('electron-updater').autoUpdater;
    updater.autoDownload = false; // 用户在界面确认后再下载
    updater.autoInstallOnAppQuit = true; // 已下载未安装时，退出应用即自动覆盖安装
    if (process.env.INKMIND_UPDATE_FEED) {
      const feedUrl = process.env.INKMIND_UPDATE_FEED;
      if (feedUrl.startsWith('https://')) {
        updater.setFeedURL({ provider: 'generic', url: feedUrl });
      } else {
        // 更新源决定要执行的代码，明文 http 可被中间人替换安装包，一律拒绝
        console.warn('[updater] 忽略非 https 的 INKMIND_UPDATE_FEED:', feedUrl);
      }
    }
    updater.on('checking-for-update', () => {
      sendUpdaterState({ type: 'checking' });
    });
    updater.on('update-available', (info) => {
      updatePhase = 'available';
      lastAvailable = {
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
      };
      sendUpdaterState({
        type: 'available',
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
      });
    });
    updater.on('update-not-available', (info) => {
      lastAvailable = null;
      sendUpdaterState({ type: 'not-available', version: info.version });
    });
    updater.on('download-progress', (p) => {
      sendUpdaterState({
        type: 'progress',
        percent: p.percent,
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond,
      });
    });
    updater.on('update-downloaded', (info) => {
      updatePhase = 'downloaded';
      lastDownloadedVersion = info.version || '';
      sendUpdaterState({ type: 'downloaded', version: info.version });
    });
    updater.on('error', (err) => {
      // 检查过程中的失败由 updater:check 的返回值统一汇报（含“缺 latest.yml 视为已是最新版”等
      // 判定），这里只广播下载等其他阶段出现的错误。
      if (checkingActive > 0) return;
      console.warn('[updater] 更新出错:', (err && err.stack) || err);
      // 下载阶段失败 → 回退到 available 允许重试；其余情况视为回到初始态
      if (updatePhase === 'downloading') updatePhase = 'available';
      else if (updatePhase !== 'downloaded') updatePhase = 'idle';
      sendUpdaterState({ type: 'error', message: shortUpdaterError(err).text });
    });
    autoUpdater = updater;
  } catch (err) {
    console.warn('[updater] electron-updater 不可用，回退为跳转下载页:', (err && err.message) || err);
  }
}

ipcMain.handle('updater:probe', () => ({
  supported: Boolean(autoUpdater),
  currentVersion: app.getVersion(),
  // 供渲染层在页面刷新后恢复面板状态（事件广播不会重放）
  phase: updatePhase,
  available: lastAvailable,
  downloadedVersion: lastDownloadedVersion,
}));

ipcMain.handle('updater:check', async () => {
  if (!autoUpdater) return { ok: false, message: '当前运行形态不支持应用内更新' };
  checkingActive += 1;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result) return { ok: true }; // 已有同名检查在途，结果仍走事件广播
    const info = result.updateInfo;
    return { ok: true, version: info ? info.version : undefined };
  } catch (err) {
    console.warn('[updater] 检查更新失败:', (err && err.stack) || err);
    const raw = String((err && err.message) || err || '');
    if (/already in progress/i.test(raw)) return { ok: true };
    const s = shortUpdaterError(err);
    if (s.kind === 'feed-missing') {
      // Release 存在但没传 latest.yml：该 Release 版本不高于当前版本 → 就是“已是最新版”，
      // 正常显示最新版提示；确有更新版本但缺清单 → 提示手动下载。
      if (semverCompare(s.tag, app.getVersion()) <= 0) {
        sendUpdaterState({ type: 'not-available', version: app.getVersion() });
        return { ok: true, version: app.getVersion() };
      }
      const msg = `新版本 v${s.tag} 已发布，但更新清单缺失，暂无法应用内升级，请前往 GitHub 手动下载。`;
      sendUpdaterState({ type: 'error', message: msg });
      return { ok: false, message: msg };
    }
    sendUpdaterState({ type: 'error', message: s.text });
    return { ok: false, message: s.text };
  } finally {
    checkingActive = Math.max(0, checkingActive - 1);
  }
});

ipcMain.on('updater:download', () => {
  if (!autoUpdater) return;
  // 仅在「已发现新版本且未在下载中」时接受；乱序/重复请求直接忽略，
  // 避免 electron-updater 二次 downloadUpdate 抛错或状态错乱。
  if (updatePhase !== 'available') {
    console.warn('[updater] 忽略当前状态下的下载请求, phase =', updatePhase);
    return;
  }
  updatePhase = 'downloading';
  autoUpdater.downloadUpdate().catch((err) => {
    console.warn('[updater] 下载更新失败:', (err && err.stack) || err);
    updatePhase = 'available'; // 允许用户重试
    sendUpdaterState({ type: 'error', message: shortUpdaterError(err).text });
  });
});

// 启动后静默检查一次更新：发现新版本照常广播（前端全局浮出更新提示），
// 网络失败等完全静默，不打扰用户；每次应用运行只做一次。
let startupCheckScheduled = false;
function scheduleSilentUpdateCheck() {
  if (startupCheckScheduled || !autoUpdater) return;
  startupCheckScheduled = true;
  setTimeout(() => {
    checkingActive += 1; // 复用检查期抑制：此间的 error 事件不广播
    autoUpdater
      .checkForUpdates()
      .catch((err) => console.warn('[updater] 启动静默检查失败（已忽略）:', (err && err.message) || err))
      .finally(() => {
        checkingActive = Math.max(0, checkingActive - 1);
      });
  }, 8000);
}

ipcMain.on('updater:install', () => {
  if (!autoUpdater) return;
  // 未下载完成就 quitAndInstall 可能直接退出应用，必须守住 downloaded 状态
  if (updatePhase !== 'downloaded') {
    console.warn('[updater] 忽略当前状态下的安装请求, phase =', updatePhase);
    return;
  }
  // 静默运行安装器完成覆盖安装，结束后自动重启应用
  autoUpdater.quitAndInstall(true, true);
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

  // 透明无边框窗口（transparent: true）在 Windows 上的已知怪癖：页面滚动/长内容
  // 重排/原生对话框关闭等场景后，合成器可能不重排，出现「画面正常但点击命中区域
  // 冻结/错位」——表现为整页或局部点击无响应，直到某个原生事件（如文件对话框开关）
  // 强制重新合成。窗口 focus 与状态变化时强制重绘一帧做缓解。
  const repaint = () => {
    if (win && !win.isDestroyed()) win.webContents.invalidate();
  };
  win.on('focus', repaint);
  win.on('restore', repaint);
  win.on('maximize', repaint);
  win.on('unmaximize', repaint);
  win.on('resize', repaint);
  win.on('move', repaint);

  // 本窗口只允许停留在本地服务同源页面：页内任何跳转到外部地址
  // （误触发链接、location 改写等）一律拦截，防止整个窗口被外部页面替换。
  const ownOrigin = `http://127.0.0.1:${PORT}`;
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== ownOrigin && !url.startsWith(`${ownOrigin}/`)) {
      event.preventDefault();
    }
  });

  // 外部链接一律调用系统默认浏览器打开；仅放行本项目相关域名的 https 链接，
  // 防止页面内被注入的任意 URL 借系统浏览器打开。
  const allowedExternalHosts = new Set([
    'github.com',
    'www.github.com',
    'objects.githubusercontent.com',
    'api.github.com',
    'raw.githubusercontent.com',
    'gist.github.com',
  ]);
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol === 'https:' &&
        (allowedExternalHosts.has(parsed.hostname) || parsed.hostname.endsWith('.github.io'))
      ) {
        shell.openExternal(url);
      }
    } catch {
      // 非法 URL 直接忽略
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
    initAutoUpdater();
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
    scheduleSilentUpdateCheck();
    console.log(`[electron] server ready at http://127.0.0.1:${PORT}`);
  } catch (err) {
    dialog.showErrorBox('InkMind — 启动异常', String((err && err.message) || err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
