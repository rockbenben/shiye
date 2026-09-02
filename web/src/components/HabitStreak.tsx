import type { HabitState } from '../lib/habit.js';

/**
 * 「今天」专属的连续打卡条（规格原话：「在『今天』里显示成连续打卡条」）。
 *
 * **只在 `TodayView.tsx` 里被引用**——`TaskCard.tsx` 不认识这个组件、不算
 * `habitStreak()`，「按来源」「看板」「四象限」「全部」等视图共用的还是裸
 * `TaskCard`，天然看不到这一行，不用在这几个视图里另外挡一次。
 *
 * `streak === 0 && doneToday === false`（这个习惯还没打过卡）时不渲染任何
 * 东西——挂一个「连续 0 天」是噪音，调用方（`habitStreak()`）的返回值本身
 * 就是这个判断的依据，这里再判一次是双保险，防止某个调用点漏判。
 *
 * 纯 CSS，不用 antd 组件——不然要绕 `colorPrimary` 那个盲区（全局是群青，
 * `theme.css` 的前缀扫描守不到，见 theme.ts 顶部注释和 FilterBar/TaskCard
 * 两处已经踩过的坑）。打卡是人自己做的事，不上群青——那是配给 AI 产出的颜色。
 */
export function HabitStreak({ habit, compact }: { habit: HabitState; compact?: boolean }) {
  /**
   * **每周的习惯说的是另一句话。** 一条「一周三次」的健身，周一三五做完之后
   * 「连续天数」是 1（周二没做）——那个数字对它是句假话，它本来就不用天天做。
   * 所以这一档写「本周 2/3 · 连续 4 周」，`week` 是不是 null 就是判据
   * （判据在 `lib/habit.ts`，这里不重新判一次「它是哪种习惯」）。
   */
  const w = habit.week;
  if (w) {
    // 一次都还没做、也没连上过：跟每天那种「连续 0 天」同一条，挂着是噪音。
    if (w.done === 0 && habit.streak === 0) return null;
    return (
      <div
        className={`ink-habit-streak${compact ? ' ink-habit-streak-compact' : ''}`}
        aria-label={`本周已打卡 ${w.done} 次，目标 ${w.target} 次${habit.streak > 0 ? `，连续 ${habit.streak} 周达标` : ''}`}
      >
        <span aria-hidden="true">🔥</span>
        <span>本周 {w.done}/{w.target}</span>
        {habit.streak > 0 && <span>· 连续 {habit.streak} 周</span>}
      </div>
    );
  }
  if (habit.streak === 0 && !habit.doneToday) return null;
  return (
    <div
      // compact（task-5）：行档（TaskRow）下用，收窄间距——.ink-habit-streak-compact
      // 定义见 theme.css，只调 margin/padding，不碰字色/背景，群青规矩不变。
      className={`ink-habit-streak${compact ? ' ink-habit-streak-compact' : ''}`}
      // aria-label 挂在这个裸 div 上——generic 角色的元素不保证读屏软件会
      // 采信 aria-label（accessible-name 计算对 generic 角色不认它），多数
      // 会退回去读子节点的可见文本。原来「今天还没打卡」那半句连子节点都是
      // aria-hidden，退回去读也读不到，等于对读屏用户整句消失——final-review.md
      // m6。aria-label 留着（不指望但不影响，读到了算多一层保险），下面把
      // `.ink-habit-pending` 的 aria-hidden 去掉，让退回去读子节点这条路也
      // 能读到完整的话，两条路径都保底。
      aria-label={`连续打卡 ${habit.streak} 天${habit.doneToday ? '' : '，今天还没打卡'}`}
    >
      <span aria-hidden="true">🔥</span>
      <span>连续 {habit.streak} 天</span>
      {!habit.doneToday && <span className="ink-habit-pending">· 今天还没打卡</span>}
    </div>
  );
}
