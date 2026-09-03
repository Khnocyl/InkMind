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
  /** 已完成孵化：所有步视为「已完成」，全部可点回看 */
  allCompleted: boolean;
  onStepSelect: (step: WizardStep) => void;
}

/**
 * 横向步骤条：编号圆点（①-⑤）+ 步骤短名，圆点间细连接线。
 * 已完成与当前步 = 黑底白字圆点；未来步 = 白底灰字（不可点）。
 * 点击语义与旧步骤条一致：仅「已完成或当前」步可点，由父级 goToStep 接管。
 */
export const WizardStepper: React.FC<WizardStepperProps> = ({
  steps,
  currentStep,
  allCompleted,
  onStepSelect,
}) => {
  const currentIdx = steps.findIndex((s) => s.step === currentStep);

  return (
    <nav className="flex items-center w-full max-w-xl" aria-label="向导步骤">
      {steps.map((item, idx) => {
        const isActive = item.step === currentStep;
        const isDone = allCompleted || (currentIdx > -1 && currentIdx > idx);
        const clickable = isDone || isActive;

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
              onClick={() => {
                if (clickable) onStepSelect(item.step);
              }}
              disabled={!clickable}
              title={item.label}
              className="flex items-center gap-1.5 px-1 py-1 rounded-full focus:outline-none disabled:cursor-not-allowed cursor-pointer disabled:cursor-not-allowed group"
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
