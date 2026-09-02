import type { Task } from '../types.js';
import { dueOverdue, isSettled, notStarted, sortByUrgency } from './taskView.js';
import type { GridSection } from '../components/TaskGrid.js';

/**
 * 「接下来」的六组。顺序是固定的，空组由 TaskGrid 自己滤掉。
 *
 * **第四组叫「7 天内」，不叫「本周内」。** 边界一直是 `endOfDay(now, 7)`——
 * 从此刻往后数七天，跟「这个日历周还剩几天」没有关系：周六看这一组，它装的是
 * 一路到下周六的任务，而「本周内」在人心里是到明天（周日）为止。那个名字说的
 * 是一件不成立的事。改叫「7 天内」还顺带对上了筛选栏里那一档——**同一个 7 天
 * 窗口原来在两处叫两个名字**（筛选栏一直写「7 天内」）。
 *
 * 判据一律看 `due`（不是 `remindAt`）——这两个字段在 AGENTS.md 里各管各的：
 * due 决定「过期了没有」，remindAt 决定「响不响」。议程回答的是前者。
 *
 * **第七组「还没开始」是从「没有时间」里分出来的。** 那一组原来同时装着两种
 * 意思完全相反的任务：「没截止日期，随时可以做」和「定了开始时间，现在还不能做」。
 * 后者正是 `startAt` 要消除的那个噪声（GTD 里那个 tickler），而它们全堆在一起的
 * 话，这个字段在这一屏上等于没有作用——`suggest.ts` 那边早就把它们排除了
 * （`notStarted` → `return false`），只有这里漏了。
 *
 * **只分「没有 due」那一支，有 due 的不动。** 一条「9 月 1 日开始、9 月 5 日截止」
 * 的任务，「你什么时候得处理它」的答案依然是那个截止日，它归 due 的桶是对的；
 * 卡片上那个「9 月 1 日 开始」的记号负责把剩下半句说完。
 */
/**
 * 「快到期」/「紧急」= `due` 落在这么多天内（含已过期）。**3 不是 7**：一周
 * 那档「接下来」视图已经有了，这一档要表达的是「再拖就来不及」。
 *
 * **两个消费方共用这一个数**：四象限「按时间 + 优先级」那套规则的横轴
 * （`cells.ts`），和行/卡上那颗到期 chip 的「快到期」样式（`dueChip.ts`）。
 * 它原来住在 `cells.ts`、只有四象限一个用户；搬到这儿是因为「N 天内算急」
 * 这件事跟四象限没有特殊关系，而这个仓库已经为「同一个界面上两种『N 天内』」
 * 栽过一次（见 `agendaSections` 上面那段「第四组叫 7 天内不叫本周内」）。
 *
 * OmniFocus 把这一档做成了可配的设置（`Due Soon` Means，默认 2 天）。这里
 * 先只给一个数：它跟四象限那条边界必须是同一个，做成设置就要同时决定
 * 「改了它四象限跟不跟着变」——那是一个产品问题，不是这一批要答的。
 */
export const URGENT_WITHIN_DAYS = 3;

export function endOfDay(now: Date, plusDays: number): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  // setDate 而不是加毫秒：加日历天数要是碰上夏令时切换的那个月，墙钟时间被
  // 跳过/重复的那一小时会让毫秒乘法多算/少算一小时（比如美东 3 月的春前夜）。
  // setDate 让 JS 自己按墙钟时间重新求 epoch，DST 自动对——中国没有 DST，
  // 这行现在测不出区别，但这个写法不比毫秒乘法贵，没理由留着不对的版本。
  d.setDate(d.getDate() + plusDays);
  return d.getTime();
}

/**
 * 按时间分成哪一档。**全站只此一份。**
 *
 * 「接下来」那一屏（`agendaSections`）和「全部/某个清单」上那个「按到期时间分组」
 * （`grouping.ts` 的 `dueBuckets`）分的是同一件事。两边原来各写一份，只共享了
 * `endOfDay`，靠一句注释（「同一套边界、同一批名字」）维持不变量——然后就真的
 * 飘了：「还没开始」那一组只加进了 `agendaSections`，于是同一条「9/1 才开始」的
 * 任务在「接下来」里归「还没开始」、在「全部」里归「没有时间」。
 *
 * 所以把分类本身抽成这一个函数，两边都调。各自只管自己那一半：议程那边要过滤
 * 已了结的、要排序、要给「还没开始」默认折起来；分组那边什么都不做。
 *
 * 解不出来的 `due` 当成「没有时间」，不是崩掉也不是当成过期——AI 写过
 * 「下周三」这种，`AGENTS.md` 明写 `dueTasks` 会静默跳过，这里同样口径。
 */
export type DueBucketKey = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'none' | 'notStarted';

/** 档位的顺序和名字。两边都读这一份，不各写一遍。 */
export const DUE_BUCKETS: ReadonlyArray<{ key: DueBucketKey; title: string }> = [
  { key: 'overdue', title: '已过期' },
  { key: 'today', title: '今天' },
  { key: 'tomorrow', title: '明天' },
  { key: 'week', title: '7 天内' },
  { key: 'later', title: '以后' },
  { key: 'none', title: '没有时间' },
  { key: 'notStarted', title: '还没开始' },
];

export function dueBucketOf(t: Task, now: Date): DueBucketKey {
  const dateless = (): DueBucketKey => (notStarted(t, now) ? 'notStarted' : 'none');
  if (!t.due) return dateless();
  const due = Date.parse(t.due);
  if (Number.isNaN(due)) return dateless();
  // **过期走 `dueOverdue`，不是裸的 `due < now`**。那个函数里有全天规则：本地零点
  // 的 due 在这个应用里的意思是「这一整天」，要过完那一天才算过期。裸比较是
  // 同一条判据的**第四份拷贝**，而且是没跟上全天规则的那份：一条今天零点到期
  // 的全天任务（从日历「安排任务」拖到今天那一格就会产生），卡片上不红、到期 chip
  // 说「今天」，这里却把它扔进「已过期」——实测出来的。
  // `isOverdue` 那段注释里已经记过一次同形的事故（dueChip 那份）。
  if (dueOverdue(t.due, now)) return 'overdue';
  if (due <= endOfDay(now, 0)) return 'today';
  if (due <= endOfDay(now, 1)) return 'tomorrow';
  if (due <= endOfDay(now, 7)) return 'week';
  return 'later';
}

/** 排序用的开始时刻。没有/解不出来的沉到最后。 */
const startTime = (t: Task): number => {
  const at = Date.parse(t.startAt ?? '');
  return Number.isNaN(at) ? Infinity : at;
};

export function agendaSections(tasks: Task[], now: Date, keep: Set<string>): GridSection[] {
  const buckets = new Map<DueBucketKey, Task[]>(DUE_BUCKETS.map((b) => [b.key, [] as Task[]]));

  for (const t of tasks) {
    // 已完成/已搁置的不进议程——跟 taskView.ts 里 isOverdue/isReminderOverdue/
    // isInTodayView 三个同族时间谓词是同一条口径（这两种都是人已经对这条任务
    // 做过判断了，不用再放在「该干哪个」的列表里烦他），App.tsx 的到期横幅
    // 也是同一条口径。但正在编辑的留下：把状态点成「已完成」/「搁置」的那一刻
    // 卡就该消失的话，编辑框会在手底下蒸发，跟 TodayView 那个坑同源。
    if (isSettled(t) && !keep.has(t.id)) continue;
    buckets.get(dueBucketOf(t, now))!.push(t);
  }

  return DUE_BUCKETS.map(({ key, title }) => {
    const rows = buckets.get(key)!;
    if (key !== 'notStarted') return { key, title, tasks: sortByUrgency(rows, now) };
    // 「还没开始」这一组两处跟别的不一样，都写在这儿：
    //
    // ① **排序按 `startAt` 升序**（快轮到的在前），不用 `sortByUrgency`——那个排的是
    //    `due`，而这一组每一条都没有 due，拿它排出来的顺序跟随机差不多。
    //    解不出来的时间沉底（NaN 归 Infinity）。
    // ② **默认折起来**，跟清单/标签视图里的「已完成」「已放弃」同一个理由（见
    //    TaskGrid 的 `startFolded`）：一个真把 tickler 用起来的人，这一组会长期堆着
    //    几十条，而它们正是他明确表示过「现在别烦我」的那几条。折起来加一个数字
    //    比整个藏掉本分，而一点就开。「接下来」没有 `onDropTo`（只有看板和四象限有），
    //    这个标志在这一屏真的生效。
    //
    // 排在最后（`DUE_BUCKETS` 的顺序）：上面那组「没有时间」是能现在做的，
    // 这组做不了——一份从上往下读的清单，做不了的该在底下。
    return {
      key,
      title,
      tasks: [...rows].sort((a, b) => startTime(a) - startTime(b)),
      startFolded: true,
    };
  });
}
