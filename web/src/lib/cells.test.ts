import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { kanbanCells, quadrantCells, priorityOfQuadrant } from './cells.js';
import { task } from '../test-utils.js';
import type { Task } from '../types.js';

const t = (over: Partial<Task> = {}) => task({ ...over });   // web/src/test-utils.tsx 的 task()
// 看板列内现在按紧急度排（见 cells.ts），所以要一个 `now`。本地墙钟，跟
// agenda.test.ts 那条同一条规矩。
const NOW = new Date(2026, 7, 24, 10, 0);

describe('kanbanCells', () => {
  it('五列齐全，顺序是 待办/进行中/已完成/搁置/已放弃', () => {
    expect(kanbanCells([], NOW).map((c) => c.key)).toEqual(['todo', 'doing', 'done', 'later', 'abandoned']);
  });

  it('空列也在——看板要能往空列里拖', () => {
    const cells = kanbanCells([t({ id: 'a', status: 'doing' })], NOW);
    expect(cells).toHaveLength(5);
    expect(cells.find((c) => c.key === 'todo')!.tasks).toEqual([]);
  });

  it('每条任务只出现在一列里', () => {
    const tasks = [t({ id: 'a', status: 'todo' }), t({ id: 'b', status: 'done' })];
    const ids = kanbanCells(tasks, NOW).flatMap((c) => c.tasks.map((x) => x.id));
    expect(ids).toEqual([...new Set(ids)]);          // 无重复
    expect(ids.sort()).toEqual(['a', 'b']);          // 也没丢
  });

  // 上限方向：不能只钉「结构」（四列都在、没重复没丢），还要钉「哪张卡真的
  // 进了哪一列」——纯结构断言挡不住读侧把 done/later 两列内容对调、或者写侧
  // 把某个状态错路由到另一列。四个状态各一条，`later` 必须在其中；仿
  // `quadrantCells` 那组 `cells.find(...)` 的写法，同时断言目标列有它、
  // 别的列没有它。
  it.each([
    ['todo', 'todo'],
    ['doing', 'doing'],
    ['done', 'done'],
    ['later', 'later'],
  ] as const)('status=%s 落进 %s 列，不在别的列里', (status, key) => {
    const cells = kanbanCells([t({ id: 'x', status })], NOW);
    for (const c of cells) expect(c.tasks.map((y) => y.id)).toEqual(c.key === key ? ['x'] : []);
  });

  // 上限方向：状态是四选一之外的脏值（服务端不校验文件里写的东西）不能凭空吃掉
  it('状态不认识的任务落进待办，不消失', () => {
    const cells = kanbanCells([t({ id: 'x', status: 'pending' as Task['status'] })], NOW);
    expect(cells.flatMap((c) => c.tasks.map((y) => y.id))).toEqual(['x']);
  });
});

describe('quadrantCells', () => {
  const NOW = new Date('2026-08-16T12:00:00.000Z');

  it('四格齐全，空格子也在', () => {
    expect(quadrantCells([], NOW, new Set()).map((c) => c.key))
      .toEqual(['imp-urg', 'imp-later', 'min-urg', 'min-later']);
    expect(quadrantCells([], NOW, new Set()).every((c) => c.tasks.length === 0)).toBe(true);
  });

  /**
   * **四格 = 四档优先级**（仿滴答清单）。这一族用例换掉了原来那套二维坐标
   * （行 = priority >= 2，列 = due 三天内）——换掉是明确要求向滴答靠齐，
   * 不是原来那套算错了。`due` 从此不参与分格，那批「三天内算紧急」的边界
   * 用例跟着退役。
   */
  it.each([
    ['高 → 重要且紧急',    3, 'imp-urg'],
    ['中 → 重要不紧急',    2, 'imp-later'],
    ['低 → 不重要但紧急',  1, 'min-urg'],
    ['无 → 不重要也不紧急', 0, 'min-later'],
  ] as const)('%s', (_n, priority, key) => {
    const cells = quadrantCells([t({ id: 'x', priority })], NOW, new Set());
    expect(cells.find((c) => c.key === key)!.tasks.map((y) => y.id)).toEqual(['x']);
  });

  it('**due 不再参与分格**——一条马上到期的低优先级任务照样待在「低」那一格', () => {
    const cells = quadrantCells([t({ id: 'x', priority: 1, due: '2026-08-16T20:00:00.000Z' })], NOW, new Set());
    expect(cells.find((c) => c.key === 'min-urg')!.tasks.map((y) => y.id)).toEqual(['x']);
  });

  it('已过期也不改变格子——过期是「已过期」那个记号的事，不是四象限的事', () => {
    const cells = quadrantCells([t({ id: 'x', priority: 0, due: '2026-08-01T00:00:00.000Z' })], NOW, new Set());
    expect(cells.find((c) => c.key === 'min-later')!.tasks.map((y) => y.id)).toEqual(['x']);
  });

  it('priority 不是 0..3 之一时落进最后一格，不凭空吃掉一条任务', () => {
    const weird = { ...t({ id: 'x' }), priority: 9 as unknown as Task['priority'] };
    const cells = quadrantCells([weird], NOW, new Set());
    expect(cells.find((c) => c.key === 'min-later')!.tasks.map((y) => y.id)).toEqual(['x']);
  });

  it('已完成的不进四象限——四象限是拿来决定「接下来做什么」的', () => {
    const cells = quadrantCells([t({ id: 'x', status: 'done', priority: 3 })], NOW, new Set());
    expect(cells.flatMap((c) => c.tasks)).toEqual([]);
  });

  it('搁置的也不进四象限——那是他已经明确做过的决定，不该被四象限的坐标覆盖', () => {
    const cells = quadrantCells([t({ id: 'x', status: 'later', priority: 3 })], NOW, new Set());
    expect(cells.flatMap((c) => c.tasks)).toEqual([]);
  });

  it('正在编辑的留下——不然编辑框会在手底下蒸发', () => {
    const cells = quadrantCells([t({ id: 'x', status: 'done', priority: 3 })], NOW, new Set(['x']));
    expect(cells.find((c) => c.key === 'imp-urg')!.tasks.map((y) => y.id)).toEqual(['x']);
  });
});

describe('priorityOfQuadrant：四个格子都拖得动', () => {
  it.each([
    ['imp-urg', 3],
    ['imp-later', 2],
    ['min-urg', 1],
    ['min-later', 0],
  ] as const)('%s → %s', (key, want) => {
    expect(priorityOfQuadrant(key)).toBe(want);
  });

  it('认不出的 key 回 null，调用方据此不发 PATCH', () => {
    expect(priorityOfQuadrant('没有这一格')).toBeNull();
  });
});

/**
 * 列内 / 格内的顺序。**在这之前是服务端读目录的顺序**——`readdirSync().sort()`，
 * 文件名是 uuid，也就是随机。别的每一个列表面都排过序，唯独这两个视图没有，
 * 而 `byPinned` 那句注释写着「所有排序的第一个比较键」，在这里一直不成立。
 */
describe('列内 / 格内按紧急度排', () => {
  const iso = (y: number, m: number, d: number) => new Date(y, m - 1, d, 9).toISOString();
  // 故意造一份「传进去的顺序」跟「该有的顺序」完全相反的输入：不排序的实现
  // 会原样吐回来，这条就会红。
  const messy = [
    t({ id: 'far', status: 'todo', due: iso(2026, 12, 1) }),
    t({ id: 'overdue', status: 'todo', due: iso(2026, 8, 1) }),
    t({ id: 'pinned', status: 'todo', due: iso(2026, 12, 31), pinned: true }),
  ];

  it('看板：置顶最前，然后过期的，再按时间', () => {
    const todo = kanbanCells(messy, NOW).find((c) => c.key === 'todo')!;
    expect(todo.tasks.map((x) => x.id)).toEqual(['pinned', 'overdue', 'far']);
  });

  it('四象限同一条', () => {
    const cells = quadrantCells(messy, NOW, new Set());
    const ids = cells.flatMap((c) => c.tasks.map((x) => x.id));
    // 三条都不重要（priority 0）：置顶那条 due 在 12/31，不紧急；过期那条紧急。
    expect(ids.indexOf('pinned')).toBeLessThan(ids.indexOf('far'));
  });

  it('**没有列内拖拽排序，所以排序不会覆盖掉谁排的顺序**——TaskGrid 在 from === to 时直接 return', () => {
    // 这条钉的是上面那条理由：看板的 GridSection 里没有 order 这一说，
    // 同一列内拖动不产生任何 patch（TaskGrid.handleDragEnd）。
    const src = readFileSync('web/src/components/TaskGrid.tsx', 'utf8');
    expect(src).toContain('from === to) return');
  });
});

/**
 * **第二套规则：`time-priority`（= 滴答清单的「规则组合2」）。**
 *
 * 这一族里的边界用例（整日边界、已过期算紧急、第四天凌晨不算）不是新写的，
 * 是从 61a58d6 之前那版捞回来的——那时候二维模型是唯一的模型。捞回来的理由
 * 跟它们当初存在的理由一字不差：`endOfDay` 是「N 天后那一天之内」，按「往后
 * 推 N 天的同一时刻」算会把三天后深夜误判成不急。
 */
describe('quadrantCells：time-priority 规则', () => {
  /** 从 NOW 往后推 plusDays 个本地日历日，钉到本地 h:mi——不用固定 UTC 'Z'
   *  时间戳表达「第几天」，跟 agenda.test.ts 的 localIso 同一条教训：
   *  紧急边界是按本地 setHours/setDate 算的，用绝对 UTC 时间戳的话「落在第几个
   *  日历日」会跟着跑测试的机器时区飘。 */
  const localDueAt = (plusDays: number, h: number, mi: number): string => {
    const d = new Date(NOW);
    d.setDate(d.getDate() + plusDays);
    d.setHours(h, mi, 0, 0);
    return d.toISOString();
  };
  const cellOf = (over: Partial<Task>) =>
    quadrantCells([t({ id: 'x', ...over })], NOW, new Set(), 'time-priority')
      .find((c) => c.tasks.length)?.key;

  it('四格齐全，空格子也在——坐标系缺一格就不成立', () => {
    const cells = quadrantCells([], NOW, new Set(), 'time-priority');
    expect(cells.map((c) => c.key)).toEqual(['imp-urg', 'imp-later', 'min-urg', 'min-later']);
    expect(cells.every((c) => c.tasks.length === 0)).toBe(true);
  });

  /**
   * **每一行的优先级都刻意挑成「在另一套规则下会落进别的格子」。**
   *
   * 第一版这四行挑的是 3/2/1/0 配上对应的日期，四条在 `priority` 规则下
   * 落的是同一个格子——于是把 `quadrantCells` 里的规则派发整个打掉之后，
   * 这四条**照样全绿**（实测只有另外两条变红）。夹具挑得能跑通，不等于
   * 夹具能证明被测的那件事。
   *
   * 现在这四行里，每一条的 `priority` 单独看会指向另一格：priority 2 在
   * `priority` 规则下是「重要不紧急」，而它今天到期，在这套规则下必须落进
   * 「重要且紧急」。四条都这样，派发一坏就四条一起红。
   */
  it.each([
    ['重要 + 紧急（priority 2 单独看是「重要不紧急」）', 2, 0, 'imp-urg'],
    ['重要 + 不急（priority 3 单独看是「重要且紧急」）', 3, 30, 'imp-later'],
    ['不重要 + 紧急（priority 0 单独看是「不重要也不紧急」）', 0, 0, 'min-urg'],
    ['不重要 + 不急（priority 1 单独看是「不重要但紧急」）', 1, 30, 'min-later'],
  ] as const)('%s → %s', (_n, priority, plusDays, key) => {
    expect(cellOf({ priority, due: localDueAt(plusDays, 12, 0) })).toBe(key);
  });

  it.each([
    ['priority 3 是重要', 3, true],
    ['priority 2 是重要——边界在这儿', 2, true],
    ['priority 1 不是', 1, false],
    ['priority 0 不是', 0, false],
  ] as const)('%s', (_n, priority, important) => {
    expect(cellOf({ priority, due: null })!.startsWith('imp')).toBe(important);
  });

  it('已过期算紧急，不是「已经来不及所以不急了」', () => {
    expect(cellOf({ priority: 3, due: localDueAt(-20, 12, 0) })).toBe('imp-urg');
  });

  it('三天后深夜也算紧急——整日边界，不是「往后推 N 天的同一时刻」', () => {
    // NOW 是 10:00，三天后 23:00 晚于「同一时刻」，按时刻算会被误判成不急。
    expect(cellOf({ priority: 0, due: localDueAt(3, 23, 0) })).toBe('min-urg');
  });

  it('第四天凌晨不算紧急——整日边界不能因此多算一天', () => {
    expect(cellOf({ priority: 0, due: localDueAt(4, 0, 30) })).toBe('min-later');
  });

  it.each([
    ['没有 due', null],
    ['due 解析不了', '下周三'],
  ] as const)('%s 当成不急，不抛也不消失', (_n, due) => {
    expect(cellOf({ priority: 0, due })).toBe('min-later');
  });

  it.each([['done'], ['later']] as const)('%s 照样滤掉——换规则不改「四象限只看接下来做什么」', (status) => {
    const x = t({ id: 'a', status, priority: 3, due: null });
    expect(quadrantCells([x], NOW, new Set(), 'time-priority').flatMap((c) => c.tasks)).toEqual([]);
  });

  it('正在编辑的卡就算被标成完成也留下——keep 在这套规则下同样生效', () => {
    const x = t({ id: 'a', status: 'done', priority: 3, due: null });
    expect(quadrantCells([x], NOW, new Set(['a']), 'time-priority').flatMap((c) => c.tasks.map((y) => y.id)))
      .toEqual(['a']);
  });
});

/**
 * **两套规则必须真的不一样，而且默认档必须是原来那套。**
 *
 * 没有这一族的话，上面两族可以在「`rule` 参数根本没被读」的情况下同时全绿：
 * 一条 priority 0、今天到期的任务，在 `priority` 规则下进「不重要也不紧急」
 * （priority 0 那一格），在 `time-priority` 下进「不重要但紧急」（今天到期）
 * ——同一条任务、同一个 `now`，两套规则给出不同的格子，这才证明参数真的在起作用。
 */
describe('两套规则的分界', () => {
  const today = new Date(NOW);
  today.setHours(20, 0, 0, 0);
  const x = t({ id: 'x', priority: 0, due: today.toISOString() });
  const keyUnder = (rule?: 'priority' | 'time-priority') =>
    quadrantCells([x], NOW, new Set(), rule).find((c) => c.tasks.length)!.key;

  it('同一条任务在两套规则下落进不同的格子', () => {
    expect(keyUnder('priority')).toBe('min-later');
    expect(keyUnder('time-priority')).toBe('min-urg');
  });

  it('不传 rule 时走的是 priority 那套——加这个开关不改任何人现在看到的四象限', () => {
    expect(keyUnder()).toBe(keyUnder('priority'));
  });

  it('priorityOfQuadrant 也跟着规则走：time-priority 下同一行两格同值', () => {
    expect(priorityOfQuadrant('imp-urg', 'time-priority')).toBe(2);
    expect(priorityOfQuadrant('imp-later', 'time-priority')).toBe(2);
    expect(priorityOfQuadrant('min-urg', 'time-priority')).toBe(0);
    expect(priorityOfQuadrant('min-later', 'time-priority')).toBe(0);
  });

  it('priority 那套下四格四个不同的值——同一行同值是 time-priority 独有的', () => {
    const vals = ['imp-urg', 'imp-later', 'min-urg', 'min-later'].map((k) => priorityOfQuadrant(k, 'priority'));
    expect(new Set(vals).size).toBe(4);
  });

  it('认不出的 key 在两套规则下都回 null', () => {
    expect(priorityOfQuadrant('没有这一格', 'priority')).toBeNull();
    expect(priorityOfQuadrant('没有这一格', 'time-priority')).toBeNull();
  });
});

/**
 * **还没到开始时间的不进四象限。**
 *
 * 跟 `isSettled` 那两支同一条口径，理由写在 `quadrantCells` 上面。这一族两个
 * 方向都要有：漏了它们（少滤）会让「重要且紧急」那格的数字虚高，而滤过头
 * （把已经开始的、或者时间解不出来的也滤掉）会让任务凭空消失——四象限是
 * 唯一一屏「就这么多事，挑一件」，两种错法都直接坏掉它存在的理由。
 */
describe('quadrantCells：还没到开始时间的不参与', () => {
  const iso = (plusDays: number, h = 12) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() + plusDays);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };

  it.each([['priority'], ['time-priority']] as const)('%s 规则下都滤掉', (rule) => {
    const x = t({ id: 'x', priority: 3, due: null, startAt: iso(30) });
    expect(quadrantCells([x], NOW, new Set(), rule).flatMap((c) => c.tasks)).toEqual([]);
  });

  it('高优先级 + 今天到期，只要还没到开始时间，照样不进——不是靠优先级或 due 豁免的', () => {
    const x = t({ id: 'x', priority: 3, due: iso(0), startAt: iso(30) });
    expect(quadrantCells([x], NOW, new Set(), 'time-priority').flatMap((c) => c.tasks)).toEqual([]);
  });

  it('已经到了开始时间的照常进——下限方向，别把整个字段当成「永远不显示」', () => {
    const x = t({ id: 'x', priority: 3, due: null, startAt: iso(-1) });
    expect(quadrantCells([x], NOW, new Set()).flatMap((c) => c.tasks.map((y) => y.id))).toEqual(['x']);
  });

  it('没有开始时间的照常进', () => {
    const x = t({ id: 'x', priority: 3, due: null, startAt: null });
    expect(quadrantCells([x], NOW, new Set()).flatMap((c) => c.tasks.map((y) => y.id))).toEqual(['x']);
  });

  it('开始时间解不出来的照常进——解析不了不等于「还没开始」，不能凭空吃掉一条任务', () => {
    const x = t({ id: 'x', priority: 3, due: null, startAt: '下周三' });
    expect(quadrantCells([x], NOW, new Set()).flatMap((c) => c.tasks.map((y) => y.id))).toEqual(['x']);
  });

  it('正在编辑的留下——keep 对这一支同样生效，不然编辑框会在手底下蒸发', () => {
    const x = t({ id: 'a', priority: 3, due: null, startAt: iso(30) });
    expect(quadrantCells([x], NOW, new Set(['a'])).flatMap((c) => c.tasks.map((y) => y.id))).toEqual(['a']);
  });
});

/**
 * **被 defer 的父任务底下的活儿，也不该摆进四象限。**
 *
 * 这一屏是这个应用里唯一一屏「就这么多事，挑一件」，而它上面那段注释说
 * 「那个数字可信」是它存在的全部意义。在 `notStartedDeep` 之前那句话是假的：
 * defer 只挡住父任务自己，它底下三条现在一件都动不了的活儿照常占着格子。
 */
describe('四象限：父亲还没开始，孩子也不进格子', () => {
  const NOW = new Date(2026, 7, 25, 12, 0, 0);
  const LATER = new Date(2026, 8, 1, 9).toISOString();
  const cellOf = (secs: ReturnType<typeof quadrantCells>, id: string) =>
    secs.find((s) => s.tasks.some((t) => t.id === id))?.key;
  const ids = (secs: ReturnType<typeof quadrantCells>) => secs.flatMap((s) => s.tasks.map((t) => t.id));

  it('**父亲 9/1 才开始：它和它的孩子都不在**——孩子自己一个日期都没设', () => {
    const all = [
      task({ id: 'p', title: '装修', startAt: LATER, priority: 3 }),
      task({ id: 'c', title: '量尺寸', parentId: 'p', priority: 3 }),
      task({ id: 'x', title: '别的事', priority: 3 }),
    ];
    expect(ids(quadrantCells(all, NOW, new Set()))).toEqual(['x']);
  });

  it('隔代也挡得住', () => {
    const all = [
      task({ id: 'p', startAt: LATER }),
      task({ id: 'm', parentId: 'p' }),
      task({ id: 'g', parentId: 'm' }),
    ];
    expect(ids(quadrantCells(all, NOW, new Set()))).toEqual([]);
  });

  it('对照：父亲的开始时间过了，父子都照常进格子——不是「有父亲就不进」', () => {
    const all = [
      task({ id: 'p', startAt: new Date(2026, 7, 1, 9).toISOString(), priority: 3 }),
      task({ id: 'c', parentId: 'p', priority: 3 }),
    ];
    expect(ids(quadrantCells(all, NOW, new Set())).sort()).toEqual(['c', 'p']);
    expect(cellOf(quadrantCells(all, NOW, new Set()), 'c')).toBe('imp-urg');
  });

  it('**正在编辑的照样留下**——`keep` 对这条新判据同样有效，编辑到一半的卡不该消失', () => {
    const all = [task({ id: 'p', startAt: LATER }), task({ id: 'c', parentId: 'p' })];
    expect(ids(quadrantCells(all, NOW, new Set(['c'])))).toEqual(['c']);
  });
});

/**
 * **在等别人的任务照常进四象限——这条守的是一个「有意不做」。**
 *
 * 「现在做什么」那一屏把 `waitingFor` 排除了（`suggest.ts`，出处是 Things 那句
 * 「it gets these to-dos out of Today」）。**这一屏有意不跟**：四象限答的是
 * 「我盘子里有什么」，一条今天到期、在等人的任务确实在盘子里，藏掉它是替他做
 * 决定；而那一屏是主动捞东西出来问他，捞错了是纯粹的噪音。两屏问的不是同一个
 * 问题，所以判据不该统一。
 *
 * 没有这条守卫的话，下一个人看见 `suggest.ts` 里那句 `if (t.waitingFor)`，
 * 很容易顺手「统一」到这里来。
 */
describe('四象限：在等别人的照常摆进格子——跟「现在做什么」有意不同', () => {
  const NOW2 = new Date(2026, 7, 25, 12, 0, 0);
  const ids = (secs: ReturnType<typeof quadrantCells>) => secs.flatMap((s) => s.tasks.map((t) => t.id));

  it('填了「在等谁」的任务照常在格子里', () => {
    const all = [task({ id: 'w', title: '等法务回合同', waitingFor: '张律师', priority: 3 })];
    expect(ids(quadrantCells(all, NOW2, new Set()))).toEqual(['w']);
  });
});
