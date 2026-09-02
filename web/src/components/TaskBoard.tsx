import { useMemo, useRef, useState } from 'react';
import { Button, ConfigProvider, Masonry } from 'antd';
import type { InboxItem, List, Task } from '../types.js';
import {
  asArray,
  bubbleOverdue,
  countByStatus,
  filterTasks,
  formatWhen,
  groupBySource,
  sortByUrgency,
  STATUS_FILTERS,
  STATUS_FILTER_LABEL,
  type StatusFilter,
  type TaskGroup,
} from '../lib/taskView.js';
import { boardLocalTheme } from '../theme.js';
import { useColumns } from '../lib/useColumns.js';
import { FIRST_RUN_HINT, isFirstRun } from '../lib/firstRun.js';
import { TaskCard } from './TaskCard.js';
import type { ProposalWiring } from './ProposalNote.js';
import { clickToSelection, type SelState } from '../lib/selection.js';

/** 卡片之间的间距。「今天」那边是 .ink-card-grid 的 gap，值要一致；
 *  Masonry 只吃数字，没法读 CSS 变量。 */
const CARD_GAP = 14;

/**
 * 筛选条那几档。**从 `taskView.ts` 的单一出处拿，不手抄**——原来这儿是一份
 * 写死的五档表，**漏了「已放弃」**：那个状态是后加的，这张表没跟上，于是
 * 「按来源」里选不到放弃的任务（而 `countByStatus` 一直在数它，那个数字从来
 * 没有地方显示）。筛选栏和批量操作条当初漏掉「已放弃」是同一个 bug，那两处
 * 修的时候没顺手修这一处。
 *
 * 顺带修掉一个隐患：下面 `FILTERS.find(...)!` 那个非空断言在 `filter` 是
 * 「已放弃」时会炸——一张不全的表配一个断言不为空的查找。
 */
const FILTERS: Array<{ key: StatusFilter; label: string }> =
  STATUS_FILTERS.map((key) => ({ key, label: STATUS_FILTER_LABEL[key] }));

interface GroupSectionProps {
  group: TaskGroup;
  now: Date;
  onPatch: Props['onPatch'];
  onEditTask: Props['onEditTask'];
  onDelete: Props['onDelete'];
  onEditingChange: (id: string, editing: boolean) => void;
  proposals?: ProposalWiring;
  lists: List[];
  /** 转交给每张 TaskCard——番茄钟一轮的时长，见 TaskCard.tsx CardProps 的
   *  注释。可选、不给就是 TaskCard 自己的默认值。 */
  focusMinutes?: number;
  /** 一轮走完之后歇多久，分钟——原样转交给每张 TaskCard，见那边的注释。 */
  breakMinutes?: number;
  /** 全表 + 创建副本，只是转交给每张 TaskCard。 */
  allTasks?: Task[];
  onDuplicate?: (t: Task) => void;
  /**
   * 跳过这一次 + 检查事项转子任务，只是转交给每张 TaskCard。**不给 `onSkip`
   * 的话那张卡的「跳过」会退回发一条普通 patch，服务端把它记成一次拖延**——
   * 这两个视图不走 `gridWiring`（手写 props），就是在这儿漏过一次，
   * 见 `cardWiring.guard.test.ts`。
   */
  onSkip?: (id: string) => void;
  onPromoteSubtask?: (t: Task, index: number) => void;
  /** 转交给每张 TaskCard 再转交给 Attachments——离线记号（task-3-brief），
   *  见 TaskCard.tsx CardProps.offline 的注释。可选、不给就是 TaskCard 自己
   *  的默认值 false。 */
  offline?: boolean;
  /** 选中态。两个都给了才接线，跟 TaskGrid 一个规矩，见那边 Props.selection。 */
  selection?: SelState;
  onSelectionChange?: (next: SelState) => void;
}

/** 一组：一句原话 + 它拆出的任务。签名元素是群青方括号（把同源的任务框在
 * 一起）和边注（每条任务自己的 aiComment，不是整组共用一条）。
 *
 * 「单独记的」（source 是 null）不画方括号——那条线视觉上说的是「这几条同源」，
 * 这组任务恰恰不同源（手工建的、或者来源笔记已经被删了），画出来是撒谎。
 * 边注（如果这条任务恰好还留着 aiComment）照常显示：那是任务自己的记录，
 * 跟它现在归不归得进某个分组是两件事。 */
function GroupSection({ group, now, onPatch, onEditTask, onDelete, onEditingChange, proposals, lists, allTasks, onDuplicate, onSkip, onPromoteSubtask, focusMinutes, breakMinutes, offline, selection, onSelectionChange }: GroupSectionProps) {
  const { source, tasks } = group;
  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useColumns(gridRef, CARD_GAP);
  // useMemo 不是过度优化：Masonry 内部有个 `useEffect(..., [items])` 把这个
  // 数组抄进自己的 state，每渲染一次新建一个数组就等于每次都多触发一轮
  // setState + 重新量所有卡片的高度。任务一改（SSE 回来刷新）就整块重排两遍。
  const items = useMemo(() => tasks.map((t) => ({ key: t.id, data: t })), [tasks]);
  // <section> 靠这个 heading 的 id 命名——不然每一组渲染出来的都是一个
  // 没有名字的 region，标题导航（屏幕阅读器按 H 跳）也无从可跳，见 #9 号复盘。
  const headingId = `ink-group-heading-${source?.id ?? '__unsourced__'}`;

  /**
   * **这一屏的多选：Shift 退化成单点加减，「一次选一排」交给组头那颗按钮。**
   *
   * 别的视图里 Shift 连选选的是「屏幕上从锚点到这里的那一段」，而这一屏是
   * 瀑布流——上面那段注释已经说了，这一组里的任务**没有顺序**，「第 4 条排在
   * 第 3 条正下方还是隔壁列」不损失任何信息。顺序本身不携带信息的地方，
   * 「之间」这个概念就不存在，连选也无从谈起（`clickToSelection` 的 `ordered`
   * 在这儿没有一份诚实的值可传）。
   *
   * 所以这儿固定传 `shift: false`：按住 Shift 点等于 Ctrl 点，加减一张。
   * **这是全站唯一一处 Shift 语义不同的视图**，代价认了——换来的是「一次选
   * 一排」有了一个比连选更贴这一屏结构的入口：按组选。这一屏的「组」就是
   * 同一句原话拆出来的那几条，那才是这里真正成排的单位。
   */
  const ids = tasks.map((t) => t.id);
  const wired = selection !== undefined && onSelectionChange !== undefined;
  // 全组都选中了，那颗按钮就反过来变成「取消这一组」——一颗按钮两个方向，
  // 不在组头上摆两颗。
  const allPicked = wired && ids.length > 0 && ids.every((id) => selection.ids.has(id));
  const pickGroup = () => {
    if (!wired) return;
    const next = new Set(selection.ids);
    for (const id of ids) {
      if (allPicked) next.delete(id);
      else next.add(id);
    }
    // 锚点落在这一组的第一条：按组选完之后再 Ctrl 点别的，语义接得上。
    // 取消时锚点清掉——锚点指着一个已经不在选中集合里的 id 是个说不通的状态。
    onSelectionChange({ ids: next, anchor: allPicked ? null : (ids[0] ?? null) });
  };
  const pickBtn = !wired || ids.length === 0 ? null : (
    <button type="button" className="ink-group-select" onClick={pickGroup}>
      {allPicked ? '取消这一组' : `选中这 ${ids.length} 条`}
    </button>
  );

  return (
    <section className="ink-group" aria-labelledby={headingId}>
      {source ? (
        <>
          <h2 id={headingId} className="ink-quote ink-source">{source.text}</h2>
          {/* asArray：跟 lib/taskView.ts 的 groupBySource 同一条防线，taskIds
              手改错了类型也不该让这里崩。「拆成 N 条」是 AI 当时拆解出的历史
              事实，读 taskIds 本身的长度，不是读筛选/删除之后还剩几张卡——
              那两件事会让这个数字随手一点筛选按钮就变，或者任务被删之后
              永久少报，见 #8 号复盘。 */}
          <p className="ink-source-meta ink-mono">
            {formatWhen(source.createdAt)} 写下 · 拆成 {asArray<string>(source.taskIds).length} 条
            {/* 按钮上那个数跟前面「拆成 N 条」**故意不是同一个数**：那个读的是
                taskIds 的长度（AI 当时拆出几条，删了、筛掉了都不改），这个是
                这一刻屏幕上真会被选中的张数。两个数并排摆着不一样是对的——
                点下去选中几张，对得上的是后面那个。 */}
            {pickBtn}
          </p>
        </>
      ) : (
        <>
          <h2 id={headingId} className="ink-source-none">单独记的</h2>
          {/* 这一组没有「写下 / 拆成 N 条」那行元信息，但按钮得有地方站——借
              同一个 .ink-source-meta 占位，间距跟别的组对齐，不新写一份样式。 */}
          {pickBtn && <p className="ink-source-meta ink-mono">{pickBtn}</p>}
        </>
      )}

      {/* 瀑布流，不是等分网格。这一组里的任务**没有顺序**（同源的按 taskIds
          原序、单独记的按紧急程度，两种都不是人手排出来的，也没法拖），所以
          「第 4 条排在第 3 条正下方还是隔壁列」不损失任何信息——那正是瀑布流
          用得起的前提。换来的是没有空洞：等分网格里一行的高度由最高那张卡决定，
          矮卡下面那块空白谁也用不上，卡片高度差得越多洞越大（这一组常有一张带
          三条子任务加边注的高卡，配几张只有标题的矮卡）。
          「今天」不能这么排，那边顺序就是内容本身，见 TodayView。 */}
      <div ref={gridRef} className={source ? 'ink-bracket' : 'ink-bracket-none'}>
        <Masonry
          columns={columns}
          gutter={CARD_GAP}
          items={items}
          itemRender={({ data: t }) => (
            // 边注渲染在卡片内部（见 TaskCard 的 showNote）——卡片旁边没有
            // 页边可放了。
            <TaskCard
              t={t} now={now} lists={lists} allTasks={allTasks} onDuplicate={onDuplicate} onSkip={onSkip} onPromoteSubtask={onPromoteSubtask}
              onPatch={onPatch} onEditTask={onEditTask} onDelete={onDelete}
              onEditingChange={onEditingChange} proposals={proposals}
              focusMinutes={focusMinutes} breakMinutes={breakMinutes} offline={offline} showNote
              select={wired ? {
                selected: selection.ids.has(t.id),
                // 「选中了至少一张之后，勾选框才出现」——判据跟 TaskGrid 一样，
                // 看的是**整个**选中集合，不是这一组里选了几张：跨组选中之后
                // 别的组也该露出勾选框，不然那几组看着像不能选。
                showCheckbox: selection.ids.size > 0,
                onClick: () => onSelectionChange(
                  clickToSelection(selection, ids, t.id, { shift: false, ctrlOrMeta: true }),
                ),
              } : undefined}
            />
          )}
        />
      </div>
    </section>
  );
}

interface Props {
  tasks: Task[];
  inbox: InboxItem[];
  now: Date;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onEditTask: (id: string, patch: Partial<Task>) => Promise<unknown>;
  onDelete: (id: string) => void;
  proposals?: ProposalWiring;
  /** 状态筛选提到 App 里：新建任务的时候要知道当前筛选会不会把新卡藏起来
   * （新任务一律是 todo，筛选停在「已完成」上就什么也看不见），
   * 而那个判断在 TaskComposer 里做，够不到这里原来那个局部 state。 */
  filter: StatusFilter;
  onFilterChange: (f: StatusFilter) => void;
  /** 转交给每张 TaskCard，经 GroupSection 中转一手。 */
  lists: List[];
  /** 转交给每张 TaskCard，经 GroupSection 中转一手——番茄钟一轮的时长，
   *  见 TaskCard.tsx CardProps 的注释。可选、不给就是 TaskCard 自己的默认值。 */
  focusMinutes?: number;
  /** 一轮走完之后歇多久，分钟——原样转交给每张 TaskCard，见那边的注释。 */
  breakMinutes?: number;
  /** 转交给每张 TaskCard，经 GroupSection 中转一手——离线记号（task-3-brief），
   *  见 TaskCard.tsx CardProps.offline 的注释。可选、不给就是 TaskCard 自己
   *  的默认值 false。 */
  offline?: boolean;
  /** 「创建副本」，同样经 GroupSection 中转一手。全表不用单独收：这个组件
   *  本来就拿着 `tasks`（它自己按来源分组），直接往下传那一份。 */
  onDuplicate?: (t: Task) => void;
  /**
   * 跳过这一次 + 检查事项转子任务，只是转交给每张 TaskCard。**不给 `onSkip`
   * 的话那张卡的「跳过」会退回发一条普通 patch，服务端把它记成一次拖延**——
   * 这两个视图不走 `gridWiring`（手写 props），就是在这儿漏过一次，
   * 见 `cardWiring.guard.test.ts`。
   */
  onSkip?: (id: string) => void;
  onPromoteSubtask?: (t: Task, index: number) => void;
  /** 选中态，经 GroupSection 转交给每张卡。两个都给了才接线，见
   *  TaskGrid.tsx Props.selection——那条规矩这一屏照用。 */
  selection?: SelState;
  onSelectionChange?: (next: SelState) => void;
}

export function TaskBoard({ tasks, inbox, now, onPatch, onEditTask, onDelete, onDuplicate, onSkip, onPromoteSubtask, proposals, filter, onFilterChange, lists, focusMinutes, breakMinutes, offline, selection, onSelectionChange }: Props) {
  // 正在编辑的任务 id——筛选切换不能把这些卡从树上摘掉，见 TaskCard.tsx 里
  // CardProps 上 onEditingChange 的注释，跟 InboxSidebar 是同一个套路。
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const setEditing = (id: string, editing: boolean) =>
    setEditingIds((prev) => {
      const next = new Set(prev);
      if (editing) next.add(id);
      else next.delete(id);
      return next;
    });
  const counts = countByStatus(tasks);

  // 「单独记的」那组内部按紧急程度排（过期置顶、按截止时间升序，不保留原顺序）
  // ——它没有叙事顺序可循。同源的组用 bubbleOverdue：过期任务浮到组内最前面，
  // 其余仍按 taskIds 数组本身的顺序（AI 拆解时写下的先后步骤，重新按时间排
  // 会把「先做这条、它卡住了才轮到下一条」的用意弄丢，只有「过期」这一件事
  // 值得打破这个顺序）。组与组之间仍按 inbox.createdAt 升序——那对应手稿翻页
  // 的顺序，是这次重做的核心结构，不因为某一组里有过期任务就整组挪位置；
  // 跨组的「哪组该先看到」是另一个更大的产品决定，这次不动，见复盘报告。
  const groups = groupBySource(tasks, inbox)
    .map((g) => {
      const passes = new Set(filterTasks(g.tasks, filter));
      // 筛选正常会滤掉的卡，只要还在编辑就留着——见上面 editingIds 的注释。
      const visible = g.tasks.filter((t) => passes.has(t) || editingIds.has(t.id));
      return { ...g, tasks: g.source ? bubbleOverdue(visible, now) : sortByUrgency(visible, now) };
    })
    .filter((g) => g.tasks.length > 0);

  // 「空的」只留给真的一条任务都没有的时候。tasks.length > 0 但 groups 被
  // 筛没了，说明是筛选把它们全挡住了——这是两件不一样的事：前者没什么好做的，
  // 后者用户随时可能以为「拆解没生效」「任务丢了」，必须给个不一样的说法，
  // 还要留一条退路（清掉筛选），不能只靠用户自己想起来点「全部」。见 #11 号复盘。
  const currentFilter = FILTERS.find((f) => f.key === filter)!;
  const filterHidesEverything = tasks.length > 0 && groups.length === 0;

  return (
    // Checkbox（子任务勾选）和 DatePicker（编辑态里的截止/提醒选择器）都直接读
    // 合并后的 token.colorPrimary 来画选中态，且都没有留一个组件级 token 能单独
    // 覆盖这个颜色（Switch 是同样的情况，见 theme.ts 顶部注释和 SettingsModal）。
    // 局部 ConfigProvider 把这一整块子树的 colorPrimary 压回你的墨：勾选框、
    // 日期选择器的选中态不该占群青的配额——那不是 AI 产出的东西，是你自己勾的、
    // 自己选的。截止/提醒键名的群青（.ink-time-ai）是原生 CSS 类画的，不经过
    // antd token，不受这层覆盖影响，两者不冲突。boardLocalTheme 跟 SettingsModal.tsx
    // 共用同一份具名导出——只压 colorPrimary 会把 DatePicker 编辑态选中的
    // 时/分/秒格背景连带压成中灰（见 theme.ts 顶部注释），这份导出额外把
    // controlItemBgActive 覆盖回可读的浅灰，两个用到它的地方都得走这份，
    // 不能各自 inline 一份改一处漏一处。
    <ConfigProvider theme={boardLocalTheme}>
      <div>
        <div className="ink-filters" role="group" aria-label="按状态筛选">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className="ink-chip"
              aria-pressed={filter === f.key}
              onClick={() => onFilterChange(f.key)}
            >
              {f.label} {counts[f.key]}
            </button>
          ))}
        </div>

        {/* 一行安静的字，不是 antd 自带的 Empty 插画——见 theme.css 里
            .ink-empty-note 的注释，跟收件箱那边的空状态同一个处理。 */}
        {groups.length === 0 && (
          filterHidesEverything ? (
            <div>
              <p className="ink-empty-note">「{currentFilter.label}」筛选下没有任务</p>
              <Button size="small" onClick={() => onFilterChange('all')}>清除筛选</Button>
            </div>
          ) : (
            // 「空的」两个字在有任务的时候都算不上一句话，在一台刚装好的机器上
            // 更是把人拦在门外——这个视图正是手工建的任务落脚的地方（「单独记的」
            // 那一组）。判据和文案在 lib/firstRun.ts，跟「今天」共用一句。
            <p className="ink-empty-note">{isFirstRun(tasks) ? FIRST_RUN_HINT : '这个筛选下没有任务'}</p>
          )
        )}

        {groups.map((g) => (
          <GroupSection
            key={g.source?.id ?? '__unsourced__'}
            group={g}
            now={now}
            lists={lists}
            onPatch={onPatch}
            onEditTask={onEditTask}
            onDelete={onDelete}
            onEditingChange={setEditing}
            proposals={proposals}
            // 全表（不是这一组）：多级任务的父亲很可能在别的分组里。
            allTasks={tasks}
            onDuplicate={onDuplicate}
            onSkip={onSkip}
            onPromoteSubtask={onPromoteSubtask}
            focusMinutes={focusMinutes}
            breakMinutes={breakMinutes}
            offline={offline}
            selection={selection}
            onSelectionChange={onSelectionChange}
          />
        ))}
      </div>
    </ConfigProvider>
  );
}
