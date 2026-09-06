import net from 'node:net';

/**
 * 服务端请求安全（纯函数，无配置读写副作用，便于单测）。
 *
 * 覆盖三类风险：
 *  1. SSRF 收敛：LLM / Embedding Base URL 仅允许 http(s)；IP 字面量时阻断
 *     链路本地段（IPv4 169.254/16、IPv6 fe80::/10）与云元数据地址；回环与
 *     私网段默认放行（本工具常配本地 Ollama/LM Studio），可用
 *     BLOCK_PRIVATE_LLM_BASE=1 收紧为阻断。
 *  2. 密钥外泄封死：探测与已存 profile 不同的地址时，不回退已存解密密钥。
 *  3. customHeaders 防覆盖：Host / Content-Length / Authorization 等危险头
 *     不可被用户自定义头覆盖或注入（大小写不敏感）。
 */

/** 始终阻断：链路本地段与云元数据地址（169.254.169.254 落在 169.254/16 内）。 */
const alwaysBlockList = new net.BlockList();
alwaysBlockList.addSubnet('169.254.0.0', 16, 'ipv4');
alwaysBlockList.addSubnet('fe80::', 10, 'ipv6');

/** 回环 + 私网段：默认放行，BLOCK_PRIVATE_LLM_BASE=1 时收紧阻断。 */
const privateBlockList = new net.BlockList();
privateBlockList.addSubnet('127.0.0.0', 8, 'ipv4');
privateBlockList.addSubnet('10.0.0.0', 8, 'ipv4');
privateBlockList.addSubnet('172.16.0.0', 12, 'ipv4');
privateBlockList.addSubnet('192.168.0.0', 16, 'ipv4');
privateBlockList.addSubnet('fc00::', 7, 'ipv6');
privateBlockList.addSubnet('::1', 128, 'ipv6');

export interface BaseUrlCheckResult {
  ok: boolean;
  reason?: string;
}

function isBlockPrivateEnabled(): boolean {
  return process.env.BLOCK_PRIVATE_LLM_BASE === '1';
}

/** IPv6 中嵌 IPv4 的映射形态（::ffff:a.b.c.d），常见于 SSRF 绕过，需按 IPv4 网段判定。 */
function ipv4MappedAddress(hostname: string): string | null {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(hostname);
  return m ? m[1] : null;
}

/** 去掉 URL.hostname 对 IPv6 的方括号包裹，并统一小写。 */
function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/**
 * 校验 Base URL：
 * - 强制 http:/https: scheme；
 * - IP 字面量时按网段判定（链路本地/云元数据始终阻断，回环/私网默认放行）；
 * - 域名字面量无法静态解析，仅校验 scheme（上游 fetch 的 DNS 解析由系统完成）。
 */
export function checkBaseUrlSafety(baseURL: string): BaseUrlCheckResult {
  const trimmed = (baseURL || '').trim();
  if (!trimmed) {
    return { ok: false, reason: 'Base URL 为空' };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Base URL 无法解析' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Base URL 仅支持 http/https 协议' };
  }

  const hostname = normalizeHostname(url.hostname);
  const ipFamily = net.isIP(hostname);

  if (ipFamily === 4) {
    if (alwaysBlockList.check(hostname, 'ipv4')) {
      return { ok: false, reason: 'Base URL 指向链路本地或云元数据地址，已阻断' };
    }
    if (isBlockPrivateEnabled() && privateBlockList.check(hostname, 'ipv4')) {
      return { ok: false, reason: 'Base URL 指向回环/私网地址，已被 BLOCK_PRIVATE_LLM_BASE 阻断' };
    }
    return { ok: true };
  }

  if (ipFamily === 6) {
    const mapped = ipv4MappedAddress(hostname);
    if (mapped && net.isIP(mapped) === 4) {
      if (alwaysBlockList.check(mapped, 'ipv4')) {
        return { ok: false, reason: 'Base URL 指向链路本地或云元数据地址，已阻断' };
      }
      if (isBlockPrivateEnabled() && privateBlockList.check(mapped, 'ipv4')) {
        return { ok: false, reason: 'Base URL 指向回环/私网地址，已被 BLOCK_PRIVATE_LLM_BASE 阻断' };
      }
      return { ok: true };
    }
    if (alwaysBlockList.check(hostname, 'ipv6')) {
      return { ok: false, reason: 'Base URL 指向链路本地或云元数据地址，已阻断' };
    }
    if (isBlockPrivateEnabled() && privateBlockList.check(hostname, 'ipv6')) {
      return { ok: false, reason: 'Base URL 指向回环/私网地址，已被 BLOCK_PRIVATE_LLM_BASE 阻断' };
    }
    return { ok: true };
  }

  // 域名（localhost / api.deepseek.com 等）：静态无法解析到 IP，交由系统 DNS 决定。
  return { ok: true };
}

/** 校验并抛错（供保存配置 / 发起上游请求调用）。 */
export function assertSafeBaseUrl(baseURL: string): void {
  const r = checkBaseUrlSafety(baseURL);
  if (!r.ok) throw new Error(r.reason);
}

/**
 * 上游响应安全校验（安全审计 P3-2）：fetch 默认自动跟随重定向，
 * 最终 URL 可能偏离初始校验过的 baseURL（如公网地址 302 到链路本地）。
 * 响应使用前对最终 URL 复检；跨源重定向时 fetch 规范已剥离 Authorization，
 * 残余风险仅为盲请求，故校验失败直接抛错（调用方不得对其重试）。
 */
export function assertSafeUrl(url: string): void {
  const r = checkBaseUrlSafety(url);
  if (!r.ok) {
    throw new Error(`上游地址校验失败（${r.reason}）: ${url.slice(0, 120)}`);
  }
}

/**
 * 同源豁免判定（纯函数，安全审计 P2-1 收紧 + 深度审查 LAN 缺口修复）：
 * - Host 必须是可信主机名（回环或显式 TRUSTED_HOSTS）——防 DNS rebinding；
 * - Sec-Fetch-Site=same-origin → 同源浏览器请求，放行；
 * - `none`（顶栏导航）与 `cross-site/same-site` → 需 token：恶意页面可诱导
 *   用户把浏览器导航到本机 API（此时 metadata 为 none），不能免 token 豁免；
 * - 无 fetch-metadata 的旧浏览器/非浏览器调用：带 Origin 时校验 Origin 主机名；
 * - 两者皆无（curl 等脚本调用）→ 仅当客户端 IP 为回环时放行（本机进程本可读
 *   token 文件）。此前未校验来源 IP：LAN 部署（HOST=0.0.0.0 + TRUSTED_HOSTS）下
 *   局域网内任何脚本都命中此分支，token 形同虚设。
 */
export function isSameOriginClient(input: {
  hostHeader: string;
  secFetchSite?: string;
  origin?: string;
  /** 客户端 IP 是否回环：无 metadata/Origin 的脚本类调用仅回环来源才豁免 token */
  isLoopbackClientIp?: boolean;
  isTrustedHostname: (hostname: string) => boolean;
}): boolean {
  try {
    if (
      !input.isTrustedHostname(
        new URL(`http://${input.hostHeader || ''}`).hostname
      )
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const sfs = input.secFetchSite;
  if (typeof sfs === 'string' && sfs) {
    return sfs === 'same-origin';
  }
  if (typeof input.origin === 'string' && input.origin) {
    try {
      return input.isTrustedHostname(new URL(input.origin).hostname);
    } catch {
      return false;
    }
  }
  return input.isLoopbackClientIp === true;
}

function effectivePort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : '80';
}

/** 两个 Base URL 是否指向同一 origin（scheme + hostname + 端口，忽略路径/尾斜杠）。 */
export function sameBaseUrlOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a.trim());
    const ub = new URL(b.trim());
    return (
      ua.protocol === ub.protocol &&
      normalizeHostname(ua.hostname) === normalizeHostname(ub.hostname) &&
      effectivePort(ua) === effectivePort(ub)
    );
  } catch {
    return false;
  }
}

/**
 * 判定某次上游请求能否回退到「已保存的解密密钥」。
 *
 * 防密钥外泄：仅当请求的 baseURL（按 origin 规范化）与已存 profile 一致、或
 * 未显式指定探测地址时才允许回退；探测不同地址必须显式传有效 key
 * （sk-**** 掩码视为未传）。返回可用密钥，或抛错阻断。
 */
export function resolveRequestApiKey(input: {
  requestedBaseURL?: string;
  storedBaseURL: string;
  requestedApiKey?: string;
  storedApiKey: string;
}): string {
  const raw = (input.requestedApiKey || '').trim();
  const hasExplicitKey = raw !== '' && !raw.startsWith('sk-****');
  if (hasExplicitKey) return raw;

  const requested = (input.requestedBaseURL || '').trim();
  const stored = (input.storedBaseURL || '').trim();
  // 未显式指定探测地址 → 沿用已存配置（正常路径，允许回退）
  if (!requested) return input.storedApiKey;

  if (!sameBaseUrlOrigin(requested, stored)) {
    throw new Error('探测新地址请先粘贴 API Key（已保存密钥不会发往不同的服务地址）');
  }
  return input.storedApiKey;
}

/** 不可被 customHeaders 覆盖/注入的危险头（大小写不敏感）。 */
export const FORBIDDEN_CUSTOM_HEADERS = new Set([
  'host',
  'content-length',
  'authorization',
  'content-type',
  'connection',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'expect',
  'te',
  'trailer',
]);

/**
 * 构造上游请求头：先合并 customHeaders（过滤危险键），再把受保护头最后写入，
 * 确保 Authorization / Content-Type 等无法被覆盖。
 */
export function buildSafeHeaders(
  protectedHeaders: Record<string, string>,
  customHeaders?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(customHeaders || {})) {
    if (FORBIDDEN_CUSTOM_HEADERS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  for (const [key, value] of Object.entries(protectedHeaders)) {
    out[key] = value;
  }
  return out;
}
