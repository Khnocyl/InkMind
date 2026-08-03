import type { ProjectConfig, Character, WorldSetting, PlotBeat, StyleConfig, Chapter } from '../types/novel';
import {
  formatStyleProfileForPrompt,
  getActiveStyleProfile,
} from './styleImitate';

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

export function buildTitleAndSynopsisPrompt(config: ProjectConfig) {
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

请根据以上灵感，构思一部爆款且极具口碑与质感的小说方案。必须输出纯合法 JSON 格式。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export function buildCharactersPrompt(_config: ProjectConfig, title: string, synopsis: string) {
  const systemPrompt = `你是一位畅销顶尖网络小说架构师，专精塑造立体深刻、极具个性与真实弧光的人物图谱。
请根据书名与故事梗概，推导生成包含主角、关键反派、重要师姐/知己、核心盟友及神秘高位者在内的 4-6 名主要人物图谱。
特别注意：性格需带有细微矛盾真实感；背景经历要有暗线伏笔；人物关系要有张力与秘密！
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

export function buildWorldbuildingPrompt(_config: ProjectConfig, title: string, synopsis: string, characters: Character[]) {
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
  settings: WorldSetting[]
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
4. 承接 previousTail 已发生事实，禁止吃书；
5. 本批属于「${volume.title}」（全书第 ${volume.startChapter}–${volume.endChapter} 章 / 全书共 ${totalChapters} 章）；
6. 本批应体现卷里程碑：${beats}；
7. 严格只输出合法 JSON。

JSON 格式：
{
  "chapters": [
    {
      "number": ${fromChapter},
      "title": "第${fromChapter}章 具体吸引人的标题（可含副题）",
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
  genrePackBlock?: string
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
  targetWordCount?: number | null
) {
  const beatsText = beats.map(b => `[分镜头 #${b.order}] (${b.focusSense ? '主打感官：' + b.focusSense : ''})：${b.description}`).join('\n\n');
  const selectedStyle = styleConfig.fewShotExamples.find(e => e.id === styleConfig.selectedExampleId) || styleConfig.fewShotExamples[0];
  const activeStyleProfile = getActiveStyleProfile(styleConfig);
  const styleImitateBlock = formatStyleProfileForPrompt(activeStyleProfile);
  const blacklist = [...(styleConfig.clicheBlacklist || []), ...(styleConfig.customBlacklist || [])];
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
  const high = target ? Math.round(target * 1.12) : 0;
  const wordRule = target
    ? `11. **字数硬门槛（必须达标）**：本章正文字数（去空白中文字符）目标 ${target} 字，**不得低于 ${low} 字**，建议落在 ${low}–${high}。每个分镜都要写成可落地的场景与交锋，禁止三言两语带过；禁止空洞注水、禁止复读同一句。写不够视为失败。`
    : '';
  const imitateRule = styleImitateBlock
    ? `12. **文风仿写铁律**：必须服从下方【文风仿写档案】的统计指纹与指南（句长、对白密度、要做/不要做）；禁止滑回通用 AI 网文腔。`
    : '';

  const systemPrompt = `你是一位荣获多项大奖、擅长高质感沉浸文学与顶尖网文的文学大师。
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
9. **反开篇复读（连章同质禁止）**：若前情含【上章开篇原文】/【高频意象】，本章前 300 字内禁止仿写该段氛围与意象；禁止「环境建立→人物亮相→世界说明」与上章同构；开头必须落在上章**章末之后**的新动作/新信息/新冲突。
10. **承接 ≠ 复述**：可承接语气与现场状态，但不得把上章已写过的景物段、感官段再扩写一遍。
${wordRule}
${imitateRule}

${styleImitateBlock ? `${styleImitateBlock}\n` : ''}
【你的目标风格参考示例 — 严格模仿其行文短句与感官渲染】：
示例风格名称：【${selectedStyle?.title || activeStyleProfile?.name || '冷峻质感风'}】
核心要领：${selectedStyle?.authorStyle || activeStyleProfile?.authorStyle || '短句紧凑，细节抓人'}
参考选段：
「${selectedStyle?.content || activeStyleProfile?.sampleExcerpt || ''}」`;

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

【本章分镜头剧本 (Plot Beats) — 请循序渐进依次将每个 Beat 写成细致生动、极具张力的正文段落】：
${beatsText}

【特别强调红线规则】：
${activeRules || '遵循功法与空间限制'}
${
  target
    ? `\n【字数硬门槛】目标 ${target} 字，最低 ${low} 字（去空白计）。请把每个 Beat 写透（动作/对白/感官/阻力），写完前自行估字数；不足请在章内继续推进情节而非提前收束。禁止注水复读。`
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
 * 字数不足时的续写/加厚：在已有正文末尾自然接写，补足到目标。
 */
export function buildChapterExpandPrompt(options: {
  chapter: Pick<Chapter, 'number' | 'title' | 'summary'>;
  existingProse: string;
  currentWords: number;
  targetWordCount: number;
  minWordCount: number;
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
  const bl = blacklist.length
    ? blacklist.slice(0, 24).join('、')
    : '那一刻、倒吸一口凉气、嘴角勾起一抹弧度';
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

  const systemPrompt = `你是网文连载执笔。任务：在【已有正文】之后自然续写，把本章字数补到硬门槛以上。
硬性要求：
1. 只输出续写正文，不要重复粘贴已有正文，不要标题/解说/字数统计；
2. 续写必须与末段语气、人物位置、冲突状态无缝衔接；
3. 通过新动作、对白交锋、信息差、阻力与代价加厚，禁止同句复读注水；
4. 禁止章末升华/命运说教；可在补足后落到具体动作或冷语钩子；
5. 禁止黑名单：${bl}；
6. 本次至少再写约 ${needMore} 字（去空白），使全章合计 ≥ ${minWordCount}（目标 ${targetWordCount}）。
风格：${styleHint}${imitateExtra}`;

  const userPrompt = `【章节】第${chapter.number}章《${chapter.title}》
【梗概】${(chapter.summary || '').slice(0, 280)}
【写前意图】
${intent}
【出场】${charHint || '—'}
【分镜备忘】
${beatsHint}

【当前字数】${currentWords}（目标 ${targetWordCount}，最低 ${minWordCount}，还差约 ${needMore}）

【已有正文末段（承接，勿重复输出此段）】
……${tail}

请从下一句起续写，加厚中后段冲突与现场，直到字数足够。只输出续写正文。`;

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
- severity=error 表示必须修才能定稿；warn 为可疑
- 无问题时 issues 为空数组，hardPassed=true
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
      "suggestion": "如何改才自洽"
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
 * 阶段 B：文笔审 —— 去 AI 味、截断升华、轻度润色；不负责硬伤定生死。
 */
export function buildStyleReviewPrompt(
  prose: string,
  styleConfig: StyleConfig,
  characters: Character[]
) {
  const blacklist = [...(styleConfig.clicheBlacklist || []), ...(styleConfig.customBlacklist || [])];
  const names = characters.map((c) => c.name).join('、') || '（未绑定）';

  let body = prose.trim();
  if (body.length > 8000) {
    body = `${body.slice(0, 3500)}\n\n……（中间省略）……\n\n${body.slice(-3500)}`;
  }

  const systemPrompt = `你是小说「文笔审校官」。任务：提升可读性、去 AI 味、截断升华，但不得改变主线事实结果（谁死谁活、关键胜负、关键道具归属）。
原则（对齐专业去AI味）：改味不改剧；改最少（能换词不换句）；不整段删情节。
执行：
1. 清除黑名单套话与情绪直给（告诉式）
2. 打散 AI 句式：不是…而是…、…带着…、声音不大却…、连续排比
3. 删除解释腔/上帝感：她不知道的是、殊不知、之所以…是因为、这意味着
4. 删除章末哲理升华/命运说教，收在具体动作或对白
5. 适当打碎过匀段落节奏；对话标签过密时用动作替代部分「说道」
6. 给出 0–5 条文笔改进建议（可被作者拒绝）
7. 输出 polishedProse：可应用的润色全文；若几乎无需改动可接近原文
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
  settings: WorldSetting[]
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
  if (body.length > maxChars) {
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
8. fixedProse 若提供必须是完整可读正文。
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

请输出 JSON。`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

export const buildDetailedBeatsPrompt = buildChapterBeatsPrompt;
export const buildCriticVerifyPrompt = buildCriticAndVerifyPrompt;
export { buildChapterRecapPrompt as buildRecapPrompt };

