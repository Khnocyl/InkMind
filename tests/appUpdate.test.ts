import { describe, it, expect, vi } from 'vitest';
import { compareVersions, checkForAppUpdates } from '../src/services/appUpdate';

describe('appUpdate · 语义化版本比对与在线更新', () => {
  it('compareVersions 正确对比版本大小', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('v1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(0);
  });

  it('404 响应视为当前已是最新（尚无 Releases）', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    });
    const result = await checkForAppUpdates('1.0.0', mockFetch as any);
    expect(result.status).toBe('latest');
    expect(result.currentVersion).toBe('1.0.0');
  });

  it('线上有更高版本时返回 update-available', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        tag_name: 'v1.1.0',
        name: 'InkMind v1.1.0 重大更新',
        body: '- 新增功能\n- 修复bug',
        html_url: 'https://github.com/Khnocyl/InkMind/releases/tag/v1.1.0',
        published_at: '2026-09-10T00:00:00Z',
      }),
    });
    const result = await checkForAppUpdates('1.0.0', mockFetch as any);
    expect(result.status).toBe('update-available');
    expect(result.latestVersion).toBe('1.1.0');
    expect(result.releaseName).toBe('InkMind v1.1.0 重大更新');
  });

  it('线上版本等于或低于当前版本时返回 latest', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        tag_name: 'v1.0.0',
        html_url: 'https://github.com/Khnocyl/InkMind/releases/tag/v1.0.0',
      }),
    });
    const result = await checkForAppUpdates('1.0.0', mockFetch as any);
    expect(result.status).toBe('latest');
  });

  it('网络异常捕获并返回 error 状态', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const result = await checkForAppUpdates('1.0.0', mockFetch as any);
    expect(result.status).toBe('error');
    expect(result.errorMsg).toContain('网络无法连接');
  });
});
