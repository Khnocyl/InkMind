/**
 * 作品磁盘备份（server/backupService）—— 真实文件系统。
 *
 * 这是 IndexedDB 之外的**最后一道恢复手段**，所以重点验三类：
 *  1. 输入白名单（projectId 防路径穿越）；
 *  2. 修剪只影响本项目、且保留份数正确；
 *  3. 原子写入：不留 .tmp 残骸，且 .tmp 不会被当成有效备份列出/计数。
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'inkmind-backup-test-'));
const BACKUP_DIR = path.join(TMP_ROOT, '.novel-data', 'backups');

/** BACKUP_DIR 在模块加载时就算好了，必须先设 env 再 resetModules + 动态导入 */
async function loadService() {
  process.env.NOVEL_APP_ROOT = TMP_ROOT;
  vi.resetModules();
  return await import('../server/backupService');
}

function backupFiles(): string[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).sort();
}

afterAll(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  delete process.env.NOVEL_APP_ROOT;
});

describe('backupService · writeProjectBackup', () => {
  it('写入成功并返回文件信息，且目录里不残留 .tmp', async () => {
    const svc = await loadService();
    const r = svc.writeProjectBackup({
      projectId: 'p1',
      title: '书',
      payload: { id: 'p1', title: '书', chapters: [] },
    });
    expect(r.file).toMatch(/^p1-\d{8}-\d{6}(-\d+)?\.novel\.json$/);
    expect(r.size).toBeGreaterThan(0);
    expect(r.kept).toBe(1);
    expect(r.pruned).toBe(0);
    expect(fs.existsSync(path.join(BACKUP_DIR, r.file))).toBe(true);
    // 原子写入：临时文件必须已被 rename 掉
    expect(backupFiles().some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('走「先写 .tmp 再 rename」的原子路径（防进程被杀留下半个 JSON）', async () => {
    const svc = await loadService();
    const spy = vi.spyOn(fs, 'writeFileSync');
    try {
      const r = svc.writeProjectBackup({ projectId: 'patomic', payload: { a: 1 } });
      const targets = spy.mock.calls.map((c) => String(c[0]));
      // 数据必须写在 .tmp 上——绝不直接写最终文件（直接写时中断会留下截断的 JSON，
      // 而它能被 listProjectBackups 列出、体积看着正常，用户恢复时才发现解析失败）
      expect(targets.some((t) => t.endsWith('.novel.json.tmp'))).toBe(true);
      expect(targets.some((t) => t.endsWith('.novel.json'))).toBe(false);
      // rename 完成后：最终文件在、.tmp 不在
      expect(fs.existsSync(path.join(BACKUP_DIR, r.file))).toBe(true);
      expect(fs.existsSync(path.join(BACKUP_DIR, `${r.file}.tmp`))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('projectId 非法（路径穿越 / 超长 / 非字符串）→ 抛错且不落盘', async () => {    const svc = await loadService();
    for (const bad of ['../evil', 'a/b', 'a\\b', 'x'.repeat(65), '', 123, null, undefined]) {
      expect(() =>
        svc.writeProjectBackup({ projectId: bad, payload: { a: 1 } })
      ).toThrow(/projectId 非法/);
    }
  });

  it('payload 非对象 → 抛错', async () => {
    const svc = await loadService();
    expect(() => svc.writeProjectBackup({ projectId: 'p2', payload: null })).toThrow(
      /payload 必须为项目 JSON 对象/
    );
    expect(() => svc.writeProjectBackup({ projectId: 'p2', payload: 'str' })).toThrow(
      /payload 必须为项目 JSON 对象/
    );
  });

  it('超过 9MB → 抛错（按 UTF-8 字节计，中文不会被低估）', async () => {
    const svc = await loadService();
    // 4M 个中文字符 ≈ 12MB（UTF-8 3 字节/字），远超声明的 9MB 上限
    const huge = { id: 'p3', blob: '中'.repeat(4 * 1024 * 1024) };
    expect(() => svc.writeProjectBackup({ projectId: 'p3', payload: huge })).toThrow(/备份过大/);
  });
});

describe('backupService · 修剪与隔离', () => {
  it('同秒多次写入不覆盖：追加序号区分', async () => {
    const svc = await loadService();
    const names = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const r = svc.writeProjectBackup({ projectId: 'psame', payload: { i } });
      names.add(r.file);
    }
    expect(names.size).toBe(5); // 5 次写入 → 5 个不同文件名
  });

  it('超过保留份数（20）→ 修剪到 20 份', async () => {
    const svc = await loadService();
    // 注意：每次写入都会顺带修剪，所以 `pruned` 是**该次调用**修剪的数量，不是累计。
    let last = { kept: 0, pruned: 0 };
    for (let i = 0; i < 22; i += 1) {
      last = svc.writeProjectBackup({ projectId: 'pmany', payload: { i } });
    }
    // 第 22 次写入时已有 20 份 → 新增 1 份到 21 → 修剪 1 份回到 20
    expect(last.kept).toBe(20);
    expect(last.pruned).toBe(1);
    expect(backupFiles().filter((n) => n.startsWith('pmany-')).length).toBe(20);
  });

  it('修剪不影响其他项目的备份', async () => {
    const svc = await loadService();
    for (let i = 0; i < 22; i += 1) {
      svc.writeProjectBackup({ projectId: 'pbig', payload: { i } });
    }
    const other = svc.writeProjectBackup({ projectId: 'psmall', payload: { i: 0 } });
    expect(fs.existsSync(path.join(BACKUP_DIR, other.file))).toBe(true);
    expect(backupFiles().filter((n) => n.startsWith('psmall-')).length).toBe(1);
  });
});

describe('backupService · listProjectBackups', () => {
  it('列出备份并按 mtime 倒序，projectId 能从文件名还原', async () => {
    const svc = await loadService();
    const r = svc.writeProjectBackup({ projectId: 'plist', payload: { a: 1 } });
    const list = svc.listProjectBackups('plist');
    expect(list.length).toBeGreaterThan(0);
    expect(list.map((x) => x.file)).toContain(r.file);
    expect(list.every((x) => x.projectId === 'plist')).toBe(true);
    expect(list.every((x) => x.size > 0)).toBe(true);
  });

  it('残留的 .tmp（模拟上次写入中断）不会被当成有效备份列出', async () => {
    const svc = await loadService();
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(BACKUP_DIR, 'ptmp-20260101-000000.novel.json.tmp'),
      '{"partial":',
      'utf-8'
    );
    const list = svc.listProjectBackups();
    expect(list.some((x) => x.file.endsWith('.tmp'))).toBe(false);
  });

  it('projectId 非法 → 抛错', async () => {
    const svc = await loadService();
    expect(() => svc.listProjectBackups('../x')).toThrow(/projectId 非法/);
  });
});

describe('backupService · deleteProjectBackups', () => {
  it('只删指定项目的备份，返回删除数量', async () => {
    const svc = await loadService();
    svc.writeProjectBackup({ projectId: 'pdel', payload: { a: 1 } });
    svc.writeProjectBackup({ projectId: 'pdel', payload: { a: 2 } });
    svc.writeProjectBackup({ projectId: 'pkeep', payload: { a: 3 } });

    const r = svc.deleteProjectBackups('pdel');
    expect(r.removed).toBe(2);
    expect(backupFiles().filter((n) => n.startsWith('pdel-')).length).toBe(0);
    expect(backupFiles().filter((n) => n.startsWith('pkeep-')).length).toBe(1);
  });

  it('projectId 非法 → 抛错', async () => {
    const svc = await loadService();
    expect(() => svc.deleteProjectBackups('../x')).toThrow(/projectId 非法/);
  });
});
