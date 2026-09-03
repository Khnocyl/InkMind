import { useEffect, useState } from 'react';
import {
  type ThemeMode,
  getStoredThemeMode,
  setStoredThemeMode,
  getResolvedTheme,
  applyTheme,
  subscribeThemeChange,
} from '../services/theme';

export interface UseThemeResult {
  mode: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setThemeMode: (mode: ThemeMode) => void;
}

export function useTheme(): UseThemeResult {
  const [mode, setModeState] = useState<ThemeMode>(() => getStoredThemeMode());
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    getResolvedTheme(getStoredThemeMode())
  );

  useEffect(() => {
    // 挂载时立即应用一次，保证与存储一致
    const currentMode = getStoredThemeMode();
    const resolved = applyTheme(currentMode);
    setModeState(currentMode);
    setResolvedTheme(resolved);

    // 订阅后续变更（系统主题切换、其它标签页或其它组件修改）
    const unsubscribe = subscribeThemeChange((newMode, newResolved) => {
      setModeState(newMode);
      setResolvedTheme(newResolved);
    });

    return unsubscribe;
  }, []);

  const setThemeMode = (newMode: ThemeMode) => {
    setStoredThemeMode(newMode);
    const resolved = applyTheme(newMode);
    setModeState(newMode);
    setResolvedTheme(resolved);
  };

  return {
    mode,
    resolvedTheme,
    setThemeMode,
  };
}
