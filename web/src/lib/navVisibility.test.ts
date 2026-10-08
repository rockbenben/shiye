// @vitest-environment jsdom
// getNavModes/setNavModes 直接用同步的 localStorage——跟 density.test.ts /
// grouping.test.ts 同一个理由，用 pragma 把这份文件切到 jsdom。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { canAuto, ensureNavDefaults, getNavModes, hasContentOf, setNavModes, visibleViews, type NavModes } from './navVisibility.js';
import { findSpec, type ViewCountSource, type ViewDef } from './views.js';
import { task } from '../test-utils.js';
import type { TrashItem } from '../types.js';

const NOW = new Date(2026, 7, 22, 10);
const SRC = { tasks: [], inbox: [], now: NOW, insights: [], trash: [] };

/** 最小的 ViewDef：这个模块只看 key 和 count，`render` 只是类型要求。 */
const def = (key: string, count?: number): ViewDef => ({
  key, label: key, group: 'tasks', render: () => null, ...(count === undefined ? {} : { count: () => count }),
});

describe('visibleViews', () => {
  const defs = [def('today', 3), def('quadrant'), def('trash')];

  // **这一组测的是机制（hide / auto / 当前项永远留下），不是默认值**——默认
  // 档是什么由 `FRESH_NAV_MODES` 和「这台机器见没见过它」决定，另有一组在下面
  // 单独盯着。所以这里先落上那个记号，让 `visibleViews` 走「已经在用的人」那条
  // 路，`defs` 里的 trash 就是一条普通的、默认显示的入口。
  beforeEach(() => { localStorage.clear(); ensureNavDefaults(); });

  it('没设过就是全显示——**对已经在用的人**来说，默认档就是老的行为', () => {
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

/**
 * **收窄默认,只对全新机器生效。**
 *
 * 一屏十四项对一个刚装好的人是太多了——而收窄最容易做坏的一处是:「已完成」
 * 和「垃圾箱」都**故意不给数字**,那个判断只否掉了「显示数字」,没否掉「空不
 * 空」。于是按老的 `canAuto`(要求有 count)收窄,这两个永远空的入口会变成新的
 * 噪音源,正好把收窄的本意抵消掉。
 */
describe('导航收窄:「空不空」和「画不画数字」是两件事', () => {
  const src = (o: Partial<ViewCountSource> = {}): ViewCountSource =>
    ({ tasks: [], inbox: [], now: new Date(2026, 7, 20), insights: [], trash: [], ...o });

  it('**垃圾箱按 `trash` 判,不按 `tasks`**——删掉的任务不在 `tasks` 里,从它现算永远是 0，而「永远是 0」在这条路上等于「永远显示」', () => {
    const v = findSpec('trash')!;
    expect(v.hasContent?.(src())).toBe(false);
    expect(v.hasContent?.(src({ trash: [{ deletedAt: 'x' }] as TrashItem[] }))).toBe(true);
  });

  it('**已完成也是判空不判数字**——完成数只会一直涨，挂个数字是噪音，但空着就该藏', () => {
    const v = findSpec('done')!;
    expect(v.count).toBeUndefined();
    expect(v.hasContent?.(src())).toBe(false);
    expect(v.hasContent?.(src({ tasks: [task({ status: 'done' })] }))).toBe(true);
  });

  it('**给了 hasContent 就以它为准**，不再从 count > 0 倒推', () => {
    const v = { hasContent: () => false, count: () => 99 };
    expect(hasContentOf(v, src())).toBe(false);
  });

  it('只有 count 没 hasContent 的，退回 count > 0', () => {
    expect(hasContentOf({ count: () => 2 }, src())).toBe(true);
    expect(hasContentOf({ count: () => 0 }, src())).toBe(false);
  });

  it('**两样都没有的不能选 auto**——那是个点了没反应的选项', () => {
    expect(canAuto({})).toBe(false);
    expect(canAuto({ count: () => 0 })).toBe(true);
    expect(canAuto({ hasContent: () => false })).toBe(true);
  });
});

describe('导航收窄:全新机器 vs 已经在用的人', () => {
  const defs = [{ key: 'trash', count: undefined, hasContent: () => false }] as unknown as ViewDef[];
  const src: ViewCountSource = { tasks: [], inbox: [], now: new Date(2026, 7, 20), insights: [], trash: [] };

  beforeEach(() => localStorage.clear());

  it('**记号还没落 = 这台机器没见过新默认**，空的垃圾箱收掉', () => {
    expect(visibleViews(defs, {}, 'today', src).map((v) => v.key)).toEqual([]);
  });

  it('**落过记号之后按老默认来**——已经在用的人开机第一眼看到的东西不该因为我们改了默认值而变', () => {
    ensureNavDefaults();
    expect(localStorage.getItem('navDefaultsV1')).not.toBeNull();
    expect(visibleViews(defs, {}, 'today', src).map((v) => v.key)).toEqual(['trash']);
  });

  it('**他显式选过显示，就一直显示**——存了就不被默认值盖回去', () => {
    setNavModes({ trash: 'show' });
    ensureNavDefaults();
    expect(visibleViews(defs, getNavModes(), 'today', src).map((v) => v.key)).toEqual(['trash']);
  });

  it('**空模块一律不收**——日历/四象限/习惯这些空着也必须在，入口消失比空着更难找', () => {
    const modules = [{ key: 'calendar' }, { key: 'quadrant' }, { key: 'habits' }] as unknown as ViewDef[];
    expect(visibleViews(modules, {}, 'today', src).map((v) => v.key)).toEqual(['calendar', 'quadrant', 'habits']);
  });
});