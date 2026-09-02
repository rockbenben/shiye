import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarAnchor, calendarDays, dayKey, daySlots, hourBand, isAllDay, shiftAnchor, isoWeek } from './calendar.js';
import { hasTimeBlock } from './taskView.js';
import { task } from '../test-utils.js';

const NOW = new Date(2026, 7, 16, 12, 0, 0); // 2026-08-16 是周日
const at = (y: number, m: number, d: number, h = 9): string => new Date(y, m - 1, d, h).toISOString();

/**
 * **一格日历的全部意义就是「这天按顺序有什么」。**
 *
 * 在这几条之前格子里根本没排过序——上面那几个循环是 `push` 进去的，顺序就是
 * 任务数组进来的顺序，也就是服务端 `readdirSync().sort()` 的 uuid 顺序，**等于
 * 随机**。实拍过：8/26 那格显示成「背单词 21:00 / 晨跑 7:00 / 给房东打电话 20:00」。
 *
 * 跟看板/四象限当初那处是同一个形状（`lib/cells.ts` 的 `kanbanCells` 注释里
 * 写着同一句「服务端读目录的顺序……随机」），日历格子是漏掉的最后一处。
 */
describe('calendarDays：格子里按时间排', () => {
  it('同一天的任务按时刻排，不是按进来的顺序', () => {
    // 故意按「乱序」喂进去——这正是 readdirSync 给的那种顺序。
    const tasks = [
      task({ id: 'c', title: '背单词', due: at(2026, 8, 26, 21) }),
      task({ id: 'a', title: '晨跑', due: at(2026, 8, 26, 7) }),
      task({ id: 'b', title: '给房东打电话', due: at(2026, 8, 26, 20) }),
    ];
    const cell = calendarDays(tasks, NOW, 'month').find((d) => d.key === '2026-08-26')!;
    expect(cell.tasks.map((t) => t.title)).toEqual(['晨跑', '给房东打电话', '背单词']);
  });

  it('全天的（零点）排在带时刻的前面——日历的通例', () => {
    const tasks = [
      task({ id: 'b', title: '下午的会', due: at(2026, 8, 26, 15) }),
      task({ id: 'a', title: '全天的事', due: at(2026, 8, 26, 0) }),
    ];
    const cell = calendarDays(tasks, NOW, 'month').find((d) => d.key === '2026-08-26')!;
    expect(cell.tasks.map((t) => t.title)).toEqual(['全天的事', '下午的会']);
  });

  it('**同一时刻按标题定序**——不留「顺序取决于文件顺序」这种一改就变的排法', () => {
    const mk = (id: string, title: string) => task({ id, title, due: at(2026, 8, 26, 9) });
    const one = calendarDays([mk('z', '乙'), mk('a', '甲')], NOW, 'month');
    const two = calendarDays([mk('a', '甲'), mk('z', '乙')], NOW, 'month');
    const titles = (ds: ReturnType<typeof calendarDays>) =>
      ds.find((d) => d.key === '2026-08-26')!.tasks.map((t) => t.title);
    expect(titles(one)).toEqual(['甲', '乙']);
    expect(titles(one)).toEqual(titles(two));   // 喂进来的顺序不影响结果
  });
});

describe('calendarDays：月视图', () => {
  it('42 天，从周一开始', () => {
    const days = calendarDays([], NOW, 'month');
    expect(days).toHaveLength(42);
    expect(days[0].date.getDay()).toBe(1); // 周一
  });

  it('本月第一天和最后一天都在里面，且 outside 为 false', () => {
    const days = calendarDays([], NOW, 'month');
    const first = days.find((d) => d.key === '2026-08-01')!;
    const last = days.find((d) => d.key === '2026-08-31')!;
    expect(first.outside).toBe(false);
    expect(last.outside).toBe(false);
  });

  // 上限方向：头尾补的那几天必须标成 outside，否则界面上分不出「这是上个月的 31 号」
  it('头尾补的日子 outside 为 true', () => {
    const days = calendarDays([], NOW, 'month');
    expect(days[0].outside).toBe(true); // 2026-07-27 周一
    expect(days[0].key).toBe('2026-07-27');
    expect(days[41].outside).toBe(true);
  });

  it('任务按 due 的本地日期落格', () => {
    const t = task({ id: 'a', due: at(2026, 8, 20) });
    const days = calendarDays([t], NOW, 'month');
    expect(days.find((d) => d.key === '2026-08-20')!.tasks.map((x) => x.id)).toEqual(['a']);
    expect(days.filter((d) => d.tasks.length).map((d) => d.key)).toEqual(['2026-08-20']);
  });

  // 时区陷阱：东八区当地 00:30 的任务，UTC 是前一天 16:30。用 toISOString().slice(0,10)
  // 会把它算到前一天去。这条只有本地日期写法才过。
  it('当地凌晨的任务算在当天，不是前一天', () => {
    const t = task({ id: 'a', due: at(2026, 8, 20, 0) }); // 当地 00:00
    const days = calendarDays([t], NOW, 'month');
    expect(days.find((d) => d.key === '2026-08-20')!.tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('没有 due 的任务不出现在任何一天', () => {
    const t = task({ id: 'a', due: null });
    expect(calendarDays([t], NOW, 'month').flatMap((d) => d.tasks)).toEqual([]);
  });

  it('due 解析不了当成没有 due，不抛也不乱落', () => {
    const t = task({ id: 'a', due: '下周三' });
    expect(calendarDays([t], NOW, 'month').flatMap((d) => d.tasks)).toEqual([]);
  });
});

describe('calendarDays：周视图', () => {
  it('7 天，从周一开始，outside 恒为 false', () => {
    const days = calendarDays([], NOW, 'week');
    expect(days).toHaveLength(7);
    expect(days[0].date.getDay()).toBe(1);
    expect(days.every((d) => !d.outside)).toBe(true);
  });
});

describe('shiftAnchor', () => {
  it('month +1 跨年不出错', () => {
    expect(dayKey(shiftAnchor(new Date(2026, 11, 15), 'month', 1))).toMatch(/^2027-01-/);
  });
  it('month -1 从 3 月 31 日退一个月不会跳成 3 月 3 日', () => {
    // 2 月没有 31 号：setMonth 会溢出成 3 月 3 日。必须先把 date 归 1。
    expect(dayKey(shiftAnchor(new Date(2026, 2, 31), 'month', -1))).toMatch(/^2026-02-/);
  });
  it('week ±1 就是 ±7 天', () => {
    expect(dayKey(shiftAnchor(new Date(2026, 7, 16), 'week', 1))).toBe('2026-08-23');
  });

  // I-2：原来这里用的是 8/31 + 1 天 = 9/1。代码评审证明了这条夹具是巧合——
  // 「day 分支被漏掉、落进 month 分支」这个变异算出来的答案*也*是 9/1（month
  // 分支的兜底算法是「先把日子归 1，再加一个月」，对最后一天的输入巧合出同一个
  // 结果），所以这条断言测不出真正的 bug。换成不落在月末的日子，两条路径的
  // 答案就不会撞车了。
  it('day +1 就是加一天', () => {
    expect(dayKey(shiftAnchor(new Date(2026, 7, 15), 'day', 1))).toBe('2026-08-16');
  });

  it('day -1 就是退一天', () => {
    expect(dayKey(shiftAnchor(new Date(2026, 7, 16), 'day', -1))).toBe('2026-08-15');
  });

  // 「day 分支跨月」这个点本身还值得测（证明用的是原生 setDate 的月末进位，
  // 不是手写的月份算术），但要挑一个不会跟「漏掉 day 分支、落进 month 分支」
  // 那个变异撞答案的方向：从月初退一天，正确答案是上个月最后一天（8/31），
  // 而 month 分支的兜底会给「上个月的 1 号」（8/1）——两条路径的答案不同，
  // 这条真的在验证分支选对了没有，不只是验证 setDate 本身。
  it('day -1 跨月：9/1 退一天到 8/31，不是掉进 month 分支的 8/1', () => {
    expect(dayKey(shiftAnchor(new Date(2026, 8, 1), 'day', -1))).toBe('2026-08-31');
  });
});

describe('calendarDays：日视图', () => {
  it('1 天，outside 恒为 false', () => {
    const days = calendarDays([], NOW, 'day');
    expect(days).toHaveLength(1);
    expect(days[0].key).toBe(dayKey(NOW));
    expect(days[0].outside).toBe(false);
  });
});

describe('isAllDay', () => {
  it('due 是当地零点 → 全天', () => {
    const t = task({ id: 'a', due: at(2026, 8, 16, 0) });
    expect(isAllDay(t)).toBe(true);
  });

  it('due 带具体时刻 → 不是全天', () => {
    const t = task({ id: 'a', due: at(2026, 8, 16, 9) });
    expect(isAllDay(t)).toBe(false);
  });

  // I-1：时/分/秒都是 0，只有毫秒不是——只判前三样、漏判毫秒的实现会在这条上
  // 露馅（之前四条夹具全用整秒时刻，毫秒那一位从没被单独测过）。
  it('due 时分秒是 0 但毫秒不是 → 不是全天', () => {
    const d = new Date(2026, 7, 16, 0, 0, 0, 500); // 当地 00:00:00.500
    expect(isAllDay(task({ id: 'a', due: d.toISOString() }))).toBe(false);
  });

  it('没有 due → 不是全天', () => {
    expect(isAllDay(task({ id: 'a', due: null }))).toBe(false);
  });

  it('due 解析不了 → 不是全天', () => {
    expect(isAllDay(task({ id: 'a', due: '下周三' }))).toBe(false);
  });
});

describe('daySlots', () => {
  // 只有「东八区」那一条会 stubEnv，这里统一收尾——不管是不是那一条跑过，
  // afterEach 对没 stub 过的情况是没事可做的空操作，写在 describe 级别比
  // 只在那一条测试里 try/finally 更不容易漏改（万一以后这个 describe 里
  // 再加一条也 stubEnv 的测试，不用记得再包一层 finally）。
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('恒 24 个小时槽，没任务的小时是空数组', () => {
    const days = calendarDays([], NOW, 'day');
    const slots = daySlots(days[0]);
    expect(slots.hours).toHaveLength(24);
    expect(slots.hours[5]).toEqual([]);
  });

  // C-1：这条测的是「用了 toISOString().slice(0,10) 切日期」这个 bug——那个 bug
  // 只在本地时区不是 UTC 时才会显形（UTC 机器上本地日期跟 UTC 日期天然相同，
  // 这道守卫在那种机器上无论实现对不对都会绿）。原来这条夹具默认跑测试的机器
  // 是东八区，实测过：`TZ=UTC` 跑这个文件会红（`hours[0]` 收到 `[]`），而这
  // 道守卫的意图是保证实现是对的，不是保证「凑巧在这台机器上测出来了」——
  // CI 换一台 UTC 机器它就会静默变成一道摆设的绿灯。
  //
  // 用 `vi.stubEnv('TZ', …)` 把这条测试自己的时区钉死在东八区，不依赖跑测试
  // 的机器实际在哪个时区——已经实测过 `vi.stubEnv('TZ', …)`/直接改
  // `process.env.TZ` 在这个仓库当前的 Node/vitest 组合下对 `Date`/`Intl`
  // 立即生效（这份仓库 Node 版本较新，不是所有 Node 版本都保证这一点，别的
  // 项目照抄这个写法之前自己验一遍）。钉死之后这道守卫在任何机器上跑都会
  // 落在东八区这个语境里，不会有「在某台机器上根本不可能失败」这种情况，
  // 所以不需要 skip 分支。
  it('东八区：UTC 16:30 落在本地下一天 00:30 那一格，不算全天', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    const t = task({ id: 'a', due: '2026-08-15T16:30:00.000Z' });
    const days = calendarDays([t], new Date(2026, 7, 16, 12), 'day');
    const day = days.find((d) => d.key === '2026-08-16')!;
    const slots = daySlots(day);
    expect(slots.hours[0].map((x) => x.id)).toEqual(['a']);
    expect(slots.allDay).toEqual([]);
  });

  it('全天的任务进 allDay，不进 0 点那个小时槽', () => {
    const t = task({ id: 'a', due: at(2026, 8, 16, 0) });
    const days = calendarDays([t], NOW, 'day');
    const slots = daySlots(days[0]);
    expect(slots.allDay.map((x) => x.id)).toEqual(['a']);
    expect(slots.hours[0]).toEqual([]);
  });

  // 夹具的小时故意不一样（0/9/23），别全用同一个值。
  it('不同小时的任务落进各自的小时槽', () => {
    const morning = task({ id: 'b', due: at(2026, 8, 16, 9) });
    const night = task({ id: 'c', due: at(2026, 8, 16, 23) });
    const days = calendarDays([morning, night], NOW, 'day');
    const slots = daySlots(days[0]);
    expect(slots.hours[9].map((x) => x.id)).toEqual(['b']);
    expect(slots.hours[23].map((x) => x.id)).toEqual(['c']);
    expect(slots.hours[9]).not.toBe(slots.hours[23]);
  });
});

/**
 * 日历显示设置（仿滴答清单）。判据本身在 repeatProjection.test.ts；这里测
 * `calendarDays` 这一层：两个开关有没有真的改变落格结果。
 */
describe('calendarDays：显示已完成 / 显示未来重复周期', () => {
  const ANCHOR = new Date(2026, 7, 17); // 2026-08-17，周一

  it('这一层的默认是「今天的行为」：不给 opts 就全都显示、不推演', () => {
    const done = task({ id: 'd', status: 'done', due: new Date(2026, 7, 17, 9).toISOString() });
    const days = calendarDays([done], ANCHOR, 'month');
    expect(days.find((d) => d.key === '2026-08-17')!.tasks.map((t) => t.id)).toEqual(['d']);
    expect(days.every((d) => d.marks.length === 0)).toBe(true);
  });

  it('showDone: false 时已完成的不落格', () => {
    const done = task({ id: 'd', status: 'done', due: new Date(2026, 7, 17, 9).toISOString() });
    const days = calendarDays([done], ANCHOR, 'month', { showDone: false });
    expect(days.find((d) => d.key === '2026-08-17')!.tasks).toEqual([]);
  });

  it('只挡已完成，搁置的照常显示——搁置是「暂时不想做」，它仍然占着那一天', () => {
    const later = task({ id: 'l', status: 'later', due: new Date(2026, 7, 17, 9).toISOString() });
    const days = calendarDays([later], ANCHOR, 'month', { showDone: false });
    expect(days.find((d) => d.key === '2026-08-17')!.tasks.map((t) => t.id)).toEqual(['l']);
  });

  it('showFutureRepeats：推演出来的落进 repeats，不混进 tasks', () => {
    const weekly = task({
      id: 'w', title: '开例会',
      due: new Date(2026, 7, 17, 9).toISOString(),
      repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null },
    });
    const days = calendarDays([weekly], ANCHOR, 'month', { showFutureRepeats: true });
    // 8/17 本体在 tasks 里，8/24 是推演出来的影子
    expect(days.find((d) => d.key === '2026-08-17')!.tasks.map((t) => t.id)).toEqual(['w']);
    expect(days.find((d) => d.key === '2026-08-17')!.marks).toEqual([]);
    expect(days.find((d) => d.key === '2026-08-24')!.marks.map((m) => m.kind)).toEqual(['repeat']);
    expect(days.find((d) => d.key === '2026-08-24')!.tasks).toEqual([]);
  });

  it('推演只算这一页看得见的那几天——翻页时重算，不是一次算三年', () => {
    const daily = task({
      id: 'd', title: '喝水',
      due: new Date(2026, 7, 17, 9).toISOString(),
      repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
    });
    const days = calendarDays([daily], ANCHOR, 'week', { showFutureRepeats: true });
    // 周视图七天，起点那天是本体，剩下六天各一个影子
    expect(days.reduce((n, d) => n + d.marks.length, 0)).toBe(6);
  });
});

describe('calendarDays：倒数纪念日落格', () => {
  const ANCHOR = new Date(2026, 7, 17);
  const c = {
    id: 'c1', title: '期末考', date: '2026-08-20', yearly: false, lunar: false,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  };

  it('不给 countdowns 就一格都没有——「显不显示」由调用方决定，这一层只认「给了就显示」', () => {
    expect(calendarDays([], ANCHOR, 'month').every((d) => d.marks.length === 0)).toBe(true);
    expect(calendarDays([], ANCHOR, 'month', { countdowns: [] }).every((d) => d.marks.length === 0)).toBe(true);
  });

  it('给了就落在那一天，跟 tasks 分开放——它不是任务', () => {
    const days = calendarDays([], ANCHOR, 'month', { countdowns: [c] });
    const day = days.find((d) => d.key === '2026-08-20')!;
    expect(day.marks.map((m) => `${m.kind}:${m.title}`)).toEqual(['countdown:期末考']);
    expect(day.tasks).toEqual([]);
  });
});

describe('calendarDays：专注记录 / 打卡落格', () => {
  const ANCHOR = new Date(2026, 7, 17);
  const focused = task({
    id: 'a', title: '写周报',
    focusSessions: [{ startedAt: new Date(2026, 7, 19, 14).toISOString(), minutes: 25 }],
  });
  const checked = task({
    id: 'h', title: '喝水', habit: true, status: 'done',
    repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 1, monthDay: null },
    completedAt: new Date(2026, 7, 19, 23, 47).toISOString(),
  });

  it('两个开关都不给就一格都没有——跟别的标记一样，默认不往日历上加东西', () => {
    expect(calendarDays([focused, checked], ANCHOR, 'month').every((d) => d.marks.length === 0)).toBe(true);
  });

  it('专注记录落在开始那天，带时长', () => {
    const day = calendarDays([focused], ANCHOR, 'month', { showFocus: true }).find((d) => d.key === '2026-08-19')!;
    expect(day.marks.map((m) => m.kind)).toEqual(['focus']);
    expect(day.marks[0].end).toBeTruthy();
  });

  it('深夜打的卡落在**当天**，不是第二天也不是前一天——只有日期的字符串按 UTC 解析会跑格', () => {
    const day = calendarDays([checked], ANCHOR, 'month', { showCheckins: true }).find((d) => d.key === '2026-08-19')!;
    expect(day.marks.map((m) => `${m.kind}:${m.title}`)).toEqual(['checkin:喝水']);
  });

  it('两个一起开时两种标记都在，各归各的格', () => {
    const day = calendarDays([focused, checked], ANCHOR, 'month', { showFocus: true, showCheckins: true })
      .find((d) => d.key === '2026-08-19')!;
    expect(day.marks.map((m) => m.kind).sort()).toEqual(['checkin', 'focus']);
  });
});

/**
 * 「放弃」这个状态是后加的，落格那行判断当时停在只认 `done`——一件已经决定
 * 不做的事继续占着日历上那一天。
 */
describe('calendarDays：已放弃的不落格', () => {
  const ANCHOR = new Date(2026, 7, 17);
  const due = new Date(2026, 7, 18, 9).toISOString();

  it('showDone 关着时，已放弃的跟已完成的一样不落格', () => {
    const days = calendarDays([
      task({ id: 'a', title: '做完了', status: 'done', due }),
      task({ id: 'b', title: '放弃了', status: 'abandoned', due }),
      task({ id: 'c', title: '还在', due }),
    ], ANCHOR, 'month', { showDone: false });
    const day = days.find((d) => d.key === '2026-08-18')!;
    expect(day.tasks.map((t) => t.title)).toEqual(['还在']);
  });

  it('**搁置的照常落格**——它仍然占着那一天，那是有意的', () => {
    const days = calendarDays([task({ id: 'a', title: '搁置了', status: 'later', due })],
      ANCHOR, 'month', { showDone: false });
    expect(days.find((d) => d.key === '2026-08-18')!.tasks.map((t) => t.title)).toEqual(['搁置了']);
  });

  it('showDone 开着时两个都回来', () => {
    const days = calendarDays([
      task({ id: 'a', title: '做完了', status: 'done', due }),
      task({ id: 'b', title: '放弃了', status: 'abandoned', due }),
    ], ANCHOR, 'month', { showDone: true });
    expect(days.find((d) => d.key === '2026-08-18')!.tasks).toHaveLength(2);
  });
});

/**
 * 第几周（ISO 8601）——滴答清单月视图每一行最左边、周视图表头最左边那个
 * 「35周」。
 *
 * 这个数字唯一的用途是跟别人对齐（「我们第 35 周交」），所以判据必须是 ISO
 * 那一份，不能是「1 月 1 日所在的周算第 1 周」那种自己数的。
 */
describe('isoWeek', () => {
  const w = (y: number, m: number, d: number) => isoWeek(new Date(y, m - 1, d));

  it('2026-08-25（滴答截图里那天）是第 35 周', () => {
    expect(w(2026, 8, 25)).toBe(35);
  });

  it('同一周里每一天都是同一个数——周一到周日', () => {
    const days = [24, 25, 26, 27, 28, 29, 30].map((d) => w(2026, 8, d));
    expect(new Set(days).size).toBe(1);
  });

  it('**跨年那两周按 ISO 算，不是按「1 月 1 日那周」**：ISO 说「一年的第 1 周是包含那年第一个周四的那一周」', () => {
    // 2027-01-01 是周五 → 那一周的周四落在 2026 年 → 它属于 2026 年的最后一周。
    expect(w(2027, 1, 1)).toBe(53);
    // 2027-01-04 是周一，那一周的周四是 1 月 7 日 → 2027 年第 1 周。
    expect(w(2027, 1, 4)).toBe(1);
  });

  it('**不看 weekStart**——那是一个跟别人对齐用的编号，换个人看就得是同一个数；设置里选周日开头只改屏幕上那七列怎么排', () => {
    // 2026-08-30 是周日。「周日开头」那一档下它是新一周的第一天，但 ISO 周
    // 恒从周一起算，它还属于第 35 周。
    expect(w(2026, 8, 30)).toBe(35);
    expect(w(2026, 8, 31)).toBe(36);
  });
});

describe('hourBand：周/日视图画哪一段小时', () => {
  const at = (h: number, m = 0) => new Date(2026, 7, 16, h, m).toISOString();
  const days = (...isos: string[]) =>
    calendarDays(isos.map((due, i) => task({ id: `t${i}`, due })), new Date(2026, 7, 16, 12), 'day');

  it('一件带时刻的都没有：就是默认那段 07-23，凌晨不白占高度', () => {
    expect(hourBand(days())).toEqual({ start: 7, end: 23 });
    expect(hourBand(days(at(9)))).toEqual({ start: 7, end: 23 });
  });

  it('**默认那段之外有事，带子张开到包住它**——这一条是这个设计的全部意义：看不见就等于没有，不该有东西躲在一条折叠带后面', () => {
    expect(hourBand(days(at(3)))).toEqual({ start: 3, end: 23 });
    expect(hourBand(days(at(23, 30)))).toEqual({ start: 7, end: 24 });
    expect(hourBand(days(at(0)))).toEqual({ start: 7, end: 23 }); // 本地零点 = 全天，见下一条
  });

  it('落在 h 点的画到 h+1——`end` 是开区间的右端，写成 h 的话那一行整条看不见', () => {
    expect(hourBand(days(at(23))).end).toBe(24);
    expect(hourBand(days(at(22))).end).toBe(23);
  });

  it('**全天任务不参与**：它们在上面那条全天带里，不占小时槽（本地零点就是这个应用表达「全天」的方式）', () => {
    expect(hourBand(days(at(0, 0)))).toEqual({ start: 7, end: 23 });
  });

  it('跨好几天一起算——周视图是七列，带子对整屏是同一段，不能每列各算各的', () => {
    const week = calendarDays(
      [task({ id: 'a', due: new Date(2026, 7, 10, 5).toISOString() }), task({ id: 'b', due: new Date(2026, 7, 14, 23, 15).toISOString() })],
      new Date(2026, 7, 16, 12), 'week',
    );
    expect(hourBand(week)).toEqual({ start: 5, end: 24 });
  });

  it('永远落在 0-24 之内', () => {
    const b = hourBand(days(at(0, 1), at(23, 59)));
    expect(b.start).toBeGreaterThanOrEqual(0);
    expect(b.end).toBeLessThanOrEqual(24);
  });
});

/**
 * **时间段**（`startAt` + `endAt`，仿滴答清单）——这个应用里唯一一个能在日历上
 * 占一段高度的东西。
 *
 * 落格判据只有一份：`calendarAnchor`。它给这个仓库原来那条「落格只看 `due`」
 * 开了唯一的例外，所以正反两面都得钉住——多开一格和少开一格都是错。
 */
describe('calendarAnchor：有时间段的按起点落格，其余看 due', () => {
  const block = (over: Partial<import('../types.js').Task> = {}) =>
    task({ id: 'b', due: at(2026, 8, 20, 15), startAt: at(2026, 8, 16, 9), endAt: at(2026, 8, 16, 12), ...over });

  it('有时间段：按起点，不是按 due', () => {
    expect(dayKey(calendarAnchor(block())!)).toBe('2026-08-16');
    expect(calendarAnchor(block())!.getHours()).toBe(9);
  });

  it('没有 endAt：照旧看 due——这是绝大多数任务，行为一个字不变', () => {
    const t = task({ id: 'x', due: at(2026, 8, 20, 15), startAt: at(2026, 8, 16, 9), endAt: null });
    expect(dayKey(calendarAnchor(t)!)).toBe('2026-08-20');
  });

  it('没有 startAt：endAt 单独存在不算时间段', () => {
    const t = task({ id: 'x', due: at(2026, 8, 20, 15), startAt: null, endAt: at(2026, 8, 16, 12) });
    expect(dayKey(calendarAnchor(t)!)).toBe('2026-08-20');
  });

  /**
   * **`endAt <= startAt` 当成没有时间段。** 那是一句自相矛盾的话，但校验器
   * 有意收下它（跟「开始晚于截止」同一条既有约定）——照它画会得到一个负高度
   * 的块。
   */
  it.each([
    ['结束早于开始', at(2026, 8, 16, 8)],
    ['结束等于开始', at(2026, 8, 16, 9)],
  ])('%s：不算时间段，退回看 due', (_n, endAt) => {
    expect(dayKey(calendarAnchor(block({ endAt }))!)).toBe('2026-08-20');
    expect(hasTimeBlock(block({ endAt }))).toBe(false);
  });

  it('两个都解析不出来、又没有 due：不落在任何一格', () => {
    expect(calendarAnchor(task({ id: 'x', due: null, startAt: '下周三', endAt: '下下周' }))).toBeNull();
  });

  it('calendarDays 真的把它落在起点那一天', () => {
    const days = calendarDays([block()], NOW, 'month');
    const on16 = days.find((d) => d.key === '2026-08-16');
    const on20 = days.find((d) => d.key === '2026-08-20');
    expect(on16!.tasks.map((t) => t.id)).toEqual(['b']);
    expect(on20!.tasks).toEqual([]);
  });

  it('daySlots 把它放进起点那个小时，不是 due 那个小时', () => {
    const days = calendarDays([block()], NOW, 'month');
    const slots = daySlots(days.find((d) => d.key === '2026-08-16')!);
    expect(slots.hours[9]!.map((t) => t.id)).toEqual(['b']);
    expect(slots.hours[15]).toEqual([]);
  });

  /**
   * **有时间段的一律不是全天**，哪怕 `due` 恰好是本地零点。把一场九点到
   * 十二点的会扔进全天那一条，等于把唯一有用的信息（几点到几点）丢掉。
   */
  it('isAllDay：有时间段就不是全天，哪怕 due 是本地零点', () => {
    const t = block({ due: at(2026, 8, 20, 0) });
    expect(isAllDay(t)).toBe(false);
    // 对照：把 endAt 摘掉，同一条就变回全天——证明上面那条不是靠别的原因过的。
    expect(isAllDay(task({ ...t, endAt: null }))).toBe(true);
  });
});

/**
 * **同一个锚点也得管到「带子画多宽」和「格子里怎么排」。**
 *
 * 上面那一族钉住的是落格，而落格对了不等于看得见：`hourBand` 和格内排序当时
 * 都还在直接读 `t.due`，两处都配着 `as string` 断言——**一条只有时间段、没有
 * 截止时间的任务在它们眼里 `due` 是 `null`**，而两处对 `null` 的反应都不是
 * 报错，是安静地给出一个错答案：
 *
 * - `hourBand`：`new Date(null)` **不是** Invalid Date，是 1970-01-01T00:00Z，
 *   在东八区取到 8 点，**恰好落在默认带 07-23 里**，于是带子不张开，那一条被
 *   切掉——`binByHour` 把它放进 5 点那一槽，屏幕上根本没有 5 点那一行。
 * - 格内排序：`Date.parse(null)` 是 NaN，`NaN || …` 落到后面的 `localeCompare`，
 *   于是**它按标题排**。
 *
 * 两条都不是「少一个功能」，是「有东西但不对」，而且都没有任何提示。
 */
describe('时间段：带子和格内排序走同一个锚点', () => {
  const iso = (d: number, h: number, m = 0) => new Date(2026, 7, d, h, m).toISOString();
  /** 一场会：只有时间段，没有截止时间——表单里三个日期选择器互相独立，这是
   *  「九点到十二点开会」最自然的输入方式。 */
  const meeting = (id: string, title: string, sh: number, sm: number, eh: number, em = 0) =>
    task({ id, title, due: null, startAt: iso(16, sh, sm), endAt: iso(16, eh, em) });
  const days1 = (...ts: import('../types.js').Task[]) => calendarDays(ts, NOW, 'day');

  it('**凌晨五点的会：带子张开到 5**——改之前它落在 5 点那一槽，而屏幕上没有 5 点那一行', () => {
    expect(hourBand(days1(meeting('m', '开会', 5, 0, 6))).start).toBe(5);
  });

  it('**深夜的会：带子张开到 24**——`end` 是开区间的右端，23 点那一行否则整条看不见', () => {
    expect(hourBand(days1(meeting('m', '开会', 23, 30, 23, 59))).end).toBe(24);
  });

  it('按起点算，不是按 due——一条 06:00 开始、18:00 截止的，带子从 6 开始', () => {
    const t = task({ id: 'x', due: iso(16, 18), startAt: iso(16, 6), endAt: iso(16, 7) });
    expect(hourBand(days1(t)).start).toBe(6);
  });

  it('**时间段要整段看得见**：22:00-23:30 那种，带子得盖到 24，不能从中间切掉', () => {
    expect(hourBand(days1(meeting('m', '开会', 22, 0, 23, 30))).end).toBe(24);
  });

  it('整点结束的不多要一行——12:00 结束的块占到 11 点那行的底，12 点那行是空的', () => {
    expect(hourBand(days1(meeting('m', '开会', 9, 0, 12))).end).toBe(23);
  });

  /**
   * **格子里的每一条都必须落在带子里。** 这是「看不见就等于没有」那句话的
   * 机械版：日后再加一个能决定落格的字段（`calendarAnchor` 改了、`daySlots`
   * 跟上了、`hourBand` 忘了），这一条就在这儿红，不用等谁去截屏。
   */
  it('清点：这一屏画出来的每一条，锚点都在带子之内', () => {
    // **默认带之外的只有那两场会**，故意不放一条凌晨到期的普通任务：放了的话
    // 带子会被它撑开，凌晨那场会顺带落进去，这一条就算 `hourBand` 退回只看
    // `due` 也照样绿——变异验证时真的这样绿过一次。
    const all = [
      meeting('m1', '晨会', 5, 0, 6),
      meeting('m2', '午会', 12, 0, 13),
      meeting('m3', '夜会', 23, 30, 23, 59),
      task({ id: 'd1', title: '交表', due: iso(16, 18) }),
      task({ id: 'a1', title: '全天', due: iso(16, 0) }),
    ];
    const days = calendarDays(all, NOW, 'day');
    const band = hourBand(days);
    let checked = 0;
    for (const d of days) {
      for (const t of d.tasks) {
        if (isAllDay(t)) continue;
        const h = calendarAnchor(t)!.getHours();
        expect(h, `「${t.title}」落在 ${h} 点，带子只画 ${band.start}-${band.end}`).toBeGreaterThanOrEqual(band.start);
        expect(h, `「${t.title}」落在 ${h} 点，带子只画 ${band.start}-${band.end}`).toBeLessThan(band.end);
        checked++;
      }
    }
    // 真的数过四条（全天那条不算），不是循环体一次都没进就绿了。
    expect(checked).toBe(4);
  });

  it('**格内按时刻排，有时间段的按起点**——改之前 `Date.parse(null)` 是 NaN，它退化成按标题排，实测排出过「晨跑 / 背单词 / 开会」', () => {
    const days = days1(
      task({ id: 's', title: '背单词', due: iso(16, 21) }),
      meeting('m', '开会', 9, 0, 12),
      task({ id: 'r', title: '晨跑', due: iso(16, 7) }),
    );
    expect(days[0].tasks.map((t) => t.title)).toEqual(['晨跑', '开会', '背单词']);
  });

  it('同一时刻的仍按标题定序——不留「顺序取决于读目录的顺序」那种排法', () => {
    const days = days1(
      meeting('b', '乙会', 9, 0, 10),
      task({ id: 'a', title: '甲事', due: iso(16, 9) }),
    );
    expect(days[0].tasks.map((t) => t.title)).toEqual(['甲事', '乙会']);
  });
});
