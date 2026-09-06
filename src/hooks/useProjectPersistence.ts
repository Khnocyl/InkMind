import { useCallback, useEffect, useRef } from 'react';
import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import type { BookProject, BookProjectSummary } from '../types/novel';
import { saveProject, listProjects, isProjectConflictError } from '../services/storage';
import { CoalescedWriter } from '../services/coalescedWriter';
import { mergeStyleConfigPreserve } from '../services/styleImitate';
import { flushAutoBackup } from '../services/autoBackup';

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
  /** 跨标签页写冲突：只弹一次，避免每次去抖落盘都打断 */
  const conflictAlertedRef = useRef(false);
  if (!persistWriterRef.current) {
    persistWriterRef.current = new CoalescedWriter(
      async () => {
        const toSave = projectRef.current;
        if (!toSave) return;
        await saveProject(toSave);
        const updatedList = await listProjects();
        setProjectsList(updatedList);
      },
      (err) => {
        console.error('项目持久化失败:', err);
        // 他页已修改导致拒写：静默 console 不足以止损（用户会继续敲而全部不落盘），显式打断一次
        if (isProjectConflictError(err) && !conflictAlertedRef.current) {
          conflictAlertedRef.current = true;
          window.alert(err.message);
        }
      }
    );
  }

  // R3 收尾：页面关闭/切后台前兜底 flush——
  // 避免「导入文风仿写后立刻刷新」中断 in-flight 写事务导致丢失。
  useEffect(() => {
    const flush = () => {
      void persistWriterRef.current?.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

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

  /**
   * 击键级编辑专用（标题/梗概/待修等元数据字段）：状态立即更新（输入不卡），
   * 落盘合并进 400ms 窗口——此前每击键 = 一次全书序列化落盘 + 书库列表刷新。
   * 注意：不保证调用返回即落盘（调用方均为 fire-and-forget）；页面隐藏时兜底冲刷。
   */
  const lightPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 去抖窗口内捕获的项目快照：切书竞态时用它兜底落盘，避免旧书最后编辑丢失
  const lightSnapshotRef = useRef<BookProject | null>(null);
  const handleUpdateAndPersistProjectDebounced = useCallback(
    (
      updates: Partial<BookProject> | ((prev: BookProject) => Partial<BookProject>)
    ) => {
      const base = projectRef.current;
      if (!base) return;

      let partial = typeof updates === 'function' ? updates(base) : updates;
      if (partial.styleConfig) {
        partial = {
          ...partial,
          styleConfig: mergeStyleConfigPreserve(base.styleConfig, partial.styleConfig),
        };
      }
      // 1) 状态立即更新（受控输入不卡顿；写任务执行时读 projectRef 最新值）
      const next: BookProject = {
        ...base,
        ...partial,
        lastModified: new Date().toISOString(),
      };
      setProjectSafe(next);
      lightSnapshotRef.current = next;

      // 2) 落盘去抖：400ms 窗口内 N 次击键只落一次盘
      if (lightPersistTimerRef.current) clearTimeout(lightPersistTimerRef.current);
      lightPersistTimerRef.current = setTimeout(() => {
        lightPersistTimerRef.current = null;
        const snap = lightSnapshotRef.current;
        lightSnapshotRef.current = null;
        if (snap && projectRef.current?.id !== snap.id) {
          // 去抖窗口内切书：projectRef 已是新书，直接落盘旧书快照防丢编辑。
          // force：snap 是写回前的旧对象，rev 落后于库中值（本页写入所致），非他页冲突
          void (async () => {
            try {
              await saveProject(snap, { force: true });
              setProjectsList(await listProjects());
            } catch (err) {
              console.error('项目持久化失败:', err);
            }
          })();
        } else {
          void persistWriterRef.current?.schedule();
        }
      }, 400);
    },
    [projectRef, setProjectSafe, setProjectsList]
  );

  // 页面隐藏/关闭前：冲刷挂起的轻量写（与既有 flush 合并一处）
  useEffect(() => {
    const flush = () => {
      if (lightPersistTimerRef.current) {
        clearTimeout(lightPersistTimerRef.current);
        lightPersistTimerRef.current = null;
        // 去抖窗口内还有未落盘的编辑：timer 清掉后快照无人消费，必须在此兜底落盘
        // （此前只清 timer 不读 lightSnapshotRef，400ms 窗口内最后的击键必丢）
        const snap = lightSnapshotRef.current;
        lightSnapshotRef.current = null;
        if (snap) {
          if (projectRef.current?.id && projectRef.current.id !== snap.id) {
            // 窗口内已切书：直接落盘旧书快照（force 原因同上：snap rev 落后于本页写入）
            void saveProject(snap, { force: true }).catch((err) =>
              console.error('项目持久化失败:', err)
            );
          } else {
            // 写任务执行时读 projectRef 最新值（已含本次编辑）
            void persistWriterRef.current?.schedule();
          }
        }
      }
      void persistWriterRef.current?.flush();
      flushAutoBackup();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return { handleUpdateAndPersistProject, handleUpdateAndPersistProjectDebounced };
}
