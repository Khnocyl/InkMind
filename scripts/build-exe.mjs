/**
 * 单文件可执行打包（Node SEA）：
 *   node scripts/build-exe.mjs
 *
 * 产物：release/novel-studio.exe + release/dist/（前端静态资源）+ 使用说明.txt
 * 双击 exe 即可运行，无需安装 Node；数据落在 exe 旁的 .novel-data/。
 *
 * 前置：先 npm run build 生成 dist/（脚本会检查）。
 * 原理：esbuild 把 server 打成单 CJS → node --experimental-sea-config 生成
 * blob → postject 注入 node.exe 副本 → 拷贝 dist。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const ROOT = path.resolve(process.cwd());
const BUILD_DIR = path.join(ROOT, 'build', 'sea');
const RELEASE_DIR = path.join(ROOT, 'release');
const DIST_DIR = path.join(ROOT, 'dist');
const EXE_NAME = 'inkmind.exe';

function log(msg) {
  console.log(`[build-exe] ${msg}`);
}

if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  console.error('[build-exe] 缺少 dist/index.html —— 请先运行 npm run build');
  process.exit(1);
}

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(RELEASE_DIR, { recursive: true });

// 1. esbuild 打包 server → 单 CJS 文件
const bundleFile = path.join(BUILD_DIR, 'server-bundle.cjs');
log('esbuild 打包 server ...');
await build({
  entryPoints: [path.join(ROOT, 'server', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: bundleFile,
  sourcemap: false,
  minify: false,
  legalComments: 'inline',
  banner: {
    js: '/* InkMind server bundle (SEA) */',
  },
});
log(`server 打包完成: ${bundleFile}`);

// 2. SEA 配置 + 生成 blob
const seaConfigFile = path.join(BUILD_DIR, 'sea-config.json');
fs.writeFileSync(
  seaConfigFile,
  JSON.stringify(
    {
      main: bundleFile,
      output: path.join(BUILD_DIR, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2
  ),
  'utf-8'
);
log('node --experimental-sea-config ...');
execSync(`node --experimental-sea-config "${seaConfigFile}"`, { stdio: 'inherit' });

// 3. 复制 node.exe 并注入 blob
const exePath = path.join(RELEASE_DIR, EXE_NAME);
log('复制 node.exe 并注入 SEA blob ...');
fs.copyFileSync(process.execPath, exePath);
execSync(
  `npx postject "${exePath}" NODE_SEA_BLOB "${path.join(BUILD_DIR, 'sea-prep.blob')}"` +
    ' --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  { stdio: 'inherit' }
);

// 4. 拷贝前端产物
log('拷贝 dist/ ...');
fs.cpSync(DIST_DIR, path.join(RELEASE_DIR, 'dist'), { recursive: true });

// 5. 使用说明
fs.writeFileSync(
  path.join(RELEASE_DIR, '使用说明.txt'),
  [
    'InkMind — AI 长篇小说创作工作台',
    '',
    '使用方法：双击 inkmind.exe，浏览器会自动打开 http://localhost:3001',
    '（若未自动打开，手动访问该地址即可）。',
    '',
    '· 首次使用：进入「风格与引擎」页签配置 LLM 的 Base URL / API Key / 模型名',
    '· 作品数据与配置保存在本目录 .novel-data/ 下，卸载/搬家直接拷走整个文件夹',
    '· API Key 加密存储且与本机绑定，拷到别的电脑无法解密（需重新填写）',
    '· 关闭方式：关闭 exe 窗口即可',
    '· 端口被占用（提示 EADDRINUSE）说明已有实例在运行，直接浏览器访问即可',
    '· 不要把 .novel-data/ 分享给他人（内含 API Key 密文与你的作品数据）',
    '',
    `构建时间：${new Date().toLocaleString('zh-CN')}`,
    ''
  ].join('\r\n'),
  'utf-8'
);

log(`完成 → ${RELEASE_DIR}`);
