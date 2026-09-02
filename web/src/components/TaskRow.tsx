import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Dropdown } from 'antd';
import type { List, Task } from '../types.js';
import { dueChip } from '../lib/dueChip.js';
import { describeRepeat } from './RepeatFields.js';
import { blockingAncestor, childProgress, parentOf } from '../lib/hierarchy.js';
import { listLabel } from '../lib/listIcon.js';
import { allTags, formatWhen, isSettled, isTaskOverdue, displayReminderAt, notStarted, CONTEXT_LABEL } from '../lib/taskView.js';
import { PRI_LABEL } from './TaskFields.js';
import { decodeTaskMenu, taskMenuItems } from '../lib/taskMenu.js';
import { isInteractiveTarget } from '../lib/keymap.js';
import { deleteOneConfirm } from '../lib/deleteConfirm.js';
import type { DragHandleProps, MoveControls } from './TaskCard.js';

export interface TaskRowProps {
  t: Task;
  now: Date;
  /** 走的是跟「待办/开始/搁置」按钮完全一样的那条路——`PATCH { status }`，
   *  服务端自己盖 `completedAt`、自己算重复任务的下一条（`maybeSpawnNextInstance`）。
   *  这个组件不重新实现那套逻辑，只发同一种 patch。 */
  onPatch: (id: string, patch: Partial<Task>) => void;
  /** 点标题/行体——调用方决定「打开」是展开详情还是别的，这里只负责转发。
   *  **只在没按 Shift/Ctrl/Cmd 时才触发**——按了这几个键的点击被下面的
   *  `select` 接住了，见那个 prop 的注释。 */
  onOpen: (id: string) => void;
  /**
   * 「更多操作」菜单要的三样。**都可选**——十几个调用点漏接一个不该让那一行
   * 崩，没接到就少几项，跟 TaskCard 那几个可选 prop 同一条。
   *
   * 在这之前这一行的 ⋯ **只有「今天」视图里的上下移**：其余五个视图里它照样
   * 渲染、点了什么都不发生，而换成「行」密度还会静默失去卡片上那颗 ⋯ 里的
   * 每一样（编辑/置顶/跳过/改期/优先级/推迟/移动到/删除）。菜单本身在
   * lib/taskMenu.ts，两边共用同一份。
   */
  lists?: List[];
  /**
   * 全表——只用来算两个层级记号（这条属于谁、名下几个孩子做完了）。**可选**：
   * 没给就不画那两个，跟 `TaskCard.CardProps.allTasks` 一字不差的约定。
   *
   * 为什么行档也要：平铺列表里子任务紧跟在父亲后面（`lib/hierarchy.ts` 的
   * `nestChildren`），但那只是**挨着**——中间隔一条分组线、父亲被筛掉、或者
   * 换个排序，这一行就是孤零零的一条，看不出它是谁的一步。卡片上一直有这两个
   * 记号，行档一个都没有。
   */
  allTasks?: Task[];
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  /**
   * 'E' 键指到的是不是这一行。行档没有就地编辑表单，所以「进入编辑态」在这里
   * 的意思就是**展开那张卡**（跟点标题、跟 ⋯ 菜单里的「编辑」同一件事）。
   * 处理完立刻回调清掉那个请求，否则那个 id 一直挂着，下次渲染又展开一次。
   */
  editRequested?: boolean;

  /**
   * 这一行就是右边那一栏详情面板现在摊着的那一条（仿滴答清单：列表里被
   * 打开的那一行是标出来的）。
   *
   * **不标出来的话这个面板是半残的**：详情在右边、列表在左边，两边对不上
   * 号——尤其是连着点了三条之后，谁也说不出现在看的是哪一行。
   *
   * 跟 `select.selected`（勾选）是两件事，视觉上也刻意分开：勾选是一整块
   * 浅底 + 一圈边（那是「这几条要一起动」），这个只有左边一道墨线（「详情
   * 在说这一条」）。同一行可以既被勾选、又是打开的那一条。
   */
  current?: boolean;
  onEditRequestHandled?: () => void;
  /**
   * 选中态接线（批量操作的地基，见 2026-08-17-selection.md）。形状**跟
   * `TaskCard.tsx` 的 `CardProps.select` 完全一致**——同一个 `TaskGrid` 会
   * 把同一份对象喂给这两个组件的其中一个（按 density 二选一），字段对不上
   * 编译期就会报错。**不给（`undefined`）时行为跟今天一模一样**：这个 prop
   * 是否存在本身就是选中功能有没有接线的唯一开关。
   *
   * - `showCheckbox`：整个选中集合非空时为 true（调用方算好传进来）。
   * - `onClick`：标题按钮（`.ink-trow-open`）被点、且带 Shift 或 Ctrl/Cmd 时
   *   回调，`mods` 原样转发这次点击的修饰键；勾选框自己被点也走这个回调，
   *   固定传 `{ shift: false, ctrlOrMeta: true }`——「一旦选中了至少一张，
   *   之后平常点勾选框就能加减，不需要按住 Ctrl」，跟 `TaskCard.tsx` 同一条
   *   规矩。
   *
   * **没有修饰键的点击永远走 `onOpen`，不看 `select` 给没给**——今天点标题
   * 就展开这件事不因为选中功能接线而改变，两个手势按「有没有按修饰键」分岔，
   * 不是「有没有 `select`」分岔。
   */
  select?: {
    selected: boolean;
    showCheckbox: boolean;
    onClick: (mods: { shift: boolean; ctrlOrMeta: boolean }) => void;
  };
  /** 这条任务是不是还挂着一条未处理的 AI 建议（`proposals?.byTask.get(t.id)`
   *  非空，由调用方算好传进来，这个组件自己不知道全局有哪些建议）。**只画
   *  一个记号，不画建议本身**——建议的完整内容（从什么改成什么、接受/忽略
   *  按钮）还是 `TaskCard.tsx` 的 `ProposalNote`，行档点标题展开成卡片之后
   *  才看得到；这里只负责「提醒你这条有事，该点开看看」。**这是群青唯一
   *  合法出现在这一整个文件里的地方**——AI 产出的内容正是群青该标的东西，
   *  跟这一行其余全部安静的记号（到期、标签、优先级……都是人这一侧的事实）
   *  不一样。 */
  hasProposal?: boolean;
  /**
   * 拖拽排序抓手的接线（task-5-brief）。**只有「今天」传**——其它五个走
   * `TaskGrid` 的密度视图没有手动排序这回事。跟 `TaskCard.tsx` 的 `drag`
   * prop 同一个形状，区别只在挂的位置：这里 `draggable` 挂在悬停/聚焦才
   * 出现的抓手（`.ink-trow-handle`）上，**不是整行**——`TodayView.tsx`
   * 顶部注释解释过为什么整行不能是 `draggable`（会让标题里选不了文字）。
   * 不给（undefined）时抓手完全不出现，其余五个视图的行为一个字不变。
   * 形状见 `TaskCard.tsx` 的 `DragHandleProps`。
   */
  drag?: DragHandleProps;
  /**
   * 上/下移按钮的接线，形状跟 `TaskCard.tsx` 的 `MoveControls` 完全一致——
   * 同样只有「今天」传。`TaskCard` 那两颗横排的按钮在一行约 32px 高的行里
   * 放不下，收进悬停/聚焦才出现的「更多」菜单：点一次 `.ink-trow-more`
   * 展开，出现一个装着「上移」「下移」的小面板。不给（undefined）时
   * 「更多」按钮没有 `onClick`——点了什么都不发生，跟其余五个视图今天的
   * 行为一致。
   */
  move?: MoveControls;
  /**
   * 紧凑排版（task-3-brief 修复轮 1 · C-2）。**只有看板传**——那一列只有
   * 217px 宽（四列同屏挤出来的），到期 chip + 标签胶囊这些不换行的元数据
   * 会把标题挤到只剩一个字（实测：`.ink-trow-open` 减掉 meta 之后只剩
   * ~13px），而看板恰恰是最需要读清标题的地方（拖哪张卡）。四象限也是
   * `layout="cells"` 但每格 455px，标题读得全，不传这个 prop。
   *
   * 打开时：标题独占一行（`.ink-trow-open-compact` 把 `.ink-trow-open` 从
   * 一行拆成两行），到期/优先级掉到第二行，**标签和子任务数不渲染**（连
   * DOM 都不进，不是 CSS 藏起来——跟 `.ink-trow-more` 悬停才挂进 DOM 同一条
   * 「没占位」的规矩）。行会从约 32px 变成约 48px，看板一列 8 条还是一屏
   * 放得下。不给（undefined，其余六个视图）时今天的行为不变。
   */
  compact?: boolean;
}

/**
 * 密度更高的那一档任务行（规格「两档都做，可切」的 Task 1：先做行本身，
 * 密度开关、接进各视图是后面几个 Task）。跟 `TaskCard` 的关系是「同一条
 * 任务的另一种渲染」，不是替换——这里先只做纯展示 + 完成勾选，`TaskCard`
 * 现有的那一整套（编辑、拖拽状态、番茄钟、附件……）都还在，且都没被这个
 * 文件引用。
 *
 * 纯 CSS 画勾选圈，**不用 antd 组件**——绕开 antd Checkbox/Button 的选中色
 * 读全局 `colorPrimary`（群青）那个已知盲区（`theme.ts` 顶部注释、
 * `HabitStreak.tsx` 同一个选择），这一整行也确实没有用到任何 antd 组件的
 * 必要：勾选是个纯 CSS 圆圈，「更多」是个纯文本按钮，批量操作的选中框是
 * 原生 `<input type="checkbox">`，都不需要 antd。
 */
export function TaskRow({
  t, now, onPatch, onOpen, select, hasProposal, drag, move, compact, lists, allTasks, onEdit, onDelete,
  editRequested, onEditRequestHandled, current,
}: TaskRowProps) {
  const { modal } = AntApp.useApp();

  // 依赖数组只列 `editRequested` 本身：`onEdit`/`onEditRequestHandled` 每次
  // 渲染都是新的函数引用，列进去会让这个 effect 每次渲染后都重跑一遍。
  // 跟 TaskCard 里 `autoEdit` 那个 effect 是同一条。
  useEffect(() => {
    if (!editRequested) return;
    onEdit?.(t.id);
    onEditRequestHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上面
  }, [editRequested]);
  const [hover, setHover] = useState(false);
  // 「更多」菜单（上/下移）展开没有——只有 `move` 给了才有意义，见
  // `.ink-trow-more` 渲染处。跟 `hover` 分开存：`hover` 决定这一整套
  // （抓手/更多/菜单）在不在 DOM 里，`menuOpen` 只决定菜单这一层自己收没收。
  const [menuOpen, setMenuOpen] = useState(false);
  // 「更多」的 aria-controls 指向这个 id（修复轮 1 · M-3）——按 t.id 拼，
  // 同一屏多行时不会撞。
  const menuId = `trow-menu-${t.id}`;
  const done = t.status === 'done';
  const chip = dueChip(t.due, now);
  // 「还没到开始时间」那枚。跟上面同一个函数，理由写在渲染处。
  const startChip = dueChip(t.startAt, now);
  // 过期红只在「还没做完」时才画——跟卡片上「已过期」标签同一条口径
  // （taskView.ts 的 isOverdue：done/later 不算过期，人已经对这条任务做过
  // 判断了）。**跟 TaskCard 用同一个判据**（整分支审查 C2）：以前这里只写
  // `isOverdue`（只看 `due`），只设了提醒、没设 `due` 的任务——`dueChip(null,
  // now)` 返回 null，连 chip 都不画——行档上会一个记号都没有，而底部
  // 「有 N 条已经过期了」用的 `countStale` 判据是同一个 `isTaskOverdue`
  // （`due` 说了算，没有 due 才看提醒——不是单纯的 OR，见那边的注释），
  // 会出现「底下说有过期的，上面一点红都没有」。`isTaskOverdue` 自己已经在
  // `!t.due`/`!remindAt`/解析不了时各自兜底成 false，不用再叠一层
  // `chip !== null` 去防同一件事。
  const overdueStyle = isTaskOverdue(t, now);
  // AI 推断的到期时间也要标群青——跟 TaskCard.tsx 里「截止/提醒」键名用的
  // 是同一个判定条件（`t.source === 'ai'`），原样复用，不新开一套判断
  // （两处判据不同步就是下一个缺陷）。**过期红优先**：两个都占的话走
  // --overdue，群青只在没过期时才出现——「这件事该关注了」比「这是谁写的」
  // 更要紧。
  const aiDueStyle = t.source === 'ai';
  /**
   * **「快到期」那一档**（仿 OmniFocus 的 `Due Soon`）。判据在 `dueChip` 里，
   * 这儿只决定画不画。
   *
   * 三条优先级，从高到低：过期红 > 群青（AI 写的） > 快到期。前两条的相对
   * 顺序是既有的（见上面），快到期排在最后是因为它是三者里最弱的一句话——
   * 「该关注了」和「这是谁写的」都比「快了」更要紧。
   *
   * **跟过期红同一条口径**：`isSettled` 的任务不画。做完了/搁置了的任务
   * 「快到期」是句废话，人已经对它做过判断了。
   */
  const soonStyle = !overdueStyle && !aiDueStyle && chip?.soon === true && !isSettled(t);
  // 提醒时刻，铃铛用（设计①：「提醒：一个小铃铛，不是『提醒 2026-08-12
  // 09:00』整串」）。铃铛的 `title`/`aria-label` 里那个时刻是**下一次响的
  // 那个**，不是最早那个——一条任务现在可以有好几个提醒，跟 TaskCard 的
  // remindAt 同一个判据（taskView 的 `displayReminderAt`）。
  const remindAt = displayReminderAt(t, now);
  // 子项数。`?? 0` 兜底——跟 TaskCard.tsx 渲染 `.ink-subtask` 那处同一条理由：
  // GET /api/tasks 不校验文件写入的数据，一个缺 `subtasks` 字段的任务对象，卡档
  // 能兜住，行档裸读 `.length` 会直接 TypeError，整个看板区域塌成错误面板
  // （BoardErrorBoundary 兜得住不至于白屏，但那不是「正常渲染」，见整分支审查 D1）。
  // 算在这里而不是在 JSX 里就地写：下面渲染处要用到三次（条件、aria-label、正文），
  // 三份各自兜底就是三个可以各自改漏的地方。
  const subCount = t.subtasks?.length ?? 0;
  /**
   * 「打标签」那一组的候选。从 `allTasks` 现算——它本来就在手上（层级记号也
   * 读它），不为这一组再穿一根 prop 下来。`useMemo` 是必要的而不是顺手：
   * 菜单的 `items` 每次渲染都重算一遍，不 memo 就是每张卡每一帧扫一遍全表。
   */
  const tagChoices = useMemo(() => (allTasks ? allTags(allTasks) : []), [allTasks]);

  // 层级记号的两份数据。`allTasks` 没给就都是空，那两个记号整个不渲染。
  // 归到哪个清单。找不到就当没有——清单被删掉之后那条任务的 `listId` 还指着
  // 它，显示一个裸 uuid 对人没有意义（跟 `TaskCard.tsx` 那份一字不差）。
  const list = t.listId ? (lists ?? []).find((l) => l.id === t.listId) : undefined;
  const parent = allTasks ? parentOf(t, allTasks) : undefined;
  // 挡着这一条的那个祖先，跟卡片那边同一份判据。
  const blocker = allTasks ? blockingAncestor(t, now, allTasks) : undefined;
  const kids = allTasks ? childProgress(t.id, allTasks) : null;

  const toggle = () => {
    onPatch(t.id, { status: done ? 'todo' : 'done' });
  };

  // 标题按钮被点：带了 Shift/Ctrl/Cmd 且接了 `select` 就走选中，别的情况
  // （没按修饰键，或者调用方压根没给 select）一律 `onOpen`——今天点标题就
  // 展开这件事不能因为选中功能接线了就变了，跟 TaskCard.tsx 的
  // `isInteractiveTarget` 那道判断是同一个目的、不同的实现（TaskCard 挡的是
  // 「点在别的按钮上」，这里挡的是「按了修饰键」，两种手势用同一个按钮承载，
  // 靠有没有修饰键分岔）。
  const onTitleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (select) {
      const shift = e.shiftKey;
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      if (shift || ctrlOrMeta) {
        // Shift 会被浏览器当成扩展文本选区的手势，不拦的话标题文字被刷蓝
        // 一片——跟 TaskCard.tsx 同一条教训。
        if (shift) e.preventDefault();
        select.onClick({ shift, ctrlOrMeta });
        return;
      }
    }
    onOpen(t.id);
  };

  /**
   * ⋯ 菜单那份配置。**提出来是因为它现在有两个入口**：右上角那颗 ⋯，和
   * 在这一行上点右键。同一份 `items` + 同一个 `onClick`，不写两遍——写两遍
   * 就是等着「右键菜单比 ⋯ 少一项」这种事发生。
   *
   * `onEdit`/`onDelete` 没给的调用点（比如只读的列表）拿不到菜单，两个入口
   * 一起没有：一个点了什么都不发生的右键菜单比没有更糟。
   */
  const rowMenu = onEdit && onDelete ? {
    items: taskMenuItems(t, { lists: lists ?? [], now, tags: tagChoices }),
    onClick: ({ key }: { key: string }) => {
      const action = decodeTaskMenu(key, t, now);
      if (!action) return;
      if (action.kind === 'edit') return onEdit(t.id);
      if (action.kind === 'patch') return onPatch(t.id, action.patch);
      if (action.kind === 'duplicate') return;
      // **只有 `delete` 才往下走。** 这里原来是「其余一律掉进删除确认框」，而
      // `decodeTaskMenu` 还会返回 `kind: 'skip'`——于是「行」密度下点「跳过本次」
      // 弹出的是「删除…？」，确认一下任务就进了垃圾箱。实测复现过。
      //
      // 现在 `skip` 那一项由 `canSkip` 闸门挡在菜单之外（这个组件没有 `onSkip`），
      // 这一句是第二道：以后再加一种 kind，漏接的后果是「点了没反应」，不是删任务。
      if (action.kind !== 'delete') return;
      // 删除先问一句——**跟卡片上那句一字不差**：同一个动作在两种密度下说两种
      // 话，等于让人以为它们是两回事。现在真的是同一份了（`lib/deleteConfirm.ts`）。
      modal.confirm({
        ...deleteOneConfirm(t, allTasks ?? [t]),
        okText: '删除',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => onDelete(t.id),
      });
    },
  } : null;

  const row = (
    <div
      // 抓手位留白（.ink-trow-draggable，整分支审查 D2）只在这一行可能有
      // 抓手时才加——`drag` 只在「今天」或看板/四象限（onDropTo）时才给，
      // 全部/接下来/已完成/搜索/清单/标签这六个视图从来没有抓手，之前那
      // 28px 左内边距在这六个视图里恒空，分组标题顶格、下面每一行圆圈却
      // 缩进 28px，看着错位。见 TaskRowProps.drag 的注释。
      className={`ink-trow${select?.selected ? ' ink-trow-selected' : ''}${current ? ' ink-trow-current' : ''}${drag ? ' ink-trow-draggable' : ''}`}
      // 读屏那一侧的同一件事：这一行是「当前打开的那一条」。`aria-current`
      // 没有 `true` 之外更合适的取值（page/step/location 都不是这个语义）。
      aria-current={current ? 'true' : undefined}
      /** `X` 选中/取消选中这一行，`Shift+X` 连选。判据和理由跟 `TaskCard.tsx`
       *  那份一字不差（那边的注释是正本）——同一个 `TaskGrid` 会按密度在卡片
       *  和行之间切换，「键盘能不能进选中态」不该跟着密度变。 */
      onKeyDown={select ? (e) => {
        if (e.key !== 'x' && e.key !== 'X') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isInteractiveTarget(e.target)) return;
        e.preventDefault();
        select.onClick({ shift: e.shiftKey, ctrlOrMeta: true });
      } : undefined}
      /**
       * **双击这一行 = 改它。** 单击是「打开」（右边详情面板），双击是「就地
       * 改」——这是列表里最省事的一步，之前只能先选中再按 `E`，或者鼠标挪到
       * 行尾去点 ⋯ 再点「编辑」。
       *
       * `isInteractiveTarget` 挡掉输入框/按钮/链接上的双击：在标题输入框里
       * 双击是「选中一个词」，那是浏览器的事，不该被劫走。
       */
      onDoubleClick={onEdit ? (e) => {
        if (isInteractiveTarget(e.target, 'button, a')) return;
        e.preventDefault();
        onEdit(t.id);
      } : undefined}
      onMouseEnter={() => setHover(true)}
      // 鼠标真的离开才收——菜单是这个 div 的子节点，鼠标移进菜单不算离开
      // （DOM 树关系判定，不是可视区域），不用另外挡。顺带收起菜单本身：
      // 不收的话下次鼠标再移进来，菜单会带着上一次的展开状态突然重新出现。
      onMouseLeave={() => { setHover(false); setMenuOpen(false); }}
      // 键盘可达性（Task 1 复审 M-9，一直挂着，这个 Task 里补上）：`hover`
      // 这个名字不准了——它现在其实是「要不要把抓手/更多按钮挂进 DOM」，
      // 鼠标悬停只是触发它的一条路，聚焦是另一条。React 的 onFocus/onBlur
      // 挂在容器上会收到子孙元素的 focusin/focusout（原生事件本身冒泡），
      // 不用给每个可聚焦的子元素各绑一份。
      onFocus={() => setHover(true)}
      // relatedTarget 是焦点去了哪——还在这个容器内部（比如从标题按钮切到
      // 「更多」按钮）不算离开，不能收；离开了容器才真的收，同时收起菜单，
      // 跟 onMouseLeave 同一条理由。
      onBlur={(e) => {
        // move.busy 期间不收（修复轮 1 · C-1）：这段时间上/下移按钮是被我们
        // 自己 disabled 掉的，浏览器把一个正聚焦的元素禁用时会自动把焦点
        // 打回 <body>（`relatedTarget` 是 null）——这不代表用户离开了这一行，
        // 是我们自己造成的副作用。见 `TaskCard.tsx` `MoveControls.upRef`
        // 的注释：那两个 ref 存在的唯一理由就是要在这个浏览器行为发生之后，
        // 把焦点重新 `focus()` 回按钮上——如果这里趁机把菜单卸载掉，
        // `upRef`/`downRef` 会各回调一次 `null`，`TodayView.tsx` 那个焦点
        // 归还 effect 就找不到目标了，行档就没有了卡档本来就有的「刷新到达
        // 之后焦点回到操作过的那张卡」这条行为。
        if (move?.busy) return;
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setHover(false);
          setMenuOpen(false);
        }
      }}
    >
      {/* 排序抓手：圆圈左边，只有它自己是拖拽激活节点——不是整行，见
          TaskRowProps.drag 的注释。

          **常驻挂在 DOM 里，视觉上悬停/聚焦才显示**（复审修复轮 1 · I4：
          以前是 `{hover && drag && (...)}`，抓手只在悬停/聚焦之后才挂进
          DOM——而它在 DOM 里的位置排在勾选圈**之前**，纯键盘正向 Tab 的
          实际顺序因此是「Tab 落到勾选圈（此时抓手还不在 DOM）→ focus 冒泡
          触发 hover → 抓手挂到它前面→ 再 Tab 走到标题，抓手被跳过」，只有
          Shift+Tab 才摸得到，等于键盘用户正向根本走不到它——这个仓库靠
          `App.tsx` 固定 `density="row"` 的看板/四象限两处（`TaskGrid.tsx` 的
          `onDropTo`）全部踩了这个坑，只有「今天」卡档的 `.ink-rank`（常驻，
          从来没有过 hover 门槛）是好的。这里的布局空间本来就已经靠
          `.ink-trow-draggable`（挂在最外层 `.ink-trow` 上）无条件预留了
          28px，抓手节点本身早不早出现在 DOM 里不影响任何人的布局；现在
          常驻挂着，只用 `.ink-trow-handle-hidden`（`theme.css`，
          `opacity:0` + `pointer-events:none`）控制「没悬停/没聚焦时看不见、
          鼠标碰不到，但 Tab 依然能停」，`hover` 变 true（悬停或聚焦，两条
          路都会触发既有的 onMouseEnter/onFocus）时去掉这个 class，抓手正常
          显示——键盘正向 Tab 现在第一个就能停在这里。 */}
      {drag && (
        <div
          className={[
            'ink-trow-handle',
            hover ? '' : 'ink-trow-handle-hidden',
            drag.disabled ? 'ink-rank-locked' : '',
          ].filter(Boolean).join(' ')}
          ref={drag.setActivatorNodeRef}
          // 可访问名字必须显式给——见 TaskCard.tsx DragHandleProps.title 的
          // 注释（复审修复轮 1 · I3）：这个节点有文本内容（固定 `⠿`），
          // `title` 属性不会被浏览器/读屏软件当成 accessible name 的来源。
          aria-label={drag.title}
          title={drag.title}
          {...drag.attributes}
          {...drag.listeners}
        >⠿</div>
      )}

      <button
        type="button"
        className={`ink-trow-check${done ? ' ink-trow-check-done' : ''}`}
        aria-pressed={done}
        aria-label={done ? `把「${t.title}」标回待办` : `把「${t.title}」标记完成`}
        onClick={toggle}
      >
        {done && <span aria-hidden="true">✓</span>}
      </button>

      {/* 勾选框：只在「已经选中了至少一张」时出现（select.showCheckbox 由
          TaskGrid 按全局选中集合算好传进来）——跟 TaskCard.tsx 的
          .ink-sel-check 同一条规矩，这里是原生 checkbox，不需要套
          boardLocalTheme 去压 antd 的选中色。点它是「平常点击就能加减」，
          不需要按修饰键，见 TaskRowProps.select 的注释。跟勾选圈/行体/更多
          是同一层的兄弟节点，`.ink-trow` 自己没有 onClick，不需要
          stopPropagation——没有祖先监听器可冒泡。 */}
      {select?.showCheckbox && (
        <input
          type="checkbox"
          className="ink-trow-select"
          aria-label={`选中「${t.title}」`}
          checked={select.selected}
          onChange={() => select.onClick({ shift: false, ctrlOrMeta: true })}
        />
      )}

      {/* 真正的「行体」：一个 <button>，标题+meta 全在里面——原生元素自带
          键盘可达（Tab 能停、Enter/Space 能触发），不用自己拼 role="button"
          + tabIndex + onKeyDown 那一套。它不能包住上面的勾选圈和下面的
          「更多」——嵌套 <button> 不合法，所以三者是兄弟节点，不是父子。 */}
      <button
        type="button"
        className={`ink-trow-open${compact ? ' ink-trow-open-compact' : ''}`}
        title={t.title}
        onClick={onTitleClick}
      >
        <span className={`ink-trow-title${done ? ' ink-trow-title-done' : ''}`}>{t.title}</span>
        <span className="ink-trow-meta">
          {hasProposal && (
            <span className="ink-trow-proposal" role="img" aria-label="有 AI 待决建议">●</span>
          )}
          {/* **还没到开始时间。** 卡片上画着「9 月 1 日 开始」，行档原来一点记号都没有
              ——一条现在根本干不了的任务，在行密度下跟一条立刻能干的长得一模一样，
              而那正是这个字段存在的全部理由。跟下面「在等」「重复」那一段注释说的是同一件事：
              卡片上画得出来、行档上没有，同一条任务换个密度就少一条信息。

              **用 chip 不用字形**：旁边那一排单字形（提醒、在等、重复、置顶）已经占了
              好几个语义，再挑一个「还没开始」的字形只会是个谜；而「起」这个后缀把它跟
              旁边那枚到期 chip 分开了，不会被读成截止时间。排在到期前面：开始在截止之前。 */}
          {/* 用 `dueChip` 而不是卡片那边的 `dueText`：**两枚 chip 就摆在一起**，各用一个
              格式化函数的话，一枚写「明天」、旁边一枚写「9 月 1 日 18:00」，看着像两种
              不同的东西（实拍出来的）。`dueChip` 就是行档这一档的写法：只答「哪一天」，
              只有「今天」那一档才带时刻。它返回的 `overdue` 这儿用不上——开始时间没有
              「过期」这回事（到了就是到了，这枚 chip 自己就消失了）。 */}
          {notStarted(t, now) && startChip && (
            <span className="ink-trow-start">{startChip.text} 起</span>
          )}
          {/* **父亲还没开始，这一条现在也做不了**（`blockingAncestor`，出处在
              hierarchy.ts）。跟卡片那边同一句话、同一条理由：四象限和「现在做
              什么」按这个判据把它挡在外面，屏幕上就得说得出为什么。
              行档这一档比卡片窄，只写名字不写日期——「装修 才开始」比一个裸
              日期更能让人知道下一步去哪儿改；具体哪天点开卡片就看到。
              自己也没开始时不重复画，跟卡片那边同一条。 */}
          {!notStarted(t, now) && blocker && (
            <span className="ink-trow-start">等「{blocker.title}」</span>
          )}
          {chip ? (
            <span
              className={`ink-trow-due${overdueStyle ? ' ink-trow-due-overdue' : aiDueStyle ? ' ink-time-ai' : soonStyle ? ' ink-trow-due-soon' : ''}`}
            >
              {chip.text}
            </span>
          ) : overdueStyle && (
            // 只设了提醒、没设 due 的任务：dueChip(null, now) 是 null，没有
            // 到期 chip 可画，但 isTaskOverdue 仍然可能因为提醒过期而为真——
            // 这里补一个同样式的「已过期」chip（复用 .ink-trow-due-overdue，
            // 不新开一条 CSS 规则），别让这一整行一点红都没有（整分支审查
            // C2）。
            <span className="ink-trow-due ink-trow-due-overdue">已过期</span>
          )}
          {remindAt && (
            <span className="ink-trow-remind" role="img" aria-label={`提醒：${formatWhen(remindAt)}`}>🔔</span>
          )}
          {/* 在等谁 / 会重复。**跟 🔔 一字不差的写法**：一个字形 + `aria-label`
              带上内容，不写正文——这一行的宽度全靠标题吃，卡片上那种「⏳ 在等
              张老师回邮件」的整句在这儿会把标题挤没。
              为什么要有：卡片上这两样都画得出来，行档一个都没有，于是**同一条
              任务换个密度就少两条信息**。「在等」那一条尤其站不住——筛选栏一直
              有「只看等待中的」，筛出一屏行，看不出各自在等什么，也想不起该去
              催谁（这句话是卡片上那块的原话，在行档同样成立）。
              `compact`（看板那一列 217px）也照常显示：这两个都是单字形，宽度上
              跟 ●／🔔／⚑ 一档，让路的是标签和子项数那种成串的东西。 */}
          {t.waitingFor && (
            <span className="ink-trow-waiting" role="img" aria-label={`在等：${t.waitingFor}`}>⏳</span>
          )}
          {t.repeat && (
            <span className="ink-trow-repeat" role="img" aria-label={`重复：${describeRepeat(t.repeat)}`}>🔁</span>
          )}
          {/* 置顶。**这个记号不是锦上添花，是在解释这一行为什么在这儿**：置顶是
              所有排序的第一个比较键（`taskView.ts` 的 `byPinned`），一条被顶到
              最前的任务在行档上没有任何说明，整份列表的顺序看起来就是乱的。 */}
          {t.pinned && <span className="ink-trow-pin" role="img" aria-label="已置顶">📌</span>}
          {/* 层级。子任务写「↳ 父亲的标题」，父任务写「n/m」——跟卡片上同一对
              记号、同一份判据（`lib/hierarchy.ts`），只是省掉「属于」「子任务」
              那几个字：这一行的宽度全归标题。`compact` 下不画，跟标签/子项数
              同一档——它们是成串的东西，不是单字形。 */}
          {!compact && parent && (
            // `role="img"` + `aria-label`：可见文字是「↳ 装修」，省掉了「属于」两个字
            // （这一行的宽度全归标题）——但读屏念出来就成了「右下箭头 装修」，谁也
            // 听不出这是「它属于装修」。跟同一排的 🔔／⏳／🔁 一字不差的处理。
            <span
              className="ink-trow-parent"
              role="img"
              aria-label={`属于「${parent.title}」`}
              title={`属于「${parent.title}」`}
            >↳ {parent.title}</span>
          )}
          {!compact && kids && (
            <span className="ink-trow-kids" role="img" aria-label={`子任务 ${kids.done}/${kids.total}`}>
              {kids.done}/{kids.total}
            </span>
          )}
          {t.priority > 0 && (
            <span
              className={`ink-pri-flag ink-pri-${t.priority}`}
              role="img"
              aria-label={`优先级：${PRI_LABEL[t.priority as 1 | 2 | 3]}`}
            >⚑</span>
          )}
          {/* 这一行属于哪个清单——**卡片档一直有（左边那条竖条 + 圆点和名字），
              行档一个字都没有**。而行档是「全部」「搜索」「今天」这类跨清单
              视图里最常用的密度，恰恰是「这条是哪儿的」最要紧的地方：同一个
              列表里躺着工作、家里、购物三份清单的任务，行档看不出任何区别。
              复用卡片那三个 class（`.ink-list-name`/`.ink-list-dot`/
              `.ink-list-emoji`），不新造样式：同一个东西在两处不该长两个样。
              `compact`（看板一列 217px）下不画，跟标签/子项数同一档——而且
              按清单分列的看板上，每一行再报一遍列头已经说过的话是纯噪音。 */}
          {!compact && list && (
            <span className="ink-list-name">
              {listLabel(list.name).icon
                ? <span className="ink-list-emoji">{listLabel(list.name).icon}</span>
                : <span className="ink-list-dot" style={{ backgroundColor: list.color }} aria-hidden="true" />}
              {listLabel(list.name).text}
            </span>
          )}
          {/* 情境（GTD）。**复用卡片那一个 `.ink-context-mark`，不新开一个 `.ink-trow-` 类**：
              那条规则本来就是等宽 11px `--dim`，跟旁边这排记号一模一样，而「两个密度长得
              一样」正是这一下要的。（`.ink-list-name`/`.ink-tag-chip` 在这一行里也是这么复用的。）

              摆在清单名和标签之间：读下来是「归哪儿 → 什么条件下干得了 → 打了什么标签」。

              `!compact`：跟标签/子项数同一档（多字符串，不是单字形），看板那一列 217px
              先让它们。**这一条是照着 CONTRIBUTING 里那份清单扫出来的**：卡片上画了、
              行档上没有，同一条任务换个密度就少一条信息——`waitingFor`、`startAt` 都漏过
              这一轮，这是第三个。 */}
          {!compact && t.context && (
            <span className="ink-context-mark">@{CONTEXT_LABEL[t.context]}</span>
          )}
          {/* compact：标签/子项数不渲染——看板一列 217px，这两样是最先该
              让路的（到期/优先级更要紧，标题本身要靠这两样让路才读得全）。
              见 TaskRowProps.compact 的注释。 */}
          {!compact && t.tags.length > 0 && (
            <span className="ink-trow-tags">
              {t.tags.map((x) => <span className="ink-tag-chip" key={x}>{x}</span>)}
            </span>
          )}
          {/* `subCount` 的缺字段兜底见上面它的定义处（整分支审查 D1）。
              `role="img"` + `aria-label`、**不加 `title`**——跟同一排的 ●／🔔／⚑
              一字不差的写法（上面三处，全仓四个 `role="img"` 都只有 aria-label）。
              屏幕阅读器念出来的是「4 个子任务」，不是「点 4」：`·` 是给眼睛看的
              分隔号，读出来毫无意义。
              不加 `title` 是有理由的：外面那颗 `.ink-trow-open` 自己挂着
              `title={t.title}`，存在意义就是「标题被省略号截断时，悬停能读到全名」
              （TaskRow.test.tsx 有一条 `getByTitle(long)` 钉着）。在里面再挂一个
              title，等于在那颗按钮上挖出一块悬停读不到标题的死区，而换来的信息
              旁边那个「· 4」已经写在脸上了。 */}
          {!compact && subCount > 0 && (
            <span
              className="ink-trow-subcount"
              role="img"
              aria-label={`${subCount} 个子任务`}
            >· {subCount}</span>
          )}
        </span>
      </button>

      {/* 悬停/聚焦才出现，不出现时**整个不在 DOM 里**（不是 CSS 藏起来）——
          上限断言要的是「没占位」，opacity/visibility 那套仍然占着盒模型的
          位置。`onClick` 只在给了 `move` 时才挂——没给（其余五个视图）这颗
          按钮点了什么都不发生，跟今天的行为一致，`aria-expanded` 同理只在
          有菜单可展开时才有意义。 */}
      {/* 完整菜单（跟卡片共用 lib/taskMenu.ts）。三个条件：
          ① `onEdit`/`onDelete` 都接了——一颗点开只有半份动作的菜单不如没有；
          ② **`move` 没给**，也就是「今天」以外那五个视图。那五个视图里这颗
             ⋯ 原来渲染出来、点了什么都不发生，正是这次要补的；
          ③ 「今天」那边继续走下面那条老路：上下移的两颗按钮挂着 `upRef`/
             `downRef`，TodayView 的键盘拖拽靠它们在重排之后把焦点放回刚移动
             的那一行。把它们塞进 Dropdown 的菜单项里，菜单一收起按钮就卸载，
             那条焦点契约当场断掉——为了让一个视图多几项而弄坏另一个视图已经
             成立的可达性，不划算。「今天」的行档想用那几项，切回卡片档。 */}
      {hover && onEdit && onDelete && !move && (
        <Dropdown
          trigger={['click']}
          menu={rowMenu!}
        >
          <button type="button" className="ink-trow-more" aria-label={`「${t.title}」的更多操作`}>⋯</button>
        </Dropdown>
      )}

      {hover && !(onEdit && onDelete && !move) && (
        <button
          type="button"
          className="ink-trow-more"
          aria-label={`「${t.title}」的更多操作`}
          aria-expanded={move ? menuOpen : undefined}
          // aria-controls 指向下面那个 role="group" 面板的 id（修复轮 1 ·
          // M-3）——面板是兄弟节点，不是这颗按钮的子孙，没有这一行读屏软件
          // 只听得到「已展开」，找不到展开了什么。只在真的有菜单可展开时
          // 才给（`move` 没给时这颗按钮压根不会展开任何东西）。
          aria-controls={move ? menuId : undefined}
          onClick={move ? () => setMenuOpen((o) => !o) : undefined}
        >⋯</button>
      )}

      {/* 上/下移收进这个小面板——点一次「更多」展开，见 TaskRowProps.move
          的注释。不在点完之后自动收起：写完到确认刷新之间有一小段等待
          （TodayView 的 `status` 状态机），这段时间里全局的上/下移按钮都会
          禁用，留着菜单开着能看见这个禁用态；用户自己再点一次「更多」，
          或者鼠标真的移出整行（`onMouseLeave` 不看 `busy`——那是用户主动
          走开），才收起。**聚焦被浏览器踢回 `<body>` 这一种「离开」例外**：
          `onBlur` 在 `busy` 期间直接跳过，见上面 `onBlur` 里的注释（修复轮
          1 · C-1）。按钮复用 `.ink-move-btn`（TaskCard.tsx 那两颗上/下移
          按钮已经在用的同一条点击目标下限规则），24px 高度和视觉重置另补
          了一条 `.ink-trow-menu .ink-move-btn`（修复轮 1 · I-1，那条全局
          规则本身只兜过高度是 antd Button 给的，没管过原生 `<button>`）。 */}
      {hover && move && menuOpen && (
        <span id={menuId} role="group" aria-label={`调整「${t.title}」在今天列表里的顺序`} className="ink-trow-menu">
          <button
            type="button"
            className="ink-move-btn"
            ref={move.upRef}
            aria-label="上移"
            disabled={!move.canMoveUp || move.busy}
            onClick={move.onUp}
          >↑</button>
          <button
            type="button"
            className="ink-move-btn"
            ref={move.downRef}
            aria-label="下移"
            disabled={!move.canMoveDown || move.busy}
            onClick={move.onDown}
          >↓</button>
        </span>
      )}
    </div>
  );

  /**
   * 整行右键 = 那份 ⋯ 菜单，落在指针处（antd 的 `contextMenu` trigger 自己
   * 定位）。**跟 ⋯ 是同一个 `menu` 对象**，不是另抄一份——两个入口一份契约。
   *
   * **有菜单才包这一层。** 这一行是刻意不用 antd 画的（`TaskRow.test.tsx` 有
   * 一条「一个 ant-* 的 class 都不该出现」的守卫盯着），而 antd 的 Dropdown
   * 会往子节点上挂 `ant-dropdown-trigger`。只读的列表（没给 onEdit/onDelete）
   * 本来就没有菜单可弹，那种时候连这一层都不该有——右键落回浏览器自己的
   * 复制/粘贴，那正是只读列表上该有的行为。
   *
   * 写成变量再包，不是把整块 JSX 抄两遍。
   */
  return rowMenu ? <Dropdown menu={rowMenu} trigger={['contextMenu']}>{row}</Dropdown> : row;
}
