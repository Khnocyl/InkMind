import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  buildSafeHeaders,
  checkBaseUrlSafety,
  isSameOriginClient,
  resolveRequestApiKey,
  sameBaseUrlOrigin,
} from '../server/llmSecurity';

const ORIGINAL_BLOCK_PRIVATE = process.env.BLOCK_PRIVATE_LLM_BASE;

afterEach(() => {
  if (ORIGINAL_BLOCK_PRIVATE === undefined) {
    delete process.env.BLOCK_PRIVATE_LLM_BASE;
  } else {
    process.env.BLOCK_PRIVATE_LLM_BASE = ORIGINAL_BLOCK_PRIVATE;
  }
});

describe('llmSecurity · checkBaseUrlSafety · scheme 校验', () => {
  it('拒绝 file:// 协议', () => {
    const r = checkBaseUrlSafety('file:///etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('http/https');
  });

  it('拒绝 ftp:// 协议', () => {
    const r = checkBaseUrlSafety('ftp://example.com/model');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('http/https');
  });

  it('拒绝空字符串', () => {
    expect(checkBaseUrlSafety('').ok).toBe(false);
    expect(checkBaseUrlSafety('   ').ok).toBe(false);
  });

  it('拒绝无法解析的 URL', () => {
    expect(checkBaseUrlSafety('not a url').ok).toBe(false);
  });

  it('放行常规 https 域名', () => {
    expect(checkBaseUrlSafety('https://api.deepseek.com').ok).toBe(true);
  });
});

describe('llmSecurity · checkBaseUrlSafety · 链路本地 / 云元数据（始终阻断）', () => {
  it('拒绝 IPv4 链路本地段 169.254.169.254（云元数据）', () => {
    const r = checkBaseUrlSafety('https://169.254.169.254');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('链路本地');
  });

  it('拒绝 IPv4 链路本地段其它地址（169.254.10.10）', () => {
    expect(checkBaseUrlSafety('http://169.254.10.10').ok).toBe(false);
  });

  it('拒绝 IPv6 链路本地段 fe80::1', () => {
    expect(checkBaseUrlSafety('http://[fe80::1]:11434').ok).toBe(false);
  });

  it('拒绝 IPv4 链路本地段的 IPv4-mapped IPv6 形态', () => {
    expect(checkBaseUrlSafety('http://[::ffff:169.254.169.254]').ok).toBe(false);
  });
});

describe('llmSecurity · checkBaseUrlSafety · 回环 / 私网段（默认放行，可收紧）', () => {
  it('默认放行 127.0.0.1:11434（本地 Ollama 场景）', () => {
    delete process.env.BLOCK_PRIVATE_LLM_BASE;
    expect(checkBaseUrlSafety('http://127.0.0.1:11434').ok).toBe(true);
  });

  it('默认放行 10/8、172.16/12、192.168/16、fc00::/7、::1', () => {
    delete process.env.BLOCK_PRIVATE_LLM_BASE;
    expect(checkBaseUrlSafety('http://10.0.0.5:11434').ok).toBe(true);
    expect(checkBaseUrlSafety('http://172.16.0.1:11434').ok).toBe(true);
    expect(checkBaseUrlSafety('http://192.168.1.5:11434').ok).toBe(true);
    expect(checkBaseUrlSafety('http://[fc00::1]:11434').ok).toBe(true);
    expect(checkBaseUrlSafety('http://[::1]:11434').ok).toBe(true);
  });

  it('BLOCK_PRIVATE_LLM_BASE=1 时拒绝 127.0.0.1', () => {
    process.env.BLOCK_PRIVATE_LLM_BASE = '1';
    const r = checkBaseUrlSafety('http://127.0.0.1:11434');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('BLOCK_PRIVATE_LLM_BASE');
  });

  it('BLOCK_PRIVATE_LLM_BASE=1 时拒绝私网 IPv4 与 IPv6 ULA', () => {
    process.env.BLOCK_PRIVATE_LLM_BASE = '1';
    expect(checkBaseUrlSafety('http://192.168.1.5:11434').ok).toBe(false);
    expect(checkBaseUrlSafety('http://[fc00::1]:11434').ok).toBe(false);
  });

  it('BLOCK_PRIVATE_LLM_BASE=1 不影响公网域名', () => {
    process.env.BLOCK_PRIVATE_LLM_BASE = '1';
    expect(checkBaseUrlSafety('https://api.deepseek.com').ok).toBe(true);
  });
});

describe('llmSecurity · sameBaseUrlOrigin', () => {
  it('相同 origin（忽略路径与尾斜杠）判等', () => {
    expect(sameBaseUrlOrigin('http://127.0.0.1:11434', 'http://127.0.0.1:11434/v1/models')).toBe(true);
    expect(sameBaseUrlOrigin('https://api.deepseek.com/', 'https://api.deepseek.com/v1')).toBe(true);
  });

  it('不同 host 或端口判不等', () => {
    expect(sameBaseUrlOrigin('http://127.0.0.1:11434', 'https://api.deepseek.com')).toBe(false);
    expect(sameBaseUrlOrigin('http://127.0.0.1:11434', 'http://127.0.0.1:11435')).toBe(false);
  });

  it('默认端口归一化', () => {
    expect(sameBaseUrlOrigin('http://example.com', 'http://example.com:80')).toBe(true);
    expect(sameBaseUrlOrigin('https://example.com', 'https://example.com:443')).toBe(true);
  });
});

describe('llmSecurity · resolveRequestApiKey · 密钥回退防外泄', () => {
  const stored = {
    storedBaseURL: 'https://api.deepseek.com',
    storedApiKey: 'stored-secret',
  };

  it('探测不同地址且无显式 key → 抛错，不回退已存密钥', () => {
    expect(() =>
      resolveRequestApiKey({
        requestedBaseURL: 'http://127.0.0.1:11434',
        requestedApiKey: undefined,
        ...stored,
      })
    ).toThrow(/探测新地址请先粘贴 API Key/);
  });

  it('sk-**** 掩码视为未传 → 探测不同地址时抛错', () => {
    expect(() =>
      resolveRequestApiKey({
        requestedBaseURL: 'http://127.0.0.1:11434',
        requestedApiKey: 'sk-****abcd',
        ...stored,
      })
    ).toThrow(/探测新地址请先粘贴 API Key/);
  });

  it('探测不同地址但显式传有效 key → 返回显式 key', () => {
    expect(
      resolveRequestApiKey({
        requestedBaseURL: 'http://127.0.0.1:11434',
        requestedApiKey: 'sk-explicit',
        ...stored,
      })
    ).toBe('sk-explicit');
  });

  it('未指定探测地址 → 允许回退已存密钥', () => {
    expect(
      resolveRequestApiKey({ requestedBaseURL: undefined, requestedApiKey: undefined, ...stored })
    ).toBe('stored-secret');
  });

  it('探测地址与已存 origin 一致 → 允许回退已存密钥', () => {
    expect(
      resolveRequestApiKey({
        requestedBaseURL: 'https://api.deepseek.com/v1/models',
        requestedApiKey: undefined,
        ...stored,
      })
    ).toBe('stored-secret');
  });
});

describe('llmSecurity · buildSafeHeaders · customHeaders 防覆盖', () => {
  it('过滤 Authorization / Host / Content-Length 等危险键（大小写不敏感）', () => {
    const headers = buildSafeHeaders(
      { Authorization: 'Bearer real', 'Content-Type': 'application/json' },
      {
        authorization: 'Bearer evil',
        hOsT: 'evil.example.com',
        'Content-Length': '9999',
        'X-Custom': 'keep-me',
        connection: 'keep-alive, evil',
      }
    );
    expect(headers.Authorization).toBe('Bearer real');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.authorization).toBeUndefined();
    expect(headers.hOsT).toBeUndefined();
    expect(headers.Host).toBeUndefined();
    expect(headers['Content-Length']).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers['X-Custom']).toBe('keep-me');
  });

  it('受保护头始终最后强制，无法被覆盖', () => {
    const headers = buildSafeHeaders(
      { Authorization: 'Bearer real' },
      { Authorization: 'Bearer evil' }
    );
    expect(headers.Authorization).toBe('Bearer real');
  });

  it('无 customHeaders 时正常返回受保护头', () => {
    const headers = buildSafeHeaders({ Authorization: 'Bearer real' });
    expect(headers).toEqual({ Authorization: 'Bearer real' });
  });
});

describe('llmSecurity · isSameOriginClient（P2-1 收紧）', () => {
  const loopbackOnly = (h: string) =>
    h === 'localhost' || h === '127.0.0.1' || h === '::1';

  it('same-origin + 回环 Host → 放行', () => {
    expect(
      isSameOriginClient({
        hostHeader: 'localhost:3001',
        secFetchSite: 'same-origin',
        isTrustedHostname: loopbackOnly,
      })
    ).toBe(true);
  });

  it('none（顶栏导航）→ 不再豁免，需 token', () => {
    expect(
      isSameOriginClient({
        hostHeader: 'localhost:3001',
        secFetchSite: 'none',
        isTrustedHostname: loopbackOnly,
      })
    ).toBe(false);
  });

  it('cross-site / same-site → 需 token', () => {
    for (const sfs of ['cross-site', 'same-site']) {
      expect(
        isSameOriginClient({
          hostHeader: 'localhost:3001',
          secFetchSite: sfs,
          isTrustedHostname: loopbackOnly,
        })
      ).toBe(false);
    }
  });

  it('无 metadata：Origin 回环 → 放行；无 Origin 的脚本调用仅回环 IP 放行', () => {
    expect(
      isSameOriginClient({
        hostHeader: '127.0.0.1:3001',
        origin: 'http://localhost:5173',
        isTrustedHostname: loopbackOnly,
      })
    ).toBe(true);
    // 本机 curl（回环 IP）→ 放行
    expect(
      isSameOriginClient({
        hostHeader: 'localhost:3001',
        isLoopbackClientIp: true,
        isTrustedHostname: loopbackOnly,
      })
    ).toBe(true);
  });

  it('LAN 部署：无 metadata 的局域网脚本调用不再豁免（token 必须生效）', () => {
    // Host 是可信 LAN 主机名，但客户端 IP 非回环 → 需 token
    const trustLan = (h: string) => loopbackOnly(h) || h === '192.168.1.5';
    expect(
      isSameOriginClient({
        hostHeader: '192.168.1.5:3001',
        isLoopbackClientIp: false,
        isTrustedHostname: trustLan,
      })
    ).toBe(false);
    // 未提供客户端 IP（未知来源）→ fail-closed，不豁免
    expect(
      isSameOriginClient({
        hostHeader: '192.168.1.5:3001',
        isTrustedHostname: trustLan,
      })
    ).toBe(false);
  });

  it('rebinding 域名的 Host → 一律拒绝（无论 metadata）', () => {
    expect(
      isSameOriginClient({
        hostHeader: 'evil.example.com',
        secFetchSite: 'same-origin',
        isTrustedHostname: loopbackOnly,
      })
    ).toBe(false);
    expect(
      isSameOriginClient({
        hostHeader: 'not a host',
        isTrustedHostname: loopbackOnly,
      })
    ).toBe(false);
  });
});

describe('llmSecurity · assertSafeUrl（P3-2 重定向复检）', () => {
  it('公网 https → 放行', () => {
    expect(() => assertSafeUrl('https://api.deepseek.com/v1/models')).not.toThrow();
  });

  it('链路本地 / 非法 scheme → 抛错', () => {
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data')).toThrow(
      /链路本地/
    );
    expect(() => assertSafeUrl('ftp://example.com/x')).toThrow(/http\/https/);
  });

  it('回环地址默认放行（本地 Ollama 场景）', () => {
    expect(() => assertSafeUrl('http://127.0.0.1:11434/v1/models')).not.toThrow();
  });
});
