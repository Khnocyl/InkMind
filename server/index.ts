import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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
} from './llmService';
import { runDoctor } from './doctor';

const app = express();
const PORT = process.env.PORT || 3001;

// ─── API Token 鉴权（R8-2）───────────────────────────────────────────────
// 威胁模型：恶意网页向 localhost:3001 发简单请求（CORS 挡不住「发出」，
// 只挡「读取」），可消耗 LLM 额度 / 触发副作用。token 确保只有持有者能调。
// - token 存 .novel-data/api-token（首次启动自动生成 32 字节 hex；.gitignore 已忽略）
// - 环境变量 API_TOKEN 可显式指定（优先）
// - 除 /api/health 外所有 /api/* 均需 x-api-token 或 Authorization: Bearer <token>
const DATA_DIR = path.join(process.cwd(), '.novel-data');
const TOKEN_FILE = path.join(DATA_DIR, 'api-token');

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
    console.log(`🔑 [Auth] 已生成 API Token → ${TOKEN_FILE}`);
    return fresh;
  } catch (err) {
    // 无法读写 token 文件：退化为仅 CORS 保护（本地工具可接受，打警告）
    console.warn('[Auth] token 文件读写失败，API Token 鉴权未启用:', err);
    return '';
  }
}

const API_TOKEN = loadOrCreateApiToken();

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

// API Token 鉴权：放在 CORS / json 之后，确保 401 响应也带 CORS 头（前端可读错误）
app.use('/api', (req, res, next) => {
  if (!API_TOKEN) return next(); // 未启用（无法读写 token 文件）时放行
  if (req.path === '/health') return next(); // 健康检查无副作用，开放探活
  const provided = extractToken(req);
  if (provided && safeEqual(provided, API_TOKEN)) return next();
  console.warn(
    `[Auth] 拒绝未授权请求: ${req.method} ${req.path} (来源 ${req.headers.origin || req.ip})`
  );
  res.status(401).json({ success: false, error: '未授权：缺少或错误的 API Token' });
});

// 轻量健康检查（不调 LLM）
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      ok: true,
      service: 'novel-studio-backend',
      time: new Date().toISOString(),
    },
  });
});

// Doctor：配置 + 连通 + JSON + 流式（会真实调用 LLM，可能数秒）
app.post('/api/doctor', async (req, res) => {
  try {
    const includeStream = req.body?.includeStream !== false;
    const includeJson = req.body?.includeJson !== false;
    const report = await runDoctor({ includeStream, includeJson });
    res.json({ success: true, data: report });
  } catch (err: any) {
    console.error('Doctor Error:', err);
    res.status(500).json({
      success: false,
      error: err?.message || 'Doctor 诊断失败',
    });
  }
});

// Get current LLM config (with masked key) — 当前「启用」档
app.get('/api/config/llm', (req, res) => {
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
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 多模型配置档列表 */
app.get('/api/config/llm/profiles', (_req, res) => {
  try {
    res.json({ success: true, data: listProfilesPublic() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 启用指定配置档 */
app.post('/api/config/llm/profiles/:id/activate', (req, res) => {
  try {
    const data = activateProfile(req.params.id);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/** 删除配置档 */
app.delete('/api/config/llm/profiles/:id', (req, res) => {
  try {
    const data = deleteProfile(req.params.id);
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/** 向量检索 Embedding 配置 */
app.get('/api/config/embedding', (_req, res) => {
  try {
    res.json({ success: true, data: getEmbeddingConfigPublic() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/embedding/test', async (_req, res) => {
  try {
    const result = await testEmbedding();
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Embedding 测试失败' });
  }
});

app.post('/api/embedding/create', async (req, res) => {
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
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Embedding 失败' });
  }
});

/**
 * 刷新服务商模型列表（OpenAI 兼容 GET /v1/models）。
 * body 可带未保存的 baseURL / apiKey 做探测，密钥不会落盘。
 */
app.post('/api/config/llm/models', async (req, res) => {
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
  } catch (err: any) {
    console.error('List models error:', err);
    res.status(500).json({
      success: false,
      error: err?.message || '拉取模型列表失败',
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
  } catch (err: any) {
    console.error('List models error:', err);
    res.status(500).json({
      success: false,
      error: err?.message || '拉取模型列表失败',
    });
  }
});

// Generate or Stream completion
app.post('/api/llm/generate', async (req, res) => {
  const { messages, temperature, response_format, stream, model } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ success: false, error: '缺少有效的 messages 数组参数' });
  }

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
        onChunk: (chunk) => {
          res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        },
      });
      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (err: any) {
      console.error('SSE Error:', err);
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  } else {
    try {
      const content = await callLLMService({
        messages,
        temperature,
        response_format,
        stream: false,
        model,
      });
      res.json({ success: true, content });
    } catch (err: any) {
      console.error('LLM Generate Error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 [Backend] Antigravity Novel Studio Backend listening at http://localhost:${PORT}`);
});
