/**
 * 账本正文死亡断言收敛回归守卫（观察项 #2）。
 *
 * 背景：extractChapterFactSnapshot 曾对「角色名 + 0~8 字 + 死亡词」做无脑正则匹配，
 * 于是回忆杀（"他想起当年阿岚便是陨落于此"）、假设句（"若他那时身亡"）、
 * 险些句（"差点身亡"）、诈死（"假装身亡"）都会被当作「本章已写死」钉进账本，
 * 触发跨章抽检/硬伤审查误报。收敛后只有确定性的死亡表述才写入 death 断言。
 */
import { describe, expect, it } from 'vitest';
import { extractChapterFactSnapshot } from '../src/services/factLedger';
import type { Character, Chapter } from '../src/types/novel';

function chapter(): Chapter {
  return {
    id: 'ch-1',
    number: 1,
    title: '第一章',
    status: '正文草稿',
    content: '',
    involvedCharacterIds: ['阿岚'],
  } as unknown as Chapter;
}

function character(name: string): Character {
  return {
    id: name,
    name,
    status: '活跃',
    currentLocation: '',
  } as unknown as Character;
}

function run(prose: string, name = '阿岚') {
  const snap = extractChapterFactSnapshot({
    chapter: chapter(),
    prose,
    characters: [character(name)],
  });
  return snap.assertions.filter((a) => a.kind === 'death' && a.note === 'from_text');
}

describe('factLedger · 正文死亡断言收敛', () => {
  it('确定性死亡（当场身亡）→ 记 from_text death', () => {
    const hits = run('魏长风一剑穿心，阿岚怒吼一声，当场身亡，血染青阶。');
    expect(hits).toHaveLength(1);
    expect(hits[0].subject).toBe('阿岚');
    // claim 带原文存证，便于后续审查判断
    expect(hits[0].claim).toContain('被描述为死亡');
    expect(hits[0].claim).toContain('原文');
    expect(hits[0].claim).toContain('当场身亡');
  });

  it('险些/差点（濒死未死）→ 不记', () => {
    expect(run('阿岚替魏长风挡下暗箭，险些身亡，众人惊呼。')).toHaveLength(0);
    expect(run('那一刀贴喉擦过，阿岚差一点便死去。')).toHaveLength(0);
  });

  it('假设句 / 回忆杀 / 传闻 → 不记', () => {
    expect(run('魏长风暗忖：若阿岚那时身亡，此局早破。')).toHaveLength(0);
    expect(run('他想起当年，阿岚便是陨落于此山道。')).toHaveLength(0);
    expect(run('江湖相传，阿岚早已陨落在北境。')).toHaveLength(0);
  });

  it('诈死 / 演技 → 不记', () => {
    expect(run('阿岚将计就计，假装身亡，骗过了追兵。')).toHaveLength(0);
  });

  it('回忆杀出现在前、真死在后 → 仍要记（首个匹配落在弱化语境不得放过后续真死）', () => {
    const hits = run(
      '他想起当年，阿岚便是陨落于此山道。\n可这一回不同——三日后，阿岚力竭身亡，再没能站起来。'
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].claim).toContain('力竭身亡');
  });

  it('写死后又救活（反转）→ 不记', () => {
    expect(run('阿岚力竭身亡，又被长老以秘药救活。')).toHaveLength(0);
  });

  it('多角色并存互不干扰（他人死讯不清算无关角色）', () => {
    const snap = extractChapterFactSnapshot({
      chapter: chapter(),
      prose: '镇夜当场毙命，阿岚却毫发无伤地立在血泊中。',
      characters: [character('阿岚'), character('镇夜')],
    });
    const deaths = snap.assertions.filter((a) => a.kind === 'death' && a.note === 'from_text');
    expect(deaths.map((d) => d.subject)).toEqual(['镇夜']);
  });
});

// ── 2026-09-25 复审补遗：误认句式 / lead 窗口 / revive 窗口边界 ──────────────

describe('factLedger · 正文死亡断言收敛（补遗）', () => {
  it('「以为/误以为/都当」（误认句式）→ 不记', () => {
    // 「众人以为阿岚已死，原来他还活着」此前会被记 death 并级联到角色卡自动阵亡
    expect(run('众人以为阿岚已死，原来他还活着。')).toHaveLength(0);
    expect(run('世人都误以为阿岚已死。')).toHaveLength(0);
    expect(run('大家都当阿岚已死，她却踏入山门。')).toHaveLength(0);
  });

  it('弱化语境落在名字前 4~12 字（时间/回忆引导）→ 不记', () => {
    // 4 字窗口只取到「那一战，」，罩不住 7 字外的「想起」；12 字窗口才防得住
    expect(run('他还清楚地想起那一战，阿岚已死。')).toHaveLength(0);
  });

  it('复活预告落在旧 10 字窗口之外（14 字内）→ 不记', () => {
    // 旧窗口恰好把「复活」劈在窗外（差 1 字假阳性）
    expect(run('阿岚陨落，但谁都知道她还会复活归来。')).toHaveLength(0);
  });

  it('加宽窗口不误吞真死（lead 12 字内无弱化词仍记）', () => {
    const hits = run('两军阵前鼓声大作，阿岚当场阵亡，血染战旗。');
    expect(hits).toHaveLength(1);
    expect(hits[0].claim).toContain('当场阵亡');
  });

  it('弱化词在上一分句、当前分句是当场真死 → 仍记（不跨分句误吞）', () => {
    // 固定 12 字窗口会把上一分句的「想起」卷进来，误吞本分句的当场死亡
    const hits = run('他想起往事，转身拔剑，阿岚当场身亡。');
    expect(hits).toHaveLength(1);
    expect(hits[0].claim).toContain('当场身亡');
  });

  it('顿号式回忆列举 → 不记（顿号不得当分句边界，回忆词须罩得住）', () => {
    // 顿号是「当前分句 + 前一分句」回看的一部分：若作分句边界，
    // 「想起」被隔在窗口外，回忆杀会被误判为真死
    expect(run('他想起当年、那场大战，阿岚已死。')).toHaveLength(0);
  });

  it('后文的「复活」属于另一角色 → 不影响本人死亡认定', () => {
    const snap = extractChapterFactSnapshot({
      chapter: chapter(),
      prose: '阿岚当场身亡，三日后镇夜复活。',
      characters: [character('阿岚'), character('镇夜')],
    });
    const deaths = snap.assertions.filter((a) => a.kind === 'death' && a.note === 'from_text');
    expect(deaths.map((d) => d.subject)).toEqual(['阿岚']);
  });

  it('本人身亡后紧接本人复活 → 不记（真反转仍要抑制）', () => {
    const snap = extractChapterFactSnapshot({
      chapter: chapter(),
      prose: '阿岚力竭身亡，三日后阿岚却离奇复活。',
      characters: [character('阿岚'), character('镇夜')],
    });
    const deaths = snap.assertions.filter((a) => a.kind === 'death' && a.note === 'from_text');
    expect(deaths).toHaveLength(0);
  });
});