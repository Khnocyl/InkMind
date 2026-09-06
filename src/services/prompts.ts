import { proseWords } from './proseWords';
import type { ProjectConfig, Character, WorldSetting, PlotBeat, StyleConfig, Chapter } from '../types/novel';
import {
  formatStyleProfileForPrompt,
  getActiveStyleProfile,
  isStyleGenreMismatch,
} from './styleImitate';
import { mergeExtendedBlacklist } from './aiTasteScan';

/**
 * 结构层注入块包装（架构排查：作家大脑参与世界观/大纲/拆章/分镜）。
 * 无结构层档案时返回空串，提示词保持原样。
 */
function styleStructureSection(styleStructureBlock?: string): string {
  return styleStructureBlock?.trim()
    ? `${styleStructureBlock.trim()}\n`
    : '';
}

/** 章末 recap 抽取 Prompt */
export function buildChapterRecapPrompt(
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>,
  prose: string,
  characters: Character[]
) {
  const charNames = characters.map((c) => c.name).join('、') || '（本章未绑定角色卡）';
  // 控制 token：正文过长时取头尾
  const maxChars = 6000;
  let body = prose.trim();
  if (body.length > maxChars) {
    const head = body.slice(0, 2800);
    const tail = body.slice(-2800);
    body = `${head}\n\n……（中间省略）……\n\n${tail}`;
  }

  const systemPrompt = `你是连载小说的「章末记忆官」。任务：根据本章定稿正文，产出供下一章写作注入的结构化记忆，而不是文学评论。
要求：
1. 只写正文里已发生的事实，禁止臆造未写内容。
2. recap 用第三人称、短句，120–280 字，覆盖：起因→关键冲突→结果→章末钩子。
3. keyFacts 3–8 条，每条一句「已钉死」事实（人物生死、物品归属、约定、伤势、地点变化等）。
4. endingState：章末现场（谁在哪、局势、情绪/对峙余波），40–100 字。
5. openThreads：0–5 条未收回的伏笔或未解问题。
严格只输出合法 JSON，无 markdown：
{
  "recap": "章末复盘……",
  "keyFacts": ["事实1", "事实2"],
  "endingState": "章末现场……",
  "openThreads": ["伏笔1"]
}`;

  const userPrompt = `【章节】第 ${chapter.number} 章《${chapter.title}》
【写前大纲梗概（仅供对照，以正文为准）】：
${chapter.summary || '（无）'}
【出场角色名】：${charNames}

【本章定稿正文】：
${body || '（正文为空）'}

请输出 JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/** 自动规划下一章标题与梗概 */
export function buildNextChapterPlanPrompt(
  chapterNumber: number,
  pastChapters: Chapter[],
  characters: Character[],
  settings: WorldSetting[],
  bookTitle?: string
) {
  const recent = [...pastChapters]
    .sort((a, b) => a.number - b.number)
    .slice(-5)
    .map((c) => {
      const mem = c.recap?.text || c.summary || '';
      return `第${c.number}章《${c.title}》：${mem.slice(0, 200)}`;
    })
    .join('\n');

  const chars = characters
    .slice(0, 8)
    .map((c) => `${c.name}(${c.status}/${c.realmOrTitle})@${c.currentLocation}`)
    .join('；');
  const rules = settings
    .slice(0, 5)
    .map((s) => `【${s.name}】${(s.hardRules || [])[0] || s.description}`)
    .join('\n');

  const systemPrompt = `你是网文连载策划。根据已有章节记忆，规划【下一章】的标题与剧情梗概。
要求：
1. 必须承接上一章结果，禁止重新开书。
2. 梗概 80–150 字，含冲突点与章末钩子。
3. involvedCharacterNames / involvedSettingNames 从给定名单中选（可空）。
严格 JSON：
{
  "title": "第N章 具体标题（可含章号）",
  "summary": "本章剧情梗概……",
  "involvedCharacterNames": ["角色名"],
  "involvedSettingNames": ["设定名"]
}`;

  const userPrompt = `【书名】${bookTitle || '未命名'}
【目标章号】第 ${chapterNumber} 章
【近章记忆】
${recent || '（尚无正文，按开篇规划）'}
【角色】${chars || '无'}
【红线】
${rules || '无'}

请规划第 ${chapterNumber} 章。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/** 从定稿正文 + recap 抽取角色状态 patch */
export function buildCharacterStatusPatchPrompt(
  chapter: Pick<Chapter, 'number' | 'title'>,
  prose: string,
  characters: Character[],
  recapText?: string
) {
  const roster = characters
    .map(
      (c) =>
        `- id=${c.id} | ${c.name} | status=${c.status} | realm=${c.realmOrTitle} | loc=${c.currentLocation}`
    )
    .join('\n');

  let body = prose.trim();
  const maxChars = 5500;
  if (body.length > maxChars) {
    body = `${body.slice(0, 2500)}\n\n……\n\n${body.slice(-2500)}`;
  }

  const systemPrompt = `你是连载「状态记忆官」。根据本章定稿，输出对已有角色卡的状态补丁（patch），供写下一章注入。
硬性规则：
1. 只根据正文已写内容更新；无依据则不要编造 patch。
2. characterId 必须来自给定名单，禁止新 id。
3. status 只能是：活跃 | 重伤 | 闭关突破 | 被捕受困 | 已阵亡/退出
4. 只输出有变化的字段；无变化的角色不要出现在 patches 里。
5. secretNotesAppend 仅追加本章新暴露的短秘密（≤40字），不要复述整个人设。
6. 严格 JSON，无 markdown：
{
  "patches": [
    {
      "characterId": "char-1",
      "characterName": "叶无痕",
      "status": "重伤",
      "realmOrTitle": "筑基后期",
      "currentLocation": "断云岭废墟",
      "secretNotesAppend": "右臂经脉受损",
      "reason": "章末被魔气反噬"
    }
  ]
}`;

  const userPrompt = `【章节】第 ${chapter.number} 章《${chapter.title}》
【章末 recap】：
${recapText || '（无）'}

【当前角色卡】：
${roster || '（无角色）'}

【定稿正文】：
${body || '（空）'}

请输出 patches JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export function buildTitleAndSynopsisPrompt(config: ProjectConfig, styleStructureBlock?: string) {
  const totalCh = config.totalChapters || config.targetChapterCount || 100;
  const wordsCh = config.wordsPerChapter || config.targetWordCountPerChapter || 3000;
  const systemPrompt = `你是一位畅销顶尖网络小说与文学巨匠，精通构思引人入胜、设定严密且极具张力的小说书名与核心世界架构。
请必须严格输出为合法 JSON 格式，不要有任何多余闲聊，结构如下：
{
  "title": "充满爆发力与辨识度的书名",
  "subtitle": "极具吸引力的副标题或标语",
  "genre": "精确分类类型，如 东方玄幻·暗黑诡秘 或 仙侠·克苏鲁修真 或 悬疑智斗",
  "synopsis": "300-500字的核心剧情梗概与背景设定，交代起因、金手指/特别机缘、残酷世界规则与最终使命",
  "hooks": ["核心亮点1：如独特的规则禁忌", "核心亮点2：如反套路主角性格", "核心亮点3：如深远的世界重置之谜"],
  "coreConflict": "全书最大的终极矛盾与生存冲突"
}`;

  const userPrompt = `【用户原始灵感描述】：
${config.inspiration}

【目标篇幅】：总共 ${totalCh} 章，每章约 ${wordsCh} 字
【目标风格】：${config.writingStyle}
【题材偏好】：${config.genre || '根据灵感推导最适合的题材'}
${styleStructureSection(styleStructureBlock)}
请根据以上灵感，构思一部爆款且极具口碑与质感的小说方案。必须输出纯合法 JSON 格式。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export function buildCharactersPrompt(_config: ProjectConfig, title: string, synopsis: string, styleStructureBlock?: string) {
  const systemPrompt = `你是一位畅销顶尖网络小说架构师，专精塑造立体深刻、极具个性与真实弧光的人物图谱。
请根据书名与故事梗概，推导生成包含主角、关键反派、重要师姐/知己、核心盟友及神秘高位者在内的 4-6 名主要人物图谱。
特别注意：性格需带有细微矛盾真实感；背景经历要有暗线伏笔；人物关系要有张力与秘密！
${styleStructureSection(styleStructureBlock)}
严格以纯合法 JSON 格式输出，不可包含任何解释说明文字，JSON JSON 结构如下：
{
  "characters": [
    {
      "id": "char-1",
      "name": "极具意境或辨识度的角色名字",
      "alias": "江湖称号 / 外号 / 真实身份",
      "role": "主角", // 从列表中选填其一: 主角 | 重要配角 | 反派 | 势力首领 | 神秘路人
      "status": "活跃", // 从列表中选填其一: 活跃 | 重伤 | 闭关突破 | 被捕受困 | 已阵亡/退出
      "realmOrTitle": "当前功法境界或具体官衔身份（如 筑基后期巅峰/镇魔司百户）",
      "currentLocation": "当前活跃所在地点（如 青云宗内门洗剑池）",
      "personality": "深入骨髓的性格特质、行为习惯与核心执念（不少于40字）",
      "appearance": "独特外貌特征、服饰打扮与标志性微细动作（例如手指带细微剑痕等，不少于40字）",
      "background": "详细过往身世、机缘秘密与内在动机（不少于60字）",
      "relations": [
        {
          "targetId": "char-2",
          "relation": "同门相争但危难时托背的师姐 / 夺命宿敌等具体关系",
          "intimacy": 65 // -100 (极度仇视欲杀之) 到 100 (生死挚友/终身相许)
        }
      ],
      "secretNotes": "该人物身上目前未被外界知晓的终极秘密或后期反转伏笔（极其重要！）"
    }
  ]
}`;

  const userPrompt = `书名：《${title}》
核心剧情梗概：
${synopsis}

请为这部书打造出极其鲜活立体的核心人物群像。请确保各人物之间的 relations.targetId 指向正确（例如 char-1, char-2 互指或单向指向）。仅输出合法 JSON 文本。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export function buildWorldbuildingPrompt(_config: ProjectConfig, title: string, synopsis: string, characters: Character[], styleStructureBlock?: string) {
  const charSummary = characters.map(c => `${c.name}(${c.role}/${c.realmOrTitle}): ${c.personality}`).join('\n');
  const systemPrompt = `你是一位顶尖小说世界观架构师与规则设计师。请根据小说梗概和核心人物，推导一套自洽、森严且令人耳目一新的世界设定集。
必须包含以下 5 大类别的内容，并且最关键的是：每个设定必须提出具体的**【绝对硬性约束规则 / 禁忌红线 (hardRules)】**，绝不容许出现吃书或逻辑破绽！
严格按 JSON 格式输出，结构如下：
{
  "settings": [
    {
      "id": "set-1",
      "category": "力量与境界体系", // 选填其一: 力量与境界体系 | 世界地理势力 | 功法神兵道具 | 天道禁忌与法则 | 核心历史伏笔
      "name": "设定或境界体系名称",
      "description": "详细设定阐述（150-200字）",
      "hardRules": [
        "绝对红线规则1（例如：引动虚空之力必定消耗自身寿元或导致神魂侵蚀，绝无例外）",
        "绝对红线规则2（例如：下位境界越阶强攻绝对不能破上位真气护身，只能通过特定阵法削弱）"
      ],
      "tags": ["核心规则", "力量上限", "死亡代价"],
      "isActive": true
    }
  ]
}`;

  const userPrompt = `书名：《${title}》
梗概：${synopsis}
主要人物：
${charSummary}
${styleStructureSection(styleStructureBlock)}
请生成 5-8 条涵盖各大类别的核心世界设定与铁律。务必仅输出 JSON 格式。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/** 目标总章数（兼容两套字段） */
export function resolveOutlineTotalChapters(config: ProjectConfig): number {
  const n = config.targetChapterCount ?? config.totalChapters ?? 100;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return 100;
  return Math.min(500, Math.max(3, Math.floor(n)));
}

/** 建议分卷数：约每卷 20–30 章 */
export function suggestVolumeCount(totalChapters: number): number {
  return Math.max(2, Math.min(12, Math.round(totalChapters / 25)));
}

/**
 * 阶段 1：只规划分卷骨架（覆盖 1..totalCh 全区间）。
 * 不在此步塞满每章，避免 JSON 截断导致「拆章不完全」。
 */
export function buildOutlineVolumesPrompt(
  config: ProjectConfig,
  title: string,
  synopsis: string,
  characters: Character[],
  settings: WorldSetting[],
  styleStructureBlock?: string
) {
  const charNames = characters.map((c) => c.name).join('、') || '（待定主角团）';
  const hardRulesSummary = settings
    .slice(0, 6)
    .map((s) => `【${s.name}】${(s.hardRules || [])[0] || s.description || ''}`)
    .join('\n');
  const totalCh = resolveOutlineTotalChapters(config);
  const volCount = suggestVolumeCount(totalCh);
  const style = config.writingStyle || '快节奏网文';

  const systemPrompt = `你是顶尖网文白金主编。任务：只规划「分卷骨架」，不写逐章正文。
硬性要求：
1. 全书恰好 ${totalCh} 章，建议 ${volCount} 卷（可微调 2～${Math.min(12, volCount + 2)} 卷）；
2. volumes 必须按章号连续覆盖第 1 章到第 ${totalCh} 章，无空洞、无重叠；
3. 第 1 卷 startChapter=1，最后一卷 endChapter=${totalCh}；
4. 相邻卷：前卷 endChapter + 1 = 后卷 startChapter；
5. 每卷给 3～6 条里程碑（majorBeats），标明卷内高潮与爽点节奏；
6. 禁止只规划前 30 章；禁止省略中后段卷；
7. 严格只输出合法 JSON，不要 Markdown。

JSON 格式：
{
  "volumes": [
    {
      "number": 1,
      "title": "第一卷 · 卷名",
      "summary": "本卷核心冲突、成长线与卷末高潮（120～200字）",
      "startChapter": 1,
      "endChapter": 25,
      "majorBeats": ["开篇钩子…", "中段反转…", "卷末高潮…"]
    }
  ]
}`;

  const userPrompt = `书名：《${title || '未命名'}》
简介：${synopsis || config.inspiration || ''}
题材：${config.genre || '玄幻'}
风格：${style}
目标总章数：${totalCh}
核心角色：${charNames}
世界法则要点：
${hardRulesSummary || '（暂无，按题材自洽即可）'}
${styleStructureSection(styleStructureBlock)}
请输出覆盖全 ${totalCh} 章的分卷 volumes JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 阶段 2：按卷（或卷内批次）逐章拆梗概。
 * 每批章数控制在 BATCH 内，保证模型能返回完整 chapters 数组。
 */
export function buildOutlineChaptersBatchPrompt(options: {
  config: ProjectConfig;
  title: string;
  synopsis: string;
  characters: Character[];
  settings: WorldSetting[];
  volume: {
    number: number;
    title: string;
    summary: string;
    startChapter: number;
    endChapter: number;
    majorBeats?: string[];
  };
  fromChapter: number;
  toChapter: number;
  /** 上一批末尾若干章，用于衔接 */
  previousTail?: { number: number; title: string; summary: string }[];
  totalChapters: number;
  /** 作家方法论结构层（可选）：拆章时的节拍/冲突设计约束 */
  styleStructureBlock?: string;
}) {
  const {
    config,
    title,
    synopsis,
    characters,
    settings,
    volume,
    fromChapter,
    toChapter,
    previousTail = [],
    totalChapters,
    styleStructureBlock,
  } = options;
  const count = toChapter - fromChapter + 1;
  const charNames = characters.map((c) => c.name).join('、') || '主角团';
  const hardRules = settings
    .slice(0, 4)
    .map((s) => `【${s.name}】${(s.hardRules || [])[0] || ''}`)
    .join('；');
  const beats = (volume.majorBeats || []).join(' / ') || volume.summary;
  const prevText =
    previousTail.length > 0
      ? previousTail
          .map((c) => `第${c.number}章《${c.title}》：${(c.summary || '').slice(0, 120)}`)
          .join('\n')
      : '（本批为开篇或卷首，无更早拆章）';

  const systemPrompt = `你是网文分章大纲专家。任务：为指定章号区间输出「逐章标题 + 梗概」。
硬性要求：
1. chapters 数组长度必须恰好为 ${count}；
2. number 必须从 ${fromChapter} 连续到 ${toChapter}，不得跳号、不得重复；
3. 每章 summary 不少于 60 字，含冲突、人物动作与章末钩子；
3.5. **involvedCharacterNames 必须列全**：本章梗概中实际出现（参与动作/对话/被提及影响局势）的**每一个角色**都要列，包括配角与反派——只写主角是错误；名字必须严格取自下方「角色」名单原文，禁止自造或带称号修饰；
4. 承接 previousTail 已发生事实，禁止吃书；
5. 本批属于「${volume.title}」（全书第 ${volume.startChapter}–${volume.endChapter} 章 / 全书共 ${totalChapters} 章）；
6. 本批应体现卷里程碑：${beats}；
7. **title 章法（逐条执行，这是否决项）**：
   - 这是**章节目录标题**，不是书名、简介或平台推荐标题：禁止堆砌设定词与卖点（境界名/金手指/天灵根/尸解液等专有设定至多一个）；禁止「真相初现」「命运逆转」等揭示腔；禁止舞台指示/功能词（卷末高潮、开篇、过渡、铺垫、尾声、引入、收束、爆发、高潮、卷末、序章、终章）；禁止套路骨架词（XX之战/风云/降临/觉醒/危机/真相/阴谋/归来/新生/传奇/横空出世）；禁「主角/少年/少女/她/他」当主语开头（"少女崛起"「他的选择」不合格）；禁带「第N章」前缀（章号以 number 字段为准）；禁止用逗号、顿号、句号串联多个卖点的长句读标题；
   - **三大黄金类型按占比择一**（每章选最适合本章情节的那类，本批内三类都要有、不得全是同一类）：
     ①悬念型（40%）——不点破结果只给谜面，用于转折、关键人物出场、秘密揭晓前（如「他没回头」「半张纸条」）；
     ②冲突型（35%）——直接展现矛盾与对抗，自带画面感（如「他当众撕毁婚约」「三大家族联手围剿」）；
     ③身份型（25%）——身份反转或隐藏信息松动（如「她喊的是别人的名字」「他床板下压着旧令牌」）；
   - **长度规则**：主标题 6～16 字最佳，最短不低于 6、最长不超过 20；本批内每 5 章至少 2 个标题长度相差 4 字以上，**避免连续 3 章标题字数相同**，长短错落；
   - **节奏控制（波浪式推进）**：每 5 章一个节奏单元循环——按章号对 5 求余定位组内位置（第1/2/3章标题相对平缓作铺垫积累，第4章标题必须有冲击力作小高潮，第5章标题制造悬念作反转升级），循环往复；跨批次按章号延续，不做批级重排；
   - 口语、平静、点到即止：从本章具体事件、物件、人物一个动作或一句台词里取，留一扇「想知道下文」的门，不点破结果、不剧透结尾；本批内句式结构不得重复。
   合格范例：「一炷香之后」「刀还在鞘里」「他当众撕毁婚约」「她喊的是别人的名字」「半张纸条」；不合格范例（卖点堆砌/长句读/揭示腔）：「三岁沉湖，天灵根世家唯一的废种」「冰湖沉底，尸解液真相初现」「少年地灵根废柴逆袭归来」。
8. 严格只输出合法 JSON。

JSON 格式：
{
  "chapters": [
    {
      "number": ${fromChapter},
      "title": "用本章具体意象起的钩子式标题（参照合格范例，杜绝模板腔）",
      "summary": "本章情节点与钩子（≥60字）",
      "involvedCharacterNames": ["角色名"],
      "involvedSettingNames": ["设定名"]
    }
  ]
}`;

  const userPrompt = `书名：《${title || '未命名'}》
简介：${(synopsis || config.inspiration || '').slice(0, 400)}
题材：${config.genre || '玄幻'} · 角色：${charNames}
法则：${hardRules || '无'}
本卷摘要：${volume.summary}
${styleStructureSection(styleStructureBlock)}

【前情拆章】
${prevText}

请生成第 ${fromChapter} 章至第 ${toChapter} 章（共 ${count} 章）的完整 chapters JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 兼容旧单次调用：小体量书（≤25 章）可一次拆完；大体量请走分卷+分批。
 * @deprecated 优先使用 buildOutlineVolumesPrompt + buildOutlineChaptersBatchPrompt
 */
export function buildOutlinePrompt(
  config: ProjectConfig,
  title: string,
  synopsis: string,
  characters: Character[],
  settings: WorldSetting[]
) {
  const totalCh = resolveOutlineTotalChapters(config);
  // 小书仍允许单次全量；大书提示只返回卷骨架（由上层改走多轮）
  if (totalCh <= 25) {
    const charNames = characters.map((c) => c.name).join('、');
    const hardRulesSummary = settings
      .slice(0, 4)
      .map((s) => `【${s.name}】规则：${(s.hardRules || [])[0] || s.description}`)
      .join('\n');
    const volCount = suggestVolumeCount(totalCh);
    const systemPrompt = `你是顶尖网文主编。全书 ${totalCh} 章，约 ${volCount} 卷。
必须输出全部 ${totalCh} 章的逐章 title+summary，禁止只拆前几章。
严格 JSON：
{"volumes":[{"number":1,"title":"...","summary":"...","startChapter":1,"endChapter":N,"chapters":[{"number":1,"title":"...","summary":"...","involvedCharacterNames":[],"involvedSettingNames":[]}]}]}`;
    const userPrompt = `书名《${title}》。简介：${synopsis}。角色：${charNames}。法则：${hardRulesSummary}。请返回覆盖 1–${totalCh} 的完整大纲 JSON。`;
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }
  return buildOutlineVolumesPrompt(config, title, synopsis, characters, settings);
}

export function buildChapterBeatsPrompt(
  chapterSummary: string,
  characters: Character[],
  settings: WorldSetting[],
  previousContext?: string,
  /** 书级权威记忆块（钉死事实 / 伏笔 / 角色状态表） */
  storyMemoryBlock?: string,
  /** 写前意图（必须/禁止/钩子） */
  chapterIntentBlock?: string,
  /** 题材规则包 */
  genrePackBlock?: string,
  /** 作家方法论结构层 */
  styleStructureBlock?: string
) {
  const charContext = characters.map(c => `${c.name} (${c.realmOrTitle}): ${c.status}，外貌性格：${c.personality}，秘密：${c.secretNotes}`).join('\n');
  const settingContext = settings.map(s => `设定《${s.name}》禁止与法则：${(s.hardRules || []).join('；')}`).join('\n');
  const prevBlock = previousContext?.trim()
    ? previousContext.trim()
    : '故事刚启幕或暂无上章正文，按本章梗概起笔即可。';
  const memoryBlock = storyMemoryBlock?.trim()
    ? storyMemoryBlock.trim()
    : '（本书级记忆尚未建立；仍须承接前情与角色状态。）';
  const intentBlock = chapterIntentBlock?.trim()
    ? chapterIntentBlock.trim()
    : '（写前意图未设定；按梗概推进。）';
  const genreBlock = genrePackBlock?.trim()
    ? genrePackBlock.trim()
    : '（通用网文节奏。）';
  const styleStruct = styleStructureSection(styleStructureBlock);

  const systemPrompt = `你是一位顶级好莱坞金牌编剧与网文大主编。请根据以下提供的**题材规则**、**写前意图**、**书级权威记忆**、**前情衔接**、本章梗概、出场角色和世界红线，将这一章细致拆解为 4 - 6 个具有黄金节奏、层层递进的 **分镜头情节点剧本 (Plot Beats)**。
硬性要求：
1. 第 1 个 Beat 必须承接**上章章末**现场与已定结果，直接进入「下一步动作/新信息」；禁止「重新开书」式自我介绍；
2. **反开篇复读**：第 1 个 Beat 禁止再写上章开篇已用过的环境建立、同套天气/光线/街景/感官堆叠；若前情含【上章开篇原文】或【高频意象】，必须避开；
3. 不得推翻【已钉死事实】与上章已定结果；
4. 对【未收伏笔】至少体现推进、回收或明确延期之一，禁止无故蒸发；
5. Beats 必须覆盖写前意图中的 must-do，且不得触碰 must-avoid；最后一个 Beat 应落到章末钩子附近；
6. 遵守题材禁忌与节奏，避免该题材常见崩坏。
请必须严格只输出合法 JSON 格式，不要有任何多余闲聊文字。JSON 结构如下：
{
  "beats": [
    {
      "order": 1,
      "description": "细致的镜头描述，例如：微雨过后的茶楼前，叶无痕指节轻压茶杯，观察隔壁暗卫的拔刀手势，利用眼角余光判断破绽。",
      "focusSense": "视觉微细节 & 心理算计"
    },
    {
      "order": 2,
      "description": "冲突交锋镜头，具体动作轨迹与功法法则呈现，避免空泛说教。",
      "focusSense": "空间力量反馈 & 听觉交鸣"
    }
  ]
}`;

  const userPrompt = `【题材规则包】：
${genreBlock}
${styleStruct}

【写前意图（本章控制面，优先执行）】：
${intentBlock}

【书级权威记忆（优先于临时发挥；手改条目不可违背）】：
${memoryBlock}

【前情衔接（必须承接，禁止吃书）】：
${prevBlock}

【本章核心剧情梗概】：
${chapterSummary}

【本章出场人物深度记忆切片】：
${charContext || '由主角主导情节推进。'}

【世界观规则与禁忌红线切片 (绝对不能违反，越界必罚)】：
${settingContext || '严格遵守常规物理与修真上限。'}

请拆解成 4-6 个紧凑有力的分镜头剧本（Beats），确保转折自然、感官画面鲜明。务必仅返回纯 JSON 格式。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export function buildChapterProsePrompt(
  chapter: Chapter,
  beats: PlotBeat[],
  characters: Character[],
  settings: WorldSetting[],
  styleConfig: StyleConfig,
  previousContext?: string,
  storyMemoryBlock?: string,
  chapterIntentBlock?: string,
  genrePackBlock?: string,
  /** 目标字数（中文字符粗算） */
  targetWordCount?: number | null,
  /** 本书题材：文风档案题材不匹配时降级为只学文笔层 */
  bookGenre?: string | null
) {
  const beatsText = beats.map(b => `[分镜头 #${b.order}] (${b.focusSense ? '主打感官：' + b.focusSense : ''})：${b.description}`).join('\n\n');
  const selectedStyle = styleConfig.fewShotExamples.find(e => e.id === styleConfig.selectedExampleId) || styleConfig.fewShotExamples[0];
  const activeStyleProfile = getActiveStyleProfile(styleConfig);
  const styleImitateBlock = formatStyleProfileForPrompt(activeStyleProfile, bookGenre);
  // 与写后机检同口径：题材附加词 + 自定义词 + 扩展套话表（白名单豁免）
  const blacklist = mergeExtendedBlacklist(styleConfig);
  const activeRules = settings.map(s => `《${s.name}》绝对红线：${(s.hardRules || []).join('；')}`).join('\n');
  const activeCharSummary = characters.map(c => `角色【${c.name}】当前状态/境界：${c.status} (${c.realmOrTitle})，性格：${c.personality}`).join('\n');
  const memoryBlock = storyMemoryBlock?.trim()
    ? storyMemoryBlock.trim()
    : '（本书级记忆尚未建立。）';
  const intentBlock = chapterIntentBlock?.trim()
    ? chapterIntentBlock.trim()
    : '（写前意图未设定。）';
  const genreBlock = genrePackBlock?.trim()
    ? genrePackBlock.trim()
    : '（通用网文。）';
  const target = targetWordCount && targetWordCount > 0 ? Math.round(targetWordCount) : 0;
  const low = target ? Math.round(target * 0.9) : 0;
  const high = target ? Math.round(target * 1.1) : 0;
  const wordRule = target
    ? `11. **字数区间（上下都是硬约束）**：本章正文字数（去空白中文字符）目标 ${target} 字，必须落在 ${low}–${high}：低于 ${low} 视为失败，**超过 ${high} 同样视为失败**。优先把每个分镜写实写足、靠密度与交锋把篇幅推进到下限以上；预计接近上限时才用具体动作或冷语收束本章。靠密度而非篇幅达标；禁止空洞注水、禁止复读凑长。`
    : '';
  const imitateRule = styleImitateBlock
    ? `12. **文风仿写铁律**：必须服从下方【文风仿写档案】的统计指纹与指南（句长、对白密度、要做/不要做）；禁止滑回通用 AI 网文腔。若档案带【题材不匹配降级铁律】，以其为最高优先级：只学文笔层，题材性机制禁止执行。`
    : '';
  // 句子长度下限（防碎片化）：允许短句与单句重音，但禁止连续超短句堆砌
  const sentenceFloorRule = `13. **句子长度下限（防碎片化）**：正文叙述句一般不少于 8 字；允许个别 ≤6 字短句作节奏重音（对白、拟声、强调语除外），但**禁止连续 3 句及以上 ≤6 字的碎句连发**（如「他走了。门关了。灯灭了。」需合并或补足成分）——碎句连发会破坏阅读节奏，属节奏破碎。`;

  const genreMismatch = isStyleGenreMismatch(activeStyleProfile, bookGenre);
  const exampleBlock = `【你的目标风格参考示例 — 严格模仿其行文短句与感官渲染${genreMismatch ? '（只学文笔层；选段的题材场面与元素禁止带进本章）' : ''}】：
示例风格名称：【${selectedStyle?.title || activeStyleProfile?.name || '冷峻质感风'}】
核心要领：${selectedStyle?.authorStyle || activeStyleProfile?.authorStyle || '短句紧凑，细节抓人'}
参考选段：
「${selectedStyle?.content || activeStyleProfile?.sampleExcerpt || ''}」`;

  const systemPrompt = styleImitateBlock
    ? `你是一位深谙类型小说节奏的文学大师，现在为第 ${chapter.number} 章《${chapter.title}》执笔。

【第一优先级 · 文风仿写：整章写成下面档案的样子（唯一最重要的指令，优先于一切文笔偏好）】
${styleImitateBlock}

${exampleBlock}

【题材优先规则】档案分文笔层（节奏/对白/白描/比喻）与题材气质两层。当档案的题材性机制（如恐怖并置、悬疑余味收尾、团战六拍、升级数值化、招式喊名口号、特定吐槽腔）与本书【题材规则包】冲突或与本书题材不匹配时，以题材规则包为准，题材性机制禁止执行；档案的文笔层始终执行。

【事实与结构红线（违反即失败）】
1. 世界法则与人物当前状态不得违反：闭关/重伤/被困/已死者不得越界行动
2. 书级记忆铁律：不得推翻【已钉死事实】；位置/伤势/境界不得无故跳变；【未收伏笔】不得无声消失
3. 写前意图铁律：必须完成 must-do；严禁触碰 must-avoid
4. 开头承接上章结尾：**首 1-3 行必须直接应答上章末段的钩子**（对话答对话/威胁答反击/刺激答生理反应/困境答破局），应答拍之后才引入新信息；禁止仿写上章开篇的氛围与意象；承接≠复述
5. 风格装置挂载纪律（无论何种文风档案）：并置、错位细节、意象重音、单句成段等装置只允许挂在情节转折/冲突爆发/揭示节拍上，每装置至多一处；禁止为凑数量在日常段落凭空插入诡异意象或突兀细节
6. **绝对反 AI 味黑名单（与文风仿写并列执行，优先级不低于仿写）**：输出中**一字不差禁止**出现以下套话短语，写稿时主动回避、禁止照进仿写摘录：
   【黑名单短语】：${blacklist.join('、') || '（无）'}。若出现即为失败——本篇写完还会有机检兜底，但合格稿不允许先写出再等修。
${wordRule}
${sentenceFloorRule}`
    : `你是一位荣获多项大奖、擅长高质感沉浸文学与顶尖网文的文学大师。
现在请你为第 ${chapter.number} 章《${chapter.title}》执笔撰写正文。

【最高铁律指令 — 你必须把下面每条当作生命红线执行】：
1. **Show, Don't Tell (展示而非陈述)**：绝对严禁出现“他心里感到恐惧”、“气氛变得极其诡异”、“眼神里露出震撼”这类廉价的告诉式描写！你必须通过手指微颤、瞳孔收缩、衣衫被冷汗浸透、地砖被内劲震出细密龟裂等微小动作与物理反馈来呈现情绪。
2. **绝对反 AI 味黑名单**：在你的输出中，**一字不差地禁止出现以下套话短语**：
   【黑名单短语】：${blacklist.join('、')}。若出现上述词汇即为彻底失败！
3. **句式与节奏质感**：多用利落短句，动词精确锋利；环境描写需融入角色的交互（例如不是枯燥写雨，而是写雨滴飞溅在兵刃断口处蒸发白雾）；严格对齐下述示例风格。
4. **强硬截断收尾（绝对不准升华）**：在章节末尾，**绝不允许发表任何总结式感悟、哲理长叹、探讨命运或天道哲理！** 必须且只能在【具体的物理交锋、一句冷语、或某个道具突然发生变化的瞬间】戛然而止！章末应落到写前意图给出的钩子附近。
5. **绝对遵守世界观法则与人物当前状态**：严禁违反下列世界法则，严禁让闭关/被困或受伤的角色凭空违规做出越界行为。
6. **书级记忆铁律**：不得推翻【已钉死事实】；不得让角色状态表中的位置/伤势/境界无故跳变；【未收伏笔】不得无声消失。
7. **写前意图铁律**：必须完成 must-do；严禁触碰 must-avoid。
8. **题材规则铁律**：遵守题材禁忌与节奏，给出题材应有的爽点/信息密度，禁止该题材常见崩坏。
9. **应答式开头（衔接铁律，优先于场景偏好）**：本章首 1-3 行必须直接应答【上章正文尾段】的最后一句钩子——对话用对话接、威胁用反击接、刺激用生理反应接、困境用破局动作接；应答拍之后才引入新动作/新信息/新冲突。若前情含【上章开篇原文】/【高频意象】，本章前 300 字内禁止仿写该段氛围与意象；禁止「环境建立→人物亮相→世界说明」与上章同构；承接≠复述，不重复上章已写信息。
10. **承接 ≠ 复述**：可承接语气与现场状态，但不得把上章已写过的景物段、感官段再扩写一遍。
11. **风格装置挂载纪律（无论使用哪种文风）**：并置、错位细节、意象重音、单句成段等装置只允许挂在情节转折/冲突爆发/揭示节拍上，每装置至多一处；禁止为凑数量在日常段落凭空插入诡异意象或突兀细节。
${wordRule}
${imitateRule}
${sentenceFloorRule}

${exampleBlock}`;

  const prevBlock = previousContext?.trim()
    ? previousContext.trim()
    : '故事刚启幕或平滑接续上回要点。';

  const userPrompt = `【目标章节】：第 ${chapter.number} 章《${chapter.title}》

【题材规则包】：
${genreBlock}

【写前意图】：
${intentBlock}

【书级权威记忆】：
${memoryBlock}

【前情衔接（硬性：开头承接章末现场；禁止重新开书；禁止复读上章开篇）】：
${prevBlock}

【出场角色状态切片】：
${activeCharSummary || '主角独白或探索情节。'}

【本章分镜头剧本 (Plot Beats) — 请循序渐进依次将每个 Beat 写成细致生动、极具张力的正文段落；每个 Beat 的首句承接上一 Beat 末句的现场（用因果或人物反应过渡，禁止另起炉灶重开环境）】：
${beatsText}

【特别强调红线规则】：
${activeRules || '遵循功法与空间限制'}
${
  target
    ? `\n【字数区间】目标 ${target} 字，必须落在 ${low}–${high}（去空白计）。把每个 Beat 写透写实、循序渐进把篇幅推进到下限以上；当剩余空间预计只够一个分镜时才开始收束本章；超过 ${high} 与低于 ${low} 同判不合格。写完前自行估字数校准。禁止注水复读。`
    : ''
}

【开篇自检（落笔前默念）】：前两段是否与上章开篇「同天气同街景同感官」？若是，必须换切口（对话打断、突发动作、新信息入场、时间跳跃到事后）。

请立即开始执笔第 ${chapter.number} 章正文。不用输出任何解说或大话，直接输出正文内容！`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 字数不足时的续写/加厚：在已有正文末尾自然接写，补足进目标区间。
 */
export function buildChapterExpandPrompt(options: {
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>;
  existingProse: string;
  currentWords: number;
  targetWordCount: number;
  minWordCount: number;
  /** 全章字数上限：合计越过此线同判不合格（默认 target × 1.1） */
  maxWordCount?: number;
  needMore: number;
  beats?: PlotBeat[];
  characters?: Character[];
  styleConfig?: StyleConfig;
  chapterIntentBlock?: string;
  blacklist?: string[];
}) {
  const {
    chapter,
    existingProse,
    currentWords,
    targetWordCount,
    minWordCount,
    maxWordCount = targetWordCount > 0 ? Math.round(targetWordCount * 1.1) : 0,
    needMore,
    beats = [],
    characters = [],
    styleConfig,
    chapterIntentBlock,
    blacklist = [],
  } = options;
  const tail = existingProse.trim().slice(-900);
  const beatsHint = beats.length
    ? beats.map((b) => `#${b.order} ${b.description}`).join('\n')
    : '（按梗概与已有正文逻辑继续）';
  const charHint = characters
    .slice(0, 6)
    .map((c) => `${c.name}（${c.status}/${c.realmOrTitle || '—'}）`)
    .join('；');
  // 全量注入（与写稿分支同口径），不截断、不用硬编码默认词冒充黑名单
  const bl = blacklist.length ? blacklist.join('、') : '（无）';
  const intent = chapterIntentBlock?.trim() || '（沿用本章既有意图）';
  const activeProfile = styleConfig ? getActiveStyleProfile(styleConfig) : null;
  const styleHint =
    activeProfile?.authorStyle ||
    styleConfig?.fewShotExamples?.find((e) => e.id === styleConfig.selectedExampleId)
      ?.authorStyle ||
    '短句利落，动作与感官具体';
  const imitateExtra = activeProfile
    ? `\n7. 保持文风仿写「${activeProfile.name}」：${activeProfile.authorStyle}；句长与对白密度贴近指纹。`
    : '';

  const systemPrompt = `你是网文连载执笔。任务：在【已有正文】之后自然续写，把本章字数补进目标区间 ${minWordCount}–${maxWordCount}。
硬性要求：
1. 只输出续写正文，不要重复粘贴已有正文，不要标题/解说/字数统计；
2. 续写首句直接承接【已有正文末段】的最后一句（因果或人物反应过渡），并与末段语气、人物位置、冲突状态无缝衔接；
3. 通过新动作、对白交锋、信息差、阻力与代价加厚，禁止同句复读注水；
4. 禁止章末升华/命运说教；可在补足后落到具体动作或冷语钩子；
5. 禁止黑名单：${bl}；
6. 本次续写约 ${needMore} 字（去空白），使全章合计进入 ${minWordCount}–${maxWordCount} 区间（目标 ${targetWordCount}）。把新冲突、新交锋写实写足，不要三两句就收；合计进入区间后以具体动作或冷语收束本章，**严禁越过 ${maxWordCount}**。
风格：${styleHint}${imitateExtra}`;

  const userPrompt = `【章节】第${chapter.number}章《${chapter.title}》
【梗概】${(chapter.summary || '').slice(0, 280)}
【写前意图】
${intent}
【出场】${charHint || '—'}
【分镜备忘】
${beatsHint}

【当前字数】${currentWords}（目标区间 ${minWordCount}–${maxWordCount}，还差约 ${needMore}）

【已有正文末段（承接，勿重复输出此段）】
……${tail}

请从下一句起续写，加厚中后段冲突与现场；写到合计进入区间即以收束句停笔，不要继续输出。只输出续写正文。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 阶段 A：硬伤审 —— 只查吃书/战力/时间线/生死道具/人称，不改正文文笔。
 */
export function buildHardReviewPrompt(
  prose: string,
  characters: Character[],
  settings: WorldSetting[],
  extras?: {
    previousContext?: string;
    storyMemoryBlock?: string;
    chapterIntentBlock?: string;
    /** 长章分段送审时的位置说明（如「第 2/3 段，开头承接上文」） */
    segmentNote?: string;
    /** 修复环已修清单：核验这些点是否真正修好，**只报修复后仍存在或新出现**的矛盾 */
    previouslyFixed?: string[];
    /** 修复后复核标志：只判断「是否还有阻断级硬伤」，不再对整章重新挑刺 */
    isRecheck?: boolean;
  }
) {
  const charRules = characters
    .map(
      (c) =>
        `【${c.name}】境界/身份=${c.realmOrTitle || '—'}，状态=${c.status}，所在=${c.currentLocation || '—'}，暗线=${(c.secretNotes || '').slice(0, 80) || '—'}`
    )
    .join('\n');
  const settingRules = settings
    .map((s) => `【${s.name}】铁律：${(s.hardRules || []).join('；')}`)
    .join('\n');

  let body = prose.trim();
  if (body.length > 7000) {
    body = `${body.slice(0, 3200)}\n\n……（中间省略）……\n\n${body.slice(-3200)}`;
  }

  const systemPrompt = `你是连载小说「硬伤审查官」，只负责事实与逻辑红线，不负责文笔润色。
检查维度（仅这些）：
1. 状态冲突：重伤/闭关/被困/已死角色做出不可能动作
2. 战力越界：境界/资源不足以完成的结果
3. 时间线错乱：先后顺序自相矛盾
4. 吃书矛盾：与前情或钉死事实冲突
5. 道具归属：关键物品无故出现/消失/换手无交代
6. 人称混乱：视角人称无故跳变

硬性规则：
- 只输出 JSON，无 markdown
- 不要改写正文，不要评价文笔/套话
- severity=error 表示**可确认的矛盾**，必须修才能定稿；warn 为可疑/待定，不阻断
- **从严认定 error**：只有正文在立场/状态/时间/归属上存在**可指认的反证**才算 error；仅「读者可能疑惑」「前后语感不同」「疑似」一律 warn——宁可漏报不要错杀，误报会把本章永久卡在门槛外
- 无问题时 issues 为空数组，hardPassed=true
**证据纪律（防幻觉硬伤，优先级最高）**：
- 每条 issue 必须附 evidenceA（从【待审正文】**逐字复制**的引文，10–40 字，定位指控位置）与 evidenceB（从【书级记忆】/【写前意图】/【前情】/本章其他位置**逐字复制**的引文，作为被违反的依据）
- 引文必须一字不改（含标点）；**禁止**转述、概括、凭记忆重写、用省略号拼接两处
- evidenceB.source 取值：memory=书级记忆 | intent=写前意图 | previous=前情 | chapter=本章其他位置
- 引文会经程序逐字核验：**给不出合规引文的问题不得列为 error**（最多 warn）；引文不实会被整条降级
打分校准（锚点，压方差）：
- 零冲突且无疑点 → 95-100；仅 warn 级疑点且可自洽 → 80-90
- 1 处 error → 55-70；2 处及以上 error → <55
- 先把文本归入锚点区间，再在区间内给分；禁止无解释的中间分（如"73"）${extras?.isRecheck ? `
模式：本调用是**修复后的复核**。上一轮已给出且修复的清单见下方【已修清单】；你只需：
- 逐条核验是否真正修好；
- 核验过程中只报「仍存在」或「新出现」的 error；已修好、或仅措辞不同的不算问题；
- 不开放新的审查维度，不对整章重新挑刺。` : ''}
JSON：
{
  "hardScore": 90,
  "hardPassed": true,
  "summary": "一句话结论",
  "issues": [
    {
      "type": "战力越界",
      "severity": "error",
      "description": "具体位置与冲突",
      "suggestion": "如何改才自洽",
      "evidenceA": { "source": "chapter", "quote": "本章原文逐字摘录10-40字" },
      "evidenceB": { "source": "memory", "quote": "被违反的记忆/前情原文逐字摘录" }
    }
  ]
}
type 只能是：状态冲突|战力越界|时间线错乱|吃书矛盾|道具归属|人称混乱|其他硬伤`;

  const userPrompt = `【前情】
${extras?.previousContext?.trim() || '（无/开篇）'}

【书级记忆】
${extras?.storyMemoryBlock?.trim() || '（无）'}

【写前意图/禁止项】
${extras?.chapterIntentBlock?.trim() || '（无）'}
${extras?.segmentNote ? `\n【分段说明】本章正文过长，分段送审。当前为${extras.segmentNote}：段首可能直接承接上文、段尾可能未完，均不算问题；只审本段内部及其与前情/记忆的事实矛盾。\n` : ''}${extras?.previouslyFixed?.length ? `\n【已修清单（上一轮已列出的问题，请核验是否已修好）】\n${(extras.previouslyFixed || []).map((d, i) => `${i + 1}. ${d}`).join('\n')}\n` : ''}
【角色状态】
${charRules || '（无）'}

【世界铁律】
${settingRules || '（无）'}

【待审正文】
${body}

只输出硬伤 JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 辩护人二次意见（P1 防误报第二道闸）：对已通过逐字引文核验的硬伤指控，
 * 换「为作者辩护」立场复核——只有两条证据所陈述事实**必然不能同时成立**才维持原判。
 * 仅喂指控与两条引文 + 本章全文（供找遗漏上下文），不给审校的原判（防锚定）。
 */
export function buildHardDefensePrompt(options: {
  prose: string;
  description: string;
  evidenceA?: { source?: string; quote?: string };
  evidenceB?: { source?: string; quote?: string };
}) {
  let body = options.prose.trim();
  if (body.length > 7000) {
    // 证据定位窗口：头尾截断会让辩护人对章节中段的指控结构性失明
    // （「后文已化解」的辩护路径被物理关闭）。verified 指控的引文必逐字命中本章，
    // 以命中点为中心切 ±1500 字窗口（A/B 证据各一个，重叠则合并），找不到引文才退回头尾截断。
    const WINDOW = 1500;
    const spans: { start: number; end: number }[] = [];
    const locate = (quote?: string) => {
      const q = (quote || '').trim();
      if (!q) return;
      const idx = body.indexOf(q);
      if (idx >= 0) {
        spans.push({
          start: Math.max(0, idx - WINDOW),
          end: Math.min(body.length, idx + q.length + WINDOW),
        });
      }
    };
    locate(options.evidenceA?.quote);
    if ((options.evidenceB?.source || 'memory') === 'chapter') locate(options.evidenceB?.quote);
    if (spans.length) {
      spans.sort((a, b) => a.start - b.start);
      const merged: { start: number; end: number }[] = [];
      for (const s of spans) {
        const last = merged[merged.length - 1];
        if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
        else merged.push({ ...s });
      }
      body = merged
        .map(
          (s) =>
            `${s.start > 0 ? '……（前文省略）……\n\n' : ''}${body.slice(s.start, s.end)}${s.end < body.length ? '\n\n……（后文省略）……' : ''}`
        )
        .join('\n\n');
    } else {
      body = `${body.slice(0, 3200)}\n\n……（中间省略）……\n\n${body.slice(-3200)}`;
    }
  }
  const systemPrompt = `你是连载小说的「作者辩护人」。有人对本章提出一条硬伤指控，你的职责是为作者辩护。
请逐项检查指控是否可以被合理解释化解：
- 时间顺序：两件事是否发生在不同时间（先闩门后来人、先走后留等）
- 不同人物/视角：指控是否把 A 的行为安到了 B 头上
- 人物的猜测、误解、谎言、回忆、梦境或心理活动（非客观事实陈述）
- 文学描写/比喻而非客观事实
- 遗漏的上下文：本章其他位置是否已写明化解该矛盾的内容
- 指控是否依赖「没有写明、但指控方自己脑补」的前提
裁决标准（从严）：
- 只有当两条证据所陈述的事实**必然不能同时成立**、且本章内找不到任何化解路径时，才判 upheld
- 只要存在一个合理解释（哪怕需要 minor 推断），判 refuted
- 确实拿不准判 unclear
只输出 JSON，无 markdown：
{ "verdict": "upheld|refuted|unclear", "reason": "一句话关键依据" }`;

  const userPrompt = `【指控】
${options.description}

【证据A · 本章原文】
${options.evidenceA?.quote || '（未提供）'}

【证据B · 记忆/前情依据】
${options.evidenceB?.quote || '（未提供）'}（来源：${options.evidenceB?.source || 'memory'}）

【本章全文】
${body}

请输出辩护裁决 JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 推进度审：本章是否真的推动了故事（区别于一致性审校）。
 * 只判「有用没用」，不判「对不对」、不判「好不好看」。
 */
export function buildProgressionReviewPrompt(options: {
  chapterNumber: number;
  beats: { order: number; description: string }[];
  prose: string;
  /** 未收伏笔/暗线清单（文本片段） */
  openThreads: string[];
  /** 主线提示（写前意图的钩子/必做） */
  mainLineHint?: string;
}) {
  const beatsText = options.beats.length
    ? options.beats.map((b) => `- 分镜#${b.order}：${b.description}`).join('\n')
    : '（本章无分镜，按梗概整体判断推进度）';
  const threadsText = options.openThreads.length
    ? options.openThreads.map((t) => `- ${t}`).join('\n')
    : '（无登记伏笔，跳过伏笔维度）';

  const systemPrompt = `你是连载小说「进度审查官」，只回答一个问题：这一章有没有让故事往前走。
你不审事实一致性（另有硬伤审），不审文笔（另有文笔审），不评价辞藻。

审查维度（仅这些）：
1. 分镜完成度：每个分镜是否写成了有信息增量的场景（动作/对白/变化），还是一笔带过或复读
2. 主线推进：本章结束时，核心冲突/目标/局势相比开头是否有实质变化（新信息、新对手、新代价、关系变化都算；原地打斗/重复交待不算）
3. 注水度：复读已知信息、无功能对话、重复环境与心理描写的占比
4. 伏笔触达：给出的未收伏笔中，本章是否有推进（推进/合理悬置都算触达；彻底无视不算）

评分锚点（progressionScore 0-100）：
- 90+：主线明显推进且分镜全部落成场景
- 70-89：有推进，个别分镜偏虚
- 50-69：推进微弱或注水明显（读者会觉得「这章没事发生」）
- <50：原地踏步/纯过渡灌水
打分纪律：先按锚点归类区间，再在区间内给分；两次读同一章应落在同一区间。

硬性规则：
- 只输出 JSON，无 markdown；不要改写正文
- unfinishedBeats 只列「没写透」的分镜序号与原因，写透的不列
- wateriness 0-10：0=信息密度高，7+=大半在灌水
JSON：
{
  "progressionScore": 75,
  "mainLineAdvanced": true,
  "wateriness": 3,
  "unfinishedBeats": [{ "order": 2, "reason": "只写了一句台词就跳过" }],
  "touchedThreads": ["伏笔片段…"],
  "suggestions": ["一句可执行的补救建议"],
  "summary": "一句话结论"
}`;

  const userPrompt = `【本章】第 ${options.chapterNumber} 章

【主线提示】
${options.mainLineHint?.trim() || '（无显式意图，按章节自然预期判断）'}

【本章分镜】
${beatsText}

【未收伏笔/暗线】
${threadsText}

【正文】
${options.prose.trim()}

只输出推进度 JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 修复环升级档：补丁修不动时的 beat 级重写。
 * 指明「哪些分镜/问题没修好」，要求只重写相关段落、其余原样保留，返回全文。
 */
export function buildBeatRewritePrompt(options: {
  chapterNumber: number;
  prose: string;
  beats: { order: number; description: string }[];
  /** 未解决的冲突（补丁修复失败的） */
  conflicts: { type?: string; description: string; suggestion?: string }[];
  characters: Character[];
  extraRules?: string;
}) {
  const beatsText = options.beats
    .map((b) => `- 分镜#${b.order}：${b.description}`)
    .join('\n');
  const conflictText = options.conflicts
    .map(
      (c, i) =>
        `${i + 1}. [${c.type || '问题'}] ${c.description}${
          c.suggestion ? `（修法：${c.suggestion}）` : ''
        }`
    )
    .join('\n');
  const charText = options.characters
    .slice(0, 8)
    .map((c) => `【${c.name}】${c.realmOrTitle || ''} · 状态：${c.status || '—'} · ${c.currentLocation || '位置不明'}`)
    .join('\n');

  const systemPrompt = `你是连载小说的修订执笔。此前多轮定点补丁未能解决下列问题，现在你获得整段重写的权限。

任务红线：
1. **只重写与所列问题相关的段落/场景**（按分镜定位）；与问题无关的正文必须原样保留，不得顺手润色。
2. 修复所列的每一个问题；不得引入新事实、新角色、新设定。
3. 重写段落必须与前后的保留段落无缝衔接（承接现场、时态、称谓、道具状态）。
4. 保持原有叙事视角与节奏；遵守下方附加规则。
5. 直接输出重写后的**完整正文**（含未改动的段落），不输出任何说明、标题或diff。

【出场角色状态（约束）】
${charText || '（略）'}
${options.extraRules ? `\n${options.extraRules}` : ''}`;

  const userPrompt = `【本章】第 ${options.chapterNumber} 章

【本章分镜（定位重写范围的依据）】
${beatsText || '（无分镜记录，按问题描述定位）'}

【必须修复的问题（补丁已失败，须重写解决）】
${conflictText || '（无——不应进入本流程）'}

【当前正文（在此基础上重写）】
${options.prose.trim()}

请输出重写后的完整正文。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 阶段 B：文笔审 —— 去 AI 味、截断升华、轻度润色；不负责硬伤定生死。
 */
export function buildStyleReviewPrompt(
  prose: string,
  styleConfig: StyleConfig,
  characters: Character[]
) {
  const blacklist = [...(styleConfig.clicheBlacklist || []), ...(styleConfig.customBlacklist || [])];
  const names = characters.map((c) => c.name).join('、') || '（未绑定）';
  // 文风保护 + 收敛：激活档案时，润色不得破坏其节奏器官与指纹，且要把偏离语感的段落贴齐
  const activeProfile = getActiveStyleProfile(styleConfig);
  const styleGuardLines: string[] = [];
  if (activeProfile) {
    styleGuardLines.push(
      `8. 保持文风档案「${activeProfile.name}」的节奏指纹：${activeProfile.authorStyle}`
    );
    if (activeProfile.punctuationTolerance === 'ellipsis-emphatic') {
      styleGuardLines.push(
        '9. 本文风以省略号「……」与短句为节奏器官：不得删除或替换省略号，不得把短句合并成长句'
      );
    }
    const ref =
      activeProfile.sampleExcerpts?.[0]?.text || activeProfile.sampleExcerpt || '';
    styleGuardLines.push(
      `10. 向档案语感收敛：把偏离档案节奏/用词/比喻风格的段落改写贴齐（长句拆短、文学腔比喻改生活化、抽象名词改具体物件）。\n【档案语感参照】\n${ref.slice(0, 350)}`
    );
  }
  const styleGuard = styleGuardLines.length ? `\n${styleGuardLines.join('\n')}` : '';

  let body = prose.trim();
  if (body.length > 8000) {
    body = `${body.slice(0, 3500)}\n\n……（中间省略）……\n\n${body.slice(-3500)}`;
  }

  const systemPrompt = `你是小说「文笔审校官」。任务：提升可读性、去 AI 味、截断升华，但不得改变主线事实结果（谁死谁活、关键胜负、关键道具归属）。
原则：改味不改剧；改最少（能换词不换句）；不整段删情节。
执行：
1. 清除黑名单套话与情绪直给（告诉式）
2. 打散 AI 句式：不是…而是…、…带着…、声音不大却…、连续排比
3. 删除解释腔/上帝感：她不知道的是、殊不知、之所以…是因为、这意味着
4. 删除章末哲理升华/命运说教，收在具体动作或对白
5. 适当打碎过匀段落节奏；对话标签过密时用动作替代部分「说道」
6. 给出 0–5 条文笔改进建议（可被作者拒绝）
7. 输出 polishedProse：可应用的润色全文；若几乎无需改动可接近原文${styleGuard}
styleScore 打分锚点（先归类再给分）：90+=可直接发布；80-89=小修即可；70-79=有明显 AI 味需多轮润色；<70=建议重写。
只输出 JSON：
{
  "styleScore": 82,
  "summary": "一句话",
  "suggestions": ["建议1", "建议2"],
  "removedClichésList": ["套话"],
  "removedSublimationsCount": 0,
  "polishedProse": "润色后的完整正文"
}`;

  const userPrompt = `【出场角色名】${names}
【Show don't tell】${styleConfig.enforceShowDontTell !== false ? '开启' : '关闭'}
【禁升华】${styleConfig.forbidEndingSublimation !== false ? '开启' : '关闭'}
【黑名单】${blacklist.join('、') || '（无）'}

【正文】
${body}

输出文笔 JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/** @deprecated 保留别名：旧单段审校，现由硬伤+文笔双阶段替代 */
export function buildCriticAndVerifyPrompt(
  prose: string,
  characters: Character[],
  settings: WorldSetting[],
  styleConfig: StyleConfig
) {
  // 兼容旧调用：拼成「偏硬伤+轻文笔」的旧结构
  const hard = buildHardReviewPrompt(prose, characters, settings);
  const style = buildStyleReviewPrompt(prose, styleConfig, characters);
  return [
    hard[0],
    {
      role: 'user',
      content: `${hard[1].content}\n\n（兼容模式请同时考虑文笔：）\n${style[1].content}\n请仍尽量按旧字段 verificationScore/logicConflicts/polishedProse 输出。`,
    },
  ];
}

/**
 * 冲突驱动局部/全文修复：只根据 conflict 列表改写，禁止自评「已完美」。
 */
export function buildConflictFixPrompt(
  prose: string,
  conflicts: {
    type?: string;
    description: string;
    suggestion?: string;
    phrase?: string;
  }[],
  styleConfig: StyleConfig,
  characters: Character[],
  settings: WorldSetting[],
  /** 字数带：修复后全篇须落在 low–high（不传则不约束） */
  wordBand?: { low: number; high: number }
) {
  const blacklist = [...(styleConfig.clicheBlacklist || []), ...(styleConfig.customBlacklist || [])];
  const conflictLines = conflicts
    .map((c, i) => {
      const head = c.type ? `[${c.type}] ` : '';
      const sug = c.suggestion ? ` → 建议：${c.suggestion}` : '';
      const ph = c.phrase ? `（禁写：${c.phrase}）` : '';
      return `${i + 1}. ${head}${c.description}${ph}${sug}`;
    })
    .join('\n');

  const charRules = characters
    .map((c) => `【${c.name}】${c.status}/${c.realmOrTitle} @${c.currentLocation}`)
    .join('\n');
  const settingRules = settings
    .slice(0, 6)
    .map((s) => `【${s.name}】${(s.hardRules || []).slice(0, 2).join('；')}`)
    .join('\n');

  let body = prose.trim();
  const maxChars = 8000;
  const truncated = body.length > maxChars;
  if (truncated) {
    body = `${body.slice(0, 3500)}\n\n……（中间省略，请保持情节连续）……\n\n${body.slice(-3500)}`;
  }

  const systemPrompt = `你是小说「冲突修复编辑」，不是评论家。
任务：根据【必须修复的冲突清单】改写正文，使清单内问题消失。
硬性规则：
1. 只输出合法 JSON，不要 markdown。
2. 禁止出现黑名单短语：${blacklist.slice(0, 40).join('、') || '（无）'}。
3. 禁止章末命运升华、哲理长叹、顿悟说教；结尾停在具体动作/对白/道具。
4. 不得改变已发生的主线结果（谁死谁活、关键胜负），只能改写表达或修正越界描写。
5. 不得新增与冲突无关的大段支线。
6. **优先局部修改**：尽量只改冲突相关段落；能用 localPatches 解决时优先给 localPatches（before 必须是原文连续子串，一字不差）。
7. 若局部不够，再给完整 fixedProse；二者可同时给（以 fixedProse 为准若提供）。
8. fixedProse 若提供必须是完整可读正文。${truncated ? `
9. **长章铁律（最高优先级）**：本章过长，【待修复正文】只提供了开头与结尾片段（中间已省略）。你**没有见过中间部分，禁止输出完整 fixedProse**——凭想象重写中段必然制造新的事实错误。只允许 localPatches 修复，且 before 必须逐字取自所提供的首尾片段原文；位于中段的问题跳过并在 remainingRisks 中说明「中段问题需分段修复」。` : ''}${wordBand ? `
${truncated ? '10' : '9'}. **字数铁律**：修复是等量替换——用同样的篇幅把错的改对，严禁借机扩写、加厚情节或补写新场景。修后全文字数必须落在 ${wordBand.low}–${wordBand.high}（去空白计），超过上限与不足同判失败。` : ''}
JSON：
{
  "localPatches": [
    { "before": "原文中需替换的连续片段", "after": "替换后的片段" }
  ],
  "fixedProse": "修复后的完整正文（可选，局部不够时必填）",
  "changesSummary": ["改动1", "改动2"],
  "remainingRisks": ["若仍可能残留的风险，可空数组"]
}`;

  const userPrompt = `【必须修复的冲突清单】：
${conflictLines || '（无显式冲突，请清洗套话并截断章末升华）'}

【角色状态】：
${charRules || '无'}

【世界红线】：
${settingRules || '无'}

【待修复正文】：
${body}
${wordBand ? `\n【字数上限】原文约 ${proseWords(body)} 字；修复后全篇须落在 ${wordBand.low}–${wordBand.high}。能用 localPatches 就不要整章重写。` : ''}

请输出 JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export const buildDetailedBeatsPrompt = buildChapterBeatsPrompt;
export const buildCriticVerifyPrompt = buildCriticAndVerifyPrompt;
export { buildChapterRecapPrompt as buildRecapPrompt };

