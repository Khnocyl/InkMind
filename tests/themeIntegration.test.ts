import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getStoredThemeMode,
  setStoredThemeMode,
  getResolvedTheme,
  applyTheme,
  subscribeThemeChange,
  THEME_STORAGE_KEY,
} from '../src/services/theme';

describe('外观设置与主题状态机集成测试 (Phase 5)', () => {
  let store: Map<string, string>;
  let classList: Set<string>;
  let style: Record<string, string>;
  let mediaListeners: Set<() => void>;
  let windowListeners: Map<string, Set<(e: any) => void>>;
  let isSystemDark = false;

  beforeEach(() => {
    store = new Map();
    classList = new Set();
    style = {};
    mediaListeners = new Set();
    windowListeners = new Map();
    isSystemDark = false;

    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    };

    const doc = {
      documentElement: {
        classList: {
          add: (c: string) => classList.add(c),
          remove: (c: string) => classList.delete(c),
          contains: (c: string) => classList.has(c),
        },
        style,
      },
      querySelector: () => null,
    };

    const win = {
      matchMedia: (query: string) => ({
        matches: query.includes('dark') ? isSystemDark : !isSystemDark,
        addEventListener: (_type: string, fn: () => void) => {
          mediaListeners.add(fn);
        },
        removeEventListener: (_type: string, fn: () => void) => {
          mediaListeners.delete(fn);
        },
      }),
      addEventListener: (type: string, handler: (e: any) => void) => {
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type)!.add(handler);
      },
      removeEventListener: (type: string, handler: (e: any) => void) => {
        windowListeners.get(type)?.delete(handler);
      },
      dispatchEvent: (e: any) => {
        windowListeners.get(e.type)?.forEach((fn) => fn(e));
        return true;
      },
    };

    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    vi.stubGlobal('CustomEvent', class CustomEvent {
      type: string;
      detail: any;
      constructor(type: string, init?: any) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
  });

  it('1. 默认设置：跟随系统（浅色系统 → 浅色软件；深色系统 → 深色软件）', () => {
    expect(getStoredThemeMode()).toBe('system');

    // 系统为浅色
    isSystemDark = false;
    expect(getResolvedTheme('system')).toBe('light');
    expect(applyTheme('system')).toBe('light');
    expect(classList.has('dark')).toBe(false);

    // 系统切为深色
    isSystemDark = true;
    expect(getResolvedTheme('system')).toBe('dark');
    expect(applyTheme('system')).toBe('dark');
    expect(classList.has('dark')).toBe(true);
  });

  it('2. 浅色模式锁定：用户选浅色 → 系统改深色 → 软件仍保持浅色', () => {
    setStoredThemeMode('light');
    applyTheme('light');
    expect(classList.has('dark')).toBe(false);

    // 系统切换为深色
    isSystemDark = true;
    // 重新根据配置应用
    const resolved = applyTheme();
    expect(resolved).toBe('light');
    expect(classList.has('dark')).toBe(false);
  });

  it('3. 深色模式锁定：用户选深色 → 系统改浅色 → 软件仍保持深色', () => {
    setStoredThemeMode('dark');
    applyTheme('dark');
    expect(classList.has('dark')).toBe(true);

    // 系统切换为浅色
    isSystemDark = false;
    // 重新根据配置应用
    const resolved = applyTheme();
    expect(resolved).toBe('dark');
    expect(classList.has('dark')).toBe(true);
  });

  it('4. 跟随系统动态联动：系统主题改变 → 软件自动改变', () => {
    setStoredThemeMode('system');
    isSystemDark = false;
    applyTheme('system');
    expect(classList.has('dark')).toBe(false);

    const cleanup = subscribeThemeChange();

    // 模拟系统切为深色并触发 mediaQuery 监听
    isSystemDark = true;
    mediaListeners.forEach((fn) => fn());
    expect(classList.has('dark')).toBe(true);

    // 模拟系统切回浅色并触发 mediaQuery 监听
    isSystemDark = false;
    mediaListeners.forEach((fn) => fn());
    expect(classList.has('dark')).toBe(false);

    cleanup();
  });

  it('5. 页面重载与持久化恢复仿真', () => {
    // 模拟用户在设置页点击「深色」
    setStoredThemeMode('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    // 模拟应用完全重启（模拟开机初始化）
    const stored = getStoredThemeMode();
    expect(stored).toBe('dark');
    const resolved = applyTheme(stored);
    expect(resolved).toBe('dark');
    expect(classList.has('dark')).toBe(true);
  });
});
