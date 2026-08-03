import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type LLMProvider = 'openai' | 'deepseek' | 'custom';

/** 单个大模型配置档（可多档切换启用） */
export interface LLMProfile {
  id: string;
  name: string;
  provider: LLMProvider;
  baseURL: string;
  modelName: string;
  temperature: number;
  encryptedApiKey?: string;
  customHeaders?: Record<string, string>;
  updatedAt?: string;
}

/** 向量检索 / Embedding API（OpenAI 兼容） */
export interface EmbeddingServerConfig {
  enabled: boolean;
  /** 与当前启用 LLM 共用 BaseURL + Key */
  useSameAsLlm: boolean;
  baseURL: string;
  modelName: string;
  encryptedApiKey?: string;
  /** 可选维度（部分模型支持 dimensions） */
  dimensions?: number | null;
  updatedAt?: string;
}

/** 落盘结构 v2 */
export interface ConfigFileV2 {
  version: 2;
  activeProfileId: string;
  profiles: LLMProfile[];
  embedding: EmbeddingServerConfig;
}

/** 对外：当前启用的 LLM（兼容旧 getStoredConfig 形状） */
export interface LLMServerConfig {
  provider: LLMProvider;
  baseURL: string;
  modelName: string;
  temperature: number;
  encryptedApiKey?: string;
  customHeaders?: Record<string, string>;
  /** 扩展：当前档 id / 名 */
  activeProfileId?: string;
  activeProfileName?: string;
}

/**
 * 配置目录放在项目根 `.novel-data`（不在 server/ 下）。
 * 旧路径 server/data 若存在会自动迁移，避免 tsx watch 监视写盘导致热重启整页刷新。
 */
const DATA_DIR = path.join(process.cwd(), '.novel-data');
const LEGACY_DATA_DIR = path.join(process.cwd(), 'server', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');

function migrateLegacyDataDir() {
  try {
    if (!fs.existsSync(LEGACY_DATA_DIR)) return;
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    for (const name of ['config.json', '.secret']) {
      const from = path.join(LEGACY_DATA_DIR, name);
      const to = path.join(DATA_DIR, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.copyFileSync(from, to);
      }
    }
  } catch (err) {
    console.warn('[config] legacy data migrate skipped:', err);
  }
}

function ensureDirectories() {
  migrateLegacyDataDir();
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SECRET_FILE)) {
    const randomSecret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, randomSecret, 'utf-8');
  }
}

function getSecretKey(): Buffer {
  ensureDirectories();
  const hex = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
  return Buffer.from(hex, 'hex');
}

export function encryptKey(plainText: string): string {
  if (!plainText) return '';
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', getSecretKey(), iv);
    let encrypted = cipher.update(plainText, 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (err) {
    console.error('Failed to encrypt key:', err);
    return '';
  }
}

export function decryptKey(cipherTextWithIv?: string): string {
  if (!cipherTextWithIv || !cipherTextWithIv.includes(':')) return '';
  try {
    const [ivHex, encryptedHex] = cipherTextWithIv.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', getSecretKey(), iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  } catch (err) {
    console.error('Failed to decrypt key:', err);
    return '';
  }
}

function newId(prefix = 'llm'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function defaultEmbedding(): EmbeddingServerConfig {
  return {
    enabled: false,
    useSameAsLlm: true,
    baseURL: '',
    modelName: 'text-embedding-3-small',
    dimensions: null,
  };
}

function defaultProfile(partial?: Partial<LLMProfile>): LLMProfile {
  return {
    id: partial?.id || newId('llm'),
    name: partial?.name || '默认 DeepSeek',
    provider: partial?.provider || 'deepseek',
    baseURL: partial?.baseURL || 'https://api.deepseek.com',
    modelName: partial?.modelName || 'deepseek-chat',
    temperature: partial?.temperature ?? 0.7,
    encryptedApiKey: partial?.encryptedApiKey,
    customHeaders: partial?.customHeaders || {},
    updatedAt: new Date().toISOString(),
  };
}

function writeConfigFile(cfg: ConfigFileV2): void {
  ensureDirectories();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

/** 读取并迁移 v1 单配置 → v2 多档 */
export function loadConfigFile(): ConfigFileV2 {
  ensureDirectories();
  if (!fs.existsSync(CONFIG_FILE)) {
    const p = defaultProfile();
    const cfg: ConfigFileV2 = {
      version: 2,
      activeProfileId: p.id,
      profiles: [p],
      embedding: defaultEmbedding(),
    };
    writeConfigFile(cfg);
    return cfg;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as any;

    // 已是 v2
    if (raw?.version === 2 && Array.isArray(raw.profiles) && raw.profiles.length) {
      const profiles = raw.profiles.map((p: any) =>
        defaultProfile({
          id: p.id,
          name: p.name,
          provider: p.provider,
          baseURL: p.baseURL,
          modelName: p.modelName,
          temperature: p.temperature,
          encryptedApiKey: p.encryptedApiKey,
          customHeaders: p.customHeaders,
        })
      );
      let activeId = raw.activeProfileId || profiles[0].id;
      if (!profiles.some((p: LLMProfile) => p.id === activeId)) {
        activeId = profiles[0].id;
      }
      const emb = { ...defaultEmbedding(), ...(raw.embedding || {}) };
      const cfg: ConfigFileV2 = {
        version: 2,
        activeProfileId: activeId,
        profiles,
        embedding: emb,
      };
      return cfg;
    }

    // v1 扁平结构迁移
    const migrated = defaultProfile({
      name: '默认配置',
      provider: raw.provider || 'deepseek',
      baseURL: raw.baseURL || 'https://api.deepseek.com',
      modelName: raw.modelName || 'deepseek-chat',
      temperature: raw.temperature ?? 0.7,
      encryptedApiKey: raw.encryptedApiKey,
      customHeaders: raw.customHeaders,
    });
    const cfg: ConfigFileV2 = {
      version: 2,
      activeProfileId: migrated.id,
      profiles: [migrated],
      embedding: defaultEmbedding(),
    };
    writeConfigFile(cfg);
    return cfg;
  } catch (err) {
    console.error('Error reading config file:', err);
    const p = defaultProfile();
    return {
      version: 2,
      activeProfileId: p.id,
      profiles: [p],
      embedding: defaultEmbedding(),
    };
  }
}

function getActiveProfile(cfg?: ConfigFileV2): LLMProfile {
  const c = cfg || loadConfigFile();
  return (
    c.profiles.find((p) => p.id === c.activeProfileId) ||
    c.profiles[0] ||
    defaultProfile()
  );
}

/** 当前启用 LLM（callLLMService 等使用） */
export function getStoredConfig(): LLMServerConfig {
  const file = loadConfigFile();
  const p = getActiveProfile(file);
  return {
    provider: p.provider,
    baseURL: p.baseURL,
    modelName: p.modelName,
    temperature: p.temperature,
    encryptedApiKey: p.encryptedApiKey,
    customHeaders: p.customHeaders,
    activeProfileId: p.id,
    activeProfileName: p.name,
  };
}

/** 更新当前启用档（兼容旧 POST /api/config/llm） */
export function saveStoredConfig(
  newConfig: Partial<LLMServerConfig> & { apiKey?: string; name?: string }
): LLMServerConfig {
  const file = loadConfigFile();
  const active = getActiveProfile(file);
  const updated: LLMProfile = {
    ...active,
    provider: (newConfig.provider as LLMProvider) || active.provider,
    baseURL: newConfig.baseURL || active.baseURL,
    modelName: newConfig.modelName || active.modelName,
    temperature:
      newConfig.temperature !== undefined ? newConfig.temperature : active.temperature,
    customHeaders: newConfig.customHeaders || active.customHeaders,
    name: newConfig.name?.trim() || active.name,
    updatedAt: new Date().toISOString(),
  };
  if (newConfig.apiKey && !newConfig.apiKey.startsWith('sk-****')) {
    updated.encryptedApiKey = encryptKey(newConfig.apiKey);
  } else {
    updated.encryptedApiKey = active.encryptedApiKey;
  }

  file.profiles = file.profiles.map((p) => (p.id === active.id ? updated : p));
  writeConfigFile(file);
  return getStoredConfig();
}

export function listProfilesPublic(): {
  activeProfileId: string;
  profiles: Array<{
    id: string;
    name: string;
    provider: string;
    baseURL: string;
    modelName: string;
    temperature: number;
    hasKey: boolean;
    maskedKey: string;
    isActive: boolean;
    updatedAt?: string;
  }>;
} {
  const file = loadConfigFile();
  return {
    activeProfileId: file.activeProfileId,
    profiles: file.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      baseURL: p.baseURL,
      modelName: p.modelName,
      temperature: p.temperature,
      hasKey: !!(p.encryptedApiKey && p.encryptedApiKey.length > 0),
      maskedKey: p.encryptedApiKey
        ? 'sk-****' + p.encryptedApiKey.slice(-4)
        : '',
      isActive: p.id === file.activeProfileId,
      updatedAt: p.updatedAt,
    })),
  };
}

export function upsertProfile(input: {
  id?: string;
  name: string;
  provider?: LLMProvider;
  baseURL: string;
  modelName: string;
  temperature?: number;
  apiKey?: string;
  customHeaders?: Record<string, string>;
  /** 保存后是否立即启用 */
  activate?: boolean;
}): ReturnType<typeof listProfilesPublic> {
  const file = loadConfigFile();
  const existing = input.id
    ? file.profiles.find((p) => p.id === input.id)
    : undefined;

  if (existing) {
    const next: LLMProfile = {
      ...existing,
      name: input.name.trim() || existing.name,
      provider: input.provider || existing.provider,
      baseURL: input.baseURL.trim() || existing.baseURL,
      modelName: input.modelName.trim() || existing.modelName,
      temperature:
        input.temperature !== undefined ? input.temperature : existing.temperature,
      customHeaders: input.customHeaders || existing.customHeaders,
      updatedAt: new Date().toISOString(),
    };
    if (input.apiKey && !input.apiKey.startsWith('sk-****')) {
      next.encryptedApiKey = encryptKey(input.apiKey);
    }
    file.profiles = file.profiles.map((p) => (p.id === existing.id ? next : p));
    if (input.activate) file.activeProfileId = existing.id;
  } else {
    const created = defaultProfile({
      name: input.name.trim() || '新模型',
      provider: input.provider || 'custom',
      baseURL: input.baseURL.trim(),
      modelName: input.modelName.trim(),
      temperature: input.temperature ?? 0.7,
      customHeaders: input.customHeaders,
    });
    if (input.apiKey && !input.apiKey.startsWith('sk-****')) {
      created.encryptedApiKey = encryptKey(input.apiKey);
    }
    file.profiles.push(created);
    if (input.activate !== false && file.profiles.length === 1) {
      file.activeProfileId = created.id;
    } else if (input.activate) {
      file.activeProfileId = created.id;
    }
  }
  writeConfigFile(file);
  return listProfilesPublic();
}

export function activateProfile(id: string): ReturnType<typeof listProfilesPublic> {
  const file = loadConfigFile();
  if (!file.profiles.some((p) => p.id === id)) {
    throw new Error('配置档不存在');
  }
  file.activeProfileId = id;
  writeConfigFile(file);
  return listProfilesPublic();
}

export function deleteProfile(id: string): ReturnType<typeof listProfilesPublic> {
  const file = loadConfigFile();
  if (file.profiles.length <= 1) {
    throw new Error('至少保留一个模型配置档');
  }
  if (!file.profiles.some((p) => p.id === id)) {
    throw new Error('配置档不存在');
  }
  file.profiles = file.profiles.filter((p) => p.id !== id);
  if (file.activeProfileId === id) {
    file.activeProfileId = file.profiles[0].id;
  }
  writeConfigFile(file);
  return listProfilesPublic();
}

export function getEmbeddingConfigPublic(): {
  enabled: boolean;
  useSameAsLlm: boolean;
  baseURL: string;
  modelName: string;
  dimensions: number | null;
  hasKey: boolean;
  maskedKey: string;
  resolvedBaseURL: string;
  resolvedHasKey: boolean;
} {
  const file = loadConfigFile();
  const emb = file.embedding || defaultEmbedding();
  const llm = getActiveProfile(file);
  const resolvedBaseURL = emb.useSameAsLlm
    ? llm.baseURL
    : emb.baseURL || llm.baseURL;
  const resolvedKey = emb.useSameAsLlm
    ? decryptKey(llm.encryptedApiKey)
    : decryptKey(emb.encryptedApiKey) || decryptKey(llm.encryptedApiKey);
  return {
    enabled: !!emb.enabled,
    useSameAsLlm: emb.useSameAsLlm !== false,
    baseURL: emb.baseURL || '',
    modelName: emb.modelName || 'text-embedding-3-small',
    dimensions: emb.dimensions ?? null,
    hasKey: !!(emb.encryptedApiKey && emb.encryptedApiKey.length > 0),
    maskedKey: emb.encryptedApiKey
      ? 'sk-****' + emb.encryptedApiKey.slice(-4)
      : '',
    resolvedBaseURL,
    resolvedHasKey: !!resolvedKey,
  };
}

export function saveEmbeddingConfig(input: {
  enabled?: boolean;
  useSameAsLlm?: boolean;
  baseURL?: string;
  modelName?: string;
  dimensions?: number | null;
  apiKey?: string;
}): ReturnType<typeof getEmbeddingConfigPublic> {
  const file = loadConfigFile();
  const emb = { ...defaultEmbedding(), ...(file.embedding || {}) };
  if (input.enabled !== undefined) emb.enabled = !!input.enabled;
  if (input.useSameAsLlm !== undefined) emb.useSameAsLlm = !!input.useSameAsLlm;
  if (input.baseURL !== undefined) emb.baseURL = input.baseURL.trim();
  if (input.modelName !== undefined) emb.modelName = input.modelName.trim();
  if (input.dimensions !== undefined) emb.dimensions = input.dimensions;
  if (input.apiKey && !input.apiKey.startsWith('sk-****')) {
    emb.encryptedApiKey = encryptKey(input.apiKey);
  }
  emb.updatedAt = new Date().toISOString();
  file.embedding = emb;
  writeConfigFile(file);
  return getEmbeddingConfigPublic();
}

function resolveEmbeddingCredentials(): {
  baseURL: string;
  apiKey: string;
  modelName: string;
  dimensions?: number | null;
} {
  const file = loadConfigFile();
  const emb = file.embedding || defaultEmbedding();
  const llm = getActiveProfile(file);
  const baseURL = (emb.useSameAsLlm ? llm.baseURL : emb.baseURL || llm.baseURL).trim();
  let apiKey = '';
  if (emb.useSameAsLlm) {
    apiKey = decryptKey(llm.encryptedApiKey);
  } else {
    apiKey = decryptKey(emb.encryptedApiKey) || decryptKey(llm.encryptedApiKey);
  }
  return {
    baseURL,
    apiKey,
    modelName: emb.modelName || 'text-embedding-3-small',
    dimensions: emb.dimensions,
  };
}

/** OpenAI 兼容 embeddings */
export async function createEmbeddings(
  texts: string[],
  options?: { baseURL?: string; apiKey?: string; modelName?: string }
): Promise<{ vectors: number[][]; model: string; dimensions: number }> {
  const cred = resolveEmbeddingCredentials();
  const baseURL = (options?.baseURL?.trim() || cred.baseURL || '').trim();
  let apiKey = options?.apiKey?.trim() || '';
  if (!apiKey || apiKey.startsWith('sk-****')) {
    apiKey = cred.apiKey;
  }
  const model = options?.modelName || cred.modelName;

  if (!baseURL) throw new Error('Embedding Base URL 为空');
  if (!apiKey) throw new Error('Embedding API Key 未配置');
  if (!texts.length) throw new Error('texts 为空');

  const root = resolveOpenAICompatibleRoot(baseURL);
  const endpoint = root.endsWith('/v1')
    ? `${root}/embeddings`
    : `${root}/v1/embeddings`;

  const body: Record<string, unknown> = {
    model,
    input: texts.length === 1 ? texts[0] : texts,
  };
  if (cred.dimensions && cred.dimensions > 0) {
    body.dimensions = cred.dimensions;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Embedding 失败 [${response.status}]: ${text.slice(0, 400)}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Embedding 响应非 JSON: ${text.slice(0, 200)}`);
  }
  const list: any[] = Array.isArray(data?.data) ? data.data : [];
  const sorted = [...list].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0)
  );
  const vectors = sorted.map((d) => d.embedding as number[]);
  if (!vectors.length || !Array.isArray(vectors[0])) {
    throw new Error('Embedding 响应无有效向量');
  }
  return {
    vectors,
    model: data.model || model,
    dimensions: vectors[0].length,
  };
}

export async function testEmbedding(): Promise<{
  ok: boolean;
  model: string;
  dimensions: number;
  latencyMs: number;
  sampleNorm: number;
}> {
  const t0 = Date.now();
  const { vectors, model, dimensions } = await createEmbeddings([
    '小说工作室向量检索连通性测试',
  ]);
  const v = vectors[0];
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return {
    ok: true,
    model,
    dimensions,
    latencyMs: Date.now() - t0,
    sampleNorm: Math.round(norm * 1000) / 1000,
  };
}

/** 归一化 OpenAI 兼容根地址 */
export function resolveOpenAICompatibleRoot(baseURL: string): string {
  let u = (baseURL || '').trim().replace(/\/+$/, '');
  if (!u) {
    throw new Error('Base URL 为空');
  }
  u = u
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/v1\/embeddings$/i, '')
    .replace(/\/embeddings$/i, '')
    .replace(/\/v1\/models$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/+$/, '');
  return u;
}

export function resolveModelsEndpoints(baseURL: string): string[] {
  const root = resolveOpenAICompatibleRoot(baseURL);
  if (root.endsWith('/v1')) {
    return [`${root}/models`];
  }
  return [`${root}/v1/models`, `${root}/models`];
}

export interface LLMModelInfo {
  id: string;
  owned_by?: string;
  created?: number;
}

export async function listLLMModels(options?: {
  baseURL?: string;
  apiKey?: string;
  /** 指定配置档 id 取 Key（默认当前启用） */
  profileId?: string;
}): Promise<{ models: LLMModelInfo[]; endpoint: string; count: number }> {
  const file = loadConfigFile();
  const profile = options?.profileId
    ? file.profiles.find((p) => p.id === options.profileId) || getActiveProfile(file)
    : getActiveProfile(file);
  const baseURL = (options?.baseURL?.trim() || profile.baseURL || '').trim();
  if (!baseURL) {
    throw new Error('请先填写 API Base URL');
  }

  let apiKey = '';
  const rawKey = options?.apiKey?.trim() || '';
  if (rawKey && !rawKey.startsWith('sk-****')) {
    apiKey = rawKey;
  } else {
    apiKey = decryptKey(profile.encryptedApiKey);
  }

  if (!apiKey) {
    throw new Error('未配置 API Key：请先填写密钥并保存，或在刷新前粘贴有效 Key');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    ...profile.customHeaders,
  };

  const endpoints = resolveModelsEndpoints(baseURL);
  let lastError = '';

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers,
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `[${response.status}] ${text.slice(0, 400)}`;
        if (response.status === 404 || response.status === 405) {
          continue;
        }
        throw new Error(`拉取模型列表失败 ${lastError}`);
      }

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`模型列表响应不是 JSON：${text.slice(0, 200)}`);
      }

      const rawList: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.models)
            ? data.models
            : [];

      const models: LLMModelInfo[] = rawList
        .map((m) => {
          if (typeof m === 'string') {
            return { id: m };
          }
          const id = m?.id || m?.model || m?.name || m?.model_name;
          if (!id || typeof id !== 'string') return null;
          return {
            id,
            owned_by: typeof m.owned_by === 'string' ? m.owned_by : m.ownedBy,
            created: typeof m.created === 'number' ? m.created : undefined,
          } as LLMModelInfo;
        })
        .filter((m): m is LLMModelInfo => !!m && !!m.id);

      const seen = new Set<string>();
      const unique = models.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      unique.sort((a, b) => a.id.localeCompare(b.id, 'en'));

      if (unique.length === 0) {
        throw new Error(`接口 ${endpoint} 返回了空模型列表，请检查 Base URL 与权限`);
      }

      return { models: unique, endpoint, count: unique.length };
    } catch (err: any) {
      lastError = err?.message || String(err);
      const isLast = endpoint === endpoints[endpoints.length - 1];
      if (/401|403|Invalid API|invalid.?api.?key|Incorrect API key/i.test(lastError)) {
        throw err instanceof Error ? err : new Error(lastError);
      }
      if (isLast) {
        throw err instanceof Error ? err : new Error(lastError);
      }
      continue;
    }
  }

  throw new Error(
    `无法拉取模型列表。已尝试：${endpoints.join(' · ')}。最后错误：${lastError || '未知'}`
  );
}

export async function callLLMService(options: {
  messages: { role: string; content: string }[];
  temperature?: number;
  response_format?: { type: 'json_object' | 'text' };
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  /** R3 收尾：请求级模型覆盖（未传则用激活配置档的 modelName） */
  model?: string;
}): Promise<string> {
  const config = getStoredConfig();
  const apiKey = decryptKey(config.encryptedApiKey);

  if (!apiKey) {
    throw new Error(
      '未配置或无法解析加密 API Key，请先在「引擎与风格」添加并启用模型配置档。'
    );
  }

  let baseURL = (config.baseURL || 'https://api.openai.com').replace(/\/+$/, '');
  let endpoint = `${baseURL}/v1/chat/completions`;
  if (baseURL.endsWith('/v1/chat/completions') || baseURL.endsWith('/chat/completions')) {
    endpoint = baseURL;
  } else if (baseURL.endsWith('/v1')) {
    endpoint = `${baseURL}/chat/completions`;
  }

  const payload: any = {
    model: options.model?.trim() || config.modelName || 'deepseek-chat',
    messages: options.messages,
    temperature:
      options.temperature !== undefined ? options.temperature : config.temperature,
    stream: !!options.stream,
  };

  if (options.response_format && (config.provider === 'openai' || config.provider === 'deepseek')) {
    if (config.provider === 'openai' && (config.modelName || '').includes('gpt-4')) {
      payload.response_format = options.response_format;
    } else if (config.provider === 'deepseek' && config.modelName === 'deepseek-chat') {
      payload.response_format = { type: 'json_object' };
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...config.customHeaders,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM API 请求失败 [${response.status}]: ${errText}`);
  }

  if (options.stream && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr);
          const chunk = parsed.choices?.[0]?.delta?.content || '';
          if (chunk) {
            fullContent += chunk;
            if (options.onChunk) {
              options.onChunk(chunk);
            }
          }
        } catch {
          // ignore
        }
      }
    }
    return fullContent;
  } else {
    const data = (await response.json()) as any;
    return data.choices?.[0]?.message?.content || '';
  }
}
