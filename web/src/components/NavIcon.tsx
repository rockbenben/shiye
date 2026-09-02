import type { ReactElement } from 'react';

/**
 * 导航上那一列小记号（仿滴答清单：它侧栏每一行前面都有一个图标）。
 *
 * **为什么要有**：在这之前侧栏是十几行纯文字，字号、字重、缩进全一样——
 * 「已完成」和「垃圾箱」在余光里长得一模一样，找一个去处得逐行读过去。一个
 * 图标把「读」变成「认」，这是这一列唯一真正的可读性问题。
 *
 * **为什么是自己画的，不是拿一套现成图标**：这一屏所有的线都是 1px 界行、
 * 直角、不填色（见 theme.css 顶部「手稿与批注」）。市面上的图标包要么是圆角
 * 填充块、要么自带一套阴影和圆角，混进来就是两种语言。这里全部是同一支笔：
 * `viewBox="0 0 16 16"`、`stroke="currentColor"`、`stroke-width="1.4"`、
 * 不填色，跟 brand/mark.svg 那三根竖条和一个圈同一套画法。
 *
 * **颜色一律 `currentColor`**：这些记号不上任何自己的颜色——包括群青。它们是
 * 导航结构，不是 AI 产出（群青是配给制，见 theme.css 顶部）。选中态、次要态
 * 的颜色由外面那一行的 `color` 决定，图标跟着走。
 *
 * 键就是视图注册表里的 `key`（`lib/views.tsx`），加一个去处忘了画记号会被
 * `NavIcon.test.tsx` 那条守卫拦下来——不是运行时报错，是构建期就红。
 */

/** 每个记号的笔画。写成数据而不是十几段 JSX：守卫测试要能数它。 */
const STROKES: Record<string, ReactElement> = {
  // 任务：一个方框里打个勾。**这一条不对应任何一个视图**，它是竖栏上「任务」
  // 那一整个模块（`lib/views.tsx` 的 `TASKS_MODULE_KEY`）——滴答那条竖栏上
  // 第一颗也正是这个形状。
  tasks: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2.5" />
      <path d="M5 8.2 7.2 10.5 11.2 5.8" />
    </>
  ),
  // 收件箱：一个浅盘子 + 一支往里落的箭头。托盘那道折线是「东西堆在这儿」。
  inbox: (
    <>
      {/* 一个托盘。**原来还画了一支往里落的箭头**，15px 下两样挤在一起是
          一团黑，认不出是什么——删掉箭头，剩下的形状反而立刻读得出来。 */}
      <path d="M2.5 3.5h11l1 6.5v3.5h-13V10l1-6.5Z" />
      <path d="M1.5 10h4l1 1.5h3l1-1.5h4" />
    </>
  ),
  // 今天：日历翻开的那一页，中间一个点——「就是这一天」。
  today: (
    <>
      <rect x="2" y="3" width="12" height="11" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
      <circle cx="8" cy="10" r="1.4" />
    </>
  ),
  // 接下来：同一本日历，右边一支箭头——往后翻。
  upcoming: (
    <>
      {/* 同一本日历，右下角缺一块、补一支往右的箭头——往后翻。
          **箭头是横的、贴着底边**：斜着放或者压在格子上，15px 下会跟日历的
          竖线糊成一片。 */}
      <path d="M8.5 13.5H2V3h12v5.5" />
      <path d="M2 6.5h12M5 1.5v3M11 1.5v3" />
      <path d="M9.5 12h5m0 0-1.8-1.8M14.5 12l-1.8 1.8" />
    </>
  ),
  // 全部：三行，每行前面一个点。就是一份清单本身。
  all: (
    <>
      <path d="M6 4h8M6 8h8M6 12h8" />
      <circle cx="2.8" cy="4" r="0.9" />
      <circle cx="2.8" cy="8" r="0.9" />
      <circle cx="2.8" cy="12" r="0.9" />
    </>
  ),
  // 按来源：一根线分成两支——这一批哪来的（AI 拆的 / 自己记的）。
  source: (
    <>
      {/* 一根主干分出两支，每支末端一个点——这一批哪来的（AI 拆的 / 自己
          记的）。末端那两个点是关键：没有它们，剩下的「<」在 15px 下会被
          当成一个返回箭头。 */}
      <path d="M2 8h4M6 8v-4h4M6 8v4h4" />
      <circle cx="11.6" cy="4" r="1.6" />
      <circle cx="11.6" cy="12" r="1.6" />
    </>
  ),
  // 未归类：一个**空的**文件夹标签——「清单」那一段每一项前面都有清单色的
  // 圆点或 emoji，这一项恰恰是「一个清单都没归进去」，所以画成一个没装东西的
  // 夹子：轮廓在、里面空着。不画成问号：那是「不知道」，而这一堆是「还没分」。
  nolist: (
    <>
      <path d="M2 4.5h4l1.2 1.5H14v6H2z" />
      <path d="M5.6 9h4.8" />
    </>
  ),
  // 已完成：一个勾。
  done: <path d="M2.5 8.5 6 12l7.5-8" />,
  // 垃圾箱：桶身 + 盖子。**不画成叉**：叉是「关掉」，这是「扔进去的那些」。
  trash: (
    <>
      <path d="M3.5 4.5 4.5 14h7l1-9.5" />
      <path d="M2 4.5h12M6 4.5V2.5h4v2" />
    </>
  ),
  // 日历：整张月历的格子。
  calendar: (
    <>
      <rect x="2" y="3" width="12" height="11" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3M6.5 6.5v7.5M10 6.5v7.5M2 10h12" />
    </>
  ),
  // **「看板」的记号删了**：它不再是一个去处（lib/listMode.ts），是清单的显示
  // 方式，那个开关在视图标题栏上、是两个字，不需要记号。留着的话
  // NavIcon.test.tsx 那条「画了却没人用」的守卫会红。
  // 四象限：一个方框，十字分四格。
  quadrant: (
    <>
      <rect x="2" y="2" width="12" height="12" />
      <path d="M8 2v12M2 8h12" />
    </>
  ),
  // 习惯：一格一格的打卡表——三行小方块，最后一行缺一个（今天还没打）。
  // **原来画的是一支循环箭头**，跟「回顾」那支往回绕的箭头在 15px 下几乎
  // 一模一样，一条栏上挨着放根本分不开。打卡表是习惯这件事本身的样子。
  habits: (
    <>
      <rect x="1.6" y="2.4" width="3.4" height="3.4" rx="0.8" />
      <rect x="6.3" y="2.4" width="3.4" height="3.4" rx="0.8" />
      <rect x="11" y="2.4" width="3.4" height="3.4" rx="0.8" />
      <rect x="1.6" y="7.3" width="3.4" height="3.4" rx="0.8" />
      <rect x="6.3" y="7.3" width="3.4" height="3.4" rx="0.8" />
      <rect x="11" y="7.3" width="3.4" height="3.4" rx="0.8" />
      <rect x="1.6" y="12.2" width="3.4" height="1.8" rx="0.8" />
      <rect x="6.3" y="12.2" width="3.4" height="1.8" rx="0.8" />
    </>
  ),
  // 专注统计：一只表——外圈 + 一根指针 + 顶上的柄。
  focus: (
    <>
      <circle cx="8" cy="9" r="5.2" />
      <path d="M8 6v3h2.4M6.2 1.6h3.6" />
    </>
  ),
  // 纪念日：一面旗子——某一天要到了。
  countdown: (
    <>
      <path d="M4 14.5V2" />
      <path d="M4 2.8h8l-2 2.6 2 2.6H4" />
    </>
  ),
  // 回顾：一支往回绕的箭头 + 底下一道横线（那一摞已经有的任务）。
  review: (
    <>
      <path d="M2.5 7A5.5 5.5 0 1 1 8 12.5" />
      <path d="M2.2 4.2v2.9h2.9" />
      <path d="M8 6.2v3h2.2" />
    </>
  ),
  // 搜索：放大镜。侧栏里没有这一项（搜索框自己在最上面），命令面板等处用得上。
  search: (
    <>
      <circle cx="7" cy="7" r="4.8" />
      <path d="M10.5 10.5 14.5 14.5" />
    </>
  ),
};

/** 有没有这个键的记号。守卫测试和 Sidebar 的兜底分支都读它。 */
export const hasNavIcon = (name: string): boolean => name in STROKES;

/** 画得出来的全部键，守卫测试拿它跟注册表对账。 */
export const NAV_ICON_NAMES = Object.keys(STROKES);

interface Props {
  /** 视图注册表里的 key（`lib/views.tsx`）。 */
  name: string;
}

/**
 * 认不出的 key 返回 `null`，不是画一个问号或者抛错——清单和标签那两段是运行时
 * 才知道数量的动态去处（`list:xxx`/`tag:xxx`），它们各自有自己的记号（清单是
 * 那个颜色圆点，标签是井号），本来就不该走这里。
 */
export function NavIcon({ name }: Props): ReactElement | null {
  const strokes = STROKES[name];
  if (!strokes) return null;
  return (
    <svg
      className="ink-nav-icon"
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      // 记号不进可访问树：它旁边就是那个去处的名字，读屏念两遍是噪音。
      aria-hidden="true"
      focusable="false"
    >
      {strokes}
    </svg>
  );
}
