/**
 * 跨章抽检窗口（近 N 章）回归守卫。
 *
 * 背景：窗口此前**写死 5**（`useAutoPilot.ts` 与 `useChapterActions.ts` 两处字面量），
 * 面板也没有入口 → 「复查更远的中程漂移」根本做不到。
 *
 * 两条路径成本曲线不同，所以上限分开：
 * - 手动 + 模型（`useLlm:true`）：窗口越大送进 prompt 的近章正文越多 → **线性花 token** → ≤30
 * - 手动 + 纯本地启发：只在本地拼 blob 做匹配 → **零 token** → ≤100
 * - **Auto-Pilot 周期抽检不读此值**（其结果决定 `stopReason='cross_audit_fail'`）
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CROSS_AUDIT_MAX_RECENT_LLM,
  CROSS_AUDIT_MAX_RECENT_LOCAL,
  CROSS_AUDIT_MIN_RECENT,
  clampCrossAuditRecentCount,
} from '../src/services/crossChapterAudit';

describe('crossChapterAudit · 检查窗口夹区间', () => {
  it('缺省/非法输入回落 5（不抛错）', () => {
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 'abc', {}]) {
      expect(clampCrossAuditRecentCount(bad)).toBe(CROSS_AUDIT_MIN_RECENT);
      expect(clampCrossAuditRecentCount(bad, { useLlm: true })).toBe(
        CROSS_AUDIT_MIN_RECENT
      );
    }
  });

  it('低于下限抬到 5；小数向下取整', () => {
    expect(clampCrossAuditRecentCount(1)).toBe(CROSS_AUDIT_MIN_RECENT);
    expect(clampCrossAuditRecentCount(0)).toBe(CROSS_AUDIT_MIN_RECENT);
    expect(clampCrossAuditRecentCount(-20)).toBe(CROSS_AUDIT_MIN_RECENT);
    expect(clampCrossAuditRecentCount(12.9)).toBe(12);
  });

  it('模型路径上限 30（线性花 token，必须收紧）', () => {
    expect(clampCrossAuditRecentCount(20, { useLlm: true })).toBe(20);
    expect(clampCrossAuditRecentCount(30, { useLlm: true })).toBe(
      CROSS_AUDIT_MAX_RECENT_LLM
    );
    expect(clampCrossAuditRecentCount(80, { useLlm: true })).toBe(
      CROSS_AUDIT_MAX_RECENT_LLM
    );
    expect(clampCrossAuditRecentCount(9999, { useLlm: true })).toBe(
      CROSS_AUDIT_MAX_RECENT_LLM
    );
  });

  it('本地启发路径上限 100（零 token，可放宽）', () => {
    expect(clampCrossAuditRecentCount(60)).toBe(60);
    expect(clampCrossAuditRecentCount(60, { useLlm: false })).toBe(60);
    expect(clampCrossAuditRecentCount(100, { useLlm: false })).toBe(
      CROSS_AUDIT_MAX_RECENT_LOCAL
    );
    expect(clampCrossAuditRecentCount(5000, { useLlm: false })).toBe(
      CROSS_AUDIT_MAX_RECENT_LOCAL
    );
  });

  it('同值在两条路径下得到不同上限（成本曲线不同）', () => {
    const v = 80;
    expect(clampCrossAuditRecentCount(v, { useLlm: true })).toBe(30);
    expect(clampCrossAuditRecentCount(v, { useLlm: false })).toBe(80);
    expect(CROSS_AUDIT_MAX_RECENT_LOCAL).toBeGreaterThan(CROSS_AUDIT_MAX_RECENT_LLM);
  });
});

describe('crossChapterAudit · 防「窗口又写死」', () => {
  it('手动抽检不得再写死 recentCount；AP 周期抽检应保持 5', async () => {
    const root = process.cwd();
    const manual = fs.readFileSync(
      path.join(root, 'src/hooks/useChapterActions.ts'),
      'utf8'
    );
    // 手动路径必须走 clamp，不得再出现字面量 5
    expect(manual).toMatch(/clampCrossAuditRecentCount/);
    expect(manual, '手动抽检又写死了 recentCount: 5').not.toMatch(/recentCount: 5,/);

    // AP 路径：窗口改动会改变停机行为，故**刻意**保持 5（此处锁住，防误改）
    const ap = fs.readFileSync(path.join(root, 'src/hooks/useAutoPilot.ts'), 'utf8');
    expect(ap, 'Auto-Pilot 的抽检窗口被改动了（会影响停机行为）').toMatch(
      /runHeuristicCrossAudit\(proj, \{ recentCount: 5 \}\)/
    );
  });
});
