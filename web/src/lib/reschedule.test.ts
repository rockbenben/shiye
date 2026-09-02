import { describe, it, expect } from 'vitest';
import {
  POSTPONE_MINUTES, postponePatch, reschedulePatch, snoozePatch, snoozeLabel, SNOOZE_CHOICES,
} from './reschedule.js';
import { SNOOZE_MINUTES } from '../../../desktop/src/notify.js';
import type { Task } from '../types.js';

/** 本地墙钟，理由同 smartInput.test.ts：算的是本地时区的「明天 18:00」。 */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();

const NOW = local(2026, 8, 22, 10, 0);

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', title: '交表', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
    reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
    createdAt: iso(2026, 8, 1), updatedAt: iso(2026, 8, 1),
    order: null, listId: null, section: null, tags: [], priority: 0, repeat: null,
    completedAt: null, postponeCount: 0, waitingFor: null, context: null,
    attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...over,
  };
}

describe('reschedulePatch', () => {
  it('原来几点还是几点——周五 18:00 推到明天是明天 18:00', () => {
    const t = task({ due: iso(2026, 8, 21, 18) });
    expect(reschedulePatch(t, 'tomorrow', NOW).due).toBe(iso(2026, 8, 23, 18));
  });

  it.each([
    ['today', iso(2026, 8, 22, 18)],
    ['tomorrow', iso(2026, 8, 23, 18)],
    ['nextWeek', iso(2026, 8, 29, 18)],
  ] as const)('%s', (to, want) => {
    expect(reschedulePatch(task({ due: iso(2026, 8, 21, 18) }), to, NOW).due).toBe(want);
  });

  it('原来没有截止时间：落在那天的 23:59，不是零点——零点会让它当天就被标成已过期', () => {
    expect(reschedulePatch(task(), 'tomorrow', NOW).due).toBe(iso(2026, 8, 23, 23, 59));
  });

  it('原来的截止时间坏掉（手改文件写了「下周三」）也当成没有，不写出 Invalid Date', () => {
    expect(reschedulePatch(task({ due: '下周三' }), 'today', NOW).due).toBe(iso(2026, 8, 22, 23, 59));
  });

  it('提醒跟着平移同样的量——只改 due 不动提醒等于让一条过期提醒下一个 tick 就炸出来', () => {
    const t = task({
      due: iso(2026, 8, 21, 18),
      reminders: [{ at: iso(2026, 8, 21, 17), firedAt: iso(2026, 8, 21, 17) }],
    });
    // due 挪了两天，提醒也挪两天，仍然比 due 早一小时
    expect(reschedulePatch(t, 'tomorrow', NOW).reminders)
      .toEqual([{ at: iso(2026, 8, 23, 17), firedAt: iso(2026, 8, 21, 17) }]);
    // firedAt 原样带上：服务端 applyTaskPatch 按时刻逐条比对，新时刻自然就是
    // 「还没提醒过」，章由它清，这一层不猜。
  });

  it('原来没有 due 就不动提醒——没有参照物，平移多少都是编的', () => {
    const t = task({ reminders: [{ at: iso(2026, 8, 21, 17), firedAt: null }] });
    expect(reschedulePatch(t, 'tomorrow', NOW).reminders).toBeUndefined();
  });

  it('提醒时刻坏掉的那条原样留着，不平移成 Invalid Date', () => {
    const t = task({ due: iso(2026, 8, 21, 18), reminders: [{ at: '下周三', firedAt: null }] });
    expect(reschedulePatch(t, 'tomorrow', NOW).reminders).toEqual([{ at: '下周三', firedAt: null }]);
  });

  it('reminders 不是数组（手改文件漏了方括号）也不炸', () => {
    const t = task({ due: iso(2026, 8, 21, 18), reminders: 'x' as unknown as Task['reminders'] });
    expect(reschedulePatch(t, 'tomorrow', NOW).reminders).toBeUndefined();
  });

  it('去掉截止时间只清 due，不连提醒一起清——两者各管各的', () => {
    const t = task({ due: iso(2026, 8, 21, 18), reminders: [{ at: iso(2026, 8, 21, 17), firedAt: null }] });
    expect(reschedulePatch(t, 'clear', NOW)).toEqual({ due: null });
  });
});

/**
 * 「推迟一小时」（仿滴答清单：批量选中之后一键往后挪一小时）。
 */
describe('postponePatch', () => {
  it('从这条任务自己的时间往后挪，不是从现在', () => {
    // NOW 是 8/22 10:00，任务的截止在 8/21 18:00——挪一小时应该是 8/21 19:00，
    // 不是「现在起一小时后」。
    const t = task({ due: iso(2026, 8, 21, 18) });
    expect(postponePatch(t, 60)!.due).toBe(iso(2026, 8, 21, 19));
  });

  it('提醒跟着挪同样的量', () => {
    const t = task({
      due: iso(2026, 8, 21, 18),
      reminders: [{ at: iso(2026, 8, 21, 17), firedAt: null }],
    });
    expect(postponePatch(t, 60)!.reminders).toEqual([{ at: iso(2026, 8, 21, 18), firedAt: null }]);
  });

  it('只有提醒、没有截止时间的也能推——不写 due 那个键，不凭空长出一个截止日期', () => {
    const t = task({ reminders: [{ at: iso(2026, 8, 21, 17), firedAt: null }] });
    const patch = postponePatch(t, 60)!;
    expect('due' in patch).toBe(false);
    expect(patch.reminders).toEqual([{ at: iso(2026, 8, 21, 18), firedAt: null }]);
  });

  it('两样时间都没有的返回 null——调用方据此跳过，不发一个什么都不改的写', () => {
    expect(postponePatch(task(), 60)).toBeNull();
  });

  it('时刻坏掉（手改文件）的那条原样留着，也不算「有时间」', () => {
    expect(postponePatch(task({ reminders: [{ at: '下周三', firedAt: null }] }), 60)).toBeNull();
  });
});

/**
 * ③ 「今天」那一档：算出来的时刻要是今天已经过去了，落 23:59。
 *
 * **这是「全部推到今天」那颗按钮能不能兑现的关键**：一条「前天 09:00」的任务
 * 下午三点被推到今天，按「原来几点还是几点」会落在今天 09:00——一个已经过去
 * 的时刻，任务当场又是过期的，「已过期」那一组按完还是原样。
 */
describe('reschedulePatch：改到今天，但那个钟点今天已经过去了', () => {
  const AFTERNOON = local(2026, 8, 22, 15, 0);

  it('过去的钟点落 23:59，不是原样搬到今天早上——不然「推到今天」等于什么都没做', () => {
    const t = task({ due: iso(2026, 8, 20, 9) });
    expect(reschedulePatch(t, 'today', AFTERNOON).due).toBe(iso(2026, 8, 22, 23, 59));
  });

  it('今天还没到的钟点照旧保留——「原来几点还是几点」那条没被推翻', () => {
    const t = task({ due: iso(2026, 8, 20, 18) });
    expect(reschedulePatch(t, 'today', AFTERNOON).due).toBe(iso(2026, 8, 22, 18));
  });

  it('正好等于此刻的也落 23:59——下一秒它就是过去', () => {
    const t = task({ due: iso(2026, 8, 20, 15) });
    expect(reschedulePatch(t, 'today', AFTERNOON).due).toBe(iso(2026, 8, 22, 23, 59));
  });

  it('**明天/下周不受影响**：那两个的落点永远在未来，这一支根本走不到', () => {
    const t = task({ due: iso(2026, 8, 20, 9) });
    expect(reschedulePatch(t, 'tomorrow', AFTERNOON).due).toBe(iso(2026, 8, 23, 9));
    expect(reschedulePatch(t, 'nextWeek', AFTERNOON).due).toBe(iso(2026, 8, 29, 9));
  });

  it('提醒跟着这个新时刻平移——顺带也不会在下一个 tick 就炸出来', () => {
    const t = task({
      due: iso(2026, 8, 20, 9),
      reminders: [{ at: iso(2026, 8, 20, 8), firedAt: null }],
    });
    const patch = reschedulePatch(t, 'today', AFTERNOON);
    // due 从 8/20 09:00 挪到 8/22 23:59，差多少提醒就挪多少：8:00 → 22:59。
    expect(patch.reminders).toEqual([{ at: iso(2026, 8, 22, 22, 59), firedAt: null }]);
  });

  it('本来就没有钟点的（落 23:59 的那批）行为一个字不变', () => {
    const t = task({ due: iso(2026, 8, 20, 23, 59) });
    expect(reschedulePatch(t, 'today', AFTERNOON).due).toBe(iso(2026, 8, 22, 23, 59));
  });
});

/**
 * 「稍后 10 分钟」。原来是「追加一条新的」，理由写着「原来那条盖过 `firedAt`，
 * 挪它不会再响」——**那个前提是错的**：服务端按时刻逐条比对来沿用旧章，`at`
 * 一变就配不上任何一条旧的、从「还没提醒过」重新算起。追加的代价是连按五次
 * 就攒下六条提醒、五条是死的。
 */
describe('snoozePatch', () => {
  const fired = (atIso: string, firedAt: string) => ({ at: atIso, firedAt });
  const TEN = iso(2026, 8, 22, 10, 10);

  it('把刚响过的那一条挪到十分钟后，不追加', () => {
    const t = task({ reminders: [fired(iso(2026, 8, 22, 9), iso(2026, 8, 22, 9))] });
    expect(snoozePatch(t, 10, NOW).reminders).toEqual([{ at: TEN, firedAt: null }]);
  });

  it('**别的提醒原样留着**——只动刚响的那一条', () => {
    const later = { at: iso(2026, 8, 23, 9), firedAt: null };
    const t = task({ reminders: [fired(iso(2026, 8, 22, 9), iso(2026, 8, 22, 9)), later] });
    expect(snoozePatch(t, 10, NOW).reminders).toEqual([{ at: TEN, firedAt: null }, later]);
  });

  it('好几条都响过：挪 firedAt 最新的那一条', () => {
    const old = fired(iso(2026, 8, 21, 9), iso(2026, 8, 21, 9));
    const fresh = fired(iso(2026, 8, 22, 9), iso(2026, 8, 22, 9, 30));
    const t = task({ reminders: [old, fresh] });
    expect(snoozePatch(t, 10, NOW).reminders).toEqual([old, { at: TEN, firedAt: null }]);
  });

  it('同一轮扫描盖了两条章（firedAt 一样）：取 at 靠后的那个', () => {
    const stamp = iso(2026, 8, 22, 9, 30);
    const early = fired(iso(2026, 8, 22, 8), stamp);
    const late = fired(iso(2026, 8, 22, 9), stamp);
    const t = task({ reminders: [early, late] });
    expect(snoozePatch(t, 10, NOW).reminders).toEqual([early, { at: TEN, firedAt: null }]);
  });

  it('**一条盖过章的都没有就退回追加**——什么都不做的话那颗按钮点了没反应', () => {
    const pending = { at: iso(2026, 8, 23, 9), firedAt: null };
    const t = task({ reminders: [pending] });
    expect(snoozePatch(t, 10, NOW).reminders).toEqual([pending, { at: TEN, firedAt: null }]);
  });

  it('连按五次只留一条——原来那条路每按一次多一条，五次之后编辑表单里六个日期选择器', () => {
    let t = task({ reminders: [fired(iso(2026, 8, 22, 9), iso(2026, 8, 22, 9))] });
    for (let i = 0; i < 5; i++) {
      // 每一轮模拟一次「服务端又把它发出去了」：盖上章再按下一次「稍后」。
      const next = snoozePatch(t, 10, NOW).reminders;
      t = task({ reminders: next.map((r) => ({ ...r, firedAt: iso(2026, 8, 22, 10, 10) })) });
    }
    expect(t.reminders).toHaveLength(1);
  });
});

/**
 * **横幅上那颗「稍后」的默认档，跟桌面通知上那颗必须同值。**
 *
 * 它们是同一个动作的两个入口：一条提醒到点，网页横幅和 Windows 通知会同时
 * 弹出来，人点哪个都行。推的量不一样的话，同一条提醒下一次响在什么时候，
 * 取决于他刚才点的是哪个窗口——那是坏数据，不是「两个壳各自的偏好」。
 *
 * **只钉第一档。** 网页那颗旁边有个小箭头能选 30 分钟和 1 小时（仿 Things 的
 * 10/30/60），桌面那条 toast 只有一档——Windows 的 toast 是一条转瞬即逝的横条，
 * 四颗按钮挤上去比没有更糟。那是超集，不是分叉：两边**点下去的默认结果**一样。
 *
 * 跨包引一个常量做对账，跟 `todayParity.guard.test.ts` 引服务端是同一条：
 * 这是测试，不是产品代码，rootDir 那条约束不受影响。`notify.ts` 不引 electron，
 * 单独 import 得动。
 */
describe('「稍后」的默认档：网页 ≡ 桌面通知', () => {
  it('第一档就是桌面那颗按钮推的量', () => {
    expect(SNOOZE_CHOICES[0]).toBe(SNOOZE_MINUTES);
  });

  it('三档是 10 / 30 / 60（仿 Things），加一档就来改这条', () => {
    expect([...SNOOZE_CHOICES]).toEqual([10, 30, 60]);
  });

  it('**跟卡片上那颗「推迟」不是一回事**——那是一小时，别看见两个数就去统一', () => {
    expect(POSTPONE_MINUTES).not.toBe(SNOOZE_CHOICES[0]);
  });

  it('六十分钟写成「1 小时」，不写「60 分钟」——没人那么说话', () => {
    expect(snoozeLabel(10)).toBe('10 分钟');
    expect(snoozeLabel(30)).toBe('30 分钟');
    expect(snoozeLabel(60)).toBe('1 小时');
  });

  it('每一档都有说得出口的文案——名单加一档时这条会替你验', () => {
    for (const m of SNOOZE_CHOICES) {
      expect(snoozeLabel(m), `${m} 分钟没有文案`).toMatch(/^\d+ (分钟|小时)$/);
    }
  });
});

/**
 * **一场只有时间段、没有截止时间的会。**
 *
 * 编辑表单里「开始时间 / 结束时间 / 截止时间」是三个互相独立、都能清空的选择器
 * （`TaskFields.tsx`），所以「九点到十二点开会」不填截止时间是最自然的输入方式
 * ——不是只有手改文件才到得了的形状。
 *
 * 在 `shiftTimesPatch` 之前，这个应用里三条「换个时间」的路各自只认 `due`，
 * 对这样一条会分别做出三件不同的错事：
 *
 * - `reschedulePatch`（⋯ 菜单「改期」、看板拖到「明天」那一列）：`prev === null`，
 *   于是**编出一个明天 23:59 的截止时间**，而那三个小时原地不动——日历上它还在
 *   原来那天，卡片上却多了一句他没说过的话。
 * - `postponePatch`（批量「推迟一小时」）：返回 `null`，**静默跳过**。它偏偏正是
 *   最该推迟的那一种（临时会议、堵车，推的就是这场会本身）。
 * - 月格拖拽（`CalendarView` 的 `onDropOnDay`）：`if (!t?.due) return`，**拖不动**。
 *
 * 三处现在共用一份平移，判据是 `calendarAnchor`——跟落格是同一个。
 */
describe('时间段：改期 / 推迟挪的是那场会，不是补一个 due', () => {
  /** 8/22（周六）九点到十二点开会，没有截止时间。`NOW` 是那天 10:00。 */
  const meeting = (over: Partial<Task> = {}) =>
    task({ title: '开会', due: null, startAt: iso(2026, 8, 22, 9), endAt: iso(2026, 8, 22, 12), ...over });

  it('**改到明天：整场挪过去，时长不变**', () => {
    const p = reschedulePatch(meeting(), 'tomorrow', NOW);
    expect(p.startAt).toBe(iso(2026, 8, 23, 9));
    expect(p.endAt).toBe(iso(2026, 8, 23, 12));
  });

  it('**不再凭空补一个 `due`**——那是他没说过的一句话', () => {
    expect(reschedulePatch(meeting(), 'tomorrow', NOW)).not.toHaveProperty('due');
    expect(postponePatch(meeting(), 60)).not.toHaveProperty('due');
  });

  it('有截止时间的，时间段和截止时间一起挪同样的量，间隔不变', () => {
    const p = reschedulePatch(meeting({ due: iso(2026, 8, 22, 18) }), 'tomorrow', NOW);
    expect(p.startAt).toBe(iso(2026, 8, 23, 9));
    expect(p.endAt).toBe(iso(2026, 8, 23, 12));
    // 位移按**起点**算（锚点），不是按 due——所以 18:00 也只挪一天，不是挪到别处。
    expect(p.due).toBe(iso(2026, 8, 23, 18));
  });

  it('**批量「推迟一小时」不再静默跳过它**', () => {
    const p = postponePatch(meeting(), POSTPONE_MINUTES);
    expect(p).not.toBeNull();
    expect(p!.startAt).toBe(iso(2026, 8, 22, 10));
    expect(p!.endAt).toBe(iso(2026, 8, 22, 13));
  });

  /**
   * **「改到今天」那条 23:59 兜底对有时间段的不适用。** 「今天之内做」是截止
   * 时间的说法；一场会没有「今天之内」，它就是九点到十二点。上午十点把一场
   * 今早九点的会「改到今天」，落在今天 09:00（一个已经过去的时刻）是如实的
   * ——那天的日历上它就在九点；改成 23:59-02:59 才是编。
   */
  it('改到今天：钟点原样保留，不落 23:59——哪怕那个时刻今天已经过去了', () => {
    const p = reschedulePatch(meeting(), 'today', NOW); // NOW 是 8/22 10:00，会在 09:00
    expect(p.startAt).toBe(iso(2026, 8, 22, 9));
    expect(p.endAt).toBe(iso(2026, 8, 22, 12));
  });

  it('对照：同一个时刻的**普通任务**照旧落 23:59——上面那一条不是把 ③ 整个拆了', () => {
    const t = task({ due: iso(2026, 8, 22, 9) });
    expect(reschedulePatch(t, 'today', NOW).due).toBe(iso(2026, 8, 22, 23, 59));
  });

  it('「去掉截止时间」不碰时间段：清掉的是「什么时候之前要做完」，不是那场会', () => {
    expect(reschedulePatch(meeting({ due: iso(2026, 8, 22, 18) }), 'clear', NOW)).toEqual({ due: null });
  });

  it('`endAt <= startAt` 不算时间段，退回原来那条只认 `due` 的路——跟 `hasTimeBlock` 同一个判据', () => {
    const bad = meeting({ due: iso(2026, 8, 22, 18), endAt: iso(2026, 8, 22, 8) });
    const p = reschedulePatch(bad, 'tomorrow', NOW);
    expect(p).not.toHaveProperty('startAt');
    expect(p.due).toBe(iso(2026, 8, 23, 18));
  });

  it('什么时间都没有的：三个字段一个都不写，`postponePatch` 仍然返回 null', () => {
    expect(postponePatch(task(), 60)).toBeNull();
  });

  it('提醒跟着一起平移——按锚点的位移算，不是按 due', () => {
    const p = reschedulePatch(meeting({ reminders: [{ at: iso(2026, 8, 22, 8, 30), firedAt: null }] }), 'tomorrow', NOW);
    expect(p.reminders).toEqual([{ at: iso(2026, 8, 23, 8, 30), firedAt: null }]);
  });
});
