import { useState } from 'react';
import { Button } from 'antd';
import type { Task, WeekStart } from '../types.js';
import { habitStats } from '../lib/habitStats.js';
import { habitDoneDays } from '../lib/habit.js';
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

/** 月历顶上那行星期标签，按 `weekStart` 轮转（不给就是周一起）。 */
const weekdayLabels = (weekStart: WeekStart): string[] =>
  Array.from({ length: 7 }, (_, i) => '日一二三四五六'[(weekStart + i) % 7]);

export function HabitStats({ tasks, now, onOpen, onCheckIn, weekStart }: Props) {
  // `weekStart` 传下去：每周那种习惯的「本周 N/M」和「连续几周」按它划周界，
  // 跟日历那七列、专注统计的「本周」必须是同一个数。
  const habits = habitStats(tasks, now, weekStart);
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

  return (
    <div className="ink-hstat-root">
      {habits.map((h) => (
        <section className="ink-hstat-card" key={h.title} aria-label={h.title}>
          <div className="ink-hstat-head">
            <button type="button" className="ink-hstat-name" onClick={() => onOpen(h.taskId)}>{h.title}</button>
            {/* 今天打没打卡是这一屏最要紧的一件事，单独标出来——底下那张
                打卡表要数到「今天」那一格才看得出来。

                **还没打、而且真有一条实例可打的时候，它是一颗按钮**：一个
                写着「今天待打卡」的纯文字标，等于把这一屏最高频的那一下推到
                三步之外（点标题 → 跳「全部」 → 在一屏任务里找到那张卡 → 勾）。
                已经打过了就还是文字——那时候没有动作可做（要反悔走勾选框那条
                路上的撤销）。没有 live 实例（整串都完成/放弃/搁置了）同样是
                文字：那时候「打卡」没有对象。 */}
            {!h.doneToday && h.liveId && onCheckIn ? (
              <Button size="small" onClick={() => onCheckIn(h.liveId!)}>今天打卡</Button>
            ) : (
              <span className={h.doneToday ? 'ink-hstat-today ink-hstat-today-done' : 'ink-hstat-today'}>
                {h.doneToday ? '今天已打卡' : '今天待打卡'}
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
            {/* 分母是「本月这个习惯能打卡的天数」：既不算还没到的，也不算建它
                之前的。整月天数会让月初第二天显示「1 / 30」，而「本月已过去几天」
                会让今天新建的习惯显示「0 / 26」——两句读起来都是「你欠了一堆」。
                判据在 habitStats.ts 的 `monthElapsed` 上。

                **分母是 0 时整栏不渲染**（手机宽度实测发现的）：那是「今天刚建了
                一个每周几次的习惯、而今天不是打卡日」——分子分母一起算成 0，
                屏幕上就成了「本月 0 / 0 天」，一个读起来像坏掉的分数。上面那句
                注释防的是「0 / 26」这种**欠账感**，没防住「0 / 0」这种**不成句**。
                跟 `workload.ts` 那条「一条都没估过时整句不出」同一条规矩：
                没有话可说的一栏不渲染，而不是渲染一个 0 让它自己解释自己。 */}
            {h.monthElapsed > 0 && <span>本月 <b>{h.monthDone}</b> / {h.monthElapsed} 天</span>}
          </div>
          {/* 可访问名跟上面那一栏说同一件事：分母是 0 时不能念「0 / 0 天」——
              读屏听到的会跟屏幕上的那句话一样费解。 */}
          <div
            className="ink-hstat-grid"
            role="img"
            aria-label={h.monthElapsed > 0
              ? `本月打卡表：${h.monthDone} / ${h.monthElapsed} 天`
              : '本月打卡表：这个月还没有打卡日'}
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
                title={`${d.key}${d.future ? '' : d.before ? ' 那时还没有这个习惯' : d.off ? ' 这天不用打卡' : d.done ? ' 打过卡' : ' 没打卡'}`}
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
        </section>
      ))}
    </div>
  );
}
