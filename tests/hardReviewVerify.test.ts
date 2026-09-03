import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  containsQuote,
  verifyHardIssue,
  applyHardReviewVerification,
} from '../src/services/hardReviewVerify';
import type { HardReviewIssue, HardReviewResult } from '../src/types/novel';

const CHAPTER = [
  '沈家演武台。',
  '黑石台心，沈烬双膝盘坐，单衣猎猎。',
  '高台左侧。家主沈渊看着台上血雾弥漫的少年，袍袖猛然一拂——转身，大步离去。',
  '族老们笑着让出嫡子主桌的席位，稳稳当当落在沈岳峰掌中。',
  '他被人从演武台拖下，丢进夜色。躯体被扔在破木板上，有人从外头落了一道铁闩，闩死，脚步声踩雪远去。',
  '北墙根，废弃祠堂。门从外头闩死，门缝里只漏一线灰白。他躺在冰凉的石板上。',
  '沈烬木然望着窗外大雪。',
  '门外忽然传来脚步声。"管他死活，三房那边传话，今晚就把他挪出正院，省得污了明天给岳峰少爷庆功的场地。""拖。绳子在柴房，省得脏了手。"',
  '门栓被从外头拨开，锈铁刮木，发出一声短促的咯吱。两个杂役挑着灯笼进来。',
].join('\n');

const MEMORY = [
  '【钉死事实】沈烬三脉尽碎，丹田死寂，无法调动任何灵力。',
  '【钉死事实】父亲沈渊衣袖一甩转身离去，未发一言。',
  '【时间线】日1：演武台灵火熄→祠堂闩门→明日他将被逐出主院，迁往后山柴房。',
].join('\n');

const CTX = { chapterContent: CHAPTER, memoryBlock: MEMORY };

describe('hardReviewVerify · 归一化匹配', () => {
  it('空白/引号/破折号差异不影响逐字命中', () => {
    expect(normalizeForMatch('袍袖猛然一拂——')).toBe(normalizeForMatch('袍袖 猛然一拂——'));
    expect(containsQuote(CHAPTER, '袍袖猛然一拂——\n转身')).toBe(true);
    expect(containsQuote(CHAPTER, '他躺在冰凉的石板上。')).toBe(true);
  });

  it('过短引文（<6字）不作为有效证据', () => {
    expect(containsQuote(CHAPTER, '沈烬')).toBe(false);
  });

  it('省略号拼接的引文不视为逐字命中', () => {
    // 模型用「……」跳抄两处，归一化后不是连续子串
    expect(containsQuote(CHAPTER, '家主沈渊看着……转身，大步离去')).toBe(false);
  });
});

describe('hardReviewVerify · verifyHardIssue', () => {
  it('引文A/B 均逐字命中 → verified', () => {
    const issue: HardReviewIssue = {
      type: '吃书矛盾',
      severity: 'error',
      description: '三脉尽碎却调动灵力',
      suggestion: '删除调灵动作',
      evidenceA: { source: 'chapter', quote: '沈烬双膝盘坐，单衣猎猎' },
      evidenceB: { source: 'memory', quote: '沈烬三脉尽碎，丹田死寂' },
    };
    expect(verifyHardIssue(issue, CTX).status).toBe('verified');
  });

  it('引文A 是模型转述（非正文原句）→ quote-a-miss', () => {
    const issue: HardReviewIssue = {
      type: '状态冲突',
      severity: 'error',
      description: '沈烬昏死前身处庆功宴主桌',
      suggestion: '切割场景',
      evidenceA: { source: 'chapter', quote: '沈烬坐在嫡子主桌席位上接受族老祝贺' }, // 正文无此句
      evidenceB: { source: 'memory', quote: '父亲沈渊衣袖一甩转身离去' },
    };
    expect(verifyHardIssue(issue, CTX).status).toBe('quote-a-miss');
  });

  it('引文B 在记忆中不存在（幻觉引用）→ quote-b-miss', () => {
    const issue: HardReviewIssue = {
      type: '吃书矛盾',
      severity: 'error',
      description: '祠堂门闩死与杂役进入冲突',
      suggestion: '保持闩死至黎明',
      evidenceA: { source: 'chapter', quote: '有人从外头落了一道铁闩，闩死' }, // 正文✓
      evidenceB: { source: 'memory', quote: '沈烬独坐稻草与冰凉石壁之间' }, // 记忆✗
    };
    const r = verifyHardIssue(issue, CTX);
    expect(r.status).toBe('quote-b-miss');
  });

  it('用省略号拼接记忆原文 → quote-b-miss（万古烬天时间线误报的真实引用形态）', () => {
    const issue: HardReviewIssue = {
      type: '时间线错乱',
      severity: 'error',
      description: '本章把明日迁柴房提前到当夜执行',
      suggestion: '迁居置于黎明后',
      evidenceA: { source: 'chapter', quote: '今晚就把他挪出正院' }, // 正文✓
      evidenceB: { source: 'memory', quote: '明日他将被……迁至后山柴房' }, // 记忆原文无省略号
    };
    expect(verifyHardIssue(issue, CTX).status).toBe('quote-b-miss');
  });

  it('缺 evidenceA → no-evidence；缺 evidenceB → evidence-b-miss', () => {
    const noA: HardReviewIssue = {
      type: '道具归属',
      severity: 'error',
      description: 'x',
      suggestion: 'y',
    };
    expect(verifyHardIssue(noA, CTX).status).toBe('no-evidence');
    const noB: HardReviewIssue = {
      type: '道具归属',
      severity: 'error',
      description: 'x',
      suggestion: 'y',
      evidenceA: { source: 'chapter', quote: '黑石台心，沈烬双膝盘坐' },
    };
    expect(verifyHardIssue(noB, CTX).status).toBe('evidence-b-miss');
  });

  it('evidenceB.source=chapter 时查正文其他位置', () => {
    const issue: HardReviewIssue = {
      type: '时间线错乱',
      severity: 'error',
      description: '先闩门后来人，但来人竟能进屋却未写开闩',
      suggestion: '补写拨闩',
      evidenceA: { source: 'chapter', quote: '两个杂役挑着灯笼进来' },
      evidenceB: { source: 'chapter', quote: '有人从外头落了一道铁闩，闩死' },
    };
    expect(verifyHardIssue(issue, CTX).status).toBe('verified');
  });
});

describe('hardReviewVerify · applyHardReviewVerification（计分闸门）', () => {
  const base: Omit<HardReviewResult, 'issues'> = {
    passed: false,
    score: 42,
    summary: '发现 2 处硬伤 error',
  };

  it('全部指控未过核验 → 全部降级 warn、分数托回 80+、passed 复位（误报不再卡死本章）', () => {
    const issues: HardReviewIssue[] = [
      {
        type: '吃书矛盾',
        severity: 'error',
        description: '门闩冲突',
        suggestion: 's',
        evidenceA: { source: 'chapter', quote: '有人从外头落了一道铁闩，闩死' },
        evidenceB: { source: 'memory', quote: '沈烬独坐稻草与冰凉石壁之间' }, // ✗
      },
      {
        type: '时间线错乱',
        severity: 'error',
        description: '迁柴房提前',
        suggestion: 's',
        evidenceA: { source: 'chapter', quote: '今晚就把他挪出正院' },
        evidenceB: { source: 'memory', quote: '明日他将被……迁至后山柴房' }, // ✗ 省略号拼接
      },
    ];
    const out = applyHardReviewVerification({ ...base, issues }, CTX);
    expect(out.downgraded).toBe(2);
    expect(out.verifiedErrors).toBe(0);
    expect(out.result.issues.every((i) => i.severity === 'warn')).toBe(true);
    expect(out.result.issues.every((i) => i.originalSeverity === 'error')).toBe(true);
    expect(out.result.issues.every((i) => i.verify && i.verify.status !== 'verified')).toBe(true);
    expect(out.result.score).toBeGreaterThanOrEqual(80);
    expect(out.result.passed).toBe(true);
    expect(out.result.summary).toContain('降级');
  });

  it('仍有已核实 error → 保守保留原分与未过状态（不因核验放水）', () => {
    const issues: HardReviewIssue[] = [
      {
        type: '状态冲突',
        severity: 'error',
        description: '已死角色说话',
        suggestion: 's',
        evidenceA: { source: 'chapter', quote: '黑石台心，沈烬双膝盘坐' },
        evidenceB: { source: 'memory', quote: '沈烬三脉尽碎，丹田死寂' }, // 引文真实存在
      },
      {
        type: '吃书矛盾',
        severity: 'error',
        description: '门闩冲突',
        suggestion: 's',
        evidenceA: { source: 'chapter', quote: '有人从外头落了一道铁闩，闩死' },
        evidenceB: { source: 'memory', quote: '沈烬独坐稻草与冰凉石壁之间' }, // ✗
      },
    ];
    const out = applyHardReviewVerification({ ...base, issues }, CTX);
    expect(out.verifiedErrors).toBe(1);
    expect(out.downgraded).toBe(1);
    // 计分收口：剩余 1 项已核实 error → 确定性锚点带 [55,70]（原 LLM 给 42 是按 2 项 error 打的）
    expect(out.result.score).toBe(55);
    expect(out.result.passed).toBe(false);
    const kept = out.result.issues.find((i) => i.verify?.status === 'verified');
    expect(kept?.severity).toBe('error');
    const dropped = out.result.issues.find((i) => i.verify?.status === 'quote-b-miss');
    expect(dropped?.severity).toBe('warn');
  });

  it('无 error 时原样通过（核验不产生副作用）', () => {
    const issues: HardReviewIssue[] = [
      { type: '战力越界', severity: 'warn', description: '语感偏强', suggestion: 's' },
    ];
    const out = applyHardReviewVerification({ passed: true, score: 88, summary: 'ok', issues }, CTX);
    expect(out.downgraded).toBe(0);
    expect(out.result.score).toBe(88);
    expect(out.result.issues[0].verify).toBeUndefined();
  });
});
