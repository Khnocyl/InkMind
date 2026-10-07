/**
 * 设置分区：核心文风开关 + Few-Shot 风格样本库
 * （自 StyleAndEngineManager 拆出；纯 props，无本地 state）
 */
import React from 'react';
import { Eye, CheckCircle2 } from 'lucide-react';
import type { StyleConfig } from '../../types/novel';

interface SettingsCoreStyleSectionProps {
  styleConfig: StyleConfig;
  onUpdateStyleConfig: (
    config: StyleConfig | ((prev: StyleConfig) => StyleConfig)
  ) => Promise<void> | void;
}

export const SettingsCoreStyleSection: React.FC<SettingsCoreStyleSectionProps> = ({
  styleConfig,
  onUpdateStyleConfig,
}) => {
  const handleSelectExample = (id: string) => {
    onUpdateStyleConfig((prev) => ({
      ...prev,
      selectedExampleId: id,
    }));
  };

  return (
      <div id="sec-core-switch" className="space-y-6">
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 space-y-6 shadow-sm">
        <h2 className="text-base font-bold text-slate-900 border-b border-slate-200 pb-3">
          🎛 核心文风开关
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="p-5 bg-white border border-slate-200 rounded-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <span className="font-bold text-sm text-slate-900 flex items-center space-x-2">
              <span>🚫 禁止结尾升华与多余哲理说教</span>
            </span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={styleConfig.forbidEndingSublimation}
                onChange={(e) =>
                  onUpdateStyleConfig({ ...styleConfig, forbidEndingSublimation: e.target.checked })
                }
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-black"></div>
            </label>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            AI 常见通病之一是在章节或段落末尾强制进行“人生哲理升华”或“宿命感慨”（如：<i>“在这茫茫天地间，命运的转轮已然悄悄转动……”</i>）。
          </p>
          <div className="text-[11px] text-neutral-900 font-semibold bg-neutral-100 p-3 border border-neutral-200 rounded-xl">
            👉 开启后：执笔和自检 Agent 将严厉压制总结倾向，强制要求章节结尾必须<strong>“戛然而止在具体的动作、冲突画面或短语断口上”</strong>。
          </div>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <span className="font-bold text-sm text-slate-900 flex items-center space-x-2">
              <span>🎬 Show, Don't Tell (展示而非阐述)</span>
            </span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={styleConfig.enforceShowDontTell}
                onChange={(e) =>
                  onUpdateStyleConfig({ ...styleConfig, enforceShowDontTell: e.target.checked })
                }
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-black"></div>
            </label>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            严禁 AI 直接陈述人物情绪（如“他极度震撼与恐惧”），要求强行将心理转化为具体的生理细节（如指骨微冷、剑刃蜂鸣、内息凝滞）。
          </p>
          <div className="text-[11px] text-slate-800 bg-white p-3 border border-slate-200 rounded-xl shadow-sm">
            配合分镜头细纲使用，可以大幅消除注水感，使文字具有沉浸的剧作电影张力。
          </div>
        </div>

        <div className="p-5 bg-white border border-slate-200 rounded-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <span className="font-bold text-sm text-slate-900 flex items-center space-x-2">
              <span>✍️ 破折号白名单（允许「——」）</span>
            </span>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={styleConfig.allowEmDash === true}
                onChange={(e) =>
                  onUpdateStyleConfig({ ...styleConfig, allowEmDash: e.target.checked })
                }
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-black"></div>
            </label>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            默认关闭：写后校验会把正文中的破折号「——」记为 error 并阻断绿通（破折号是常见 AI 味标记）。
          </p>
          <div className="text-[11px] text-slate-800 bg-white p-3 border border-slate-200 rounded-xl shadow-sm">
            👉 开启后：写后校验放行破折号，已有/新增的「——」不再计违规。适合以破折号为节奏器官的文风；
            激活文风档案若声明了省略号/破折号容忍（ellipsis-emphatic），无需开启本开关。
          </div>
        </div>
        </div>
        <div className="border-t border-slate-200 pt-5">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3">
          <div className="font-bold text-base text-slate-900 flex items-center space-x-2">
            <Eye className="w-5 h-5 text-emerald-600" />
            <span>Few-Shot 目标短句风格示例克隆库 (Style Cloner)</span>
          </div>
          <span className="text-xs font-emerald-800 bg-emerald-100 border border-emerald-300 px-3 py-1 rounded-full font-bold flex items-center space-x-1.5">
            <CheckCircle2 size={13} className="text-emerald-600" />
            <span>当前已激活目标语感</span>
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {(styleConfig.fewShotExamples || []).map((example) => {
            const isSelected = example.id === styleConfig.selectedExampleId;
            return (
              <div
                key={example.id}
                onClick={() => handleSelectExample(example.id)}
                className={`p-5 rounded-xl cursor-pointer transition-all border flex flex-col justify-between ${
                  isSelected
                    ? 'bg-white border-neutral-900 shadow-lg'
                    : 'bg-white border-slate-200 hover:border-slate-400 shadow-sm'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <span className={`font-bold text-sm ${isSelected ? 'text-neutral-800' : 'text-slate-900'}`}>
                      {example.title}
                    </span>
                    {isSelected && (
                      <span className="text-[10px] bg-black text-white px-2 py-0.5 rounded-full font-bold">
                        当前激活
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-600 mb-3 border-b border-slate-200 pb-2.5">
                    <strong className="text-slate-900">行文要诀：</strong>
                    {example.authorStyle}
                  </div>
                  <div className="text-xs text-slate-800 font-serif leading-relaxed bg-slate-50 p-3 rounded-lg border border-slate-200 line-clamp-6">
                    {example.content}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-200 text-[11px] text-slate-600">
                  <strong className="text-neutral-800">核心解构：</strong>
                  {example.analysis}
                </div>
              </div>
            );
          })}
        </div>
        </div>
        </div>
      </div>
  );
};
