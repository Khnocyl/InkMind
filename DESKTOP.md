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
