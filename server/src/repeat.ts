import type { Reminder, Repeat, Subtask, Task } from './store.js';
import { holidayYearKnown, isLegalHoliday, isLegalWorkday, lunarOf, solarFromLunar } from './chineseDays.js';

/**
 * 从 `from` 出发的下一次。超过 `until` 返回 null。
 *
 * 全程用**本地墙钟**（`setDate`/`setMonth` 而不是加毫秒）：加日历天数碰上夏令时
 * 切换的那个月，被跳过/重复的那一小时会让毫秒乘法多算或少算一小时。中国没有
 * 夏令时测不出区别，但这个写法不比毫秒乘法贵，没理由留着不对的版本。
 * 同一条教训见 `web/src/lib/agenda.ts` 的 `endOfDay`。
 */
/**
 * 艾宾浩斯记忆法的间隔，单位是天。
 *
 * 滴答清单帮助文档给的是**累计天数**：「1，2，4，7，15，15，15……」，配一句
 * 「在学习的当天（一）、第二天（二）、第四天（四）、第七天（七）复习」。
 * 这个函数要的是**相邻两次之间的间隔**，所以要做一次差：
 * 1→2 差 1，2→4 差 2，4→7 差 3，7→15 差 8，之后每次 +15。
 *
 * 所以表是 `[1, 2, 3, 8]`，走完之后恒用 `EBBINGHAUS_TAIL`。写死这四个数而不是
 * 存累计值再现算，是因为一条重复任务只知道自己「走到第几步」（`repeat.step`），
 * 不知道最初那一天是哪天——累计天数在这个模型里没有参照点。
 */
export const EBBINGHAUS_GAPS = [1, 2, 3, 8];
export const EBBINGHAUS_TAIL = 15;

/** 第 `step` 次复习之后，隔几天再来。越界（走过表尾）落 `EBBINGHAUS_TAIL`。 */
export const ebbinghausGap = (step: number): number => {
  const i = Number.isInteger(step) && step >= 0 ? step : 0;
  return EBBINGHAUS_GAPS[i] ?? EBBINGHAUS_TAIL;
};

export function nextOccurrence(rule: Repeat, from: Date): Date | null {
  // Invalid Date 进来：`NaN.getDay()` 是 NaN，`weekdays` 分支的 `sorted.includes(NaN)`
  // 恒为 false，`do...while` 永远转不出来，会把整个 Node 进程挂死。目前唯一的调用方
  // （`nextInstance`）在调用前已经用 `Number.isNaN(base.getTime())` 挡过一次，但这个
  // 函数本身是 export 的，下一个调用方不一定会记得也挡一遍。
  if (Number.isNaN(from.getTime())) return null;

  const n = Math.max(1, rule.interval ?? 1);
  const d = new Date(from);

  if (rule.every === 'ebbinghaus') {
    // 间隔按遗忘曲线走，跟 interval 无关——这一档下那个字段没有意义。
    d.setDate(d.getDate() + ebbinghausGap(rule.step ?? 0));
  } else if (rule.every === 'day') {
    d.setDate(d.getDate() + n);
  } else if (rule.every === 'week') {
    const days = (rule.weekdays ?? []).filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
    if (days.length === 0) {
      d.setDate(d.getDate() + 7 * n);
    } else {
      // 指定了星期几：走到**下一个**命中的星期几。「每周一三五」从周五出发该
      // 落到下周一，不是下下周五——所以是逐天找，不是整周跳。
      const sorted = [...new Set(days)].sort((a, b) => a - b);
      do { d.setDate(d.getDate() + 1); } while (!sorted.includes(d.getDay()));

      // **`interval > 1` 时还要跳过中间那 n-1 周。** 这一段原来完全不看 `n`：
      // 「每 2 周的周一三五」实际是**每周**都走（实测：9/7 起是 9/9 → 9/11 →
      // 9/14 → 9/16 → 9/18，第二周一次都没跳过），而卡片上的说明写着「每 2 周的
      // 周一三五」、导出的 RRULE 也带过 `INTERVAL=2`——三处各说各的。
      //
      // **周边界用规则自己的锚点算，不用 `Settings.weekStart`**：那是每台机器的
      // 显示偏好（`app.ts` 里默认周一，可改成周日/周六），一条重复任务的节奏不该
      // 因为换了台机器、或者他把日历改成周日开头就跟着变。这里取名单里最小的
      // 那个星期几当这一组的起点——「每 2 周的周一三五」就是以周一为界的两周一组。
      if (n > 1) {
        const anchor = sorted[0];
        // 这次落点相对它所在那一组起点的偏移，跟出发点那一组起点比：跨过组界
        // 就把中间的 n-1 组整个跳掉。
        const groupStart = (x: Date): number => {
          const c = new Date(x);
          c.setHours(0, 0, 0, 0);
          c.setDate(c.getDate() - ((c.getDay() - anchor + 7) % 7));
          return c.getTime();
        };
        const fromStart = groupStart(from);
        if (groupStart(d) !== fromStart) d.setDate(d.getDate() + 7 * (n - 1));
      }
    }
  } else if (rule.every === 'workday' || rule.every === 'holiday') {
    /**
     * **法定工作日 / 法定节假日**：逐天往前走，数够 `interval` 个命中的日子。
     *
     * 不能像别的档那样一步算出来——这两档跟着**每年的放假通知**走，不是一条
     * 等间隔的规律。「下一个工作日」在十一之前是明天，在九月三十号是十月八号。
     *
     * **走出表的边界就收工**（返回 `null`，这条重复到此为止）。`chinese-days`
     * 对表外的日期一律答「要上班」，照它往下排会把 2027 年的国庆安静地排成
     * 工作日——一个看起来像答案的错答案。判据在 `chineseDays.ts`，那儿写着
     * 为什么这张表有边界而农历没有。
     *
     * 上界 20000 天是防死循环的兜底，不是对数据的预期：真正让它停下来的是
     * 上面那道年份检查，从任何一个现实的起点出发都在四百天内就会撞到。
     */
    const hit = rule.every === 'workday' ? isLegalWorkday : isLegalHoliday;
    let left = n;
    for (let guard = 0; left > 0; guard++) {
      if (guard >= 20000) return null;
      d.setDate(d.getDate() + 1);
      if (!holidayYearKnown(d.getFullYear())) return null;
      if (hit(d)) left--;
    }
  } else if (rule.every === 'lunar-year' || rule.every === 'lunar-month') {
    /**
     * **农历每年 / 每月**：把这一条落在农历的哪一天算出来，加上 `interval`
     * 个农历年/月，再换回公历。
     *
     * **锚点跟公历月重复共用 `monthDay`**（这一档下它记的是农历的号数）。
     * 理由一模一样：农历月也有大小月，「九月三十」在小月那年会被截到廿九，
     * 只看当前这条的日号的话下一次就从廿九算起，**永久漂掉一天**。
     * 那个字段上面的注释讲的就是这件事，这儿沿用，不新加一个字段。
     *
     * `solarFromLunar` 自己负责「那天不存在就截到当月最后一天」和往返验证
     * ——`getSolarDateFromLunar('2027-09-30')` 不报错，它会安静地滚到十月初一
     * （实测），不验的话这条重复会漂进下个月。
     *
     * **不设年份闸门**：农历是算出来的（天文算法 + 一张压缩月表），往后几十年
     * 都成立，跟上面那两档「发布出来的」数据不是一回事。换不出来（表真的到头
     * 了）返回 `null`。
     */
    const base = lunarOf(d);
    const anchorDay = rule.monthDay ?? base.day;
    let ly = base.year;
    let lm = base.month;
    if (rule.every === 'lunar-year') {
      ly += n;
    } else {
      const zero = (lm - 1) + n;          // 换成 0..11 再进位，省掉一次边界特判
      ly += Math.floor(zero / 12);
      lm = (zero % 12) + 1;
    }
    const solar = solarFromLunar(ly, lm, anchorDay);
    if (!solar) return null;
    // **先归到 1 号再整体设**：直接 setFullYear(y, m, d) 时，当前日号比目标月的
    // 天数大就会溢出到下个月（跟下面 `month` 分支防的是同一件事）。
    // 时刻不动——这一档只换日期，几点还是几点。
    d.setDate(1);
    d.setFullYear(solar.getFullYear(), solar.getMonth(), solar.getDate());
  } else if (rule.every === 'month') {
    // setMonth 会溢出：1/31 加一个月变成 3/3。先记住日号，加完月份如果日号
    // 变了（说明溢出了），退回到目标月的最后一天。
    //
    // **锚点优先读 `rule.monthDay`，不是当前这条的日号。** 只看当前日号的话，
    // 「每月 31 号」过一次二月就永久漂了：31 号 clamp 到 2/28，下一次从 28
    // 算起，三月就成了 28 号，再也回不去。`monthDay` 记着他定的那一天，
    // 二月照旧 clamp，三月能回到 31。没记过（这个字段之前的数据、或者在表单里
    // 点出来的月重复）就退回当前日号，跟以前一字不差。
    const day = rule.monthDay ?? d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  } else {
    // year：闰日同理，2/29 的下一年退到 2/28
    const day = d.getDate();
    const month = d.getMonth();
    d.setDate(1);
    d.setFullYear(d.getFullYear() + n);
    const last = new Date(d.getFullYear(), month + 1, 0).getDate();
    d.setMonth(month);
    d.setDate(Math.min(day, last));
  }

  // interval 大到把日历算出 Date 的表示范围之外（比如手滑/AI 写了个
  // interval: 99999999），setDate/setFullYear 不会抛，只会悄悄把 d 变成
  // Invalid Date——不挡的话下面 d.getTime() 是 NaN，NaN <= x 恒 false，
  // nextInstance 的循环会把它当成「已经不用再跳过期周期」直接放行，最后
  // d.toISOString() 才炸出 RangeError，而调用方（PATCH /api/tasks/:id）
  // 离这里已经隔了两层，只能看见一个 500，任务卡在 todo 上完不成。
  // 退化成「不生成下一条」，跟 until 解析不了/过期是同一种失败方向。
  if (Number.isNaN(d.getTime())) return null;

  if (rule.until) {
    const until = Date.parse(rule.until);
    // 解析不了的 until 当成「没有截止」，不是当成「已经过期」——后者会让
    // 一条重复任务因为一个手滑的字符串永久停摆，而且不会有任何提示。
    if (!Number.isNaN(until) && d.getTime() > until) return null;
  }
  return d;
}

/**
 * 完成一条重复任务时，造出下一条。不该生成就返回 null。
 *
 * 完成的那条**留在原地不动**（还是 done），这里只造新的——历史留得住，
 * 「已完成」视图里看得到上一次做了。
 */
/**
 * 「走到下一次」这一步——**完成和跳过共用**。
 *
 * 抽出来是因为跳过本次（`skipPatch`）跟完成（`nextInstance`）算的是同一件事：
 * 下一次落在哪、提醒该整体挪多少。两处各写一份的话，`from: 'done'`、拖过
 * 好几个周期、提醒对齐 due 这三条极容易的分歧会悄悄漂开。
 */
/**
 * 把一个时刻整体平移 `delta` 毫秒。没有 / 解析不了的原样返回。
 *
 * `startAt` 和 `endAt` 共用——它们是「时间段」的两端，平移的量必须一样，
 * 各写一份的话下一次实例的时长会悄悄变。
 */
function shift(iso: string | null, delta: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t + delta).toISOString();
}

function advance(t: Task, at: Date): { next: Date; delta: number } | null {
  if (!t.repeat) return null;
  // 「按次数结束重复」（滴答清单的说法）。`count` 存的是**还要再重复几次**，
  // 0 就是「这是最后一条」。判在最前面：算完下一次日期再发现次数用完了，
  // 白算一遍，而且下面每一条分支都要多带一个「其实不该生成」的状态。
  // `count` 缺失（加这个字段之前的老数据）是 `undefined`，`=== 0` 不成立，
  // 走「一直重复」那条，行为跟加它之前一字不差。
  if (t.repeat.count !== null && t.repeat.count !== undefined && t.repeat.count <= 0) return null;

  // 基准点：`repeat.from` 说了算，仿滴答清单的「到期重复 / 完成重复」。
  // - `'due'`（默认）：按 due 推，周期不漂——一条「每周一」的任务拖到周三才
  //   做完，下一次还该是下周一，不是下下周三。
  // - `'done'`：按完成时刻推——「每三天健身一次」周五耽搁了、周六才做，
  //   下一次就该是周二。这种任务的间隔是「离上次做完过了多久」，钉在原来的
  //   日历格子上反而是错的。
  // 两种都在没有 due 时退回按完成时刻推：没有 due 就没有别的基准可选。
  // 跳过走的是同一条：`at` 那时是「按下跳过的时刻」而不是完成时刻，但
  // 「离上一次动它过了多久」这个语义仍然成立，也没有别的参照可用。
  const base = t.repeat.from === 'done' || !t.due ? new Date(at) : new Date(t.due);
  if (Number.isNaN(base.getTime())) return null;

  // 拖过不止一个周期的（due 三周前的「每天」任务），推一次还是过去——新实例
  // 会「出生即过期」，下一个 tick 就被 reminder.ts 的 isDue（没有下界）当成
  // 迟到通知立刻炸出去。跳到 `at` 之后的下一次；下面的 delta 按「最终的 next」
  // 算，一次性带过所有跳过的周期，提醒平移的量跟 due 平移的量对得上。
  // 上界防真的转不出来的排列——这个模块已经证明过一次真实的死循环形状
  // （见 nextOccurrence 顶部 Invalid Date 的守卫），不留没有上界的 while。
  let next = nextOccurrence(t.repeat, base);
  for (let guard = 0; next && next.getTime() <= at.getTime(); guard++) {
    if (guard >= 1000) return null;
    next = nextOccurrence(t.repeat, next);
  }
  if (!next) return null;

  // 提醒平移多少：**跟 due 平移的量对齐，不是跟 base**。两者只在完成重复
  // （`from: 'done'`，base 是完成时刻而不是 due）时才会不同——那时候按 base
  // 算会让「截止前一小时提醒」变成截止之后才响：due 从周一 09:00 跳到周二
  // 15:00，而提醒只被推了「三天」。以 due 的位移为准，提醒相对 due 的偏移量
  // 才守得住。没有 due 的任务没有这个参照，退回按 base 算，跟原来一样。
  const oldDue = t.due ? Date.parse(t.due) : NaN;
  return { next, delta: next.getTime() - (Number.isNaN(oldDue) ? base.getTime() : oldDue) };
}

/**
 * 规则本身往前走一格：次数减一、艾宾浩斯的步数加一。**完成和跳过共用**。
 *
 * 跳过也减次数、也进步数，是一个有意的判断：「还要再重复几次」数的是**这个
 * 日程还剩几次**，不是「我还要做几次」——一门上五次的课，翘掉一次也还是在
 * 那五个日子里结束。艾宾浩斯同理，跳过一次复习之后按下一档间隔走；想改成
 * 「没复习就原地重来」，改这一处即可。
 */
/**
 * 带给下一条的重复规则：次数减一、艾宾浩斯步数加一，**外加把月重复的锚点补上**。
 *
 * `anchorDay` 是这一条 `due` 落在几号。只在 `every: 'month'` 且 `monthDay` 还
 * 没记过时写进去——那一天正是他自己定的锚，不用迁移、也不用在表单里多摆一个
 * 控件。记了之后不再改：`monthDay` 一旦有值，就是「这条月重复认哪一号」的
 * 唯一出处，让后面的 clamp 有个回得去的地方（见 `nextOccurrence` 里 month 那支）。
 */
const stepRepeat = (r: Repeat, anchorDay?: number): Repeat => ({
  ...r,
  ...(r.count === null || r.count === undefined ? {} : { count: r.count - 1 }),
  ...(r.every === 'ebbinghaus' ? { step: (r.step ?? 0) + 1 } : {}),
  ...(r.every === 'month' && (r.monthDay === null || r.monthDay === undefined) && anchorDay
    ? { monthDay: anchorDay }
    : {}),
});

/** 这条任务的 `due` 落在几号。没有 due / 解析不了就是 `undefined`。 */
const dueDay = (t: Task): number | undefined => {
  if (!t.due) return undefined;
  const ms = Date.parse(t.due);
  return Number.isNaN(ms) ? undefined : new Date(ms).getDate();
};

/**
 * 跳过本次（仿滴答清单重复任务的「跳过」）——返回一个 `PATCH /api/tasks/:id`
 * 就能用的补丁，不该跳就返回 `null`。
 *
 * **跟完成的根本区别：这条记录本身往前挪，不产生新记录。** 完成会把做完的那条
 * 留在原地、另造一条新的，历史留得住；跳过什么都没发生过——没有 `completedAt`、
 * 没有一条「已完成」的记录、习惯的连续天数一天都不加（那是从 `completedAt` 推
 * 出来的，见 `web/src/lib/habit.ts`）。这正是它存在的理由：今天不想做那次跑步，
 * 又不愿意为了不断掉打卡记录去按一下「完成」。
 *
 * 因为是同一条记录往前挪，`focusSessions` / `postponeCount` **原样留着**——
 * 那是「这条任务上花过的时间、拖过几次」，不随某一次occurrence作废。
 * `subtasks` 反过来要重置：勾掉的那两项属于被放弃的那一次。
 *
 * 没有 `due` 的重复任务返回 `null`：屏幕上没有任何东西会变（没有日期可挪），
 * 一个点了看不出发生了什么的菜单项比没有更糟。
 */
export interface SkipPatch {
  // 不是 `Pick<Task, …>`：那份的 `due`/`repeat` 都可空，而跳过永远落在一个
  // 具体的日期和一条具体的规则上——可空的类型会让每个调用点都多一次没有
  // 意义的判空。
  due: string;
  reminders: Reminder[];
  subtasks: Subtask[];
  repeat: Repeat;
  /**
   * 时间段的两端跟着 `due` 一起平移。**没有时间段就是 `null`**（不是缺这两个键）：
   * 缺键的话 `applyTaskPatch` 那条「只挪 startAt 就补 endAt」的补偿分支会以为
   * 调用方没提，而这里其实是明确说了「没有」。
   */
  startAt: string | null;
  endAt: string | null;
}

export function skipPatch(t: Task, at: Date): SkipPatch | null {
  if (!t.due || !t.repeat) return null;
  const step = advance(t, at);
  if (!step) return null;
  return {
    due: step.next.toISOString(),
    reminders: t.reminders.map((r) => {
      const ms = Date.parse(r.at);
      return { at: Number.isNaN(ms) ? r.at : new Date(ms + step.delta).toISOString(), firedAt: null };
    }),
    subtasks: t.subtasks.map((s) => ({ ...s, done: false })),
    repeat: stepRepeat(t.repeat, dueDay(t)),
    // **时间段跟着走**，用的是同一个 `step.delta`——跟 `nextInstance` 那两行
    // 一模一样的做法和理由（见 `shift` 的注释：两端平移的量必须一样）。
    //
    // 少了这两行，跳过一次会议之后 `due` 走到下周、而 `startAt`/`endAt` 还钉在
    // **刚被跳过的那一周**。`calendarAnchor` 有时间段时按起点落格，于是日历上
    // 那场会仍然画在已经跳过的那次，每跳一次错得更远。实测复现过：走
    // `POST /api/tasks/:id/skip`，due 到了 9/11，startAt/endAt 还是 9/4。
    //
    // `applyTaskPatch` 里那条「只挪 startAt 就补 endAt」的补偿分支救不了这里——
    // 它的条件是 `!('startAt' in patch) || 'endAt' in patch` 就退出，而这个 patch
    // 原来一个都不带。
    startAt: shift(t.startAt, step.delta),
    endAt: shift(t.endAt, step.delta),
  };
}

/**
 * 完成这一下之后，下一条会不会生成、落在哪天。
 *
 * **给界面报一句「下次 X」用的**（`web/src/lib/undoDone.ts`）：点完成，那张
 * 卡当场消失，一条「每周一交周报」看不出下一条到底生没生成、生在哪天——而
 * 那正是重复任务最需要当场确认的一件事。
 *
 * 两个字段是两件事，不能用「`due` 是不是 null」代替：
 * - `spawns` 为假 = **真的不会有下一条**（不重复、或者「按次数结束重复」的
 *   次数用完了，这是最后一次）。
 * - `spawns` 为真、`due` 是 `null` = 下一条会生成，但**它没有日期**——原来那条
 *   就没有 `due`，`nextInstance` 那边同样是 `due: done.due ? … : null`。这时候
 *   报不出「下次几号」，但「下一条排上了」这件事仍然要说。
 *
 * 跟 `nextInstance` 共用 `advance`，不另算一遍：两处一旦分头算，`from: 'done'`、
 * 拖过好几个周期这几条会悄悄漂开（那正是 `advance` 被抽出来的原因）。这里
 * 不直接调 `nextInstance` 是因为它要 `randomUUID` 造一条完整的任务，而这儿
 * 只想要一个日期。
 */
export interface NextAfterDone {
  spawns: boolean;
  due: string | null;
}

export function nextAfterDone(t: Task, at: Date): NextAfterDone {
  const step = t.repeat ? advance(t, at) : null;
  if (!step) return { spawns: false, due: null };
  return { spawns: true, due: t.due ? step.next.toISOString() : null };
}

export function nextInstance(done: Task, at: Date): Task | null {
  if (!done.repeat) return null;
  const step = advance(done, at);
  if (!step) return null;
  const { next, delta } = step;
  // `at` 就在手边：这条实例诞生的时刻，语义上就是完成的时刻，没有理由再读
  // 一次系统时钟——那样会让这个函数变成不可测的非纯函数（`randomUUID` 是
  // 必需的不纯，这个不是）。
  const iso = at.toISOString();

  return {
    ...done,
    // globalThis.crypto.randomUUID——不是 node:crypto 的 randomUUID：这个函数是
    // server/src/mutate.ts 那批平台无关纯函数的一环，node **19+**（不是 18——
    // 18 需要 `--experimental-global-webcrypto` 才有全局 crypto，19 起才默认开）
    // 和浏览器都有 globalThis.crypto；这个仓库 package.json 的 engines.node
    // 是 ">=24.0.0"，所以对这个项目没有实际影响。import 'node:crypto' 会让
    // 这个模块没法被 web 那边引用。
    id: globalThis.crypto.randomUUID(),
    // 原来没有 due 的，不该因为重复了一次就凭空长出一个截止日期
    due: done.due ? next.toISOString() : null,
    // 开始时间跟提醒一样**整体平移同样的量**。不平移的话（`...done` 原样带
    // 过去）每一次实例都背着上一次的开始时间：一条「每月 10 号开始」的任务，
    // 下个月那条还写着上个月 10 号——而那个时刻早就过去了，于是「还没开始」
    // 这个记号从第二次起就再也不出现，这个字段等于只在第一条上有效。
    // 没设开始时间的原样是 null，跟上面 due 那条同一个态度：不凭空长出来。
    startAt: shift(done.startAt, delta),
    // 结束时刻跟开始时刻**平移同样的量**（滴答清单的「时间段」）：一场每周
    // 九点到十二点的会，下一条也该是九点到十二点。不平移的话新实例会背着
    // 上一次的结束时刻，时间段整个错位——跟 `startAt` 那条一模一样的道理，
    // 所以两处共用 `shift`，不是两份几乎一样的三元。
    endAt: shift(done.endAt, delta),
    // 提醒整体平移同样的量，章全部清掉——不清的话新的一条永远不会响
    reminders: done.reminders.map((r) => {
      const t = Date.parse(r.at);
      return { at: Number.isNaN(t) ? r.at : new Date(t + delta).toISOString(), firedAt: null };
    }),
    // 子任务带过去，但全部重置成没做
    subtasks: done.subtasks.map((s) => ({ ...s, done: false })),
    // 次数减一带给下一条（`null` = 一直重复，原样传）；艾宾浩斯还要把步数
    // 往前推一格，不然它会永远停在第一个间隔上，变成「每天」。跳过走同一条。
    repeat: stepRepeat(done.repeat, dueDay(done)),
    status: 'todo',
    completedAt: null,
    postponeCount: 0,
    // **`estimateMinutes` 不清**：一条「每周报告，预计 45 分钟」下一次照样是
    // 45 分钟——那是这件事要花多久，不是这一次花了多久。`focusSessions` 反过来
    // 必须清空，它记的正是「这一次花了多久」。
    focusSessions: [],
    /**
     * **附件清空。** 上周那份报告的 PDF 是上周的产物，跟 `focusSessions`
     * 同一类——`web/src/lib/duplicate.ts` 早就把 `attachments` 归在「上一条的
     * 经历」里丢掉了，这边靠 `...done` 悄悄带了过去。
     *
     * **带过去的还不止是一个不一致，是一条假数据。** 附件按任务 id 分目录存
     * （`data/attachments/<taskId>/`），而新实例是新 id：那个目录是空的。
     * 于是盘上那条任务声称自己有一份它根本没有的附件。
     *
     * 界面上看不出来，是因为 `GET /api/tasks` 有一道以磁盘为准的矫正
     * （`app.ts` 那条路由）——但那道矫正**只改响应、不写盘**，所以假数据
     * 会一直躺在 `data/tasks/<id>.json` 里。而 AI 是直接读那些文件的（AGENTS.md），
     * 它看到的就是那句谎话。
     */
    attachments: [],
    /**
     * **「看过了」的章不带过去。** 那个章说的是「他在回顾里看过**这一条**、
     * 并且决定维持原样」——而新实例是另一件事，他还没看过。带过去的话，一条
     * 每周重复的任务只要被看过一次，此后每一次新实例出生就自带七天豁免，
     * 而回顾那一屏永远不会再问起它。
     */
    reviewedAt: null,
    order: null,
    createdAt: iso,
    updatedAt: iso,
  };
}
