import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NAV_GROUPS, VIEW_SPECS, buildRegistry, findSpec, RAIL_GROUPS, SIDEBAR_GROUPS, TASKS_MODULE_KEY, showsSidebar } from './views.js';
import { SKIP_IN_NAV } from '../components/Sidebar.js';
import type { Insight } from '../types.js';
import { openInsights } from '../components/ReviewView.js';
import type { Task, InboxItem } from '../types.js';
import { allSections } from './simpleViews.js';
import { isInTodayView } from './taskView.js';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: '写周报', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
  reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null,
  completedAt: null, postponeCount: 0, waitingFor: null, context: null,
  attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...p,
});
const note = (p: Partial<InboxItem> = {}): InboxItem =>
  ({ id: 'i1', text: '随手记', createdAt: '2026-08-01T00:00:00.000Z', processed: true, taskIds: [], ...p });

describe('视图注册表', () => {
  it('key 不重复——重复的话导航里两个入口指向同一处，切换看着像坏了', () => {
    const keys = VIEW_SPECS.map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每个视图都有非空的 label——导航上不能出现没有名字的入口', () => {
    for (const v of VIEW_SPECS) expect(v.label.trim()).not.toBe('');
  });

  it('findSpec 找得到已注册的，找不到没注册的', () => {
    expect(findSpec(VIEW_SPECS[0].key)?.key).toBe(VIEW_SPECS[0].key);
    expect(findSpec('压根没有这个视图')).toBeUndefined();
  });

  /**
   * 侧栏分段。原来这里钉的是「日历/看板/四象限 依次排在『接下来』和『全部』
   * 之间」（规格第 379 行定的那个平铺顺序）——**那条顺序连同它背后的「一个平
   * 列表」一起被换掉了**：十四项分成三段，日历那三个自己一段。
   */
  it('日历、四象限自成一段「换种看法」，依次相邻', () => {
    const keys = VIEW_SPECS.filter((s) => s.group === 'views').map((s) => s.key);
    expect(keys).toEqual(['calendar', 'quadrant']);
  });

  it('**「看板」不在注册表里**——它是清单的显示方式，不是去处（lib/listMode.ts）', () => {
    expect(VIEW_SPECS.map((s) => s.key)).not.toContain('kanban');
  });

  it('**竖栏那几段 + 侧栏那几段 = 全部段，不重不漏**——漏一段，那一段的去处在界面上哪儿都不出现', () => {
    expect([...RAIL_GROUPS, ...SIDEBAR_GROUPS].sort()).toEqual([...NAV_GROUPS].sort());
    for (const g of RAIL_GROUPS) expect(SIDEBAR_GROUPS, g).not.toContain(g);
  });

  it('**「任务」那个模块的哨兵值不能跟任何视图 key 撞车**——撞了的话点竖栏第一颗会跳去那个视图，而不是回到你上次的位置', () => {
    expect(VIEW_SPECS.map((v) => v.key)).not.toContain(TASKS_MODULE_KEY);
  });

  it('侧栏只给任务那一段和清单/标签——别的一律没有', () => {
    for (const spec of VIEW_SPECS) {
      expect(showsSidebar(spec.key), spec.key).toBe(spec.group === 'tasks');
    }
    expect(showsSidebar('list:L1')).toBe(true);
    expect(showsSidebar('tag:工作')).toBe(true);
    // 认不出的 key 也没有——不假装它是个任务去处。
    expect(showsSidebar('没这个去处')).toBe(false);
  });
  it('每一项都归了段，段名都认得——加一个新去处必须做这个决定', () => {
    for (const s of VIEW_SPECS) expect(NAV_GROUPS, s.key).toContain(s.group);
  });

  /**
   * **表的顺序必须按段连续**。数字键 `1`–`9` 和命令面板里的 hint 都是按
   * 「导航上第几个」算的，而屏幕上是一段一段渲染的——表里要是 `tasks` 中间
   * 夹了一个 `views`，那一项在屏幕上会跳到后面那段去，按 `3` 就跳错地方。
   */
  it('表的顺序按段连续——不然数字键跟屏幕上的顺序对不上', () => {
    const seen: string[] = [];
    for (const s of VIEW_SPECS) {
      if (seen[seen.length - 1] !== s.group) seen.push(s.group);
    }
    expect(seen).toEqual([...new Set(seen)]);
    // 而且段与段的先后跟 NAV_GROUPS 一致。
    expect(seen).toEqual(NAV_GROUPS.filter((g) => seen.includes(g)));
  });

  it('日历不 keepMounted——keepMounted 只给 inbox/today/source 三个，上限断言（下一条）已经钉着', () => {
    expect(VIEW_SPECS.find((v) => v.key === 'calendar')?.keepMounted).toBeUndefined();
  });

  it('keepMounted 只给这三个——多开一个是另一个方向的错，见 views.tsx 那段注释', () => {
    // 只断言这三个是 true 挡不住「第四个也悄悄开了」——views.tsx 的文档注释
    // 明写「只给真正有本地状态要保的视图开，不是默认开」，十几个视图全常驻
    // 是另一个方向的错，代价是 App.test.tsx 的耗时（实测给 upcoming 开
    // keepMounted 之后 +89%）。用整份列表的 toEqual 同时守住上限和下限。
    expect(VIEW_SPECS.filter((v) => v.keepMounted).map((v) => v.key)).toEqual(['inbox', 'today', 'source']);
  });

  it('「今天」的计数是当天该做的条数，不是全部任务数', () => {
    const today = findSpec('today')!;
    const inToday = task({ id: 'a', reminders: [{ at: NOW.toISOString(), firedAt: null }] });
    const later = task({ id: 'b', due: '2027-01-01T00:00:00.000Z' });
    expect(today.count?.({ tasks: [inToday, later], inbox: [], now: NOW, insights: [] })).toBe(1);
  });

  it('「收件箱」的计数是**还没拆的**条数，不是收件箱总条数', () => {
    const box = findSpec('inbox')!;
    const n = box.count?.({
      tasks: [],
      inbox: [note({ id: 'a', processed: false }), note({ id: 'b', processed: true })],
      now: NOW,
      insights: [],
    });
    expect(n).toBe(1);
  });

  it('inbox 是 keepMounted 的——它现在是可以切走的视图，草稿要保', () => {
    expect(VIEW_SPECS.find((v) => v.key === 'inbox')?.keepMounted).toBe(true);
  });

  it('buildRegistry 把 render 填进去，其它字段（含 keepMounted/count）原样带过', () => {
    // 三条分开断言（key 序列 / render 都是函数 / today 的 label）测不到
    // keepMounted、count 这两个可选字段有没有被漏掉——`{ ...s, render }` 改成
    // `{ key: s.key, label: s.label, render }` 照样能让那三条断言全绿，
    // 而丢了 keepMounted 就是「切走视图把正在编辑的草稿冲掉」那个真实回归
    // （见 views.tsx keepMounted 那段长注释）。一次性 toEqual 整个数组，
    // 少一个字段、多一个字段都逃不掉。
    const r = buildRegistry(Object.fromEntries(VIEW_SPECS.map((s) => [s.key, () => null])));
    expect(r).toEqual(VIEW_SPECS.map((s) => ({ ...s, render: expect.any(Function) })));
  });

  it('注册了却没给 render 就抛——导航上一个点了没反应的入口，宁可开发时炸出来', () => {
    // 传一份**只缺 today** 的部分注册表，不是空对象：全空的话任何「只查了第
    // 一项就抛」的实现（比如 `if (!render && i === 0) throw ...`）都能蒙混过关
    // ——VIEW_SPECS 第一项（现在是 search）空对象下必然没 render，这类
    // 实现全靠巧合通过，测不出它有没有真的挨个检查每一项。只留 today 空缺，
    // 才能确认是「specs 里任何一个缺 render 都会被发现」，而不是只查了第一个。
    const partial = Object.fromEntries(
      VIEW_SPECS.filter((s) => s.key !== 'today').map((s) => [s.key, () => null]),
    );
    expect(() => buildRegistry(partial)).toThrow(/today/);
  });
});

/**
 * **导航上那个数字必须等于点进去看得到的条数。** 这条守的是一类很好犯、
 * 又很难自己发现的错：徽标和视图各自写一遍「哪些算数」，其中一处漏了个状态
 * ——徽标写着 12、点进去只有 10，而这个应用最怕的就是界面说的跟实际不符。
 *
 * 实际犯过的那次：「全部」的徽标是 `status !== 'done'`，而 `allSections`
 * 排除的是「做完 + 放弃」两种（`abandoned` 是后加的状态，徽标没跟上）。
 */
describe('导航徽标跟视图数得一样', () => {
  // 用这个文件自己的 `task` 夹具和 `NOW`，不另起一套。
  const rows: Task[] = [
    task({ id: 'a', status: 'todo', due: NOW.toISOString() }),
    task({ id: 'b', status: 'doing' }),
    task({ id: 'c', status: 'later' }),
    task({ id: 'd', status: 'done', completedAt: NOW.toISOString() }),
    task({ id: 'e', status: 'abandoned' }),
  ];

  const countOf = (key: string) => {
    const spec = VIEW_SPECS.find((v) => v.key === key)!;
    return spec.count?.({ tasks: rows, inbox: [], now: NOW, insights: [] });
  };

  it('「全部」：徽标 = allSections 真的列出来的条数', () => {
    const shown = allSections(rows, NOW, new Set()).reduce((n, s) => n + s.tasks.length, 0);
    expect(countOf('all')).toBe(shown);
    // 反向钉一下这个夹具真的能抓到那个错：五条里有一条 done、一条 abandoned，
    // 老写法（只排除 done）会数出 4。
    expect(shown).toBe(3);
  });

  it('「今天」：徽标 = isInTodayView 认下来的条数（视图用的是同一个函数）', () => {
    expect(countOf('today')).toBe(rows.filter((x) => isInTodayView(x, NOW)).length);
  });
});

/**
 * 「回顾」的计数。原来这个视图**故意不给数字**，理由写在 `views.tsx` 里：
 * `ViewCountSource` 拿不到 insights，「加进那个类型会让所有现有 count 的签名
 * 跟着动」。实际改起来一个签名都不用动——`count` 收的是整个 source 对象。
 */
describe('「回顾」的计数', () => {
  const insight = (over: Partial<Insight> = {}): Insight => ({
    id: 'i1', kind: 'stuck', taskIds: ['t1'], text: '卡住了', createdAt: '2026-08-01T00:00:00.000Z',
    dismissedAt: null, ...over,
  });
  const n = (insights: Insight[]) =>
    findSpec('review')!.count?.({ tasks: [], inbox: [], now: NOW, insights });

  it('数的是还没点过「知道了」的——那才是待办', () => {
    expect(n([insight({ id: 'a' }), insight({ id: 'b', dismissedAt: '2026-08-02T00:00:00.000Z' })])).toBe(1);
  });

  it('一条都没有就是 0（导航自己不画 0）', () => {
    expect(n([])).toBe(0);
  });

  it('**判据跟 ReviewView 共用同一个 openInsights**，不在视图表里另写一遍 filter', () => {
    const all = [insight({ id: 'a' }), insight({ id: 'b', dismissedAt: '2026-08-02T00:00:00.000Z' })];
    expect(n(all)).toBe(openInsights(all).length);
  });
});

/**
 * **数字键 1–9 那份名单，README 和 `App.tsx` 的注释各抄了一份。**
 *
 * 正本是 `VIEW_SPECS` 去掉 `SKIP_IN_NAV`（也就是 `App.tsx` 的 `NAV_VIEW_SPECS`）
 * 的前九项。抄的那两份都飘过：往表里插一项「未归类」之后没人重算序号，于是
 * README 漏了它、还留着早就不是去处的「看板」，`App.tsx` 那两条注释把「垃圾箱」
 * 说成数字键够不到的（它是第 8）。
 *
 * 这条从 `VIEW_SPECS` **现算**，不手抄第三份：往表里插一项、或者改一个 label，
 * README 没跟上就会红。
 */
describe('数字键 1–9 的那九个去处', () => {
  const first9 = VIEW_SPECS.filter((v) => !SKIP_IN_NAV.has(v.key)).slice(0, 9);

  it('README 抄的那份跟 VIEW_SPECS 算出来的一字不差、顺序也一样', () => {
    const md = readFileSync('README.md', 'utf8').replace(/\s+/g, '');
    const want = first9.map((v) => v.label).join('/');
    expect(
      md,
      `README 里那份「1–9 切到哪九个」的名单跟 VIEW_SPECS 对不上了。正本算出来是：${want}`,
    ).toContain(want);
  });

  it('抠到的确实是九个、而且第一个是收件箱——不是拿空表在比', () => {
    expect(first9).toHaveLength(9);
    expect(first9[0].key).toBe('inbox');
  });
});
