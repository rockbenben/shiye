import { describe, expect, it } from 'vitest';
import { applyFilter, emptyFilter, isFilterEmpty } from './smartFilter.js';
import { task } from '../test-utils.js';
import type { SmartFilter, Status } from '../types.js';
import { FILTER_KEYS } from '../../../server/src/list.js';

const NOW = new Date(2026, 7, 17, 12, 0, 0);
const F = (over: Partial<SmartFilter> = {}): SmartFilter => ({ ...emptyFilter(), ...over });

/** 这几条新用例里的简写：`t('a', {…})` 造一条 id 为 a 的任务，`ids(...)` 取 id 列表。 */
const t = (id: string, over: Partial<import('../types.js').Task> = {}) => task({ id, ...over });
const ids = (ts: Array<{ id: string }>) => ts.map((x) => x.id);

describe('空筛选 = 什么都不筛（不是什么都不匹配）', () => {
  it('emptyFilter 放行全部', () => {
    const ts = [task({ id: 'a' }), task({ id: 'b', status: 'done' })];
    expect(applyFilter(ts, emptyFilter(), NOW).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['status', { status: [] as Status[] }],
    ['listIds', { listIds: [] }],
    ['tags', { tags: [] }],
    ['priority', { priority: [] }],
  ])('%s 是空数组时那一维不筛', (_n, over) => {
    const ts = [task({ id: 'a', status: 'later', priority: 3, tags: ['x'], listId: 'L1' })];
    expect(applyFilter(ts, F(over), NOW).map((t) => t.id)).toEqual(['a']);
  });

  it('isFilterEmpty 对 emptyFilter 为真，对任意一维非空为假', () => {
    expect(isFilterEmpty(emptyFilter())).toBe(true);
    expect(isFilterEmpty(F({ status: ['todo'] }))).toBe(false);
    expect(isFilterEmpty(F({ listIds: ['L1'] }))).toBe(false);
    expect(isFilterEmpty(F({ tags: ['x'] }))).toBe(false);
    expect(isFilterEmpty(F({ priority: [1] }))).toBe(false);
    expect(isFilterEmpty(F({ dueWithinDays: 3 }))).toBe(false);
    expect(isFilterEmpty(F({ hasWaitingFor: true }))).toBe(false);
    expect(isFilterEmpty(F({ text: '周报' }))).toBe(false);
  });
});

describe('各维单独生效', () => {
  it('status 多选：或的关系', () => {
    const ts = [
      task({ id: 'a', status: 'todo' }),
      task({ id: 'b', status: 'doing' }),
      task({ id: 'c', status: 'done' }),
    ];
    expect(applyFilter(ts, F({ status: ['todo', 'doing'] }), NOW).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('listIds 多选', () => {
    const ts = [
      task({ id: 'a', listId: 'L1' }),
      task({ id: 'b', listId: 'L2' }),
      task({ id: 'c', listId: 'L3' }),
    ];
    expect(applyFilter(ts, F({ listIds: ['L1', 'L2'] }), NOW).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('tags 多选：任一命中即可', () => {
    const ts = [
      task({ id: 'a', tags: ['家里'] }),
      // b 只命中「工作」一个标签、没有「紧急」——验证的是「任一命中」，
      // 写成「全部标签都要有」的话 b 会被漏掉。
      task({ id: 'b', tags: ['工作', '紧急'] }),
      task({ id: 'c', tags: ['其它'] }),
    ];
    expect(applyFilter(ts, F({ tags: ['家里', '工作'] }), NOW).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('priority 多选', () => {
    const ts = [
      task({ id: 'a', priority: 1 }),
      task({ id: 'b', priority: 2 }),
      task({ id: 'c', priority: 3 }),
    ];
    expect(applyFilter(ts, F({ priority: [1, 2] }), NOW).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('dueWithinDays：整日边界，跟 agenda.ts 的 endOfDay 一致', () => {
    // due 是 3 天后深夜 23:00——「同一时刻 + N 天」语义会把它判成不在 3 天内
    // （17 日 12:00 + 3 天 = 20 日 12:00，23:00 晚于它），整日边界不会。
    const due = new Date(2026, 7, 20, 23, 0, 0).toISOString();
    const ts = [task({ id: 'a', due })];
    expect(applyFilter(ts, F({ dueWithinDays: 3 }), NOW).map((t) => t.id)).toEqual(['a']);
  });

  it('dueWithinDays 为 null 时不筛', () => {
    const ts = [task({ id: 'a', due: null }), task({ id: 'b', due: new Date(2026, 8, 1).toISOString() })];
    expect(applyFilter(ts, F({ dueWithinDays: null }), NOW).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('没有 due 的任务在 dueWithinDays 非 null 时被筛掉', () => {
    const ts = [task({ id: 'a', due: null })];
    expect(applyFilter(ts, F({ dueWithinDays: 3 }), NOW)).toEqual([]);
  });

  it('hasWaitingFor 为 true 时只留 waitingFor 非空的', () => {
    const ts = [task({ id: 'a', waitingFor: '张老师' }), task({ id: 'b', waitingFor: null })];
    expect(applyFilter(ts, F({ hasWaitingFor: true }), NOW).map((t) => t.id)).toEqual(['a']);
  });

  it('hasWaitingFor 为 false 时不筛（不是「只留没有 waitingFor 的」）', () => {
    const ts = [task({ id: 'a', waitingFor: '张老师' }), task({ id: 'b', waitingFor: null })];
    expect(applyFilter(ts, F({ hasWaitingFor: false }), NOW).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('text 命中的范围跟搜索框一致（复用 searchTasks）', () => {
    const ts = [
      task({ id: 'a', title: '别的', notes: '找老王要数据' }),
      task({ id: 'b', title: '别的', subtasks: [{ text: '打印合同', done: false }] }),
      task({ id: 'c', title: '别的' }),
    ];
    // 备注命中
    expect(applyFilter(ts, F({ text: '老王' }), NOW).map((t) => t.id)).toEqual(['a']);
    // 子任务文本命中
    expect(applyFilter(ts, F({ text: '合同' }), NOW).map((t) => t.id)).toEqual(['b']);
  });
});

describe('多维叠加是「与」的关系', () => {
  it('status + tags 同时给，两条都满足才留下', () => {
    const ts = [
      task({ id: 'a', status: 'todo', tags: ['家里'] }),
      task({ id: 'b', status: 'todo', tags: ['工作'] }),
      task({ id: 'c', status: 'done', tags: ['家里'] }),
    ];
    expect(applyFilter(ts, F({ status: ['todo'], tags: ['家里'] }), NOW).map((t) => t.id)).toEqual(['a']);
  });

  it('任一维不满足就筛掉', () => {
    // 这条只满足 tags 这一维、不满足 status——「与」的话必须两维都满足，
    // 写成「或」的残次实现会把它错误地留下。
    const ts = [task({ id: 'a', status: 'done', tags: ['家里'] })];
    expect(applyFilter(ts, F({ status: ['todo'], tags: ['家里'] }), NOW)).toEqual([]);
  });
});

describe('上限方向', () => {
  it('一条都不匹配时返回空数组，不是全部', () => {
    const ts = [task({ id: 'a', status: 'todo' }), task({ id: 'b', status: 'doing' })];
    expect(applyFilter(ts, F({ status: ['done'] }), NOW)).toEqual([]);
  });

  it('不修改传入的数组', () => {
    const ts = [task({ id: 'a' })];
    applyFilter(ts, F({ status: ['done'] }), NOW);
    expect(ts).toHaveLength(1);
  });

  it('保持传入顺序', () => {
    const ts = [
      task({ id: 'c', status: 'todo' }),
      task({ id: 'a', status: 'todo' }),
      task({ id: 'b', status: 'todo' }),
    ];
    expect(applyFilter(ts, F({ status: ['todo'] }), NOW).map((t) => t.id)).toEqual(['c', 'a', 'b']);
  });
});

/**
 * 高级筛选（仿滴答清单）：标签这一维内部的「且」，和多语句「或」查询。
 */
describe('applyFilter：标签的且/或', () => {
  const a = t('a', { tags: ['工作'] });
  const b = t('b', { tags: ['工作', '紧急'] });
  const c = t('c', { tags: ['紧急'] });

  it('默认「或」：任一命中即可', () => {
    expect(ids(applyFilter([a, b, c], F({ tags: ['工作', '紧急'] }), NOW))).toEqual(['a', 'b', 'c']);
  });

  it('tagsAll：选中的每一个都得有', () => {
    expect(ids(applyFilter([a, b, c], F({ tags: ['工作', '紧急'], tagsAll: true, noList: false, noTag: false }), NOW))).toEqual(['b']);
  });

  it('二级标签：筛「工作」筛得出 #工作/项目A——跟点侧栏那个标签看到的是同一批', () => {
    const sub = t('s', { tags: ['工作/项目A'] });
    expect(ids(applyFilter([sub], F({ tags: ['工作'] }), NOW))).toEqual(['s']);
  });

  it('tagsAll 下二级标签同样算——「工作」这一条被 #工作/项目A 满足', () => {
    const sub = t('s', { tags: ['工作/项目A', '紧急'] });
    expect(ids(applyFilter([sub], F({ tags: ['工作', '紧急'], tagsAll: true, noList: false, noTag: false }), NOW))).toEqual(['s']);
  });

  it('tagsAll 不影响别的维度，也不影响「标签这一维没填」的情况', () => {
    expect(ids(applyFilter([a, c], F({ tagsAll: true, noList: false, noTag: false }), NOW))).toEqual(['a', 'c']);
  });
});

describe('applyFilter：多语句「或」查询', () => {
  const hi = t('hi', { priority: 3 });
  const urgent = t('u', { tags: ['紧急'] });
  const plain = t('p');

  it('组与组之间取并集', () => {
    const f = F({ priority: [3], or: [F({ tags: ['紧急'] })] });
    expect(ids(applyFilter([hi, urgent, plain], f, NOW))).toEqual(['hi', 'u']);
  });

  it('同时满足两组的任务只出现一次', () => {
    const both = t('both', { priority: 3, tags: ['紧急'] });
    const f = F({ priority: [3], or: [F({ tags: ['紧急'] })] });
    expect(ids(applyFilter([both], f, NOW))).toEqual(['both']);
  });

  it('结果按原数组顺序，不按「命中的是第几组」', () => {
    const f = F({ tags: ['紧急'], or: [F({ priority: [3] })] });
    expect(ids(applyFilter([hi, urgent], f, NOW))).toEqual(['hi', 'u']);
  });

  it('每一组内部照旧是七维「且」', () => {
    const both = t('both', { priority: 3, tags: ['紧急'] });
    const f = F({ priority: [1], or: [F({ priority: [3], tags: ['紧急'] })] });
    // hi 只有高优先级、没有 #紧急，第二组要求两个都满足
    expect(ids(applyFilter([hi, urgent, both], f, NOW))).toEqual(['both']);
  });

  it('**空组不参与，不是「匹配全部」**——第一行被清空时，下面那组还在筛的东西不该被它吃掉', () => {
    // 这一条跟单组时正好相反（单组为空是「什么都不筛」）。不这么定的话，
    // 加「或」这个功能会在第一行一清空的那一刻退化成「全部」。
    const f = F({ or: [F({ priority: [3] })] });
    expect(ids(applyFilter([hi, urgent, plain], f, NOW))).toEqual(['hi']);
  });

  it('全都空了：回到「什么都不筛」，放行全部——不是一条都不显示', () => {
    const f = F({ or: [F()] });
    expect(ids(applyFilter([hi, urgent, plain], f, NOW))).toEqual(['hi', 'u', 'p']);
  });

  it('or 缺失（加这个字段之前存下来的智能清单）当成没有「或」组，不炸', () => {
    const legacy = { ...F({ priority: [3] }) } as SmartFilter;
    delete (legacy as Partial<SmartFilter>).or;
    expect(ids(applyFilter([hi, plain], legacy, NOW))).toEqual(['hi']);
  });
});

describe('isFilterEmpty：跟高级筛选那两个字段的关系', () => {
  it('只勾了 tagsAll、什么都没筛——还是空的，不然筛选栏再也收不起来', () => {
    expect(isFilterEmpty(F({ tagsAll: true, noList: false, noTag: false }))).toBe(true);
  });

  it('有「或」组就不空了', () => {
    expect(isFilterEmpty(F({ or: [F()] }))).toBe(false);
  });
});

/**
 * 「还没归类的」两维（仿滴答清单筛选里的「收集箱」「无标签」）。空数组的含义
 * 已经被「这一维不参与」占了，表达不出 `listId === null`——所以是两个自己的
 * 布尔字段，不是往数组里塞一个哨兵。
 */
describe('applyFilter：noList / noTag', () => {
  const unfiled = t('无', { listId: null, section: null, tags: [] });
  const work = t('工作', { listId: 'L1', tags: ['写作'] });
  const home = t('家里', { listId: 'L2', tags: [] });
  const all = [unfiled, work, home];
  const hits = (f: Partial<SmartFilter>) => ids(applyFilter(all, F(f), NOW));

  it('noList 只留没归进任何清单的', () => {
    expect(hits({ noList: true })).toEqual(['无']);
  });

  it('**跟选中的清单是「或」不是「且」**——勾了「没有清单」又选了工作，要的是两边加起来，判成「既没清单又在工作里」就是空集', () => {
    expect(hits({ noList: true, listIds: ['L1'] })).toEqual(['无', '工作']);
  });

  it('不勾就是今天的行为，这一维不参与', () => {
    expect(hits({})).toEqual(['无', '工作', '家里']);
    expect(hits({ listIds: ['L1'] })).toEqual(['工作']);
  });

  it('noTag 只留一个标签都没有的', () => {
    expect(hits({ noTag: true })).toEqual(['无', '家里']);
  });

  it('**`tagsAll` 管不着「没有标签」**：「每个都得有」加上「一个都没有」本身就是矛盾，两者只能是或', () => {
    expect(hits({ noTag: true, noDue: false, tags: ['写作'], tagsAll: true })).toEqual(['无', '工作', '家里']);
  });

  it('跟别的维度之间照旧是「且」', () => {
    expect(hits({ noList: true, noTag: true })).toEqual(['无']);
  });

  it('**算「填了」**：勾上之后这份筛选不再是空的，筛选栏该展开、也存得成智能清单', () => {
    expect(isFilterEmpty({ ...emptyFilter(), noList: true })).toBe(false);
    expect(isFilterEmpty({ ...emptyFilter(), noTag: true })).toBe(false);
    expect(isFilterEmpty(emptyFilter())).toBe(true);
  });

  it('缺这两个键的旧智能清单（加它们之前存下来的）当成没勾，不炸', () => {
    const legacy = { ...emptyFilter(), listIds: ['L1'] } as SmartFilter;
    delete (legacy as unknown as Record<string, unknown>).noList;
    delete (legacy as unknown as Record<string, unknown>).noTag;
    expect(ids(applyFilter(all, legacy, NOW))).toEqual(['工作']);
  });
});

/**
 * 「还没排期的」（仿滴答清单筛选里的「无日期」）。跟 `noList`/`noTag` 同一个
 * 形状、同一个理由：`dueWithinDays` 的 `null` 已经被「这一维不参与」占了，
 * 表达不出「压根没有截止时间」。
 *
 * **它捞的是最容易被整批遗忘的那一堆**：这个应用处处按日期组织——「今天」
 * 要有日期才进得去、日历只画有日期的、`sortByUrgency` 按日期排——没有日期的
 * 任务在哪儿都不显眼，而在这之前没有任何地方能把它们一次性捞出来。
 */
describe('applyFilter：noDue', () => {
  const none = t('没日期', { due: null });
  const soon = t('三天后', { due: new Date(2026, 7, 25, 9).toISOString() });
  const broken = t('手改坏了', { due: '下周三' });
  const all = [none, soon, broken];
  const hits = (f: Partial<SmartFilter>) => ids(applyFilter(all, F(f), NOW));

  it('只留没有截止时间的', () => {
    expect(hits({ noDue: true })).toEqual(['没日期', '手改坏了']);
  });

  it('**日期读不出来的也算没有**——「N 天内」筛不到它、日历不画它、「今天」不收它，功能上它就是没日期', () => {
    expect(hits({ noDue: true }).includes('手改坏了')).toBe(true);
    expect(hits({ dueWithinDays: 30 })).toEqual(['三天后']);
  });

  it('不勾就是今天的行为，这一维不参与', () => {
    expect(hits({})).toEqual(['没日期', '三天后', '手改坏了']);
  });

  it('**同时写了两档得到空集**——界面上那是个单选下拉，产不出这种组合；手改文件写出来，那就是这两句话摆在一起的字面意思', () => {
    expect(hits({ noDue: true, dueWithinDays: 30 })).toEqual([]);
  });

  it('算「填了」：勾上之后这份筛选不再是空的，存得成智能清单', () => {
    expect(isFilterEmpty({ ...emptyFilter(), noDue: true })).toBe(false);
  });

  it('缺这个键的旧智能清单（加它之前存下来的）当成没勾，不炸', () => {
    const legacy = { ...emptyFilter(), dueWithinDays: 30 } as SmartFilter;
    delete (legacy as unknown as Record<string, unknown>).noDue;
    expect(ids(applyFilter(all, legacy, NOW))).toEqual(['三天后']);
  });
});

/**
 * **一份存坏了的智能清单不该把整个应用打白。**
 *
 * 实测出来的：只把 `data/lists/xxx.json` 里的 `status` 写成 `statuses`
 * （手改、旧版本、同步过来半截文件都会造成这个），`f.status.length` 就是
 * 「读 undefined 的 length」，React 渲染当场抛异常——侧栏、任务、随手记
 * 一起白屏，而那条清单可能根本不在当前视图里。服务端的 `checkSmartFilter`
 * 只拦得住经过 API 写进来的，拦不住直接落在磁盘上的文件。
 *
 * 判据在 `normalizeFilter`。这一族测试钉的是「缺字段/类型不对时不抛，
 * 并且那一维按『不参与』处理」——不是「猜出他本来想筛什么」。
 */
describe('存坏了的智能清单：补形状，不白屏', () => {
  const all = [t('a'), t('b', { status: 'done' })];
  const broken = (over: Record<string, unknown>) => ({ ...emptyFilter(), ...over } as unknown as SmartFilter);

  it.each([
    ['status', 'statuses'],
    ['listIds', 'lists'],
    ['tags', 'labels'],
    ['priority', 'priorities'],
  ])('四个数组维度里 %s 缺了（写成了 %s）也照样跑，那一维不参与', (key, wrongName) => {
    const f = broken({ [wrongName]: [] });
    delete (f as unknown as Record<string, unknown>)[key];
    expect(() => applyFilter(all, f, NOW)).not.toThrow();
    expect(ids(applyFilter(all, f, NOW))).toEqual(['a', 'b']);
    expect(() => isFilterEmpty(f)).not.toThrow();
  });

  it('整个 filter 是 null / 不是对象，也不抛', () => {
    expect(() => applyFilter(all, null as unknown as SmartFilter, NOW)).not.toThrow();
    expect(() => applyFilter(all, 'x' as unknown as SmartFilter, NOW)).not.toThrow();
    expect(ids(applyFilter(all, null as unknown as SmartFilter, NOW))).toEqual(['a', 'b']);
  });

  it('本该是数组的写成了别的（字符串/数字），按「这一维不参与」处理', () => {
    const f = broken({ status: 'done', tags: 3 });
    expect(ids(applyFilter(all, f, NOW))).toEqual(['a', 'b']);
  });

  it('**补形状不改语义**：字段都在的时候，结果跟以前一模一样', () => {
    const f = F({ status: ['done'] });
    expect(ids(applyFilter(all, f, NOW))).toEqual(['b']);
    expect(isFilterEmpty(F())).toBe(true);
    expect(isFilterEmpty(f)).toBe(false);
  });

  it('`or` 里那一组也补——嵌套的那份存坏了同样会白屏', () => {
    const bad = { ...emptyFilter(), status: ['done'] } as SmartFilter;
    delete (bad as unknown as Record<string, unknown>).tags;
    const f = F({ status: ['todo'], or: [bad] });
    expect(() => applyFilter(all, f, NOW)).not.toThrow();
    expect(ids(applyFilter(all, f, NOW))).toEqual(['a', 'b']);
  });
});


/**
 * 情境（GTD）那一维。三件事，第二件是这一维跟别的维度不一样的地方：
 *
 *   1. 空数组 = 这一维不筛（跟其它维度一样，这个文件最容易写反的一处）。
 *   2. **没分情境的任务筛不到**。清单那一维有一档「不属于任何清单」可以显式
 *      勾，这一维没有——因为它的用法是「我现在在电脑前，给我能干的」，
 *      而没分情境的既不是能干也不是不能干。
 *   3. 多选是「任一命中」，跟优先级那一维同构。
 */
describe('情境这一维', () => {
  const all = [
    t('pc', { context: 'computer' }),
    t('out', { context: 'out' }),
    t('none', { context: null }),
  ];

  it('空数组不筛', () => {
    expect(ids(applyFilter(all, F({ contexts: [] }), NOW))).toEqual(['pc', 'out', 'none']);
  });

  it('选一档就只剩那一档，**没分情境的不跟进来**', () => {
    expect(ids(applyFilter(all, F({ contexts: ['computer'] }), NOW))).toEqual(['pc']);
  });

  it('选两档是「任一命中」，不是「两档都要」（那样永远是空集）', () => {
    expect(ids(applyFilter(all, F({ contexts: ['computer', 'out'] }), NOW))).toEqual(['pc', 'out']);
  });

  it('跟别的维度是「且」：情境 + 状态一起筛', () => {
    const ts = [
      t('a', { context: 'computer', status: 'todo' }),
      t('b', { context: 'computer', status: 'done' }),
    ];
    expect(ids(applyFilter(ts, F({ contexts: ['computer'], status: ['todo'] }), NOW))).toEqual(['a']);
  });

  it('算「填了筛选」——只选了情境时筛选栏不能收起来', () => {
    expect(isFilterEmpty(F({ contexts: ['easy'] }))).toBe(false);
  });

  it('存下来的旧筛选没有 contexts 这个键也不能白屏', () => {
    const legacy = F({ status: ['todo'] }) as unknown as Record<string, unknown>;
    delete legacy.contexts;
    expect(() => applyFilter(all, legacy as unknown as SmartFilter, NOW)).not.toThrow();
  });
});

/**
 * **这一批补的三维**（仿 OmniFocus 的自定义视角规则，出处
 * 《Custom Perspectives》）：是否重复、还没到开始时间、
 * 预计时长不超过 N 分钟。三个字段本来都在 `Task` 上，只是筛不到。
 */
describe('applyFilter：重复 / 还没开始 / 预计时长', () => {
  const rep = { every: 'day' as const, interval: 1, weekdays: [], until: null, from: 'due' as const, count: null, step: 0, monthDay: null };
  const soon = new Date(NOW.getTime() + 3 * 86400000).toISOString();
  const past = new Date(NOW.getTime() - 3 * 86400000).toISOString();

  it('isRepeating：只留挂着重复规则的', () => {
    const ts = [t('a', { repeat: rep }), t('b', { repeat: null })];
    expect(ids(applyFilter(ts, F({ isRepeating: true }), NOW))).toEqual(['a']);
    // 不勾就是这一维不筛——空数组/false 是「所有值都要」，这个文件最容易写反的一处。
    expect(ids(applyFilter(ts, F(), NOW))).toEqual(['a', 'b']);
  });

  it('notStarted：只留还没到开始时间的，判据跟卡片上那个记号同一个函数', () => {
    const ts = [
      t('future', { startAt: soon }),
      t('past', { startAt: past }),
      t('none', { startAt: null }),
    ];
    expect(ids(applyFilter(ts, F({ notStarted: true }), NOW))).toEqual(['future']);
  });

  it.each([
    ['正好等于上限也算——人说「只有二十分钟」时，一件正好二十分钟的事显然算数', 20, ['a', 'b']],
    ['超过的不要', 10, ['a']],
  ] as const)('estimateWithinMinutes：%s', (_n, cap, want) => {
    const ts = [t('a', { estimateMinutes: 10 }), t('b', { estimateMinutes: 20 }), t('c', { estimateMinutes: 45 })];
    expect(ids(applyFilter(ts, F({ estimateWithinMinutes: cap }), NOW))).toEqual([...want]);
  });

  /**
   * **没估过的筛不到。** 「没估过」既不是二十分钟以内也不是以外，混进来这份
   * 清单就不能直接照着做——跟 `contexts` 那一维对「没分情境」的态度一字不差。
   */
  it('estimateWithinMinutes：没估过的筛不到', () => {
    const ts = [t('a', { estimateMinutes: 10 }), t('none', { estimateMinutes: null })];
    expect(ids(applyFilter(ts, F({ estimateWithinMinutes: 30 }), NOW))).toEqual(['a']);
  });

  it('三维跟别的维度是「且」', () => {
    const ts = [
      t('a', { repeat: rep, estimateMinutes: 10, priority: 3 }),
      t('b', { repeat: rep, estimateMinutes: 10, priority: 0 }),
    ];
    expect(ids(applyFilter(ts, F({ isRepeating: true, estimateWithinMinutes: 30, priority: [3] }), NOW))).toEqual(['a']);
  });

  it('三维都算「填了」——筛选栏收不收得起来、存不存得成智能清单靠这个', () => {
    expect(isFilterEmpty(F({ isRepeating: true }))).toBe(false);
    expect(isFilterEmpty(F({ notStarted: true }))).toBe(false);
    expect(isFilterEmpty(F({ estimateWithinMinutes: 20 }))).toBe(false);
    expect(isFilterEmpty(F())).toBe(true);
  });
});

/**
 * **「排除」组**（OmniFocus 的 `None of the Following`）。跟 `or` 是一对：
 * 一个往结果里加，一个从结果里减。
 */
describe('applyFilter：排除组', () => {
  const ts = [
    t('work', { tags: ['工作'] }),
    t('home', { tags: ['家里'] }),
    t('none', { tags: [] }),
  ];

  it('命中排除组的拿掉，别的全留', () => {
    expect(ids(applyFilter(ts, F({ not: [F({ tags: ['工作'] })] }), NOW))).toEqual(['home', 'none']);
  });

  it('只写排除组、第一组是空的：放行全部再减——不是「什么都没筛」', () => {
    const f = F({ not: [F({ tags: ['工作'] })] });
    expect(isFilterEmpty(f)).toBe(false);
    expect(ids(applyFilter(ts, f, NOW))).toEqual(['home', 'none']);
  });

  it('空的排除组不参与——刚点出来还没填条件时，屏幕不该当场清空', () => {
    expect(ids(applyFilter(ts, F({ not: [F()] }), NOW))).toEqual(['work', 'home', 'none']);
  });

  it('多个排除组之间是「或」：命中任何一组就拿掉', () => {
    const f = F({ not: [F({ tags: ['工作'] }), F({ tags: ['家里'] })] });
    expect(ids(applyFilter(ts, f, NOW))).toEqual(['none']);
  });

  /**
   * **减在最后，对整份结果减一次。** 每个「或」组各减各的会把
   * 「A 或 B，排除 C」变成「(A 排除 C) 或 B」——那是另一句话，而且是人从
   * 界面上读不出来的那一句。
   */
  it('跟「或」组一起用：先算并集，再整体排除', () => {
    const all = [
      t('a', { tags: ['工作'], priority: 3 }),
      t('b', { tags: ['家里'], priority: 3 }),
      t('c', { tags: ['工作'], priority: 0 }),
    ];
    // （高优先级 或 带家里标签），排除带工作标签的
    const f = F({ priority: [3], or: [F({ tags: ['家里'] })], not: [F({ tags: ['工作'] })] });
    expect(ids(applyFilter(all, f, NOW))).toEqual(['b']);
  });

  it('排除组自己的 or/not 被拍平——只嵌一层，跟服务端校验同一条', () => {
    const f = { ...F(), not: [{ ...F({ tags: ['工作'] }), or: [F({ tags: ['家里'] })], not: [F()] }] };
    expect(ids(applyFilter(ts, f as SmartFilter, NOW))).toEqual(['home', 'none']);
  });
});

/**
 * **`SmartFilter` 的字段集合有三份定义，这条盯着它们不飘。**
 *
 * 一份是 `model.ts` 的接口（编译器管着，web 那份由 `types.sync.test.ts` 对账），
 * 一份是这边的 `emptyFilter()`（编译器也管得着，少一个键编译不过），
 * **第三份是 `server/src/list.ts` 的 `FILTER_KEYS` 白名单——编译器一个字都不说。**
 *
 * 它飘了的后果很具体：新加的那一维在界面上筛得出来、看起来一切正常，而按
 * 「存成智能清单」的那一刻整份 filter 被 400 退回，错误信息说的是「不能有别的键」
 * ——一句跟他刚做的事毫无关系的话。
 */
describe('SmartFilter 的字段集合：白名单 ≡ 接口', () => {
  it('emptyFilter 的键跟服务端 FILTER_KEYS 一个不多一个不少', () => {
    expect(Object.keys(emptyFilter()).sort()).toEqual([...FILTER_KEYS].sort());
  });

  it('两边都不为空——不是拿两个空表在相等', () => {
    expect(FILTER_KEYS.length).toBeGreaterThan(10);
  });
});
