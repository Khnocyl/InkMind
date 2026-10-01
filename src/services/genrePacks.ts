/**
 * 题材规则包：写入前注入 prompt，约束节奏、禁忌与常见崩坏点。
 *
 * 除「禁忌/应具备/审校关注/附加黑名单」这套审计向字段外，每个题材还携带
 * 创作向的执行层维度：
 * - beatStructure  章节四段式（起→承→转→合），避免每章同构
 * - scenePatterns  招牌场景的具体拍法（比抽象要求更可执行）
 * - payoffDesign   本题材读者的兑现点及其伦理校正
 * - perspectiveRules 人称/视角纪律
 * - relationshipRules 人物关系法则（配角反应与羁绊生成规则）
 * - styleNorms     题材常见数值规格（软性参考，冲突时以项目硬约束为准）
 *
 * 全部内容为本项目自有表述，仅进正文层 prompt，不进大纲/世界观等结构层。
 */

/** 题材常见数值规格（软性参考） */
export interface GenreStyleNorms {
  /** 单章参考字数 */
  targetWords?: number;
  /** 段落参考长度（字） */
  paragraphLen?: number;
  /** 对白占比参考（0–100） */
  dialogueRatio?: number;
}

export interface GenrePack {
  id: string;
  name: string;
  /** 用于匹配 project.genre / config.genre */
  aliases: string[];
  description: string;
  /** 节奏与爽点总纲（一句话） */
  pacing: string;
  /** 章节四段式：起→承→转→合 */
  beatStructure?: string;
  /** 招牌场景的具体拍法 */
  scenePatterns?: string[];
  /** 爽点 / 情绪兑现设计 */
  payoffDesign?: string[];
  /** 人称与视角纪律 */
  perspectiveRules?: string[];
  /** 人物关系法则 */
  relationshipRules?: string[];
  /** 题材常见数值规格（软性） */
  styleNorms?: GenreStyleNorms;
  /** 禁忌（写作与审校都参考） */
  taboos: string[];
  /** 题材必给读者的感觉/要素 */
  mustHaves: string[];
  /** 审校额外关注 */
  auditHints: string[];
  /** 叠到黑名单的额外词 */
  extraBlacklist?: string[];
}

/**
 * 内置题材库。
 *
 * 顺序即匹配优先级（resolveGenrePack 取首个命中）：越是窄题材越靠前，
 * 「通用网文」始终垫底。新增题材时必须检查别名是否与前面的包重叠。
 */
export const GENRE_PACKS: GenrePack[] = [
  // ────────────────────────────── 东方幻想 ──────────────────────────────
  {
    id: 'xuanhuan',
    name: '玄幻修真',
    aliases: ['玄幻', '东方玄幻', '异界', '高武', '热血玄幻', '史诗玄幻'],
    description: '力量体系森严、以实力定尊卑，视觉奇观与能量对轰是主表达，避免无脑碾压与境界瞬跳。',
    pacing: '章内小兑现+章末钩子；战力展示用具体招式与空间反馈，忌空喊境界名。',
    beatStructure: '遭遇压制或发现机缘 → 受挫/苦修/险死 → 底牌掀开、以暴制暴 → 清点所得并引出更强的敌人',
    scenePatterns: [
      '机缘秘境：先设门槛（阵法/守护兽/竞争者），获取过程必付代价，宝物不给现成的',
      '越阶反杀：先用绝对压制把绝望感拉满，再亮底牌，且底牌必须带后遗症（虚弱/重创/寿元）',
      '势力打脸：反派先亮傲慢，主角隐忍不发，再在众目睽睽下用一招或一件物品碾碎质疑',
    ],
    payoffDesign: [
      '纯粹的力量释放：前期被规则与强权压住，突破后以绝对姿态碾碎算计',
      '收获反馈：打赢之后要写「清算所得」，但对象要分档——对死敌可冷酷，对可敬的对手留片刻沉默',
    ],
    perspectiveRules: [
      '第三人称限知，聚焦主角视角；表现他人震惊用生理与动作外显（倒吸冷气、杯子脱手），不写他人内心独白',
      '战斗中每个大开大合的招式必须绑定具体角色名，防止混战画面失焦',
    ],
    relationshipRules: [
      '慕强逻辑：配角态度随主角实力展现发生反转，这是世界的运行规则而非势利',
      '牵藤带瓜：打了小的来老的，任一反派背后可牵出宗门或家族，冲突要有延续性',
    ],
    styleNorms: { targetWords: 3500, paragraphLen: 175, dialogueRatio: 25 },
    taboos: [
      '境界无铺垫连跳两级以上',
      '主角无代价碾压同阶全体',
      '天材地宝随手捡完无争夺',
      '反派降智只为送经验',
      '用大段功法说明书代替冲突',
    ],
    mustHaves: ['可感知的实力差', '资源/因果代价', '至少一处信息差或反转', '具体地理/宗门势力触感'],
    auditHints: ['战力是否自洽', '功法 debuff 是否被忘记', '势力关系是否突变无因'],
    extraBlacklist: ['一股恐怖的气息', '仿佛要撕裂苍穹', '整个人都呆住了'],
  },
  {
    id: 'xianxia',
    name: '仙侠',
    aliases: ['仙侠', '修仙', '修真', '传统修真', '仙途', '洪荒'],
    description: '以长生意境与出世张力为骨，讲究道心权衡与因果牵绊，笔法留白，忌写成纯粹的力量碾压。',
    pacing: '慢起势、重余韵；一章一次心境或道途抉择，打斗讲究分寸与代价。',
    beatStructure: '尘缘或道途起念 → 闭关/游历中积累与牵绊 → 因果一线引动爆发 → 尘缘落定、道心改变',
    scenePatterns: [
      '论道与破境：突破写成对自身认知的变化（放下了什么、看清了什么），而非气浪特效堆积',
      '仙门试炼：规则与规矩先立住，胜负之外还要交代人情与立场',
      '了断尘缘：旧人心愿与长生的冲突，用一次具体的选择收束，而非空谈天道',
    ],
    payoffDesign: [
      '出尘感：主角在众人争抢处转身离去，以「不要」形成更高维度的压制',
      '道法兑现：术法以意象与分寸动人（一剑分水、以气养物），不堆砌夸张破坏力',
    ],
    perspectiveRules: [
      '第三人称限知，允许在关键节点用极短段落写主角的内心权衡，但禁长篇悟道独白',
      '擅用旁观者视角侧写主角的仙姿与威望，不写「众人都惊呆了」这类概括句',
    ],
    relationshipRules: [
      '师门即秩序：长辈、同门、外门之间有一套不成文的礼数与规矩，越礼必须有后果',
      '因果有主：欠下的人情与恩义要记账，后续章节要有人来还或来讨',
    ],
    styleNorms: { targetWords: 3000, paragraphLen: 160, dialogueRatio: 20 },
    taboos: [
      '把仙侠写成数值化的打怪升级',
      '主角逢战必赢且无一处因果牵绊',
      '悟道段落实为大段说理与鸡汤',
      '滥用夸张破坏力描写却无空间尺度感',
    ],
    mustHaves: ['境界与道心的对应关系', '一桩需要了断的尘缘或因果', '留白式的收束'],
    auditHints: ['寿命/境界设定是否被违反', '因果线与人情账是否回收'],
    extraBlacklist: ['道韵悠长', '岁月静好', '心中一片空明'],
  },
  {
    id: 'wuxia',
    name: '武侠',
    aliases: ['武侠', '传统武侠', '新派武侠', '江湖'],
    description: '招式、江湖规矩与人情冷暖优先于数值；刀光有声，恩仇有因。',
    pacing: '短打干净；对话藏锋；一章一事，恩怨推进，忌无意义游山玩水。',
    beatStructure: '江湖事上身 → 摸清规矩与对手 → 一场硬桥硬马的交手 → 恩怨落地、新债又起',
    scenePatterns: [
      '狭路相逢：交手前先交待双方的身份、忌讳与名利立场，出手才有分量',
      '酒楼是非：一场戏里同时压着人情、规矩与面子，冲突不必动手也紧张',
      '雨夜追杀：用环境限制（湿滑、视野、无关路人）逼出角色的取舍',
    ],
    payoffDesign: [
      '招式兑现：每一招都要有可感的方位、劲路与后果（兵器破损、衣袖割裂）',
      '恩义兑现：守诺与忍让在关键处换来实际的回报或转机，而非空喊义气',
    ],
    perspectiveRules: [
      '第三人称限知，招式描写要落到角色的呼吸、步眼与兵器重量上',
      '限制全知视角剧透杀招，让读者与人物同步判断',
    ],
    relationshipRules: [
      '江湖规矩优先：门派、辈分、恩怨的规矩构成人物行为的边界，破规必被议论或报复',
      '恩仇对等：欠下的恩要还，结下的仇要偿，两笔账都要在故事里走动',
    ],
    styleNorms: { targetWords: 3000, paragraphLen: 150, dialogueRatio: 30 },
    taboos: [
      '无门派规矩的随意杀人无后果',
      '轻功满天飞却无距离感',
      '把武侠写成修仙飞升',
      '全程内心独白不交手也不交谈',
    ],
    mustHaves: ['招式/身法细节', '江湖规矩或人情', '恩仇或承诺线'],
    auditHints: ['是否违反江湖规矩却无人反应', '兵器与身法是否前后一致'],
    extraBlacklist: ['那一刻', '心中暗道'],
  },
  {
    id: 'qihuan',
    name: '奇幻',
    aliases: ['奇幻', '西幻', '剑与魔法', '魔法', '西式奇幻'],
    description: '设定自洽的异世界与团队冒险；魔法有规则与代价，种族与神祇有立场。',
    pacing: '探索→受挫→新认知；每章推进一条设定或一条信任关系，忌设定讲座。',
    beatStructure: '委托或威胁入场 → 队伍试探与规则摸索 → 代价显露的正面冲突 → 收获与新的更大谜团',
    scenePatterns: [
      '地下遗迹：用照明、补给、退路三条限制制造压力，谜题要有可回溯的线索',
      '多族谈判：各方诉求都要站得住脚，靠利益交换而非善恶站队推动',
      '魔法对决：必须先讲清规则与消耗，胜负取决于对规则的利用而非喊咒语',
    ],
    payoffDesign: [
      '规则被用活：主角用被人忽视的规则细节翻盘，读者有「原来如此」的解谜快感',
      '羁绊兑现：队伍里被轻视的成员在关键处补位，用行动而非台词完成角色高光',
    ],
    perspectiveRules: [
      '第三人称限知，可轮换视角但每次至少写满一个完整场景，头部要给出视角提示',
      '非人种族的感知与语言要与人类区分开，不能只是换个名字的人类',
    ],
    relationshipRules: [
      '队伍磨合：信任靠共同经历换取，分歧必须发生在具体决策上而非性格标签',
      '神祇与凡人：信仰能被兑现也能被辜负，亵渎与祈祷都要有可见后果',
    ],
    styleNorms: { targetWords: 3500, paragraphLen: 170, dialogueRatio: 28 },
    taboos: [
      '魔法万能且无消耗无副作用',
      '种族只贴标签没有文化差异',
      '设定前后互相打架',
      '队伍成员沦为没有欲望的功能位',
    ],
    mustHaves: ['可理解的魔法/设定限制', '至少一处团队分歧', '异世界的具体物产与习俗'],
    auditHints: ['设定是否吃书', '魔法消耗与后果是否被遗忘'],
  },
  {
    id: 'kehuan',
    name: '科幻',
    aliases: ['科幻', '赛博', '赛博朋克', '硬科幻', '星际', '未来', '太空歌剧'],
    description: '规则与设定自洽；技术有代价与限制；用具体界面/机制代替黑箱神迹。',
    pacing: '问题—尝试—新信息；每章揭示一点规则或风险；忌纯设定讲座。',
    beatStructure: '异常被发现 → 试探与代价试探 → 规则被突破或反噬 → 解决问题同时暴露更大的系统性风险',
    scenePatterns: [
      '界面与舱内：用仪表、告警、延迟这些具体交互写紧张感，不靠形容词',
      '人与非人：AI/改造者/异种的心智差异要落在语言节奏与价值取舍上',
      '代价演示：先让读者看清某技术的使用成本，再让主角被迫使用它',
    ],
    payoffDesign: [
      '智性兑现：主角靠对机理的理解找到出路，答案事后可被读者复盘',
      '尺度冲击：用一个具体可感的对照（时间、距离、人口）替代空洞的宏大',
    ],
    perspectiveRules: [
      '第三人称限知，技术信息通过操作与故障呈现，禁效果图式旁白',
      '涉及时间/距离时给出明确参照，防止尺度失真',
    ],
    relationshipRules: [
      '利益与准则：阵营差异源于资源与理念分配，冲突要有可计算的利害',
      '信任可测量：关系变化要落在权限、数据或救命操作的让渡上',
    ],
    styleNorms: { targetWords: 3200, paragraphLen: 170, dialogueRatio: 28 },
    taboos: [
      '科技万能无副作用',
      '前后设定互相打架',
      '用「量子」一词糊弄因果',
      '全员只有功能没有欲望',
    ],
    mustHaves: ['可理解的规则限制', '具体技术触感', '选择的代价'],
    auditHints: ['设定是否吃书', '时间线/通讯延迟是否合理'],
  },
  {
    id: 'xuanyi',
    name: '悬疑推理',
    aliases: ['悬疑', '推理', '本格', '刑侦', '诡案', '犯罪', '社会派'],
    description: '线索可回溯；真相不靠最后一章乱编；氛围用细节而非空喊恐怖。',
    pacing: '线索投放—误导—修正；章末新疑点；忌连续回忆灌设定。',
    beatStructure: '异状或发现现场 → 搜集线索与伪因果 → 关键伪装被戳破、二次危机 → 推理重构并留下新钩子',
    scenePatterns: [
      '现场勘查：证据要有位置与状态，读者掌握的信息不得少于侦探',
      '交叉问询：每个人的说法互相咬合又各有隐瞒，靠对比而非直觉推进',
      '伪解答被推翻：先给出一个成立度高的错误答案，再用既有关怀中的线索打碎它',
    ],
    payoffDesign: [
      '推理兑现：破案依据必须是前文客观出现过的细节，禁止凭灵感拍脑袋',
      '人性兑现：动机扎根于现实的贪惧与结构困境，不靠临时发明的疯癫',
    ],
    perspectiveRules: [
      '第三人称限知，严格锁在侦探视角；不切凶手或受害者内心以保守悬念',
      '叙述可保留但不可欺骗：允许给出易被误读的客观描写，禁止直接写假事实',
    ],
    relationshipRules: [
      '猜忌网：没有无缘无故的信任，盟友之间也有信息保留与试探',
      '猎手猎物随时互换：谁掌握的信息多，谁就在上风，身份要随信息流动',
    ],
    styleNorms: { targetWords: 3200, paragraphLen: 180, dialogueRatio: 30 },
    taboos: [
      '关键线索未出场却直接破案',
      '凶手动机临时发明',
      '用超自然无规则收尾现实案件',
      '主角全知视角剧透真相',
    ],
    mustHaves: ['可检索线索', '人物隐瞒动机', '具体场景证据'],
    auditHints: ['时间线是否可推', '证据是否前后矛盾'],
    extraBlacklist: ['真相只有一个', '背后隐藏着惊天秘密'],
  },

  // ────────────────────────────── 都市 · 情感 ──────────────────────────────
  {
    id: 'dushi',
    name: '都市现实',
    aliases: ['都市', '现实', '职场', '都市异能', '都市修真', '商战'],
    description: '社会关系、利益与信息差驱动；能力再强也要吃人间烟火约束。',
    pacing: '对话推进信息；每章至少一个利益节点或关系变化；忌纯装逼无代价。',
    beatStructure: '现实难题压上桌 → 试错与被规则卡住 → 用信息差或人情完成破局 → 局面改善但代价与麻烦同步升级',
    scenePatterns: [
      '饭局与谈判：一桌人各有诉求，靠座次、话术与让步次序写博弈',
      '职场交锋：胜负落在流程、邮件、审批这些现代规则上，而非拳头',
      '群聊与舆论：让信息在网上发酵，用可见的传播链制造压力',
    ],
    payoffDesign: [
      '规则内反制：主角用程序或契约把对手逼进死角，读者能看懂凭什么赢',
      '被认可感：付出换来具体回报（职位、订单、尊重），不靠旁人吹捧',
    ],
    perspectiveRules: [
      '第三人称限知，社会资源与职级边界要写清，越权就要承担后果',
      '心理活动适度，大量情绪用行为与对话外化',
    ],
    relationshipRules: [
      '人脉即资源：关系的建立与消耗要记账，不搞单方面索取',
      '利益为先：对手有智商与诉求，倒戈需要理由',
    ],
    styleNorms: { targetWords: 3000, paragraphLen: 160, dialogueRatio: 35 },
    taboos: [
      '无视法律与舆论的无限横行',
      '配角工具人只会跪舔',
      '能力升级无社会反馈',
      '大段成功学鸡汤',
    ],
    mustHaves: ['具体职业/场景', '利益或人情博弈', '对手有智商'],
    auditHints: ['人际关系是否突变', '金钱/权势获取是否跳步'],
    extraBlacklist: ['嘴角勾起一抹弧度', '空气瞬间安静'],
  },
  {
    id: 'yanqing',
    name: '现代言情',
    aliases: ['言情', '现代言情', '甜宠', '虐恋', '爱情', '都市言情'],
    description: '关系张力与情绪兑现优先；冲突来自选择与误解，而非纯巧合。',
    pacing: '拉扯—靠近—新阻碍；章末情绪钩子；忌连续纯撒糖无推进。',
    beatStructure: '关系遇到新变量 → 试探与退让的拉扯 → 某个真相或选择把关系逼到临界 → 关系状态改变并埋下新的不安',
    scenePatterns: [
      '拥挤处的克制：用不经意的靠近与错身写心动，先写身体反应再写心理',
      '修罗场：不靠吵闹，靠克制的失态（话到一半停住、杯子放重）写情绪失控',
      '卸下防备：强势方在脆弱时刻显露依赖，用具体动作而非长台词',
    ],
    payoffDesign: [
      '偏爱与例外：世界对谁都一样，唯独对一个人不同，用具体事例证明',
      '误解澄清：真相揭开时改变的是双方的位置关系，而不只是情绪',
    ],
    perspectiveRules: [
      '以一方视角为主的第三人称限知，便于读者代入',
      '关键情感转折处可切一小段对方视角，用心理落差放大张力，但每次不超过一个场景',
    ],
    relationshipRules: [
      '选择高于巧合：关系推进必须由人物选择驱动，外力只做催化剂',
      '双方都要有独立诉求与底线，不能一方只为另一方而活',
    ],
    styleNorms: { targetWords: 2800, paragraphLen: 140, dialogueRatio: 40 },
    taboos: [
      '用羞辱人格当情趣且无反思',
      '女主/男主无理由反复降智',
      '第三者工具化无动机',
      '大段心灵鸡汤收尾',
    ],
    mustHaves: ['关系状态变化', '至少一处具体互动细节', '冲突有人物动机'],
    auditHints: ['感情态度是否无故翻转', '是否只有误会驱动全剧'],
    extraBlacklist: ['心中一软', '眼眶不争气地红了'],
  },
  {
    id: 'guyan',
    name: '古代言情',
    aliases: ['古言', '古代言情', '古风', '宫斗', '宅斗', '闺阁'],
    description: '礼制与家族秩序下的情感博弈；进退都要讲名分与分寸，情绪藏在规矩缝隙里。',
    pacing: '一局一进：每章动一次位分、婚约或家族态度的齿轮。',
    beatStructure: '名分或婚约起变 → 借规矩试探与布局 → 一次宴席/朝堂/家法的正面交锋 → 位分与人心同步改写',
    scenePatterns: [
      '宴席交锋：座次、赏赐、称呼都是武器，胜负落在礼数细节里',
      '家法与私情：用祠堂、家书、族老施压，逼角色在情与规之间选边',
      '书信与物件：以一封信、一支旧钗承载无法直言的心意与把柄',
    ],
    payoffDesign: [
      '以弱胜强：主角靠对规矩的熟练运用反制高位者，赢得有理有据',
      '名分兑现：情感推进同时要落到实际名分或家族态度的改变上',
    ],
    perspectiveRules: [
      '第三人称限知，礼制称谓必须准确，越礼之处要被他人指出',
      '心理描写含蓄，多用动作、物件与留白代替直白抒情',
    ],
    relationshipRules: [
      '家族优先：个人情感要面对家族利益，亲疏格局决定谁帮谁害',
      '主仆与妯娌：下人、妯娌、婆母各有立场，人情往来要记挂',
    ],
    styleNorms: { targetWords: 3000, paragraphLen: 150, dialogueRatio: 35 },
    taboos: [
      '无视礼教却能毫无后果地横行',
      '用现代口吻与价值观直接评判古代人物',
      '宅斗全靠下毒栽赃而无制度博弈',
      '所有人只为男女主感情服务',
    ],
    mustHaves: ['名分或婚约的变化', '礼数与分寸的细节', '一次布局交锋'],
    auditHints: ['礼制/称谓是否出错', '位分与家族态度是否跳变'],
    extraBlacklist: ['眸光流转', '唇角微扬', '心中五味杂陈'],
  },
  {
    id: 'danmei',
    name: '耽美',
    aliases: ['耽美', 'BL', '纯爱', '原耽'],
    description: '双男主关系的分寸与拉扯为核心；感情之外两人各自要有立得住的处境与目标。',
    pacing: '克制试探—默契加深—身份或立场冲突；情绪张力靠留白而非直白表白。',
    beatStructure: '两人被共同处境绑定 → 试探边界与默契累积 → 立场/身份的秘密被撞破 → 关系重新定义并面对外部阻力',
    scenePatterns: [
      '并肩做事：用一次具体协作写默契，眼神与配合替代告白',
      '界限被打乱：意外同处一室或受伤照护，写清越界的犹豫与克制',
      '立场对立：当各自阵营要求相悖，两人必须在台面上做出选择',
    ],
    payoffDesign: [
      '唯一性：对方在众人中只对彼此不同，用具体待遇差异体现',
      '并肩兑现：关键时刻两人配合无间，靠能力而非台词完成高光',
    ],
    perspectiveRules: [
      '第三人称限知，择一主视角推进，另一方的心理靠外在细节侧写',
      '情感表达含蓄，重要心意用行动与物件承载',
    ],
    relationshipRules: [
      '两人都要有独立目标，感情是交汇而非替代',
      '外部阻力来自立场与处境，不能只靠误会撑剧情',
    ],
    styleNorms: { targetWords: 2800, paragraphLen: 140, dialogueRatio: 42 },
    taboos: [
      '把配角写成只会助攻的工具',
      '一方完全丧失主体性只为另一方存在',
      '用狗血误会反复拖延感情推进',
      '情绪全靠形容词堆砌',
    ],
    mustHaves: ['关系阶段的明确变化', '一次具体协作或照护', '外部立场冲突'],
    auditHints: ['两人动机是否各自成立', '情绪是否靠事件而非旁白推动'],
  },
  {
    id: 'qingxiaoshuo',
    name: '轻小说',
    aliases: ['轻小说', '二次元', '日系', '轻喜剧'],
    description: '轻快节奏、角色魅力优先；日常与奇幻混搭，吐槽与反差是主要笑点来源。',
    pacing: '短段落、快切场景；每章一个趣味事件并推进一点关系。',
    beatStructure: '日常被意外打断 → 角色以各自方式应对、笑料累积 → 反差或真相翻转 → 收尾回到日常但关系悄然变了',
    scenePatterns: [
      '社团/校园日常：靠角色间的固定梗与互相拆台写群像',
      '能力反差：把超常设定塞进日常场景（做饭、考试、打工），笑点来自错位',
      '内心吐槽：用短促的自嘲打断严肃场面，但每次不超过两三句',
    ],
    payoffDesign: [
      '反差高光：平时最不可靠的角色在关键时刻靠得住',
      '关系升温：用一个共同的小秘密或约定完成阶段推进',
    ],
    perspectiveRules: [
      '第一人称或近距离第三人称，语感轻快，段落短，禁大段景物描写',
      '吐槽要贴着当前动作，不做脱离场景的段子',
    ],
    relationshipRules: [
      '群像轮转：配角各有登场章节，不能永远只当背景',
      '亲近靠小事积累：一起吃饭、借东西、值日这些日常行为推进关系',
    ],
    styleNorms: { targetWords: 2600, paragraphLen: 140, dialogueRatio: 45 },
    taboos: [
      '吐槽脱离场景变成段子堆砌',
      '角色只有萌点没有欲望',
      '日常段落毫无推进地重复',
      '感情线靠突然告白一步到位',
    ],
    mustHaves: ['一个完整趣味事件', '至少一次反差发挥', '关系的小幅推进'],
    auditHints: ['笑点是否服务剧情', '角色是否前后一致'],
    extraBlacklist: ['嘴角抽搐了一下'],
  },

  // ────────────────────────────── 惊悚 · 悬疑变体 ──────────────────────────────
  {
    id: 'kongbu',
    name: '恐怖惊悚',
    aliases: ['恐怖', '惊悚', '心理惊悚', '克苏鲁', '恐惧'],
    description: '恐惧来自未知与失控的累积；不靠血浆与尖叫，靠规则不明与判断失灵。',
    pacing: '信息缺失→错误判断→代价显现；压力持续加压，间歇用静止制造不安。',
    beatStructure: '日常出现不对劲的细节 → 试探并付出小代价 → 规则被误解导致重创 → 暂时脱身但认知已被改写',
    scenePatterns: [
      '规则不明：先展示一次违反规则的后果，让读者和角色同步学会恐惧',
      '静止压迫：在最安静处埋一处不该存在的动静，用环境细节而非形容词',
      '判断失灵：让最可靠的感官或同伴出问题，恐惧由不可信而非强力产生',
    ],
    payoffDesign: [
      '认知满足：真相揭开时读者能回忆出前文的伏笔，恐惧因理解而升级',
      '幸存代价：脱身必须付出具体代价（伤残、记忆、同伴），不做无损通关',
    ],
    perspectiveRules: [
      '第三人称限知或第一人称，严格限制信息面；不切到怪物视角解释动机',
      '禁止用「莫名的恐惧」这类概括句替代具体感知错乱',
    ],
    relationshipRules: [
      '压力下的分裂：恐惧会侵蚀信任，同伴的失误要有现实理由',
      '牺牲与隐瞒：有人隐瞒信息，代价要由集体承担并引发后续冲突',
    ],
    styleNorms: { targetWords: 2800, paragraphLen: 150, dialogueRatio: 22 },
    taboos: [
      '用突然出现的巨响代替持续压迫',
      '怪物无规则且不可理解到读者无法复盘',
      '角色降智只为送死',
      '用血浆与描摹残肢代替恐惧',
    ],
    mustHaves: ['可推理的恐怖规则', '一次代价明确的重创', '认知被改写的收束'],
    auditHints: ['恐怖规则是否前后一致', '角色是否无缘由变傻'],
    extraBlacklist: ['不禁头皮发麻', '脊背一阵发凉', '心里涌起一股莫名的恐惧'],
  },
  {
    id: 'lingyi',
    name: '灵异怪谈',
    aliases: ['灵异', '怪谈', '民俗', '都市怪谈', '驱魔', '阴阳'],
    description: '以民间禁忌与因果报应为底色；规矩先立，违者必偿，恐怖之余有世情温度。',
    pacing: '触忌→异象→解释与了断；每章交代一条禁忌的作用与代价。',
    beatStructure: '有人触了禁忌 → 异象逐步升级、旁人反应各异 → 触忌的真相与因果浮出 → 按规矩了断并留余韵',
    scenePatterns: [
      '禁忌演示：先把规矩讲明白，再让人物因无奈或侥幸去踩它',
      '老物件索命：让一件旧物承载前债，通过它牵扯出旧事',
      '夜路与祠堂：用具体的地理与民俗器物立住氛围，不靠阴风鬼影',
    ],
    payoffDesign: [
      '因果兑现：作恶者的下场与其当年的行为严格对应',
      '了断的释然：化解之后留一份对逝者的交代，情绪落点在人情而非惊吓',
    ],
    perspectiveRules: [
      '第三人称限知，民俗器物与称呼要准确，写错会破功',
      '允许短促的第一人称插入写当事人口述，但要有明确来源与场景',
    ],
    relationshipRules: [
      '行规与人情：从业者有自己的规矩与忌讳，破规要被同行排斥',
      '亲缘牵连：灾祸常由祖辈旧事牵出，后辈须替前人偿还',
    ],
    styleNorms: { targetWords: 3000, paragraphLen: 160, dialogueRatio: 25 },
    taboos: [
      '鬼物凭空出现且毫无规矩约束',
      '用跳跃惊吓代替因果铺垫',
      '把民俗写成胡说八道',
      '所有异象都靠主角一招解决',
    ],
    mustHaves: ['一条明确的禁忌规则', '一桩前世今生的因果', '民俗器物的具体用法'],
    auditHints: ['禁忌规则是否自洽', '因果是否回收'],
    extraBlacklist: ['一股阴风扑面而来', '仿佛有什么在暗处窥视'],
  },
  {
    id: 'wuxianliu',
    name: '无限流',
    aliases: ['无限流', '轮回', '主神空间', '副本流'],
    description: '一段段封闭副本构成的成长链；规则先讲清再逼迫玩家在绝境中取舍。',
    pacing: '进本→摸底→规则被利用→出本清算；副本内至少一次规则反转。',
    beatStructure: '被卷入新副本并公布规则 → 试探规则与队友立场 → 规则被利用或反噬而局势逆转 → 结算收获，但代价与下个副本的线索浮现',
    scenePatterns: [
      '规则公布：把硬约束、隐藏条款与违约后果分三层抛出，逼读者一起推演',
      '队伍博弈：成员各有算盘与专长，合作与背刺都要有可计算的动机',
      '规则漏洞被反用：主角找到条款里的缝隙完成非常规通关，事后可复盘',
    ],
    payoffDesign: [
      '推演兑现：通关靠对规则的精确理解，而非突然变强',
      '结算兑现：出本后明确交代点数/道具/伤势的变化，给出可见的进度反馈',
    ],
    perspectiveRules: [
      '第三人称限知，规则文本要原样呈现给读者，不得隐瞒关键条款',
      '主角的推理过程要写出来，不搞事后诸葛亮式解释',
    ],
    relationshipRules: [
      '临时同盟：队友之间是利益与生存的合约，背叛需要有现实理由',
      '老手与新人：前辈的指点夹杂私心，新人要在代价中学会生存',
    ],
    styleNorms: { targetWords: 3500, paragraphLen: 170, dialogueRatio: 28 },
    taboos: [
      '规则临时更改以制造难度',
      '队友无理由送死或背叛',
      '通关全靠道具而不靠推理',
      '副本结束后收获不作交代',
    ],
    mustHaves: ['明确的副本规则文本', '一次规则层面的反转', '可复盘的通关逻辑'],
    auditHints: ['规则是否被违反', '道具与点数是否前后一致'],
  },

  // ────────────────────────────── 设定驱动 ──────────────────────────────
  {
    id: 'xitong',
    name: '系统流',
    aliases: ['系统', '系统流', '签到', '任务流'],
    description: '以系统提示与任务驱动的成长节奏；奖励有层级、惩罚有牙齿，避免提示淹没剧情。',
    pacing: '任务下达→执行受挫→奖励兑现；每章系统信息克制投放，不刷屏。',
    beatStructure: '系统发布任务或惩罚预警 → 在现实阻力中执行 → 触发隐藏条件或版本变化 → 结算奖励并暴露系统更大的意图',
    scenePatterns: [
      '提示与现实的错位：系统给出最优解，但现实里这么做会得罪人或触犯规矩',
      '惩罚落地：让一次失败真的带来可感损失，确立系统不是外挂而是债主',
      '隐藏条件触发：通过一个被忽视的前置行为解锁额外奖励，回报前期耐心',
    ],
    payoffDesign: [
      '数值兑现：奖励要换算成实际处境改善（钱、地位、战力），不能只跳数字',
      '成长可见：读者能对照前后章节看出主角的变化曲线',
    ],
    perspectiveRules: [
      '第三人称限知，系统信息以独立短行呈现并与叙述区分开',
      '每章系统文本总量克制，避免变成提示日志',
    ],
    relationshipRules: [
      '系统与宿主是交易：任务背后要有目的，逐步揭示其意图',
      '旁人视角：外界看到的是运气与怪癖，造成误读与冲突',
    ],
    styleNorms: { targetWords: 3200, paragraphLen: 160, dialogueRatio: 30 },
    taboos: [
      '任务与主线无关纯刷存在感',
      '奖励无上限导致战力崩坏',
      '系统提示刷屏挤压剧情',
      '惩罚永不到账',
    ],
    mustHaves: ['一条清晰的任务链', '一次真实的惩罚', '奖励兑换成现实处境'],
    auditHints: ['数值是否自洽', '系统规则是否被违反'],
  },
  {
    id: 'chongsheng',
    name: '穿越重生',
    aliases: ['穿越', '重生', '穿越重生', '穿书', '快穿', '回到过去'],
    description: '带着信息或经验重来一次，靠先知与改变制造优势，同时被蝴蝶效应反噬。',
    pacing: '预知→行动→变数；每次改动都必须引发新的偏差，禁止一路躺赢。',
    beatStructure: '带着记忆回到关键节点 → 按记忆抢先布局 → 因改动过大出现记忆失效或新对手 → 拿到优势同时失去先知红利',
    scenePatterns: [
      '抢先一步：用对时间点的精确把握截走原本属于他人的机会，代价要写清',
      '记忆失效：让熟悉的剧情拐弯，逼角色丢掉拐杖重新判断',
      '身份落差：以陌生身体或身份行事，处处受制于原有关系网',
    ],
    payoffDesign: [
      '先知兑现：读者与主角共享信息优势，看到「果然如此」的验证快感',
      '补偿兑现：弥补前世的遗憾，但要付出别处的代价以维持张力',
    ],
    perspectiveRules: [
      '第三人称限知，前世信息以简短回忆插入，不做整章倒叙',
      '主角的判断要受当下信息限制，不能随时调用全部记忆',
    ],
    relationshipRules: [
      '旧关系新解读：前世的对头或恩人可能因你的改变而转向',
      '身份成本：占用他人身份要面对原有亲疏与债务',
    ],
    styleNorms: { targetWords: 3200, paragraphLen: 165, dialogueRatio: 30 },
    taboos: [
      '靠记忆一路无阻通关',
      '改变历史却毫无蝴蝶效应',
      '前世设定前后矛盾',
      '用旁观者反复吹捧主角',
    ],
    mustHaves: ['一处对前世的改变', '由此引发的偏差', '先知优势的失效时刻'],
    auditHints: ['前世今生信息是否一致', '蝴蝶效应是否落地'],
  },
  {
    id: 'mozhou',
    name: '末日废土',
    aliases: ['末日', '废土', '丧尸', '末世', '天灾'],
    description: '资源枯竭下的生存秩序重建；每一次获得都伴随风险，人性在分配中显形。',
    pacing: '搜刮—威胁—分配；每章交代一项物资或一条势力的变化。',
    beatStructure: '生存危机逼近 → 外出获取并遭遇他人 → 分配或信任出现裂痕 → 暂时稳住但更大威胁成型',
    scenePatterns: [
      '据点防御：清点人手、物资与缺口，用具体数字写压迫感',
      '外出搜刮：限制水、油、弹药三项，逼出取舍',
      '幸存者相遇：对方也有难处与企图，判断善恶意本身就有代价',
    ],
    payoffDesign: [
      '生存兑现：一次成功的获取实实在在改善处境，读者能算出收益',
      '秩序兑现：建立规则与分工带来稳定，也带来新的权力摩擦',
    ],
    perspectiveRules: [
      '第三人称限知，物资与伤病状态要严格记账，不可凭空恢复',
      '不写全能救世主，主角的每次决定都要有人承担后果',
    ],
    relationshipRules: [
      '分配即政治：谁拿多少决定谁服谁，冲突要落在具体份额上',
      '旧秩序残影：军方、宗教、帮派各有规矩，接触需按各自规则来',
    ],
    styleNorms: { targetWords: 3200, paragraphLen: 170, dialogueRatio: 26 },
    taboos: [
      '物资无限且随意获取',
      '丧尸只作背景没有威胁设计',
      '人性选择非黑即白无成本',
      '伤病与饥饿说完就忘',
    ],
    mustHaves: ['物资或伤病的明确账目', '一次涉及分配的冲突', '势力或环境的实质变化'],
    auditHints: ['物资与伤势是否连续', '威胁强度是否合理'],
  },
  {
    id: 'zhongtian',
    name: '种田经营',
    aliases: ['种田', '种田文', '经营', '田园', '生活流'],
    description: '以稳步经营与日常积累提供满足感；缓慢推进但每章都要有可见的增长。',
    pacing: '投入—产出—扩张；每章交代一笔明确的经营成果。',
    beatStructure: '发现可经营的机会 → 投入人手与资源试错 → 遭遇市场或自然变故 → 站稳脚跟并扩大规模',
    scenePatterns: [
      '开张与改良：把技术改良写成可验证的产出差异',
      '丰收与分配：用具体数目与人物反应写回报，兼顾人情往来',
      '灾年应对：天灾或税赋压来，考验储备与邻里关系',
    ],
    payoffDesign: [
      '积累兑现：读者能对照章节看到产业与家底的成长曲线',
      '口碑兑现：主角因手艺或信誉被人尊重，带来新的机会',
    ],
    perspectiveRules: [
      '第三人称限知，工序与农时要写实，不可凭空增产',
      '节奏可舒缓，但每章结束必须有一步实际推进',
    ],
    relationshipRules: [
      '乡邻与宗族：人情往来与借贷要记账，互助与嫉妒并存',
      '生意对手：竞品靠正当手段竞争，胜负落在质量与销路',
    ],
    styleNorms: { targetWords: 3000, paragraphLen: 170, dialogueRatio: 32 },
    taboos: [
      '一季暴富且无技术依据',
      '日常段落毫无推进地重复',
      '邻人只作背景没有利害',
      '经营细节全靠含糊带过',
    ],
    mustHaves: ['一笔可核算的产出', '一次经营或自然灾害', '邻里人情的具体往来'],
    auditHints: ['产出与投入是否匹配', '时间/农时是否合理'],
  },
  {
    id: 'youxi',
    name: '游戏竞技',
    aliases: ['游戏', '网游', '电竞', '游戏竞技', '虚拟网游'],
    description: '规则明确的竞技场；胜负靠对机制的理解与团队配合，不靠隐藏外挂。',
    pacing: '对局—复盘—升级；每章至少一场有胜负判定的对抗。',
    beatStructure: '遭遇新对手或新版本 → 试探与战术布置 → 关键团战或决策点 → 胜负落定并复盘暴露短板',
    scenePatterns: [
      '版本适应：新规则改动打乱原有打法，考验理解速度',
      '团战配合：把每个位置的作用写清，胜负取决于指令执行而非个人秀',
      '赛后复盘：用数据与关键节点回看，让读者理解赢在哪输在哪',
    ],
    payoffDesign: [
      '战术兑现：靠战术与配合取胜，事后可被读者复盘',
      '成长兑现：个人操作与团队默契有可见的进步轨迹',
    ],
    perspectiveRules: [
      '第三人称限知，界面与操作以具体指令呈现，禁抽象描述「操作很秀」',
      '不滥用第一人称意识流描写操作手感',
    ],
    relationshipRules: [
      '队内分工：位置与性格冲突要落到具体职责上',
      '对手尊重：强敌有自己的打法与坚持，胜负之外要有承认',
    ],
    styleNorms: { targetWords: 3400, paragraphLen: 170, dialogueRatio: 30 },
    taboos: [
      '靠未公布的隐藏机制取胜',
      '对手全员降智配合主角秀',
      '比赛过程含糊带过直接给结果',
      '数值与技能设定前后不一',
    ],
    mustHaves: ['一场完整对抗', '一次战术或规则细节的运用', '赛后复盘'],
    auditHints: ['技能/数值是否自洽', '胜负是否合理'],
  },
  {
    id: 'tiyu',
    name: '体育竞技',
    aliases: ['体育', '运动', '篮球', '足球', '田径', '竞技体育'],
    description: '训练与赛场的双重叙事；天赋之外更看重方法与意志，胜负服从项目真实规则。',
    pacing: '训练—比赛—成长；每章一场训练成果的检验。',
    beatStructure: '遭遇瓶颈或强敌 → 针对性训练与调整 → 赛场关键分或关键局 → 结果落定并暴露新短板',
    scenePatterns: [
      '极限训练：把枯燥训练写出方法和身体反馈，不靠口号',
      '赛场关键分：放慢关键一球，写判断、体能与心理的叠加',
      '伤病与复出：伤病的现实限制要延续数章，不可立刻痊愈',
    ],
    payoffDesign: [
      '突破兑现：技术或体能进步在关键分上直接转化成分数',
      '团队兑现：默契配合完成一次漂亮攻势，靠细节而非解说吹捧',
    ],
    perspectiveRules: [
      '第三人称限知，项目规则与术语必须准确，裁判判罚要有依据',
      '比赛解说式的旁白要克制，信息通过场上动作呈现',
    ],
    relationshipRules: [
      '队友与教练：信任建立在训练与调整的有效性上，冲突源于理念',
      '对手即镜子：强敌的技术特点要被具体写出，胜负之外有敬意',
    ],
    styleNorms: { targetWords: 3200, paragraphLen: 165, dialogueRatio: 30 },
    taboos: [
      '违背项目规则的超常表现',
      '伤病说完就好完全无后遗',
      '靠解说夸大代替场上描写',
      '对手毫无技术特点',
    ],
    mustHaves: ['一场有判定的比赛', '训练方法的可感进步', '项目规则的准确运用'],
    auditHints: ['项目规则是否出错', '伤病与状态是否连续'],
  },
  {
    id: 'junshi',
    name: '军事战争',
    aliases: ['军事', '战争', '谍战', '军旅', '特种作战'],
    description: '以战术、后勤与情报为骨；胜负取决于准备与判断，牺牲要有重量。',
    pacing: '受命—侦察—战斗；每章交代一次明确的战术目标与结果。',
    beatStructure: '接到任务并明确情报 → 侦察与部署中暴露变数 → 交火或交锋出现意外 → 完成任务但付出代价',
    scenePatterns: [
      '战术部署：把火力、地形、通讯这三项摆清，胜负落在准备上',
      '遭遇战：用弹药、伤员、通讯中断这些具体限制推进紧张',
      '情报博弈：对手的计划同样合理，胜负取决于谁先识破',
    ],
    payoffDesign: [
      '战术兑现：靠配合与预案化解绝境，事后可复盘每一步',
      '牺牲兑现：伤亡带来实际的编制与情感空缺，会被后续章节记得',
    ],
    perspectiveRules: [
      '第三人称限知，装备与军衔术语要准确，不出现时空错位的器械',
      '战斗以小队视角推进，避免全知全局的战报式叙述',
    ],
    relationshipRules: [
      '命令与情义：服从与保全下属之间的张力是持续冲突源',
      '敌我相知：对手的指挥风格要具体，形成可对抗的镜像',
    ],
    styleNorms: { targetWords: 3300, paragraphLen: 175, dialogueRatio: 26 },
    taboos: [
      '无视后勤与弹药的无限作战',
      '敌方指挥官毫无判断力',
      '用现代装备硬套历史背景',
      '牺牲轻描淡写无后续影响',
    ],
    mustHaves: ['一次明确的战术行动', '情报或后勤的具体细节', '代价与善后'],
    auditHints: ['装备/编制是否出错', '伤亡与后勤是否连续'],
  },
  {
    id: 'lishi',
    name: '历史架空',
    aliases: ['历史', '架空历史', '权谋', '朝堂', '王朝'],
    description: '以朝堂与制度博弈为主干；改变需要制度成本，个人意志受制于时代条件。',
    pacing: '布局—交锋—落子；每章推动一次权力格局的微调。',
    beatStructure: '朝局出现缺口 → 借人事与奏议布局 → 殿前或边地正面交锋 → 格局改写但结下新仇',
    scenePatterns: [
      '朝议交锋：以奏对、站位与用典写博弈，胜负落在制度依据上',
      '人事任命：一个职位的归属牵动多方，靠交换而非命令成事',
      '边患与粮政：用具体的粮道、军费与户口数字支撑决策',
    ],
    payoffDesign: [
      '制度兑现：主角靠对典章与流程的熟悉压制对手，赢在规则内',
      '格局兑现：每次胜利都落实为具体职务、地盘或政策改变',
    ],
    perspectiveRules: [
      '第三人称限知，官制、称谓与器物需符合所设定的时代，不可混用',
      '用制度性障碍限制主角，不能靠现代理念直接碾压',
    ],
    relationshipRules: [
      '派系即利益：结党与背叛都要有利益依据，非忠奸二字可概括',
      '上下相制：对上级、同僚、下属各有一套应对逻辑',
    ],
    styleNorms: { targetWords: 3300, paragraphLen: 180, dialogueRatio: 30 },
    taboos: [
      '现代观念直接改造古代社会而无阻力',
      '官制与称谓随意混用',
      '权谋全靠刺杀而无制度博弈',
      '所有人只分忠奸两类',
    ],
    mustHaves: ['一次制度层面的博弈', '具体的官职或政策变化', '时代条件的制约'],
    auditHints: ['官制/称谓是否出错', '政策后果是否落地'],
  },
  {
    id: 'tongren',
    name: '同人二创',
    aliases: ['同人', '二创', '衍生', '同人创作'],
    description: '在原作骨架内写新故事；人物言行须与原设定一致，创新只加在缝隙处。',
    pacing: '以原作的节奏感推进，每章至少一处与原设定咬合的细节。',
    beatStructure: '切入原作的空白缝隙 → 与既有人物建立新关系 → 与既定事件正面相遇 → 在不推翻原作的前提下完成本线收束',
    scenePatterns: [
      '缝隙补白：选取原作没有明写的时段展开，不与既定事实冲突',
      '人物互认：靠口癖、习惯与决策方式让老角色一开口就被认出',
      '既定事件重演：换视角重写名场面，给读者熟悉的陌生感',
    ],
    payoffDesign: [
      '还原兑现：角色的语气与选择高度贴合原作，读者获得认同快感',
      '补完兑现：为原作未交代的遗憾给出合理的另一种可能',
    ],
    perspectiveRules: [
      '第三人称限知，视角人物应与原作信息量匹配，不让他知道不该知道的',
      '与原作设定冲突时以原作为准，不以二创便利改写既定事实',
    ],
    relationshipRules: [
      '关系基于原作：新增互动要在既有性格与羁绊上生长',
      '原创角色不抢戏：新角色承担功能与情感补充，不夺走原作人物的核心弧光',
    ],
    styleNorms: { targetWords: 3000, paragraphLen: 160, dialogueRatio: 32 },
    taboos: [
      '原作人物说出不符合其性格的台词',
      '随意推翻原作既定事实',
      '原创角色战力与地位碾压原作主角',
      '只堆角色互动而无新情节',
    ],
    mustHaves: ['与原设定咬合的细节', '一处原作的空白补白', '不冲突于原作的事件收束'],
    auditHints: ['人物言行是否贴合原作', '是否改写既定事实'],
  },
  {
    id: 'duanpian',
    name: '短篇爽文',
    aliases: ['短篇', '短篇爽文', '爽文', '短平快', '微短剧'],
    description: '节奏极快、冲突前置；开局即矛盾，几百字内完成一次压制与反制。',
    pacing: '开篇即冲突，三拍内完成压制—反制—打脸，结尾强钩子。',
    beatStructure: '开局亮出矛盾 → 主角被压制到极难堪 → 亮出底牌瞬间反制 → 收尾留强钩子',
    scenePatterns: [
      '开局难堪：在第一段就把主角推到被当众轻视的位置，迅速建立代入',
      '底牌掀桌：反转要短促干脆，用一句话或一个动作完成身份/实力揭示',
      '连锁打脸：让前一章的轻视者在本章付出可见代价，形成即时反馈',
    ],
    payoffDesign: [
      '即时爽感：压制与反制之间的间隔要短，兑现要狠',
      '身份反转：靠一个具体标识（称谓、物件、来电）完成身份揭示',
    ],
    perspectiveRules: [
      '第三人称限知或第一人称，段落短促，砍掉所有铺垫性景物描写',
      '心理描写极简，情绪靠动作与对话爆发',
    ],
    relationshipRules: [
      '轻视者需有代价：每一份藐视都要在近期章节被结算',
      '盟友来得快：关键处出现的支持要有前置伏笔，避免天降',
    ],
    styleNorms: { targetWords: 1800, paragraphLen: 120, dialogueRatio: 35 },
    taboos: [
      '开局大段背景介绍',
      '压制与反制之间拖过三章',
      '打脸靠旁人吹捧而非事实',
      '结尾无钩子',
    ],
    mustHaves: ['开局即有的明确矛盾', '一次干脆的反转', '结尾强钩子'],
    auditHints: ['节奏是否拖沓', '反转是否有前置依据'],
  },

  // ────────────────────────────── 兜底 ──────────────────────────────
  {
    id: 'general',
    name: '通用网文',
    aliases: ['通用', '其他', '综合', '网文'],
    description: '黄金三章节奏：冲突清晰、人物有欲、章末有钩；忌注水与说教。',
    pacing: '起冲突—加压—小兑现—钩子；对话与动作交替。',
    beatStructure: '冲突登场 → 加压并暴露人物欲望 → 小兑现或转折 → 章末钩子',
    scenePatterns: [
      '开局立人物：用一个具体选择展示主角的欲求与底线',
      '首个小高潮：让主角在有限条件下拿到一次小胜',
      '章末钩子：用新信息或新威胁把读者推向下一章',
    ],
    payoffDesign: [
      '清晰兑现：每次努力都对应可见回报，不做无效努力',
      '欲望驱动：主角的目标要具体可衡量',
    ],
    perspectiveRules: [
      '第三人称限知为主，视角变化需明确分段',
      '情绪用动作与对话外化，少用概括性形容词',
    ],
    relationshipRules: [
      '关系有来有往：盟友与对手都要有自己的动机',
      '冲突来自诉求差异，而非单纯善恶',
    ],
    styleNorms: { targetWords: 3000, paragraphLen: 160, dialogueRatio: 32 },
    taboos: ['章末升华说教', '无冲突流水账', '人设无故OOC', '重复信息三次以上'],
    mustHaves: ['清晰欲望', '阻力', '章末钩子'],
    auditHints: ['是否注水', '是否OOC'],
  },
];

export function listGenrePacks(): GenrePack[] {
  return GENRE_PACKS;
}

export function getGenrePackById(id?: string | null): GenrePack | undefined {
  if (!id) return undefined;
  return GENRE_PACKS.find((p) => p.id === id);
}

/**
 * 根据书的 genre 字符串解析规则包。
 *
 * 匹配优先级：
 * 1. id / 名称精确命中；
 * 2. **命中位置最靠前**的题材（而非库内顺序先到先得）。
 *    混合题材串如「科幻赛博·修仙智斗」取首个标签所属题材；
 *    若按库内顺序匹配，会因「修仙」所在的包排在前面而被误路由。
 */
export function resolveGenrePack(genre?: string | null): GenrePack {
  const raw = (genre || '').trim();
  const g = raw.toLowerCase();
  const fallback = GENRE_PACKS.find((p) => p.id === 'general')!;
  if (!g) return fallback;

  const exact = GENRE_PACKS.find((p) => p.id === g || p.name === raw);
  if (exact) return exact;

  let best: { pack: GenrePack; at: number } | null = null;
  for (const pack of GENRE_PACKS) {
    let at = Number.POSITIVE_INFINITY;
    for (const a of pack.aliases) {
      const al = a.toLowerCase();
      const i = g.indexOf(al);
      if (i >= 0 && i < at) at = i;
      // 反向包含：题材串比别名短时（genre='都市' / 别名='都市异能'）视为命中
      if (g.length >= 2 && al.includes(g)) at = Math.min(at, 0);
    }
    if (at === Number.POSITIVE_INFINITY) continue;
    if (!best || at < best.at) best = { pack, at };
  }
  return best?.pack ?? fallback;
}

/**
 * 项目级自定义覆盖（存 config.customParameters.genrePackOverride）
 * 可改名称/描述/节奏/创作维度/禁忌/应具备/审校提示/附加黑名单，不改 id。
 */
export interface GenrePackOverride {
  basePackId?: string;
  name?: string;
  description?: string;
  pacing?: string;
  beatStructure?: string;
  scenePatterns?: string[];
  payoffDesign?: string[];
  perspectiveRules?: string[];
  relationshipRules?: string[];
  styleNorms?: GenreStyleNorms;
  taboos?: string[];
  mustHaves?: string[];
  auditHints?: string[];
  extraBlacklist?: string[];
}

const MAX_TEXT_LEN = 400;

function normText(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXT_LEN) : undefined;
}

/**
 * 行首列表标记：仅剥「1. / 12、 / 3) / - / *」这类真正的列表标记。
 *
 * 旧实现 /^[\d\.、\-\*\s]+/ 无差别剥掉行首数字，把正文数字开头的条目
 * （「3天内必须回款」→「天内必须回款」、「10.000灵石上限」→「灵石上限」）
 * 也损坏了。收紧为：1–3 位数字 + 分隔符（(?!\d) 保护小数），或单个项目符号；
 * 数字后直接跟正文字（3天…）不构成列表标记，不剥。
 */
const LIST_MARK_RE = /^\s*(?:\d{1,3}\s*[\.、）)](?!\d)|[-*·])\s*/;

function stripListMark(s: string): string {
  return s.replace(LIST_MARK_RE, '').trim();
}

/** 把「多行字符串」或「字符串数组」统一成去噪后的字符串数组 */
function lines(v: unknown, cap: number): string[] | undefined {
  const arr = Array.isArray(v)
    ? v.map(String)
    : typeof v === 'string'
      ? v.split('\n')
      : undefined;
  if (!arr) return undefined;
  const out = arr.map(stripListMark).filter(Boolean).slice(0, cap);
  return out.length ? out : undefined;
}

/** 数值规格归一化：非法/越界一律丢弃，避免脏数据进 prompt */
function normNorms(v: unknown): GenreStyleNorms | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const pick = (x: unknown, min: number, max: number): number | undefined => {
    const n = typeof x === 'number' ? x : Number(x);
    if (!Number.isFinite(n)) return undefined;
    const i = Math.floor(n);
    return i >= min && i <= max ? i : undefined;
  };
  // ⚠️ 无效字段必须**省略键**而不是置 undefined：merge 侧用
  // { ...base.styleNorms, ...override.styleNorms } 合并，undefined 键会覆盖
  // 内置值——部分覆盖（只改 paragraphLen）会把「单章约3500字/对白25%」整个冲掉。
  // 对白比不含 0（0% 对白对一章正文无意义，视为非法）。
  const out: GenreStyleNorms = {};
  const tw = pick(r.targetWords, 300, 20000);
  if (tw !== undefined) out.targetWords = tw;
  const pl = pick(r.paragraphLen, 20, 2000);
  if (pl !== undefined) out.paragraphLen = pl;
  const dr = pick(r.dialogueRatio, 1, 100);
  if (dr !== undefined) out.dialogueRatio = dr;
  return Object.keys(out).length ? out : undefined;
}

export function normalizeGenreOverride(raw: unknown): GenrePackOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const o: GenrePackOverride = {};
  if (typeof r.basePackId === 'string') o.basePackId = r.basePackId;
  const name = normText(r.name);
  if (name) o.name = name;
  // 文本字段统一「空 = 未提供」：merge 时回退内置值，与列表字段语义一致
  // （此前 description/pacing/beatStructure 空字符串会原样覆盖、清空内置值，
  // 与「空即回退」的列表字段不对称）。normText 同时给 400 字上限。
  const description = normText(r.description);
  if (description) o.description = description;
  const pacing = normText(r.pacing);
  if (pacing) o.pacing = pacing;
  const beatStructure = normText(r.beatStructure);
  if (beatStructure) o.beatStructure = beatStructure;

  const scenePatterns = lines(r.scenePatterns, 12);
  if (scenePatterns) o.scenePatterns = scenePatterns;
  const payoffDesign = lines(r.payoffDesign, 12);
  if (payoffDesign) o.payoffDesign = payoffDesign;
  const perspectiveRules = lines(r.perspectiveRules, 10);
  if (perspectiveRules) o.perspectiveRules = perspectiveRules;
  const relationshipRules = lines(r.relationshipRules, 10);
  if (relationshipRules) o.relationshipRules = relationshipRules;
  const norms = normNorms(r.styleNorms);
  if (norms) o.styleNorms = norms;

  const taboos = lines(r.taboos, 20);
  if (taboos) o.taboos = taboos;
  const mustHaves = lines(r.mustHaves, 20);
  if (mustHaves) o.mustHaves = mustHaves;
  const auditHints = lines(r.auditHints, 15);
  if (auditHints) o.auditHints = auditHints;
  const extra = lines(r.extraBlacklist, 30);
  if (extra) o.extraBlacklist = extra;
  return o;
}

function cloneBase(base: GenrePack): GenrePack {
  return {
    ...base,
    aliases: [...base.aliases],
    taboos: [...base.taboos],
    mustHaves: [...base.mustHaves],
    auditHints: [...(base.auditHints || [])],
    extraBlacklist: [...(base.extraBlacklist || [])],
    scenePatterns: [...(base.scenePatterns || [])],
    payoffDesign: [...(base.payoffDesign || [])],
    perspectiveRules: [...(base.perspectiveRules || [])],
    relationshipRules: [...(base.relationshipRules || [])],
    styleNorms: base.styleNorms ? { ...base.styleNorms } : undefined,
  };
}

export function mergePackWithOverride(
  base: GenrePack,
  override?: GenrePackOverride | null
): GenrePack {
  const out = cloneBase(base);
  if (!override) return out;

  out.name = override.name?.trim() || base.name;
  out.description = override.description ?? base.description;
  out.pacing = override.pacing ?? base.pacing;
  out.beatStructure = override.beatStructure ?? base.beatStructure;
  // 创作向维度：覆盖为空即回退内置，避免「编辑一次旧面板就把新维度清空」
  if (override.scenePatterns?.length) out.scenePatterns = [...override.scenePatterns];
  if (override.payoffDesign?.length) out.payoffDesign = [...override.payoffDesign];
  if (override.perspectiveRules?.length) out.perspectiveRules = [...override.perspectiveRules];
  if (override.relationshipRules?.length) out.relationshipRules = [...override.relationshipRules];
  if (override.styleNorms) out.styleNorms = { ...base.styleNorms, ...override.styleNorms };
  if (override.taboos?.length) out.taboos = [...override.taboos];
  if (override.mustHaves?.length) out.mustHaves = [...override.mustHaves];
  if (override.auditHints?.length) out.auditHints = [...override.auditHints];
  if (override.extraBlacklist?.length) out.extraBlacklist = [...override.extraBlacklist];
  return out;
}

/**
 * 从项目 config + genre 解析最终注入用规则包（含自定义覆盖）。
 */
export function resolveGenrePackForProject(input: {
  genre?: string | null;
  genrePackId?: string | null;
  override?: unknown;
}): GenrePack {
  const base =
    getGenrePackById(input.genrePackId) ||
    resolveGenrePack(input.genre);
  const ov = normalizeGenreOverride(input.override);
  // 若覆盖指定了 basePackId 且与当前 base 不同，以覆盖的 base 为准
  const base2 =
    ov?.basePackId && ov.basePackId !== base.id
      ? getGenrePackById(ov.basePackId) || base
      : base;
  return mergePackWithOverride(base2, ov);
}

function numbered(title: string, items?: string[]): string[] {
  if (!items?.length) return [];
  const out = [`${title}：`];
  items.forEach((t, i) => out.push(`${i + 1}. ${t}`));
  return out;
}

function formatNorms(norms?: GenreStyleNorms): string | null {
  if (!norms) return null;
  const bits: string[] = [];
  if (norms.targetWords) bits.push(`单章约 ${norms.targetWords} 字`);
  if (norms.paragraphLen) bits.push(`段落约 ${norms.paragraphLen} 字`);
  if (norms.dialogueRatio) bits.push(`对白约 ${norms.dialogueRatio}%`);
  return bits.length ? bits.join(' · ') : null;
}

export function formatGenrePackForPrompt(pack: GenrePack): string {
  const lines: string[] = [];
  lines.push(`【题材规则包：${pack.name}】${pack.description}`);
  lines.push(`节奏：${pack.pacing}`);
  if (pack.beatStructure) {
    lines.push(`章节范式：${pack.beatStructure}`);
  }
  lines.push(...numbered('招牌场景拍法', pack.scenePatterns));
  lines.push(...numbered('爽点与情绪兑现', pack.payoffDesign));
  lines.push(...numbered('视角纪律', pack.perspectiveRules));
  lines.push(...numbered('人物关系法则', pack.relationshipRules));
  const norms = formatNorms(pack.styleNorms);
  if (norms) {
    // 软性参考：与字数硬约束（若存在）冲突时以硬约束为准，避免自相矛盾的指令
    lines.push(`题材参考规格（软性，若与字数硬约束冲突以硬约束为准）：${norms}`);
  }
  lines.push('禁忌：');
  pack.taboos.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  lines.push('本章应具备：');
  pack.mustHaves.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  if (pack.auditHints?.length) {
    lines.push('审校额外关注：');
    pack.auditHints.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  return lines.join('\n');
}

/** 合并题材附加黑名单 */
export function mergeGenreBlacklist(
  base: string[],
  pack: GenrePack
): string[] {
  return [...new Set([...base, ...(pack.extraBlacklist || [])])];
}
