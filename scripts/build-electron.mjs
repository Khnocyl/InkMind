/**
 * Electron 桌面端打包前置：esbuild 把 server 打成单 CJS 供主进程 require。
 *   node scripts/build-electron.mjs
 * 前置：npm run build 生成 dist/（electron-builder 会一并打包）。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, 'build', 'electron', 'server.cjs');

fs.mkdirSync(path.dirname(OUT), { recursive: true });

await build({
  entryPoints: [path.join(ROOT, 'server', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: OUT,
  sourcemap: false,
  minify: false,
  legalComments: 'inline',
  banner: { js: '/* InkMind server bundle (Electron) */' },
});

console.log(`[build-electron] server 打包完成: ${OUT}`);
