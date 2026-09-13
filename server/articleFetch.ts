/**
 * 文章抓取的逐跳重定向安全跟随（拆书 URL 导入专用）。
 *
 * 独立成模块的**唯一目的**是可测：此前这段循环内联在 server/index.ts 的路由里，
 * 而 server/index.ts 是启动脚本（会真的监听端口），无法单测 —— 于是安全最关键的
 * 那一层恰恰没有测试覆盖，并因此长期存在一个 DNS 绕过（见下）。
 *
 * 关键不变量：**每一跳都必须做「解析版」安全复检**（`checkArticleUrlSafetyResolved`），
 * 而不是同步字面量版。同步版对域名一律放行，于是
 *   「公网域名 → 302 到 http://internal.evil.example/ → 该域名解析到 127.0.0.1」
 * 这种 DNS 型绕过能穿透。重定向目标恰恰是攻击者可控的那一环，必须解析后复检。
 */
import { checkArticleUrlSafetyResolved, type HostResolver } from './llmSecurity';

export const ARTICLE_FETCH_MAX_REDIRECTS = 5;

export interface SafeRedirectOptions {
  maxRedirects?: number;
  signal?: AbortSignal;
  /** 测试注入：DNS 解析器 */
  resolve?: HostResolver;
  /** 测试注入：fetch 实现 */
  fetchImpl?: typeof fetch;
}

export type SafeRedirectResult =
  | { ok: true; url: string; response: Response }
  | { ok: false; error: string };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 从 startUrl 起跟随重定向，每一跳先做解析版安全复检，返回最终响应。
 * 校验失败 / 重定向过多 / 缺少 Location 一律返回 `{ ok: false }`（fail-closed）。
 */
export async function resolveSafeRedirects(
  startUrl: string,
  options: SafeRedirectOptions = {}
): Promise<SafeRedirectResult> {
  const maxRedirects = options.maxRedirects ?? ARTICLE_FETCH_MAX_REDIRECTS;
  const doFetch = options.fetchImpl ?? fetch;

  let current = startUrl;
  for (let hop = 0; ; hop += 1) {
    const safety = await checkArticleUrlSafetyResolved(current, options.resolve);
    if (!safety.ok) {
      return { ok: false, error: safety.reason || 'URL 未通过安全校验' };
    }

    let response: Response;
    try {
      response = await doFetch(current, {
        method: 'GET',
        redirect: 'manual', // 逐跳手动跟随：每一跳都过安全复检
        headers: {
          // 显式 UA：礼貌抓取，让目标站可识别与拒绝
          'User-Agent': 'InkMind-Deconstruct/1.0 (local novel study tool)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { ok: true, url: current, response };
    }

    const location = response.headers.get('location');
    if (!location) {
      return { ok: false, error: '上游返回重定向但缺少 Location' };
    }
    if (hop >= maxRedirects) {
      return { ok: false, error: '重定向次数过多' };
    }
    try {
      current = new URL(location, current).toString();
    } catch {
      return { ok: false, error: '重定向 Location 无法解析' };
    }
  }
}
