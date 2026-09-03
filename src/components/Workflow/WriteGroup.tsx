import React, { useState } from 'react';
import type {
  Chapter,
  Character,
  WorldSetting,
  StyleConfig,
  ChapterIntent,
} from '../../types/novel';
import {
  autoPilotWriteModeLabel,
  resolveAutoPilotConfig,
  type AutoPilotWriteMode,
} from '../../services/autoPilot';
import { ChapterIntentPanel } from '../Workspace/ChapterIntentPanel';
import {
  Lock,
  Unlock,
  Rocket,
  Sliders,
  Layers,
  BookOpen,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface WriteGroupProps {
  chapter: Chapter;
  characters: Character[];
  settings: WorldSetting[];
  styleConfig: StyleConfig;
  isGenerating: boolean;
  isAutoPiloting: boolean;
  locked: boolean;
  onLockChapter?: () => void;
  onUnlockChapter?: () => void;
  /** 仅用于禁用态判断（是否有启动 handler） */
  onStartAutoPilot?: () => void;
  /** 经写前体检 guard 后的启动入口（AIWorkflowPanel.guardAndStart('autopilot')） */
  onLaunchAutoPilot: () => void;
  onUpdateStyleConfig?: (config: StyleConfig) => void;
  onGenerateChapterIntent?: () => Promise<void> | void;
  onSaveChapterIntent?: (intent: ChapterIntent) => void;
}

/**
 * 右栏分组「写作」：写前大纲确认常驻；分镜 / 连写 / 定稿锁定为折叠行（默认收起，
 * 一屏收完，对照设计稿 01/02 帧 .card.sub）；角色状态回写、章末 Recap、设定切片
 * 等生成产物展示折叠行。强调色纪律：墨=主操作，语义色只上徽标。
 */
export const WriteGroup: React.FC<WriteGroupProps> = ({
  chapter,
  characters,
  settings,
  styleConfig,
  isGenerating,
  isAutoPiloting,
  locked,
  onLockChapter,
  onUnlockChapter,
  onStartAutoPilot,
  onLaunchAutoPilot,
  onUpdateStyleConfig,
  onGenerateChapterIntent,
  onSaveChapterIntent,
}) => {
  // 渐进披露：折叠行默认收起（点击标题展开）
  const [beatsOpen, setBeatsOpen] = useState(false);
  const [apOpen, setApOpen] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  const [infoStatusOpen, setInfoStatusOpen] = useState(false);
  const [infoRecapOpen, setInfoRecapOpen] = useState(false);
  const [infoSliceOpen, setInfoSliceOpen] = useState(false);
  const activeChars = characters.filter((c) => chapter.involvedCharacterIds?.includes(c.id));
  const activeSettings = settings.filter((s) => chapter.involvedSettingIds?.includes(s.id));
  const apCfg = resolveAutoPilotConfig(styleConfig);
  const beatsCount = (chapter.beats || []).length;

  return (
    <>
      {/* 写前大纲确认 */}
      {onGenerateChapterIntent && onSaveChapterIntent && (
        <ChapterIntentPanel
          chapter={chapter}
          busy={isGenerating || isAutoPiloting}
          onGenerate={onGenerateChapterIntent}
          onSaveIntent={onSaveChapterIntent}
        />
      )}

      {/* 折叠行卡片组（设计稿 .card.sub：分镜 / 连写 / 定稿锁定） */}
      <div className="mx-4 mt-3 border border-slate-200 rounded-xl bg-slate-50 divide-y divide-slate-200">
        {/* 分镜细纲 */}
        <div className="px-[11px]">
          <button
            type="button"
            onClick={() => setBeatsOpen((v) => !v)}
            className="w-full flex items-center justify-between py-2"
          >
            <span className="text-[11px] font-semibold text-slate-900 flex items-center space-x-1.5">
              <Sliders size={13} className="text-slate-500" />
              <span>分镜（{beatsCount}）· 可拖动排序</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-[9.5px] font-bold text-slate-600 bg-white border border-slate-300 px-[7px] py-[1.5px] rounded-full">
                杜绝水字数
              </span>
              {beatsOpen ? <ChevronUp size={13} className="text-slate-500" /> : <ChevronDown size={13} className="text-slate-500" />}
            </span>
          </button>
          {beatsOpen && (
            <div className="pb-2.5 space-y-2 max-h-52 overflow-y-auto pr-1">
              {(chapter.beats || []).map((beat) => (
                <div key={beat.id} className="p-2.5 bg-white border border-slate-200 rounded-lg text-xs shadow-sm">
                  <div className="flex items-center justify-between font-bold text-slate-900 mb-1">
                    <span>镜头 #{beat.order}</span>
                    {beat.focusSense && (
                      <span className="text-[10px] font-normal text-slate-600 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-200">
                        {beat.focusSense}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-800 text-[11px] leading-relaxed">{beat.description}</p>
                </div>
              ))}
              {beatsCount === 0 && (
                <div className="text-center py-5 text-xs text-slate-500 bg-white border border-slate-200 rounded-lg">
                  尚未拆分分镜，点击上方推理按钮一键推导。
                </div>
              )}
            </div>
          )}
        </div>

        {/* 连写 Auto-Pilot */}
        <div className="px-[11px]">
          <button
            type="button"
            onClick={() => setApOpen((v) => !v)}
            className="w-full flex items-center justify-between py-2"
          >
            <span className="text-[11px] font-semibold text-slate-900 flex items-center space-x-1.5">
              <Rocket size={13} className="text-slate-500" />
              <span>
                连写 · 目标 {styleConfig.autoPilotTargetChapters ?? apCfg.targetChapters} 章 ·{' '}
                {autoPilotWriteModeLabel(apCfg.writeMode)}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-[10px] text-slate-500">Auto-Pilot</span>
              {apOpen ? <ChevronUp size={13} className="text-slate-500" /> : <ChevronDown size={13} className="text-slate-500" />}
            </span>
          </button>
          {apOpen && (
            <div className="pb-2.5 space-y-2">
              {onUpdateStyleConfig && (
                <>
                  <label className="flex items-center justify-between text-[10px] text-slate-600">
                    <span>本轮连写章数</span>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={styleConfig.autoPilotTargetChapters ?? 3}
                      onChange={(e) =>
                        onUpdateStyleConfig({
                          ...styleConfig,
                          autoPilotTargetChapters: Math.max(
                            1,
                            Math.min(30, Number(e.target.value) || 1)
                          ),
                        })
                      }
                      className="w-14 px-1.5 py-0.5 border border-slate-300 rounded text-right font-mono bg-white"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] text-slate-600">
                    <span>写作深度</span>
                    <select
                      value={styleConfig.autoPilotWriteMode || 'until_green'}
                      onChange={(e) =>
                        onUpdateStyleConfig({
                          ...styleConfig,
                          autoPilotWriteMode: e.target.value as AutoPilotWriteMode,
                        })
                      }
                      className="w-full px-2 py-1 border border-slate-300 rounded-lg bg-white text-[11px] font-medium text-slate-800"
                    >
                      <option value="until_green">
                        {autoPilotWriteModeLabel('until_green')}
                      </option>
                      <option value="draft_only">
                        {autoPilotWriteModeLabel('draft_only')}
                      </option>
                      <option value="until_review">
                        {autoPilotWriteModeLabel('until_review')}
                      </option>
                    </select>
                  </label>
                </>
              )}
              <button
                type="button"
                onClick={onLaunchAutoPilot}
                disabled={!onStartAutoPilot}
                className="w-full py-2.5 px-3 bg-black hover:bg-neutral-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center space-x-2 shadow-sm"
              >
                <Rocket size={14} />
                <span>🚀 启动连写</span>
              </button>
            </div>
          )}
        </div>

        {/* 定稿锁定 / 解锁重写 */}
        {(onLockChapter || onUnlockChapter) && (
          <div className="px-[11px]">
            <button
              type="button"
              onClick={() => setLockOpen((v) => !v)}
              className="w-full flex items-center justify-between py-2"
            >
              <span className="text-[11px] font-semibold text-slate-900 flex items-center space-x-1.5">
                <Lock size={13} className="text-slate-500" />
                <span>定稿锁定</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-[10px] text-slate-500">{locked ? '已锁' : '未锁'}</span>
                {lockOpen ? <ChevronUp size={13} className="text-slate-500" /> : <ChevronDown size={13} className="text-slate-500" />}
              </span>
            </button>
            {lockOpen && (
              <div className="pb-2.5">
                {locked ? (
                  <button
                    type="button"
                    disabled={isGenerating}
                    onClick={onUnlockChapter}
                    className="w-full text-[11px] font-bold py-1.5 px-2 rounded-lg border border-black bg-black text-white hover:bg-neutral-800 disabled:opacity-50 flex items-center justify-center gap-1"
                  >
                    <Unlock size={12} />
                    解锁重写
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isGenerating || !(chapter.content || '').trim()}
                    onClick={onLockChapter}
                    className="w-full text-[11px] font-bold py-1.5 px-2 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50 flex items-center justify-center gap-1"
                    title="防止流水线与 Auto-Pilot 覆盖正文"
                  >
                    <Lock size={12} />
                    定稿锁定
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 角色状态回写（生成产物展示折叠行） */}
      <div className="p-4 border-b border-slate-200 space-y-2 bg-white">
        <button
          type="button"
          onClick={() => setInfoStatusOpen((v) => !v)}
          className="w-full flex items-center justify-between"
        >
          <span className="text-[11px] font-semibold text-slate-900 flex items-center space-x-1.5">
            <Layers size={14} className="text-slate-500" />
            <span>角色状态更新</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${
                chapter.memoryWriteLog && chapter.memoryWriteLog.appliedCount > 0
                  ? 'bg-rose-50 text-rose-800 border-rose-200'
                  : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}
            >
              {chapter.memoryWriteLog
                ? chapter.memoryWriteLog.appliedCount > 0
                  ? `已回写 ${chapter.memoryWriteLog.appliedCount}`
                  : '无变更'
                : '未执行'}
            </span>
            {infoStatusOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>
        {infoStatusOpen && (
          <>
        {chapter.memoryWriteLog ? (
          <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1.5">
            <div className="text-[10px] text-slate-500">
              来源：{chapter.memoryWriteLog.source === 'llm' ? '模型抽取' : '启发式'} ·{' '}
              {chapter.memoryWriteLog.generatedAt
                ? new Date(chapter.memoryWriteLog.generatedAt).toLocaleString()
                : ''}
            </div>
            {(chapter.memoryWriteLog.patches || []).length === 0 ? (
              <div className="text-[11px] text-slate-500">本章角色卡无字段变化。</div>
            ) : (
              <ul className="space-y-1.5 max-h-36 overflow-y-auto">
                {chapter.memoryWriteLog.patches.map((p) => (
                  <li key={p.characterId} className="p-2 bg-white border border-slate-200 rounded-lg">
                    <div className="font-semibold text-slate-800 text-[11px]">{p.characterName}</div>
                    <div className="text-[10px] text-rose-800 mt-0.5">
                      {p.changedFields.join(' · ')}
                    </div>
                    {p.reason && (
                      <div className="text-[10px] text-slate-500 mt-0.5">{p.reason}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[10px] text-slate-500 leading-relaxed">
              状态/地点/境界会写入世界圣经角色卡，下一章切片自动带上。
            </p>
          </div>
        ) : (
          <div className="text-[11px] text-slate-500 italic p-2 bg-slate-50 rounded border border-slate-200">
            跑完创作闭环后，系统会根据正文回写角色 status / 地点 / 境界。
          </div>
        )}
          </>
        )}
      </div>

      {/* 本章已存 recap（生成产物展示折叠行） */}
      <div className="p-4 border-b border-slate-200 space-y-2 bg-white">
        <button
          type="button"
          onClick={() => setInfoRecapOpen((v) => !v)}
          className="w-full flex items-center justify-between"
        >
          <span className="text-[11px] font-semibold text-slate-900 flex items-center space-x-1.5">
            <BookOpen size={14} className="text-neutral-800" />
            <span>本章章末 Recap</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${
                chapter.recap
                  ? chapter.recap.source === 'fallback'
                    ? 'bg-amber-50 text-amber-800 border-amber-200'
                    : 'bg-neutral-100 text-neutral-800 border-neutral-200'
                  : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}
            >
              {chapter.recap
                ? chapter.recap.source === 'fallback'
                  ? '启发式'
                  : '已沉淀'
                : '未生成'}
            </span>
            {infoRecapOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>
        {infoRecapOpen && (
          <>
        {chapter.recap ? (
          <div className="p-2.5 bg-white border border-slate-200 rounded-lg text-xs space-y-2 shadow-sm">
            <p className="text-[11px] text-slate-800 leading-relaxed whitespace-pre-wrap">
              {chapter.recap.text}
            </p>
            {chapter.recap.endingState && (
              <div className="text-[10px] text-slate-600 bg-slate-50 border border-slate-100 rounded p-2">
                <span className="font-semibold text-slate-700">章末现场：</span>
                {chapter.recap.endingState}
              </div>
            )}
            {chapter.recap.keyFacts?.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-slate-600 mb-1">
                  已钉死事实 ({chapter.recap.keyFacts.length})
                </div>
                <ul className="space-y-1 max-h-28 overflow-y-auto">
                  {chapter.recap.keyFacts.map((f, i) => (
                    <li key={i} className="text-[10px] text-slate-700 flex gap-1.5">
                      <span className="text-slate-400 font-bold shrink-0">{i + 1}.</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {chapter.recap.openThreads?.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-amber-700 mb-1">
                  未收伏笔 ({chapter.recap.openThreads.length})
                </div>
                <ul className="space-y-1">
                  {chapter.recap.openThreads.map((t, i) => (
                    <li key={i} className="text-[10px] text-slate-700">· {t}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-slate-500 italic p-2 bg-white rounded border border-slate-200">
            定稿后自动生成本章摘要，供下一章写作参考。
          </div>
        )}
          </>
        )}
      </div>

      {/* 设定与角色切片（生成产物展示折叠行） */}
      <div className="p-4 border-b border-slate-200 space-y-2 bg-white">
        <button
          type="button"
          onClick={() => setInfoSliceOpen((v) => !v)}
          className="w-full flex items-center justify-between"
        >
          <span className="text-[11px] font-semibold text-slate-900 flex items-center space-x-1.5">
            <Layers size={14} className="text-slate-500" />
            <span>设定/角色状态切片 ({activeChars.length + activeSettings.length})</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-300">
              防遗忘
            </span>
            {infoSliceOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
        </button>

        {infoSliceOpen && (
        <div className="space-y-2">
          <div>
            <div className="text-[11px] font-semibold text-slate-600 mb-1">活跃人物状态追踪 ({activeChars.length})</div>
            <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
              {activeChars.map((char) => (
                <div key={char.id} className="p-2.5 bg-white border border-slate-200 rounded-lg text-xs shadow-sm">
                  <div className="flex items-center justify-between font-bold text-slate-900">
                    <span className="truncate pr-1">{char.name} ({char.alias || '核心人物'})</span>
                    <span className="text-[10px] font-normal px-1.5 py-0.5 bg-neutral-100 border border-neutral-200 rounded text-neutral-700 flex-shrink-0">
                      {char.realmOrTitle || '修行者'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600 mt-1 line-clamp-1">
                    当前状态: <strong className="text-slate-800">{char.status || '活跃'}</strong>
                  </div>
                </div>
              ))}
              {activeChars.length === 0 && (
                <div className="text-[11px] text-slate-500 italic p-2 bg-white rounded border border-slate-200 shadow-sm">
                  本章暂无关联角色记忆，可在大纲梗概中提及即可自动捕捉。
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-slate-600 mb-1">世界红线铁律约束 ({activeSettings.length})</div>
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {activeSettings.map((set) => (
                <div key={set.id} className="p-2.5 bg-white border border-slate-200 rounded-lg text-xs shadow-sm">
                  <div className="font-bold text-amber-800 text-xs mb-1">{set.name}</div>
                  {(set.hardRules || []).slice(0, 2).map((rule, idx) => (
                    <div key={idx} className="text-[10px] text-slate-700 flex items-start space-x-1.5 mt-0.5">
                      <span className="text-amber-600 font-bold">！</span>
                      <span className="line-clamp-2">{rule}</span>
                    </div>
                  ))}
                </div>
              ))}
              {activeSettings.length === 0 && (
                <div className="text-[11px] text-slate-500 italic p-2 bg-white rounded border border-slate-200 shadow-sm">
                  本章未特别关联红线，将应用通用物理法则。
                </div>
              )}
            </div>
          </div>
        </div>
        )}
      </div>
    </>
  );
};
