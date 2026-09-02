// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { decodeTaskMenu, taskMenuItems, type MenuItem } from './taskMenu.js';
import { task } from '../test-utils.js';
import { CONTEXTS } from './taskView.js';
import type { List, Repeat } from '../types.js';

// 跳过本次和改期都按本地墙钟算日历——钉死时区，断言才不跟着宿主机飘。
beforeEach(() => { vi.stubEnv('TZ', 'Asia/Shanghai'); });
afterEach(() => { vi.unstubAllEnvs(); });

const NOW = () => new Date(2026, 7, 12, 12);
const LISTS: List[] = [
  { id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
];
const DAILY: Repeat = { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null };

const keysOf = (items: MenuItem[]): string[] =>
  items.flatMap((i) => ('children' in i ? i.children.map((c) => c.key) : 'key' in i ? [i.key] : []));

describe('taskMenuItems', () => {
  const items = (over = {}, opts = {}) =>
    taskMenuItems(task({ id: 't1', ...over }), { lists: [], now: NOW(), ...opts });

  it('编辑 / 置顶 / 改期 / 优先级 / 删除，最少这几样总是在', () => {
    const ks = keysOf(items());
    for (const k of ['edit', 'pin', 'due:today', 'pri:3', 'delete']) expect(ks, k).toContain(k);
  });

  it('置顶一个开关两种文案，不摆两项', () => {
    const label = (over: object) => (items(over).find((i) => 'key' in i && i.key === 'pin') as { label: string }).label;
    expect(label({})).toBe('置顶');
    expect(label({ pinned: true })).toBe('取消置顶');
  });

  it('不给 canDuplicate 就没有「创建副本」——它要发请求，调用方没接就不该摆', () => {
    expect(keysOf(items())).not.toContain('duplicate');
    expect(keysOf(items({}, { canDuplicate: true }))).toContain('duplicate');
  });

  // **还要调用方开了 `canSkip`**：处理不了 `kind:'skip'` 的调用方（`TaskRow`）
  // 摆出这一项会掉进删除确认框，见文件末尾那一组。
  it('不重复的任务没有「跳过本次」；能跳、而且调用方接得住的才有', () => {
    expect(keysOf(items())).not.toContain('skip');
    const 能跳 = { due: new Date(2026, 7, 12, 9).toISOString(), repeat: DAILY };
    expect(keysOf(items(能跳, { canSkip: true }))).toContain('skip');
  });

  it('没有任何时间的任务没有「推迟」——点了什么都不会发生', () => {
    expect(keysOf(items())).not.toContain('postpone');
    expect(keysOf(items({ due: new Date(2026, 7, 12, 9).toISOString() }))).toContain('postpone');
  });

  it('一个清单都没有时整组「移动到」不出现', () => {
    expect(keysOf(items())).not.toContain('list:');
    expect(keysOf(items({}, { lists: LISTS }))).toContain('list:L1');
  });

  it('**当前那一档/那个清单禁用着，不是藏起来**——藏了看不出「少的那项正是它现在的位置」', () => {
    const pri = items({ priority: 2 }).find((i) => 'children' in i && i.label === '优先级') as { children: MenuItem[] };
    expect(pri.children.find((c) => 'key' in c && c.key === 'pri:2')).toMatchObject({ disabled: true });
  });

  /**
   * 情境这一组**永远在**，不像「移动到」「打标签」那样看数据——五档是内置的
   * 常量，不是他建出来的东西。
   *
   * 顺带钉住那个先后：编辑表单、筛选栏、批量操作条上情境都紧跟在优先级后面，
   * 这里是第四处。三处一致而第四处不一致，等于在每一处都要重新找一遍。
   */
  it('情境那一组永远在，五档加一个「不分情境」，紧跟在优先级后面', () => {
    const its = items();
    const at = (label: string) => its.findIndex((i) => 'children' in i && i.label === label);
    expect(at('情境'), '菜单里没有「情境」这一组').toBeGreaterThan(-1);
    expect(at('情境')).toBe(at('优先级') + 1);
    const ctx = its[at('情境')] as { children: MenuItem[] };
    expect(ctx.children.length).toBe(CONTEXTS.length + 1);
    expect(ctx.children.at(-1)).toMatchObject({ key: 'ctx:', label: '不分情境' });
  });

  it('当前那个情境禁用着——单值字段，跟「优先级」「移动到」同一条，不跟「打标签」那条', () => {
    const group = (over: object) => (items(over).find((i) => 'children' in i && i.label === '情境') as { children: MenuItem[] }).children;
    // 没分情境时，禁用的是「不分情境」那一项。
    expect(group({}).find((c) => 'key' in c && c.key === 'ctx:')).toMatchObject({ disabled: true });
    expect(group({ context: 'out' }).find((c) => 'key' in c && c.key === 'ctx:out')).toMatchObject({ disabled: true });
    expect(group({ context: 'out' }).find((c) => 'key' in c && c.key === 'ctx:')).toMatchObject({ disabled: false });
  });

  it('一个标签都还没有时整组「打标签」不出现——那组会是个空壳', () => {
    expect(keysOf(items())).not.toContain('tag:工作');
    expect(keysOf(items({}, { tags: ['工作'] }))).toContain('tag:工作');
  });

  it('**已经打上的不禁用**——标签是多值，点当前那一个的意思是「摘掉它」，不是没意义的一下', () => {
    const grp = items({ tags: ['工作'] }, { tags: ['工作', '家里'] })
      .find((i) => 'children' in i && i.label === '打标签') as { children: MenuItem[] };
    expect(grp.children).toEqual([
      { key: 'tag:工作', label: '✓ 工作' },
      { key: 'tag:家里', label: '家里' },
    ]);
  });
});

describe('decodeTaskMenu', () => {
  const t = task({ id: 't1', due: new Date(2026, 7, 11, 18).toISOString() });

  it('三个非 patch 的动作各自报出来，让组件自己接', () => {
    for (const [key, kind] of [['edit', 'edit'], ['duplicate', 'duplicate'], ['delete', 'delete']]) {
      expect(decodeTaskMenu(key, t, NOW())).toEqual({ kind });
    }
  });

  it('置顶取反', () => {
    expect(decodeTaskMenu('pin', t, NOW())).toEqual({ kind: 'patch', patch: { pinned: true } });
  });

  it('改期保留原来的钟点', () => {
    const a = decodeTaskMenu('due:tomorrow', t, NOW());
    expect(a).toMatchObject({ kind: 'patch' });
    expect((a as { patch: { due: string } }).patch.due).toBe(new Date(2026, 7, 13, 18).toISOString());
  });

  it('「不属于任何清单」是 null，不是空字符串', () => {
    expect(decodeTaskMenu('list:', t, NOW())).toEqual({ kind: 'patch', patch: { listId: null } });
    expect(decodeTaskMenu('list:L1', t, NOW())).toEqual({ kind: 'patch', patch: { listId: 'L1' } });
  });

  it('优先级发数字，「无」是 0 不是 null', () => {
    expect(decodeTaskMenu('pri:0', t, NOW())).toEqual({ kind: 'patch', patch: { priority: 0 } });
  });

  it('**跳不动 / 推不动时返回 null**——菜单里本来就不该有它，真点到了也不发空写', () => {
    expect(decodeTaskMenu('skip', task({ id: 'x' }), NOW())).toBeNull();
    expect(decodeTaskMenu('postpone', task({ id: 'x' }), NOW())).toBeNull();
  });

  it('点没打过的标签是加上，点已经有的是摘掉——同一个入口两个方向', () => {
    const plain = task({ id: 't1', tags: [] });
    expect(decodeTaskMenu('tag:工作', plain, NOW())).toEqual({ kind: 'patch', patch: { tags: ['工作'] } });
    const tagged = task({ id: 't1', tags: ['工作', '家里'] });
    expect(decodeTaskMenu('tag:工作', tagged, NOW())).toEqual({ kind: 'patch', patch: { tags: ['家里'] } });
  });

  it('标签名里带冒号也认得全——按前缀长度切，不是按第一个冒号切', () => {
    const plain = task({ id: 't1', tags: [] });
    expect(decodeTaskMenu('tag:项目:035', plain, NOW())).toEqual({ kind: 'patch', patch: { tags: ['项目:035'] } });
  });

  it('分情境发字段名；「不分情境」是 null，不是空字符串——跟「不属于任何清单」同一个约定', () => {
    expect(decodeTaskMenu('ctx:out', t, NOW())).toEqual({ kind: 'patch', patch: { context: 'out' } });
    expect(decodeTaskMenu('ctx:', task({ id: 't1', context: 'out' }), NOW())).toEqual({ kind: 'patch', patch: { context: null } });
  });

  it('不认识的 key 返回 null，不猜', () => {
    expect(decodeTaskMenu('什么', t, NOW())).toBeNull();
  });
});

/**
 * **「跳过本次」只在调用方处理得了它的时候才摆出来。**
 *
 * `TaskRow`（紧凑行）的菜单 handler 只认 edit/patch/duplicate，其余原来**一律**
 * 掉进删除确认框——于是「行」密度下点「跳过本次」，弹出来的是「删除…？」，
 * 确认一下任务就进了垃圾箱。实测复现过：菜单里真有这一项，`decodeTaskMenu`
 * 真的返回 `{kind:"skip"}`，而那个组件连 `onSkip` 都没有。
 *
 * 默认关掉而不是「谁都摆」：漏接的后果是**丢数据**，漏开的后果只是少一项。
 */
describe('taskMenuItems：跳过本次要看调用方接不接得住', () => {
  const 每周 = () => task({
    id: 'r1', title: '每周例会', due: new Date(2026, 8, 4, 9).toISOString(),
    repeat: { every: 'week', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
  });
  const labels = (opts: Parameters<typeof taskMenuItems>[1]) =>
    JSON.stringify(taskMenuItems(每周(), opts));

  it('不给 canSkip：不摆——摆了会掉进删除确认框', () => {
    expect(labels({ lists: [], now: new Date(2026, 8, 3, 9), tags: [] })).not.toContain('跳过本次');
  });

  it('canSkip: true：照常摆', () => {
    expect(labels({ lists: [], now: new Date(2026, 8, 3, 9), tags: [], canSkip: true })).toContain('跳过本次');
  });

  // 摆出来的时候，解码要真的给出 skip 这个 kind——不然上面那条就成了
  // 「挡住一个本来也不存在的东西」，是句废话。
  it('前提：这个形状确实解码得出 kind: skip', () => {
    expect(decodeTaskMenu('skip', 每周(), new Date(2026, 8, 3, 9))).toMatchObject({ kind: 'skip' });
  });
});
