import { describe, expect, it } from 'vitest';
import { agendaSections } from './agenda.js';
import { dueOverdue } from './taskView.js';
import { task } from '../test-utils.js';
import type { Task } from '../types.js';

// 边界要测的是日历日（今天 23:59 vs 明天 00:01），不能用固定 UTC 'Z' 时间戳——
// 那样断言结果会跟着跑测试的机器时区飘，跟 taskView.test.ts 里 LOCAL_NOW/
// localIso 那条注释是同一条教训（agenda.ts 的 endOfDay 本来就是按本地
// setHours 算的，跟 isSameLocalDay 同一套「今天是日历上的今天」的语义）。
// NOW 和所有 due 都改用不带时区的本地 Date 构造。
const NOW = new Date(2026, 7, 14, 12, 0, 0);   // 周五
const localIso = (y: number, m: number, d: number, h = 0, mi = 0): string =>
  new Date(y, m - 1, d, h, mi).toISOString();

const t = (id: string, due: string | null, over: Partial<Task> = {}): Task =>
  task({ id, title: id, due, ...over });

const keyOf = (tasks: Task[], id: string, keep = new Set<string>()) =>
  agendaSections(tasks, NOW, keep).find((s) => s.tasks.some((x) => x.id === id))?.key;

describe('agendaSections', () => {
  it('七组顺序固定：已过期在最前，「还没开始」在最后', () => {
    const all = agendaSections([], NOW, new Set());
    expect(all.map((s) => s.key)).toEqual(['overdue', 'today', 'tomorrow', 'week', 'later', 'none', 'notStarted']);
  });

  it('昨天到期 → 已过期', () => {
    expect(keyOf([t('a', localIso(2026, 8, 13, 12, 0))], 'a')).toBe('overdue');
  });

  it('今天晚些 → 今天', () => {
    expect(keyOf([t('a', localIso(2026, 8, 14, 23, 0))], 'a')).toBe('today');
  });

  it('今天更早（已经过去了）→ 已过期，不是今天', () => {
    // 「今天」这一组是「今天还没到点的」，今早 9 点的事到中午已经是过期了
    expect(keyOf([t('a', localIso(2026, 8, 14, 9, 0))], 'a')).toBe('overdue');
  });

  it('明天 → 明天', () => {
    expect(keyOf([t('a', localIso(2026, 8, 15, 10, 0))], 'a')).toBe('tomorrow');
  });

  it('没有 due → 没有时间', () => {
    expect(keyOf([t('a', null)], 'a')).toBe('none');
  });

  it('时间解析不出来 → 没有时间，不是崩掉也不是当成过期', () => {
    // AGENTS.md 明写 AI 会写出「下周三」这种非 ISO 时间；这里跟 dueTasks
    // 一样的口径：静默归到「没有时间」，不是过期，也不能让整段解析崩掉。
    expect(keyOf([t('a', '下周三')], 'a')).toBe('none');
  });

  it('已完成的不进议程', () => {
    expect(keyOf([t('a', localIso(2026, 8, 15, 10, 0), { status: 'done' })], 'a')).toBeUndefined();
  });

  it('已完成但正在编辑的留下——不然改状态的时候卡当场消失', () => {
    const tasks = [t('a', localIso(2026, 8, 15, 10, 0), { status: 'done' })];
    expect(keyOf(tasks, 'a', new Set(['a']))).toBe('tomorrow');
  });

  it('搁置的任务不进议程——跟 isInTodayView/isOverdue/isReminderOverdue 三个同族谓词同一条口径，见 taskView.ts', () => {
    // 故意选一个过期日期：改之前 agendaSections 会把它塞进 overdue 组
    // （之前唯一没挡 later 的地方），这里要确认它现在哪个组都进不去。
    expect(keyOf([t('a', localIso(2026, 8, 13, 12, 0), { status: 'later' })], 'a')).toBeUndefined();
  });

  it('搁置但正在编辑的留下——不然点「取消搁置」的时候卡当场消失，跟 done 那条对称', () => {
    const tasks = [t('a', localIso(2026, 8, 15, 10, 0), { status: 'later' })];
    expect(keyOf(tasks, 'a', new Set(['a']))).toBe('tomorrow');
  });

  it('组内按紧急度排', () => {
    // due 故意让 b 比 a 早——期望顺序 ['b','a'] 跟 id 的字典序（'a','b'）
    // 相反：改成按 id 排、或者干脆不排，这条都会红，不会跟「巧合按 id 排」
    // 的残次实现混过去。
    const tasks = [t('a', localIso(2026, 8, 20, 10, 0)), t('b', localIso(2026, 8, 18, 10, 0))];
    const week = agendaSections(tasks, NOW, new Set()).find((s) => s.key === 'week')!;
    expect(week.tasks.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('七组各放一条边界值：key/title 都对，第 7/8 天不越界，展平后 id 不重复', () => {
    // 边界值而不是随便挑一个「明显在组里」的日子——这是唯一能钉住「7 天内」
    // 到底是第几天为止的写法：随便挑一个 8/18（第 4 天）测「7 天内」，一个
    // 横跨一个月的残次实现（把 weekEnd 算成 +30 天）照样能让它落进 week，
    // 测不出真正的分界线在第 7/8 天。
    const t0 = NOW.getTime();
    const tasks = [
      t('overdue', new Date(t0 - 60_000).toISOString()),      // t0 前一分钟
      t('today', localIso(2026, 8, 14, 23, 59)),               // todayEnd 前
      t('tomorrow', localIso(2026, 8, 15, 23, 59)),             // tomorrowEnd 前
      t('week', localIso(2026, 8, 21, 23, 0)),                  // 第 7 天，weekEnd 前
      t('later', localIso(2026, 8, 22, 0, 30)),                 // 第 8 天，weekEnd 后
      t('none', null),
      // 没有 due、但定了还没到的开始时间——这一条原来会跟上面那条挤在「没有时间」里。
      t('notStarted', null, { startAt: localIso(2026, 9, 1) }),
    ];
    const sections = agendaSections(tasks, NOW, new Set());
    expect(sections.map((s) => [s.key, s.title])).toEqual([
      ['overdue', '已过期'], ['today', '今天'], ['tomorrow', '明天'],
      ['week', '7 天内'], ['later', '以后'], ['none', '没有时间'],
      ['notStarted', '还没开始'],
    ]);
    // 每条任务的 id 跟它该落进的组同名——用这层锚点一次性验证六个桶各自
    // 只收对应边界值那一条，没有谁越界收错、也没有谁被漏收。
    for (const s of sections) expect(s.tasks.map((x) => x.id)).toEqual([s.key]);
    // 结构上（if/else-if 链 + continue）任务不可能同时进两个桶，这句是
    // 零成本的复核：展平后没有重复 id。
    const allIds = sections.flatMap((s) => s.tasks.map((x) => x.id));
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

/**
 * 「还没开始」这一组。它是从「没有时间」里分出来的——那一组原来同时装着
 * 「随时可以做」和「现在还不能做」两种意思相反的任务。
 */
describe('agendaSections：还没开始', () => {
  const soon = localIso(2026, 8, 20);   // 未来
  const past = localIso(2026, 8, 1);    // 已经到了

  it('没 due + 开始时间还没到 → 还没开始，不在「没有时间」里', () => {
    expect(keyOf([t('a', null, { startAt: soon })], 'a')).toBe('notStarted');
  });

  it('没 due + 开始时间已经到了 → 还是「没有时间」（现在真的能做了）', () => {
    expect(keyOf([t('a', null, { startAt: past })], 'a')).toBe('none');
  });

  it('没 due + 没开始时间 → 「没有时间」，跟以前一样', () => {
    expect(keyOf([t('a', null)], 'a')).toBe('none');
  });

  it('**有 due 的不动**——就算还没到开始时间，你得处理它的时间依然是那个截止日', () => {
    expect(keyOf([t('a', localIso(2026, 8, 15, 10, 0), { startAt: soon })], 'a')).toBe('tomorrow');
  });

  it('due 解不出来（AI 写了「下周三」）+ 还没开始 → 还没开始，不是「没有时间」', () => {
    // 解不出来的 due 当成「没有时间」是这个文件既有的口径（见 agenda.ts），
    // 分组这一步得跟着走到同一个分叉上——只改一支就是两条路各说各的。
    expect(keyOf([t('a', '下周三', { startAt: soon })], 'a')).toBe('notStarted');
  });

  it('组内按开始时间升序：快轮到的在前', () => {
    const tasks = [
      t('晚', null, { startAt: localIso(2026, 12, 1) }),
      t('早', null, { startAt: localIso(2026, 9, 1) }),
      t('中', null, { startAt: localIso(2026, 10, 1) }),
    ];
    const g = agendaSections(tasks, NOW, new Set()).find((s) => s.key === 'notStarted')!;
    expect(g.tasks.map((x) => x.id)).toEqual(['早', '中', '晚']);
  });

  it('默认折起来（startFolded），别的组不折——全折了等于把这一屏整个收起来', () => {
    const sections = agendaSections([t('a', null, { startAt: soon }), t('b', null)], NOW, new Set());
    expect(sections.find((s) => s.key === 'notStarted')!.startFolded).toBe(true);
    expect(sections.find((s) => s.key === 'none')!.startFolded).toBeUndefined();
  });

  it('已完成/搁置的照旧不进议程，不会因为新开一组就漏进来', () => {
    const tasks = [
      t('done', null, { startAt: soon, status: 'done' }),
      t('later', null, { startAt: soon, status: 'later' }),
    ];
    const g = agendaSections(tasks, NOW, new Set()).find((s) => s.key === 'notStarted')!;
    expect(g.tasks).toEqual([]);
  });
});


/**
 * **全天任务（本地零点的 due）在这一屏不算过期。**
 *
 * 零点在这个应用里的意思是「这一整天」（`isAllDayIso`），要过完那一天才算过期——
 * 卡片上那个红标签、到期 chip、服务端的每日概览三处都是这么算的。议程这里原来写的是
 * 裸的 `due < now`，是同一条判据的第四份拷贝、也是没跟上全天规则的那份：
 * 一条今天零点到期的任务，卡片上不红、chip 说「今天」，这里却把它扔进「已过期」。
 *
 * 从日历「安排任务」把一条没日期的任务拖到今天那一格，产生的正是这种值——不是边界奇谈。
 */
describe('agendaSections：全天任务的过期口径', () => {
  const bucketOf = (t: Task, now = NOW) =>
    agendaSections([t], now, new Set()).find((s) => s.tasks.length > 0)?.title;

  it('**今天零点**（全天）：归「今天」，不是「已过期」', () => {
    expect(bucketOf(t('a', localIso(2026, 8, 14, 0, 0)))).toBe('今天');
  });

  it('昨天零点（全天）：那一天已经过完了，算过期', () => {
    expect(bucketOf(t('a', localIso(2026, 8, 13, 0, 0)))).toBe('已过期');
  });

  it('今天 09:00（定了钟点）：下午十二点看就是过期了——全天规则只管零点那一种', () => {
    expect(bucketOf(t('a', localIso(2026, 8, 14, 9, 0)))).toBe('已过期');
  });

  it('跟卡片/chip 那边同一个函数：`dueOverdue` 说不过期，这里就不能归「已过期」', () => {
    const midnight = localIso(2026, 8, 14, 0, 0);
    expect(dueOverdue(midnight, NOW)).toBe(false);
    expect(bucketOf(t('a', midnight))).not.toBe('已过期');
  });
});
