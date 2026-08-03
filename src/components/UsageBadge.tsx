/**
 * R3-B 用量看板徽标：显示本月 LLM 估算用量与预算上限。
 * 自包含——直接读 costControl（localStorage），无需父组件传值；
 * 挂载后每 30s 自动刷新，点击立即刷新。
 */
import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import type { StyleConfig } from '../types/novel';
import {
  formatUsageSummary,
  getBudgetConfig,
  getUsageSummary,
  setBudgetConfig,
} from '../services/costControl';

interface BadgeState {
  text: string;
  exceeded: boolean;
}

export const UsageBadge: React.FC<{ styleConfig?: StyleConfig }> = ({
  styleConfig,
}) => {
  const [state, setState] = useState<BadgeState>({ text: '', exceeded: false });

  const refresh = () => {
    // 与 llmClient 闸门共用同一配置源：未跑过管线时以 StyleConfig 为准
    setBudgetConfig({
      enabled: !!styleConfig?.llmBudgetEnabled,
      monthlyLimitCny: styleConfig?.llmMonthlyBudgetCny ?? 0,
    });
    const budget = getBudgetConfig();
    const summary = getUsageSummary();
    setState({
      text: formatUsageSummary(
        summary,
        budget.enabled ? budget.monthlyLimitCny : undefined
      ),
      exceeded:
        budget.enabled && summary.month.costCny >= budget.monthlyLimitCny,
    });
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state.text) return null;

  return (
    <button
      onClick={refresh}
      title={`LLM 用量（点击刷新）\n${state.text}`}
      className={`hidden lg:flex items-center space-x-1.5 bg-slate-50 border border-slate-200 px-2.5 py-1.5 rounded-xl shrink-0 ${
        state.exceeded
          ? 'text-red-700 border-red-200 bg-red-50'
          : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      <Coins
        size={13}
        className={state.exceeded ? 'text-red-600' : 'text-amber-600'}
      />
      <span className="font-mono text-[11px] whitespace-nowrap">
        {state.text}
      </span>
    </button>
  );
};
