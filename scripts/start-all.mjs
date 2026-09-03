/**
 * 一键启动：缺 dist 时自动构建前端，然后以 tsx 启动后端（单进程托管前端）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function runBuild(done) {
  console.log('[start] 未发现 dist/，正在构建前端（首次约 1-2 分钟）...');
  const r = spawn(npmCmd, ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
  });
  r.on('exit', (code) => {
    if (code !== 0) {
      console.error('[start] 前端构建失败');
      process.exit(code ?? 1);
    }
    done();
  });
}

function startServer() {
  console.log('[start] 启动服务 → http://localhost:3001（关闭本窗口/进程即停止）');
  const s = spawn(npmCmd, ['exec', '--yes', 'tsx', path.join('server', 'index.ts')], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env },
  });
  s.on('exit', (code) => process.exit(code ?? 0));
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  runBuild(startServer);
} else {
  startServer();
}
