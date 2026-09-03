import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import {
  assertSafeBaseUrl,
  assertSafeUrl,
  buildSafeHeaders,
  resolveRequestApiKey,
  sameBaseUrlOrigin,
} from './llmSecurity';
import {
  decryptWithKeyAuto,
  encryptWithKeyGcm,
} from './keyCipher';

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
 * 配置目录放在应用根 `.novel-data`（不在 server/ 下）。
 * 应用根判定：cwd 下有 package.json 视为开发/脚本态（项目根）；
 * 否则（单文件可执行形态）取可执行文件所在目录——双击运行时数据落在 exe 旁边。
 * 旧路径 server/data 若存在会自动迁移并清理，避免 tsx watch 监视写盘导致热重启。
 */
const APP_ROOT = process.env.NOVEL_APP_ROOT
  ? process.env.NOVEL_APP_ROOT
  : fs.existsSync(path.join(process.cwd(), 'package.json'))
    ? process.cwd()
    : path.dirname(process.execPath);

/** 应用根（开发态=项目根；单文件可执行态=exe 所在目录）。备份等磁盘服务共用。 */
export function getAppRoot(): string {
  return APP_ROOT;
}
const DATA_DIR = path.join(APP_ROOT, '.novel-data');
const LEGACY_DATA_DIR = path.join(APP_ROOT, 'server', 'data');
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
    // 新位置已齐备：删除旧目录残留（含旧密钥副本），杜绝密文多份留存
    for (const name of ['config.json', '.secret']) {
      fs.rmSync(path.join(LEGACY_DATA_DIR, name), { force: true });
    }
    fs.rmSync(LEGACY_DATA_DIR, { recursive: true, force: true });
    console.log('[config] 旧 server/data 已迁移并清理');
  } catch (err) {
    console.warn('[config] legacy data migrate skipped:', err);
  }
}

// ─── 主密钥：机器绑定派生，不落盘 ───────────────────────────────────────
// 此前 32 字节密钥明文写在 .novel-data/.secret，与密文同目录——能读到密文
// 就能读到密钥，加密形同虚设。现改为运行时从机器指纹（Windows MachineGuid /
// macOS IOPlatformUUID / Linux machine-id）+ 当前用户名派生，密钥不再存在
// 任何文件里，.novel-data 整个目录被拷走也无法在别处解密。
// 威胁模型不变：能以同一用户身份在本机执行代码者仍可解密（本地工具的边界）。

let cachedFingerprint: string | null = null;

function machineFingerprint(): string {
  if (cachedFingerprint) return cachedFingerprint;
  let fp = '';
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m) fp = m[1];
    } else if (process.platform === 'darwin') {
      const out = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice',
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) fp = m[1];
    } else {
      fp = fs.readFileSync('/etc/machine-id', 'utf-8').trim();
    }
  } catch {
    // 指纹不可得时降级为 hostname（弱一些但稳定，保证功能可用）
  }
  cachedFingerprint = fp || os.hostname() || 'unknown-host';
  return cachedFingerprint;
}

let cachedMasterKey: Buffer | null = null;

function getSecretKey(): Buffer {
  if (!cachedMasterKey) {
    cachedMasterKey = crypto
      .createHash('sha256')
      .update('novel-studio-master-key-v2\x00')
      .update(machineFingerprint())
      .update('\x00')
      .update(os.userInfo().username || 'user')
      .digest();
  }
  return cachedMasterKey;
}

/** 旧 .secret 文件密钥（迁移期兜底；迁移成功后文件删除、这里返回 null） */
let legacyKeyCache: Buffer | null | undefined;

function readLegacySecretKey(): Buffer | null {
  if (legacyKeyCache !== undefined) return legacyKeyCache;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const hex = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
      legacyKeyCache = /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
    } else {
      legacyKeyCache = null;
    }
  } catch {
    legacyKeyCache = null;
  }
  return legacyKeyCache;
}

/**
 * 一次性升级：存在旧 .secret 时，把配置里全部密文字段用旧钥解出、
 * 以机器绑定钥重加密落盘，然后删除 .secret。失败则保留 .secret，
 * decryptKey 仍以旧钥兜底，功能不中断。
 */
function migrateSecretKeyIfNeeded(): void {
  if (!fs.existsSync(SECRET_FILE)) return;
  try {
    const legacyKey = readLegacySecretKey();
    if (!legacyKey) {
      fs.rmSync(SECRET_FILE, { force: true });
      return;
    }
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as {
        version?: number;
        profiles?: { encryptedApiKey?: string }[];
        embedding?: { encryptedApiKey?: string };
      };
      if (raw?.version === 2) {
        let changed = false;
        const reencrypt = (cipher?: string): string | undefined => {
          if (!cipher || !cipher.includes(':')) return cipher;
          const plain = decryptWithKey(legacyKey, cipher);
          if (!plain) return cipher; // 已是新钥密文或无法解：原样保留
          changed = true;
          return encryptWithKey(getSecretKey(), plain);
        };
        for (const p of raw.profiles || []) {
          p.encryptedApiKey = reencrypt(p.encryptedApiKey);
        }
        if (raw.embedding) {
          raw.embedding.encryptedApiKey = reencrypt(raw.embedding.encryptedApiKey);
        }
        if (changed) {
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2), 'utf-8');
        }
      }
    }
    fs.rmSync(SECRET_FILE, { force: true });
    legacyKeyCache = null;
    console.log('[config] 主密钥已升级为机器绑定派生，旧 .secret 已删除');
  } catch (err) {
    console.warn('[config] .secret 密钥迁移失败（保留旧文件，运行时旧钥兜底）:', err);
  }
}

function ensureDirectories() {
  migrateLegacyDataDir();
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  hardenFilePermissions(DATA_DIR, true);
  migrateSecretKeyIfNeeded();
  migrateCipherToGcmIfNeeded();
}

/**
 * 收紧文件/目录权限（安全加固 P1）：POSIX chmod 600/700；Windows 用 icacls
 * 移除继承并仅保留当前用户完全控制。失败静默（尽力而为，不阻塞启动）。
 * @param p 目标路径
 * @param isDir 目录=true（POSIX 700 / Windows 加 (OI)(CI)），文件=false（POSIX 600）
 */
export function hardenFilePermissions(p: string, isDir: boolean): void {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME || process.env.USER || '当前用户';
      const suffix = isDir ? '(OI)(CI)F' : 'F';
      execSync(`icacls "${p}" /inheritance:r /grant:r "${user}:${suffix}"`, {
        stdio: 'ignore',
      });
    } else {
      fs.chmodSync(p, isDir ? 0o700 : 0o600);
    }
  } catch {
    /* 权限收紧失败不阻塞 */
  }
}

/**
 * 一次性升级（安全审计 P3-1）：把配置里仍是旧版 CBC 格式（无 `gcm:` 前缀）的
 * 密文用当前主密钥解出并以 GCM 重加密落盘。失败保留原密文（解密兼容读兜底）。
 */
function migrateCipherToGcmIfNeeded(): void {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as {
      version?: number;
      profiles?: { encryptedApiKey?: string }[];
      embedding?: { encryptedApiKey?: string };
    };
    if (raw?.version !== 2) return;
    let changed = false;
    const upgrade = (cipher?: string): string | undefined => {
      if (!cipher || cipher.startsWith('gcm:')) return cipher;
      const plain = decryptWithKey(getSecretKey(), cipher);
      if (!plain) return cipher; // 异机/损坏：无法迁移，解密时自然拒绝
      changed = true;
      return encryptWithKey(getSecretKey(), plain);
    };
    for (const p of raw.profiles || []) {
      p.encryptedApiKey = upgrade(p.encryptedApiKey);
    }
    if (raw.embedding) {
      raw.embedding.encryptedApiKey = upgrade(raw.embedding.encryptedApiKey);
    }
    if (changed) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2), 'utf-8');
      console.log('[config] API Key 密文已升级为 aes-256-gcm（带认证标签）');
    }
  } catch (err) {
    console.warn('[config] CBC→GCM 迁移跳过（解密兼容读兜底）:', err);
  }
}

function encryptWithKey(key: Buffer, plainText: string): string {
  // v2：aes-256-gcm（带认证标签，防密文篡改）——旧 CBC 密文由启动迁移统一升级
  return encryptWithKeyGcm(key, plainText);
}

function decryptWithKey(key: Buffer, cipherTextWithIv: string): string {
  // 自动格式：gcm: 前缀 → GCM；否则按旧版 CBC 兼容读（迁移兜底）
  return decryptWithKeyAuto(key, cipherTextWithIv);
}

export function encryptKey(plainText: string): string {
  if (!plainText) return '';
  try {
    ensureDirectories();
    return encryptWithKey(getSecretKey(), plainText);
  } catch (err) {
    console.error('Failed to encrypt key:', err);
    return '';
  }
}

export function decryptKey(cipherTextWithIv?: string): string {
  if (!cipherTextWithIv || !cipherTextWithIv.includes(':')) return '';
  try {
    ensureDirectories();
    const byMaster = decryptWithKey(getSecretKey(), cipherTextWithIv);
    if (byMaster) return byMaster;
    // 迁移失败遗留的旧密文：以旧 .secret 钥兜底
    const legacy = readLegacySecretKey();
    return legacy ? decryptWithKey(legacy, cipherTextWithIv) : '';
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

/**
 * 安全加固 P0：更换 baseURL 到不同 origin 且未提供新 key 时，不再沿用旧加密密钥
 * （防止把已存 key 发往攻击者可控的 baseURL）。origin 比较忽略路径差异（/v1 等）。
 */
function shouldKeepExistingKey(
  existingBaseURL: string,
  nextBaseURL: string,
  incomingKey?: string
): boolean {
  const key = (incomingKey || '').trim();
  if (key && !key.startsWith('sk-****')) return true; // 显式提供新 key → 用新的
  if (!nextBaseURL.trim()) return true; // baseURL 未变
  if (!existingBaseURL.trim()) return false; // 之前无 baseURL → 无旧 key 可沿用
  return sameBaseUrlOrigin(existingBaseURL, nextBaseURL);
}

/** 服务端模型白名单：当前所有配置档的 modelName（供 /api/llm/generate 校验 model） */
export function resolveAllowedModels(): string[] {
  const file = loadConfigFile();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of file.profiles) {
    const m = (p.modelName || '').trim();
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
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
  if (newConfig.baseURL && newConfig.baseURL.trim()) {
    assertSafeBaseUrl(newConfig.baseURL);
  }
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
  } else if (shouldKeepExistingKey(active.baseURL, updated.baseURL, newConfig.apiKey)) {
    updated.encryptedApiKey = active.encryptedApiKey;
  } else {
    // 安全加固 P0：更换 baseURL 到不同 origin 且未提供新 key → 清空密钥，防旧 key 外泄
    updated.encryptedApiKey = undefined;
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
  if (input.baseURL && input.baseURL.trim()) {
    assertSafeBaseUrl(input.baseURL);
  }
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
    } else if (!shouldKeepExistingKey(existing.baseURL, next.baseURL, input.apiKey)) {
      // 安全加固 P0：更换 baseURL 到不同 origin 且未提供新 key → 清空密钥，防旧 key 外泄
      next.encryptedApiKey = undefined;
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
  if (input.baseURL && input.baseURL.trim()) {
    assertSafeBaseUrl(input.baseURL);
  }
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
  if (!baseURL) throw new Error('Embedding Base URL 为空');
  assertSafeBaseUrl(baseURL);
  const apiKey = resolveRequestApiKey({
    requestedBaseURL: options?.baseURL,
    storedBaseURL: cred.baseURL,
    requestedApiKey: options?.apiKey,
    storedApiKey: cred.apiKey,
  });
  const model = options?.modelName || cred.modelName;

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
    signal: AbortSignal.timeout(LLM_UPSTREAM_TIMEOUT_MS),
  });
  assertSafeUrl(response.url || endpoint); // 重定向复检（P3-2）
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
  assertSafeBaseUrl(baseURL);

  const apiKey = resolveRequestApiKey({
    requestedBaseURL: options?.baseURL,
    storedBaseURL: profile.baseURL,
    requestedApiKey: options?.apiKey,
    storedApiKey: decryptKey(profile.encryptedApiKey),
  });

  if (!apiKey) {
    throw new Error('未配置 API Key：请先填写密钥并保存，或在刷新前粘贴有效 Key');
  }

  const headers: Record<string, string> = buildSafeHeaders(
    {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    profile.customHeaders
  );

  const endpoints = resolveModelsEndpoints(baseURL);
  let lastError = '';

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      assertSafeUrl(response.url || endpoint); // 重定向复检（P3-2）
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

/**
 * 输出 token 上限（字数达标的关键之一）：不传时由服务商/中转默认值决定，
 * 常见 4096 token ≈ 2000+ 中文字即被截断——目标 3000 字的章必然写不完。
 * 默认 8192（主流 OpenAI 兼容端安全值），可用环境变量 NOVEL_LLM_MAX_TOKENS 覆盖。
 */
const DEFAULT_LLM_MAX_TOKENS = Number(process.env.NOVEL_LLM_MAX_TOKENS) > 0
  ? Number(process.env.NOVEL_LLM_MAX_TOKENS)
  : 8192;

/**
 * 上游请求硬超时（毫秒）：此前三处上游 fetch 均无超时——上游挂死时
 * HTTP 响应永不结束，连接与内存持续累积；前端 120s 超时放弃后后端仍完整跑完并全额计费。
 * 默认 10 分钟（长文流式生成 + 多轮补写的安全上限），NOVEL_LLM_TIMEOUT_MS 可调。
 */
const LLM_UPSTREAM_TIMEOUT_MS = Number(process.env.NOVEL_LLM_TIMEOUT_MS) > 0
  ? Number(process.env.NOVEL_LLM_TIMEOUT_MS)
  : 600_000;

export async function callLLMService(options: {
  messages: { role: string; content: string }[];
  temperature?: number;
  response_format?: { type: 'json_object' | 'text' };
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  /** 流结束回调：finish_reason=length 表示被 max_tokens 截断（上游可见） */
  onFinish?: (info: { finishReason?: string }) => void;
  /** R3 收尾：请求级模型覆盖（未传则用激活配置档的 modelName） */
  model?: string;
  /**
   * 按角色路由：命中已保存配置档 → 整体切换到该档
   * （baseURL / 解密 Key / modelName / 温度 / 自定义头 / provider）。
   * 未传、档不存在时回退激活档——与不传 profileId 完全等价。
   */
  profileId?: string;
  maxTokens?: number;
  /** 客户端断连/取消信号：中止后停止向上游拉流，避免无人消费还全额计费 */
  signal?: AbortSignal;
}): Promise<string> {
  const config = getStoredConfig();

  // 按角色路由：请求级 profileId 命中已保存档时，用该档的完整凭据发起上游请求
  let effectiveConfig = config;
  if (options.profileId) {
    const routed = loadConfigFile().profiles.find((p) => p.id === options.profileId);
    if (routed) {
      effectiveConfig = {
        provider: routed.provider,
        baseURL: routed.baseURL,
        modelName: routed.modelName,
        temperature: routed.temperature,
        encryptedApiKey: routed.encryptedApiKey,
        customHeaders: routed.customHeaders,
        activeProfileId: routed.id,
        activeProfileName: routed.name,
      };
    }
  }
  const apiKey = decryptKey(effectiveConfig.encryptedApiKey);

  if (!apiKey) {
    throw new Error(
      '未配置或无法解析加密 API Key，请先在「引擎与风格」添加并启用模型配置档。'
    );
  }

  let baseURL = (effectiveConfig.baseURL || 'https://api.openai.com').replace(/\/+$/, '');
  assertSafeBaseUrl(baseURL);
  let endpoint = `${baseURL}/v1/chat/completions`;
  if (baseURL.endsWith('/v1/chat/completions') || baseURL.endsWith('/chat/completions')) {
    endpoint = baseURL;
  } else if (baseURL.endsWith('/v1')) {
    endpoint = `${baseURL}/chat/completions`;
  }

  const payload: any = {
    model: options.model?.trim() || effectiveConfig.modelName || 'deepseek-chat',
    messages: options.messages,
    temperature:
      options.temperature !== undefined ? options.temperature : effectiveConfig.temperature,
    stream: !!options.stream,
    // 字数达标关键：显式给输出上限，避免中转/默认 4096 截断
    max_tokens: options.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
  };

  if (options.response_format && (effectiveConfig.provider === 'openai' || effectiveConfig.provider === 'deepseek')) {
    if (effectiveConfig.provider === 'openai' && (effectiveConfig.modelName || '').includes('gpt-4')) {
      payload.response_format = options.response_format;
    } else if (effectiveConfig.provider === 'deepseek' && effectiveConfig.modelName === 'deepseek-chat') {
      payload.response_format = { type: 'json_object' };
    }
  }

  const headers: Record<string, string> = buildSafeHeaders(
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    effectiveConfig.customHeaders
  );

  /**
   * 上游请求（带共享池耐心重试）：429/502/503/504 属「稍后重试可解」——
   * OpenRouter 类共享池限流、网关抖动。退避 2s/8s/20s ±抖动，最多 4 次尝试。
   * 客户端已断开（options.signal aborted）绝不重试；一旦进入流式消费阶段
   * （已有 onChunk 发出）也不重试，避免内容重复。
   */
  let response!: Response;
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted) {
      throw new Error('客户端已断开，取消上游请求');
    }
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        // 上游硬超时（防挂死连接累积）+ 客户端断连中止（防白烧计费）
        signal: AbortSignal.any([
          AbortSignal.timeout(LLM_UPSTREAM_TIMEOUT_MS),
          ...(options.signal ? [options.signal] : []),
        ]),
      });
    } catch (err: any) {
      // 客户端主动断开：直接上抛；其余网络异常按可重试处理
      if (options.signal?.aborted) throw err;
      if (attempt >= maxAttempts) throw err;
      const delay = [2000, 8000, 20000][attempt - 1] ?? 8000;
      console.warn(
        `[LLM] 上游网络异常（第${attempt}/${maxAttempts}次）: ${err?.message || err} · ${delay}ms 后重试`
      );
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    // 重定向复检（P3-2）：在重试环外抛出，安全违规绝不重试盲打
    assertSafeUrl(response.url || endpoint);

    if (response.ok) break;

    const errText = await response.text();
    const retryable = [429, 502, 503, 504].includes(response.status);
    if (!retryable || attempt >= maxAttempts) {
      throw new Error(`LLM API 请求失败 [${response.status}]: ${errText}`);
    }
    const delay = [2000, 8000, 20000][attempt - 1] ?? 8000;
    console.warn(
      `[LLM] 上游 ${response.status}（第${attempt}/${maxAttempts}次）· ${delay}ms 后重试` +
        `: ${errText.slice(0, 160)}`
    );
    await new Promise((r) => setTimeout(r, delay));
  }

  if (options.stream && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullContent = '';
    let buffer = '';
    let finishReason: string | undefined;
    // 调试口（NOVEL_DEBUG_SSE=1）：抓原始 SSE 帧样本——定位「finish=length 但 0 字符」类问题
    const debugSse = process.env.NOVEL_DEBUG_SSE === '1';
    const rawSamples: string[] = [];

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
        if (debugSse && rawSamples.length < 8) rawSamples.push(dataStr.slice(0, 300));
        if (dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr);
          const chunk = parsed.choices?.[0]?.delta?.content || '';
          if (parsed.choices?.[0]?.finish_reason) {
            finishReason = parsed.choices[0].finish_reason;
          }
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
    if (debugSse) {
      console.log(
        `[SSE-DEBUG] model=${payload.model} finish=${finishReason} chars=${fullContent.length} 原始帧样本:\n` +
          rawSamples.map((s, i) => `  [${i}] ${s}`).join('\n')
      );
    }
    // 异常守卫：预算耗尽（length）却没有一个正文字符——典型于推理模型把
    // 输出预算全部花在思考上、或中转站上游异常路由。必须显式失败，
    // 让调用方走降级链（保守稿），绝不把「空成功」交给管线当正常稿。
    if (finishReason === 'length' && !fullContent.trim()) {
      console.error(
        `[LLM] 异常：finish=length 但正文 0 字符（model=${payload.model}）。` +
          '多为推理模型思考烧尽输出预算或中转异常；换非推理模型 / 调大 NOVEL_LLM_MAX_TOKENS 可解。' +
          (rawSamples.length
            ? `原始帧样本:\n${rawSamples.map((s, i) => `  [${i}] ${s}`).join('\n')}`
            : '')
      );
      throw new Error(
        '上游返回截断信号但正文为空（疑似推理模型思考烧尽输出预算，或中转站异常）——' +
          '请换非推理模型（如 glm-5 / kimi-k2.5），或调大 NOVEL_LLM_MAX_TOKENS 后重试。'
      );
    }
    if (finishReason === 'length') {
      console.warn(
        `[LLM] 输出被 max_tokens 截断（finish=length，产出 ${fullContent.length} 字符）。` +
          `若目标字数仍不足：换更长上限的模型，或设置环境变量 NOVEL_LLM_MAX_TOKENS 调大。`
      );
    }
    options.onFinish?.({ finishReason });
    return fullContent;
  } else {
    const data = (await response.json()) as any;
    const finishReason: string | undefined = data.choices?.[0]?.finish_reason;
    if (finishReason === 'length') {
      console.warn(`[LLM] 输出被 max_tokens 截断（finish=length）。`);
    }
    options.onFinish?.({ finishReason });
    return data.choices?.[0]?.message?.content || '';
  }
}
