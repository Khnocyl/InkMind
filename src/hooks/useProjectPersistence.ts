import { useCallback, useRef } from 'react';
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import type { BookProject, BookProjectSummary } from '../types/novel';
import { saveProject, listProjects } from '../services/storage';
import { CoalescedWriter } from '../services/coalescedWriter';
import { mergeStyleConfigPreserve } from '../services/styleImitate';

export interface UseProjectPersistenceOptions {
  /** 始终指向最新 project 的 ref（长异步工作流防闭包脏写） */
  projectRef: MutableRefObject<BookProject | null>;
  /** 同步 state + ref 的安全 setter */
  setProjectSafe: (next: BookProject | null) => void;
  /** 书库列表 setter（持久化后刷新摘要） */
  setProjectsList: Dispatch<SetStateAction<BookProjectSummary[]>>;
}

/**
 * 项目落盘路径（R1 拆分第一步）。
 *
 * 封装：
 * - CoalescedWriter（R2-3）：串行化 IndexedDB 写入 + 合并突发更新，
 *   同一时刻最多 1 在跑 + 1 排队；
 * - handleUpdateAndPersistProject：合并 partial 更新 → 保护文风档案
 *   （styleConfig 陈旧整表覆盖）→ 同步 ref/state → 合并式落盘。
 *
 * 不变量：`await` 返回时本次数据必已落盘（状态先同步进 ref，
 * 写任务执行时读最新 ref）。
 */
export function useProjectPersistence({
  projectRef,
  setProjectSafe,
  setProjectsList,
}: UseProjectPersistenceOptions) {
  /** 串行化 IndexedDB 写入 + 合并突发（R2-3） */
  const persistWriterRef = useRef<CoalescedWriter | null>(null);
  if (!persistWriterRef.current) {
    persistWriterRef.current = new CoalescedWriter(
      async () => {
        const toSave = projectRef.current;
        if (!toSave) return;
        await saveProject(toSave);
        const updatedList = await listProjects();
        setProjectsList(updatedList);
      },
      (err) => console.error('项目持久化失败:', err)
    );
  }

  const handleUpdateAndPersistProject = useCallback(
    async (
      updates: Partial<BookProject> | ((prev: BookProject) => Partial<BookProject>)
    ) => {
      const base = projectRef.current;
      if (!base) return;

      let partial = typeof updates === 'function' ? updates(base) : updates;
      // 保护文风仿写档案：禁止陈旧 styleConfig 整表覆盖冲掉 styleProfiles
      if (partial.styleConfig) {
        partial = {
          ...partial,
          styleConfig: mergeStyleConfigPreserve(base.styleConfig, partial.styleConfig),
        };
      }
      const next: BookProject = {
        ...base,
        ...partial,
        lastModified: new Date().toISOString(),
      };
      setProjectSafe(next);

      // 合并式持久化：突发更新只写「正在跑 + 末尾一次」；
      // await 语义不变 —— resolve 时本次状态已随某次写落盘
      await persistWriterRef.current?.schedule();
    },
    // projectRef / persistWriterRef 均为 ref（引用恒定），不会导致重创建
    [projectRef, setProjectSafe]
  );

  return { handleUpdateAndPersistProject };
}
