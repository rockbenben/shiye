// @vitest-environment jsdom
// getNavModes/setNavModes 直接用同步的 localStorage——跟 density.test.ts /
// grouping.test.ts 同一个理由，用 pragma 把这份文件切到 jsdom。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canAuto, getNavModes, setNavModes, visibleViews, type NavModes } from './navVisibility.js';
import type { ViewDef } from './views.js';

const NOW = new Date(2026, 7, 22, 10);
const SRC = { tasks: [], inbox: [], now: NOW, insights: [] };

/** 最小的 ViewDef：这个模块只看 key 和 count，`render` 只是类型要求。 */
const def = (key: string, count?: number): ViewDef => ({
  key, label: key, group: 'tasks', render: () => null, ...(count === undefined ? {} : { count: () => count }),
});

describe('visibleViews', () => {
  const defs = [def('today', 3), def('quadrant'), def('trash')];

  it('没设过就是全显示——默认档就是今天的行为', () => {
    expect(visibleViews(defs, {}, 'today', SRC).map((v) => v.key)).toEqual(['today', 'quadrant', 'trash']);
  });

  it("'hide' 的不出现", () => {
    expect(visibleViews(defs, { quadrant: 'hide' }, 'today', SRC).map((v) => v.key)).toEqual(['today', 'trash']);
  });

  it("'auto'：有数字才出现", () => {
    expect(visibleViews([def('today', 3)], { today: 'auto' }, 'x', SRC).map((v) => v.key)).toEqual(['today']);
    expect(visibleViews([def('today', 0)], { today: 'auto' }, 'x', SRC)).toEqual([]);
  });

  it("没有 count 的选了 'auto' 就一直不显示——所以设置里根本不给它这一档，见 canAuto", () => {
    expect(visibleViews([def('quadrant')], { quadrant: 'auto' }, 'x', SRC)).toEqual([]);
  });

  it('正在看的那一项永远留下，不管设成什么——藏掉会让导航上没有任何一项是当前项，看着像坏了', () => {
    expect(visibleViews(defs, { quadrant: 'hide' }, 'quadrant', SRC).map((v) => v.key))
      .toEqual(['today', 'quadrant', 'trash']);
  });

  it('认不出来的值当成显示，不当成隐藏——一个手改坏的存储不该让入口凭空消失', () => {
    expect(visibleViews(defs, { trash: '随便' as unknown as NavModes[string] }, 'today', SRC).map((v) => v.key))
      .toEqual(['today', 'quadrant', 'trash']);
  });
});

describe('canAuto', () => {
  it('有 count 才能选「有内容时显示」', () => {
    expect(canAuto(def('today', 3))).toBe(true);
    expect(canAuto(def('quadrant'))).toBe(false);
  });
});

describe('getNavModes / setNavModes', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('没存过就是空表（全显示）', () => {
    expect(getNavModes()).toEqual({});
  });

  it('存了读得回来', () => {
    setNavModes({ quadrant: 'hide', today: 'auto' });
    expect(getNavModes()).toEqual({ quadrant: 'hide', today: 'auto' });
  });

  it("'show' 不落盘——它是默认值，记下来只让这份表越长越大", () => {
    setNavModes({ quadrant: 'show', trash: 'hide' });
    expect(getNavModes()).toEqual({ trash: 'hide' });
  });

  it('坏 JSON、不认识的值都当没设过，不炸', () => {
    localStorage.setItem('navModes', '{不是 json');
    expect(getNavModes()).toEqual({});
    localStorage.setItem('navModes', JSON.stringify({ a: '藏起来', b: 'hide' }));
    expect(getNavModes()).toEqual({ b: 'hide' });
  });
});
