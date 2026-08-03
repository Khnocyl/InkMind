/** 与 server/doctor.ts 对齐的前端类型与调用 */

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

export interface DoctorClientResult {
  /** 后端是否可达 */
  backendReachable: boolean;
  report: DoctorReport | null;
  /** 客户端侧错误（如后端未启动） */
  clientError?: string;
}

function backendDownReport(message: string): DoctorReport {
  return {
    ok: false,
    overall: 'broken',
    checkedAt: new Date().toISOString(),
    configSummary: {
      provider: '—',
      baseURL: '—',
      modelName: '—',
      temperature: 0,
      hasKey: false,
      maskedKeyHint: '未知',
    },
    checks: [
      {
        id: 'backend_reachable',
        name: '本地后端可达',
        status: 'fail',
        message,
        detail:
          '请在项目根目录运行 npm run dev（会同时启动 Vite 与 server/index.ts）。默认后端端口 3001，Vite 将 /api 代理过去。',
      },
    ],
    suggestions: [
      '确认已执行 npm run dev 或 npm run server。',
      '若改过端口，请同步 vite.config.ts 里 proxy target 与 PORT。',
      '浏览器直接访问 http://localhost:3001/api/health 应返回 ok。',
    ],
  };
}

/**
 * 先探活 /api/health，再跑完整 Doctor。
 * 未启动后端时给出明确中文指引，而不是模糊 Network Error。
 */
export async function runDoctorClient(options?: {
  includeStream?: boolean;
  includeJson?: boolean;
}): Promise<DoctorClientResult> {
  // 1) 后端探活
  try {
    const health = await fetch('/api/health');
    if (!health.ok) {
      const report = backendDownReport(`后端健康检查失败 HTTP ${health.status}`);
      return { backendReachable: false, report, clientError: report.checks[0].message };
    }
  } catch (e: unknown) {
    const msg =
      e instanceof Error
        ? `无法连接本地后端：${e.message}`
        : '无法连接本地后端（Network Error）';
    const report = backendDownReport(msg);
    return { backendReachable: false, report, clientError: msg };
  }

  // 2) 完整诊断
  try {
    const res = await fetch('/api/doctor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        includeStream: options?.includeStream !== false,
        includeJson: options?.includeJson !== false,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      let errorMsg = `Doctor 接口错误 [${res.status}]`;
      try {
        const j = JSON.parse(errText);
        if (j.error) errorMsg = j.error;
      } catch {
        if (errText) errorMsg = `${errorMsg}: ${errText.slice(0, 200)}`;
      }
      return {
        backendReachable: true,
        report: {
          ok: false,
          overall: 'broken',
          checkedAt: new Date().toISOString(),
          configSummary: {
            provider: '—',
            baseURL: '—',
            modelName: '—',
            temperature: 0,
            hasKey: false,
            maskedKeyHint: '—',
          },
          checks: [
            {
              id: 'doctor_endpoint',
              name: 'Doctor 接口',
              status: 'fail',
              message: errorMsg,
            },
          ],
          suggestions: ['查看终端里 server 报错日志。'],
        },
        clientError: errorMsg,
      };
    }

    const data = await res.json();
    if (!data.success || !data.data) {
      throw new Error(data.error || 'Doctor 返回异常');
    }

    const report = data.data as DoctorReport;
    // 前端补一条后端可达
    report.checks = [
      {
        id: 'backend_reachable',
        name: '本地后端可达',
        status: 'pass',
        message: 'Vite 代理 → 后端 /api 正常',
      },
      ...report.checks,
    ];

    return { backendReachable: true, report };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      backendReachable: true,
      report: backendDownReport(msg),
      clientError: msg,
    };
  }
}

export function overallLabel(overall: DoctorReport['overall']): string {
  switch (overall) {
    case 'healthy':
      return '健康 · 可以写章';
    case 'degraded':
      return '降级 · 部分能力异常';
    case 'broken':
      return '不可用 · 请先修复';
    default:
      return overall;
  }
}
