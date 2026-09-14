/**
 * 回归守卫：同一处元素里不得同时出现「图标组件 + 同义 emoji」。
 *
 * 背景：这类重复在视觉上就是「同一个符号挨着出现两次」。已修过 4 例
 * （<Sparkles/> ✨ / <Rocket/> 🚀 / <Zap/> ⚡ / <Sparkles/> ✨ 写这一章），
 * 本轮又发现 3 例（<Square/> ⏹ / <Save/> 💾 / <ShieldAlert/> 🔒）。
 * 人工 grep 容易漏（本轮就漏了 U+23F9 ⏹ —— 它不在常见 emoji 区段里），故固化成测试。
 *
 * 规矩：**图标是设计语言，emoji 留给「没有图标的纯文本」**（状态行、toast、行内提示）。
 *
 * 判定精度优先：只报「同义」组合；要求 emoji 与图标在**相邻 8 行内**，
 * 且两者之间没有出现元素闭合。窗口取 8 而非 2，是因为 JSX 常跨多行
 * （如 `<Save/>` 下方紧跟一个跨 5 行的三元表达式才出现 💾）；
 * 「遇到 `</` 就停」这条护栏负责挡住「上一个元素的图标」这类误报。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** 图标名 → 同义 emoji（只列同义，保证零误报） */
const SYNONYM: Record<string, string[]> = {
  Square: ['⏹', '⏹️'],
  Save: ['💾'],
  Sparkles: ['✨', '🌟', '💫'],
  Rocket: ['🚀'],
  Zap: ['⚡'],
  Wand2: ['🪄'],
  Lock: ['🔒'],
  Unlock: ['🔓'],
  ShieldAlert: ['🔒', '🛡️'],
  Shield: ['🛡️'],
  ShieldCheck: ['🛡️'],
  Trash2: ['🗑️', '🗑'],
  RefreshCw: ['🔄', '♻️'],
  Search: ['🔍', '🔎'],
  Pencil: ['✏️', '✍️'],
  PenLine: ['✏️', '✍️'],
  Ban: ['🚫'],
  AlertTriangle: ['⚠️', '⚠'],
  TriangleAlert: ['⚠️', '⚠'],
  Download: ['📥', '⬇️'],
  Upload: ['📤', '⬆️'],
  Play: ['▶️'],
  CheckCircle: ['✅'],
  CheckCircle2: ['✅'],
  Check: ['✅', '✔️'],
  Target: ['🎯'],
  FileText: ['📄'],
  Link2: ['🔗'],
  Copy: ['📋'],
  Star: ['⭐'],
  Flame: ['🔥'],
  Settings: ['⚙️', '⚙'],
  Clock: ['⏰'],
  BookOpen: ['📖', '📚'],
  ListChecks: ['📋'],
  Lightbulb: ['💡'],
  Eye: ['👁️', '👁'],
  Globe: ['🌐'],
  Users: ['👥'],
  Bell: ['🔔'],
  Palette: ['🎨'],
  MessageSquare: ['💬'],
  TrendingUp: ['📈'],
  Award: ['🏆'],
  Puzzle: ['🧩'],
  Scissors: ['✂️'],
  Camera: ['📷'],
  Image: ['🖼️', '🖼'],
  Layers: ['📚'],
};

const ALL_EMOJI = [...new Set(Object.values(SYNONYM).flat())];

const isComment = (l: string) => /^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l);
/** 状态消息字符串按约定允许 emoji */
const isStatusMessage = (l: string) =>
  /(setStatusMessage|pushStatus|setMsg|setStyleMsg|setRunMsg|setLedgerMsg|setPolishMsg|setInlineFeedback|setSavedHint|setUrlMsg|setPreviewNotice|toastMsg|saveStatusMsg|console\.)\s*[(`]/.test(
    l
  );

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

const SRC = path.join(process.cwd(), 'src');

function findViolations(): string[] {
  const bad: string[] = [];
  for (const file of walk(SRC)) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, i) => {
      if (isComment(line) || isStatusMessage(line)) return;
      const emojis = ALL_EMOJI.filter((e) => line.includes(e));
      if (!emojis.length) return;

      // 向上看 8 行找图标；中间不得出现元素闭合（否则是「上一个元素」的图标）
      for (let back = 1; back <= 8; back += 1) {
        const prev = lines[i - back];
        if (prev === undefined) break;
        if (/<\//.test(prev)) break; // 元素已闭合 → 不是同一个元素
        for (const [icon, syms] of Object.entries(SYNONYM)) {
          if (!new RegExp(`<${icon}\\b`).test(prev)) continue;
          const hit = syms.filter((s) => emojis.includes(s));
          if (hit.length) {
            bad.push(
              `${rel}:${i + 1}  <${icon}/> 与 ${hit.join('')} 出现在同一元素（图标上方第 ${back} 行）`
            );
          }
        }
      }
    });
  }
  return bad;
}

describe('UI 约定 · 同一元素不得「图标 + 同义 emoji」重复', () => {
  it('src/**/*.tsx 无违规', () => {
    const bad = findViolations();
    expect(
      bad,
      `发现图标与同义 emoji 重复（应删 emoji，图标已表达同一含义）：\n${bad.join('\n')}`
    ).toEqual([]);
  });
});
