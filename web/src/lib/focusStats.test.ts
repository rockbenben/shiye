import { describe, it, expect } from 'vitest';
import {
  addSessionPatch, focusByDay, focusByTask, focusTotals, formatMinutes,
  recentSessions, removeSessionPatch, busiestHour, focusByGroup, focusByHour } from './focusStats.js';
import { task } from '../test-utils.js';
import type { FocusSession, Task } from '../types.js';

/** 本地墙钟：周/月边界按本地日历算，用固定 UTC 'Z' 会让这份测试跟着机器时区飘。 */
const local = (y: number, mo: number, d: number, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();

/** 2026-08-19 是周三——本周从 8/17（周一）起，本月从 8/1 起。 */
const NOW = local(2026, 8, 19, 12);

const withSessions = (id: string, sessions: FocusSession[], over: Partial<Task> = {}) =>
  task({ id, title: id, focusSessions: sessions, ...over });

describe('focusTotals', () => {
  it('今天 / 本周 / 本月 / 至今 各自的次数和分钟', () => {
    const t = withSessions('a', [
      { startedAt: iso(2026, 8, 19, 10), minutes: 25 },   // 今天
      { startedAt: iso(2026, 8, 17, 10), minutes: 25 },   // 本周（周一）
      { startedAt: iso(2026, 8, 3, 10), minutes: 50 },    // 本月
      { startedAt: iso(2026, 7, 3, 10), minutes: 10 },    // 更早
    ]);
    expect(focusTotals([t], NOW)).toEqual({
      today: { count: 1, minutes: 25 },
      week: { count: 2, minutes: 50 },
      month: { count: 3, minutes: 100 },
      all: { count: 4, minutes: 110 },
    });
  });

  it('「本周」是本地日历的这一周（周一起），不是往前 168 小时', () => {
    // 周日（8/16）那次不算这一周——按 168 小时算就会把它算进来
    const t = withSessions('a', [{ startedAt: iso(2026, 8, 16, 23), minutes: 25 }]);
    expect(focusTotals([t], NOW).week).toEqual({ count: 0, minutes: 0 });
  });

  it('多条任务的记录合起来算', () => {
    const ts = [
      withSessions('a', [{ startedAt: iso(2026, 8, 19, 9), minutes: 25 }]),
      withSessions('b', [{ startedAt: iso(2026, 8, 19, 10), minutes: 15 }]),
    ];
    expect(focusTotals(ts, NOW).today).toEqual({ count: 2, minutes: 40 });
  });

  it('坏记录跳过，不让整块统计变成 NaN——data/tasks/ 是手改得到的文件', () => {
    const t = withSessions('a', [
      { startedAt: '下周三', minutes: 25 },
      { startedAt: iso(2026, 8, 19, 9), minutes: 0 },
      { startedAt: iso(2026, 8, 19, 9), minutes: -5 },
      { startedAt: iso(2026, 8, 19, 9), minutes: 'x' as unknown as number },
      { startedAt: iso(2026, 8, 19, 9), minutes: 25 },
    ]);
    expect(focusTotals([t], NOW).all).toEqual({ count: 1, minutes: 25 });
  });

  it('focusSessions 不是数组（手改文件漏了方括号）也不炸', () => {
    const t = task({ id: 'a', focusSessions: 'x' as unknown as FocusSession[] });
    expect(focusTotals([t], NOW).all).toEqual({ count: 0, minutes: 0 });
  });

  it('一条记录都没有：全是 0', () => {
    expect(focusTotals([task({ id: 'a' })], NOW).all).toEqual({ count: 0, minutes: 0 });
  });
});

describe('focusByDay', () => {
  it('含今天、最早的在前，一天一格', () => {
    const days = focusByDay([], NOW, 3);
    expect(days.map((d) => d.key)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
  });

  it('**没有记录的那天也在**——缺的那几根柱子本身就是信息', () => {
    const t = withSessions('a', [{ startedAt: iso(2026, 8, 19, 9), minutes: 25 }]);
    const days = focusByDay([t], NOW, 3);
    expect(days.map((d) => d.total.minutes)).toEqual([0, 0, 25]);
  });

  it('窗口之外的记录不算进任何一格', () => {
    const t = withSessions('a', [{ startedAt: iso(2026, 8, 1, 9), minutes: 25 }]);
    expect(focusByDay([t], NOW, 3).every((d) => d.total.count === 0)).toBe(true);
  });

  it('同一天多条合并', () => {
    const t = withSessions('a', [
      { startedAt: iso(2026, 8, 19, 9), minutes: 25 },
      { startedAt: iso(2026, 8, 19, 14), minutes: 15 },
    ]);
    expect(focusByDay([t], NOW, 1)[0].total).toEqual({ count: 2, minutes: 40 });
  });
});

describe('focusByTask', () => {
  it('分钟多的在前，只列真的有记录的', () => {
    const ts = [
      withSessions('少', [{ startedAt: iso(2026, 8, 19, 9), minutes: 10 }]),
      withSessions('多', [{ startedAt: iso(2026, 8, 19, 9), minutes: 50 }]),
      task({ id: '没有', title: '没有' }),
    ];
    expect(focusByTask(ts).map((r) => r.id)).toEqual(['多', '少']);
  });

  it('分钟一样时按次数，再一样按标题——不留「顺序取决于文件顺序」这种排法', () => {
    const ts = [
      withSessions('乙', [{ startedAt: iso(2026, 8, 19, 9), minutes: 30 }]),
      withSessions('甲', [{ startedAt: iso(2026, 8, 19, 9), minutes: 30 }]),
      withSessions('丙', [
        { startedAt: iso(2026, 8, 19, 9), minutes: 15 },
        { startedAt: iso(2026, 8, 19, 10), minutes: 15 },
      ]),
    ];
    // 丙 两次、甲乙各一次，分钟都是 30 → 丙 在前；甲乙按标题
    expect(focusByTask(ts).map((r) => r.id)).toEqual(['丙', '甲', '乙']);
  });
});

describe('formatMinutes', () => {
  it.each([
    [0, '0 分钟'],
    [25, '25 分钟'],
    [59, '59 分钟'],
    [60, '1 小时'],
    [85, '1 小时 25 分'],
    [120, '2 小时'],
  ])('%s → %s', (m, want) => {
    expect(formatMinutes(m)).toBe(want);
  });
});

/**
 * 补记 / 删掉一条专注记录（仿滴答清单的「补记专注记录」「删除专注记录」）。
 */
describe('addSessionPatch / removeSessionPatch / recentSessions', () => {
  it('补记是追加，不覆盖已有的', () => {
    const t = withSessions('a', [{ startedAt: iso(2026, 8, 18), minutes: 25 }]);
    const patch = addSessionPatch(t, local(2026, 8, 19, 14), 40);
    expect(patch.focusSessions).toHaveLength(2);
    expect(patch.focusSessions![1]).toEqual({ startedAt: iso(2026, 8, 19, 14), minutes: 40 });
  });

  it('原来一条都没有也能补记', () => {
    expect(addSessionPatch(task({ id: 'a' }), local(2026, 8, 19), 25).focusSessions).toHaveLength(1);
  });

  it('删掉按 startedAt 精确匹配', () => {
    const t = withSessions('a', [
      { startedAt: iso(2026, 8, 18), minutes: 25 },
      { startedAt: iso(2026, 8, 19), minutes: 40 },
    ]);
    const patch = removeSessionPatch(t, iso(2026, 8, 18))!;
    expect(patch.focusSessions).toEqual([{ startedAt: iso(2026, 8, 19), minutes: 40 }]);
  });

  it('两条时刻撞上时只删一条，不把两条一起抹掉', () => {
    const same = iso(2026, 8, 19);
    const t = withSessions('a', [{ startedAt: same, minutes: 25 }, { startedAt: same, minutes: 40 }]);
    expect(removeSessionPatch(t, same)!.focusSessions).toHaveLength(1);
  });

  it('找不到就返回 null——调用方不该发一个什么都不改的写', () => {
    const t = withSessions('a', [{ startedAt: iso(2026, 8, 18), minutes: 25 }]);
    expect(removeSessionPatch(t, iso(2026, 1, 1))).toBeNull();
  });

  it('recentSessions 新的在前，跨任务合起来，超出上限截断', () => {
    const ts = [
      withSessions('甲', [{ startedAt: iso(2026, 8, 17), minutes: 25 }]),
      withSessions('乙', [{ startedAt: iso(2026, 8, 19), minutes: 25 }]),
      withSessions('丙', [{ startedAt: iso(2026, 8, 18), minutes: 25 }]),
    ];
    expect(recentSessions(ts, 2).map((r) => r.title)).toEqual(['乙', '丙']);
  });

  it('recentSessions 跳过坏记录——跟统计那半用的是同一条判据', () => {
    const t = withSessions('a', [
      { startedAt: '下周三', minutes: 25 },
      { startedAt: iso(2026, 8, 19), minutes: 25 },
    ]);
    expect(recentSessions([t], 10)).toHaveLength(1);
  });
});

/**
 * 另外两种切法（仿滴答清单「专注时长分布」和「专注时间分布」）。同一批
 * `focusSessions`，换的是维度。
 */
describe('focusByHour', () => {
  it('24 个槽一个不少——凌晨三点是空的，那本身就是信息', () => {
    expect(focusByHour([])).toHaveLength(24);
  });

  it('按开始时刻归一个整点，用本地钟点', () => {
    const rows = focusByHour([withSessions('a', [{ startedAt: iso(2026, 8, 19, 14), minutes: 25 }])]);
    expect(rows[14].total).toEqual({ count: 1, minutes: 25 });
    expect(rows[13].total.minutes).toBe(0);
  });

  it('**跨小时的一段整段算进开始那个钟点**——摊开的话每段都在两根柱子上留影子，看不出起点', () => {
    const rows = focusByHour([withSessions('a', [{ startedAt: iso(2026, 8, 19, 14, 50), minutes: 25 }])]);
    expect(rows[14].total.minutes).toBe(25);
    expect(rows[15].total.minutes).toBe(0);
  });

  it('同一个钟点的几段加起来', () => {
    const rows = focusByHour([withSessions('a', [
      { startedAt: iso(2026, 8, 19, 9, 0), minutes: 25 },
      { startedAt: iso(2026, 8, 20, 9, 30), minutes: 15 },
    ])]);
    expect(rows[9].total).toEqual({ count: 2, minutes: 40 });
  });

  it('坏记录跳过，不让一条手改坏的把整张图炸掉', () => {
    expect(focusByHour([withSessions('a', [{ startedAt: '不是时间', minutes: 25 }])])[0].total.minutes).toBe(0);
  });
});

describe('busiestHour', () => {
  it('一条记录都没有返回 null——不说一句「记录最多的是 0 点」', () => {
    expect(busiestHour(focusByHour([]))).toBeNull();
  });

  it('挑分钟最多的那个钟点', () => {
    const rows = focusByHour([withSessions('a', [
      { startedAt: iso(2026, 8, 19, 9), minutes: 25 },
      { startedAt: iso(2026, 8, 19, 15), minutes: 50 },
    ])]);
    expect(busiestHour(rows)?.hour).toBe(15);
  });

  it('并列时取靠前的那个，结果稳定', () => {
    const rows = focusByHour([withSessions('a', [
      { startedAt: iso(2026, 8, 19, 9), minutes: 25 },
      { startedAt: iso(2026, 8, 19, 15), minutes: 25 },
    ])]);
    expect(busiestHour(rows)?.hour).toBe(9);
  });
});

describe('focusByGroup', () => {
  const LISTS = [{ id: 'L1', name: '工作' }, { id: 'L2', name: '生活' }];
  const sess = (h: number, m: number) => ({ startedAt: iso(2026, 8, 19, h), minutes: m });

  it('按清单分组，多的在前', () => {
    const rows = focusByGroup([
      withSessions('a', [sess(9, 10)], { listId: 'L1' }),
      withSessions('b', [sess(9, 50)], { listId: 'L2' }),
    ], 'list', LISTS);
    expect(rows.map((r) => [r.label, r.total.minutes])).toEqual([['生活', 50], ['工作', 10]]);
  });

  it('没有清单的归到「不属于任何清单」', () => {
    const rows = focusByGroup([withSessions('a', [sess(9, 10)])], 'list', LISTS);
    expect(rows).toEqual([{ key: null, label: '不属于任何清单', total: { count: 1, minutes: 10 } }]);
  });

  it('指向一个已经删掉的清单时也归到那一档，不显示一个裸 id', () => {
    const rows = focusByGroup([withSessions('a', [sess(9, 10)], { listId: '没了' })], 'list', LISTS);
    expect(rows[0].label).toBe('不属于任何清单');
  });

  it('**按标签分组时一段算进它的每一个标签**——加起来会超过总时长，这是有意的', () => {
    const rows = focusByGroup([withSessions('a', [sess(9, 25)], { tags: ['工作', '紧急'] })], 'tag', LISTS);
    expect(rows.map((r) => [r.label, r.total.minutes]).sort()).toEqual([['工作', 25], ['紧急', 25]]);
  });

  it('没有标签的归到「没有标签」', () => {
    const rows = focusByGroup([withSessions('a', [sess(9, 10)])], 'tag', LISTS);
    expect(rows[0].label).toBe('没有标签');
  });

  it('一条记录都没有的任务不进来——全是 0 的分布没有信息', () => {
    expect(focusByGroup([task({ id: 'a', listId: 'L1' })], 'list', LISTS)).toEqual([]);
  });

  it('一样多时按次数、再按名字排——不留「顺序取决于读盘顺序」这种排法', () => {
    const rows = focusByGroup([
      withSessions('b', [sess(9, 10)], { listId: 'L2' }),
      withSessions('a', [sess(9, 10)], { listId: 'L1' }),
    ], 'list', LISTS);
    expect(rows.map((r) => r.label)).toEqual(['工作', '生活']);
  });
});


/**
 * 按情境分。**跟按清单分一样是真划分**（一条任务只有一个情境）——这一族里
 * 最要紧的一条就是它：标签那一档各组加起来会超过总时长（界面上专门声明过），
 * 情境那一档不该。
 */
describe('focusByGroup：按情境', () => {
  const sess = (h: number, m: number) => ({ startedAt: iso(2026, 8, 19, h), minutes: m });

  it('按情境分组，多的在前，用的是中文名不是存盘的英文 key', () => {
    const rows = focusByGroup([
      task({ id: 'a', context: 'computer', focusSessions: [sess(9, 25)] }),
      task({ id: 'b', context: 'out', focusSessions: [sess(10, 50)] }),
      task({ id: 'c', context: 'computer', focusSessions: [sess(11, 25)] }),
    ], 'context', []);
    // 两组都是 50 分钟，**平局按次数**：电脑前 2 次在前、外出 1 次在后。
    // （这一条顺便钉住了排序的第二个比较键，不只是分钟数。）
    expect(rows.map((r) => r.label)).toEqual(['电脑前', '外出']);
    expect(rows.map((r) => r.total.minutes)).toEqual([50, 50]);
    expect(rows.map((r) => r.total.count)).toEqual([2, 1]);
  });

  it('没分情境的归「没分情境」一组，key 是 null', () => {
    const rows = focusByGroup([
      task({ id: 'a', context: null, focusSessions: [sess(9, 25)] }),
    ], 'context', []);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('没分情境');
    expect(rows[0].key).toBeNull();
  });

  it('**各组加起来等于总时长**——这是它跟标签那一档最大的区别', () => {
    const tasks = [
      task({ id: 'a', context: 'computer', tags: ['x', 'y'], focusSessions: [sess(9, 25)] }),
      task({ id: 'b', context: 'out', tags: ['x'], focusSessions: [sess(10, 25)] }),
    ];
    const byCtx = focusByGroup(tasks, 'context', []);
    expect(byCtx.reduce((n, r) => n + r.total.minutes, 0)).toBe(50);
    // 对照：标签那一档 a 算两遍，加起来是 75，比总时长多。
    const byTag = focusByGroup(tasks, 'tag', []);
    expect(byTag.reduce((n, r) => n + r.total.minutes, 0)).toBe(75);
  });

  it('认不得的情境值（手改进来的旧数据）归「没分情境」，不印一个裸 key', () => {
    const t = task({ id: 'a', focusSessions: [sess(9, 25)] });
    (t as unknown as Record<string, unknown>).context = 'office';
    const rows = focusByGroup([t], 'context', []);
    expect(rows[0].label).toBe('没分情境');
  });
});

/**
 * **「本周」跟着设置走。**
 *
 * 这儿原来自己抄了一份写死周一的 `mondayOf`，注释写着「跟 `calendar.ts` 同一条」
 * ——而那句话当时就不成立：日历读 `Settings.weekStart`，这里不读。把「每周开始于」
 * 改成周日之后，日历那七列跟着变了，屏幕上「本周专注 3 小时」还是按周一到周日
 * 算的。那是**一个算错了的数字**，不是排版偏好。
 *
 * 夹具挑成三档给三个不同答案，缺一档都测不出派发：
 * 基准是周三（8/26），周一档的周首是 8/24、周日档 8/23、周六档 8/22。
 */
describe('focusTotals：本周的边界跟着 weekStart 走', () => {
  const WED = local(2026, 8, 26, 12);        // 周三
  const sunday = iso(2026, 8, 23, 10);       // 周日：周日档和周六档算「本周」
  const saturday = iso(2026, 8, 22, 10);     // 周六：只有周六档算「本周」
  const wed = iso(2026, 8, 26, 8);           // 今天：三档都算

  const totalsFor = (at: string, ws: 0 | 1 | 6) =>
    focusTotals([withSessions('a', [{ startedAt: at, minutes: 25 }])], WED, ws).week.minutes;

  it('周日那一次：周日档和周六档算「本周」，周一档不算', () => {
    expect(totalsFor(sunday, 0)).toBe(25);
    expect(totalsFor(sunday, 6)).toBe(25);
    expect(totalsFor(sunday, 1)).toBe(0);
  });

  it('周六那一次：只有周六档算「本周」', () => {
    expect(totalsFor(saturday, 6)).toBe(25);
    expect(totalsFor(saturday, 0)).toBe(0);
    expect(totalsFor(saturday, 1)).toBe(0);
  });

  it('今天那一次三档都算——下限方向，别把整个「本周」算没了', () => {
    for (const ws of [0, 1, 6] as const) expect(totalsFor(wed, ws)).toBe(25);
  });

  it('不给这个参数就按周一，跟设置的默认档一致（离线读不到设置走这条）', () => {
    const t = [withSessions('a', [{ startedAt: sunday, minutes: 25 }])];
    expect(focusTotals(t, WED).week.minutes).toBe(focusTotals(t, WED, 1).week.minutes);
    expect(focusTotals(t, WED).week.minutes).toBe(0);
  });

  it('「今天」和「本月」不受 weekStart 影响——它改的只是周边界', () => {
    const t = [withSessions('a', [{ startedAt: sunday, minutes: 25 }])];
    for (const ws of [0, 1, 6] as const) {
      expect(focusTotals(t, WED, ws).today.minutes).toBe(0);
      expect(focusTotals(t, WED, ws).month.minutes).toBe(25);
    }
  });
});
