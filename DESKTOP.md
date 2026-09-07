# 桌面端（Electron）

InkMind 的桌面端 = Electron 壳 + 现有 Express server（主进程直跑，零改造）。
窗口加载 `http://127.0.0.1:<随机端口>`，同源/token/回环安全模型与 Web 版完全一致。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run electron:dev` | 打包 server bundle 后以 Electron 运行（开发调试，窗口直开） |
| `npm run electron:dist` | 前端构建 + server bundle + **出 NSIS 安装包** → `release-electron/` |

产物：`release-electron/InkMind Setup <version>.exe`（NSIS 安装版，
含桌面/开始菜单快捷方式与卸载器，可自定义安装目录）。

## 架构要点

- **主进程**（`electron/main.cjs`）：单实例锁 → 随机空闲端口 → 设置环境变量 →
  `require(build/electron/server.cjs)` 启动 Express → 轮询 `/api/health` 就绪后开窗。
- **无边框大圆角窗口**：`frame: false`，通过 `electron/preload.cjs` 桥接窗口控制 IPC（最小化、最大化/还原、关闭），配合前端 `TopNav` 拖拽区（`-webkit-app-region: drag`）与卡片大圆角样式（`rounded-[28px]`，最大化时自适应展平）。
- **数据目录**：`NOVEL_APP_ROOT = %APPDATA%/novel-studio` → 其下 `.novel-data/`
  （API Token、加密的 LLM 配置、作品备份）随应用数据走，卸载器不会误删该目录之外的文件。
- **前端资源**：`NOVEL_DIST_DIR` 指向打包内 `dist/`（`electron-builder.yml` 已设 `asar: false`，
  服务端以真实文件路径读取）。
- **浏览器自动拉起已禁用**（`NOVEL_OPEN=0`）：窗口即 UI。

## 应用内自动更新（electron-updater）

仅「Electron 安装版」启用（`app.isPackaged`）；Web / 单文件 SEA 版无安装器、
无法自我覆盖，自动回退为「检查 + 跳转 GitHub Releases」手动下载。
流程：设置 → 关于 · 检查更新 → 立即检查 → **下载更新**（进度条）→
**重启并安装更新**（静默覆盖安装后自动重启）；已下载未安装时，退出应用
也会自动完成覆盖安装。

- 主进程：`electron/main.cjs` 的 `initAutoUpdater()`（`autoDownload: false`，
  更新事件经 `updater:state` IPC 广播给渲染层；环境变量 `INKMIND_UPDATE_FEED`
  可指向 https 的 generic 镜像源（非 https 会被拒绝），缓解国内直连 GitHub 不稳的问题）。
- **启动静默检查**：安装版启动约 8 秒后后台静默检查一次更新，发现新版本时
  全局右下角浮出「发现新版本」提示（`DesktopUpdateToast`，点击直达设置中的
  更新区块）；检查失败完全静默，不打扰用户。
- **差分更新（blockmap）**：electron-builder 打包时自动生成 `*.exe.blockmap`，
  上传后旧版客户端应用内下载会自动只下载与已安装版本的差异部分，无需额外配置。
- 渲染层：`src/components/StyleConfig/DesktopUpdaterPanel.tsx` +
  `src/services/desktopUpdater.ts`（preload 桥 `window.electronUpdater`，
  类型声明在 `src/types/electron.d.ts`）。
- 更新源：`electron-builder.yml` 的 `publish`（GitHub Khnocyl/InkMind），
  打包时生成 `resources/app-update.yml`。

**发版清单**：`npm run electron:dist` 后，需将 `release-electron/` 中的
`InkMind-<version>-win-x64-Setup.exe`、同名 `.exe.blockmap` 与 `latest.yml`
**三个文件一起**上传为 GitHub Release 资产——旧版客户端的应用内检查依赖
`latest.yml`，缺失时检查报 404（UI 自动回退为手动下载入口，但无法应用内升级）。

## 构建环境注意（Windows / 国内网络）

- 依赖安装与打包需要镜像（GitHub 直连会超时）：
  ```bash
  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
  ```
- `electron-builder.yml` 已设 `electronDist: node_modules/electron/dist`，
  跳过 zip 下载/解压/重命名（绕开 Defender 对新解压 electron.exe 的实时扫描导致的 rename EPERM）。

## 数据迁移（浏览器 → 桌面端，一次性）

1. 浏览器版中：书库 → 「导出 JSON 备份」；
2. 桌面端中：书库 → 「导入备份」（始终新建项目，不覆盖）。
   localStorage 里的用量记录 / 全局文风档案不随迁（可接受）。

## 与 SEA 便携版（`npm run build:exe`）的关系

两者并存：SEA 版是"单 exe + 浏览器"的便携服务端；Electron 版是带窗口的正式桌面应用。
