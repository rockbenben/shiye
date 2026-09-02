import type { Countdown, Repeat, Task } from './store.js';

/**
 * 任务 → `.ics`（RFC 5545 的一个很小的子集，手写不引库：只用得上 VEVENT +
 * VALARM，一个依赖换这几十行不划算）。只读——同步到手机之后任何日历 App
 * 订阅它就行，改日历不会改回任务。
 *
 * 只导出有 `due` 的、未完成的任务。
 *
 * **这句话不等于「有时间的都导」**：一场只有时间段（`startAt`+`endAt`）、没填
 * 截止时间的会**导不出去**，虽然它在这个应用自己的日历上画得好好的。这是下面
 * 那条「`startAt` 不参与导出」的直接推论，不是另一个决定——RRULE 的锚点没跟
 * 事件的起止拆开之前，这一族只能整体留在门外。改的时候两处一起改。
 *
 * **`startAt`（开始时间）有意不参与导出。** 一条设了「时间段」的任务在日历
 * 应用里理应是一段（DTSTART=开始、DTEND=截止），而这里每条都是 DTSTART=due
 * 的时间点。不改是因为**重复规则整个锚在 DTSTART 上**（下面 `rruleFor`：
 * BYDAY 按 DTSTART 转成 UTC 之后的那一天写、FREQ=MONTHLY 按 DTSTART 的日号
 * 重复）——把起点换成 `startAt` 会让每一条重复任务的周期锚点跟着变，而那跟
 * 「显示成一段」是两件事。真要做，得先把 RRULE 的锚点和事件的起止拆开。
 * 写在这儿是为了下一个人知道这是一个决定，不是漏了。
 *
 * **分类那一整族也都不导：`tags` / `listId` / `priority` / `context`。**
 * 这是一条规则，不是四个各自的疏忽——RFC 5545 能装它们的只有 `CATEGORIES`，
 * 而主流日历（Google、Apple）都不把它显示出来。导了等于往每条事件里塞一行
 * 订阅方看不见的字——**而这份导出回答的问题只有一个：哪天要干什么。**
 * 「归哪个清单」「多重要」「什么条件下干得了」都是拿来挑活的，而挑活发生在
 * 这个应用里，不在手机日历里。加新字段时默认归这一族，除非它真的回答
 * 「哪天」（见 CONTRIBUTING「加一个 Task 字段要动哪些地方」里那一条）。
 */

/**
 * ⚠️ **改这个字符串等于把所有日历事件换一遍身份，以后别动。** 它拼进每条事件的
 * `UID:<任务 id>@<这里>`，而 UID 就是日历 App 用来认「这是不是上次那条」的东西：
 * 换了域名，订阅方看到的是旧事件全部消失、一批新事件出现——运气好是闪一下，
 * 运气不好是重复两份。
 *
 * 它跟着「待办 → 办事师爷」那次改名从 `035-todo.local` 改成了现在这个，**那次是
 * 因为项目还没发布、确定没有任何订阅方**。这个前提只成立那一次。
 *
 * 域名本身是假的（`.local`），不解析、也不需要解析——UID 只要求全局唯一，
 * 「任务 id + 一个自己的域」是 RFC 5545 的常规做法。
 *
 * 没有测试守着它：`ics.test.ts` 只断言 UID 带上了任务 id，域名部分是裸的。
 */
const UID_DOMAIN = '035-shiye.local';
const FOLD_MAX_BYTES = 75;

/** `,` `;` `\` 转义成 `\,` `\;` `\\`，换行转成 `\n`。**必须在折行之前做**——
 * 转义会让串变长，折行要看的是转义之后的长度。反斜杠必须最先转，否则后面
 * 几步自己转出来的反斜杠会被重复转义。 */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** UTC 基本格式：`20260820T090000Z`。 */
function formatUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** RRULE 的 BYDAY 简写，索引就是 `Date.getDay()`（0=周日）。 */
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * 一条任务的重复规则 → 一行 `RRULE:…`。表达不了就返回 `null`（那条事件照旧
 * 只导出这一次）。
 *
 * 为什么要有：这个应用的重复是「完成一条才生成下一条」，所以任何一刻都只有
 * **一条**真实的任务记录。不写 RRULE 的话，手机上订阅这份日历的人看到「每周一
 * 开例会」只出现一次，之后每个周一都是空的——跟日历视图当初加「显示未来重复
 * 周期」要解决的是同一件事（那边的说法是「日历回答的是『什么时候要做什么』，
 * 一页空空如也是错的答案」）。
 *
 * **这几种情况故意不写**，写了就是撒谎：
 * - 没有 `repeat`；
 * - `from: 'done'`（完成重复）——下一次几号取决于他哪天做完，压根不是一个固定
 *   节律，RRULE 只能表达固定节律；
 * - `every: 'ebbinghaus'`——间隔是 1/2/3/8/15… 走表的，RRULE 没有这种频率；
 * - `'lunar-year'` / `'lunar-month'`——农历跟公历不是等间隔的（一个农历年在
 *   353 到 385 天之间跳），`FREQ=YEARLY` 展开出来每年都会差十几天；
 * - `'workday'` / `'holiday'`——它们跟着每年的放假通知走，是一张**发布出来的
 *   表**，不是任何一条 RRULE 规则能表达的（RFC 5545 里没有「法定节假日」这个
 *   概念，各国还不一样）。
 *
 * 这几种在别人的日历里就是一个个独立的单次事件，那正是它们真实的样子。
 *
 * **BYDAY 要按 DTSTART 转成 UTC 之后的那一天写，不是本地那一天。** 这个文件
 * 全程用 UTC 时刻（顶部注释：不引 VTIMEZONE），而 BYDAY 是在 DTSTART 的时区
 * 里展开的。一条本地周一 23:59 的任务在纽约是 UTC 周二 03:59，写 `BYDAY=MO`
 * 会让整串事件落到 UTC 周一、也就是本地**周日** 23:59——整整差一天。按同一个
 * 位移把每个星期几挪过去，展开出来的 UTC 时刻才是对的那几个。
 * （夏令时切换那一周位移可能变一天，这是 UTC-only 导出本来就有的取舍，跟事件
 * 时刻会跟着差一小时同源，见文件顶部。）
 *
 * `BYMONTHDAY` **不写**：`FREQ=MONTHLY` 本来就按 DTSTART 的日号重复，写了不
 * 多解决什么；而这个应用对「31 号遇上二月」是**收到月末**（28 号），RFC 5545
 * 的 BYMONTHDAY 是**整月跳过**（2/4/6/9/11 月直接没有那次），两种语义对不上，
 * 写出去反而是错的。
 *
 * **代价说清楚：订阅端看到的「未来那几次」可能跟这个应用将要做的不一样。**
 * 这个应用用 `repeat.monthDay` 当锚点，被短月钳过之后能弹回去（实测：31 号那条
 * 滚动是 1/31 → 2/28 → **3/31** → 4/30 → 5/31）；而导出的 DTSTART 只是「当下
 * 这一次」，订阅端从 2/28 往后展开会算成 3/28、4/28。
 *
 * **但这不是永久漂移**——`.ics` 是服务端按当前任务现生成的（`index.ts` 的
 * `writeIcsFile`，每 30 秒一次 + 数据变更时），任务一滚到 3/31，导出的锚点也就
 * 跟着回到 31 号。不一致只存在于「这一次已经被钳、还没滚到下一次」那段时间里，
 * 而且只影响订阅端**预测**的未来几次，不影响任何一次真实提醒（提醒在这个应用
 * 自己这边）。写 BYMONTHDAY 换来的是每年五个月整月不出现——用一个持续的错换一个
 * 短暂的不准，不划算。
 */
export function rruleFor(t: Task, dueDate: Date): string | null {
  const r = t.repeat;
  if (!r || r.from === 'done') return null;
  // 表里没有的那几档就是「RRULE 表达不了」，一律不写。用查表而不是一串
  // `!==`：加一档新周期时，忘了在这儿表态的后果是它落进 `undefined`、
  // 被下面这行接住，而不是悄悄按某个错的频率导出去。
  const freq = ({ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' } as Partial<Record<Repeat['every'], string>>)[r.every];
  if (!freq) return null;
  const parts = [`FREQ=${freq}`];
  const days = r.every === 'week' ? [...new Set(r.weekdays ?? [])].sort((a, b) => a - b) : [];
  // `INTERVAL` 照写。这里曾经有一条豁免：「指定了星期几时不写」——理由是当时
  // `repeat.ts` 的 week 分支**根本不看 interval**（「每 2 周的周一三五」实际每周
  // 都走），导出写 `INTERVAL=2` 会让订阅端隔周、而应用每周提醒。那个 bug 已经
  // 修好（见 `nextOccurrence` 里那段「跳过中间那 n-1 周」），豁免跟着撤掉。
  const n = Math.max(1, r.interval ?? 1);
  if (n > 1) parts.push(`INTERVAL=${n}`);
  if (days.length > 0) {
    const shift = (dueDate.getUTCDay() - dueDate.getDay() + 7) % 7;
    parts.push(`BYDAY=${days.map((d) => BYDAY[(d + shift) % 7]).join(',')}`);
    // **`WKST` 跟应用的锚点一致。** `repeat.ts` 算「每 N 周」的周边界时，锚在名单里
    // 最小的那个星期几上（理由写在那儿：不用 `Settings.weekStart`，那是每台机器的
    // 显示偏好）。RRULE 里对应的就是 `WKST`，不写默认是 `MO`——名单里有周日时两边
    // 就对不上了。RFC 5545 自己举的例子：周二 1997-08-05 起、每 2 周的 SU,TU，
    // `WKST=SU` 是 8/5, 8/17, 8/19, 8/31（应用就是这么响的），默认 `WKST=MO` 是
    // 8/5, 8/10, 8/19, 8/24——订阅端手机日历上画的日子跟应用提醒的日子不一样。
    // `INTERVAL=1` 时 WKST 不影响结果，所以这个问题一直被上面那条（已撤的）豁免
    // 盖着；只在 n > 1 时写，免得给每条周重复都多一段没用的字。
    if (n > 1) parts.push(`WKST=${BYDAY[(days[0] + shift) % 7]}`);
  }
  // UNTIL 和 COUNT **不能同时出现**（RFC 5545 3.3.10 的 MUST NOT），而这个
  // 应用两个可以一起设、谁先到算谁的。取 UNTIL：一堵时间上的墙，订阅方自己
  // 就能核对；次数那一半表达不出来时，宁可少说一句也不说一句对不上的。
  const until = r.until ? new Date(r.until) : null;
  if (until && !Number.isNaN(until.getTime())) parts.push(`UNTIL=${formatUtc(until)}`);
  // `count` 存的是**还要再重复几次**（见 model.ts），而 RRULE 的 COUNT 是这一
  // 串一共几次——当前这条自己也算一次，所以要 +1。
  else if (typeof r.count === 'number' && r.count >= 0) parts.push(`COUNT=${r.count + 1}`);
  return `RRULE:${parts.join(';')}`;
}

/**
 * RFC 5545 折行：每行不超过 75 **字节**，超了要折；续行以一个空格开头
 * （这个空格也占续行的字节预算）。**按字符累加、逐字符判断要不要先折**，
 * 不能按字符数切（`slice(0, 75)`）——中文一个字三字节，那样会把一个汉字
 * 切成半个，产出乱码。`for...of` 逐个取的是 Unicode 码位，天然不会劈开
 * 代理对，多字节字符按整个字符判断，不会切在字符中间。
 */
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= FOLD_MAX_BYTES) return line;
  const segments: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    const budget = segments.length === 0 ? FOLD_MAX_BYTES : FOLD_MAX_BYTES - 1; // 续行开头的空格占 1 字节
    if (currentBytes + chBytes > budget) {
      segments.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  segments.push(current);
  return segments.map((seg, i) => (i === 0 ? seg : ` ${seg}`)).join('\r\n');
}

/**
 * `DTSTAMP` 不读时钟：读时钟的话两台机器各写各的 `.ics`，内容永远不同，
 * 同步客户端会把它们当成冲突（`待办 (冲突副本 …).ics` 越堆越多，而且这类
 * 副本 `CONFLICT_RE` 不认 `.ics`，横幅也提不到它，见 sync-and-ics 复盘）。
 * 改用任务集合本身能推出来的确定值——全部 `updatedAt` 的最大值，RFC 5545
 * 对 `DTSTAMP` 的定义就是「信息最后修订时刻」，本来就该是这个。两台机器
 * 拿到同一份任务，算出来的 `.ics` 字节一致，冲突自然消失。
 */
function latestUpdate(tasks: Task[]): Date {
  const ms = tasks.map((t) => new Date(t.updatedAt).getTime()).filter((n) => !Number.isNaN(n));
  return new Date(ms.length ? Math.max(...ms) : 0);
}

export function toIcs(tasks: Task[], countdowns: Countdown[] = []): string {
  const dtstamp = formatUtc(latestUpdate(tasks));
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//035-shiye//ics//CN'];

  for (const t of tasks) {
    // 已完成和**已放弃**的不导出。放弃这一档原来漏了（这个状态是后加的，
    // 这行还停在只认 done）：一件已经决定不做的事继续占着日历上那一天，
    // 跟「全部」那个去处的规矩也对不上——那边一直是「排除已完成和已放弃，
    // 保留搁置」（web/src/lib/simpleViews.ts）。
    //
    // **搁置的照常导出**，这是一条有意的保留：搁置是「暂时不想做，心里还
    // 留着它」，日历视图也一直照常显示它（「它仍然占着那一天」）。
    if (t.status === 'done' || t.status === 'abandoned' || !t.due) continue;
    const dueDate = new Date(t.due);
    if (Number.isNaN(dueDate.getTime())) continue; // 解析不了的 due 静默跳过，不带走整份日历
    const dt = formatUtc(dueDate);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${t.id}@${UID_DOMAIN}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${dt}`);
    const rrule = rruleFor(t, dueDate);
    if (rrule) lines.push(rrule);
    /**
     * **有时间段的写 DTEND**（滴答清单的「时间段」）——订阅方那边它才是一段，
     * 不是一个点。
     *
     * **DTSTART 仍然是 `due`，没换成 `startAt`**：文件顶部那段解释过为什么，
     * 而那个理由到今天还成立——重复规则整个锚在 DTSTART 上（BYDAY 按它转成
     * UTC 之后的那一天写、FREQ=MONTHLY 按它的日号重复），换起点会让每一条
     * 重复任务的周期跟着变。所以这里只补上「有多长」这一半：`endAt` 晚于
     * `due` 时写 DTEND，那条事件在别人日历上就有了高度。
     *
     * **`endAt <= due` 时不写**：RFC 5545 §3.8.2.2 规定 DTEND 必须严格晚于
     * DTSTART，写了是一份非法的 .ics——而「结束早于开始」这种自相矛盾的话
     * 校验器是有意收下的（那是用户的话），到这一层必须挡住。
     */
    const endMs = t.endAt ? Date.parse(t.endAt) : NaN;
    if (!Number.isNaN(endMs) && endMs > dueDate.getTime()) {
      lines.push(`DTEND:${formatUtc(new Date(endMs))}`);
    }
    lines.push(`SUMMARY:${escapeText(t.title)}`);
    if (t.notes) lines.push(`DESCRIPTION:${escapeText(t.notes)}`);

    // **搁置的不带 VALARM**：事件留着（上面那条），闹钟不留。
    // 这两件事在这个应用里本来就分开——`reminder.ts` 明确拒绝给搁置的任务
    // 发提醒，原话是「用户刚把一张卡从『今天』挪走图个清净，下一秒就被同一
    // 条的提醒烦到，比放着不搁置还糟」。而 VALARM 是同一个提醒换了条路走到
    // 他手机上，还是这个应用关不掉的那条路。日历上看得见 ≠ 到点要响。
    for (const r of (t.status === 'later' ? [] : t.reminders)) {
      const remindAt = new Date(r.at);
      if (Number.isNaN(remindAt.getTime())) continue; // 解析不了的提醒时刻静默跳过
      const diffMin = Math.round((dueDate.getTime() - remindAt.getTime()) / 60_000);
      // 正数（提醒早于 due）写成 -PT{n}M；提醒晚于 due 写成 PT{n}M。
      const trigger = diffMin > 0 ? `-PT${diffMin}M` : diffMin < 0 ? `PT${-diffMin}M` : 'PT0M';
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${escapeText(t.title)}`);
      lines.push(`TRIGGER:${trigger}`);
      lines.push('END:VALARM');
    }

    lines.push('END:VEVENT');
  }

  /**
   * 纪念日也导出。**应用自己的日历默认就标着它们**（`calendarPrefs` 的
   * `showCountdowns` 默认开，那条注释的说法是「它们本来就是『哪天有什么事』
   * ——那正是日历回答的问题」），而导出的那份里它们一条都没有。生日、
   * 考试、纪念日恰恰是最想出现在手机日历里的东西。
   *
   * **恒全天事件**（`VALUE=DATE`），不是任务那种时刻点：纪念日的粒度就是
   * 「哪一天」（`Countdown.date` 就是 `YYYY-MM-DD`，根本没有钟点），把它画成
   * 一个 00:00 的时刻块是在暗示一个并不存在的时间安排——跟日历那边把打卡
   * 画成全天是同一条（`calendarMarks.ts`）。全天事件用本地日期字面，不转 UTC：
   * 转了就会在负时区里提前一天，而「生日是哪天」跟时区无关。
   *
   * 每年重复的写 `RRULE:FREQ=YEARLY`——这一档没有任务那边那些顾虑（不看
   * `BYDAY`、没有完成重复、没有次数上限），就是最素的一条。
   *
   * UID 另起一个 `cd-` 前缀：纪念日和任务是两张表，**id 各自生成、理论上
   * 撞得上**（都是 uuid，撞的概率可忽略但不是零），而 UID 撞了的后果是订阅方
   * 把两条当成同一件事、后写的盖掉前一条。
   */
  for (const c of countdowns) {
    // 日期形状不对（手改 `data/countdowns/` 写坏了）的静默跳过，不带走整份日历
    // ——跟上面任务那边 `Number.isNaN` 那一条同一个处理。
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.date ?? '');
    if (!m) continue;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:cd-${c.id}@${UID_DOMAIN}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${m[1]}${m[2]}${m[3]}`);
    lines.push(`SUMMARY:${escapeText(c.title)}`);
    // **农历的每年不写 RRULE**——跟上面 `rruleFor` 对 `lunar-year` 的处理
    // 一字不差，理由也一样：农历跟公历不是等间隔的（一个农历年在 353 到 385
    // 天之间跳），`FREQ=YEARLY` 展开出来每年都会差十几天。在别人的日历里它
    // 就是一个单次事件，那正是它真实的样子。
    if (c.yearly && !c.lunar) lines.push('RRULE:FREQ=YEARLY');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
