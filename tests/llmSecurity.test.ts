import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  buildSafeHeaders,
  checkArticleUrlSafety,
  checkArticleUrlSafetyResolved,
  checkBaseUrlSafety,
  checkBaseUrlSafetyResolved,
  isSameOriginClient,
  resolveEmbeddingKeyFallback,
  resolveRequestApiKey,
  sameBaseUrlOrigin,
} from '../server/llmSecurity';

const ORIGINAL_BLOCK_PRIVATE = process.env.BLOCK_PRIVATE_LLM_BASE;
const ORIGINAL_PROXY = process.env.INKMIND_PROXY;

afterEach(() => {
  if (ORIGINAL_BLOCK_PRIVATE === undefined) {
    delete process.env.BLOCK_PRIVATE_LLM_BASE;
  } else {
    process.env.BLOCK_PRIVATE_LLM_BASE = ORIGINAL_BLOCK_PRIVATE;
  }
  if (ORIGINAL_PROXY === undefined) {
    delete process.env.INKMIND_PROXY;
  } else {
    process.env.INKMIND_PROXY = ORIGINAL_PROXY;
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

  it('拒绝云厂商元数据的 CGNAT 地址 100.100.100.200（阿里云/腾讯云）', () => {
    // 100.64/10 不属链路本地，此前漏网——即使 BLOCK_PRIVATE_LLM_BASE=1 也不阻断
    expect(checkBaseUrlSafety('http://100.100.100.200').ok).toBe(false);
  });

  it('拒绝 AWS IMDSv6 地址 fd00:ec2::254', () => {
    expect(checkBaseUrlSafety('http://[fd00:ec2::254]').ok).toBe(false);
  });

  it('拒绝「本机」语义的保留地址 0.0.0.0 与 ::', () => {
    expect(checkBaseUrlSafety('http://0.0.0.0').ok).toBe(false);
    expect(checkBaseUrlSafety('http://[::]').ok).toBe(false);
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

  it('same-origin 携带 Origin：与 Host 同源 → 放行；Origin 对不上 → 拒绝', () => {
    expect(
      isSameOriginClient({
        hostHeader: 'localhost:3001',
        secFetchSite: 'same-origin',
        origin: 'http://localhost:3001',
        isTrustedHostname: loopbackOnly,
      })
    ).toBe(true);
    // 伪造 sfs 头但 Origin 指向别处 → 拒绝
    expect(
      isSameOriginClient({
        hostHeader: 'localhost:3001',
        secFetchSite: 'same-origin',
        origin: 'http://evil.example.com',
        isTrustedHostname: loopbackOnly,
      })
    ).toBe(false);
    // Origin 端口与 Host 不一致 → 拒绝
    expect(
      isSameOriginClient({
        hostHeader: 'localhost:3001',
        secFetchSite: 'same-origin',
        origin: 'http://localhost:9999',
        isTrustedHostname: loopbackOnly,
      })
    ).toBe(false);
  });

  it('LAN 部署：same-origin 浏览器请求（Origin 与可信 Host 同源）仍放行', () => {
    const trustLan = (h: string) => loopbackOnly(h) || h === 'myhost';
    expect(
      isSameOriginClient({
        hostHeader: 'myhost:3001',
        secFetchSite: 'same-origin',
        origin: 'http://myhost:3001',
        isTrustedHostname: trustLan,
      })
    ).toBe(true);
    expect(
      isSameOriginClient({
        hostHeader: 'myhost:3001',
        secFetchSite: 'same-origin',
        origin: 'http://other-lan-host:3001',
        isTrustedHostname: trustLan,
      })
    ).toBe(false);
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
  const publicDns = async () => ['93.184.216.34'];

  it('公网 https → 放行', async () => {
    await expect(
      assertSafeUrl('https://api.deepseek.com/v1/models', publicDns)
    ).resolves.toBeUndefined();
  });

  it('链路本地 / 非法 scheme → 抛错', async () => {
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /链路本地/
    );
    await expect(assertSafeUrl('ftp://example.com/x')).rejects.toThrow(/http\/https/);
  });

  it('回环地址默认放行（本地 Ollama 场景）', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:11434/v1/models')).resolves.toBeUndefined();
  });

  it('域名型重定向目标解析到元数据地址 → 阻断（同步版曾完全漏检）', async () => {
    // 攻击者把 baseURL 302 到 http://metadata.google.internal/ 这类域名：
    // 同步字面量校验对域名一律放行，必须靠解析后校验拦住
    await expect(
      assertSafeUrl('https://metadata.google.internal/computeMetadata/v1', async () => [
        '169.254.169.254',
      ])
    ).rejects.toThrow(/链路本地|元数据/);
  });

  it('域名型重定向目标解析失败 → fail-closed 阻断', async () => {
    // 开发机常已配置 INKMIND_PROXY（代理侧 DNS 解析失败会放行），
    // 本用例测的是默认直连路径，需显式清掉才成立
    delete process.env.INKMIND_PROXY;
    await expect(
      assertSafeUrl('https://evil.example/x', async () => {
        throw new Error('ENOTFOUND');
      })
    ).rejects.toThrow(/无法解析/);
  });
});

describe('llmSecurity · checkBaseUrlSafetyResolved（域名解析后校验）', () => {
  it('域名解析到云元数据/链路本地地址 → 阻断（同步检查拦不住的形态）', async () => {
    const r = await checkBaseUrlSafetyResolved('https://metadata.example.com/v1', async () => [
      '169.254.169.254',
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('链路本地');
  });

  it('IPv6 映射形态的解析结果同样阻断', async () => {
    const r = await checkBaseUrlSafetyResolved('https://evil.example.com/v1', async () => [
      '::ffff:169.254.169.254',
    ]);
    expect(r.ok).toBe(false);
  });

  it('解析到公网地址 → 放行', async () => {
    const r = await checkBaseUrlSafetyResolved('https://api.deepseek.com', async () => [
      '203.0.113.10',
    ]);
    expect(r.ok).toBe(true);
  });

  it('解析到回环：默认放行（本地 Ollama），BLOCK_PRIVATE_LLM_BASE=1 时阻断', async () => {
    const resolve = async () => ['127.0.0.1'];
    expect((await checkBaseUrlSafetyResolved('http://localhost:11434/v1', resolve)).ok).toBe(
      true
    );
    process.env.BLOCK_PRIVATE_LLM_BASE = '1';
    const blocked = await checkBaseUrlSafetyResolved('http://localhost:11434/v1', resolve);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain('BLOCK_PRIVATE_LLM_BASE');
  });

  it('解析失败 → fail-closed（不放过未知主机）', async () => {
    delete process.env.INKMIND_PROXY; // 开发机常已配置本机代理，需显式清掉才是直连路径
    const r = await checkBaseUrlSafetyResolved('https://nope.invalid/v1', async () => {
      throw new Error('ENOTFOUND');
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('无法解析');
  });

  it('配置了本机代理时解析失败放行（出口 DNS 在代理侧）', async () => {
    process.env.INKMIND_PROXY = 'http://127.0.0.1:7890';
    const r = await checkBaseUrlSafetyResolved('https://proxy-only.example.com/v1', async () => {
      throw new Error('ENOTFOUND');
    });
    expect(r.ok).toBe(true);
  });

  it('IP 字面量不触发 DNS 解析（同步检查已覆盖）', async () => {
    let called = 0;
    const r = await checkBaseUrlSafetyResolved('https://169.254.169.254/latest', async () => {
      called += 1;
      return [];
    });
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });
});

describe('llmSecurity · resolveEmbeddingKeyFallback（密钥不回退异源）', () => {
  const LLM_KEY = 'sk-llm-secret';
  const LLM_URL = 'https://api.deepseek.com/v1';

  it('embedding 有自己的 key → 用自己的', () => {
    expect(
      resolveEmbeddingKeyFallback({
        embKey: 'sk-emb',
        embBaseURL: 'https://free-embeddings.example.com/v1',
        llmKey: LLM_KEY,
        llmBaseURL: LLM_URL,
      })
    ).toBe('sk-emb');
  });

  it('异源地址且无专属 key → 不回退 LLM 密钥（防止密钥外泄）', () => {
    expect(
      resolveEmbeddingKeyFallback({
        embKey: '',
        embBaseURL: 'https://free-embeddings.example.com/v1',
        llmKey: LLM_KEY,
        llmBaseURL: LLM_URL,
      })
    ).toBe('');
  });

  it('同源（含路径差异）→ 允许回退', () => {
    expect(
      resolveEmbeddingKeyFallback({
        embKey: '',
        embBaseURL: 'https://api.deepseek.com',
        llmKey: LLM_KEY,
        llmBaseURL: LLM_URL,
      })
    ).toBe(LLM_KEY);
  });

  it('embBaseURL 留空（实际沿用 LLM 地址）→ 允许回退', () => {
    expect(
      resolveEmbeddingKeyFallback({
        embKey: '',
        embBaseURL: '',
        llmKey: LLM_KEY,
        llmBaseURL: LLM_URL,
      })
    ).toBe(LLM_KEY);
  });
});

describe('llmSecurity · checkArticleUrlSafety（拆书 URL 导入 · 收紧版）', () => {
  it('公网 https URL 放行', () => {
    expect(checkArticleUrlSafety('https://example.com/chapter/1').ok).toBe(true);
  });

  it('非 http(s) 协议拒绝', () => {
    expect(checkArticleUrlSafety('ftp://example.com/a').ok).toBe(false);
    expect(checkArticleUrlSafety('file:///etc/passwd').ok).toBe(false);
  });

  it('回环/私网默认阻断（与 LLM Base URL 的默认放行不同——防 SSRF）', () => {
    expect(checkArticleUrlSafety('http://127.0.0.1:8080/x').ok).toBe(false);
    expect(checkArticleUrlSafety('http://192.168.1.1/x').ok).toBe(false);
    expect(checkArticleUrlSafety('http://10.0.0.5/x').ok).toBe(false);
  });

  it('显式 allowPrivate 时放行本地联调地址', () => {
    expect(
      checkArticleUrlSafety('http://127.0.0.1:8080/x', { allowPrivate: true }).ok
    ).toBe(true);
  });

  it('链路本地/云元数据始终阻断（allowPrivate 也救不了）', () => {
    expect(
      checkArticleUrlSafety('http://169.254.169.254/latest/meta-data', { allowPrivate: true }).ok
    ).toBe(false);
    expect(
      checkArticleUrlSafety('http://[::ffff:169.254.169.254]/x', { allowPrivate: true }).ok
    ).toBe(false);
  });

  it('解析后复检：域名解析到私网 IP → 阻断（直连路径）', async () => {
    delete process.env.INKMIND_PROXY;
    const r = await checkArticleUrlSafetyResolved('https://evil.example/x', async () => [
      '10.0.0.9',
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('私网');
  });

  it('解析后复检：公网地址放行', async () => {
    delete process.env.INKMIND_PROXY;
    const r = await checkArticleUrlSafetyResolved('https://good.example/x', async () => [
      '93.184.216.34',
    ]);
    expect(r.ok).toBe(true);
  });

  it('解析失败 → fail-closed（未配置代理时）', async () => {
    delete process.env.INKMIND_PROXY;
    const r = await checkArticleUrlSafetyResolved('https://dead.example/x', async () => {
      throw new Error('ENOTFOUND');
    });
    expect(r.ok).toBe(false);
  });
});
