import React, { useMemo } from 'react';
import type { PlotOutline, Character, WorldSetting } from '../../types/novel';
import { GitBranch, Link, CheckSquare, Plus } from 'lucide-react';

interface TimelinePlannerProps {
  outlines: PlotOutline[];
  characters: Character[];
  settings: WorldSetting[];
}

/** React.memo：outlines/characters/settings 引用不变时跳过重渲染（大纲页可达百卡规模） */
export const TimelinePlanner: React.FC<TimelinePlannerProps> = React.memo(({
  outlines,
  characters,
  settings,
}) => {
  // 预建角色/设定 id → 实体 Map，把每张卡片的关联查询从 O(全部) 降到 O(关联数量)。
  // 200+ 章时这是切换大纲页的主要 CPU 瓶颈（原先每卡都对全数组 filter）。
  const characterMap = useMemo(() => {
    const m = new Map<string, Character>();
    for (const c of characters) m.set(c.id, c);
    return m;
  }, [characters]);

  const settingMap = useMemo(() => {
    const m = new Map<string, WorldSetting>();
    for (const s of settings) m.set(s.id, s);
    return m;
  }, [settings]);

  return (
    <div className="flex-1 bg-white text-slate-900 p-8 lg:p-12 overflow-y-auto max-w-6xl mx-auto space-y-8 animate-fadeIn select-none">
      <div className="pb-6 border-b border-slate-200 flex items-center justify-between">
        <div>
          <div className="flex items-center space-x-2.5 mb-1">
            <GitBranch size={22} className="text-indigo-600" />
            <h1 className="font-bold text-2xl text-slate-900">全书主线剧情链与 RAG 记忆绑定轴</h1>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            在大纲阶段把即将出场的角色 ID 与需要遵守的世界红线绑定到指定章节，AI 执笔前会自动按需提取结构化上下文，实现绝不吃书、不遗忘伏笔。
          </p>
        </div>
        <button className="flex items-center space-x-2 bg-black hover:bg-neutral-800 text-white px-4 py-2 rounded-xl text-xs font-bold transition-colors shadow-md">
          <Plus size={15} />
          <span>规划新情节点与章节绑定</span>
        </button>
      </div>

      <div className="relative border-l-2 border-slate-200 pl-6 space-y-8 ml-4">
        {outlines.map((outline, index) => {
          const chapNum = outline.order || (outline as any).chapterNumber || index + 1;
          const chapTitle = outline.chapterTitle || (outline as any).title || `第 ${chapNum} 章 剧情展开`;
          const keyEvents: string[] = (outline as any).keyEvents || [outline.summary || '推进主要主线冲突'];
          // O(关联数量) 查关联，不再对全数组 filter
          const linkedChars = (outline.involvedCharacterIds || [])
            .map((id) => characterMap.get(id))
            .filter((c): c is Character => Boolean(c));
          const linkedSettings = (outline.involvedSettingIds || [])
            .map((id) => settingMap.get(id))
            .filter((s): s is WorldSetting => Boolean(s));

          return (
            <div key={outline.id} className="relative group [content-visibility:auto] [contain-intrinsic-size:auto_240px]">
              <div className="absolute -left-[31px] top-2.5 w-4 h-4 rounded-full bg-indigo-600 border-4 border-white shadow-md group-hover:bg-indigo-400 transition-colors"></div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-6 shadow-md hover:border-indigo-400 transition-colors">
                <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
                  <div className="flex items-center space-x-3">
                    <span className="bg-indigo-100 text-indigo-800 border border-indigo-300 font-mono font-bold text-xs px-2.5 py-1 rounded-lg">
                      第 {chapNum} 章
                    </span>
                    <h3 className="font-serif font-bold text-base text-slate-900">{chapTitle}</h3>
                  </div>
                  <span className="text-[11px] text-emerald-800 bg-emerald-100 border border-emerald-300 px-2.5 py-1 rounded-full font-medium flex items-center space-x-1.5">
                    <CheckSquare size={13} className="text-emerald-600" />
                    <span>RAG 上下文切片已绑定</span>
                  </span>
                </div>

                <p className="text-xs text-slate-700 leading-relaxed font-serif mb-4">
                  {outline.summary || '暂无章节梗概描述...'}
                </p>

                <div className="mb-5 space-y-2">
                  <div className="text-xs font-bold text-slate-800 mb-1">关键情节点推进：</div>
                  {keyEvents.map((evt: string, idx: number) => (
                    <div key={idx} className="text-xs text-slate-700 flex items-start space-x-2 bg-white p-2.5 rounded-lg border border-slate-200 shadow-sm">
                      <span className="text-indigo-600 font-bold">·</span>
                      <span>{evt}</span>
                    </div>
                  ))}
                </div>

                <div className="pt-4 border-t border-slate-200 flex flex-wrap gap-6 text-xs">
                  <div>
                    <span className="text-[11px] text-slate-600 font-semibold flex items-center space-x-1 mb-2">
                      <Link size={13} className="text-blue-600" />
                      <span>绑定出场角色 (防遗忘 / 跟踪亲密度变化):</span>
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {linkedChars.map((c) => (
                        <span key={c.id} className="bg-white text-slate-800 border border-slate-300 px-2.5 py-1 rounded-lg text-xs font-semibold shadow-sm">
                          {c.name} <span className="text-indigo-600 font-normal">({c.realmOrTitle || '角色'})</span>
                        </span>
                      ))}
                      {linkedChars.length === 0 && (
                        <span className="text-slate-500 text-[11px]">本章未绑定指定角色</span>
                      )}
                    </div>
                  </div>

                  <div>
                    <span className="text-[11px] text-slate-600 font-semibold flex items-center space-x-1 mb-2">
                      <Link size={13} className="text-amber-600" />
                      <span>绑定世界观与规则红线 (防越界 / 防吃书):</span>
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {linkedSettings.map((s) => (
                        <span key={s.id} className="bg-amber-50 text-amber-900 border border-amber-300 px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center space-x-1 shadow-sm">
                          <span>🛡️ {s.name}</span>
                          <span className="text-[10px] text-amber-700 font-medium">({(s.hardRules || []).length}条铁律)</span>
                        </span>
                      ))}
                      {linkedSettings.length === 0 && (
                        <span className="text-slate-500 text-[11px]">应用通用基础物理法则</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {outlines.length === 0 && (
          <div className="p-12 text-center text-slate-500 bg-slate-50 rounded-xl border border-slate-200 text-sm">
            暂无大纲章节链，请前往设定向导自动推导或在此添加。
          </div>
        )}
      </div>
    </div>
  );
});