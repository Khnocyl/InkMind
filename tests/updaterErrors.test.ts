import { describe, it, expect } from 'vitest';
import { semverCompare, shortUpdaterError } from '../electron/updaterErrors.cjs';

/** 线上 v1.0.1 Release 缺 latest.yml 时 electron-updater 抛出的真实报错（含 headers 全文） */
const REAL_404_MESSAGE =
  'Cannot find latest.yml in the latest release artifacts ' +
  '(https://github.com/Khnocyl/InkMind/releases/download/v1.0.1/latest.yml): HttpError: 404 \n' +
  '"method: GET url: https://github.com/Khnocyl/InkMind/releases/download/v1.0.1/latest.yml\\n\\n' +
  'Please double check that your authentication token is correct. Due to security reasons, ' +
  'actual status maybe not reported, but 404.\\n"\n' +
  'Headers: {\n  "cache-control": "no-cache",\n  "content-encoding": "gzip",\n  "date": "Sun, 06 Sep 2026 15:38:35 GMT"\n}';

describe('updaterErrors · electron-updater 报错分类', () => {
  it('缺 latest.yml 的 404 识别为 feed-missing，并从 URL 解析出版本号', () => {
    const s = shortUpdaterError(new Error(REAL_404_MESSAGE));
    expect(s.kind).toBe('feed-missing');
    expect(s.tag).toBe('1.0.1');
    expect(s.text).not.toContain('Headers');
    expect(s.text.length).toBeLessThan(120);
  });

  it('网络类报错压成一句短提示，不透出原始信息', () => {
    const err = new Error(
      'net::ERR_CONNECTION_RESET at https://api.github.com/repos/Khnocyl/InkMind/releases\nHeaders: { "x": 1 }'
    );
    const s = shortUpdaterError(err);
    expect(s.kind).toBe('error');
    expect(s.text).toBe('网络无法连接到 GitHub 更新源，请检查网络或代理后重试。');
  });

  it('速率限制报错给出对应提示', () => {
    const s = shortUpdaterError(new Error('HttpError: 403 rate limit exceeded for api.github.com'));
    expect(s.kind).toBe('error');
    expect(s.text).toContain('请求受限');
  });

  it('其他多行报错只保留首行并截断到 160 字符内', () => {
    const raw = `Some weird failure\nline2\n${'x'.repeat(400)}`;
    const s = shortUpdaterError(new Error(raw));
    expect(s.text).toBe('Some weird failure');
  });

  it('兜底文案抹掉 URL 等内部细节', () => {
    const raw = 'Unexpected redirect to https://internal.example.com/secret?token=abc123 while updating';
    const s = shortUpdaterError(new Error(raw));
    expect(s.kind).toBe('error');
    expect(s.text).not.toContain('internal.example.com');
    expect(s.text).not.toContain('token');
    expect(s.text).toContain('链接已省略');
  });

  it('semverCompare 支持带 v 前缀与多段版本号', () => {
    expect(semverCompare('1.0.1', '1.0.1')).toBe(0);
    expect(semverCompare('v1.0.1', '1.0.1')).toBe(0);
    expect(semverCompare('1.0.2', '1.0.1')).toBeGreaterThan(0);
    expect(semverCompare('1.0.1', '1.2.0')).toBeLessThan(0);
  });
});
