import { describe, expect, it } from 'vitest';
import { salvageJsonParse } from '../src/services/jsonRepair';

/** 断言成功并返回 value + strategy，便于类型收窄与后续深比较。 */
function expectOk<T>(raw: string): { value: T; strategy: string } {
  const r = salvageJsonParse<T>(raw);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('unreachable');
  return { value: r.value, strategy: r.strategy };
}

describe('jsonRepair · direct / fence-strip / trailing-comma', () => {
  it('正常 JSON 直接解析（direct）', () => {
    const { value, strategy } = expectOk<{ a: number }>('{"a":1}');
    expect(strategy).toBe('direct');
    expect(value).toEqual({ a: 1 });
  });

  it('markdown 围栏剥离（fence-strip）', () => {
    const { value, strategy } = expectOk<{ b: number }>('```json\n{"b":2}\n```');
    expect(strategy).toBe('fence-strip');
    expect(value).toEqual({ b: 2 });
  });

  it('BOM + 零宽字符剥离（fence-strip）', () => {
    const { value, strategy } = expectOk<{ a: number }>(
      '\uFEFF\u200B{"a":1}\u200D'
    );
    expect(strategy).toBe('fence-strip');
    expect(value).toEqual({ a: 1 });
  });

  it('对象尾逗号（trailing-comma）', () => {
    const { value, strategy } = expectOk<{ a: number }>('{"a":1,}');
    expect(strategy).toBe('trailing-comma');
    expect(value).toEqual({ a: 1 });
  });

  it('数组尾逗号（trailing-comma）', () => {
    const { value, strategy } = expectOk<number[]>('[1,2,]');
    expect(strategy).toBe('trailing-comma');
    expect(value).toEqual([1, 2]);
  });
});

describe('jsonRepair · 真实失败形状', () => {
  it('样本1：响应截断，缺最外层闭合（bracket-balance）', () => {
    const raw = '{"mustDo": ["a", "b"], "emotionalBeats": ["x", "y"]';
    const { value, strategy } = expectOk<{
      mustDo: string[];
      emotionalBeats: string[];
    }>(raw);
    expect(strategy).toBe('bracket-balance');
    expect(value).toEqual({ mustDo: ['a', 'b'], emotionalBeats: ['x', 'y'] });
  });

  it('样本2：值内未转义双引号（inner-quote-escape）', () => {
    const raw = '{"recap": "对方说完"你没看见"后消失", "n": 1}';
    const { value, strategy } = expectOk<{ recap: string; n: number }>(raw);
    expect(strategy).toBe('inner-quote-escape');
    expect(value).toEqual({ recap: '对方说完"你没看见"后消失', n: 1 });
  });

  it('样本3：复合（多键 + 多处内引号 + 截断结尾）', () => {
    const raw =
      '{"volumes":[{"title":"卷一","arc":"主角觉醒"烬天之火"之力","climax":"大战开启"},{"title":"卷二","arc":"再遇"烬天之火"旧主","climax":"真相初现"}],"overall":"贯穿全书的"烬天之火"意象';
    const { value, strategy } = expectOk<{
      volumes: Array<{ title: string; arc: string; climax: string }>;
      overall: string;
    }>(raw);
    expect(strategy).toBe('bracket-balance');
    expect(value).toEqual({
      volumes: [
        { title: '卷一', arc: '主角觉醒"烬天之火"之力', climax: '大战开启' },
        { title: '卷二', arc: '再遇"烬天之火"旧主', climax: '真相初现' },
      ],
      overall: '贯穿全书的"烬天之火"意象',
    });
  });
});

describe('jsonRepair · 语义保持与兜底', () => {
  it('已是合法 JSON 绝不改动语义（direct，深比较）', () => {
    const raw = '{"text":"a\\"b\\"c","list":[1,2,3],"nested":{"k":"v"}}';
    const { value, strategy } = expectOk<{
      text: string;
      list: number[];
      nested: { k: string };
    }>(raw);
    expect(strategy).toBe('direct');
    expect(value).toEqual({ text: 'a"b"c', list: [1, 2, 3], nested: { k: 'v' } });
  });

  it('悬空 `"key":` 后无值 → 补 null（bracket-balance）', () => {
    const { value, strategy } = expectOk<{ a: number; b: unknown }>(
      '{"a": 1, "b":'
    );
    expect(strategy).toBe('bracket-balance');
    expect(value).toEqual({ a: 1, b: null });
  });

  it('悬空已闭合键（无冒号/值）→ 丢弃该键（bracket-balance）', () => {
    const { value, strategy } = expectOk<{ a: number }>('{"a": 1, "b"');
    expect(strategy).toBe('bracket-balance');
    expect(value).toEqual({ a: 1 });
  });

  it('空输入 → ok:false', () => {
    const r = salvageJsonParse<unknown>('');
    expect(r.ok).toBe(false);
  });

  it('垃圾输入 → ok:false', () => {
    const r = salvageJsonParse<unknown>('not json at all');
    expect(r.ok).toBe(false);
  });
});

describe('jsonRepair · 错嵌括号回归（围栏 + 尾逗号 + 缺数组闭括号）', () => {
  it('线上 fixture 逐字回归：emotionalBeats 缺 `]` 但对象 `}` 完整', () => {
    const raw = `\`\`\`json
{
 "mustDo": [
 "沈烬于废弃矿脉深处的临时落脚点苏醒/独处，胸口烬天碑首次浮现并展示「推演烙印之能」的具体用法（例如：在掌心浮现出某个陌生火种图纹、或能推演出他人灵火弱点的虚影），以可验收的视觉/动作完成首次能力落点。",
 "姜漪澜在姜家别院禁足期间得知沈烬已跌落废人、由族人遣送至青冥城的事实，安排（或默许）退婚使者在当日启程赴青冥城，形成两条线的物理会师倒计时。",
 "退婚一行抵达青冥城并找到沈烬所在的废弃矿脉边缘，当面以姜家之名宣读退婚、掷还婚书信物，需有具体可拍动作（掷、摔、丢、推）。",
 "沈烬面对退婚者只回一句「你来晚了」，并以烬天碑推演之力当场做出一件让对方短暂失语/后退的可验收小事（例：一眼看穿来者火种缺陷、或在掌中凝出其本不该再拥有的火纹），不升级战斗。",
 "章末以沈烬被逐出矿脉落脚点、身后彻底坍塌作为物理层面的「旧路断绝」，同时给出下一步去向（青冥小城新生）的具体方向锚点。",
 ],
 "mustAvoid": [
 "不得让沈烬当场以灵力击败或压制退婚者一行——境界碾压铁律下，他必须只以「推演/烙印」类的非攻击性手段反压，不可破境越阶。",
 "不得让姜漪澜本人在本章现身于沈烬面前，本章只通过「她安排使者」间接推动，避免两线在开篇就硬碰。",
 "不得让沈烬本章内点燃任何真正灵火或宣告重燃——灵火熄灭即道基崩碎是铁律，烬天碑之力应表现为「烙印/推演」而非「重燃灵火」。",
 "不得安排族人、父亲或姜家高境界强者亲临退婚现场——本卷开篇只由下人/使者执行退婚，留出后续父辈冲突的升级空间，避免第一章就把家族矛盾打到顶。",
 "不得出现哲理总结、宏大自白或「我沈烬必将……」类空喊式升华；台词与结尾一律以具体可拍的动作/物件收束。",
 ],
 "endingHook": "退婚信物被掷在地上的同一息，沈烬身后的矿洞支柱轰然断裂、塌方将他整个人吞没，尘埃散尽后洞壁焦黑处多出一道崭新的火纹——而姜家使者手里的退婚书在无人触碰下无火自燃，烧成灰烬。",
 "emotionalBeats": [
 "压迫：退婚者居高临下宣读、掷书、嘲笑沈家百年天才沦为废人，沈烬全程沉默站立。",
 "反转：沈烬只抬一眼，以烬天碑推演之能一句话点破来者火种隐患，对方笑容僵在脸上。",
 "反转加压：退婚者色厉内荏地以「姜漪澜已是灵师大圆满」相压，暗示她半年内即可破境，差距被刻意拉满。",
 "释放：沈烬平静吐出一句「你来晚了」，语气不重，却让在场所有人闭嘴一拍。",
 "钩子冲击：矿洞塌方、火纹自生、退婚书无火自燃，三件事同帧叠出，把「烬」字从废人烙印一次性翻成悬念。"
}
\`\`\``;
    const { value, strategy } = expectOk<{
      mustDo: string[];
      mustAvoid: string[];
      endingHook: string;
      emotionalBeats: string[];
    }>(raw);
    expect(strategy).toBe('bracket-balance');
    expect(value.mustDo).toHaveLength(5);
    expect(value.mustAvoid).toHaveLength(5);
    expect(value.emotionalBeats).toHaveLength(5);
    expect(value.endingHook.endsWith('烧成灰烬。')).toBe(true);
    expect(value.mustDo[3]).toContain('你来晚了');
    expect(value.mustDo[4]).toContain('青冥小城新生');
    expect(value.emotionalBeats[3]).toContain('你来晚了');
    expect(value.emotionalBeats[4]).toContain('无火自燃');
  });

  it('最小单元：缺数组闭括号 + 对象闭括号齐全 → {a:[1,2]}', () => {
    const { value, strategy } = expectOk<{ a: number[] }>('{"a": [1, 2}');
    expect(strategy).toBe('bracket-balance');
    expect(value).toEqual({ a: [1, 2] });
  });

  it('最小单元：对称场景——数组闭符错收对象 → 修复成功', () => {
    const { value, strategy } = expectOk<{ a: { b: number } }>('{"a": {"b": 1]');
    expect(strategy).toBe('bracket-balance');
    expect(value).toEqual({ a: { b: 1 } });
  });

  it('最小单元：数组内对象缺 `}` 由 `]` 就地收口', () => {
    const { value, strategy } = expectOk<{ a: Array<{ b: number }> }>(
      '{"a": [{"b": 1]'
    );
    expect(strategy).toBe('bracket-balance');
    expect(value).toEqual({ a: [{ b: 1 }] });
  });

  it('杂散 closer `{"a": 1}}` → 不比修复前更坏（不抛异常）', () => {
    const r = salvageJsonParse<{ a: number }>('{"a": 1}}');
    if (r.ok) {
      expect(r.value).toEqual({ a: 1 });
    } else {
      expect(typeof r.error).toBe('string');
      expect(r.error.length).toBeGreaterThan(0);
    }
  });
});
