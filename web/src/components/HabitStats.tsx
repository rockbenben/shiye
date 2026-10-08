import { useState } from 'react';
import { Button } from 'antd';
import type { Task, WeekStart } from '../types.js';
import { habitStats, type HabitDay, type HabitSummary } from '../lib/habitStats.js';
import { habitDoneDays } from '../lib/habit.js';
import { dayKey } from '../lib/calendar.js';
import { useIsNarrow } from '../lib/narrow.js';
import { Heatmap } from './Heatmap.js';

interface Props {
  tasks: Task[];
  now: Date;
  /** 一周从周几开始（`Settings.weekStart`）——热力图每一行代表星期几靠它。
   *  跟专注统计那张图必须是同一个数。不给按周一。 */
  weekStart?: WeekStart;
  /** 点某个习惯：跳到那条任务。跟「回顾」里点关联任务同一个动作。 */
  onOpen: (taskId: string) => void;
  /**
   * 今天打个卡——**就是把当下这条实例标成完成**，跟在卡片上勾它是同一个动作
   * （调用方接的也该是同一个处理，那样撤销提示和「下次 X」都白来）。
   *
   * 补的是一处「看得见、够不着」：这一屏每个习惯上都写着「今天待打卡」，
   * 而打卡这件事在这儿一步都做不了——得先点标题跳到「全部」、在一屏任务里
   * 找到那张卡、再勾它。**这是这个应用里最高频的一下**，却隔着三步。
   *
   * 不给就退回原来的样子（一个纯文字的状态标），跟这个仓库里所有可选回调
   * 同一条：点了没反应的入口比没有更糟。
   */
  onCheckIn?: (taskId: string) => void;
}

/**
 * 习惯概览——仿滴答清单的「打卡概览」+「月度打卡表」。
 *
 * 存在的理由：习惯在这个应用里**只在「今天」露过面**（那条连续天数），换个
 * 视图就什么都看不见，也回答不了「这个月坚持得怎么样」。判据在
 * `lib/habitStats.ts`，这里只管怎么摆。
 *
 * 月度打卡表是一排 div，不引图表库——一个月三十一个方格，`done` 决定填不填。
 */
/** `YYYY-MM-DD` 那天是星期几（`getDay()` 的 0–6）。**按本地时区拆着建**，
 *  不 `new Date(key)`——那个按 UTC 解析，东八区会整体差一天。 */
const weekdayOf = (key: string): number => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};

/**
 * 月历第一行、1 号之前要空几格。
 *
 * **必须跟 `weekStart` 同一个坐标系**，不然空出来的格数和上面那行星期标签
 * 对不上——设置里改成周日开始，标签挪了、空格没挪，整张表就错位一天。
 */
const monthOffset = (firstKey: string, weekStart: WeekStart): number =>
  (weekdayOf(firstKey) - weekStart + 7) % 7;

/** `YYYY-MM-DD` → 「9月」。翻月之后每一张卡的表头要说得出自己画的是哪个月。 */
const monthLabel = (key: string): string => `${Number(key.split('-')[1])}月`;

/** 月历顶上那行星期标签，按 `weekStart` 轮转（不给就是周一起）。 */
const weekdayLabels = (weekStart: WeekStart): string[] =>
  Array.from({ length: 7 }, (_, i) => '日一二三四五六'[(weekStart + i) % 7]);

/**
 * 「今天这一条处在哪个状态」——**一份判据，两个读者**：卡片顶上那颗按钮/那句
 * 文字，和屏顶那句总账。写两遍迟早对不上（这一屏上「今天不用打卡」的格子旁边
 * 摆一颗「今天打卡」的按钮，就是按钮那份没读 `checkinDays` 造成的）。
 *
 * - `done` 今天已经打过
 * - `off` 这天本来不用打（勾了一三五的健身在周六）
 * - `met` 每周那种，本周次数已经够了
 * - `pending` 该打、还没打、也没达标——**唯一有动作可做的一档**
 *
 * 顺序是有意义的：先 `done`（打过就是打过），再 `off`（今天不是它的日子），
 * 最后才轮到 `met`。
 */
export type TodayState = 'done' | 'off' | 'met' | 'pending';

export const todayState = (h: HabitSummary, now: Date): TodayState => {
  if (h.doneToday) return 'done';
  if (h.checkinDays !== null && !h.checkinDays.includes(now.getDay())) return 'off';
  if (h.week !== null && h.week.done >= h.week.target) return 'met';
  return 'pending';
};

const TODAY_TEXT: Record<TodayState, string> = {
  done: '今天已打卡',
  off: '今天不用打卡',
  met: '本周已达标',
  pending: '今天待打卡',
};

/**
 * 一格悬停说的话。月历和右边那条带**共用这一份**：同一个格子在两处出现，
 * 说两句不一样的话（一处讲「那天不用打」一处讲「那天没打」）比不说还糟。
 */
const cellTitle = (d: HabitDay): string =>
  `${d.key}${d.future ? '' : d.before ? ' 那时还没有这个习惯' : d.off ? ' 这天不用打卡' : d.done ? ' 打过卡' : ' 没打卡'}`;

export function HabitStats({ tasks, now, onOpen, onCheckIn, weekStart }: Props) {
  /** 窄屏那一档退回原来的卡片摆法（CSS 里那条媒体查询），翻月那颗也就常驻。
   *  jsdom 里它恒为 false，所以测试走的都是整宽这张表那条路——跟 `narrow.ts`
   *  顶部写明的既有约定一致。 */
  const narrow = useIsNarrow();
  // `weekStart` 传下去：每周那种习惯的「本周 N/M」和「连续几周」按它划周界，
  // 跟日历那七列、专注统计的「本周」必须是同一个数。
  /** 月历看的是哪个月（0 = 这个月，-1 = 上个月……**不许往未来翻**）。
   *
   * 加这一档是因为月初进这一屏什么都看不见：这一屏的立意是「这个月坚持得
   * 怎么样」，而每月头几天月历上就是几个空格，刚过去的九月反而一眼都查不到
   * ——想查只能点「看这一年」，在 365 格里自己找。
   * 连续天数/本周次数/今天打没打不受它影响（判据在 `habitStats` 那边）。 */
  const [monthBack, setMonthBack] = useState(0);
  const habits = habitStats(tasks, now, weekStart, monthBack);
  // 月历那七列和顶上那行标签共用这一个数。`habitStats` 内部也落同一个默认值，
  // 这里再写一次不是重复：**这一份是给渲染用的**，那边那份管的是划周界。
  const ws: WeekStart = weekStart ?? 1;
  // 哪几个习惯展开了年度热力图。**默认全收起**——滴答清单那边也是点「更多」
  // 才进年度热力页：一张 365 格的图乘上五个习惯，会把「这个月怎么样」这个
  // 主问题挤到屏幕外面去。
  const [openYear, setOpenYear] = useState<Set<string>>(new Set());
  const toggleYear = (title: string) => setOpenYear((prev) => {
    const next = new Set(prev);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    return next;
  });
  /**
   * 整宽那张表里，哪几行的**详情**（月历 + 年度热力图）是摊开的。
   *
   * 一行一个习惯、右边一条格子带，是为了把「谁这周断了」一次看完；月历一摊开
   * 就是五行七列，全摊开等于回到原来那屏一列长卡。所以默认全收起，跟年度
   * 热力图那档同一个道理。
   *
   * **窄屏不受它管**：手机上本来是一行一张卡、月历常驻（CSS 那条媒体查询说的），
   * 那儿没有「先看完密度再决定展开谁」这回事。
   */
  const [openRow, setOpenRow] = useState<Set<string>>(new Set());
  const toggleRow = (title: string) => setOpenRow((prev) => {
    const next = new Set(prev);
    if (next.has(title)) next.delete(title);
    else next.add(title);
    return next;
  });
  /** 那条带的最后一格。**认的是今天这个日子，不是 `h.recent` 的最后一项**——
   *  万一哪天带子的长度改了或者哪条习惯没有近 28 天，标错格子的代价是「今天」
   *  这一列在几行里各偏一位，而整条带存在的意义就是列对齐。 */
  const todayKey = dayKey(now);

  // 一个习惯都没有：说清楚怎么建一个，不摆一张空表。「习惯」在这个应用里是
  // 「标了 habit，而且重复档是每天或每周」（判据 `isHabit`），不点破的话
  // 没人猜得到要怎么弄出一个来。
  // **这句话以前指着一个不存在的开关**：`habit` 那时候界面上根本没有入口，
  // 唯一的办法是手改 data/tasks/ 下的 JSON。现在它指的是编辑表单里那个
  // 勾选框（重复选了「每天」或「每周」之后出现，见 TaskFields.tsx）。
  if (habits.length === 0) {
    return (
      <p className="ink-empty-note">
        还没有习惯。在任务的编辑表单里把重复设成「每天」或「每周」，下面就会出现「当成习惯」那个勾选框，勾上它就会出现在这里。
      </p>
    );
  }

  const counts = habits.reduce(
    (acc, h) => ({ ...acc, [todayState(h, now)]: acc[todayState(h, now)] + 1 }),
    { done: 0, off: 0, met: 0, pending: 0 } as Record<TodayState, number>,
  );

  return (
    <>
      {/* 一句总账。**这一屏原来什么都不说**：两个习惯、今天一个待打卡一个不用
          打，屏幕上没有任何一处回答「我今天还欠几件」——而侧栏给它配的是一个
          网格图标，它是被当报表进的这一屏。
          只汇总，**不做「一键全打」**：打卡是人自己那一下。 */}
      <p className="ink-hstat-summary" role="status">
        {counts.pending > 0 && <>今天 <b>{counts.pending}</b> 个待打卡</>}
        {counts.done > 0 && <>{counts.pending > 0 ? ' · ' : ''}<b>{counts.done}</b> 个已打</>}
        {counts.off > 0 && <> · <b>{counts.off}</b> 个今天不用打</>}
        {counts.met > 0 && <> · <b>{counts.met}</b> 个本周已达标</>}
        {counts.pending === 0 && counts.off === 0 && counts.met === 0 && counts.done === 0 && '今天没有要打的卡'}
      </p>
      {/* 翻月那颗。**宽屏上它只在至少一行摊开时出现**：它管的是各行的月历，
          而整宽那张表默认一行都没摊开——那时候摆一排只翻得着看不见的东西的
          按钮，等于让人去按一个当下没有任何反应的控件。
          窄屏常驻：那儿月历本来就摊着（CSS 那一档），它一直有用。 */}
      {(narrow || openRow.size > 0) && (
      <div className="ink-hstat-month">
        <button
          type="button"
          className="ink-hstat-moonav"
          aria-label="上一个月"
          onClick={() => setMonthBack((n) => n - 1)}
        >‹</button>
        {/* 翻到哪个月就把那个月写在**每一张卡的表头**上（见下面 monthLabel），
            这一行只负责翻页——两处都写月份会各写一份，迟早对不上。 */}
        <button
          type="button"
          className="ink-hstat-moonav"
          aria-label="下一个月"
          disabled={monthBack >= 0}
          onClick={() => setMonthBack((n) => Math.min(0, n + 1))}
        >›</button>
      </div>
      )}
      <div className="ink-hstat-root">
      {habits.map((h) => {
        const state = todayState(h, now);
        const canCheckIn = state === 'pending' && h.liveId !== null && !!onCheckIn;
        const todayText = TODAY_TEXT[state];
        return (
        <section className={`ink-hstat-card${openRow.has(h.title) ? ' is-open' : ''}`} key={h.title} aria-label={h.title}>
          <div className="ink-hstat-head">
            {/* 摊开/收起月历。**跟标题那两颗是分开的两件事**：点标题跳去那张卡
                （原来只有它），点这一颗在这一屏里看历史。合成一颗的话，想看看
                上个月就得离开这一屏。 */}
            <button
              type="button"
              className="ink-hstat-exp"
              aria-expanded={openRow.has(h.title)}
              aria-label={`${openRow.has(h.title) ? '收起' : '展开'}「${h.title}」的月历`}
              onClick={() => toggleRow(h.title)}
            >{openRow.has(h.title) ? '▾' : '▸'}</button>
            <button type="button" className="ink-hstat-name" onClick={() => onOpen(h.taskId)}>{h.title}</button>
            {/* 今天打没打卡是这一屏最要紧的一件事，单独标出来——底下那张
                打卡表要数到「今天」那一格才看得出来。

                **还没打、今天真的该打、而且真有一条实例可打的时候，它才是一颗
                按钮**：一个写着「今天待打卡」的纯文字标，等于把这一屏最高频的那
                一下推到三步之外（点标题 → 跳「全部」 → 在一屏任务里找到那张卡 →
                勾）。打过了、今天不用打、本周已达标，三种都没有动作可做，就还是
                文字——没有 live 实例（整串都完成/放弃/搁置了）同样是文字。 */}
            {canCheckIn ? (
              <Button size="small" onClick={() => onCheckIn!(h.liveId!)}>今天打卡</Button>
            ) : (
              <span className={h.doneToday ? 'ink-hstat-today ink-hstat-today-done' : 'ink-hstat-today'}>
                {todayText}
              </span>
            )}
          </div>
          <div className="ink-hstat-nums">
            {/* **单位跟着习惯的种类走**：每周那种数的是「连续几周达标」，
                对一条一周三次的习惯说「连续 12 天」是句假话，它本来就不用
                天天做。判据是 `week` 是不是 null（`lib/habit.ts` 定的），
                这儿不自己再判一次「它是哪种习惯」。 */}
            <span>连续 <b>{h.streak}</b> {h.week ? '周' : '天'}</span>
            <span>最长 <b>{h.longest}</b> {h.week ? '周' : '天'}</span>
            {h.week && <span>本周 <b>{h.week.done}</b> / {h.week.target} 次</span>}
            {/* 分母是「**这一屏正在画的那个月**里这个习惯能打卡的天数」：既不算还没到的，也不算建它
                之前的。整月天数会让月初第二天显示「1 / 30」，而「本月已过去几天」
                会让今天新建的习惯显示「0 / 26」——两句读起来都是「你欠了一堆」。
                判据在 habitStats.ts 的 `monthElapsed` 上。

                **分母是 0 时整栏不渲染**（手机宽度实测发现的）：那是「今天刚建了
                一个每周几次的习惯、而今天不是打卡日」——分子分母一起算成 0，
                屏幕上就成了「9月 0 / 0 天」，一个读起来像坏掉的分数。上面那句
                ——**这一栏跟着翻月改口**：翻到九月还写「本月」，说的是假话。
                注释防的是「0 / 26」这种**欠账感**，没防住「0 / 0」这种**不成句**。
                跟 `workload.ts` 那条「一条都没估过时整句不出」同一条规矩：
                没有话可说的一栏不渲染，而不是渲染一个 0 让它自己解释自己。 */}
            {h.monthElapsed > 0 && <span>{monthLabel(h.days[0].key)} <b>{h.monthDone}</b> / {h.monthElapsed} 天</span>}
          </div>
          {/* 可访问名跟上面那一栏说同一件事：分母是 0 时不能念「0 / 0 天」——
              读屏听到的会跟屏幕上的那句话一样费解。 */}
          {/* 右边那条格子带：最近 28 天，最后一天是今天。整宽那张表要的就是这一条
              ——每一行的**同一列是同一个日子**，所以「这周谁断了」是横着一眼看完的，
              不用一个习惯一个习惯地点开。月历回答的是另一个问题（这个月怎么样），
              所以它收在详情里。
              每格不写日子数字：28 格写数字在窄一点的行里就挤成一团，而这条带要的是
              密度；哪一天悬停有话，读屏另有下面那句 aria-label。 */}
          <div
            className="ink-hstat-band"
            role="img"
            aria-label={`最近 28 天：打过 ${h.recent.filter((d) => d.done).length} 天`}
          >
            {h.recent.map((d) => (
              <span
                key={d.key}
                title={cellTitle(d)}
                className={[
                  'ink-hstat-bcell',
                  d.done ? 'ink-hstat-bcell-done' : '',
                  // 还没到 / 那时还没建 / 这天不用打：三样都「不是漏」，画得一样。
                  d.future || d.before || d.off ? 'ink-hstat-bcell-off' : '',
                  d.key === todayKey ? 'ink-hstat-bcell-today' : '',
                  // 每周第一天那格左边留一道缝：不带节奏的话 28 格就是一排芝麻，
                  // 数「这周几天」还得自己一格一格点数。
                  (weekdayOf(d.key) - ws + 7) % 7 === 0 ? 'ink-hstat-bcell-wk' : '',
                ].filter(Boolean).join(' ')}
              />
            ))}
          </div>
          <div className="ink-hstat-detail">
          {/* 表头那个月份：翻到九月就该写着九月。 */}
          <div className="ink-hstat-monthlabel" aria-hidden="true">{monthLabel(h.days[0].key)}</div>
          <div
            className="ink-hstat-grid"
            role="img"
            aria-label={`${monthLabel(h.days[0].key)}打卡表：${h.monthElapsed > 0
              ? `${h.monthDone} / ${h.monthElapsed} 天`
              // 分母是 0 时不念一个读起来像坏掉的分数——这条规矩原来就有，
              // 翻月之后照样成立。
              : '还没有打卡日'}`}
          >
            {/* 星期几那一行。**没有它七列也不可读**——「第一列是周一」得靠这行字。
                跟下面的格子同宽同间距，才能对得上。 */}
            {weekdayLabels(ws).map((w, i) => (
              <span key={`wd${i}`} className="ink-hstat-wd" aria-hidden="true">{w}</span>
            ))}
            {/* 1 号之前那几格。空着，不画边框——画了就成了「那几天漏打卡」。 */}
            {Array.from({ length: monthOffset(h.days[0].key, ws) }, (_, i) => (
              <span key={`blank${i}`} className="ink-hstat-blank" aria-hidden="true" />
            ))}
            {h.days.map((d) => (
              <span
                key={d.key}
                // 「还没到」和「那时还没有这个习惯」画得一样（都不是「漏了」），
                // 但**说的话不一样**：后者以前会说「没打卡」，那是一句不成立的话。
                className={`ink-hstat-cell${d.done ? ' ink-hstat-cell-done' : ''}${d.future || d.before || d.off ? ' ink-hstat-cell-off' : ''}`}
                title={cellTitle(d)}
              >{d.dayOfMonth}</span>
            ))}
          </div>
          <div className="ink-hstat-year">
            <Button size="small" type="text" aria-expanded={openYear.has(h.title)} onClick={() => toggleYear(h.title)}>
              {openYear.has(h.title) ? '▾' : '▸'} 看这一年
            </Button>
            {openYear.has(h.title) && (
              <Heatmap
                // 打卡是「有没有」，不是「多少」——值只有 0 和 1，热力图上就是
                // 两档深浅。这张图看的是密度和断档，不是强度。
                values={new Map([...habitDoneDays(tasks, h.title)].map((k) => [k, 1]))}
                now={now}
                weekStart={weekStart}
                // 建这个习惯之前的那些天不说「没打卡」——那时它还不存在。
                // 跟上面月历格子里 `before` 那一档同一句话、同一个理由。
                // 「那天本来就不用打卡」跟月历格子里的 `off` 是同一句话、同一个
                // 理由：不说的话，一周三次的习惯的每个周二在这张图上都写着
                // 「没打卡」，而那是一句不成立的话——一年五十二次。
                label={(key, v) => `${key} ${key < h.startKey ? '那时还没有这个习惯'
                  : v > 0 ? '打过卡'
                    : h.checkinDays && !h.checkinDays.includes(weekdayOf(key)) ? '这天不用打卡'
                      : '没打卡'}`}
                ariaLabel={`「${h.title}」这一年的打卡热力图`}
              />
            )}
          </div>
          </div>
        </section>
        );
      })}
      </div>
    </>
  );
}
