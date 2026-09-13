/**
 * 平台文笔纪律与克制原则
 * 注入写手/修订 prompt，并供确定性校验使用。
 */
import type { ProseHardRules } from '../types/novel';

export const PROSE_DISCIPLINE_ZH = `## 平台文笔纪律（硬尺）

**描写克制**
- 每个关键动作/物件只抓 1 个核心感官锚，点到即走。
- 禁止同一拍连续写「触觉→温度→气味→质地→神经末梢」。
- 同一意象域（体内热流、伤口黏腻、残留物温热等）全章最多两轮。
- 过渡段（收拾、消毒、看后台）只保留有用信息。

**跨章事实**
- 外貌、伤势部位、攻击落点、昼夜、道具、数值、关键台词须与上章正文一致。
- 冲突时以上章正文为准，不得自创补丁。

**信息边界**
- 角色只能使用其当前认知内的专有名词与内幕；未铺垫的不得当常识脱口。

**标点规范**
- 对白一律用中文双引号“”（大陆网文规范），禁止直角引号「」『』与半角直引号 "。
- 引号内不重复句末标点；叙述层不出现 Markdown 记号（**加粗**、# 标题、\`代码\`）。`;

export const SENSORY_STACK_TOKENS = [
  '温热', '温的', '发烫', '冰凉', '刺骨',
  '黏腻', '黏糊', '黏湿', '湿滑',
  '刺麻', '发麻', '酥麻', '刺痛',
  '铁锈', '腥', '腐臭', '焦糊',
  '粗糙', '细腻', '柔软', '坚硬',
  '神经', '末梢', '毛孔', '汗毛',
  '微微', '隐隐', '缓缓',
] as const;

export function countSensoryStackHits(paragraph: string): number {
  let hits = 0;
  for (const token of SENSORY_STACK_TOKENS) {
    if (paragraph.includes(token)) hits += 1;
  }
  return hits;
}

export function findSensoryStackParagraphs(
  content: string,
  options?: { minHits?: number; maxParagraphLength?: number }
): string[] {
  const minHits = options?.minHits ?? 4;
  const maxParagraphLength = options?.maxParagraphLength ?? 280;
  return content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length <= maxParagraphLength)
    .filter((p) => countSensoryStackHits(p) >= minHits);
}

export interface EngineViolation {
  rule: string;
  severity: 'error' | 'warning';
  description: string;
  suggestion: string;
}

/** 零 LLM 写后确定性校验 */
export function validatePostWrite(
  content: string,
  options?: {
    /**
     * 文风豁免：激活档案声明 punctuationTolerance='ellipsis-emphatic' 时为 true，
     * 该类文风以省略号/破折号为节奏器官，通用禁令误伤。
     */
    allowEmDash?: boolean;
    /**
     * 文风硬规（平台型纪律）：仅当激活档案声明 hardRules 时传入并生效，
     * 未声明的档案零行为变化。需要人物名单的规则（单机检测）经 speakerNames 传入。
     */
    hardRules?: ProseHardRules | null;
    /** 本章可说话人名单（角色名，用于对白归属/单机自言自语检测） */
    speakerNames?: string[];
  }
): EngineViolation[] {
  const violations: EngineViolation[] = [];
  const text = content || '';

  if (/不是[^，。！？\n]{0,30}[，,]?\s*而是/.test(text)) {
    violations.push({
      rule: '禁止句式',
      severity: 'error',
      description: '出现了「不是……而是……」句式',
      suggestion: '改用直述句',
    });
  }
  if (!options?.allowEmDash && text.includes('——')) {
    violations.push({
      rule: '禁止破折号',
      severity: 'error',
      description: '出现了破折号「——」',
      suggestion: '用逗号或句号断句',
    });
  }

  const markers = ['仿佛', '忽然', '竟然', '猛地', '猛然', '不禁', '宛如'];
  let markerCount = 0;
  const found: string[] = [];
  for (const w of markers) {
    const m = text.match(new RegExp(w, 'g'));
    if (m?.length) {
      markerCount += m.length;
      found.push(`${w}×${m.length}`);
    }
  }
  const markerLimit = Math.max(1, Math.floor(text.length / 3000));
  if (markerCount > markerLimit) {
    violations.push({
      rule: '转折词密度',
      severity: 'warning',
      description: `转折/惊讶标记词共${markerCount}次（上限${markerLimit}），${found.join('、')}`,
      suggestion: '改用具体动作传递突然性',
    });
  }

  const stacks = findSensoryStackParagraphs(text, { minHits: 4 });
  if (stacks.length >= 1) {
    const sample =
      stacks[0]!.length > 48 ? `${stacks[0]!.slice(0, 47)}…` : stacks[0]!;
    violations.push({
      rule: '描写过细',
      severity: stacks.length >= 3 ? 'error' : 'warning',
      description: `检测到${stacks.length}处疑似感官堆砌，例："${sample}"`,
      suggestion: '每个物件只留 1 个感官锚',
    });
  }

  const reportTerms = [
    '核心动机', '信息边界', '信息落差', '核心风险', '利益最大化',
    '当前处境', '行为约束', '性格过滤', '情绪外化',
  ];
  const hitTerms = reportTerms.filter((t) => text.includes(t));
  if (hitTerms.length) {
    violations.push({
      rule: '报告术语',
      severity: 'error',
      description: `正文出现分析术语：${hitTerms.join('、')}`,
      suggestion: '改成口语化内心戏或动作',
    });
  }

  if (options?.hardRules) {
    violations.push(
      ...validateStyleHardRules(text, options.hardRules, options.speakerNames || [])
    );
  }

  return violations;
}

// ─────────────────────────────────────────────────────────────────────
// 文风硬规机检（ProseHardRules）：番茄平台型纪律，零 LLM、可复现。
// 仅在激活档案声明 hardRules 时执行；对未声明档案零行为变化。
// ─────────────────────────────────────────────────────────────────────

/**
 * 物理动词（放行式检测：句中出现任一即视为「有动作」）。
 * 单字动词有误放行风险（如「哗啦」的「拉」），但方向是「判过不判死」，
 * 只会漏杀不会错杀，符合机检保守原则。
 */
const PHYSICAL_VERBS: string[] = [
  '踹', '踢', '推', '拽', '拉', '甩', '挥', '劈', '砍', '刺', '捅', '扎',
  '抓', '掐', '拧', '砸', '摔', '掀', '拔', '抡', '掷', '扔', '踩', '踏',
  '跃', '闪', '滚', '爬', '翻', '扑', '咬', '蹬', '拍', '撕', '割', '剁',
  '掏', '扯', '吼', '骂', '喊', '嘶', '嚎', '喷', '溅', '射', '窜', '闯',
  '杀', '撞', '压', '扣', '锁', '举', '顶', '捶', '揍', '掴', '磕', '戳',
  '摸', '跳', '跑', '冲', '跃', '奔', '掠', '掷',
  '撞开', '踹开', '砸开', '推开', '掀开', '拔出', '抽出', '甩出', '挥出',
  '砍下', '斩落', '刺出', '扑上', '扑出', '冲出', '冲进', '闯进', '闯入',
  '翻身', '躲开', '侧身', '低头', '抬头', '回头', '转身', '抬手', '伸手',
  '掐住', '按住', '压住', '掀翻', '打翻', '踢飞', '踩住', '捏碎', '攥紧',
  '握紧', '松手', '抓住', '扯住', '撕开', '割开', '剁下', '拍在', '拍上',
  '递过', '塞进', '扔给', '砸在', '撞上', '穿过', '跨过', '踢开', '点开',
];

/** 突发事态标记（首句合法切口之一） */
const SUDDEN_EVENT_MARKERS: string[] = [
  '突然', '砰', '轰', '咔嚓', '哐', '咚', '当啷', '吱呀', '传来', '响起',
  '炸响', '裂开', '碎了', '塌了', '倒下', '倒地', '惊雷', '警报', '着火',
  '救人', '敌袭', '门被', '窗被', '有人', '出事了',
];

/** 环境铺陈名词（首句/开篇窗口检测） */
const ENV_NOUNS: string[] = [
  '阳光', '月光', '月色', '晨曦', '晨光', '暮色', '夕阳', '余晖', '天空',
  '天色', '空气', '微风', '云层', '薄雾', '浓雾', '细雨', '霜', '星辰',
  '清晨', '黄昏', '傍晚', '深夜', '夜里', '街道', '小镇', '城市', '房间',
  '屋内', '院子', '庭院', '森林', '草原', '走廊', '大厅', '大殿', '教室',
  '病房', '青石', '石板路', '瓦', '树影', '花香', '鸟鸣', '虫鸣', '雪原',
  '荒漠', '戈壁', '夜色', '夜幕', '风', '云', '雾', '雨', '雪', '月', '山',
  '河', '湖', '海', '林', '树', '花', '草', '窗', '门',
];

/** 章末议论/口号抽象词（引号外叙述层，按不重复词计数） */
const ELEVATION_ABSTRACTS: string[] = [
  '道理', '意义', '人生', '命运', '宿命', '成长', '选择', '信念', '意志',
  '决心', '灵魂', '使命', '责任', '价值', '真谛', '未来', '起点', '终点',
  '道路', '世界', '公平', '正义', '强者', '弱者', '初心', '救赎', '考验',
];

/** 章末口号句式（叙述层逐字命中即 error） */
const ENDING_SLOGAN_PHRASES: string[] = [
  '这就是', '所谓的', '从今以后', '从今往后', '总有一天', '等着瞧',
  '终于明白', '懂得了', '才明白', '不过如此', '又能如何', '又能怎样',
  '不是吗', '才刚刚开始', '新的开始', '路还很长', '注定', '他知道',
  '她知道', '他清楚', '她清楚', '这一刻他', '这一刻她',
];

/** 科普讲解段标记（长段无对白无动作时命中即 error） */
const LECTURE_MARKERS: RegExp[] = [
  /原来/, /所谓/, /据说/, /相传/, /众所周知/, /事实上/, /实际上/, /要知道/,
  /也就是说/, /简单来说/, /顾名思义/, /指的是/, /是指/, /被称为/, /叫做/,
  /之所以/, /分为[^。]{0,8}(种|类|级|层|重|期)/, /按[^。]{0,6}划分/,
  /规则是/, /等级从/, /境界从/, /历史上/, /传说中/, /在这个世界/, /这片大陆/,
];

/** 对白跨度：宽松配对「」『』“” 与直引号，内容 ≤200 字 */
const DIALOGUE_RE = /[「『“"]([^」』”"]{1,200})[」』”"]/g;

function stripQuoted(text: string): string {
  return text.replace(DIALOGUE_RE, '');
}

function collectDialogueSpans(
  text: string
): { content: string; before: string; after: string }[] {
  const spans: { content: string; before: string; after: string }[] = [];
  DIALOGUE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIALOGUE_RE.exec(text)) !== null) {
    spans.push({
      content: m[1] || '',
      before: text.slice(Math.max(0, m.index - 40), m.index),
      after: text.slice(m.index + m[0].length, m.index + m[0].length + 18),
    });
  }
  return spans;
}

function hasPhysicalAction(sentence: string): boolean {
  return PHYSICAL_VERBS.some((v) => sentence.includes(v));
}

function firstSentenceOf(text: string): string {
  const para = paragraphsOf(text)[0] || '';
  const m = para.match(/^[\s\S]{1,80}?[。！？…”』」]/);
  return (m ? m[0] : para).trim();
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n|\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 环境名词「种类」计数（同一词多处出现只计 1）。
 * 长词优先去重：短词若是已命中长词的子串（「月光」里的「月」、「门」在
 * 无复合命中时）不重复计数——否则「月光洒落窗前」会同时命中 月光/月/窗/门
 * 四个词，正常开篇被误判为环境堆砌 error。
 */
export function envNounCount(text: string): number {
  const present = ENV_NOUNS.filter((w) => text.includes(w));
  const sorted = [...present].sort((a, b) => b.length - a.length);
  const counted: string[] = [];
  for (const w of sorted) {
    if (!counted.some((c) => c.includes(w))) counted.push(w);
  }
  return counted.length;
}

/** 对白字占比（引号内字数 / 去空白总字数） */
export function computeDialogueCharRatio(text: string): number {
  const spans = collectDialogueSpans(text);
  const dialogueChars = spans.reduce((s, d) => s + d.content.length, 0);
  const total = text.replace(/\s/g, '').length;
  if (!total) return 0;
  return dialogueChars / total;
}

/**
 * 本章可说话人：出场角色优先（involvedCharacterIds），无标记回落全员。
 */
export function collectSpeakerNames(
  characters: { id: string; name: string }[],
  involvedIds?: string[] | null
): string[] {
  const involved = involvedIds?.length
    ? characters.filter((c) => involvedIds.includes(c.id))
    : characters;
  return (involved.length ? involved : characters)
    .slice(0, 24)
    .map((c) => c.name)
    .filter((n) => n && n.length >= 2);
}

/** 文风硬规机检：由 validatePostWrite 在档案声明 hardRules 时调用 */
export function validateStyleHardRules(
  content: string,
  rules: ProseHardRules,
  speakerNames: string[] = []
): EngineViolation[] {
  const out: EngineViolation[] = [];
  const text = content || '';
  const total = text.replace(/\s/g, '').length;
  if (total < 40) return out; // 残段不判（防草稿碎片误报）

  const paras = paragraphsOf(text);

  // ── 1) 开局第一句必须「事故化」切入 ──
  if (rules.openingCutIn) {
    const s1 = firstSentenceOf(text);
    const startsWithDialogue = /^[「『“"]/.test(s1);
    const hasDialogueInside = /[「『“"][^」』”"]{2,}[」』”"]/.test(s1);
    const hasSudden = SUDDEN_EVENT_MARKERS.some((w) => s1.includes(w));
    const hasAction = hasPhysicalAction(s1);
    if (!startsWithDialogue && !hasDialogueInside && !hasSudden && !hasAction) {
      const envish = envNounCount(s1) >= 2;
      out.push({
        rule: '开局铺环境',
        severity: 'error',
        description: `第一句不是台词/动作/突发事态切入${
          envish ? '（环境铺陈开场）' : '（静态说明开场）'
        }："${s1.slice(0, 42)}${s1.length > 42 ? '…' : ''}"`,
        suggestion:
          '首句改为：一句台词、一个物理动词开头的动作，或突发事件（爆炸/闯入/死讯/账单到期）；天气景物来历全部后置或删除。',
      });
    }
  }

  // ── 2) 开头环境堆砌（前两段无对白无动作，或环境名词密集） ──
  if (rules.forbidOpeningEnvStack && paras.length >= 2) {
    const window2 = `${paras[0] || ''}\n${paras[1] || ''}`.slice(0, 420);
    const hasQuoteInWindow = /[「『“"][^」』”"]{2,}[」』”"]/.test(window2);
    const windowAction = hasPhysicalAction(window2);
    const envN = envNounCount(window2);
    if (!hasQuoteInWindow && !windowAction && envN >= 4) {
      out.push({
        rule: '开头环境堆砌',
        severity: 'error',
        description: `开篇两段无对白无动作、环境名词 ${envN} 个（移动端读者 3 秒划走型开头）`,
        suggestion: '把前两段压成一句场景锚（≤15 字），腾出的篇幅让人物开口或让事件发生。',
      });
    }
  }

  // ── 3) 对白占比带（≥400 字才判，防短样文误报） ──
  const ratioMin = rules.dialogueRatioMin;
  const ratioMax = rules.dialogueRatioMax;
  if ((ratioMin !== undefined || ratioMax !== undefined) && total >= 400) {
    const ratio = computeDialogueCharRatio(text);
    const pct = Math.round(ratio * 100);
    if (ratioMin !== undefined && ratio < ratioMin) {
      out.push({
        rule: '对白占比不足',
        severity: 'error',
        description: `对白字占比 ${pct}%，低于硬规下限 ${Math.round(ratioMin * 100)}%（信息/冲突/打脸必须装进对白）`,
        suggestion:
          '把叙述改成人物交锋：主角心里想一遍，不如当面问一遍；长段独白改为有人抛话、有人接招的多回合对白。',
      });
    }
    if (ratioMax !== undefined && ratio > ratioMax) {
      out.push({
        rule: '对白占比过高',
        severity: 'warning',
        description: `对白字占比 ${pct}%，高于目标带上限 ${Math.round(ratioMax * 100)}%`,
        suggestion: '个别关键对白补动作与外部证据（捏皱的收据、停在中途的拉链），避免纯嘴炮。',
      });
    }

    // ── 3b) 单机自言自语：多处对白全部归属同一人 ──
    if (rules.forbidSoloMonologue && speakerNames.length >= 2 && total >= 400) {
      const spans = collectDialogueSpans(text);
      if (spans.length >= 4) {
        const speakers = new Set<string>();
        let attributed = 0;
        for (const sp of spans) {
          const ctx = `${sp.before}${sp.after}`;
          for (const name of speakerNames) {
            if (ctx.includes(name)) {
              speakers.add(name);
              attributed += 1;
            }
          }
        }
        if (attributed >= 3 && speakers.size <= 1) {
          out.push({
            rule: '单机自言自语',
            severity: 'error',
            description: `全章 ${spans.length} 处对白可归属说话人只有 ${
              speakers.size === 1 ? `「${[...speakers][0]}」一人` : '零人（疑似自问自答）'
            }，无人接招`,
            suggestion:
              '杜绝闭门自言自语：给主角配一个当场对手/搭档/接线人，把关键信息改成交换而非独白；纯内心推剧情的段落删掉改成行动。',
          });
        }
      }
    }
  }

  // ── 4) 章末假升华/口号（剥掉引号内的台词，只审叙述层） ──
  if (rules.endingNoElevation) {
    const endingNarration = stripQuoted(text.slice(-320));
    const sloganHits = ENDING_SLOGAN_PHRASES.filter((p) =>
      endingNarration.includes(p)
    );
    if (sloganHits.length) {
      out.push({
        rule: '结尾假升华',
        severity: 'error',
        description: `章末叙述出现升华/口号句式：${sloganHits.slice(0, 3).join('、')}`,
        suggestion:
          '章末只留钩子：删掉感悟与宣言，停在台词、动作、道具变化或新威胁入场；删掉最后一段而剧情不断裂，就该删。',
      });
    }
    const abstractHits = ELEVATION_ABSTRACTS.filter((w) =>
      endingNarration.includes(w)
    );
    if (abstractHits.length >= 3) {
      out.push({
        rule: '结尾议论升华',
        severity: 'error',
        description: `章末叙述堆叠抽象词 ${abstractHits.length} 个（${abstractHits
          .slice(0, 5)
          .join('、')}），疑似哲理总结`,
        suggestion: '章末禁止议论：抽象词全删，只写看得见的动作与听得见的台词。',
      });
    } else if (abstractHits.length === 2) {
      out.push({
        rule: '结尾议论苗头',
        severity: 'warning',
        description: `章末叙述出现抽象词：${abstractHits.join('、')}`,
        suggestion: '确认不是在总结人物成长或点题；是则删，改为事件收尾。',
      });
    }
    const lastPara = paras[paras.length - 1] || '';
    if (
      lastPara &&
      !/[「『“"]/.test(lastPara) &&
      !hasPhysicalAction(lastPara) &&
      abstractHits.length >= 1
    ) {
      out.push({
        rule: '结尾无动作钩子',
        severity: 'warning',
        description: `最后一段既无台词也无动作："${lastPara.slice(0, 40)}…"`,
        suggestion: '结尾落在未完成的动作或一句有信息量的台词上，给下一章留应答点。',
      });
    }
  }

  // ── 5) 大段科普讲解 + 超长段落（移动端阅读纪律） ──
  const lectureHits: string[] = [];
  let longParas = 0;
  for (const p of paras) {
    if (rules.maxParagraphLen !== undefined && p.length > rules.maxParagraphLen) {
      longParas += 1;
    }
    if (!rules.noLectureParagraphs) continue;
    if (p.length < 130) continue;
    if (/[「『“"]/.test(p)) continue; // 含台词不判
    if (hasPhysicalAction(p)) continue; // 有动作不判
    const hit = LECTURE_MARKERS.find((re) => re.test(p));
    if (hit) {
      lectureHits.push(`"${p.slice(0, 30)}…"`);
      if (lectureHits.length >= 2) break;
    }
  }
  if (lectureHits.length) {
    out.push({
      rule: '科普讲解段',
      severity: 'error',
      description: `检测到 ${lectureHits.length} 处百字以上无对白无动作的讲解段，例：${lectureHits.join(' ')}`,
      suggestion:
        '设定信息拆进对白分歧与当场动作：两个人对一条规则理解不同，胜过作者讲解一百字。',
    });
  }
  if (longParas > 0 && rules.maxParagraphLen !== undefined) {
    out.push({
      rule: '段落超长',
      severity: 'warning',
      description: `${longParas} 个段落超过 ${rules.maxParagraphLen} 字（移动端一屏换两次内容的纪律）`,
      suggestion: '拆成 1-3 句短段；重点句单独成段做重音。',
    });
  }

  return out;
}
