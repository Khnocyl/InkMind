/**
 * 一键启动：缺 dist 时自动构建前端，然后以 tsx 启动后端（单进程托管前端）。
 *
 * 为什么不用 `npm` / `npm exec`：
 * Windows 上 npm 是 npm.cmd 批处理，Node 20+ 禁止在 shell:false 下 spawn
 * .cmd（直接抛 EINVAL），而 shell:true 又会引入参数转义问题。这里改为用
 * process.execPath 直接执行 node_modules 内的 CLI 入口，跨平台且不依赖 shell。
 *
 * 构建步骤与 package.json 的 `build` 保持一致（tsc -b → vite build）；
 * 改 package.json 的 build 时需同步这里。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');

/** 读取本地包的 bin 入口绝对路径（兼容 bin 声明为字符串或对象两种形式） */
function localCli(pkg, binName) {
  const pkgDir = path.join(ROOT, 'node_modules', pkg);
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const bin = pkgJson.bin;
  const rel = typeof bin === 'string' ? bin : bin?.[binName];
  if (!rel) {
    console.error(`[start] 找不到 ${pkg} 的 bin 入口（${binName}），请先执行 npm install`);
    process.exit(1);
  }
  return path.join(pkgDir, rel);
}

/** 用当前 Node 直接执行一个 JS CLI（不经 shell），返回子进程 */
function runCli(scriptPath, args) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  child.on('error', (err) => {
    console.error('[start] 无法启动子进程:', err);
    process.exit(1);
  });
  return child;
}

/** 按 package.json 的 build 语义顺序执行：tsc -b → vite build */
function runBuild(done) {
  console.log('[start] 未发现 dist/，正在构建前端（首次约 1-2 分钟）...');
  const tsc = runCli(localCli('typescript', 'tsc'), ['-b']);
  tsc.on('exit', (code) => {
    if (code !== 0) {
      console.error('[start] 类型检查失败（tsc -b）');
      process.exit(code ?? 1);
    }
    const vite = runCli(localCli('vite', 'vite'), ['build']);
    vite.on('exit', (viteCode) => {
      if (viteCode !== 0) {
        console.error('[start] 前端构建失败');
        process.exit(viteCode ?? 1);
      }
      done();
    });
  });
}

function startServer() {
  console.log('[start] 启动服务 → http://localhost:3001（关闭本窗口/进程即停止）');
  const server = runCli(localCli('tsx', 'tsx'), [path.join('server', 'index.ts')]);
  server.on('exit', (code) => process.exit(code ?? 0));
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  runBuild(startServer);
} else {
  startServer();
}
