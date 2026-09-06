import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import {
  getStoredConfig,
  saveStoredConfig,
  callLLMService,
  listLLMModels,
  listProfilesPublic,
  upsertProfile,
  activateProfile,
  deleteProfile,
  getEmbeddingConfigPublic,
  saveEmbeddingConfig,
  testEmbedding,
  createEmbeddings,
  resolveAllowedModels,
} from './llmService';
import { isSameOriginClient } from './llmSecurity';
import { hardenFilePermissions } from './llmService';
import { runDoctor } from './doctor';
import { writeProjectBackup, listProjectBackups, deleteProjectBackups } from './backupService';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
// 默认只绑定回环地址（安全加固 F1）：避免无意间把 LLM 代理暴露到局域网/公网。
// 如需局域网使用可显式 HOST=0.0.0.0（启动时会打印风险提示）。
const HOST = process.env.HOST || '127.0.0.1';

// ─── API Token 鉴权（R8-2）───────────────────────────────────────────────
// 威胁模型：恶意网页向 localhost:3001 发简单请求（CORS 挡不住「发出」，
// 只挡「读取」），可消耗 LLM 额度 / 触发副作用。token 确保只有持有者能调。
// - token 存 .novel-data/api-token（首次启动自动生成 32 字节 hex；.gitignore 已忽略）
// - 环境变量 API_TOKEN 可显式指定（优先）
// - 除 /api/health 外所有 /api/* 均需 x-api-token 或 Authorization: Bearer <token>
// - 同源浏览器请求（单进程托管前端）与本机非浏览器调用豁免，见下方中间件
// - fail-closed（安全加固 F2）：token 不可读写时默认拒绝全部 /api/*（除 /health），
//   仅当 ALLOW_NO_AUTH=1 显式开启才允许无鉴权运行（启动打醒目警告）
// 应用根：NOVEL_APP_ROOT（桌面端显式指定）> 开发态（cwd 有 package.json）> 单文件可执行态（exe 所在目录）
const APP_ROOT = process.env.NOVEL_APP_ROOT
  ? process.env.NOVEL_APP_ROOT
  : fs.existsSync(path.join(process.cwd(), 'package.json'))
    ? process.cwd()
    : path.dirname(process.execPath);
const DATA_DIR = path.join(APP_ROOT, '.novel-data');
const TOKEN_FILE = path.join(DATA_DIR, 'api-token');

/** 显式允许无鉴权运行（默认关闭；仅限可信环境，不推荐）。 */
const ALLOW_NO_AUTH = process.env.ALLOW_NO_AUTH === '1';

function loadOrCreateApiToken(): string {
  const fromEnv = (process.env.API_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
      if (t) return t;
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const fresh = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, fresh, 'utf-8');
    // 安全审计 P3-3：收紧文件权限（Unix 同机其他用户不可读；Windows 走 ACL）
    hardenFilePermissions(TOKEN_FILE, false);
    console.log(`🔑 [Auth] 已生成 API Token → ${TOKEN_FILE}`);
    return fresh;
  } catch (err) {
    // 无法读写 token 文件：fail-closed（见下方中间件），此处仅记录
    console.warn('[Auth] token 文件读写失败，将进入 fail-closed 模式:', err);
    return '';
  }
}

const API_TOKEN = loadOrCreateApiToken();

if (!API_TOKEN) {
  if (ALLOW_NO_AUTH) {
    console.warn(
      '⚠️ [Auth] 已通过 ALLOW_NO_AUTH=1 显式禁用鉴权——所有 /api/* 将无鉴权开放，仅限可信环境使用！'
    );
  } else {
    console.error(
      '❌ [Auth] 无法读写/生成 API Token，鉴权已进入 fail-closed 模式：除 /api/health 外所有 /api/* 将返回 503。'
    );
    console.error(
      '   修复：确认 .novel-data 目录可写，或设置环境变量 API_TOKEN 显式指定。'
    );
    console.error('   如确需在无鉴权下运行（不推荐），请设置 ALLOW_NO_AUTH=1。');
  }
}

/** unknown 错误 → 消息文案（架构排查 A7：接口层不再用 err: any） */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 恒定时间比较（sha256 摘要后 timingSafeEqual，防时序侧信道与长度泄露） */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function extractToken(req: express.Request): string {
  const header = req.headers['x-api-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}
// ──────────────────────────────────────────────────────────────────────────

// CORS：默认只放行本机开发/预览来源（localhost / 127.0.0.1 任意端口），
// 避免其他来源的网页直接调用本机 LLM 代理消耗额度。
// 环境变量扩展：
//   CORS_ORIGINS=http://192.168.1.5:5173,https://example.com
//   CORS_ALLOW_LOCAL=false  （关闭"任意本机端口"放行，仅信任 CORS_ORIGINS）
const EXTRA_CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CORS_ALLOW_LOCAL = (process.env.CORS_ALLOW_LOCAL ?? 'true') !== 'false';

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // 同源 / 非浏览器调用（curl 等）
  if (EXTRA_CORS_ORIGINS.includes(origin)) return true;
  if (CORS_ALLOW_LOCAL) {
    try {
      const u = new URL(origin);
      return (
        u.protocol === 'http:' &&
        (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      );
    } catch {
      return false;
    }
  }
  return false;
}

app.use(
  cors({
    origin(origin, callback) {
      // 拒绝时不返回 CORS 头，由浏览器侧拦截；本地日志便于排查
      const ok = isAllowedOrigin(origin ?? undefined);
      if (!ok) console.warn(`[CORS] 已拒绝来源: ${origin}`);
      callback(null, ok);
    },
  })
);
app.use(express.json({ limit: '10mb' }));

/**
 * 同源豁免判定：单进程形态下前端由本服务直接托管、浏览器请求不会带
 * token（token 注入是 Vite 代理做的）。判定逻辑抽到 llmSecurity.isSameOriginClient
 * （纯函数可单测）。规则（防 DNS rebinding）：
 * - Host 头的 hostname 必须是本机回环地址或显式可信主机——rebinding 域名的
 *   Host 是攻击者域名，直接拒绝；
 * - Sec-Fetch-Site=same-origin → 同源浏览器请求，放行；
 * - `none`（顶栏导航）与 cross-site/same-site → 必须带 token（安全审计 P2-1
 *   收紧：恶意页面可诱导用户把浏览器导航到本机 API，此时 metadata 为 none，
 *   不能免 token；应用自身 fetch 均为 same-origin 不受影响）；
 * - 无 Sec-Fetch-Site 但带 Origin：Origin hostname 也必须是本机回环地址；
 * - 两者都无（curl 等非浏览器本机调用）→ 放行（本地进程本可读 token 文件）。
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * 额外可信主机名（TRUSTED_HOSTS 环境变量，逗号分隔）：
 * 默认仅信任本机回环。若把服务暴露到局域网同源使用（如
 * http://192.168.1.5:3001 直接打开页面），需显式声明该主机名才豁免
 * token——防止 rebinding 类域名混入。
 */
const TRUSTED_HOSTS = (process.env.TRUSTED_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function isTrustedHostname(hostname: string): boolean {
  return (
    isLoopbackHostname(hostname) || TRUSTED_HOSTS.includes(hostname.toLowerCase())
  );
}

/** 客户端 IP 是否回环（脚本类调用的 token 豁免前提，防 LAN 下鉴权形同虚设） */
function isLoopbackIp(ip?: string): boolean {
  if (!ip) return false;
  const h = ip.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1' || h === 'localhost';
}

function isSameOriginOrLocalClient(req: express.Request): boolean {
  const sfs = req.headers['sec-fetch-site'];
  const origin = req.headers.origin;
  return isSameOriginClient({
    hostHeader: req.headers.host || '',
    secFetchSite: typeof sfs === 'string' ? sfs : undefined,
    origin: typeof origin === 'string' ? origin : undefined,
    isLoopbackClientIp: isLoopbackIp(req.ip),
    isTrustedHostname,
  });
}

// API Token 鉴权：放在 CORS / json 之后，确保 401/503 响应也带 CORS 头（前端可读错误）
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next(); // 健康检查无副作用，开放探活
  if (!API_TOKEN) {
    // fail-closed（安全加固 F2）：token 不可用且未显式 ALLOW_NO_AUTH → 拒绝全部 /api/*
    if (ALLOW_NO_AUTH) return next();
    return res.status(503).json({
      success: false,
      error:
        '鉴权不可用（API Token 无法读取/生成）。请修复 .novel-data 目录权限或设置 API_TOKEN；' +
        '如需无鉴权运行请设置 ALLOW_NO_AUTH=1。',
    });
  }
  if (isSameOriginOrLocalClient(req)) return next(); // 同源前端 / 本机非浏览器调用
  const provided = extractToken(req);
  if (provided && safeEqual(provided, API_TOKEN)) return next();
  console.warn(
    `[Auth] 拒绝未授权请求: ${req.method} ${req.path} (来源 ${req.headers.origin || req.ip})`
  );
  res.status(401).json({ success: false, error: '未授权：缺少或错误的 API Token' });
});

// ─── 服务端限流（安全加固 P1：防本机恶意进程 / 局域网调用者刷爆 LLM 额度）───
// 零依赖内存实现：按来源 IP 的滑动窗口 QPS + 全局并发上限。
// 环境变量：LLM_RATE_LIMIT_PER_MIN（默认 120 次/分钟）、LLM_MAX_CONCURRENT（默认 4）。
// 仅作用于真正消耗上游费用的端点（LLM / Doctor / Embedding / 模型探测 / 磁盘备份）。
const LLM_RATE_LIMIT_PER_MIN =
  Number(process.env.LLM_RATE_LIMIT_PER_MIN) > 0
    ? Number(process.env.LLM_RATE_LIMIT_PER_MIN)
    : 120;
const LLM_MAX_CONCURRENT =
  Number(process.env.LLM_MAX_CONCURRENT) > 0
    ? Number(process.env.LLM_MAX_CONCURRENT)
    : 4;

const rateBuckets = new Map<string, number[]>(); // ip -> 近 60s 时间戳(ms)
let concurrentCalls = 0;

function acquireRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60_000;
  const list = (rateBuckets.get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length >= LLM_RATE_LIMIT_PER_MIN) {
    rateBuckets.set(ip, list);
    return false;
  }
  list.push(now);
  // 防内存无限增长：仅保留每来源最近上限量的时间戳
  if (list.length > LLM_RATE_LIMIT_PER_MIN + 16) list.splice(0, list.length - LLM_RATE_LIMIT_PER_MIN - 16);
  rateBuckets.set(ip, list);
  return true;
}

function rateLimitExpensive() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = req.ip || 'unknown';
    if (!acquireRateLimit(ip)) {
      res.status(429).json({ success: false, error: '请求过于频繁，请稍后再试（限流）' });
      return;
    }
    if (concurrentCalls >= LLM_MAX_CONCURRENT) {
      res.status(429).json({ success: false, error: '并发调用过多，请稍后再试（限流）' });
      return;
    }
    concurrentCalls += 1;
    // 用 close（而非 finish）释放并发槽：客户端中断/断连的流式请求也会触发，
    // 避免并发计数泄漏把服务锁死成永久 429
    res.on('close', () => {
      concurrentCalls -= 1;
    });
    next();
  };
}

// 轻量健康检查（不调 LLM）
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      ok: true,
      service: 'inkmind-backend',
      time: new Date().toISOString(),
    },
  });
});

// Doctor：配置 + 连通 + JSON + 流式（会真实调用 LLM，可能数秒）
app.post('/api/doctor', rateLimitExpensive(), async (req, res) => {
  try {
    const includeStream = req.body?.includeStream !== false;
    const includeJson = req.body?.includeJson !== false;
    const report = await runDoctor({ includeStream, includeJson });
    res.json({ success: true, data: report });
  } catch (err) {
    console.error('Doctor Error:', err);
    res.status(500).json({
      success: false,
      error: errMessage(err) || 'Doctor 诊断失败',
    });
  }
});

// Get current LLM config (with masked key) — 当前「启用」档
app.get('/api/config/llm', (_req, res) => {
  try {
    const config = getStoredConfig();
    const maskedKey = config.encryptedApiKey ? 'sk-****' + config.encryptedApiKey.slice(-4) : '';
    const profiles = listProfilesPublic();
    res.json({
      success: true,
      data: {
        provider: config.provider,
        baseURL: config.baseURL,
        modelName: config.modelName,
        temperature: config.temperature,
        hasKey: !!config.encryptedApiKey && config.encryptedApiKey.length > 0,
        maskedKey,
        customHeaders: config.customHeaders || {},
        activeProfileId: config.activeProfileId,
        activeProfileName: config.activeProfileName,
        profiles: profiles.profiles,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: errMessage(err) });
  }
});

// Update current active profile (兼容旧接口)
app.post('/api/config/llm', (req, res) => {
  try {
    const { provider, baseURL, modelName, temperature, apiKey, customHeaders, name } =
      req.body;
    const updated = saveStoredConfig({
      provider,
      baseURL,
      modelName,
      temperature,
      apiKey,
      customHeaders,
      name,
    });
    const maskedKey = updated.encryptedApiKey ? 'sk-****' + updated.encryptedApiKey.slice(-4) : '';
    res.json({
      success: true,
      data: {
        provider: updated.provider,
        baseURL: updated.baseURL,
        modelName: updated.modelName,
        temperature: updated.temperature,
        hasKey: !!updated.encryptedApiKey,
        maskedKey,
        activeProfileId: updated.activeProfileId,
        activeProfileName: updated.activeProfileName,
        profiles: listProfilesPublic().profiles,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: errMessage(err) });
  }
});

/** 多模型配置档列表 */
app.get('/api/config/llm/profiles', (_req, res) => {
  try {
    res.json({ success: true, data: listProfilesPublic() });
  } catch (err) {
    res.status(500).json({ success: false, error: errMessage(err) });
  }
});

/** 新建 / 更新配置档 */
app.post('/api/config/llm/profiles', (req, res) => {
  try {
    const data = upsertProfile({
      id: req.body?.id,
      name: req.body?.name || '新模型',
      provider: req.body?.provider,
      baseURL: req.body?.baseURL || '',
      modelName: req.body?.modelName || '',
      temperature: req.body?.temperature,
      apiKey: req.body?.apiKey,
      customHeaders: req.body?.customHeaders,
      activate: !!req.body?.activate,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: errMessage(err) });
  }
});

/** 启用指定配置档 */
app.post('/api/config/llm/profiles/:id/activate', (req, res) => {
  try {
    const data = activateProfile(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, error: errMessage(err) });
  }
});

/** 删除配置档 */
app.delete('/api/config/llm/profiles/:id', (req, res) => {
  try {
    const data = deleteProfile(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, error: errMessage(err) });
  }
});

/** 向量检索 Embedding 配置 */
app.get('/api/config/embedding', (_req, res) => {
  try {
    res.json({ success: true, data: getEmbeddingConfigPublic() });
  } catch (err) {
    res.status(500).json({ success: false, error: errMessage(err) });
  }
});

app.post('/api/config/embedding', (req, res) => {
  try {
    const data = saveEmbeddingConfig({
      enabled: req.body?.enabled,
      useSameAsLlm: req.body?.useSameAsLlm,
      baseURL: req.body?.baseURL,
      modelName: req.body?.modelName,
      dimensions:
        req.body?.dimensions === '' || req.body?.dimensions == null
          ? null
          : Number(req.body.dimensions),
      apiKey: req.body?.apiKey,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: errMessage(err) });
  }
});

app.post('/api/embedding/test', rateLimitExpensive(), async (_req, res) => {
  try {
    const result = await testEmbedding();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: errMessage(err) || 'Embedding 测试失败' });
  }
});

app.post('/api/embedding/create', rateLimitExpensive(), async (req, res) => {
  try {
    const texts = Array.isArray(req.body?.texts)
      ? req.body.texts.map(String)
      : typeof req.body?.input === 'string'
        ? [req.body.input]
        : [];
    const data = await createEmbeddings(texts, {
      baseURL: req.body?.baseURL,
      apiKey: req.body?.apiKey,
      modelName: req.body?.modelName,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: errMessage(err) || 'Embedding 失败' });
  }
});

/**
 * 刷新服务商模型列表（OpenAI 兼容 GET /v1/models）。
 * body 可带未保存的 baseURL / apiKey 做探测，密钥不会落盘。
 */
app.post('/api/config/llm/models', rateLimitExpensive(), async (req, res) => {
  try {
    const baseURL = typeof req.body?.baseURL === 'string' ? req.body.baseURL : undefined;
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : undefined;
    const result = await listLLMModels({ baseURL, apiKey });
    res.json({
      success: true,
      data: {
        models: result.models,
        count: result.count,
        endpoint: result.endpoint,
      },
    });
  } catch (err) {
    console.error('List models error:', err);
    res.status(500).json({
      success: false,
      error: errMessage(err) || '拉取模型列表失败',
    });
  }
});

/** 使用已保存配置刷新模型列表 */
app.get('/api/config/llm/models', async (_req, res) => {
  try {
    const result = await listLLMModels();
    res.json({
      success: true,
      data: {
        models: result.models,
        count: result.count,
        endpoint: result.endpoint,
      },
    });
  } catch (err) {
    console.error('List models error:', err);
    res.status(500).json({
      success: false,
      error: errMessage(err) || '拉取模型列表失败',
    });
  }
});

// 作品自动备份（落磁盘）：章末由前端推送整书 JSON；每书保留最近 20 份
app.post('/api/backup', rateLimitExpensive(), (req, res) => {
  try {
    const data = writeProjectBackup({
      projectId: req.body?.projectId,
      title: req.body?.title,
      payload: req.body?.payload,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, error: errMessage(err) || '备份写入失败' });
  }
});

app.get('/api/backup/list', (req, res) => {
  try {
    const projectId =
      typeof req.query?.projectId === 'string' ? req.query.projectId : undefined;
    res.json({ success: true, data: { backups: listProjectBackups(projectId) } });
  } catch (err) {
    res.status(400).json({ success: false, error: errMessage(err) || '备份列表读取失败' });
  }
});

// 删除某项目的全部磁盘备份（项目删除时由前端调用，数据生命周期清理）
app.delete('/api/backup', (req, res) => {
  try {
    const projectId =
      typeof req.query?.projectId === 'string' ? req.query.projectId : undefined;
    const data = deleteProjectBackups(projectId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, error: errMessage(err) || '备份删除失败' });
  }
});

// Generate or Stream completion
app.post('/api/llm/generate', rateLimitExpensive(), async (req, res) => {
  const { messages, temperature, response_format, stream, model } = req.body;
  // 按角色路由：客户端选定的已保存配置档 id（串类型校验，防注入非预期形状）
  const profileId =
    typeof req.body?.profileId === 'string' && req.body.profileId.trim()
      ? req.body.profileId.trim()
      : undefined;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ success: false, error: '缺少有效的 messages 数组参数' });
  }

  // 安全加固 P0：model 服务端白名单——仅允许已配置档的 modelName，防伪造昂贵模型烧额度
  const reqModel = typeof model === 'string' ? model.trim() : '';
  if (reqModel) {
    const allowed = new Set(resolveAllowedModels());
    if (!allowed.has(reqModel)) {
      return res
        .status(400)
        .json({ success: false, error: `模型「${reqModel}」不在已配置档白名单内，已拒绝` });
    }
  }

  // 客户端断连 → 中止向上游的请求（前端「停止」按钮 / 页面关闭即生效，
  // 否则后端会继续跑完并全额计费）。正常结束后 close 不触发 abort。
  const upstream = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) upstream.abort();
  });
  res.on('error', () => upstream.abort());

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      await callLLMService({
        messages,
        temperature,
        response_format,
        stream: true,
        model,
        profileId,
        signal: upstream.signal,
        onChunk: (chunk) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        },
        onFinish: (info) => {
          // 截断信号透传（finish=length → 前端提示 max_tokens 上限）
          if (info.finishReason && !res.writableEnded) {
            res.write(`data: ${JSON.stringify({ finish: info.finishReason })}\n\n`);
          }
        },
      });
      if (!res.writableEnded) {
        res.write(`data: [DONE]\n\n`);
        res.end();
      }
    } catch (err) {
      console.error('SSE Error:', err);
      if (!res.writableEnded) {
        try {
          res.write(`data: ${JSON.stringify({ error: errMessage(err) })}\n\n`);
          res.end();
        } catch {
          /* 客户端已断开：socket 不可写，忽略 */
        }
      }
    }
  } else {
    try {
      const content = await callLLMService({
        messages,
        temperature,
        response_format,
        stream: false,
        model,
        profileId,
        signal: upstream.signal,
      });
      res.json({ success: true, content });
    } catch (err) {
      console.error('LLM Generate Error:', err);
      if (!res.writableEnded) {
        res.status(500).json({ success: false, error: errMessage(err) });
      }
    }
  }
});

// 静态托管前端构建产物（npm run build 后单进程即可提供完整应用，无需 Vite）
// NOVEL_DIST_DIR：桌面端（Electron）显式指定前端产物目录
const DIST_DIR = process.env.NOVEL_DIST_DIR
  ? process.env.NOVEL_DIST_DIR
  : path.join(APP_ROOT, 'dist');
let staticServing = false;
if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  app.use(express.static(DIST_DIR));
  // SPA 回退：非 /api 的 GET 一律回 index.html（前端为单页应用，无路由，直达/刷新都安全）
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  staticServing = true;
  console.log(`📦 [Static] serving ${DIST_DIR}`);
} else {
  console.log('💡 [Static] 未找到 dist/（仅 API 模式）。先 npm run build 可获得单进程完整应用。');
}

/** 单文件可执行形态：监听后自动拉起浏览器（NOVEL_OPEN=0 可关闭 / =1 强制开） */
function maybeOpenBrowser(url: string) {
  const flag = process.env.NOVEL_OPEN || '';
  const packaged = !fs.existsSync(path.join(process.cwd(), 'package.json'));
  if (flag === '0') return;
  if (!packaged && flag !== '1') return;
  try {
    const cmd =
      process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd);
  } catch {
    // 拉起失败不影响服务
  }
}

const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 [Backend] InkMind Backend listening at http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(
      `⚠️ [Backend] 正在绑定非回环地址 ${HOST}:${PORT} —— 服务将对局域网/公网可见，请确认已配置强鉴权且网络环境可信。`
    );
  }
  if (staticServing) {
    maybeOpenBrowser(`http://localhost:${PORT}`);
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n❌ 端口 ${PORT} 已被占用。可能已有一个实例在运行（浏览器打开 http://localhost:${PORT} 即可），` +
        `或用环境变量 PORT 换一个端口。\n`
    );
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});
