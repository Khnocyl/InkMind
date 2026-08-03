import React, { useEffect, useState } from 'react';
import type { Chapter, ChapterIntent } from '../../types/novel';
import {
  confirmIntent,
  emptyIntent,
  hasIntentDraft,
  intentCompleteness,
  isIntentConfirmed,
  normalizeChapterIntent,
  touchIntentUnconfirmed,
} from '../../services/chapterIntent';
import {
  Target,
  Ban,
  Anchor,
  Sparkles,
  CheckCircle2,
  Loader2,
  ChevronDown,
  ChevronUp,
  ListOrdered,
} from 'lucide-react';

interface ChapterIntentPanelProps {
  chapter: Chapter;
  busy?: boolean;
  onGenerate: () => Promise<void> | void;
  onSaveIntent: (intent: ChapterIntent) => void;
}

export const ChapterIntentPanel: React.FC<ChapterIntentPanelProps> = ({
  chapter,
  busy = false,
  onGenerate,
  onSaveIntent,
}) => {
  const [open, setOpen] = useState(true);
  const [generating, setGenerating] = useState(false);
  const intent = normalizeChapterIntent(chapter.intent || emptyIntent());
  const confirmed = isIntentConfirmed(intent);
  const { score, missing } = intentCompleteness(intent);

  const [mustDoText, setMustDoText] = useState(intent.mustDo.join('\n'));
  const [mustAvoidText, setMustAvoidText] = useState(intent.mustAvoid.join('\n'));
  const [hook, setHook] = useState(intent.endingHook);
  const [beatsText, setBeatsText] = useState((intent.emotionalBeats || []).join('\n'));

  // 切换章节时同步表单
  useEffect(() => {
    const i = normalizeChapterIntent(chapter.intent || emptyIntent());
    setMustDoText(i.mustDo.join('\n'));
    setMustAvoidText(i.mustAvoid.join('\n'));
    setHook(i.endingHook);
    setBeatsText((i.emotionalBeats || []).join('\n'));
  }, [chapter.id, chapter.intent]);

  const lines = (s: string) =>
    s
      .split('\n')
      .map((x) => x.replace(/^[\d\.、\-\*\s]+/, '').trim())
      .filter(Boolean);

  const buildFromForm = (keepConfirmed: boolean): ChapterIntent => {
    const next: ChapterIntent = {
      ...intent,
      mustDo: lines(mustDoText).slice(0, 8),
      mustAvoid: lines(mustAvoidText).slice(0, 8),
      endingHook: hook.trim().slice(0, 200),
      emotionalBeats: lines(beatsText).slice(0, 8),
      source: intent.source === 'llm' && !intent.confirmed ? 'llm' : intent.source || 'manual',
    };
    if (keepConfirmed && intent.confirmed) {
      return confirmIntent(next);
    }
    return touchIntentUnconfirmed(next);
  };

  const persistEdit = () => {
    onSaveIntent(buildFromForm(false));
  };

  const handleConfirm = () => {
    const draft = buildFromForm(false);
    if (draft.mustDo.length < 1 || draft.endingHook.trim().length < 4) {
      window.alert('请至少填写 1 条「必须完成」和「章末钩子」后再确认。');
      return;
    }
    onSaveIntent(confirmIntent(draft));
  };

  const handleGenerate = async () => {
    if (busy || generating) return;
    setGenerating(true);
    try {
      await onGenerate();
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="p-4 border-b border-slate-200 bg-white space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between"
      >
        <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
          <Target size={14} className="text-orange-600" />
          写前大纲确认
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${
              confirmed
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : hasIntentDraft(intent)
                  ? 'bg-amber-50 text-amber-900 border-amber-200'
                  : 'bg-slate-50 text-slate-600 border-slate-200'
            }`}
          >
            {confirmed ? '已确认' : hasIntentDraft(intent) ? '草稿·待确认' : '未生成'} · {score}分
          </span>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div className="space-y-2.5">
          <p className="text-[10px] text-slate-500 leading-relaxed">
            开写前先定：必须完成 / 禁止事项 / 章末钩子。确认后分镜与正文会严格执行。编辑字段会取消确认。
          </p>

          {!confirmed && missing.length > 0 && (
            <div className="text-[10px] text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5">
              待补：{missing.join(' · ')}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || generating}
              onClick={handleGenerate}
              className="flex-1 inline-flex items-center justify-center gap-1 text-[11px] font-bold py-1.5 rounded-lg border border-orange-200 bg-orange-50 text-orange-900 hover:bg-orange-100 disabled:opacity-50"
            >
              {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {hasIntentDraft(intent) ? '重新生成' : 'AI 生成大纲'}
            </button>
            <button
              type="button"
              disabled={busy || generating || confirmed}
              onClick={handleConfirm}
              className="flex-1 inline-flex items-center justify-center gap-1 text-[11px] font-bold py-1.5 rounded-lg bg-black text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              <CheckCircle2 size={12} />
              确认大纲
            </button>
          </div>

          <label className="block space-y-1">
            <span className="text-[10px] font-bold text-slate-700 flex items-center gap-1">
              <Target size={11} className="text-orange-600" />
              必须完成（每行一条）
            </span>
            <textarea
              rows={3}
              value={mustDoText}
              disabled={busy}
              onChange={(e) => setMustDoText(e.target.value)}
              onBlur={persistEdit}
              className="w-full text-[11px] p-2 border border-slate-200 rounded-lg focus:border-orange-400 focus:outline-none leading-relaxed disabled:bg-slate-50"
              placeholder={'例：\n逼出反派真实身份\n主角确认断刀来历'}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[10px] font-bold text-slate-700 flex items-center gap-1">
              <Ban size={11} className="text-red-600" />
              禁止事项（每行一条）
            </span>
            <textarea
              rows={2}
              value={mustAvoidText}
              disabled={busy}
              onChange={(e) => setMustAvoidText(e.target.value)}
              onBlur={persistEdit}
              className="w-full text-[11px] p-2 border border-slate-200 rounded-lg focus:border-red-300 focus:outline-none leading-relaxed disabled:bg-slate-50"
              placeholder={'例：\n不得让已死角色复活\n禁止章末升华'}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[10px] font-bold text-slate-700 flex items-center gap-1">
              <Anchor size={11} className="text-sky-600" />
              章末钩子
            </span>
            <input
              value={hook}
              disabled={busy}
              onChange={(e) => setHook(e.target.value)}
              onBlur={persistEdit}
              className="w-full text-[11px] px-2 py-1.5 border border-slate-200 rounded-lg focus:border-sky-400 focus:outline-none disabled:bg-slate-50"
              placeholder="一句具体可拍的收束，勿写哲理"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[10px] font-bold text-slate-700 flex items-center gap-1">
              <ListOrdered size={11} className="text-violet-600" />
              情绪/爽点节拍（可选，每行一条）
            </span>
            <textarea
              rows={2}
              value={beatsText}
              disabled={busy}
              onChange={(e) => setBeatsText(e.target.value)}
              onBlur={persistEdit}
              className="w-full text-[11px] p-2 border border-slate-200 rounded-lg focus:border-violet-300 focus:outline-none leading-relaxed disabled:bg-slate-50"
              placeholder={'压迫铺垫\n信息差反转\n小胜或更险'}
            />
          </label>

          {confirmed && intent.confirmedAt && (
            <p className="text-[10px] text-emerald-700 font-mono">
              已于 {new Date(intent.confirmedAt).toLocaleString()} 确认
              {intent.source ? ` · ${intent.source}` : ''}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
