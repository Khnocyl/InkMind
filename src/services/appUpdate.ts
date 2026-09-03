/**
 * 客户端版本检测与在线更新服务
 */

export const CURRENT_APP_VERSION = '1.0.0';
export const GITHUB_REPO = 'Khnocyl/InkMind';
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

export interface CheckUpdateResult {
  status: 'latest' | 'update-available' | 'error';
  currentVersion: string;
  latestVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  errorMsg?: string;
}

/**
 * 比较两个语义化版本号 (例如 "1.0.1" 与 "1.0.0")
 * 返回值:
 *  > 0 : v1 > v2 (有新版本)
 *  = 0 : v1 == v2
 *  < 0 : v1 < v2
 */
export function compareVersions(v1: string, v2: string): number {
  const normalize = (v: string) =>
    v.replace(/^v/i, '').trim().split('.').map((n) => parseInt(n, 10) || 0);

  const p1 = normalize(v1);
  const p2 = normalize(v2);
  const len = Math.max(p1.length, p2.length);

  for (let i = 0; i < len; i++) {
    const num1 = p1[i] ?? 0;
    const num2 = p2[i] ?? 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

/**
 * 检查 GitHub Releases 最新发布
 */
export async function checkForAppUpdates(
  current = CURRENT_APP_VERSION,
  fetchFn = fetch
): Promise<CheckUpdateResult> {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

  try {
    const res = await fetchFn(apiUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (res.status === 404) {
      // 仓库尚未发布任何 Release
      return {
        status: 'latest',
        currentVersion: current,
        latestVersion: current,
        releaseUrl: GITHUB_RELEASES_URL,
      };
    }

    if (!res.ok) {
      return {
        status: 'error',
        currentVersion: current,
        errorMsg: `请求失败 (HTTP ${res.status})`,
        releaseUrl: GITHUB_RELEASES_URL,
      };
    }

    const data = await res.json();
    const rawTag = (data.tag_name || '').trim();
    const cleanTag = rawTag.replace(/^v/i, '');

    if (!cleanTag) {
      return {
        status: 'latest',
        currentVersion: current,
        releaseUrl: GITHUB_RELEASES_URL,
      };
    }

    const isNewer = compareVersions(cleanTag, current) > 0;

    if (isNewer) {
      return {
        status: 'update-available',
        currentVersion: current,
        latestVersion: cleanTag,
        releaseName: data.name || `InkMind v${cleanTag}`,
        releaseNotes: data.body || '',
        releaseUrl: data.html_url || GITHUB_RELEASES_URL,
        publishedAt: data.published_at,
      };
    }

    return {
      status: 'latest',
      currentVersion: current,
      latestVersion: cleanTag,
      releaseUrl: data.html_url || GITHUB_RELEASES_URL,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      currentVersion: current,
      errorMsg: msg.includes('Failed to fetch') ? '网络无法连接到 GitHub' : msg,
      releaseUrl: GITHUB_RELEASES_URL,
    };
  }
}
