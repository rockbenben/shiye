import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { NARROW_QUERY, useIsNarrow } from './narrow.js';

/** 装一个能手动触发 change 的假 matchMedia，返回「翻转 matches」的开关。 */
function stubMedia(initial: boolean) {
  let matches = initial;
  const handlers = new Set<() => void>();
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    get matches() { return matches; },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, cb: () => void) => { handlers.add(cb); },
    removeEventListener: (_: string, cb: () => void) => { handlers.delete(cb); },
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    flip(next: boolean) { matches = next; for (const h of handlers) h(); },
    restore() { window.matchMedia = real; },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('useIsNarrow', () => {
  it('断点跟 theme.css 里那批 @media 是同一个数——三处对不上就会出现「CSS 已经躺平了而 JS 还以为是宽屏」的半吊子布局', () => {
    expect(NARROW_QUERY).toBe('(max-width: 767px)');
  });

  it('读的是 matchMedia 当前的值', () => {
    const m = stubMedia(true);
    try {
      const { result } = renderHook(() => useIsNarrow());
      expect(result.current).toBe(true);
    } finally { m.restore(); }
  });

  it('窗口跨过断点会跟着变——不是只在挂载时读一次', () => {
    const m = stubMedia(false);
    try {
      const { result } = renderHook(() => useIsNarrow());
      expect(result.current).toBe(false);
      act(() => { m.flip(true); });
      expect(result.current).toBe(true);
    } finally { m.restore(); }
  });

  it('**首帧就是对的值，不先渲染一个错的再纠正**——用 useState + useEffect 的话手机上那一下是「侧栏闪一下再消失」', () => {
    const m = stubMedia(true);
    try {
      const seen: boolean[] = [];
      renderHook(() => { seen.push(useIsNarrow()); });
      expect(seen[0]).toBe(true);
    } finally { m.restore(); }
  });
});

/**
 * 这一条不测 hook，测的是**它引出的那个约定**：随手记那个框在宽屏和窄屏
 * 待在两个不同的容器里（侧栏底下 / 任务列表下面），所以任何「去找那个框」
 * 的代码都必须认组件自己的根 class，不能认装它的位置。
 *
 * `App.tsx` 的 `focusQuickCapture`（`N` 键和命令面板里的「随手记」）曾经写的
 * 是 `.ink-nav-composer textarea`——那是**侧栏里**那层容器，窄屏下当场找不到
 * 东西，两个入口在手机上都变成按了没反应。
 */
describe('随手记那个框：选择器认组件自己的根', () => {
  it('App.tsx 里不再按 .ink-nav-composer 去找它', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('web/src/App.tsx', 'utf8');
    expect(src).not.toMatch(/querySelector<[^>]*>\('\.ink-nav-composer/);
    expect(src).toMatch(/querySelector<HTMLTextAreaElement>\('\.ink-composer textarea'\)/);
  });
});
