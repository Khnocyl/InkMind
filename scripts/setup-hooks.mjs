/**
 * 本地质量门禁（替代云端 CI）：
 * git config core.hooksPath .githooks —— 把钩子指向仓库内版本化目录。
 * npm install 时经 prepare 脚本自动执行；幂等，可重复跑。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
if (!fs.existsSync(path.join(root, '.git'))) {
  console.log('[hooks] 非 git 仓库，跳过钩子安装');
  process.exit(0);
}

try {
  execSync('git config core.hooksPath .githooks', { cwd: root, stdio: 'inherit' });
  console.log('[hooks] 已启用本地质量门禁：.githooks/（commit 前 tsc+lint，push 前测试+构建）');
  console.log('[hooks] 急事跳过检查可加 --no-verify');
} catch (err) {
  console.warn('[hooks] 安装失败（不影响使用，仅无自动检查）:', err?.message || err);
}
