import { describe, it, expect } from 'vitest';
import { ruleScanProse } from '../src/services/ruleScan';
import type { StyleConfig } from '../src/types/novel';

const baseStyle: StyleConfig = {
  clicheBlacklist: ['那一刻', '倒吸一口凉气'],
  customBlacklist: [],
  fewShotExamples: [],
  selectedExampleId: '',
  enforceShowDontTell: true,
  forbidEndingSublimation: true,
};

describe('ruleScanProse', () => {
  it('黑名单命中为 error 且 passed=false', () => {
    const r = ruleScanProse('那一刻，他倒吸一口凉气。', baseStyle);
    expect(r.blacklistHits).toBeGreaterThan(0);
    const bl = r.hits.filter((h) => h.kind === 'blacklist');
    expect(bl.length).toBeGreaterThan(0);
    expect(bl[0].severity).toBe('error');
    expect(r.passed).toBe(false);
    expect(r.score).toBeLessThan(100);
  });

  it('黑名单白名单豁免：命中短语含豁免词则不计数', () => {
    const style: StyleConfig = {
      ...baseStyle,
      aiTasteWhitelist: ['那一刻'],
    };
    const r = ruleScanProse('那一刻，他推开门。', style);
    expect(r.blacklistHits).toBe(0);
  });

  it('禁升华开启时章末升华命中', () => {
    const r = ruleScanProse('他望着远方，或许这就是命运。', baseStyle);
    expect(r.sublimationHits).toBeGreaterThan(0);
  });

  it('禁升华关闭时不命中升华', () => {
    const style: StyleConfig = { ...baseStyle, forbidEndingSublimation: false };
    const r = ruleScanProse('他望着远方，或许这就是命运。', style);
    expect(r.sublimationHits).toBe(0);
  });

  it('show-don-tell 弱模式命中为 warn', () => {
    const r = ruleScanProse('他心中感到一阵不安。', baseStyle);
    const tell = r.hits.filter((h) => h.kind === 'tell');
    expect(tell.length).toBeGreaterThan(0);
    expect(tell[0].severity).toBe('warn');
  });

  it('干净文本 passed=true', () => {
    const r = ruleScanProse('雨水顺着瓦缝滴在青石板上，他握紧了刀柄。', baseStyle);
    expect(r.passed).toBe(true);
    expect(r.hits.length).toBe(0);
  });

  it('开篇与上章同质被标记', () => {
    const prev =
      '夜雨敲窗，烛火摇曳。他坐在桌前，指节发白，目光落在半卷残页上。窗外隐约传来更夫的梆子声，一下，又一下。';
    const curr =
      '夜雨敲窗，烛火摇曳。她站在窗前，指节发白，目光落在半卷残页上。窗外隐约传来更夫的梆子声，一下，又一下。';
    const r = ruleScanProse(curr, baseStyle, { previousProse: prev });
    const echo = r.hits.filter((h) => h.kind === 'echo');
    expect(echo.length).toBeGreaterThan(0);
    expect(echo[0].severity).toBe('error');
  });
});
