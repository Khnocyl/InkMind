import { callLLMService, decryptKey, getStoredConfig } from './llmService';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  name: string;
  status: DoctorCheckStatus;
  message: string;
  detail?: string;
  durationMs?: number;
}

export interface DoctorReport {
  /** 关键检查无 fail */
  ok: boolean;
  overall: 'healthy' | 'degraded' | 'broken';
  checkedAt: string;
  configSummary: {
    provider: string;
    baseURL: string;
    modelName: string;
    temperature: number;
    hasKey: boolean;
    maskedKeyHint: string;
  };
  checks: DoctorCheck[];
  suggestions: string[];
}

function nowMs() {
  return Date.now();
}

function stripCodeFence(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('```')) {
    const lines = s.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1]?.startsWith('```')) lines.pop();
    s = lines.join('\n').trim();
  }
  return s;
}

function tryParseJsonObject(raw: string): { ok: boolean; value?: unknown; error?: string } {
  const s = stripCodeFence(raw);
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { ok: true, value: v };
    }
    return { ok: false, error: '解析成功但不是 JSON 对象' };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'JSON.parse 失败' };
  }
}

function humanizeApiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/未配置或无法解析/.test(msg)) {
    return '未配置或无法解密 API Key。请在「去 AI 味与后端配置」中粘贴真实密钥并保存。';
  }
  if (/401|Unauthorized|invalid.?api.?key|Incorrect API key/i.test(msg)) {
    return 'API Key 无效或已过期（401）。请重新填写密钥并保存。';
  }
  if (/403|permission|insufficient/i.test(msg)) {
    return '无权限调用该模型（403）。请检查账号额度/模型开通状态。';
  }
  if (/404|Not Found/i.test(msg)) {
    return '接口地址或模型名可能错误（404）。请检查 Base URL 是否带正确路径、Model Name 是否存在。';
  }
  if (/429|rate.?limit|Too Many/i.test(msg)) {
    return '触发限流（429）。请稍后重试或降低并发。';
  }
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(msg)) {
    return '无法连接模型服务。请检查 Base URL、本机网络或代理。';
  }
  if (/timeout|ETIMEDOUT/i.test(msg)) {
    return '请求超时。请检查网络或更换更近的中转节点。';
  }
  return msg.length > 280 ? `${msg.slice(0, 280)}…` : msg;
}

/**
 * 运行服务端 Doctor：配置完整性 + 文本连通 + JSON 结构化 + 流式输出。
 * 耗时约数秒，依赖外部 LLM。
 */
export async function runDoctor(options?: {
  /** 是否跑流式检测，默认 true */
  includeStream?: boolean;
  /** 是否跑 JSON 模式，默认 true */
  includeJson?: boolean;
}): Promise<DoctorReport> {
  const includeStream = options?.includeStream !== false;
  const includeJson = options?.includeJson !== false;
  const checks: DoctorCheck[] = [];
  const suggestions: string[] = [];

  const config = getStoredConfig();
  const hasEncrypted = !!(config.encryptedApiKey && config.encryptedApiKey.length > 0);
  let decrypted = '';
  try {
    decrypted = decryptKey(config.encryptedApiKey);
  } catch {
    decrypted = '';
  }
  const hasKey = hasEncrypted && decrypted.length > 0;

  const maskedKeyHint = hasKey
    ? `已配置（长度 ${decrypted.length}，脱敏展示 sk-****）`
    : hasEncrypted
      ? '有密文但无法解密（.secret 可能被替换）'
      : '未配置';

  // 1) 配置字段
  {
    const missing: string[] = [];
    if (!config.baseURL?.trim()) missing.push('Base URL');
    if (!config.modelName?.trim()) missing.push('Model Name');
    checks.push({
      id: 'config_fields',
      name: '配置字段完整性',
      status: missing.length ? 'fail' : 'pass',
      message: missing.length
        ? `缺少：${missing.join('、')}`
        : `Base URL / 模型 / Provider 已填写（${config.provider || 'custom'}）`,
      detail: `baseURL=${config.baseURL || '—'} · model=${config.modelName || '—'}`,
    });
    if (missing.length) {
      suggestions.push('请补全 Base URL 与 Model Name 后保存配置。');
    }
  }

  // 2) API Key
  {
    if (!hasEncrypted) {
      checks.push({
        id: 'api_key',
        name: 'API Key 配置',
        status: 'fail',
        message: '未保存 API Key',
        detail: '密钥经 AES 加密写入 server/data，前端只见脱敏占位。',
      });
      suggestions.push('在配置页粘贴真实 API Key（不要用 sk-**** 占位）并点击保存。');
    } else if (!decrypted) {
      checks.push({
        id: 'api_key',
        name: 'API Key 配置',
        status: 'fail',
        message: '密钥密文存在但解密失败',
        detail: '通常是 server/data/.secret 被删除或更换，导致旧密文无法解开。请重新输入 API Key 并保存。',
      });
      suggestions.push('删除无效密钥后重新输入 API Key 保存；勿单独替换 .secret 文件。');
    } else {
      checks.push({
        id: 'api_key',
        name: 'API Key 配置',
        status: 'pass',
        message: '密钥已配置且可解密',
        detail: maskedKeyHint,
      });
    }
  }

  // 3) Base URL 形态提示
  {
    const url = (config.baseURL || '').trim();
    let status: DoctorCheckStatus = 'pass';
    let message = 'Base URL 形态看起来可用';
    let detail = url;
    if (!url) {
      status = 'fail';
      message = 'Base URL 为空';
    } else if (!/^https?:\/\//i.test(url)) {
      status = 'warn';
      message = 'Base URL 建议以 http:// 或 https:// 开头';
      suggestions.push('Base URL 示例：https://api.deepseek.com 或 https://api.openai.com/v1');
    } else if (url.includes('localhost') || url.includes('127.0.0.1')) {
      status = 'warn';
      message = 'Base URL 指向本机，请确认本地推理服务已启动';
    }
    checks.push({
      id: 'base_url_shape',
      name: 'Base URL 形态',
      status,
      message,
      detail,
    });
  }

  // 关键检查已 fail 则跳过真实调用
  const blocked = checks.some((c) => c.status === 'fail' && (c.id === 'api_key' || c.id === 'config_fields'));

  // 4) 文本连通
  if (blocked) {
    checks.push({
      id: 'connectivity_text',
      name: '文本生成连通',
      status: 'skip',
      message: '因配置不完整已跳过真实调用',
    });
  } else {
    const t0 = nowMs();
    try {
      const content = await callLLMService({
        messages: [
          {
            role: 'user',
            content:
              '你是连通性测试。请只回复两个汉字：正常。不要标点、不要解释、不要其它文字。',
          },
        ],
        temperature: 0,
        stream: false,
      });
      const durationMs = nowMs() - t0;
      const text = (content || '').trim();
      if (!text) {
        checks.push({
          id: 'connectivity_text',
          name: '文本生成连通',
          status: 'fail',
          message: '接口返回空正文',
          detail: 'HTTP 成功但 choices 内容为空，常见于模型名错误或中转兼容问题。',
          durationMs,
        });
        suggestions.push('确认 Model Name 与服务商控制台一致；尝试 deepseek-chat / gpt-4o-mini。');
      } else {
        checks.push({
          id: 'connectivity_text',
          name: '文本生成连通',
          status: 'pass',
          message: `连通成功（${durationMs}ms）`,
          detail: `样例回复：${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`,
          durationMs,
        });
      }
    } catch (err) {
      const durationMs = nowMs() - t0;
      checks.push({
        id: 'connectivity_text',
        name: '文本生成连通',
        status: 'fail',
        message: humanizeApiError(err),
        detail: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      suggestions.push('优先检查 API Key、Base URL、Model Name 三者是否匹配同一服务商。');
    }
  }

  // 5) JSON 结构化（写作管线强依赖）
  if (!includeJson) {
    checks.push({
      id: 'json_mode',
      name: 'JSON 结构化输出',
      status: 'skip',
      message: '已按请求跳过',
    });
  } else if (blocked || checks.some((c) => c.id === 'connectivity_text' && c.status === 'fail')) {
    checks.push({
      id: 'json_mode',
      name: 'JSON 结构化输出',
      status: 'skip',
      message: '因上游失败/配置问题已跳过',
    });
  } else {
    const t0 = nowMs();
    try {
      const content = await callLLMService({
        messages: [
          {
            role: 'user',
            content:
              '请严格返回一个 JSON 对象，不要 Markdown 代码块，不要其它文字。格式：{"ok":true,"ping":"pong"}',
          },
        ],
        temperature: 0,
        stream: false,
        response_format: { type: 'json_object' },
      });
      const durationMs = nowMs() - t0;
      const parsed = tryParseJsonObject(content || '');
      if (parsed.ok) {
        checks.push({
          id: 'json_mode',
          name: 'JSON 结构化输出',
          status: 'pass',
          message: `JSON 可解析（${durationMs}ms）`,
          detail: stripCodeFence(content || '').slice(0, 120),
          durationMs,
        });
      } else {
        checks.push({
          id: 'json_mode',
          name: 'JSON 结构化输出',
          status: 'warn',
          message: `模型未返回合法 JSON：${parsed.error}`,
          detail: (content || '').slice(0, 200),
          durationMs,
        });
        suggestions.push(
          'JSON 不稳会导致分镜/审校失败。可换更强模型，或在中转侧开启 JSON mode。前端也会尝试剥 ``` 围栏。'
        );
      }
    } catch (err) {
      const durationMs = nowMs() - t0;
      checks.push({
        id: 'json_mode',
        name: 'JSON 结构化输出',
        status: 'warn',
        message: humanizeApiError(err),
        detail: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      suggestions.push('若仅 JSON 检测失败而文本连通正常，多半是 response_format 不被该服务商支持，可忽略 warn 或换模型。');
    }
  }

  // 6) 流式输出（正文执笔依赖）
  if (!includeStream) {
    checks.push({
      id: 'stream_mode',
      name: '流式输出 (SSE)',
      status: 'skip',
      message: '已按请求跳过',
    });
  } else if (blocked || checks.some((c) => c.id === 'connectivity_text' && c.status === 'fail')) {
    checks.push({
      id: 'stream_mode',
      name: '流式输出 (SSE)',
      status: 'skip',
      message: '因上游失败/配置问题已跳过',
    });
  } else {
    const t0 = nowMs();
    try {
      let chunks = 0;
      const content = await callLLMService({
        messages: [
          {
            role: 'user',
            content: '请用不超过15个汉字说一句：流式测试通过。不要解释。',
          },
        ],
        temperature: 0.2,
        stream: true,
        onChunk: () => {
          chunks += 1;
        },
      });
      const durationMs = nowMs() - t0;
      const text = (content || '').trim();
      if (!text) {
        checks.push({
          id: 'stream_mode',
          name: '流式输出 (SSE)',
          status: 'fail',
          message: '流式结束但正文为空',
          detail: `收到 ${chunks} 个 content 分片。部分中转流式 usage 正常却无 delta.content。`,
          durationMs,
        });
        suggestions.push('流式为空时正文无法边写边出。可换官方 API，或后续改为非流式执笔兜底。');
      } else {
        checks.push({
          id: 'stream_mode',
          name: '流式输出 (SSE)',
          status: 'pass',
          message: `流式正常（${chunks} 片 · ${durationMs}ms）`,
          detail: `样例：${text.slice(0, 80)}`,
          durationMs,
        });
      }
    } catch (err) {
      const durationMs = nowMs() - t0;
      checks.push({
        id: 'stream_mode',
        name: '流式输出 (SSE)',
        status: 'fail',
        message: humanizeApiError(err),
        detail: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      suggestions.push('流式失败时请确认中转支持 SSE chat/completions；或检查防火墙对长连接的限制。');
    }
  }

  const criticalIds = new Set(['config_fields', 'api_key', 'connectivity_text', 'stream_mode']);
  const hasCriticalFail = checks.some((c) => c.status === 'fail' && criticalIds.has(c.id));
  const hasAnyFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');

  let overall: DoctorReport['overall'] = 'healthy';
  if (hasCriticalFail || checks.some((c) => c.id === 'api_key' && c.status === 'fail')) {
    overall = 'broken';
  } else if (hasAnyFail || hasWarn) {
    overall = 'degraded';
  }

  // 去重建议
  const uniqSuggestions = [...new Set(suggestions)].slice(0, 8);

  if (overall === 'healthy' && uniqSuggestions.length === 0) {
    uniqSuggestions.push('配置健康，可以开始写章。建议写完重要章节后导出 JSON 备份。');
  }

  return {
    ok: !hasCriticalFail,
    overall,
    checkedAt: new Date().toISOString(),
    configSummary: {
      provider: config.provider || 'custom',
      baseURL: config.baseURL || '',
      modelName: config.modelName || '',
      temperature: config.temperature ?? 0.7,
      hasKey,
      maskedKeyHint,
    },
    checks,
    suggestions: uniqSuggestions,
  };
}
