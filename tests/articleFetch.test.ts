import { describe, expect, it, vi } from 'vitest';
import { resolveSafeRedirects } from '../server/articleFetch';

/**
 * 逐跳重定向安全跟随的测试。
 *
 * 为什么单独有这个文件：这段逻辑此前内联在 server/index.ts 的路由里（启动脚本，
 * 无法单测），于是**安全最关键的一层恰恰零覆盖**——并因此长期存在一个 DNS 绕过：
 * 逐跳复检用的是同步字面量版（对域名一律放行），导致
 * 「公网域名 → 302 到解析到内网的域名」能穿透。纯函数测试再全也拦不住它。
 */

/** 造一个只返回状态码/Location 的假响应 */
function redirectResponse(status: number, location?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'location' ? (location ?? null) : null),
    },
    text: async () => '',
    body: null,
  } as unknown as Response;
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () => '<html></html>',
    body: null,
  } as unknown as Response;
}

const publicDns = async () => ['93.184.216.34'];

describe('articleFetch · resolveSafeRedirects', () => {
  it('无重定向 → 直接返回最终响应', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const r = await resolveSafeRedirects('https://example.com/a', {
      resolve: publicDns,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://example.com/a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('重定向到公网域名 → 正常跟随', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(302, 'https://example.com/b'))
      .mockResolvedValueOnce(okResponse()) as unknown as typeof fetch;
    const r = await resolveSafeRedirects('https://example.com/a', {
      resolve: publicDns,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://example.com/b');
  });

  it('域名型重定向目标解析到云元数据 → 阻断（同步版曾完全漏检）', async () => {
    const fetchImpl = vi.fn(async () =>
      redirectResponse(302, 'http://metadata.google.internal/computeMetadata/v1/')
    ) as unknown as typeof fetch;
    const resolve = async (host: string) =>
      host === 'metadata.google.internal' ? ['169.254.169.254'] : ['93.184.216.34'];

    const r = await resolveSafeRedirects('https://example.com/a', { resolve, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/链路本地|元数据/);
    // 关键：被阻断后绝不能再发第二次请求
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('域名型重定向目标解析到回环 → 阻断', async () => {
    const fetchImpl = vi.fn(async () =>
      redirectResponse(302, 'http://internal.attacker.example/secret')
    ) as unknown as typeof fetch;
    const resolve = async (host: string) =>
      host === 'internal.attacker.example' ? ['127.0.0.1'] : ['93.184.216.34'];

    const r = await resolveSafeRedirects('https://example.com/a', { resolve, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/回环|私网/);
  });

  it('重定向到 IP 字面量的内网地址 → 阻断', async () => {
    const fetchImpl = vi.fn(async () =>
      redirectResponse(302, 'http://127.0.0.1:3001/api/backup')
    ) as unknown as typeof fetch;
    const r = await resolveSafeRedirects('https://example.com/a', {
      resolve: publicDns,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
  });

  it('多跳重定向中只有最后一跳危险 → 仍在那一跳阻断', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(302, 'https://example.com/b'))
      .mockResolvedValueOnce(redirectResponse(302, 'http://evil.example/c'))
      .mockResolvedValueOnce(okResponse()) as unknown as typeof fetch;
    const resolve = async (host: string) =>
      host === 'evil.example' ? ['10.0.0.5'] : ['93.184.216.34'];

    const r = await resolveSafeRedirects('https://example.com/a', { resolve, fetchImpl });
    expect(r.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 第三跳被拦下，未发出
  });

  it('超过最大跳数 → 阻断', async () => {
    const fetchImpl = vi.fn(async () =>
      redirectResponse(302, 'https://example.com/next')
    ) as unknown as typeof fetch;
    const r = await resolveSafeRedirects('https://example.com/a', {
      resolve: publicDns,
      fetchImpl,
      maxRedirects: 3,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/重定向次数过多/);
  });

  it('重定向缺少 Location → 阻断', async () => {
    const fetchImpl = vi.fn(async () =>
      redirectResponse(302)
    ) as unknown as typeof fetch;
    const r = await resolveSafeRedirects('https://example.com/a', {
      resolve: publicDns,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/缺少 Location/);
  });

  it('起始 URL 本身不安全 → 不发任何请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const r = await resolveSafeRedirects('http://169.254.169.254/latest/meta-data', {
      resolve: publicDns,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('相对 Location 按当前 URL 解析', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse(302, '/b/chapter'))
      .mockResolvedValueOnce(okResponse()) as unknown as typeof fetch;
    const r = await resolveSafeRedirects('https://example.com/a/start', {
      resolve: publicDns,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://example.com/b/chapter');
  });
});
