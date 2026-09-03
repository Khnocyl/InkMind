import { contentWordsOrFallback } from './proseWords';
import type {
  BookProject,
  Chapter,
  Character,
  StyleConfig,
  Volume,
  WizardStep,
  WorldSetting,
} from '../types/novel';
import { getDefaultStyleConfig } from './storage';
import { normalizeStoryMemory } from './storyMemory';
import { normalizeChapterIntent } from './chapterIntent';
import type { CrossChapterAuditReport } from '../types/novel';

/** 导出包格式标识（导入时校验） */
export const EXPORT_FORMAT = 'novel-studio-project' as const;
export const EXPORT_VERSION = 1;

export interface ProjectExportBundle {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  /** 可读提示，方便人眼识别 */
  title?: string;
  appHint?: string;
  project: BookProject;
}

export interface ParseImportResult {
  project: BookProject;
  warnings: string[];
  /** 是否来自标准导出包（含 format 字段） */
  fromBundle: boolean;
}

function safeFileBaseName(title: string): string {
  const base = (title || '未命名小说')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 40);
  return base || 'novel';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 导出前剥离密钥等敏感字段（styleConfig.apiKey 等） */
export function sanitizeProjectForExport(project: BookProject): BookProject {
  const style = project.styleConfig ? { ...project.styleConfig } : getDefaultStyleConfig();
  if ('apiKey' in style) {
    delete (style as StyleConfig & { apiKey?: string }).apiKey;
  }

  return {
    ...project,
    characters: Array.isArray(project.characters) ? project.characters.map((c) => ({ ...c })) : [],
    settings: Array.isArray(project.settings) ? project.settings.map((s) => ({ ...s })) : [],
    volumes: Array.isArray(project.volumes) ? project.volumes.map((v) => ({ ...v })) : [],
    chapters: Array.isArray(project.chapters)
      ? project.chapters.map((ch) => ({
          ...ch,
          beats: Array.isArray(ch.beats) ? ch.beats.map((b) => ({ ...b })) : [],
        }))
      : [],
    config: project.config ? { ...project.config } : {
      inspiration: '',
      genre: project.genre || '玄幻',
      writingStyle: '',
    },
    styleConfig: style,
  };
}

export function buildExportBundle(project: BookProject): ProjectExportBundle {
  const clean = sanitizeProjectForExport(project);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    title: clean.title,
    appHint: 'InkMind 全书备份。可在「书库」中导入恢复。不含 API Key。',
    project: clean,
  };
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延迟 revoke，避免部分浏览器下载中断
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 导出完整可恢复 JSON 备份 */
export function exportProjectAsJson(project: BookProject): { filename: string } {
  const bundle = buildExportBundle(project);
  const filename = `${safeFileBaseName(project.title)}_${stamp()}.novel.json`;
  const content = JSON.stringify(bundle, null, 2);
  downloadTextFile(filename, content, 'application/json;charset=utf-8');
  return { filename };
}

function mdEscapeHeading(s: string): string {
  return (s || '').replace(/\r\n/g, '\n').trim();
}

/** 导出人类可读 Markdown（便于审阅/外发；完整恢复请用 JSON） */
export function exportProjectAsMarkdown(project: BookProject): { filename: string } {
  const p = sanitizeProjectForExport(project);
  const lines: string[] = [];

  lines.push(`# ${mdEscapeHeading(p.title) || '未命名小说'}`);
  if (p.subtitle) lines.push(`> ${p.subtitle}`);
  lines.push('');
  lines.push(`- 题材：${p.genre || '未设定'}`);
  lines.push(`- 导出时间：${new Date().toISOString()}`);
  lines.push(`- 章节数：${(p.chapters || []).length}`);
  const words = (p.chapters || []).reduce(
    (sum, c) => sum + (contentWordsOrFallback(c.content, c.wordCount) || 0),
    0
  );
  lines.push(`- 约总字数：${words}`);
  lines.push('');
  lines.push('> 本文件为可读导出。完整恢复（含 recap / 机检 / 风格配置）请使用同名的 `.novel.json` 备份。');
  lines.push('');

  lines.push('## 简介');
  lines.push('');
  lines.push((p.synopsis || p.config?.inspiration || '（无）').trim());
  lines.push('');

  if (p.config?.inspiration) {
    lines.push('## 创作灵感');
    lines.push('');
    lines.push(p.config.inspiration.trim());
    lines.push('');
  }

  lines.push('## 角色');
  lines.push('');
  if (!p.characters?.length) {
    lines.push('（无角色）');
    lines.push('');
  } else {
    for (const c of p.characters) {
      lines.push(`### ${c.name}${c.alias ? `（${c.alias}）` : ''}`);
      lines.push('');
      lines.push(`- 定位：${c.role} · 状态：${c.status}`);
      lines.push(`- 境界/身份：${c.realmOrTitle || '—'}`);
      lines.push(`- 所在：${c.currentLocation || '—'}`);
      if (c.personality) lines.push(`- 性格：${c.personality}`);
      if (c.appearance) lines.push(`- 外貌：${c.appearance}`);
      if (c.background) lines.push(`- 背景：${c.background}`);
      if (c.secretNotes) lines.push(`- 隐藏设定：${c.secretNotes}`);
      lines.push('');
    }
  }

  lines.push('## 世界观设定');
  lines.push('');
  if (!p.settings?.length) {
    lines.push('（无设定）');
    lines.push('');
  } else {
    for (const s of p.settings) {
      lines.push(`### [${s.category}] ${s.name}`);
      lines.push('');
      lines.push(s.description || '（无描述）');
      if (s.hardRules?.length) {
        lines.push('');
        lines.push('硬规则：');
        s.hardRules.forEach((r) => lines.push(`- ${r}`));
      }
      lines.push('');
    }
  }

  if (p.volumes?.length) {
    lines.push('## 分卷');
    lines.push('');
    for (const v of p.volumes) {
      lines.push(`- 卷${v.number}《${v.title}》第 ${v.startChapter}–${v.endChapter} 章：${v.summary || ''}`);
    }
    lines.push('');
  }

  lines.push('## 正文');
  lines.push('');
  const sorted = [...(p.chapters || [])].sort((a, b) => a.number - b.number);
  if (!sorted.length) {
    lines.push('（暂无章节）');
    lines.push('');
  } else {
    for (const ch of sorted) {
      lines.push(`### 第 ${ch.number} 章 ${ch.title || ''}`.trim());
      lines.push('');
      lines.push(`*状态：${ch.status} · 字数：${ch.wordCount || 0}*`);
      lines.push('');
      if (ch.summary?.trim()) {
        lines.push('**梗概**');
        lines.push('');
        lines.push(ch.summary.trim());
        lines.push('');
      }
      if (ch.recap?.text?.trim()) {
        lines.push('**章末 recap**');
        lines.push('');
        lines.push(ch.recap.text.trim());
        lines.push('');
      }
      if (ch.authorNotes?.trim()) {
        lines.push('**作者批注**');
        lines.push('');
        lines.push(ch.authorNotes.trim());
        lines.push('');
      }
      if (ch.revisionTodos?.length) {
        lines.push('**待修清单**');
        lines.push('');
        for (const t of ch.revisionTodos) {
          const mark = t.status === 'done' ? 'x' : ' ';
          lines.push(`- [${mark}] ${t.text}`);
        }
        lines.push('');
      }
      lines.push('**正文**');
      lines.push('');
      lines.push((ch.content || '（空）').trim());
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  const filename = `${safeFileBaseName(project.title)}_${stamp()}.md`;
  downloadTextFile(filename, lines.join('\n'), 'text/markdown;charset=utf-8');
  return { filename };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function normalizeCharacter(raw: unknown, index: number): Character {
  const r = isRecord(raw) ? raw : {};
  return {
    id: asString(r.id, `char-import-${index}`),
    name: asString(r.name, `角色${index + 1}`),
    alias: asString(r.alias),
    role: (asString(r.role, '重要配角') as Character['role']) || '重要配角',
    status: (asString(r.status, '活跃') as Character['status']) || '活跃',
    realmOrTitle: asString(r.realmOrTitle),
    currentLocation: asString(r.currentLocation),
    personality: asString(r.personality),
    appearance: asString(r.appearance),
    background: asString(r.background),
    relations: Array.isArray(r.relations) ? (r.relations as Character['relations']) : [],
    secretNotes: asString(r.secretNotes),
    lastMemoryChapterNumber:
      typeof r.lastMemoryChapterNumber === 'number' ? r.lastMemoryChapterNumber : undefined,
    lastMemoryUpdatedAt: asString(r.lastMemoryUpdatedAt) || undefined,
  };
}

function normalizeSetting(raw: unknown, index: number): WorldSetting {
  const r = isRecord(raw) ? raw : {};
  return {
    id: asString(r.id, `set-import-${index}`),
    category: (asString(r.category, '核心历史伏笔') as WorldSetting['category']) || '核心历史伏笔',
    name: asString(r.name, `设定${index + 1}`),
    description: asString(r.description),
    hardRules: Array.isArray(r.hardRules) ? r.hardRules.map(String) : [],
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    isActive: r.isActive !== false,
  };
}

function normalizeVolume(raw: unknown, index: number): Volume {
  const r = isRecord(raw) ? raw : {};
  return {
    id: asString(r.id, `vol-import-${index}`),
    number: asNumber(r.number, index + 1),
    title: asString(r.title, `卷${index + 1}`),
    summary: asString(r.summary),
    startChapter: asNumber(r.startChapter, 1),
    endChapter: asNumber(r.endChapter, 1),
  };
}

function normalizeChapter(raw: unknown, index: number): Chapter {
  const r = isRecord(raw) ? raw : {};
  return {
    id: asString(r.id, `chap-import-${index}`),
    number: asNumber(r.number, index + 1),
    title: asString(r.title, `第 ${index + 1} 章`),
    summary: asString(r.summary),
    wordCount: asNumber(r.wordCount, 0),
    status: (asString(r.status, '大纲待拆') as Chapter['status']) || '大纲待拆',
    content: asString(r.content),
    volumeId: asString(r.volumeId) || undefined,
    volumeNumber: typeof r.volumeNumber === 'number' ? r.volumeNumber : undefined,
    involvedCharacterIds: Array.isArray(r.involvedCharacterIds)
      ? r.involvedCharacterIds.map(String)
      : [],
    involvedSettingIds: Array.isArray(r.involvedSettingIds)
      ? r.involvedSettingIds.map(String)
      : [],
    beats: Array.isArray(r.beats) ? (r.beats as Chapter['beats']) : [],
    memoryAudit: isRecord(r.memoryAudit)
      ? (r.memoryAudit as unknown as Chapter['memoryAudit'])
      : undefined,
    recap: isRecord(r.recap) ? (r.recap as unknown as Chapter['recap']) : undefined,
    memoryWriteLog: isRecord(r.memoryWriteLog)
      ? (r.memoryWriteLog as unknown as Chapter['memoryWriteLog'])
      : undefined,
    intent: isRecord(r.intent) ? normalizeChapterIntent(r.intent) : undefined,
    lastModified: asString(r.lastModified, new Date().toISOString()),
    autoFixCount: typeof r.autoFixCount === 'number' ? r.autoFixCount : undefined,
    autoGenerated: asBool(r.autoGenerated, false),
    locked: typeof r.locked === 'boolean' ? r.locked : undefined,
    lockedAt: asString(r.lockedAt) || undefined,
    authorNotes: asString(r.authorNotes) || undefined,
    contentUpdatedAt: asString(r.contentUpdatedAt) || undefined,
    memoryInjection: isRecord(r.memoryInjection)
      ? (r.memoryInjection as unknown as Chapter['memoryInjection'])
      : undefined,
    revisionTodos: Array.isArray(r.revisionTodos)
      ? (r.revisionTodos as unknown[])
          .map((raw, i) => {
            const t = isRecord(raw) ? raw : {};
            const text = asString(t.text);
            if (!text) return null;
            const status = asString(t.status, 'open') === 'done' ? 'done' : 'open';
            return {
              id: asString(t.id, `todo-import-${index}-${i}`),
              text,
              status: status as 'open' | 'done',
              createdAt: asString(t.createdAt, new Date().toISOString()),
              doneAt: asString(t.doneAt) || undefined,
            };
          })
          .filter((x): x is NonNullable<typeof x> => !!x)
      : undefined,
  };
}

function normalizeStyleConfig(raw: unknown): StyleConfig {
  const base = getDefaultStyleConfig();
  if (!isRecord(raw)) return base;
  const merged: StyleConfig = {
    ...base,
    ...raw,
    clicheBlacklist: Array.isArray(raw.clicheBlacklist)
      ? raw.clicheBlacklist.map(String)
      : base.clicheBlacklist,
    customBlacklist: Array.isArray(raw.customBlacklist)
      ? raw.customBlacklist.map(String)
      : base.customBlacklist,
    deslopWhitelist: Array.isArray(raw.deslopWhitelist)
      ? raw.deslopWhitelist.map(String)
      : Array.isArray(raw.aiTasteWhitelist)
        ? raw.aiTasteWhitelist.map(String)
        : base.deslopWhitelist || [],
    useExtendedClicheList:
      typeof raw.useExtendedClicheList === 'boolean'
        ? raw.useExtendedClicheList
        : base.useExtendedClicheList,
    aiTasteStrict:
      typeof raw.aiTasteStrict === 'boolean' ? raw.aiTasteStrict : base.aiTasteStrict,
    aiTasteBlockHeavy:
      typeof raw.aiTasteBlockHeavy === 'boolean'
        ? raw.aiTasteBlockHeavy
        : base.aiTasteBlockHeavy,
    fewShotExamples: Array.isArray(raw.fewShotExamples)
      ? (raw.fewShotExamples as StyleConfig['fewShotExamples'])
      : base.fewShotExamples,
    selectedExampleId: asString(raw.selectedExampleId, base.selectedExampleId),
    styleProfiles: Array.isArray(raw.styleProfiles)
      ? (raw.styleProfiles as StyleConfig['styleProfiles'])
      : base.styleProfiles,
    activeStyleProfileId:
      raw.activeStyleProfileId === null
        ? null
        : typeof raw.activeStyleProfileId === 'string'
          ? raw.activeStyleProfileId
          : base.activeStyleProfileId ?? null,
    enforceShowDontTell:
      typeof raw.enforceShowDontTell === 'boolean'
        ? raw.enforceShowDontTell
        : base.enforceShowDontTell,
    forbidEndingSublimation:
      typeof raw.forbidEndingSublimation === 'boolean'
        ? raw.forbidEndingSublimation
        : base.forbidEndingSublimation,
  };
  // 绝不导入密钥
  delete (merged as StyleConfig & { apiKey?: string }).apiKey;
  return merged;
}

const VALID_WIZARD: WizardStep[] = [
  'inspiration',
  'title-review',
  'characters-review',
  'world-review',
  'outline-review',
  'ready',
];

/**
 * 将任意兼容 JSON 规范化为可落盘的 BookProject。
 * @param assignNewId 为 true 时生成新项目 id，避免覆盖同 id 旧书
 */
export function normalizeImportedProject(
  raw: unknown,
  options: { assignNewId?: boolean; idSuffix?: string } = {}
): { project: BookProject; warnings: string[] } {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    throw new Error('导入内容不是有效的项目对象');
  }

  const assignNewId = options.assignNewId !== false;
  const oldId = asString(raw.id, '');
  const newId = assignNewId
    ? `proj-import-${Date.now()}${options.idSuffix ? `-${options.idSuffix}` : ''}`
    : oldId || `proj-import-${Date.now()}`;

  if (assignNewId && oldId) {
    warnings.push(`已分配新项目 ID（原 ID：${oldId}），不会覆盖书库中同名 ID 的旧项目。`);
  }

  const characters = Array.isArray(raw.characters)
    ? raw.characters.map((c, i) => normalizeCharacter(c, i))
    : [];
  const settings = Array.isArray(raw.settings)
    ? raw.settings.map((s, i) => normalizeSetting(s, i))
    : [];
  const volumes = Array.isArray(raw.volumes)
    ? raw.volumes.map((v, i) => normalizeVolume(v, i))
    : [];
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters.map((c, i) => normalizeChapter(c, i))
    : [];

  if (!characters.length) warnings.push('未包含角色数据。');
  if (!chapters.length) warnings.push('未包含章节数据。');

  let wizardStep = asString(raw.wizardStep, 'ready') as WizardStep;
  if (!VALID_WIZARD.includes(wizardStep)) {
    warnings.push(`向导步骤「${wizardStep}」无效，已重置为 ready。`);
    wizardStep = 'ready';
  }

  const configRaw = isRecord(raw.config) ? raw.config : {};
  const genre = asString(raw.genre) || asString(configRaw.genre, '玄幻');

  const project: BookProject = {
    id: newId,
    title: asString(raw.title, '导入的小说'),
    subtitle: asString(raw.subtitle),
    genre,
    synopsis: asString(raw.synopsis) || asString(configRaw.inspiration),
    author: asString(raw.author) || undefined,
    totalWords: typeof raw.totalWords === 'number' ? raw.totalWords : undefined,
    createdDate: asString(raw.createdDate) || undefined,
    createdAt: asString(raw.createdAt, new Date().toISOString()),
    lastModified: new Date().toISOString(),
    wizardStep,
    config: {
      inspiration: asString(configRaw.inspiration, asString(raw.synopsis)),
      totalChapters:
        typeof configRaw.totalChapters === 'number' ? configRaw.totalChapters : undefined,
      wordsPerChapter:
        typeof configRaw.wordsPerChapter === 'number' ? configRaw.wordsPerChapter : undefined,
      targetChapterCount:
        typeof configRaw.targetChapterCount === 'number'
          ? configRaw.targetChapterCount
          : chapters.length || 100,
      targetWordCountPerChapter:
        typeof configRaw.targetWordCountPerChapter === 'number'
          ? configRaw.targetWordCountPerChapter
          : 3000,
      writingStyle: asString(configRaw.writingStyle, '克制严谨、网文节奏'),
      genre,
      targetAudience: asString(configRaw.targetAudience) || undefined,
      customParameters: isRecord(configRaw.customParameters)
        ? (configRaw.customParameters as Record<string, unknown>)
        : {},
    },
    characters,
    settings,
    volumes,
    chapters,
    currentChapterId: asString(raw.currentChapterId) || chapters[0]?.id,
    styleConfig: normalizeStyleConfig(raw.styleConfig),
    memory: raw.memory ? normalizeStoryMemory(raw.memory) : undefined,
    lastCrossAudit: isRecord(raw.lastCrossAudit)
      ? (raw.lastCrossAudit as unknown as CrossChapterAuditReport)
      : undefined,
    dailyWordLog: isRecord(raw.dailyWordLog)
      ? (Object.fromEntries(
          Object.entries(raw.dailyWordLog).filter(
            (entry): entry is [string, number] =>
              /^\d{4}-\d{2}-\d{2}$/.test(entry[0]) && typeof entry[1] === 'number'
          )
        ) as Record<string, number>)
      : undefined,
  };

  return { project, warnings };
}

/**
 * 解析导入文本：支持标准导出包，或裸 BookProject JSON。
 * 不支持纯 Markdown 反解析（MD 仅供阅读）。
 */
export function parseProjectImport(text: string): ParseImportResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    throw new Error('文件内容为空');
  }
  if (trimmed.startsWith('#')) {
    throw new Error(
      '检测到 Markdown 文件。可读导出不能完整恢复，请使用「导出 JSON 备份」生成的 .novel.json 文件导入。'
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new Error('JSON 解析失败，请确认文件是本工作室导出的 .novel.json 备份。');
  }

  if (!isRecord(data)) {
    throw new Error('导入根节点必须是 JSON 对象');
  }

  // 标准包
  if (data.format === EXPORT_FORMAT || isRecord(data.project)) {
    if (data.format && data.format !== EXPORT_FORMAT) {
      throw new Error(`不支持的导出格式：${String(data.format)}`);
    }
    if (typeof data.version === 'number' && data.version > EXPORT_VERSION) {
      // 仍尝试导入，但警告
    }
    const inner = data.project ?? data;
    const { project, warnings } = normalizeImportedProject(inner, { assignNewId: true });
    if (typeof data.version === 'number' && data.version > EXPORT_VERSION) {
      warnings.push(
        `备份版本 v${data.version} 高于当前支持的 v${EXPORT_VERSION}，部分字段可能无法识别。`
      );
    }
    if (data.format !== EXPORT_FORMAT && isRecord(data.project)) {
      warnings.push('包内无标准 format 字段，已按内嵌 project 导入。');
    }
    return { project, warnings, fromBundle: data.format === EXPORT_FORMAT };
  }

  // 裸项目
  if (data.title || data.chapters || data.config) {
    const { project, warnings } = normalizeImportedProject(data, { assignNewId: true });
    warnings.push('识别为裸项目 JSON（非标准导出包），已尝试兼容导入。');
    return { project, warnings, fromBundle: false };
  }

  throw new Error('无法识别的 JSON 结构：既不是导出包，也不像 BookProject。');
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}
