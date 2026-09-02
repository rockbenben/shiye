// @vitest-environment jsdom
// 按扩展名这个文件本该落进 'node' 档（裸 node 没有 localStorage），用这行
// pragma 切到 jsdom——跟 density.test.ts / keymap.test.ts 同一个理由：
// getGroupSort/setGroupSort 直接用同步的 localStorage。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_GROUP_SORT, GROUP_LABEL, cellPatch, getGroupSort, getKanbanAxis, isDefaultGroupSort, viewDefaultGroupSort,
  regroupSections, sectionNames, setGroupSort, setKanbanAxis,
  type GroupBy, type GroupSort,
} from './grouping.js';
import { agendaSections, DUE_BUCKETS } from './agenda.js';
import type { GridSection } from '../components/TaskGrid.js';
import type { List, Task } from '../types.js';

/** 本地墙钟：时间分组的边界（今天/明天/7 天内）按本地日历日算，跟 agenda.ts 同一套。 */
const local = (y: number, mo: number, d: number, h = 0) => new Date(y, mo - 1, d, h);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();
const NOW = local(2026, 8, 22, 10);

const task = (over: Partial<Task> = {}): Task => ({
  id: 't', title: '任务', notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: iso(2026, 8, 1), updatedAt: iso(2026, 8, 1),
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...over,
});

const LISTS: List[] = [
  { id: 'L1', name: '工作', color: '#000', folderId: null, order: 1, archived: false, filter: null },
  { id: 'L0', name: '生活', color: '#000', folderId: null, order: 0, archived: false, filter: null },
];

const one = (tasks: Task[]): GridSection[] => [{ key: 'src', title: '全部', tasks }];
const gs = (o: Partial<GroupSort> = {}): GroupSort => ({ ...DEFAULT_GROUP_SORT, ...o });
const ctx = { lists: LISTS, now: NOW };
const titles = (secs: GridSection[]) => secs.map((s) => s.title);
const ids = (secs: GridSection[]) => secs.map((s) => s.tasks.map((t) => t.id));

describe('regroupSections：默认档什么都不改', () => {
  it('不分组 + 默认顺序 = 原样返回，连对象都是同一个——默认档就是今天的行为', () => {
    const input = one([task({ id: 'a' }), task({ id: 'b' })]);
    expect(regroupSections(input, DEFAULT_GROUP_SORT, ctx)).toBe(input);
  });
});

describe('regroupSections：排序', () => {
  const a = task({ id: 'a', due: iso(2026, 8, 25), priority: 1, createdAt: iso(2026, 8, 3) });
  const b = task({ id: 'b', due: iso(2026, 8, 23), priority: 3, createdAt: iso(2026, 8, 1) });
  const c = task({ id: 'c', due: null, priority: 2, createdAt: iso(2026, 8, 2) });

  it('按截止时间：早的在前，没设时间的沉底', () => {
    expect(ids(regroupSections(one([a, b, c]), gs({ sortBy: 'due' }), ctx))).toEqual([['b', 'a', 'c']]);
  });

  it('倒序只翻转「有值的那些」——没设截止时间的仍然沉底，不会糊在最前面', () => {
    expect(ids(regroupSections(one([a, b, c]), gs({ sortBy: 'due', desc: true }), ctx))).toEqual([['a', 'b', 'c']]);
  });

  it('按优先级：高的在前', () => {
    expect(ids(regroupSections(one([a, b, c]), gs({ sortBy: 'priority' }), ctx))).toEqual([['b', 'c', 'a']]);
  });

  it('按创建时间：老的在前，倒序就是新的在前', () => {
    expect(ids(regroupSections(one([a, b, c]), gs({ sortBy: 'created' }), ctx))).toEqual([['b', 'c', 'a']]);
    expect(ids(regroupSections(one([a, b, c]), gs({ sortBy: 'created', desc: true }), ctx))).toEqual([['a', 'c', 'b']]);
  });

  /**
   * 「我现在只有二十分钟，能做点什么」。**升序 = 短的在前**，没估过的恒沉底
   * ——那一问的答案不该是一堆没人估过的任务，所以这一档跟「按截止时间」共用
   * `sortTasks` 里那三行 null 判断（倒序也不会把它们翻上来）。
   */
  it('按预计时长：短的在前，没估过的沉底', () => {
    const long = task({ id: 'long', estimateMinutes: 120 });
    const short = task({ id: 'short', estimateMinutes: 15 });
    const none = task({ id: 'none' });
    expect(ids(regroupSections(one([long, none, short]), gs({ sortBy: 'estimate' }), ctx)))
      .toEqual([['short', 'long', 'none']]);
  });

  it('倒序是「今天最大那块石头」——没估过的照样沉底，不糊在最前面', () => {
    const long = task({ id: 'long', estimateMinutes: 120 });
    const short = task({ id: 'short', estimateMinutes: 15 });
    const none = task({ id: 'none' });
    expect(ids(regroupSections(one([long, none, short]), gs({ sortBy: 'estimate', desc: true }), ctx)))
      .toEqual([['long', 'short', 'none']]);
  });

  it('手改坏的估计（字符串/负数/0）当成没估过，沉底，不炸', () => {
    const bad = task({ id: 'bad', estimateMinutes: '30' as unknown as number });
    const zero = task({ id: 'zero', estimateMinutes: 0 });
    const ok = task({ id: 'ok', estimateMinutes: 15 });
    expect(ids(regroupSections(one([bad, zero, ok]), gs({ sortBy: 'estimate' }), ctx)))
      .toEqual([['ok', 'bad', 'zero']]);
  });

  it('键相同的维持传进来的相对顺序——「都没设优先级」不该变成随机顺序', () => {
    const x = task({ id: 'x' });
    const y = task({ id: 'y' });
    const z = task({ id: 'z' });
    expect(ids(regroupSections(one([x, y, z]), gs({ sortBy: 'priority' }), ctx))).toEqual([['x', 'y', 'z']]);
  });

  it('时间字符串坏掉（手改文件写了「下周三」）当成没有值，沉底，不炸', () => {
    const bad = task({ id: 'bad', due: '下周三' });
    expect(ids(regroupSections(one([bad, b]), gs({ sortBy: 'due' }), ctx))).toEqual([['b', 'bad']]);
  });

  it('不分组时保留视图原来的分组，只在组内排——清单页那两组是这个视图的结构，不该被拍平', () => {
    const secs: GridSection[] = [
      { key: 'open', title: '未完成', tasks: [a, b] },
      { key: 'closed', title: '已完成', tasks: [c] },
    ];
    const out = regroupSections(secs, gs({ sortBy: 'due' }), ctx);
    expect(titles(out)).toEqual(['未完成', '已完成']);
    expect(ids(out)).toEqual([['b', 'a'], ['c']]);
  });
});

describe('regroupSections：分组', () => {
  it('按时间：跟「接下来」视图同一套边界、同一批名字', () => {
    const out = regroupSections(one([
      task({ id: 'over', due: iso(2026, 8, 20) }),
      task({ id: 'today', due: iso(2026, 8, 22, 18) }),
      task({ id: 'tmr', due: iso(2026, 8, 23, 9) }),
      task({ id: 'week', due: iso(2026, 8, 27) }),
      task({ id: 'later', due: iso(2026, 9, 30) }),
      task({ id: 'none' }),
    ]), gs({ groupBy: 'due' }), ctx);
    expect(titles(out)).toEqual(['已过期', '今天', '明天', '7 天内', '以后', '没有时间']);
  });

  it('按优先级：高中低无', () => {
    const out = regroupSections(one([
      task({ id: 'p0' }), task({ id: 'p3', priority: 3 }), task({ id: 'p1', priority: 1 }),
    ]), gs({ groupBy: 'priority' }), ctx);
    expect(titles(out)).toEqual(['高优先级', '低优先级', '没有优先级']);
    expect(ids(out)).toEqual([['p3'], ['p1'], ['p0']]);
  });

  it('优先级越界（手改文件写了 7）归进「没有优先级」，不另开一档', () => {
    const weird = task({ id: 'w', priority: 7 as unknown as Task['priority'] });
    const out = regroupSections(one([weird]), gs({ groupBy: 'priority' }), ctx);
    expect(titles(out)).toEqual(['没有优先级']);
  });

  it('按清单：跟侧栏一样按 List.order 排，「不属于任何清单」在最后', () => {
    const out = regroupSections(one([
      task({ id: 'a', listId: 'L1' }), task({ id: 'b', listId: 'L0' }), task({ id: 'c' }),
    ]), gs({ groupBy: 'list' }), ctx);
    expect(titles(out)).toEqual(['生活', '工作', '不属于任何清单']);
  });

  it('listId 指向一个已经不存在的清单，也归「不属于任何清单」', () => {
    const out = regroupSections(one([task({ id: 'gone', listId: '删掉了' })]), gs({ groupBy: 'list' }), ctx);
    expect(titles(out)).toEqual(['不属于任何清单']);
  });

  it('按标签：一条任务只进第一个标签的组，不复制到每个标签下', () => {
    const out = regroupSections(one([
      task({ id: 'a', tags: ['工作', '紧急'] }), task({ id: 'b', tags: ['紧急'] }), task({ id: 'c' }),
    ]), gs({ groupBy: 'tag' }), ctx);
    // 复制的话 a 会同时出现在「#工作」和「#紧急」下——批量选中算两遍、
    // 拖拽两个位置指同一条，React 的 key 也会撞。
    expect(ids(out).flat().filter((x) => x === 'a')).toHaveLength(1);
    expect(titles(out)).toEqual(['#工作', '#紧急', '没有标签']);
  });

  it('空组不返回', () => {
    const out = regroupSections(one([task({ id: 'a', priority: 3 })]), gs({ groupBy: 'priority' }), ctx);
    expect(titles(out)).toEqual(['高优先级']);
  });

  it('分组会把视图原来的分组拍平——分组轴换了，原来的组标题就不再成立', () => {
    const secs: GridSection[] = [
      { key: 'open', title: '未完成', tasks: [task({ id: 'a', priority: 3 })] },
      { key: 'closed', title: '已完成', tasks: [task({ id: 'b', priority: 3, status: 'done' })] },
    ];
    const out = regroupSections(secs, gs({ groupBy: 'priority' }), ctx);
    expect(titles(out)).toEqual(['高优先级']);
    expect(ids(out)).toEqual([['a', 'b']]);
  });

  it('分组 + 组内排序一起生效', () => {
    const out = regroupSections(one([
      task({ id: 'late', priority: 3, due: iso(2026, 8, 30) }),
      task({ id: 'soon', priority: 3, due: iso(2026, 8, 23) }),
    ]), gs({ groupBy: 'priority', sortBy: 'due' }), ctx);
    expect(ids(out)).toEqual([['soon', 'late']]);
  });

  it('组的 key 带前缀，不会跟视图自己的 section key 撞', () => {
    const out = regroupSections(one([task({ id: 'a' })]), gs({ groupBy: 'priority' }), ctx);
    expect(out[0].key.startsWith('g:')).toBe(true);
  });
});

describe('getGroupSort / setGroupSort', () => {
  // localStorage 在 jsdom 里跨用例会串——CLAUDE.md 明写的那条规矩，
  // 前后各清一次，不依赖用例执行顺序。
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('没存过就是默认档', () => {
    expect(getGroupSort('all')).toEqual(DEFAULT_GROUP_SORT);
  });

  it('存了就读得回来', () => {
    setGroupSort('all', { groupBy: 'list', sortBy: 'due', desc: true });
    expect(getGroupSort('all')).toEqual({ groupBy: 'list', sortBy: 'due', desc: true });
  });

  it('**一个去处一份**——在「工作」里改成按优先级，翻到「购物」不该跟着变', () => {
    setGroupSort('list:工作', { groupBy: 'none', sortBy: 'priority', desc: false });
    expect(getGroupSort('list:购物')).toEqual(DEFAULT_GROUP_SORT);
    expect(getGroupSort('list:工作').sortBy).toBe('priority');
  });

  it('几个去处各存各的，互不覆盖', () => {
    setGroupSort('all', { groupBy: 'list', sortBy: 'default', desc: false });
    setGroupSort('tag:紧急', { groupBy: 'none', sortBy: 'due', desc: true });
    expect(getGroupSort('all').groupBy).toBe('list');
    expect(getGroupSort('tag:紧急')).toEqual({ groupBy: 'none', sortBy: 'due', desc: true });
  });

  it('改回默认档就把那一条删掉——不然这张表会随着「点进过的清单」无限长大', () => {
    setGroupSort('list:工作', { groupBy: 'tag', sortBy: 'due', desc: true });
    setGroupSort('list:工作', DEFAULT_GROUP_SORT);
    expect(JSON.parse(localStorage.getItem('groupSort')!)).toEqual({});
    expect(getGroupSort('list:工作')).toEqual(DEFAULT_GROUP_SORT);
  });

  it('**旧版本存的那个全局裸值认得出来**，归到 all 名下——昨天设的东西今天不该没了', () => {
    localStorage.setItem('groupSort', JSON.stringify({ groupBy: 'priority', sortBy: 'due', desc: true }));
    expect(getGroupSort('all')).toEqual({ groupBy: 'priority', sortBy: 'due', desc: true });
    expect(getGroupSort('list:工作')).toEqual(DEFAULT_GROUP_SORT);
  });

  it('存的是坏 JSON、或者值不在枚举里，一律回默认档，不炸', () => {
    localStorage.setItem('groupSort', '{不是 json');
    expect(getGroupSort('all')).toEqual(DEFAULT_GROUP_SORT);
    localStorage.setItem('groupSort', JSON.stringify({ all: { groupBy: '按心情', sortBy: '随便', desc: '真' } }));
    expect(getGroupSort('all')).toEqual(DEFAULT_GROUP_SORT);
    localStorage.setItem('groupSort', JSON.stringify(['不是对象']));
    expect(getGroupSort('all')).toEqual(DEFAULT_GROUP_SORT);
  });

  it('isDefaultGroupSort 认得出改没改过', () => {
    expect(isDefaultGroupSort('all', DEFAULT_GROUP_SORT)).toBe(true);
    expect(isDefaultGroupSort('all', gs({ groupBy: 'tag' }))).toBe(false);
    expect(isDefaultGroupSort('all', gs({ desc: true }))).toBe(false);
  });

  /**
   * **「默认」按去处算。** 「已完成」的默认是按完成时间分组（`VIEW_DEFAULT`），
   * 拿全局默认去比它，会得出两个都错的结论：一进这一屏就判成「改过了」
   * （于是「恢复默认」白亮着），而全局默认那一档反倒被判成「没改过」。
   * 这一条就是那个缺陷的回归——原来的实现在这两句上都是反的。
   */
  it('「已完成」的默认是它自己那一档，不是全局那一档', () => {
    expect(isDefaultGroupSort('done', gs({ groupBy: 'completed' }))).toBe(true);
    expect(isDefaultGroupSort('done', DEFAULT_GROUP_SORT)).toBe(false);
    // 没有自己默认档的去处照旧走全局那一档。
    expect(isDefaultGroupSort('all', gs({ groupBy: 'completed' }))).toBe(false);
  });

  it('viewDefaultGroupSort 就是 getGroupSort 在「没设过」时给的那一档——两处不许分叉', () => {
    localStorage.removeItem('groupSort');
    for (const v of ['done', 'all', 'list:abc']) {
      expect(getGroupSort(v)).toEqual(viewDefaultGroupSort(v));
    }
  });
});

describe('按状态分组（看板默认的那根轴，列表视图里也能用）', () => {
  it('四列固定顺序：待办 / 进行中 / 已完成 / 搁置', () => {
    const out = regroupSections(one([
      task({ id: 'd', status: 'done' }), task({ id: 'l', status: 'later' }),
      task({ id: 't' }), task({ id: 'g', status: 'doing' }),
    ]), gs({ groupBy: 'status' }), ctx);
    expect(titles(out)).toEqual(['待办', '进行中', '已完成', '搁置']);
  });

  it('status 是脏值（手改文件写了「进行中」三个字）落待办列，不凭空吃掉', () => {
    const weird = task({ id: 'w', status: '进行中' as unknown as Task['status'] });
    const out = regroupSections(one([weird]), gs({ groupBy: 'status' }), ctx);
    expect(titles(out)).toEqual(['待办']);
  });
});

describe('keepEmpty：看板要能往空列里拖', () => {
  it('不给 keepEmpty 时空组被滤掉（平铺列表不要一排空标题）', () => {
    const out = regroupSections(one([task({ id: 'a', priority: 3 })]), gs({ groupBy: 'priority' }), ctx);
    expect(titles(out)).toEqual(['高优先级']);
  });

  it('给了 keepEmpty 时四档全在——一列没卡就把整列藏起来等于把落点也藏了', () => {
    const out = regroupSections(one([task({ id: 'a', priority: 3 })]), gs({ groupBy: 'priority' }), { ...ctx, keepEmpty: true });
    expect(titles(out)).toEqual(['高优先级', '中优先级', '低优先级', '没有优先级']);
  });
});

describe('cellPatch：拖进某一列该改哪个字段', () => {
  const t = task({ id: 'a', due: iso(2026, 8, 20, 18) });

  it('按状态：改 status', () => {
    expect(cellPatch('status', 'g:s:doing', t, NOW)).toEqual({ status: 'doing' });
  });

  it('按优先级：改 priority', () => {
    expect(cellPatch('priority', 'g:p3', t, NOW)).toEqual({ priority: 3 });
    expect(cellPatch('priority', 'g:p0', t, NOW)).toEqual({ priority: 0 });
  });

  it('按清单：改 listId，「不属于任何清单」那列写 null', () => {
    expect(cellPatch('list', 'g:l:L1', t, NOW)).toEqual({ listId: 'L1' });
    expect(cellPatch('list', 'g:l:none', t, NOW)).toEqual({ listId: null });
  });

  it('按标签：**加上去，不是换掉**——一条任务可以有好几个标签', () => {
    const tagged = task({ id: 'a', tags: ['紧急'] });
    expect(cellPatch('tag', 'g:t:工作', tagged, NOW)).toEqual({ tags: ['紧急', '工作'] });
  });

  it('已经有那个标签就不发空 PATCH', () => {
    expect(cellPatch('tag', 'g:t:工作', task({ id: 'a', tags: ['工作'] }), NOW)).toBeNull();
  });

  it('「没有标签」那列不接受落点——落进去要清掉全部标签，那是删数据', () => {
    expect(cellPatch('tag', 'g:t:none', t, NOW)).toBeNull();
  });

  it('按时间：今天/明天走跟卡片「改期」同一个纯函数，原来几点还是几点', () => {
    expect(cellPatch('due', 'g:today', t, NOW)).toMatchObject({ due: iso(2026, 8, 22, 18) });
    expect(cellPatch('due', 'g:tomorrow', t, NOW)).toMatchObject({ due: iso(2026, 8, 23, 18) });
  });

  it('「没有时间」那列清掉截止时间', () => {
    expect(cellPatch('due', 'g:none', t, NOW)).toEqual({ due: null });
  });

  it('「已过期」「7 天内」「以后」三列没有对应的值可写，返回 null——一个范围对不出一个具体日期', () => {
    expect(cellPatch('due', 'g:overdue', t, NOW)).toBeNull();
    expect(cellPatch('due', 'g:week', t, NOW)).toBeNull();
    expect(cellPatch('due', 'g:later', t, NOW)).toBeNull();
  });

  it('认不出来的 key 一律 null，不瞎猜', () => {
    expect(cellPatch('status', 'g:s:随便', t, NOW)).toBeNull();
    expect(cellPatch('priority', 'g:p9', t, NOW)).toBeNull();
    expect(cellPatch('none', 'g:whatever', t, NOW)).toBeNull();
  });
});

describe('getKanbanAxis / setKanbanAxis', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("没存过就是 'status'——原来写死的那四列，行为不变", () => {
    expect(getKanbanAxis()).toBe('status');
  });

  it('存了读得回来；不认识的值回默认', () => {
    setKanbanAxis('tag');
    expect(getKanbanAxis()).toBe('tag');
    localStorage.setItem('kanbanAxis', '按心情');
    expect(getKanbanAxis()).toBe('status');
  });

  it('跟 groupSort 分开存——在「全部」里选了按标签不该顺手把看板也换掉', () => {
    setGroupSort('all', { groupBy: 'tag', sortBy: 'due', desc: false });
    expect(getKanbanAxis()).toBe('status');
  });
});

/**
 * 按完成时间分组（仿滴答清单的已完成列表按日期分）。「按时间」那一档分的是
 * `due`——对一份做完的清单几乎没有意义：一件上周就该做、昨天才做完的事，
 * 按 due 会落进「已过期」，而你想知道的是「昨天做完的」。
 */
describe('regroupSections：按完成时间', () => {
  const NOW = new Date(2026, 7, 20, 12);
  const at = (d: number, h = 10) => new Date(2026, 7, d, h).toISOString();
  const gs = { groupBy: 'completed' as const, sortBy: 'default' as const, desc: false };
  const run = (tasks: Task[]) =>
    regroupSections([{ key: 'x', title: '', tasks }], gs, { lists: [], now: NOW })
      .map((s) => [s.title, s.tasks.map((t) => t.id)] as const);

  const done = (id: string, completedAt: string | null, over: Partial<Task> = {}) =>
    task({ id, status: 'done', completedAt, ...over });

  it('今天 / 昨天 / 7 天内 / 更早，按本地日历天分', () => {
    expect(run([
      done('今天的', at(20)),
      done('昨天的', at(19)),
      done('本周的', at(16)),
      done('很久的', at(1)),
    ])).toEqual([
      ['今天', ['今天的']],
      ['昨天', ['昨天的']],
      ['7 天内', ['本周的']],
      ['更早', ['很久的']],
    ]);
  });

  it('空组不出现——只做完一件事的那天不该看到四个空标题', () => {
    expect(run([done('a', at(20))]).map(([title]) => title)).toEqual(['今天']);
  });

  it('**还没了结的单独一组，不拿 updatedAt 顶上去充数**——那会让「按完成时间」这个标题说一件不成立的事', () => {
    expect(run([task({ id: '还开着', updatedAt: at(20) })])).toEqual([['还没完成', ['还开着']]]);
  });

  it('已放弃的按「最后一次动它」算——服务端不给放弃的盖完成章，那就是什么时候放弃的', () => {
    const gone = task({ id: '放弃了', status: 'abandoned', completedAt: null, updatedAt: at(19) });
    expect(run([gone])).toEqual([['昨天', ['放弃了']]]);
  });

  it('老数据没有 completedAt 的退到 updatedAt，不一股脑沉到「不知道什么时候」', () => {
    expect(run([done('老的', null, { updatedAt: at(20) })])).toEqual([['今天', ['老的']]]);
  });

  it('时间戳坏掉的落「不知道什么时候」，不崩也不装作是今天', () => {
    expect(run([done('坏的', '前天下午', { updatedAt: '不是时间' })]))
      .toEqual([['不知道什么时候', ['坏的']]]);
  });
});

describe('getGroupSort：每个去处自己的默认档', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('「已完成」默认就按完成时间分——那个去处是一条几百行的流水，一个要先发现才有用的默认对「墙」这个问题没有帮助', () => {
    expect(getGroupSort('done').groupBy).toBe('completed');
  });

  it('别的去处还是不分组，行为没变', () => {
    for (const v of ['all', 'search', 'list:L1', 'tag:工作']) {
      expect(getGroupSort(v), v).toEqual(DEFAULT_GROUP_SORT);
    }
  });

  it('**在「已完成」里手动选回「不分组」要记得住**——那跟它的默认不一样，不存的话下次进来又变回去，他刚明确改掉的那一下会被无视', () => {
    setGroupSort('done', DEFAULT_GROUP_SORT);
    expect(getGroupSort('done')).toEqual(DEFAULT_GROUP_SORT);
  });

  it('改回它自己的默认档时那条记录删掉——表不该随着点进过的去处无限长大', () => {
    setGroupSort('done', { groupBy: 'tag', sortBy: 'default', desc: false });
    setGroupSort('done', { groupBy: 'completed', sortBy: 'default', desc: false });
    expect(JSON.parse(localStorage.getItem('groupSort')!)).toEqual({});
  });
});


/**
 * **「按到期时间分组」跟「接下来」那一屏必须给出同一个答案。**
 *
 * 两边原来各写一份六档，只共享 `endOfDay`，靠 `dueBuckets` 头上一句注释（「同一套
 * 边界、同一批名字」）维持不变量——然后就真的飘了：「还没开始」那一组只加进了
 * `agendaSections`，于是同一条「9/1 才开始」的任务在两屏上归了不同的组。
 *
 * 现在两边都调 `dueBucketOf`，这条把「必须一致」从注释变成断言：同一批任务、
 * 同一个 `now`，每条落在同名的组里。
 */
describe('按到期时间分组 ≡ 「接下来」的分档', () => {
  const at = (d: number, h = 9) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + d, h).toISOString();
  /** 每一档至少一条，包括两个没有 due 的分支。 */
  const SPREAD = (): Task[] => [
    task({ id: 'overdue', due: at(-3) }),
    task({ id: 'today', due: at(0, 23) }),
    task({ id: 'tomorrow', due: at(1) }),
    task({ id: 'week', due: at(5) }),
    task({ id: 'later', due: at(40) }),
    task({ id: 'none', due: null }),
    task({ id: 'notStarted', due: null, startAt: at(9) }),
    // 解不出来的 due：两边都该当成「没有时间」，不是各自发明一种处理。
    task({ id: 'bad-due', due: '下周三' }),
  ];

  /** id → 组名。空组不算。 */
  const where = (secs: GridSection[]) => {
    const m: Record<string, string> = {};
    for (const s of secs) for (const t of s.tasks) m[t.id] = s.title;
    return m;
  };

  it('每一条在两边落的组名一模一样', () => {
    const rows = SPREAD();
    const viaGrouping = where(regroupSections(one(rows), gs({ groupBy: 'due' }), ctx));
    const viaAgenda = where(agendaSections(rows, NOW, new Set()));
    expect(viaGrouping).toEqual(viaAgenda);
    // 夹具真的铺满了七档——否则上面那句可能是两个小集合在相等。
    expect(new Set(Object.values(viaAgenda)).size).toBe(7);
  });

  it('档位的顺序和名字也是同一份（DUE_BUCKETS）', () => {
    // 两边都该按 `DUE_BUCKETS` 的顺序吐，而不是各排各的。
    expect(titles(agendaSections(SPREAD(), NOW, new Set()))).toEqual(DUE_BUCKETS.map((b) => b.title));
    expect(titles(regroupSections(one(SPREAD()), gs({ groupBy: 'due' }), ctx)))
      .toEqual(DUE_BUCKETS.map((b) => b.title));
  });
});

/**
 * **按创建时间分组**（仿滴答清单，它那边这一档标着「新增」）。
 *
 * 用途原文：「整理刚添加到 Inbox 的任务；回顾近期记录的想法和事项」。这个应用
 * 里那正是收件箱拆完之后的下一步——「哪几条是刚进来还没安排的」，按别的轴都
 * 答不上（按时间分的是 `due`，新任务多半没有；按状态全挤在「待办」）。
 */
describe('regroupSections：按创建时间', () => {
  const NOW_C = new Date(2026, 7, 26, 12);
  const ago = (days: number, h = 10) => new Date(2026, 7, 26 - days, h).toISOString();
  const t = (id: string, createdAt: string) => task({ id, createdAt, due: null, reminders: [] });

  const groupOf = (tasks: Task[]) =>
    regroupSections(one(tasks), gs({ groupBy: 'created' }), { now: NOW_C, lists: LISTS })
      .map((s) => [s.title, s.tasks.map((x) => x.id)] as const);

  it('今天 / 昨天 / 7 天内 / 更早，各落各的', () => {
    expect(groupOf([t('a', ago(0)), t('b', ago(1)), t('c', ago(5)), t('d', ago(60))])).toEqual([
      ['今天', ['a']], ['昨天', ['b']], ['7 天内', ['c']], ['更早', ['d']],
    ]);
  });

  it('创建时间解析不出来的落「不知道什么时候」，不凭空吃掉一条任务', () => {
    expect(groupOf([t('x', '上个月')])).toEqual([['不知道什么时候', ['x']]]);
  });

  /**
   * **跟「按完成时间」分得清。** 那一档对没完成的任务不成立，所以它有一组
   * 「还没完成」；创建时间对每条任务都成立，不该有那一组——多一组恒为空的
   * 桶只是噪音，而空组本来就不渲染，出现它就说明判据抄错了地方。
   */
  it('没有「还没完成」那一组——每条任务都有创建时间', () => {
    const titles = groupOf([t('a', ago(0)), t('b', ago(60))]).map(([title]) => title);
    expect(titles).not.toContain('还没完成');
  });

  it('已完成的照样按创建时间分，不被踢到别处', () => {
    const done = task({ id: 'z', createdAt: ago(0), status: 'done', due: null, reminders: [] });
    expect(groupOf([done])).toEqual([['今天', ['z']]]);
  });

  it('边界跟「按完成时间」一字不差：昨天 23:00 算昨天，今天 00:30 算今天', () => {
    expect(groupOf([t('y', ago(1, 23)), t('n', ago(0, 0))])).toEqual([
      ['今天', ['n']], ['昨天', ['y']],
    ]);
  });
});

/**
 * **按最后修改时间分组**——「这个项目最近动了什么」。
 *
 * 手上同时有几十份清单时，真正要问的不是「这条什么时候建的」，而是「这周哪几摊
 * 有进展、哪几摊一个月没碰」。在「全部」里选这一档是一条按天的更新流水，在某一份
 * 清单里选就是那个项目自己的。
 */
describe('regroupSections：按修改时间', () => {
  const NOW_U = new Date(2026, 7, 26, 12);
  const ago = (days: number, h = 10) => new Date(2026, 7, 26 - days, h).toISOString();
  // `createdAt` 固定在很久以前：这样「落进今天」只可能是 `updatedAt` 起的作用，
  // 抄错字段（去读 createdAt）的实现会当场红，而不是碰巧也过。
  const t = (id: string, updatedAt: string) =>
    task({ id, updatedAt, createdAt: ago(400), due: null, reminders: [] });

  const groupOf = (tasks: Task[]) =>
    regroupSections(one(tasks), gs({ groupBy: 'updated' }), { now: NOW_U, lists: LISTS })
      .map((s) => [s.title, s.tasks.map((x) => x.id)] as const);

  it('今天 / 昨天 / 7 天内 / 更早，各落各的', () => {
    expect(groupOf([t('a', ago(0)), t('b', ago(1)), t('c', ago(5)), t('d', ago(60))])).toEqual([
      ['今天', ['a']], ['昨天', ['b']], ['7 天内', ['c']], ['更早', ['d']],
    ]);
  });

  it('修改时间解析不出来的落「不知道什么时候」，不凭空吃掉一条任务', () => {
    expect(groupOf([t('x', '上个月')])).toEqual([['不知道什么时候', ['x']]]);
  });

  it('没有「还没完成」那一组——每条任务都有修改时间', () => {
    const titles = groupOf([t('a', ago(0)), t('b', ago(60))]).map(([title]) => title);
    expect(titles).not.toContain('还没完成');
  });

  it('已完成的照样按修改时间分，不被踢到别处——项目回溯要看的正是「做完了什么」', () => {
    const done = task({ id: 'z', updatedAt: ago(0), createdAt: ago(400), status: 'done', due: null, reminders: [] });
    expect(groupOf([done])).toEqual([['今天', ['z']]]);
  });

  it('边界跟另外两档一字不差：昨天 23:00 算昨天，今天 00:30 算今天', () => {
    expect(groupOf([t('y', ago(1, 23)), t('n', ago(0, 0))])).toEqual([
      ['今天', ['n']], ['昨天', ['y']],
    ]);
  });
});

/**
 * **每一个分组档都得真的接上自己的分桶函数。**
 *
 * 分派处是一条 if-else 链，**结尾兜底是 `tagBuckets`**——漏接一档不会报类型错，
 * 也不会抛异常，界面上只是静悄悄地按标签分组，标题却写着别的。加「按修改时间」
 * 那一次实测确认过：只加 `GROUP_LABEL` 一行、不接分派，`npm run typecheck` 全绿。
 *
 * 判据不写死名单，直接遍历 `GROUP_LABEL`：以后再加一档，忘了接线这条就红。
 */
describe('regroupSections：分组档没有一个是漏接的', () => {
  it('每个档分出来的组，都不等于「按标签」那一档的结果', () => {
    // 这批任务标签各不相同，所以「按标签」会切成三组三个不同的标题——
    // 任何一档漏接、掉进兜底，都会得出跟标签一模一样的分法。
    const sample = [
      task({ id: 'a', tags: ['甲'], listId: 'L1', section: '一期', priority: 3, due: iso(2026, 8, 23), status: 'done', completedAt: iso(2026, 8, 22), createdAt: iso(2026, 8, 1), updatedAt: iso(2026, 8, 22) }),
      task({ id: 'b', tags: ['乙'], listId: 'L0', section: '二期', priority: 1, due: iso(2026, 8, 30), createdAt: iso(2026, 8, 10), updatedAt: iso(2026, 8, 20) }),
      task({ id: 'c', tags: ['丙'], listId: null, section: null, priority: 0, createdAt: iso(2026, 8, 20), updatedAt: iso(2026, 8, 21) }),
    ];
    const byTag = titles(regroupSections(one(sample), gs({ groupBy: 'tag' }), ctx));
    const missed: string[] = [];
    for (const key of Object.keys(GROUP_LABEL) as GroupBy[]) {
      if (key === 'none' || key === 'tag') continue;
      const got = titles(regroupSections(one(sample), gs({ groupBy: key }), ctx));
      if (JSON.stringify(got) === JSON.stringify(byTag)) missed.push(key);
    }
    expect(missed, '这几档掉进了分派链结尾的 tagBuckets 兜底：' + missed.join('、')).toEqual([]);
  });
});

/**
 * **按分段分组**（`Task.section`，仿滴答清单的「分组」/ Things 的 Headings）。
 *
 * 这个应用里分段**没有实体**，是从任务上现算的段名——理由和代价写在
 * `types.ts` 的 `section` 上（照标签那条既有判断办的）。
 */
describe('regroupSections：按分段', () => {
  const s = (id: string, section: string | null) => task({ id, section, due: null, reminders: [] });
  const groupOf = (tasks: Task[]) =>
    regroupSections(one(tasks), gs({ groupBy: 'section' }), { now: NOW, lists: LISTS })
      .map((x) => [x.title, x.tasks.map((y) => y.id)] as const);

  /**
   * **顺序按第一次出现，不是字典序。** 段名多半带着次序（「准备」「收尾」），
   * 而中文字典序按拼音走，跟人心里的次序没有关系。
   *
   * **夹具是挑过的**：第一版用的是「第二阶段 / 第一阶段」，而
   * `'第二阶段'.localeCompare('第一阶段', 'zh')` 本来就是负的（拼音 èr < yī）
   * ——两种排法给同一个答案，把实现换成 `sort(localeCompare)` 这条照样绿。
   * 实测出来的。这里换成拼音序和出现序**真会分家**的一对：
   * 「准备」(zhǔnbèi) 在字典序里排「收尾」(shōuwěi) 后面，而它先出现。
   */
  it('按第一次出现排，不按字典序', () => {
    expect(groupOf([s('a', '准备'), s('b', '收尾'), s('c', '准备')])).toEqual([
      ['准备', ['a', 'c']],
      ['收尾', ['b']],
    ]);
  });

  it('不在任何分段的排最后，跟「按清单」「按标签」对「没有」那一档一字不差', () => {
    expect(groupOf([s('none', null), s('a', '甲')])).toEqual([
      ['甲', ['a']],
      ['不在任何分段', ['none']],
    ]);
  });

  it('空白段名当没有分段——不然会冒出一个没有标题的组', () => {
    expect(groupOf([s('a', '   ')])).toEqual([['不在任何分段', ['a']]]);
  });

  it('cellPatch：拖进某一段就是设成那一段', () => {
    expect(cellPatch('section', 'g:s:第一阶段', task({ id: 'x' }), NOW)).toEqual({ section: '第一阶段' });
  });

  /**
   * **拖进「不在任何分段」= 摘出来，不是空操作。** 这一条跟标签那边刻意相反
   * （那边落进「没有标签」返回 null，因为要清的是一整个数组、那是删数据）：
   * 分段只有一个值，摘出来是「不属于任何一段」这句话本身。
   */
  it('cellPatch：拖进「不在任何分段」写回 null', () => {
    expect(cellPatch('section', 'g:s:none', task({ id: 'x', section: '甲' }), NOW)).toEqual({ section: null });
  });
});

describe('sectionNames：编辑表单里那份候选', () => {
  const s = (id: string, section: string | null) => task({ id, section });

  it('去重、按第一次出现排——跟分组用的是同一个顺序', () => {
    expect(sectionNames([s('a', '乙'), s('b', '甲'), s('c', '乙')])).toEqual(['乙', '甲']);
  });

  it('没有分段的、空白的都不进候选', () => {
    expect(sectionNames([s('a', null), s('b', '  '), s('c', '甲')])).toEqual(['甲']);
  });

  /**
   * **不按清单过滤。** 段名只在它所属的那份清单里有意义，但这一份是**候选**
   * 不是约束——新建任务时清单可能还没选，而在别的清单用过的名字正是他最可能
   * 想复用的。给多了不选就是了；给少了他得重打一遍，**而打错一个字就是凭空
   * 多一段**——那是「存名字不建表」唯一真正的风险，这份候选是挡它的防线。
   */
  it('跨清单的段名都给——它是候选不是约束', () => {
    const a = task({ id: 'a', listId: 'L1', section: '甲' });
    const b = task({ id: 'b', listId: 'L2', section: '乙' });
    expect(sectionNames([a, b])).toEqual(['甲', '乙']);
  });
});
