/**
 * 番茄平台硬规（ProseHardRules）单测：
 * - 预设形状与指纹自洽
 * - 六条机检规则的命中/放行双侧
 * - 未声明 hardRules 的档案零行为变化
 * - 解析与 prompt 注入链路（resolveStyleHardRules / formatStyleProfileForPrompt）
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STYLE_PRESETS,
  FANQIE_STYLE_PROFILE,
} from '../src/services/stylePresets';
import {
  validatePostWrite,
  validateStyleHardRules,
  collectSpeakerNames,
  computeDialogueCharRatio,
} from '../src/engine/discipline';
import {
  getActiveStyleProfile,
  importStyleProfile,
  resolveStyleHardRules,
  formatStyleProfileForPrompt,
} from '../src/services/styleImitate';
import { getDefaultStyleConfig } from '../src/services/storage';

const RULES = FANQIE_STYLE_PROFILE.hardRules!;

describe('番茄预设 · 形状与指纹', () => {
  it('存在于内置清单，id 唯一', () => {
    expect(BUILTIN_STYLE_PRESETS.some((p) => p.id === FANQIE_STYLE_PROFILE.id)).toBe(true);
    expect(new Set(BUILTIN_STYLE_PRESETS.map((p) => p.id)).size).toBe(
      BUILTIN_STYLE_PRESETS.length
    );
  });

  it('hardRules 声明全部六类平台纪律', () => {
    expect(RULES.openingCutIn).toBe(true);
    expect(RULES.forbidOpeningEnvStack).toBe(true);
    expect(RULES.dialogueRatioMin).toBe(0.35);
    expect(RULES.dialogueRatioMax).toBe(0.5);
    expect(RULES.endingNoElevation).toBe(true);
    expect(RULES.noLectureParagraphs).toBe(true);
    expect(RULES.forbidSoloMonologue).toBe(true);
    expect(RULES.maxParagraphLen).toBe(180);
  });

  it('指纹为设计靶区且数值自洽（对白 42% 落在硬规带内）', () => {
    const fp = FANQIE_STYLE_PROFILE.fingerprint;
    expect(fp.avgSentenceLen).toBeCloseTo(fp.charCount / fp.sentenceCount, 5);
    expect(fp.avgParagraphLen).toBeCloseTo(fp.charCount / fp.paragraphCount, 5);
    expect(fp.shortSentenceRatio).toBeGreaterThanOrEqual(0.6);
    expect(fp.dialogueRatio).toBeGreaterThanOrEqual(0.35);
    expect(fp.dialogueRatio).toBeLessThanOrEqual(0.5);
    expect(fp.topPhrases.length).toBeGreaterThanOrEqual(3);
  });

  it('指南/doList/dontList 覆盖用户五条纪律', () => {
    const blob = [
      FANQIE_STYLE_PROFILE.styleGuide,
      FANQIE_STYLE_PROFILE.authorStyle,
      ...FANQIE_STYLE_PROFILE.doList,
      ...FANQIE_STYLE_PROFILE.dontList,
    ].join('\n');
    expect(blob).toContain('第一句');
    expect(blob).toContain('35%');
    expect(blob).toContain('升华');
    expect(blob).toContain('科普');
    expect(blob).toContain('自言自语');
    expect(FANQIE_STYLE_PROFILE.doList.length).toBeGreaterThanOrEqual(6);
    expect(FANQIE_STYLE_PROFILE.dontList.length).toBeGreaterThanOrEqual(5);
    expect((FANQIE_STYLE_PROFILE.structureGuide || '').length).toBeGreaterThan(40);
  });

  it('原创样文：默认纪律与番茄硬规双通过（样文自身必须示范合规写法）', () => {
    for (const e of FANQIE_STYLE_PROFILE.sampleExcerpts || []) {
      const dflt = validatePostWrite(e.text).filter((v) => v.severity === 'error');
      expect(dflt, `样文「${e.label}」默认纪律失败：${dflt.map((x) => x.rule).join('、')}`).toEqual([]);
      const hard = validateStyleHardRules(e.text, RULES, [
        '陈默',
        '林晚',
        '主管',
        '副总',
        '房东',
      ]).filter((v) => v.severity === 'error');
      expect(hard, `样文「${e.label}」硬规失败：${hard.map((x) => x.rule).join('、')}`).toEqual([]);
    }
  });

  it('样文引号字形合规：只用中文双引号“”，无半角 " 与直角「」', () => {
    const blobs = [
      FANQIE_STYLE_PROFILE.sampleExcerpt,
      ...(FANQIE_STYLE_PROFILE.sampleExcerpts || []).map((e) => e.text),
    ];
    for (const b of blobs) {
      expect(b).not.toContain('"');
      expect(b).not.toContain('「');
      expect(b).not.toContain('」');
      expect(b).toContain('\u201C');
    }
  });
});

describe('机检 · 开局第一句事故化切入', () => {
  it('环境铺陈开场 → error「开局铺环境」', () => {
    const text =
      '清晨的阳光洒在小镇的青石板路上，空气中弥漫着淡淡的花香与湿气。陈默收拾好东西，出了门。';
    const rules = validateStyleHardRules(text, RULES).filter((v) => v.severity === 'error');
    expect(rules.some((v) => v.rule === '开局铺环境')).toBe(true);
  });

  it('台词切入 → 放行', () => {
    const text =
      '"押金这个月再不交，你就滚。"房东把收据拍在桌上，指甲敲了敲那行数字。陈默没接话，把四百二十块推过去。';
    const vs = validateStyleHardRules(text, RULES, ['陈默', '房东']);
    expect(vs.filter((v) => v.rule === '开局铺环境')).toEqual([]);
  });

  it('物理动词切入 → 放行', () => {
    const text =
      '陈默踹开会议室的门，把一沓打印纸拍在主桌上。所有人抬头。主管的笔停在半空，半天没落下来。';
    const vs = validateStyleHardRules(text, RULES, ['陈默', '主管']);
    expect(vs.filter((v) => v.rule === '开局铺环境')).toEqual([]);
  });

  it('突发事态切入 → 放行', () => {
    const text =
      '轰的一声，隔壁单元的窗户炸开了花。陈默抓起外套冲出楼道，身后全是尖叫与哭喊。';
    const vs = validateStyleHardRules(text, RULES, ['陈默']);
    expect(vs.filter((v) => v.rule === '开局铺环境')).toEqual([]);
  });
});

describe('机检 · 对白占比带与单机独白', () => {
  /** 400+ 字纯动作叙述（无对白） */
  const NARRATION_400 = [
    '陈默拨开人群，撞开会议室的侧门，把一沓打印纸拍在主桌上。纸角划过半杯凉透的茶，杯身晃了晃，压住桌沿的工牌。',
    '主管盯着他，喉咙里挤出一声冷哼。陈默不接话，只把工牌翻过来，摆在签到表的第一行。有人低头记日期，有人挪开视线。',
    '空调的风灌进领口，纸页哗啦作响。他逐页翻给每个人看，签到栏的签名一行行对上打卡机的编号，最后停在周六那一栏。',
    '满桌人开始交头接耳。主管把笔帽按得咔咔响，指节泛白。陈默把最后一页抽出来，走到白板前，用磁扣固定住，退后两步。',
    '散会后，走廊里全是脚步声。林晚靠在窗边等他，手里捏着半块没吃完的饼干。陈默把外套搭在臂弯，与她擦肩而过，径直走向电梯。',
    '回到工位，他把抽屉清空，纸箱沉得压手。前台喊他拿快递，他应了一声，把箱子搁在脚边，蹲下系了系松开的鞋带。',
    '下班高峰期，地铁闸机前排着长队。陈默刷开卡，被人流挤进车厢，玻璃上映出一张没表情的脸，他抬手抹了一把。',
    '出了站，他把纸箱换到左手，右手掏出钥匙捅了两次才对准锁孔。门开了，屋里黑着，他没开灯，先把箱子放在门边，摸黑按亮了灶台的开关。',
  ].join('\n\n');

  it('对白占比 <35% → error「对白占比不足」', () => {
    expect(computeDialogueCharRatio(NARRATION_400)).toBeLessThan(0.35);
    const vs = validateStyleHardRules(NARRATION_400, RULES, ['陈默', '林晚', '主管']);
    expect(vs.some((v) => v.rule === '对白占比不足' && v.severity === 'error')).toBe(true);
  });

  it('对白占比 >50% → warning「对白占比过高」，两人接话不误判单机', () => {
    const text = Array.from(
      { length: 12 },
      (_, i) =>
        `"第${i}轮了，这句该你再说一遍。"陈默敲桌，"装到什么时候？签字的人现在就坐在这。"林晚开口。`
    ).join('\n\n');
    const ratio = computeDialogueCharRatio(text);
    expect(ratio).toBeGreaterThan(0.5);
    const vs = validateStyleHardRules(text, RULES, ['陈默', '林晚']);
    expect(vs.some((v) => v.rule === '对白占比过高' && v.severity === 'warning')).toBe(true);
    expect(vs.some((v) => v.rule === '单机自言自语')).toBe(false);
  });

  it('全部台词归属同一人 → error「单机自言自语」', () => {
    const text = Array.from(
      { length: 12 },
      (_, i) =>
        `"这单我先记下，编号${i}。"陈默对着空椅子说完，把本子翻过一页，笔尖点在下一行格子里，等明天来核对。`
    ).join('\n\n');
    expect(computeDialogueCharRatio(text)).toBeGreaterThan(0.2);
    const vs = validateStyleHardRules(text, RULES, ['陈默', '林晚']);
    expect(vs.some((v) => v.rule === '单机自言自语' && v.severity === 'error')).toBe(true);
  });

  it('不足 400 字不判占比带（样文/短稿豁免）', () => {
    const vs = validateStyleHardRules(
      '陈默踹开门，把扳手摔在桌上。桌上只剩半块饼干和一张催款单。',
      RULES
    );
    expect(vs.some((v) => v.rule.includes('对白占比'))).toBe(false);
  });
});

describe('机检 · 结尾假升华与科普讲解段', () => {
  it('结尾哲思升华/口号 → error', () => {
    const text =
      '"先把今天的活交了。"陈默接过扳手，拧松了第一颗螺栓。\n\n他终于明白，这就是成长的意义。命运从未亏待过谁，从今以后，他要带着这份信念，走向属于他的新的人生。';
    const vs = validateStyleHardRules(text, RULES, ['陈默']);
    expect(vs.some((v) => v.rule === '结尾假升华' && v.severity === 'error')).toBe(true);
    expect(vs.some((v) => v.rule === '结尾议论升华')).toBe(true);
  });

  it('台词/动作收尾 → 放行', () => {
    const text =
      '"这月的数不对。"林晚把报表推过去，指尖压住最后一行红字。\n\n陈默盯着那个数字，慢慢把报表翻回第一页，又看了一遍，抬头时脸色已经沉了下去。';
    const vs = validateStyleHardRules(text, RULES, ['陈默', '林晚']);
    expect(vs.filter((v) => v.rule.startsWith('结尾'))).toEqual([]);
  });

  it('130+ 字无对白无动作的说明腔段 → error「科普讲解段」', () => {
    const lecture =
      '所谓修行体系，原来共分三大类：凡境、灵境、天境。每一类又分为九重小境界，等级从凡境一重起步，依资质划定上限，众所周知，凡境九重之后方能进入灵境，此为亘古不变的铁律，任何宗门概莫能外。三者的差距并非单纯的积累问题，而是生命层次的质变，之所以艰难，是因为每一次进阶都要重塑筋骨，历史上成功者寥寥无几，失败者尽皆湮灭无闻。';
    const text = `"先对一下账。"陈默把本子摊在柜台上，指尖压住缺角的那一页。\n\n${lecture}\n\n林晚掀帘进来，把剑往桌上一横："出发。"`;
    const vs = validateStyleHardRules(text, RULES, ['陈默', '林晚']);
    expect(vs.some((v) => v.rule === '科普讲解段' && v.severity === 'error')).toBe(true);
  });

  it('超长叙述段 → warning「段落超长」', () => {
    const longPara =
      '陈默把仓库里所有箱子按编号重新码放了一遍，从最里侧靠墙的角落开始，先搬轻的再搬重的，中间的通道留出半步宽度，标签一律朝外，胶带断口压在箱底，汗湿的手掌在裤腿上蹭了蹭又继续搬，直到窗外透出灰白的光。'.repeat(
        2
      );
    const text = `"钥匙给你。"房东把铁环扔过来，陈默抬手接住。\n\n${longPara}\n\n"第一箱，开。"林晚用靴尖踢了踢箱角。`;
    const vs = validateStyleHardRules(text, RULES, ['陈默', '林晚', '房东']);
    expect(vs.some((v) => v.rule === '段落超长' && v.severity === 'warning')).toBe(true);
  });
});

describe('门控与链路', () => {
  it('未激活档案 / 档案无 hardRules → validatePostWrite 零新增行为', () => {
    const bad =
      '清晨的阳光洒在小镇的青石板路上，空气中弥漫着淡淡的花香。陈默收拾好东西，走出了门。他终于明白，这就是命运的意义，从今以后一切都不同了。';
    const plain = validatePostWrite(bad);
    expect(plain.some((v) => v.rule === '开局铺环境')).toBe(false);
    expect(plain.some((v) => v.rule === '结尾假升华')).toBe(false);
    // 通用纪律不受影响（升华机检走 ruleScan 的 forbidEndingSublimation，另一条链路）
  });

  it('激活番茄档案 → resolveStyleHardRules 返回硬规；关闭仿写即失效', () => {
    const activated = importStyleProfile(getDefaultStyleConfig(), FANQIE_STYLE_PROFILE, {
      activate: true,
    });
    expect(getActiveStyleProfile(activated)?.hardRules).toBeTruthy();
    expect(resolveStyleHardRules(activated)?.dialogueRatioMin).toBe(0.35);
    expect(resolveStyleHardRules(getDefaultStyleConfig())).toBeNull();
  });

  it('写手 prompt 注入机检硬规块（先写对，再免打回）', () => {
    const block = formatStyleProfileForPrompt(FANQIE_STYLE_PROFILE);
    expect(block).toContain('机检硬规');
    expect(block).toContain('第一句');
    expect(block).toContain('35%–50%');
    expect(block).toContain('禁止哲思升华');
  });

  it('collectSpeakerNames：出场角色优先，回落全员，过滤单字名', () => {
    const chars = [
      { id: 'a', name: '陈默' },
      { id: 'b', name: '林晚' },
      { id: 'c', name: '影' },
    ];
    expect(collectSpeakerNames(chars, ['a', 'b'])).toEqual(['陈默', '林晚']);
    expect(collectSpeakerNames(chars, undefined).length).toBe(2);
    expect(collectSpeakerNames(chars, []).length).toBe(2);
  });
});
