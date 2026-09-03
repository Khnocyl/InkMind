export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'inkmind-theme-mode';
export const THEME_CHANGE_EVENT = 'inkmind-theme-change';

/** 读取持久化的主题偏好；缺省为 'system'（跟随系统） */
export function getStoredThemeMode(): ThemeMode {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return 'system';
  }
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') {
      return v;
    }
  } catch {
    /* ignore storage errors */
  }
  return 'system';
}

/** 存储用户选择的主题偏好 */
export function setStoredThemeMode(mode: ThemeMode): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* ignore storage errors */
  }
}

/** 读取当前操作系统是否处于深色模式 */
export function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** 根据当前设定或指定模式解析出最终生效的明暗模式 ('light' | 'dark') */
export function getResolvedTheme(mode?: ThemeMode): 'light' | 'dark' {
  const m = mode ?? getStoredThemeMode();
  if (m === 'dark') return 'dark';
  if (m === 'light') return 'light';
  return getSystemTheme();
}

/**
 * 将解析出的主题应用到 DOM 节点：
 * 1. 切换 html.classList 中的 'dark'；
 * 2. 同步 document.documentElement.style.colorScheme；
 * 3. 同步 <meta name="theme-color"> 保持桌面端窗口与移动端状态栏一致；
 * 4. 派发自定义变更事件通知所有订阅者。
 */
export function applyTheme(mode?: ThemeMode): 'light' | 'dark' {
  const currentMode = mode ?? getStoredThemeMode();
  const resolved = getResolvedTheme(currentMode);

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (resolved === 'dark') {
      root.classList.add('dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.style.colorScheme = 'light';
    }

    // 更新 meta theme-color
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', resolved === 'dark' ? '#121212' : '#ffffff');
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(THEME_CHANGE_EVENT, {
        detail: { mode: currentMode, resolved },
      })
    );
  }

  return resolved;
}

/**
 * 订阅系统主题变化与用户切换事件：
 * 当处于 'system' 模式且系统外观切换时，自动同步 DOM。
 */
export function subscribeThemeChange(
  callback?: (mode: ThemeMode, resolved: 'light' | 'dark') => void
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const mediaQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  const handleMediaChange = () => {
    const currentMode = getStoredThemeMode();
    if (currentMode === 'system') {
      const resolved = applyTheme('system');
      callback?.(currentMode, resolved);
    }
  };

  const handleCustomChange = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail) {
      callback?.(detail.mode, detail.resolved);
    } else {
      const mode = getStoredThemeMode();
      callback?.(mode, getResolvedTheme(mode));
    }
  };

  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY) {
      const mode = getStoredThemeMode();
      const resolved = applyTheme(mode);
      callback?.(mode, resolved);
    }
  };

  mediaQuery?.addEventListener('change', handleMediaChange);
  window.addEventListener(THEME_CHANGE_EVENT, handleCustomChange);
  window.addEventListener('storage', handleStorageChange);

  return () => {
    mediaQuery?.removeEventListener('change', handleMediaChange);
    window.removeEventListener(THEME_CHANGE_EVENT, handleCustomChange);
    window.removeEventListener('storage', handleStorageChange);
  };
}
