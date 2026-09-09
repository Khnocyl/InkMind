import React from 'react';
import type { WizardStep } from '../../types/novel';

export interface WizardStepperItem {
  step: WizardStep;
  /** 完整步骤名（悬浮提示沿用原文案） */
  label: string;
  /** 步骤条短名：灵感/书名/角色/世界观/大纲 */
  short: string;
  num: number;
}

interface WizardStepperProps {
  steps: WizardStepperItem[];
  currentStep: WizardStep;
  /** 已有产出的步骤（用于圆点完成态；与「当前位置」无关，跳步后依然准确） */
  doneSteps: WizardStep[];
  /** 已完成孵化：所有步视为「已完成」 */
  allCompleted: boolean;
  onStepSelect: (step: WizardStep) => void;
}

/**
 * 横向步骤条：编号圆点（①-⑤）+ 步骤短名，圆点间细连接线。
 * 完成态来自 doneSteps（项目真实产出），不是「位置在左边」。
 *
 * 每一步都可点击：允许直接跳到任意一步重跑（例如对书名满意、只想重新推导角色，
 * 就不必让 AI 把书名再跑一遍烧 token）。缺前置条件时由各步的生成处理器给出
 * 明确提示，而不是静默生成垃圾内容。
 */
export const WizardStepper: React.FC<WizardStepperProps> = ({
  steps,
  currentStep,
  doneSteps,
  allCompleted,
  onStepSelect,
}) => {
  return (
    <nav className="flex items-center w-full max-w-xl" aria-label="向导步骤">
      {steps.map((item, idx) => {
        const isActive = item.step === currentStep;
        const isDone = allCompleted || doneSteps.includes(item.step);

        return (
          <React.Fragment key={item.step}>
            {idx > 0 && (
              <span
                aria-hidden
                className={`h-px flex-1 min-w-[12px] transition-colors ${
                  isDone ? 'bg-slate-900' : 'bg-slate-200'
                }`}
              />
            )}
            <button
              type="button"
              onClick={() => onStepSelect(item.step)}
              title={`${item.label}（点击直接跳转到这一步）`}
              className="flex items-center gap-1.5 px-1 py-1 rounded-full focus:outline-none cursor-pointer group"
            >
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 transition-colors ${
                  isDone || isActive
                    ? 'bg-black text-white shadow-sm'
                    : 'bg-white text-slate-400 border border-slate-300 group-hover:border-slate-400'
                }`}
              >
                {item.num}
              </span>
              <span
                className={`text-xs hidden lg:inline whitespace-nowrap transition-colors ${
                  isActive
                    ? 'font-bold text-black'
                    : isDone
                    ? 'font-medium text-slate-700'
                    : 'text-slate-400'
                }`}
              >
                {item.short}
              </span>
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
};
