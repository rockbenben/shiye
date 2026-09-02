import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **每一个能变成看板的去处，都必须给得出「切回列表」那颗开关。**
 *
 * 看板分支写在 `withFilterBar` 里：`groupable && listMode === 'board'` 一成立
 * 就渲染成看板。而 `listMode` 是**一个全局偏好**（`lib/listMode.ts`，整个应用
 * 一个 `localStorage` 值）——在任意一屏切成看板，走到别的 `groupable` 去处它
 * 也是看板。那一屏要是不在 `canToggleListMode` 里，**人就被关在看板模式里出不来**。
 *
 * 实测复现过（无头浏览器走完整条路）：在「全部」切看板 → 走到「未归类」→
 * 那一屏是看板，列表/看板开关和密度开关**都不在**。
 *
 * ## 为什么用扫源码，不用调函数
 *
 * `canToggleListMode` 和各处的 `groupable` 都写死在 `App.tsx` 的组件体里，
 * 拿不到导出。这条守卫扫的是**两份名单本身**，判据是「集合包含」——正解是把
 * 它变成 `views.tsx` 里 `ViewSpec` 的一个字段（那儿已经带着 `keepMounted`
 * 之类），只有一份正本，那时候这条守卫可以删掉。
 */
describe('看板模式的覆盖面', () => {
  const src = readFileSync('web/src/App.tsx', 'utf8');

  /** `withFilterBar` 的注册处形如 `    all: () => withFilterBar(`。 */
  const groupableViews = (): string[] => {
    const out: string[] = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s{4}([a-z]+): \(\) => withFilterBar\(/.exec(lines[i]);
      if (!m) continue;
      // 往下找这次调用的选项对象，最多 60 行。
      const tail = lines.slice(i, i + 60).join('\n');
      const end = tail.indexOf('withFilterBar(');
      const body = tail.slice(end, tail.indexOf('\n    },', end) + 1 || undefined);
      if (/groupable:\s*true/.test(body)) out.push(m[1]);
    }
    return out;
  };

  /** `canToggleListMode` 那行里显式列出的几个 key。 */
  const toggleable = (): string[] => {
    const m = /const canToggleListMode = \[([^\]]*)\]/.exec(src);
    if (!m) throw new Error('找不到 canToggleListMode 的名单——改写了就把这条守卫的锚点一起改');
    return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  };

  it('前提：两份名单都抠得出来，不是拿空集合在比', () => {
    expect(groupableViews().length, '一个 groupable 去处都没抠到').toBeGreaterThan(0);
    expect(toggleable().length).toBeGreaterThan(0);
  });

  it('每个 groupable 的去处都在 canToggleListMode 里——否则会被关在看板模式里', () => {
    const can = new Set(toggleable());
    for (const v of groupableViews()) {
      expect(can.has(v), `「${v}」能变成看板，却给不出切回列表的开关`).toBe(true);
    }
  });

  it('每个 groupable 的去处也得有密度开关——看板里同样要能换行/卡', () => {
    const m = /export const DENSITY_VIEWS = new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(m, '找不到 DENSITY_VIEWS').toBeTruthy();
    const density = new Set([...m![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]));
    for (const v of groupableViews()) {
      expect(density.has(v), `「${v}」能变成看板，却没有密度开关`).toBe(true);
    }
  });
});
