import net from 'node:net';
import { lookup } from 'node:dns/promises';

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
// 云元数据与保留段（不属链路本地但同样危险，此前全部漏网）：
// - 100.64/10（CGNAT 保留段）覆盖阿里云/腾讯云元数据 100.100.100.200；
// - fd00:ec2::254 为 AWS IMDSv6；
// - 0.0.0.0/8 与 :: 作为请求目标常被系统解析为「本机」，是经典 SSRF 绕过手法。
alwaysBlockList.addSubnet('100.64.0.0', 10, 'ipv4');
alwaysBlockList.addAddress('fd00:ec2::254', 'ipv6');
alwaysBlockList.addSubnet('0.0.0.0', 8, 'ipv4');
alwaysBlockList.addAddress('::', 'ipv6');

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

/** 主机名 → IP 列表（可注入，便于单测不触网） */
export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultHostResolver: HostResolver = async (hostname) => {
  const addrs = await lookup(hostname, { all: true, verbatim: true });
  return addrs.map((a) => a.address);
};

/** 对单个已解析 IP 做「始终阻断 / 可选私网阻断」判定 */
function checkResolvedAddress(address: string): BaseUrlCheckResult {
  const family = net.isIP(address);
  if (family === 4) {
    if (alwaysBlockList.check(address, 'ipv4')) {
      return { ok: false, reason: `Base URL 解析到链路本地/云元数据地址（${address}），已阻断` };
    }
    if (isBlockPrivateEnabled() && privateBlockList.check(address, 'ipv4')) {
      return { ok: false, reason: `Base URL 解析到回环/私网地址（${address}），已被 BLOCK_PRIVATE_LLM_BASE 阻断` };
    }
    return { ok: true };
  }
  if (family === 6) {
    const mapped = ipv4MappedAddress(address);
    if (mapped) return checkResolvedAddress(mapped);
    if (alwaysBlockList.check(address, 'ipv6')) {
      return { ok: false, reason: `Base URL 解析到链路本地地址（${address}），已阻断` };
    }
    if (isBlockPrivateEnabled() && privateBlockList.check(address, 'ipv6')) {
      return { ok: false, reason: `Base URL 解析到回环/私网地址（${address}），已被 BLOCK_PRIVATE_LLM_BASE 阻断` };
    }
  }
  return { ok: true };
}

/**
 * 域名解析后再校验（安全审计 H1）。
 *
 * 同步的 checkBaseUrlSafety 只能看 hostname 字符串：`metadata.google.internal`、
 * `localhost`、`*.nip.io`、DNS rebinding 域名都能绕过 IP 字面量黑名单。
 * 这里在真正发请求前解析域名，逐个 IP 套用同一套网段规则：
 * - 链路本地 / 云元数据（169.254/16、fe80::/10）**始终**阻断；
 * - 回环 / 私网仅在 BLOCK_PRIVATE_LLM_BASE=1 时阻断（默认放行本地 Ollama）。
 *
 * 残留风险：解析与连接之间仍存在 TOCTOU（要彻底消除需自定义 undici dispatcher
 * 固定拨号地址）。解析失败按 fail-closed 处理——随后本来也发不出去。
 */
export async function checkBaseUrlSafetyResolved(
  baseURL: string,
  resolve: HostResolver = defaultHostResolver
): Promise<BaseUrlCheckResult> {
  const sync = checkBaseUrlSafety(baseURL);
  if (!sync.ok) return sync;

  const hostname = normalizeHostname(new URL(baseURL.trim()).hostname);
  if (net.isIP(hostname)) return { ok: true }; // IP 字面量：同步检查已覆盖

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    // 配置了本机代理时出口 DNS 在代理侧，本地解析失败不代表不可达 → 放行
    // （代理是用户显式声明的信任边界；默认直连路径仍 fail-closed）
    if (process.env.INKMIND_PROXY) return { ok: true };
    return { ok: false, reason: `Base URL 主机名无法解析：${hostname}` };
  }
  if (!addresses.length) {
    return { ok: false, reason: `Base URL 主机名无法解析：${hostname}` };
  }
  for (const address of addresses) {
    const r = checkResolvedAddress(address);
    if (!r.ok) return r;
  }
  return { ok: true };
}

/** 解析后校验并抛错（发起上游请求前调用）。 */
export async function assertSafeBaseUrlResolved(
  baseURL: string,
  resolve?: HostResolver
): Promise<void> {
  const r = await checkBaseUrlSafetyResolved(baseURL, resolve);
  if (!r.ok) throw new Error(r.reason);
}

/**
 * 上游响应安全校验（安全审计 P3-2）：fetch 默认自动跟随重定向，
 * 最终 URL 可能偏离初始校验过的 baseURL（如公网地址 302 到链路本地）。
 * 响应使用前对最终 URL 复检；跨源重定向时 fetch 规范已剥离 Authorization，
 * 残余风险仅为盲请求，故校验失败直接抛错（调用方不得对其重试）。
 *
 * 必须用**解析版**（异步）而非同步字面量版：同步版对域名一律放行，
 * 于是「302 到 http://metadata.google.internal/」或「302 到 DNS 重新指向内网的
 * 攻击者域名」这类域名型重定向目标完全漏检——而重定向目标恰恰是攻击者可控的。
 */
export async function assertSafeUrl(url: string, resolve?: HostResolver): Promise<void> {
  const r = await checkBaseUrlSafetyResolved(url, resolve);
  if (!r.ok) {
    throw new Error(`上游地址校验失败（${r.reason}）: ${url.slice(0, 120)}`);
  }
}

/**
 * 同源豁免判定（纯函数，安全审计 P2-1 收紧 + 深度审查 LAN 缺口修复）：
 * - Host 必须是可信主机名（回环或显式 TRUSTED_HOSTS）——防 DNS rebinding；
 * - Sec-Fetch-Site=same-origin → 同源浏览器请求，放行；该头是浏览器强制注入的
 *   禁改头，网页场景不可伪造。非浏览器脚本可伪造任意头，但注意：LAN 部署
 *   （TRUSTED_HOSTS）本身就是「局域网访问者共享本机 API 权限」的信任域
 *   （SECURITY.md 已声明），脚本伪造并不越过该边界；默认仅回环绑定时，
 *   局域网攻击者无法建立连接。若请求携带 Origin，则额外要求 Origin 与
 *   可信 Host 同源——浏览器 same-origin POST 必然满足，伪造头但对不上
 *   Origin 的请求在此被拒；
 * - `none`（顶栏导航）与 `cross-site/same-site` → 需 token：恶意页面可诱导
 *   用户把浏览器导航到本机 API（此时 metadata 为 none），不能免 token 豁免；
 * - 无 fetch-metadata 的旧浏览器/非浏览器调用：带 Origin 时校验 Origin 主机名；
 * - 两者皆无（curl 等脚本调用）→ 仅当客户端 IP 为回环时放行（本机进程本可读
 *   token 文件）。
 */
export function isSameOriginClient(input: {
  hostHeader: string;
  secFetchSite?: string;
  origin?: string;
  /** 客户端 IP 是否回环：无 metadata/Origin 的脚本类调用仅回环来源才豁免 token */
  isLoopbackClientIp?: boolean;
  isTrustedHostname: (hostname: string) => boolean;
}): boolean {
  let hostUrl: URL;
  try {
    hostUrl = new URL(`http://${input.hostHeader || ''}`);
    if (!input.isTrustedHostname(normalizeHostname(hostUrl.hostname))) {
      return false;
    }
  } catch {
    return false;
  }
  const sfs = input.secFetchSite;
  if (typeof sfs === 'string' && sfs) {
    if (sfs !== 'same-origin') return false;
    if (typeof input.origin === 'string' && input.origin) {
      try {
        const originUrl = new URL(input.origin);
        return (
          input.isTrustedHostname(normalizeHostname(originUrl.hostname)) &&
          effectivePort(originUrl) === effectivePort(hostUrl)
        );
      } catch {
        return false;
      }
    }
    return true;
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

/**
 * Embedding 解析密钥（安全审计：密钥不回退异源）。
 *
 * 独立 embedding 地址且未配置专属 key 时，历史上会回退到已存的 LLM 密钥——
 * 于是把 embedding baseURL 指向任意第三方主机就能让 DeepSeek/OpenAI 的密钥
 * 被当作 Bearer 发出去。现在只有「embedding 地址与 LLM 地址同源」才允许回退
 * （embBaseURL 留空 → 实际用 LLM 地址，属同源，行为不变）。
 */
export function resolveEmbeddingKeyFallback(input: {
  embKey: string;
  embBaseURL: string;
  llmKey: string;
  llmBaseURL: string;
}): string {
  if (input.embKey) return input.embKey;
  // 未指定独立 embedding 地址 = 实际沿用 LLM 地址（调用方已做替换）→ 允许回退
  if (!input.embBaseURL.trim()) return input.llmKey;
  return sameBaseUrlOrigin(input.embBaseURL, input.llmBaseURL) ? input.llmKey : '';
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

/**
 * 拆书 URL 导入的**收紧版**地址校验（与 LLM Base URL 的区别）：
 * LLM 地址默认放行回环/私网（本机 Ollama 场景），而文章抓取面向公网网页，
 * 私网/回环默认一律阻断——防止恶意页面诱导本地服务抓取内网资源（SSRF）。
 * 链路本地/云元数据始终阻断；`ARTICLE_FETCH_ALLOW_PRIVATE=1` 可显式放开
 * （仅供对本地静态服务做联调测试）。
 */
export function checkArticleUrlSafety(
  url: string,
  options?: { allowPrivate?: boolean }
): BaseUrlCheckResult {
  const trimmed = (url || '').trim();
  if (!trimmed) return { ok: false, reason: 'URL 为空' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'URL 无法解析' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'URL 仅支持 http/https 协议' };
  }
  const allowPrivate =
    options?.allowPrivate ?? process.env.ARTICLE_FETCH_ALLOW_PRIVATE === '1';
  const hostname = normalizeHostname(parsed.hostname);
  const ipFamily = net.isIP(hostname);
  const judge = (ip: string): BaseUrlCheckResult | null => {
    if (alwaysBlockList.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4')) {
      return { ok: false, reason: `URL 指向链路本地或云元数据地址（${ip}），已阻断` };
    }
    if (!allowPrivate && privateBlockList.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4')) {
      return { ok: false, reason: `URL 指向回环/私网地址（${ip}），已阻断（防 SSRF；联调可设 ARTICLE_FETCH_ALLOW_PRIVATE=1）` };
    }
    return null;
  };
  if (ipFamily === 4) return judge(hostname) ?? { ok: true };
  if (ipFamily === 6) {
    const mapped = ipv4MappedAddress(hostname);
    if (mapped) return judge(mapped) ?? { ok: true };
    return judge(hostname) ?? { ok: true };
  }
  // 域名：同步检查只看字面量，解析后复检交给 checkArticleUrlSafetyResolved
  return { ok: true };
}

/** 域名解析后对每个 IP 复检（文章抓取版，私网默认阻断）。 */
export async function checkArticleUrlSafetyResolved(
  url: string,
  resolve: HostResolver = defaultHostResolver,
  options?: { allowPrivate?: boolean }
): Promise<BaseUrlCheckResult> {
  const sync = checkArticleUrlSafety(url, options);
  if (!sync.ok) return sync;
  const hostname = normalizeHostname(new URL(url.trim()).hostname);
  if (net.isIP(hostname)) return { ok: true };
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    if (process.env.INKMIND_PROXY) return { ok: true };
    return { ok: false, reason: `URL 主机名无法解析：${hostname}` };
  }
  if (!addresses.length) {
    return { ok: false, reason: `URL 主机名无法解析：${hostname}` };
  }
  for (const address of addresses) {
    const r = checkArticleUrlSafety(
      `http://${net.isIP(address) === 6 ? `[${address}]` : address}`,
      options
    );
    if (!r.ok) return r;
  }
  return { ok: true };
}
