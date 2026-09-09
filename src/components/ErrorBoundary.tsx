import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 顶层错误边界：渲染期异常此前会直接卸载整棵组件树 → 白屏（桌面端尤其糟，
 * 没有地址栏也没有刷新按钮）。这里兜底展示错误信息 + 重新加载入口，
 * 并保留错误详情供用户复制反馈。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 渲染异常:', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-full w-full flex items-center justify-center bg-white text-slate-900 p-6 overflow-auto">
        <div className="max-w-xl w-full space-y-3">
          <h1 className="text-base font-bold">界面出错了</h1>
          <p className="text-xs text-slate-600 leading-relaxed">
            数据已保存在本地（IndexedDB），重新加载通常可以恢复。若反复出现，请把下面的错误详情反馈给我们。
          </p>
          <pre className="text-[10px] font-mono whitespace-pre-wrap break-all bg-slate-50 border border-slate-200 rounded-lg p-2 max-h-48 overflow-auto text-slate-700">
            {error.stack || error.message}
          </pre>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleReload}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-black text-white hover:bg-neutral-800"
            >
              重新加载
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(`${error.stack || error.message}`);
              }}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
            >
              复制错误详情
            </button>
          </div>
        </div>
      </div>
    );
  }
}
