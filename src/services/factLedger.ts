/**
 * 结构化事实账本：
 * - 章后启发式抽取（角色死/状态/地点/道具归属/事件）
 * - 合并进 StoryMemory.factLedger
 * - 写后正文 vs 账本对账（可复现，不调 LLM）
 */

import type {
  Character,
  Chapter,
  ChapterFactSnapshot,
  ChapterRecap,
  CharacterStatus,
  FactAssertion,
  FactAssertionKind,
  FactLedger,
  HardReviewIssue,
  StoryMemory,
  StoryTimeAnchor,
  WorldEntityState,
} from '../types/novel';

const MAX_ACTIVE = 120;
const MAX_SNAPSHOTS = 30;
const MAX_TIMELINE = 40;
const MAX_ITEMS = 40;
const MAX_LOCATIONS = 40;

function nowIso(): string {
  return new Date().toISOString();
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertId(
  kind: FactAssertionKind,
  subject: string,
  chapter: number,
  salt = 0
): string {
  const sub = subject.replace(/\s+/g, '').slice(0, 16);
  return `fa-${kind}-${sub}-c${chapter}${salt ? `-${salt}` : ''}`.slice(0, 72);
}

function emptyLedger(): FactLedger {
  return {
    assertions: [],
    recentSnapshots: [],
    storyDayCursor: 1,
    timeline: [],
    updatedAt: nowIso(),
  };
}

function normalizeTimelineEntry(raw: unknown): StoryTimeAnchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const chapterNumber =
    typeof r.chapterNumber === 'number' ? r.chapterNumber : 0;
  const label = String(r.label || '').trim();
  if (chapterNumber <= 0 || !label) return null;
  return {
    chapterNumber,
    label: label.slice(0, 48),
    storyDay: typeof r.storyDay === 'number' ? r.storyDay : undefined,
    dayDelta: typeof r.dayDelta === 'number' ? r.dayDelta : undefined,
    extractedAt: String(r.extractedAt || nowIso()),
  };
}

export function normalizeFactLedger(raw: unknown): FactLedger {
  if (!raw || typeof raw !== 'object') return emptyLedger();
  const r = raw as Record<string, unknown>;
  const assertions = Array.isArray(r.assertions)
    ? r.assertions
        .map((a, i) => normalizeAssertion(a, i))
        .filter((a): a is FactAssertion => !!a)
        .slice(0, MAX_ACTIVE)
    : [];
  const snaps = Array.isArray(r.recentSnapshots)
    ? r.recentSnapshots
        .map((s) => normalizeSnapshot(s))
        .filter((s): s is ChapterFactSnapshot => !!s)
        .slice(-MAX_SNAPSHOTS)
    : [];
  const timeline = Array.isArray(r.timeline)
    ? r.timeline
        .map((t) => normalizeTimelineEntry(t))
        .filter((t): t is StoryTimeAnchor => !!t)
        .slice(-MAX_TIMELINE)
    : [];
  return {
    assertions,
    recentSnapshots: snaps,
    storyDayCursor:
      typeof r.storyDayCursor === 'number' && r.storyDayCursor >= 1
        ? Math.floor(r.storyDayCursor)
        : timeline.length
          ? Math.max(...timeline.map((t) => t.storyDay || 1))
          : 1,
    timeline,
    updatedAt:
      typeof r.updatedAt === 'string' ? r.updatedAt : nowIso(),
  };
}

/** 中文小数字 → 阿拉伯（1–30 粗解析） */
function parseCnNum(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) return Math.min(365, parseInt(t, 10));
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (map[t] != null) return map[t];
  if (t.startsWith('十') && t.length === 2 && map[t[1]]) return 10 + map[t[1]];
  if (t.endsWith('十') && t.length === 2 && map[t[0]]) return map[t[0]] * 10;
  if (t.length === 3 && t[1] === '十' && map[t[0]] && map[t[2]]) {
    return map[t[0]] * 10 + map[t[2]];
  }
  return null;
}

/**
 * 从文本估计相对上章的「故事日」增量。
 * 返回 { delta, label }；无时间词则 null。
 */
export function parseStoryDayDelta(
  text: string
): { delta: number; label: string } | null {
  const blob = (text || '').replace(/\s+/g, '');
  if (!blob) return null;

  if (/(半个月|半月)后/.test(blob)) return { delta: 15, label: '半月后' };
  if (/(一个月|一月)后/.test(blob)) return { delta: 30, label: '一月后' };
  if (/一年后|周岁后/.test(blob)) return { delta: 365, label: '一年后' };

  const m = blob.match(
    /(?:过了)?([一二三四五六七八九十两\d]{1,3})(?:日|天)后/
  );
  if (m) {
    const n = parseCnNum(m[1]);
    if (n != null && n > 0) return { delta: n, label: `${n}日后` };
  }
  if (/次日|翌日|第二天|隔日/.test(blob)) return { delta: 1, label: '次日' };
  if (/当晚|当夜|当日|同日|当天|此时此刻/.test(blob)) {
    return { delta: 0, label: '当日' };
  }
  if (/黎明|清晨|破晓/.test(blob.slice(0, 40))) {
    // 章首黎明常为次日
    return { delta: 1, label: '清晨/黎明' };
  }
  return null;
}

function normalizeAssertion(raw: unknown, index: number): FactAssertion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const subject = String(r.subject || '').trim();
  const claim = String(r.claim || '').trim();
  if (!subject || claim.length < 2) return null;
  const kind = normalizeKind(r.kind);
  const status =
    r.status === 'superseded' || r.status === 'retracted' ? r.status : 'active';
  return {
    id: String(r.id || `fa-legacy-${index}`),
    kind,
    subject: subject.slice(0, 24),
    claim: claim.slice(0, 160),
    value: typeof r.value === 'string' ? r.value.slice(0, 48) : undefined,
    sourceChapterNumber:
      typeof r.sourceChapterNumber === 'number' ? r.sourceChapterNumber : 0,
    createdAt: String(r.createdAt || nowIso()),
    status,
    supersededBy:
      typeof r.supersededBy === 'string' ? r.supersededBy : undefined,
    note: typeof r.note === 'string' ? r.note.slice(0, 80) : undefined,
  };
}

function normalizeKind(raw: unknown): FactAssertionKind {
  const k = String(raw || '');
  const allowed: FactAssertionKind[] = [
    'death',
    'character_status',
    'character_location',
    'item_owner',
    'item_state',
    'location_state',
    'event',
    'time_anchor',
  ];
  return (allowed as string[]).includes(k) ? (k as FactAssertionKind) : 'event';
}

function normalizeSnapshot(raw: unknown): ChapterFactSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const chapterNumber =
    typeof r.chapterNumber === 'number' ? r.chapterNumber : 0;
  if (chapterNumber <= 0) return null;
  const assertions = Array.isArray(r.assertions)
    ? r.assertions
        .map((a, i) => normalizeAssertion(a, i))
        .filter((a): a is FactAssertion => !!a)
    : [];
  return {
    chapterNumber,
    chapterId: typeof r.chapterId === 'string' ? r.chapterId : undefined,
    extractedAt: String(r.extractedAt || nowIso()),
    source:
      r.source === 'llm' || r.source === 'mixed' ? r.source : 'heuristic',
    assertions,
    summary: typeof r.summary === 'string' ? r.summary.slice(0, 200) : undefined,
  };
}

export function listActiveAssertions(
  ledger?: FactLedger | null
): FactAssertion[] {
  return (ledger?.assertions || []).filter((a) => a.status === 'active');
}

function pushAssert(
  list: FactAssertion[],
  partial: Omit<FactAssertion, 'id' | 'createdAt' | 'status'> & {
    id?: string;
    status?: FactAssertion['status'];
  }
): void {
  const subject = partial.subject.trim();
  const claim = partial.claim.trim();
  if (subject.length < 1 || claim.length < 2) return;
  const id =
    partial.id ||
    assertId(partial.kind, subject, partial.sourceChapterNumber, list.length);
  // 同章同 kind+subject+value 去重
  const key = `${partial.kind}|${subject}|${partial.value || claim}`;
  if (
    list.some(
      (a) =>
        `${a.kind}|${a.subject}|${a.value || a.claim}` === key &&
        a.sourceChapterNumber === partial.sourceChapterNumber
    )
  ) {
    return;
  }
  list.push({
    id,
    kind: partial.kind,
    subject: subject.slice(0, 24),
    claim: claim.slice(0, 160),
    value: partial.value?.slice(0, 48),
    sourceChapterNumber: partial.sourceChapterNumber,
    createdAt: nowIso(),
    status: partial.status || 'active',
    note: partial.note,
  });
}

/**
 * 从角色卡 + recap + 正文启发式抽取本章事实快照。
 */
export function extractChapterFactSnapshot(input: {
  chapter: Pick<Chapter, 'id' | 'number' | 'title' | 'involvedCharacterIds'>;
  prose: string;
  recap?: ChapterRecap | null;
  characters?: Character[];
}): ChapterFactSnapshot {
  const chN = input.chapter.number;
  const prose = input.prose || '';
  const recap = input.recap;
  const blob = [
    recap?.text || '',
    recap?.endingState || '',
    ...(recap?.keyFacts || []),
    prose.slice(-1200),
  ].join('\n');

  const assertions: FactAssertion[] = [];
  const chars = input.characters || [];
  const involved = new Set(input.chapter.involvedCharacterIds || []);

  // —— 角色：死亡 / 状态 / 地点 ——
  for (const c of chars) {
    const inScope =
      involved.size === 0 ||
      involved.has(c.id) ||
      prose.includes(c.name) ||
      blob.includes(c.name);
    if (!inScope) continue;

    if (c.status === '已阵亡/退出' || /阵亡|身亡|已死|陨落/.test(c.status || '')) {
      pushAssert(assertions, {
        kind: 'death',
        subject: c.name,
        claim: `${c.name}已阵亡/退出（角色卡）`,
        value: 'dead',
        sourceChapterNumber: chN,
        note: 'from_character_card',
      });
    } else if (c.status && c.status !== '活跃') {
      pushAssert(assertions, {
        kind: 'character_status',
        subject: c.name,
        claim: `${c.name}状态：${c.status}`,
        value: c.status,
        sourceChapterNumber: chN,
        note: 'from_character_card',
      });
    }

    const loc = (c.currentLocation || '').trim();
    if (loc.length >= 2) {
      pushAssert(assertions, {
        kind: 'character_location',
        subject: c.name,
        claim: `${c.name}所在：${loc}`,
        value: loc,
        sourceChapterNumber: chN,
        note: 'from_character_card',
      });
    }

    // 正文/recap：X死了 / X身亡
    const deathRe = new RegExp(
      `${escapeReg(c.name)}[^。！？\\n]{0,8}(身亡|阵亡|已死|死去|陨落|毙命|气绝)`
    );
    if (deathRe.test(blob)) {
      pushAssert(assertions, {
        kind: 'death',
        subject: c.name,
        claim: `${c.name}在文中被描述为死亡/阵亡`,
        value: 'dead',
        sourceChapterNumber: chN,
        note: 'from_text',
      });
    }

    // X在YYY（ending 优先）
    const atRe = new RegExp(
      `${escapeReg(c.name)}[^。！？\\n]{0,6}在([\\u4e00-\\u9fff]{2,10})`
    );
    const atM = (recap?.endingState || blob).match(atRe);
    if (atM?.[1] && !/^(此|那|这|其|心|梦|意)/.test(atM[1])) {
      pushAssert(assertions, {
        kind: 'character_location',
        subject: c.name,
        claim: `${c.name}所在：${atM[1]}（文中）`,
        value: atM[1],
        sourceChapterNumber: chN,
        note: 'from_text',
      });
    }
  }

  // —— keyFacts 事件 + 归属 ——
  for (const f of recap?.keyFacts || []) {
    const t = f.trim();
    if (t.length < 4) continue;

    const own = t.match(
      /([\u4e00-\u9fff]{2,8})(?:归|属于)([\u4e00-\u9fff]{2,8})/
    );
    if (own) {
      pushAssert(assertions, {
        kind: 'item_owner',
        subject: own[1],
        claim: `${own[1]}归属：${own[2]}`,
        value: own[2],
        sourceChapterNumber: chN,
      });
      continue;
    }

    const lost = t.match(
      /([\u4e00-\u9fff]{2,8})(?:已)?(?:失去|被毁|损毁|破碎|遗失)/
    );
    if (lost) {
      pushAssert(assertions, {
        kind: 'item_state',
        subject: lost[1],
        claim: t.slice(0, 120),
        value: 'lost_or_destroyed',
        sourceChapterNumber: chN,
      });
      continue;
    }

    const dead = t.match(
      /([\u4e00-\u9fff]{2,8})(?:已)?(?:死|阵亡|身亡|陨落)/
    );
    if (dead) {
      pushAssert(assertions, {
        kind: 'death',
        subject: dead[1],
        claim: t.slice(0, 120),
        value: 'dead',
        sourceChapterNumber: chN,
      });
      continue;
    }

    pushAssert(assertions, {
      kind: 'event',
      subject: t.slice(0, 8),
      claim: t.slice(0, 120),
      sourceChapterNumber: chN,
    });
  }

  // —— endingState 作时间/现场锚 ——
  if (recap?.endingState?.trim()) {
    const end = recap.endingState.trim().slice(0, 100);
    pushAssert(assertions, {
      kind: 'time_anchor',
      subject: `第${chN}章末`,
      claim: `章末现场：${end}`,
      value: end.slice(0, 48),
      sourceChapterNumber: chN,
    });
  }

  // —— 故事时间词（正文头 + recap）→ time_anchor ——
  const timeSource = [
    (prose || '').slice(0, 200),
    recap?.text || '',
    recap?.endingState || '',
  ].join('\n');
  const dayHit = parseStoryDayDelta(timeSource);
  if (dayHit) {
    pushAssert(assertions, {
      kind: 'time_anchor',
      subject: `第${chN}章时序`,
      claim: `时间推进：${dayHit.label}（Δ${dayHit.delta}日）`,
      value: `delta:${dayHit.delta}`,
      sourceChapterNumber: chN,
      note: 'timeline',
    });
  }

  // —— 道具获得句 ——
  const itemRe =
    /([\u4e00-\u9fff]{2,6})(?:获得|得到|夺得|抢到|收下|握着)了?([\u4e00-\u9fff]{2,8})/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(blob)) !== null) {
    pushAssert(assertions, {
      kind: 'item_owner',
      subject: m[2],
      claim: `${m[2]}由${m[1]}持有/获得`,
      value: m[1],
      sourceChapterNumber: chN,
    });
  }

  const summaryParts = assertions
    .filter((a) => a.kind !== 'event')
    .slice(0, 6)
    .map((a) => a.claim);
  return {
    chapterNumber: chN,
    chapterId: input.chapter.id,
    extractedAt: nowIso(),
    source: 'heuristic',
    assertions: assertions.slice(0, 40),
    summary: summaryParts.join('； ').slice(0, 200),
  };
}

/**
 * 合并快照进账本：同 kind+subject 新断言覆盖旧 active。
 */
export function mergeSnapshotIntoLedger(
  ledger: FactLedger | null | undefined,
  snapshot: ChapterFactSnapshot
): FactLedger {
  const base = normalizeFactLedger(ledger || emptyLedger());
  const now = nowIso();
  let assertions = [...base.assertions];

  for (const incoming of snapshot.assertions) {
    // 仅覆盖可唯一主体类
    const coverKinds: FactAssertionKind[] = [
      'death',
      'character_status',
      'character_location',
      'item_owner',
      'item_state',
      'location_state',
    ];
    if (coverKinds.includes(incoming.kind)) {
      assertions = assertions.map((old) => {
        if (
          old.status === 'active' &&
          old.kind === incoming.kind &&
          old.subject === incoming.subject &&
          old.id !== incoming.id
        ) {
          // 值相同则保留旧（更新章号可选）；不同则 supersede
          if (old.value && incoming.value && old.value === incoming.value) {
            return {
              ...old,
              sourceChapterNumber: Math.max(
                old.sourceChapterNumber,
                incoming.sourceChapterNumber
              ),
              claim: incoming.claim || old.claim,
            };
          }
          return {
            ...old,
            status: 'superseded' as const,
            supersededBy: incoming.id,
          };
        }
        return old;
      });
    }
    // 去掉同 id
    assertions = assertions.filter((a) => a.id !== incoming.id);
    assertions.push({ ...incoming, status: 'active', createdAt: now });
  }

  // 活跃上限：优先保留 death / item_owner / 新近
  const active = assertions.filter((a) => a.status === 'active');
  if (active.length > MAX_ACTIVE) {
    const ranked = [...active].sort((a, b) => {
      const rank = (k: FactAssertionKind) =>
        k === 'death' ? 0 : k === 'item_owner' ? 1 : k === 'character_status' ? 2 : 3;
      return rank(a.kind) - rank(b.kind) || b.sourceChapterNumber - a.sourceChapterNumber;
    });
    const keepIds = new Set(ranked.slice(0, MAX_ACTIVE).map((a) => a.id));
    assertions = assertions.map((a) =>
      a.status === 'active' && !keepIds.has(a.id)
        ? { ...a, status: 'superseded' as const, note: '[账本上限归档]' }
        : a
    );
  }

  // 非 active 只留最近 40 条 superseded 备查
  const actives = assertions.filter((a) => a.status === 'active');
  const supers = assertions
    .filter((a) => a.status !== 'active')
    .sort((a, b) => b.sourceChapterNumber - a.sourceChapterNumber)
    .slice(0, 40);

  const snaps = [
    ...(base.recentSnapshots || []).filter(
      (s) => s.chapterNumber !== snapshot.chapterNumber
    ),
    snapshot,
  ]
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .slice(-MAX_SNAPSHOTS);

  // 时间线：从本章 time_anchor 推故事日
  let storyDayCursor = base.storyDayCursor ?? 1;
  let timeline = [...(base.timeline || [])].filter(
    (t) => t.chapterNumber !== snapshot.chapterNumber
  );
  const timeAssert = snapshot.assertions.find(
    (a) =>
      a.kind === 'time_anchor' &&
      (a.note === 'timeline' || (a.value || '').startsWith('delta:'))
  );
  let dayDelta = 0;
  let label = `第${snapshot.chapterNumber}章`;
  if (timeAssert?.value?.startsWith('delta:')) {
    dayDelta = Math.max(0, parseInt(timeAssert.value.slice(6), 10) || 0);
    label = timeAssert.claim.replace(/^时间推进：/, '').split('（')[0] || label;
  } else {
    // 无明确时间词：默认 +0～1 不强推；同日
    dayDelta = 0;
    const end = snapshot.assertions.find(
      (a) => a.kind === 'time_anchor' && a.subject.includes('章末')
    );
    if (end) label = end.value || end.claim.slice(0, 24);
  }
  // 首章从 1 起；有推进则累加
  if (timeline.length === 0 && snapshot.chapterNumber <= 1) {
    storyDayCursor = 1 + dayDelta;
  } else {
    storyDayCursor = Math.max(1, storyDayCursor + dayDelta);
  }
  timeline.push({
    chapterNumber: snapshot.chapterNumber,
    label: String(label).slice(0, 48),
    storyDay: storyDayCursor,
    dayDelta,
    extractedAt: now,
  });
  timeline = timeline
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .slice(-MAX_TIMELINE);

  return {
    assertions: [...actives, ...supers],
    recentSnapshots: snaps,
    storyDayCursor,
    timeline,
    updatedAt: now,
  };
}

export function mergeSnapshotIntoMemory(
  memory: StoryMemory | null | undefined,
  snapshot: ChapterFactSnapshot
): StoryMemory {
  // 避免与 storyMemory 循环依赖：浅合并即可
  const base = memory || {
    pinnedFacts: [],
    openThreads: [],
  };
  return {
    ...base,
    factLedger: mergeSnapshotIntoLedger(base.factLedger, snapshot),
    updatedAt: nowIso(),
  };
}

export interface LedgerReconcileHit {
  type: HardReviewIssue['type'];
  severity: 'error' | 'warn';
  description: string;
  suggestion: string;
  assertionId?: string;
}

export interface LedgerReconcileResult {
  passed: boolean;
  score: number;
  summary: string;
  issues: LedgerReconcileHit[];
}

/**
 * 正文 vs 账本对账（写后、可复现）。
 * 主要抓：死人行动、已毁道具再用、归属矛盾、地点硬跳（warn）。
 */
export function reconcileProseAgainstLedger(input: {
  prose: string;
  ledger?: FactLedger | null;
  characters?: Character[];
  /** 本章号：忽略「本章刚写入」的同章断言过严 */
  chapterNumber?: number;
}): LedgerReconcileResult {
  const prose = input.prose || '';
  const issues: LedgerReconcileHit[] = [];
  if (prose.replace(/\s+/g, '').length < 40) {
    return {
      passed: true,
      score: 100,
      summary: '正文过短，跳过账本对账',
      issues: [],
    };
  }

  const active = listActiveAssertions(input.ledger);
  if (!active.length) {
    return {
      passed: true,
      score: 100,
      summary: '账本为空，跳过对账',
      issues: [],
    };
  }

  const chN = input.chapterNumber ?? 9999;

  // 1) 死亡断言 vs 行动
  for (const a of active) {
    if (a.kind !== 'death' && !(a.kind === 'character_status' && a.value === '已阵亡/退出')) {
      // death only for hard action check
    }
    if (a.kind !== 'death' && a.value !== 'dead') continue;
    // 本章刚钉死的死亡：允许死亡场景本身
    if (a.sourceChapterNumber >= chN) continue;

    const name = a.subject;
    if (!prose.includes(name)) continue;
    const actRe = new RegExp(
      `${escapeReg(name)}[^。！？\\n]{0,12}(说|道|问|答|笑|吼|拔剑|挥|杀|冲|跑|走|站起|起身|睁眼|抬手)`
    );
    if (!actRe.test(prose)) continue;
    const memoryCtx = new RegExp(
      `(回忆|想起|当年|那时|梦中|幻象|幻觉|遗言|灵位).{0,24}${escapeReg(name)}|${escapeReg(name)}.{0,16}(的尸|遗容|墓|灵位)`
    );
    if (memoryCtx.test(prose)) {
      issues.push({
        type: '状态冲突',
        severity: 'warn',
        description: `账本：${a.claim}；正文有行动但似回忆/幻境`,
        suggestion: '写清时间锚或确认是否应更新账本。',
        assertionId: a.id,
      });
      continue;
    }
    issues.push({
      type: '状态冲突',
      severity: 'error',
      description: `账本记载「${a.claim}」（第${a.sourceChapterNumber}章），正文似仍有当下行动`,
      suggestion: '改为回忆/他人转述，或修正角色状态与账本。',
      assertionId: a.id,
    });
  }

  // 2) 道具损毁 vs 再用
  for (const a of active) {
    if (a.kind !== 'item_state' || a.value !== 'lost_or_destroyed') continue;
    if (a.sourceChapterNumber >= chN) continue;
    const name = a.subject;
    if (name.length < 2 || !prose.includes(name)) continue;
    const useRe = new RegExp(
      `${escapeReg(name)}[^。！？\\n]{0,10}(斩|砍|刺|挥|抽出|握紧|祭出|催动)|用${escapeReg(name)}|持${escapeReg(name)}`
    );
    if (useRe.test(prose)) {
      issues.push({
        type: '道具归属',
        severity: 'error',
        description: `账本：${a.claim}；正文似仍在使用该道具`,
        suggestion: '交代修复/替身/误认，或更新账本状态。',
        assertionId: a.id,
      });
    }
  }

  // 3) 归属矛盾：账本 item 归 A，正文写归 B / 被 B 持有（B≠A）
  for (const a of active) {
    if (a.kind !== 'item_owner' || !a.value) continue;
    if (a.sourceChapterNumber >= chN) continue;
    const item = a.subject;
    const owner = a.value;
    if (item.length < 2) continue;
    // 「item归X」且 X≠owner
    const ownRe = new RegExp(
      `${escapeReg(item)}[^。]{0,6}(?:归|属于)([\\u4e00-\\u9fff]{2,8})`
    );
    const m = prose.match(ownRe);
    if (m?.[1] && m[1] !== owner && !owner.includes(m[1]) && !m[1].includes(owner)) {
      issues.push({
        type: '道具归属',
        severity: 'error',
        description: `账本：${item}归属${owner}（第${a.sourceChapterNumber}章）；正文写归属${m[1]}`,
        suggestion: '补易手过程，或更新账本归属。',
        assertionId: a.id,
      });
    }
    // B夺得item / B持有item
    const seizeRe = new RegExp(
      `([\\u4e00-\\u9fff]{2,6})(?:夺得|抢走|拿走|收下|握着)${escapeReg(item)}`
    );
    const s = prose.match(seizeRe);
    if (s?.[1] && s[1] !== owner) {
      // 允许正当易手描写，标 warn，要求与账本更新
      issues.push({
        type: '道具归属',
        severity: 'warn',
        description: `账本：${item}归${owner}；正文出现「${s[1]}」持有/夺取描写`,
        suggestion: '若已易手，章末 recap 应写清并更新账本。',
        assertionId: a.id,
      });
    }
  }

  // 4) 地点硬跳：上章在 A，本章无过渡词却在 B（弱 warn）
  for (const a of active) {
    if (a.kind !== 'character_location' || !a.value) continue;
    if (a.sourceChapterNumber >= chN - 0) {
      // 只用更早章的位置
      if (a.sourceChapterNumber >= chN) continue;
    }
    // 仅当上一断言章距离 ≤5
    if (chN - a.sourceChapterNumber > 5) continue;
    const name = a.subject;
    const oldLoc = a.value;
    if (!prose.includes(name)) continue;
    const atRe = new RegExp(
      `${escapeReg(name)}[^。！？\\n]{0,6}在([\\u4e00-\\u9fff]{2,10})`
    );
    const m = prose.match(atRe);
    if (!m?.[1] || m[1] === oldLoc || oldLoc.includes(m[1]) || m[1].includes(oldLoc)) {
      continue;
    }
    // 有过渡词则放过
    const window = prose.slice(
      Math.max(0, prose.indexOf(name) - 40),
      prose.indexOf(name) + 80
    );
    if (/(来到|抵达|赶往|逃往|返回|回到|前往|一路|途经|传送|瞬移)/.test(window)) {
      continue;
    }
    issues.push({
      type: '时间线错乱',
      severity: 'warn',
      description: `账本：${name}曾在「${oldLoc}」（第${a.sourceChapterNumber}章）；本章写在「${m[1]}」且未见移动交代`,
      suggestion: '补一句移动/传送，或更新所在地账本。',
      assertionId: a.id,
    });
  }

  // 5) 事件 claim 粗否定（短 claim）
  for (const a of active) {
    if (a.kind !== 'event') continue;
    const head = a.claim.replace(/\s+/g, '').slice(0, 8);
    if (head.length < 4) continue;
    if (a.sourceChapterNumber >= chN) continue;
    const neg = new RegExp(
      `(从未|并没有?|并不存在|纯属虚构).{0,4}${escapeReg(head.slice(0, 6))}|${escapeReg(head.slice(0, 6))}[^。]{0,8}(从未发生|并未发生)`
    );
    if (neg.test(prose)) {
      issues.push({
        type: '吃书矛盾',
        severity: 'error',
        description: `正文似否定账本事件：「${a.claim.slice(0, 50)}」`,
        suggestion: '改写冲突句或作废该账本断言。',
        assertionId: a.id,
      });
    }
  }

  // 6) 时间线：正文「三天后」但账本上章已是更晚故事日且无闪回词 → warn
  const ledger = input.ledger;
  const timeline = ledger?.timeline || [];
  const prevAnchor = [...timeline]
    .filter((t) => t.chapterNumber < chN)
    .sort((a, b) => b.chapterNumber - a.chapterNumber)[0];
  const thisDelta = parseStoryDayDelta(prose.slice(0, 280) + prose.slice(-120));
  if (prevAnchor?.storyDay != null && thisDelta) {
    // 粗检：上章故事日很大，本章写「当日」且出现「多年前/当年」以外的矛盾较少；
    // 主要抓：本章宣称 Δ≥3，但与上章标签同为「次日」连跳无交代——弱
    if (
      thisDelta.delta === 0 &&
      prevAnchor.dayDelta != null &&
      prevAnchor.dayDelta >= 3 &&
      !/(回忆|闪回|曾几何时|多年前|当初|那时)/.test(prose.slice(0, 200))
    ) {
      // 不报：当日接「三日后」是正常的
    }
    // 抓倒流：正文写「故事第N天」且 N < prevDay（极弱）
    const dayNum = prose.match(/故事第\s*(\d+)\s*天/);
    if (dayNum) {
      const n = parseInt(dayNum[1], 10);
      if (n > 0 && n < (prevAnchor.storyDay || 0) - 1) {
        issues.push({
          type: '时间线错乱',
          severity: 'warn',
          description: `正文写「故事第${n}天」，账本上章约第${prevAnchor.storyDay}天，疑似时间倒流`,
          suggestion: '改为闪回并标明，或修正时间表述。',
        });
      }
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.filter((i) => i.severity === 'warn').length;
  const passed = errors === 0;
  const score = passed
    ? Math.max(72, 100 - warns * 5)
    : Math.max(28, 68 - errors * 16 - warns * 3);

  return {
    passed,
    score,
    summary: passed
      ? warns
        ? `账本对账通过（${warns} 警告）`
        : '账本对账通过'
      : `账本对账未过：${errors} error / ${warns} warn`,
    issues: issues.slice(0, 16),
  };
}

export function ledgerHitsToHardIssues(
  hits: LedgerReconcileHit[]
): HardReviewIssue[] {
  return hits.map((h) => ({
    type: h.type,
    severity: h.severity,
    description: `[账本对账] ${h.description}`,
    suggestion: h.suggestion,
  }));
}

/** 写前注入：当前活跃账本摘要 */
export function formatFactLedgerForPrompt(
  ledger?: FactLedger | null,
  max = 18
): string {
  const active = listActiveAssertions(ledger);
  if (!active.length) return '';

  const rank = (k: FactAssertionKind) =>
    k === 'death'
      ? 0
      : k === 'item_owner'
        ? 1
        : k === 'character_status'
          ? 2
          : k === 'character_location'
            ? 3
            : k === 'item_state'
              ? 4
              : 5;

  const sorted = [...active].sort(
    (a, b) => rank(a.kind) - rank(b.kind) || b.sourceChapterNumber - a.sourceChapterNumber
  );

  const lines = [
    '【事实账本·当前有效（绝对禁止无交代推翻；冲突以近章正文+手改角色卡为准）】',
  ];
  sorted.slice(0, max).forEach((a, i) => {
    lines.push(
      `${i + 1}. [${a.kind}] ${a.claim}（第${a.sourceChapterNumber}章）`
    );
  });
  return lines.join('\n');
}

export function factLedgerSummaryCounts(ledger?: FactLedger | null): {
  active: number;
  deaths: number;
  items: number;
  snapshots: number;
  storyDay: number;
  timeline: number;
} {
  const active = listActiveAssertions(ledger);
  return {
    active: active.length,
    deaths: active.filter((a) => a.kind === 'death').length,
    items: active.filter(
      (a) => a.kind === 'item_owner' || a.kind === 'item_state'
    ).length,
    snapshots: ledger?.recentSnapshots?.length || 0,
    storyDay: ledger?.storyDayCursor || 1,
    timeline: ledger?.timeline?.length || 0,
  };
}

function entityId(kind: 'location' | 'item', name: string): string {
  return `${kind}-${name.replace(/\s+/g, '').slice(0, 24)}`;
}

function upsertWorldEntity(
  list: WorldEntityState[],
  patch: {
    kind: 'location' | 'item';
    name: string;
    status?: string;
    note?: string;
    lastChapterNumber?: number;
  },
  max: number
): WorldEntityState[] {
  const name = patch.name.trim();
  if (name.length < 2) return list;
  const id = entityId(patch.kind, name);
  const idx = list.findIndex(
    (e) => e.id === id || (e.kind === patch.kind && e.name === name)
  );
  const next: WorldEntityState = {
    id,
    kind: patch.kind,
    name: name.slice(0, 24),
    status: patch.status?.slice(0, 80),
    note: patch.note?.slice(0, 120),
    lastChapterNumber: patch.lastChapterNumber,
    updatedAt: nowIso(),
  };
  if (idx >= 0) {
    const copy = [...list];
    copy[idx] = {
      ...list[idx],
      ...next,
      status: next.status || list[idx].status,
      note: next.note || list[idx].note,
      lastChapterNumber:
        next.lastChapterNumber ?? list[idx].lastChapterNumber,
    };
    return copy;
  }
  return [next, ...list].slice(0, max);
}

/**
 * 账本 → 地点/道具实体表（可复现同步）。
 * item_owner / item_state / character_location / location_state
 */
export function syncLedgerEntitiesToMemory(
  memory: StoryMemory | null | undefined
): { memory: StoryMemory; itemsUpdated: number; locationsUpdated: number } {
  const base = memory || { pinnedFacts: [], openThreads: [] };
  const active = listActiveAssertions(base.factLedger);
  let items = [...(base.items || [])];
  let locations = [...(base.locations || [])];
  let itemsUpdated = 0;
  let locationsUpdated = 0;

  for (const a of active) {
    if (a.kind === 'item_owner' && a.subject.length >= 2) {
      const before = items.find((i) => i.name === a.subject)?.status;
      const status = a.value
        ? `归属：${a.value}`
        : a.claim.slice(0, 40);
      items = upsertWorldEntity(
        items,
        {
          kind: 'item',
          name: a.subject,
          status,
          note: `账本·第${a.sourceChapterNumber}章`,
          lastChapterNumber: a.sourceChapterNumber,
        },
        MAX_ITEMS
      );
      if (before !== status) itemsUpdated += 1;
    }
    if (a.kind === 'item_state' && a.subject.length >= 2) {
      const status =
        a.value === 'lost_or_destroyed'
          ? '已失去/损毁'
          : a.claim.slice(0, 40);
      const before = items.find((i) => i.name === a.subject)?.status;
      items = upsertWorldEntity(
        items,
        {
          kind: 'item',
          name: a.subject,
          status,
          note: `账本·第${a.sourceChapterNumber}章`,
          lastChapterNumber: a.sourceChapterNumber,
        },
        MAX_ITEMS
      );
      if (before !== status) itemsUpdated += 1;
    }
    if (a.kind === 'character_location' && a.value && a.value.length >= 2) {
      const loc = a.value;
      const status = `${a.subject}在此`;
      const before = locations.find((l) => l.name === loc)?.status;
      locations = upsertWorldEntity(
        locations,
        {
          kind: 'location',
          name: loc,
          status,
          note: `账本·第${a.sourceChapterNumber}章`,
          lastChapterNumber: a.sourceChapterNumber,
        },
        MAX_LOCATIONS
      );
      if (before !== status) locationsUpdated += 1;
    }
    if (a.kind === 'location_state' && a.subject.length >= 2) {
      locations = upsertWorldEntity(
        locations,
        {
          kind: 'location',
          name: a.subject,
          status: a.value || a.claim.slice(0, 40),
          note: `账本·第${a.sourceChapterNumber}章`,
          lastChapterNumber: a.sourceChapterNumber,
        },
        MAX_LOCATIONS
      );
      locationsUpdated += 1;
    }
  }

  return {
    memory: {
      ...base,
      items,
      locations,
      updatedAt: nowIso(),
    },
    itemsUpdated,
    locationsUpdated,
  };
}

/** 写前注入：故事时间线摘要 */
export function formatTimelineForPrompt(
  ledger?: FactLedger | null,
  max = 8
): string {
  const tl = [...(ledger?.timeline || [])]
    .sort((a, b) => b.chapterNumber - a.chapterNumber)
    .slice(0, max);
  if (!tl.length) return '';
  const cursor = ledger?.storyDayCursor;
  const lines = [
    `【故事时间线（估计故事日≈${cursor ?? '?' }；勿无故时间倒流）】`,
  ];
  // 显示从旧到新更易读
  [...tl].reverse().forEach((t, i) => {
    const day = t.storyDay != null ? `日${t.storyDay}` : '';
    const d =
      t.dayDelta != null && t.dayDelta > 0 ? `+${t.dayDelta}日` : t.dayDelta === 0 ? '同日' : '';
    lines.push(
      `${i + 1}. 第${t.chapterNumber}章 · ${t.label}${day ? ` · ${day}` : ''}${d ? `（${d}）` : ''}`
    );
  });
  return lines.join('\n');
}

// ─── 手改 CRUD ───────────────────────────────────────────

function patchLedgerOnMemory(
  memory: StoryMemory | null | undefined,
  patch: (ledger: FactLedger) => FactLedger
): StoryMemory {
  const base = memory || { pinnedFacts: [], openThreads: [] };
  const ledger = normalizeFactLedger(base.factLedger);
  return {
    ...base,
    factLedger: { ...patch(ledger), updatedAt: nowIso() },
    updatedAt: nowIso(),
  };
}

/** 作废断言（保留记录，不再参与对账/注入） */
export function retractAssertion(
  memory: StoryMemory | null | undefined,
  assertionId: string,
  note?: string
): StoryMemory {
  return patchLedgerOnMemory(memory, (ledger) => ({
    ...ledger,
    assertions: ledger.assertions.map((a) =>
      a.id === assertionId
        ? {
            ...a,
            status: 'retracted' as const,
            note: [a.note, note || '手动作废'].filter(Boolean).join(' · ').slice(0, 80),
          }
        : a
    ),
  }));
}

/** 从账本彻底删除 */
export function removeAssertion(
  memory: StoryMemory | null | undefined,
  assertionId: string
): StoryMemory {
  return patchLedgerOnMemory(memory, (ledger) => ({
    ...ledger,
    assertions: ledger.assertions.filter((a) => a.id !== assertionId),
  }));
}

/** 手钉一条断言（覆盖同 kind+subject 的 active） */
export function addManualAssertion(
  memory: StoryMemory | null | undefined,
  input: {
    kind: FactAssertionKind;
    subject: string;
    claim: string;
    value?: string;
    chapterNumber?: number;
  }
): StoryMemory {
  const subject = input.subject.trim();
  const claim = input.claim.trim();
  if (subject.length < 1 || claim.length < 2) {
    return memory || { pinnedFacts: [], openThreads: [] };
  }
  const chN = input.chapterNumber ?? 0;
  const assertion: FactAssertion = {
    id: assertId(input.kind, subject, chN || 0, Date.now() % 10000),
    kind: input.kind,
    subject: subject.slice(0, 24),
    claim: claim.slice(0, 160),
    value: input.value?.trim().slice(0, 48),
    sourceChapterNumber: chN,
    createdAt: nowIso(),
    status: 'active',
    note: 'manual',
  };
  const snap: ChapterFactSnapshot = {
    chapterNumber: Math.max(1, chN || 1),
    extractedAt: nowIso(),
    source: 'heuristic',
    assertions: [assertion],
    summary: claim.slice(0, 80),
  };
  return mergeSnapshotIntoMemory(memory, snap);
}

/** 快捷：钉死「某人已死」 */
export function pinDeathAssertion(
  memory: StoryMemory | null | undefined,
  name: string,
  chapterNumber?: number
): StoryMemory {
  const n = name.trim();
  if (n.length < 1) return memory || { pinnedFacts: [], openThreads: [] };
  return addManualAssertion(memory, {
    kind: 'death',
    subject: n,
    claim: `${n}已阵亡/退出`,
    value: 'dead',
    chapterNumber,
  });
}

/**
 * LLM 补抽：在启发式快照基础上补漏（死亡/归属/地点）。
 * 失败则原样返回启发式结果。
 */
export async function enrichSnapshotWithLlm(
  snapshot: ChapterFactSnapshot,
  input: {
    chapter: Pick<Chapter, 'number' | 'title'>;
    prose: string;
    recap?: ChapterRecap | null;
    onProgress?: (msg: string) => void;
  }
): Promise<ChapterFactSnapshot> {
  const { generateJSON } = await import('./llmClient');
  input.onProgress?.(' [账本] LLM 补抽关键事实…');
  const prose = (input.prose || '').trim();
  const body =
    prose.length > 4500
      ? `${prose.slice(0, 2000)}\n…\n${prose.slice(-2000)}`
      : prose;
  const recapBits = [
    input.recap?.text || '',
    input.recap?.endingState || '',
    ...(input.recap?.keyFacts || []),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200);

  try {
    const res = await generateJSON<{
      assertions?: {
        kind?: string;
        subject?: string;
        claim?: string;
        value?: string;
      }[];
    }>(
      [
        {
          role: 'system',
          content:
            '你是小说事实抽取器。只从给定正文/recap 抽取已成立的硬事实，禁止编造。' +
            '输出 JSON：{ "assertions": [ { "kind", "subject", "claim", "value?" } ] }。' +
            'kind 只能是：death|character_status|character_location|item_owner|item_state|event|time_anchor。' +
            '最多 12 条；优先死亡、道具归属/损毁、角色所在。claim 中文短句。',
        },
        {
          role: 'user',
          content: [
            `第${input.chapter.number}章《${input.chapter.title}》`,
            '--- recap ---',
            recapBits || '（无）',
            '--- 正文(截断) ---',
            body || '（无）',
            '--- 已有启发式断言（勿重复） ---',
            snapshot.assertions.map((a) => `[${a.kind}] ${a.claim}`).join('\n') || '（无）',
          ].join('\n'),
        },
      ],
      0.25
    );

    const chN = input.chapter.number;
    const extra: FactAssertion[] = [];
    for (const raw of res.assertions || []) {
      const kind = normalizeKind(raw.kind);
      const subject = String(raw.subject || '').trim();
      const claim = String(raw.claim || '').trim();
      if (subject.length < 1 || claim.length < 2) continue;
      // 与启发式去重
      const dup = snapshot.assertions.some(
        (a) =>
          a.kind === kind &&
          a.subject === subject &&
          (a.value === raw.value || a.claim.slice(0, 20) === claim.slice(0, 20))
      );
      if (dup) continue;
      extra.push({
        id: assertId(kind, subject, chN, extra.length + 50),
        kind,
        subject: subject.slice(0, 24),
        claim: claim.slice(0, 160),
        value: raw.value ? String(raw.value).slice(0, 48) : undefined,
        sourceChapterNumber: chN,
        createdAt: nowIso(),
        status: 'active',
        note: 'llm',
      });
    }

    if (!extra.length) {
      input.onProgress?.(' [账本] LLM 无新增断言');
      return snapshot;
    }

    input.onProgress?.(` [账本] LLM 补抽 +${extra.length} 条`);
    return {
      ...snapshot,
      source: 'mixed',
      assertions: [...snapshot.assertions, ...extra].slice(0, 40),
      summary: [snapshot.summary, ...extra.map((e) => e.claim)]
        .filter(Boolean)
        .join('； ')
        .slice(0, 200),
      extractedAt: nowIso(),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    input.onProgress?.(` [账本] LLM 补抽失败，沿用启发式：${msg.slice(0, 80)}`);
    return snapshot;
  }
}

/**
 * 将硬伤/账本/本地断言中的 error（及可选 warn）写入章待修清单。
 */
/**
 * 账本活跃「死亡」→ 角色卡 status=已阵亡/退出。
 * 仅名字精确匹配；已是阵亡的跳过。
 */
export function syncDeathsFromLedgerToCharacters(
  memory: StoryMemory | null | undefined,
  characters: Character[],
  options?: { chapterNumber?: number }
): { characters: Character[]; updated: number; names: string[] } {
  const deaths = listActiveAssertions(memory?.factLedger).filter(
    (a) => a.kind === 'death' || a.value === 'dead'
  );
  if (!deaths.length || !characters.length) {
    return { characters, updated: 0, names: [] };
  }
  const deadNames = new Set(deaths.map((d) => d.subject.trim()).filter(Boolean));
  const names: string[] = [];
  const chN = options?.chapterNumber;
  const next = characters.map((c) => {
    if (!deadNames.has(c.name)) return c;
    if (c.status === '已阵亡/退出') return c;
    names.push(c.name);
    return {
      ...c,
      status: '已阵亡/退出' as CharacterStatus,
      lastMemoryChapterNumber: chN ?? c.lastMemoryChapterNumber,
    };
  });
  return { characters: next, updated: names.length, names };
}

/**
 * 角色卡「已阵亡/退出」→ 账本 death 断言。
 */
export function syncDeathsFromCharactersToLedger(
  memory: StoryMemory | null | undefined,
  characters: Character[],
  chapterNumber?: number
): { memory: StoryMemory; added: number; names: string[] } {
  let next = memory || { pinnedFacts: [], openThreads: [] };
  const activeDeaths = new Set(
    listActiveAssertions(next.factLedger)
      .filter((a) => a.kind === 'death' || a.value === 'dead')
      .map((a) => a.subject)
  );
  const names: string[] = [];
  for (const c of characters) {
    if (c.status !== '已阵亡/退出') continue;
    if (activeDeaths.has(c.name)) continue;
    next = pinDeathAssertion(next, c.name, chapterNumber ?? c.lastMemoryChapterNumber);
    activeDeaths.add(c.name);
    names.push(c.name);
  }
  return { memory: next, added: names.length, names };
}

/** 双向：卡→账本 + 账本→卡 */
export function syncDeathsBidirectional(
  memory: StoryMemory | null | undefined,
  characters: Character[],
  chapterNumber?: number
): {
  memory: StoryMemory;
  characters: Character[];
  toLedger: string[];
  toCards: string[];
} {
  const fromCards = syncDeathsFromCharactersToLedger(memory, characters, chapterNumber);
  const fromLedger = syncDeathsFromLedgerToCharacters(
    fromCards.memory,
    characters,
    { chapterNumber }
  );
  return {
    memory: fromCards.memory,
    characters: fromLedger.characters,
    toLedger: fromCards.names,
    toCards: fromLedger.names,
  };
}

export function applyHardIssuesAsRevisionTodos(
  chapter: Chapter,
  issues: HardReviewIssue[],
  options?: { errorsOnly?: boolean; max?: number }
): { chapter: Chapter; added: number } {
  const errorsOnly = options?.errorsOnly !== false;
  const max = options?.max ?? 12;
  const list = issues.filter((i) =>
    errorsOnly ? i.severity === 'error' : true
  );
  if (!list.length) return { chapter, added: 0 };

  const now = nowIso();
  const existing = [...(chapter.revisionTodos || [])];
  const keys = new Set(
    existing.map((t) => t.text.replace(/\s+/g, '').slice(0, 48))
  );
  let added = 0;
  const next = [...existing];

  for (const iss of list.slice(0, max)) {
    const prefix = iss.description.startsWith('[账本')
      ? ''
      : iss.description.startsWith('[本地')
        ? ''
        : '[硬伤] ';
    const text = `${prefix}${iss.description}${
      iss.suggestion ? ` → ${iss.suggestion}` : ''
    }`.slice(0, 280);
    const key = text.replace(/\s+/g, '').slice(0, 48);
    if (keys.has(key)) continue;
    const id = `hard-${chapter.number}-${iss.type}-${added}-${Date.now().toString(36)}`.slice(
      0,
      80
    );
    next.unshift({
      id,
      text,
      status: 'open',
      createdAt: now,
    });
    keys.add(key);
    added += 1;
  }

  if (added === 0) return { chapter, added: 0 };
  return {
    chapter: {
      ...chapter,
      revisionTodos: next.slice(0, 40),
      lastModified: new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    },
    added,
  };
}
