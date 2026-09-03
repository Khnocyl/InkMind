import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getStoredThemeMode,
  setStoredThemeMode,
  getResolvedTheme,
  applyTheme,
  subscribeThemeChange,
  THEME_STORAGE_KEY,
} from '../src/services/theme';

describe('theme service', () => {
  let store: Map<string, string>;
  let classList: Set<string>;
  let style: Record<string, string>;
  let listeners: Map<string, Set<(e: any) => void>>;

  beforeEach(() => {
    store = new Map();
    classList = new Set();
    style = {};
    listeners = new Map();

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
        matches: query.includes('dark'),
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      addEventListener: (type: string, handler: (e: any) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(handler);
      },
      removeEventListener: (type: string, handler: (e: any) => void) => {
        listeners.get(type)?.delete(handler);
      },
      dispatchEvent: (e: any) => {
        listeners.get(e.type)?.forEach((fn) => fn(e));
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

  it('默认为 system 模式', () => {
    expect(getStoredThemeMode()).toBe('system');
  });

  it('支持持久化读写 light 与 dark', () => {
    setStoredThemeMode('dark');
    expect(getStoredThemeMode()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    setStoredThemeMode('light');
    expect(getStoredThemeMode()).toBe('light');

    setStoredThemeMode('system');
    expect(getStoredThemeMode()).toBe('system');
  });

  it('显式 light/dark 模式解析稳定', () => {
    expect(getResolvedTheme('light')).toBe('light');
    expect(getResolvedTheme('dark')).toBe('dark');
  });

  it('applyTheme 能正确切换 DOM 类名与样式', () => {
    const res1 = applyTheme('dark');
    expect(res1).toBe('dark');
    expect(classList.has('dark')).toBe(true);
    expect(style.colorScheme).toBe('dark');

    const res2 = applyTheme('light');
    expect(res2).toBe('light');
    expect(classList.has('dark')).toBe(false);
    expect(style.colorScheme).toBe('light');
  });

  it('派发与订阅主题变更事件', () => {
    const spy = vi.fn();
    const cleanup = subscribeThemeChange(spy);

    applyTheme('dark');
    expect(spy).toHaveBeenCalledWith('dark', 'dark');

    cleanup();
  });
});
