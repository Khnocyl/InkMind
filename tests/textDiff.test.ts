import { describe, it, expect } from 'vitest';
import {
  applyLocalPatches,
  diffProseBlocks,
  type LocalPatchFailure,
} from '../src/services/textDiff';

describe('applyLocalPatches', () => {
  it('精确命中时替换首次出现', () => {
    const prose = '他深吸一口气，推开门。门后站着一个人。';
    const r = applyLocalPatches(prose, [
      { before: '他深吸一口气', after: '他压下呼吸' },
    ]);
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.text).toBe('他压下呼吸，推开门。门后站着一个人。');
  });

  it('未命中记录 not_found 与片段（不静默失败）', () => {
    const prose = '夜色深沉。';
    const r = applyLocalPatches(prose, [
      { before: '不存在的一句话', after: '替换' },
    ]);
    expect(r.applied).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.failedDetails).toHaveLength(1);
    const d = r.failedDetails[0] as LocalPatchFailure;
    expect(d.reason).toBe('not_found');
    expect(d.before).toBe('不存在的一句话');
  });

  it('空 before 记为 empty_before', () => {
    const r = applyLocalPatches('正文', [{ before: '  ', after: 'x' }]);
    expect(r.applied).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.failedDetails[0].reason).toBe('empty_before');
  });

  it('多条补丁：部分命中部分失败', () => {
    const prose = 'A 段。B 段。';
    const r = applyLocalPatches(prose, [
      { before: 'A 段', after: 'A2' },
      { before: 'C 段', after: 'C2' },
    ]);
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.text).toBe('A2。B 段。');
  });

  it('空补丁数组不改变文本', () => {
    const r = applyLocalPatches('正文', []);
    expect(r.applied).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.text).toBe('正文');
  });
});

describe('diffProseBlocks', () => {
  it('相同文本 identical', () => {
    const r = diffProseBlocks('甲\n\n乙', '甲\n\n乙');
    expect(r.identical).toBe(true);
    expect(r.changeCount).toBe(0);
  });

  it('检测到变化并给出 charDelta', () => {
    const r = diffProseBlocks('甲\n\n乙', '甲\n\n乙丙');
    expect(r.identical).toBe(false);
    expect(r.afterChars - r.beforeChars).toBe(1);
    expect(r.changeCount).toBeGreaterThan(0);
  });

  it('空白差异不影响统计', () => {
    const r = diffProseBlocks('甲 乙', '甲乙');
    expect(r.beforeChars).toBe(2);
    expect(r.afterChars).toBe(2);
  });
});
