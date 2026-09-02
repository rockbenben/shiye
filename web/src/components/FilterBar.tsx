import { useState } from 'react';
import { Button, Checkbox, ConfigProvider, Input, Select } from 'antd';
import type { List, SmartFilter } from '../types.js';
import { CONTEXT_LABEL, CONTEXTS, STATUS_LABEL, STATUSES } from '../lib/taskView.js';
import { emptyFilter, isFilterEmpty } from '../lib/smartFilter.js';
import { fileableLists } from '../lib/listIcon.js';
import { describeFilter, type FilterLabels } from '../lib/describeFilter.js';
import { boardLocalTheme } from '../theme.js';
import { PRI_LABEL_ALL } from './TaskFields.js';

// 值和顺序从 `taskView.ts` 的 `STATUSES` 单一出处拿，不在这儿手抄一份——
// 原来这里是一份写死的四个，「已放弃」是后加的状态，抄的这份没跟上：
// 筛选栏里选不到已放弃的任务，批量操作条也没法把选中的几条一起标成放弃
// （单张卡上的状态按钮一直可以）。`grouping.ts` 的状态分组早就是这么引的
// （直接 import `STATUSES` + `STATUS_LABEL`），这两处是漏网的。
const STATUS_OPTIONS = STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }));

// 0（无）放最后——跟 BatchBar 的 PRIORITIES 同一个顺序（高→低，「无」是额外
// 加的第四档），不是这个文件自己发明的一套新顺序。
const PRIORITIES: Array<0 | 1 | 2 | 3> = [3, 2, 1, 0];
const PRIORITY_OPTIONS = PRIORITIES.map((p) => ({ value: p, label: PRI_LABEL_ALL[p] }));

/** 情境那一维的档位。顺序和名字都从 `lib/taskView.ts` 那一份来，不在这儿重排。 */
const CONTEXT_OPTIONS = CONTEXTS.map((c) => ({ value: c, label: CONTEXT_LABEL[c] }));

// 「N 天内」的预设档位。dueWithinDays 本身是任意数字（服务端只校验「是数字或
// null」，见 server/src/list.ts 的 checkSmartFilter），这里给几个最常用的
// 档位，不做自由输入——跟 cells.ts 的紧急边界（3 天）、agenda.ts 的「接下来」
// 不是同一份数字，各自的语义不同，这里只是筛选栏自己的档位表。
const DUE_PRESETS = [1, 3, 7, 14, 30];
/**
 * 「没有时间」也进这个下拉，跟几档「N 天内」并列——**日期这一维只能选一档**，
 * 所以它不像「不属于任何清单」那样要跟同维度的选择取「或」，选了这一档就是
 * 没选那几档，没有歧义。
 *
 * 值是一个中文串、不是 `-1` 之类的数字：`dueWithinDays` 服务端只校验「是数字
 * 或 null」，`-1` 是一个合法值（意思是「昨天之前」），拿它当哨兵迟早会跟一份
 * 手改出来的真 `-1` 撞上。跟 `NO_LIST`/`NO_TAG` 同一个写法，也同样**一个字节
 * 都不会落进 `SmartFilter`**——`onChange` 那一步就把它拆成 `noDue` 这个布尔量。
 */
const NO_DUE = '（没有时间）';
const DUE_OPTIONS: Array<{ value: number | string; label: string }> =
  [...DUE_PRESETS.map((n) => ({ value: n as number | string, label: `${n} 天内` })), { value: NO_DUE, label: '没有时间' }];

/** 人话预览用的两张文案表——**就是上面两个下拉用的那两张**，不另攒一份。
 *  各写一份的话，下拉里写「高」、预览里写「高优先级」这种事早晚会发生。 */
const FILTER_LABELS: FilterLabels = {
  status: Object.fromEntries(STATUS_OPTIONS.map((o) => [o.value, o.label])),
  priority: Object.fromEntries(PRIORITY_OPTIONS.map((o) => [o.value, o.label])),
  context: Object.fromEntries(CONTEXT_OPTIONS.map((o) => [o.value, o.label])),
};

export interface FilterBarProps {
  filter: SmartFilter;
  onChange: (f: SmartFilter) => void;
  /** 只列普通清单——调用方本该已经把智能清单过滤掉了，这里再挡一次
   * （`l.filter === null`）：一个查询里套另一个查询没有意义，这层防线
   * 不指望调用方记得，见组件内部 normalLists 那行。 */
  lists: List[];
  allTags: string[];
  /** 筛完剩几条。 */
  matched: number;
  /** 筛之前几条。 */
  total: number;
  /**
   * 不给就不渲染「存成智能清单」。
   *
   * 可选而不是必填**不是因为这件事还没做**（`App.tsx` 三处都接了，点了会开弹窗
   * 问名字）——是因为**有一处刻意不接**：「编辑这一份智能清单的筛选条件」那个
   * 弹窗复用的也是这个组件，而在那儿再放一颗「存成新的」是**两个动作挤在一处**，
   * 理由写在 `App.tsx` 那个弹窗上。
   */
  onSaveAsList?: () => void;
}

/**
 * 筛选栏。`SmartFilter` 里每一个筛选维度（status/listIds/tags/priority/
 * contexts/dueWithinDays/hasWaitingFor/text）在这里都有对应的控件——规格第六
 * 节那行只点名了前四个，但其余几个已经在数据模型和服务端校验里了，见
 * task-2-brief。
 *
 * （原来这段写着「七维筛选栏」，情境是后加的第八维。把维数写死在注释里就是
 * 等着下一次加维度时飘掉，所以改成不数数。）
 *
 * **控件本身不管「筛完剩几条」**：`matched`/`total` 由调用方算好传进来
 * （`applyFilter` 是 Task 1 的纯函数，不在这个组件里调），这里只负责显示。
 *
 * **默认收起**（task-4-brief「顶部 chrome 收一收」）：六个下拉 + 搜索框 +
 * 一个按钮平时是空的，常驻占约 100px 没有意义，收成一颗「筛选」按钮，点了
 * 才展开成下面这一整条。**筛选非空时必须展开、且没有收起的入口**——这条
 * 防线是 `2026-08-17-smart-filter.md` 设计②定下来的，「收起」只解决「空
 * 筛选」这一种情况，不能被这次改动破坏：`expanded` 用 `open || !empty`
 * 算，非空时不管 `open`（用户手动收没收）是什么值都强制为真；收起按钮本身
 * 也只在 `empty` 时才渲染——没有入口，非空时就没有办法把它点没。
 *
 * **一层 `ConfigProvider theme={boardLocalTheme}` 包住整条**：antd 的
 * `Select`（多选选中项的高亮底色）、`Checkbox` 选中态都直接读全局
 * `token.colorPrimary`，也就是群青——这几颗是界面元件，不是 AI 产出，照
 * `TaskBoard`/`TodayView`/`TaskCard` 的既有解法（见 `theme.ts` 顶部
 * `boardLocalTheme` 的注释），局部压回 `ink.you`。整条筛选栏只有这一层
 * `ConfigProvider`，不是每个控件各包一层——跟 `TaskBoard`/`TodayView` 整棵
 * 子树套一层是同一个写法，控件在同一个容器里没有理由分开压。
 */
/** `or` 缺失（加这个字段之前存下来的智能清单）当成没有「或」组。 */
const asOr = (f: SmartFilter): SmartFilter[] => (Array.isArray(f.or) ? f.or : []);
/** `not` 缺失（加这个字段之前存下来的智能清单）当成没有「排除」组。 */
const asNot = (f: SmartFilter): SmartFilter[] => (Array.isArray(f.not) ? f.not : []);

/** 「预计不超过」的几档。跟 `DUE_OPTIONS` 同一个形状：人心里的答案本来就是
 *  「一刻钟 / 半小时 / 一小时」这种整块，不是一个任意数字。 */
const ESTIMATE_OPTIONS = [15, 30, 60, 120].map((m) => ({
  value: m,
  label: m < 60 ? `≤ ${m} 分钟` : `≤ ${m / 60} 小时`,
}));

interface RowProps {
  group: SmartFilter;
  onChange: (next: SmartFilter) => void;
  listOptions: Array<{ value: string; label: string }>;
  tagOptions: Array<{ value: string; label: string }>;
}

/**
 * 一组条件的七个控件。**第一组和每个「或」组共用这一份**——两边各写一遍的话，
 * 加第八个筛选维度时漏改其中一处不会报错，只会让「或」组悄悄少一维。
 *
 * 不含「清空」「存成智能清单」「收起」那几颗：它们是整份筛选的动作，不是
 * 某一组的。
 */
/**
 * 「不属于任何清单」「没有标签」这两项在下拉框里的值。
 *
 * **只活在这个下拉框的 value 数组里**，一个字节都不会落进 `SmartFilter`——
 * `onChange` 那一步就把它拆成 `noList`/`noTag` 两个布尔量。所以不用担心
 * 「万一有一份清单的 id 正好长这样」：存下来的 `listIds` 里永远不会出现它，
 * 而清单 id 是 `crypto.randomUUID()`，也不可能长成一句中文。
 *
 * 摆在真清单/真标签**后面**，跟看板按清单分列时那两列的位置一致（见
 * lib/grouping.ts：`buckets.push` 在遍历完真清单之后）——同一个概念，
 * 同一个位置。
 */
const NO_LIST = '（不属于任何清单）';
const NO_TAG = '（没有标签）';

function FilterRow({ group, onChange, listOptions, tagOptions }: RowProps) {
  return (
    <>
      <Select
        mode="multiple"
        aria-label="状态"
        placeholder="状态"
        className="ink-filter-select"
        options={STATUS_OPTIONS}
        value={group.status}
        onChange={(next) => onChange({ ...group, status: next })}
      />
      <Select
        mode="multiple"
        aria-label="清单"
        placeholder="清单"
        className="ink-filter-select"
        options={[...listOptions, { value: NO_LIST, label: '不属于任何清单' }]}
        value={group.noList ? [...group.listIds, NO_LIST] : group.listIds}
        onChange={(next) => onChange({
          ...group,
          noList: next.includes(NO_LIST),
          listIds: next.filter((v) => v !== NO_LIST),
        })}
      />
      <Select
        mode="multiple"
        aria-label="标签"
        placeholder="标签"
        className="ink-filter-select"
        options={[...tagOptions, { value: NO_TAG, label: '没有标签' }]}
        value={group.noTag ? [...group.tags, NO_TAG] : group.tags}
        onChange={(next) => onChange({
          ...group,
          noTag: next.includes(NO_TAG),
          tags: next.filter((v) => v !== NO_TAG),
        })}
      />
      {/* 标签这一维内部的且/或（滴答清单：「同一个筛选条件内，仅标签支持」）。
          **只在选了不止一个标签时才出现**：一个标签时「任一」和「全部」是同
          一件事，摆一个改了没效果的开关只会让人怀疑自己理解错了。 */}
      {group.tags.length > 1 && (
        <Checkbox
          className="ink-filter-waiting"
          checked={group.tagsAll === true}
          onChange={(e) => onChange({ ...group, tagsAll: e.target.checked })}
        >
          标签要全中
        </Checkbox>
      )}
      <Select
        mode="multiple"
        aria-label="优先级"
        placeholder="优先级"
        className="ink-filter-select"
        options={PRIORITY_OPTIONS}
        value={group.priority}
        onChange={(next) => onChange({ ...group, priority: next })}
      />
      {/* 情境（GTD）。摆在优先级后面、到期天数前面——跟编辑表单里那个下拉同一个
          位置关系：优先级答「哪条最重要」，情境答「我现在能干哪条」，两个问题
          挨着问，才看得出它们不是一回事。 */}
      <Select
        mode="multiple"
        aria-label="情境"
        placeholder="情境"
        className="ink-filter-select"
        options={CONTEXT_OPTIONS}
        value={group.contexts}
        onChange={(next) => onChange({ ...group, contexts: next })}
      />
      <Select
        allowClear
        aria-label="到期天数"
        placeholder="到期天数"
        className="ink-filter-select"
        options={DUE_OPTIONS}
        value={group.noDue ? NO_DUE : group.dueWithinDays ?? undefined}
        onChange={(next) => onChange({
          ...group,
          noDue: next === NO_DUE,
          dueWithinDays: typeof next === 'number' ? next : null,
        })}
      />
      <Checkbox
        className="ink-filter-waiting"
        checked={group.hasWaitingFor}
        onChange={(e) => onChange({ ...group, hasWaitingFor: e.target.checked })}
      >
        只看等待中的
      </Checkbox>
      {/* 「只看重复的」——重复任务在别的维度上跟一次性任务长得一模一样，
          攒到几十条之后没有任何地方数得清「我到底给自己排了多少条常规」。 */}
      <Checkbox
        className="ink-filter-waiting"
        checked={group.isRepeating}
        onChange={(e) => onChange({ ...group, isRepeating: e.target.checked })}
      >
        只看重复的
      </Checkbox>
      {/* 「还没开始的」。判据走 `notStarted`，跟卡片上那个「9 月 1 日 开始」的
          记号是同一个函数——这一维要是自己写一遍，筛出来的卡片上会没有那个记号。 */}
      <Checkbox
        className="ink-filter-waiting"
        checked={group.notStarted}
        onChange={(e) => onChange({ ...group, notStarted: e.target.checked })}
      >
        还没开始的
      </Checkbox>
      {/* 「我现在只有二十分钟，能做点什么」——`estimateMinutes` 这个字段最本命
          的问题，在这一维之前只能排序、不能筛。给几档预设而不是数字输入框：
          人心里的答案本来就是「一刻钟 / 半小时 / 一小时」这种整块，跟上面那个
          「到期天数」同一个形状、同一个理由。 */}
      <Select
        allowClear
        aria-label="预计时长"
        placeholder="预计时长"
        className="ink-filter-select"
        options={ESTIMATE_OPTIONS}
        value={group.estimateWithinMinutes ?? undefined}
        onChange={(next) => onChange({ ...group, estimateWithinMinutes: typeof next === 'number' ? next : null })}
      />
      <Input
        aria-label="筛选文本"
        placeholder="标题/备注/标签/子任务里搜"
        className="ink-filter-text"
        value={group.text}
        onChange={(e) => onChange({ ...group, text: e.target.value })}
      />
    </>
  );
}

export function FilterBar({ filter, onChange, lists, allTags, matched, total, onSaveAsList }: FilterBarProps) {
  // 文案表从既有出处传进去，`describeFilter` 不自己攒一份——这两张表正是
  // 上面 STATUS_OPTIONS / PRIORITY_OPTIONS 用的那两张。
  const summary = describeFilter(filter, lists, FILTER_LABELS);
  const empty = isFilterEmpty(filter);
  // 手动展开的记忆，只在筛选为空时起作用（见上面文档注释）。每次挂载都从
  // false 开始——切视图会重新挂载这个组件（App.tsx 每个视图各自的 render
  // 闭包，不是同一个元素实例），跟「筛选本身跨视图保留」不是一回事：筛选
  // 保留在 App.tsx 的 state 里，跟这里的 UI 展开状态无关。
  const [open, setOpen] = useState(false);
  const expanded = open || !empty;
  // 智能清单（filter !== null）不能作为筛选条件——查询里套查询，第一步就
  // 该挡住，不指望 `lists` prop 传进来的时候已经是干净的。归档清单也排除，
  // 跟 BatchBar.tsx「改清单」、TaskFields.tsx「归到哪个清单」、Sidebar.tsx
  // 导航同一条规矩（`!l.archived`）——东西还在，只是不想它占着导航/选择器，
  // 见 final-review.md m2。
  const normalLists = fileableLists(lists);
  const listOptions = normalLists.map((l) => ({ value: l.id, label: l.name }));
  const tagOptions = allTags.map((t) => ({ value: t, label: t }));

  return (
    <ConfigProvider theme={boardLocalTheme}>
      {/* 修复轮 1 · A：收起来的是一颗按钮，不是一个面板——边框/底色/内边距
          （`.ink-filter-bar-open`）只在展开时才套上，收起时容器只剩纯布局
          的 `.ink-filter-bar`（flex 对齐 + 间距），没有边框也没有 --sheet
          底色，不会看着仍然像「顶上有一条栏」。展开态是上限：这个 class
          不能被顺手删掉，见 theme.css.test.ts 和 FilterBar.test.tsx 两处
          断言。 */}
      <div className={`ink-filter-bar${expanded ? ' ink-filter-bar-open' : ''}`} role="group" aria-label="筛选">
        {!expanded ? (
          <Button size="small" onClick={() => setOpen(true)}>筛选</Button>
        ) : (
          <>
            <FilterRow
              group={filter}
              onChange={(g) => onChange({ ...g, or: filter.or, not: filter.not })}
              listOptions={listOptions}
              tagOptions={tagOptions}
            />

            {/* 「或」组（滴答清单的「高级筛选」多语句查询）。每一组是同一排
                七个控件，组与组之间取并集。**只嵌一层**——服务端校验也拦着，
                见 model.ts 里 SmartFilter 的注释。 */}
            {asOr(filter).map((g, i) => (
              <div className="ink-filter-or" key={i}>
                <span className="ink-filter-or-label">或者</span>
                <FilterRow
                  group={g}
                  onChange={(next) => onChange({ ...filter, or: asOr(filter).map((x, k) => (k === i ? next : x)) })}
                  listOptions={listOptions}
                  tagOptions={tagOptions}
                />
                <Button
                  size="small"
                  type="text"
                  aria-label={`删掉第 ${i + 1} 个「或」组`}
                  onClick={() => onChange({ ...filter, or: asOr(filter).filter((_, k) => k !== i) })}
                >×</Button>
              </div>
            ))}

            {/* 「排除」组（OmniFocus 的 None of the Following）。跟「或」组
                共用同一排控件、同一个形状，只是方向相反：那个往结果里加，
                这个从结果里减。**减在最外面一次**，判据在 smartFilter.ts 的
                `applyNot`。 */}
            {asNot(filter).map((g, i) => (
              <div className="ink-filter-or ink-filter-not" key={i}>
                <span className="ink-filter-or-label">但不要</span>
                <FilterRow
                  group={g}
                  onChange={(next) => onChange({ ...filter, not: asNot(filter).map((x, k) => (k === i ? next : x)) })}
                  listOptions={listOptions}
                  tagOptions={tagOptions}
                />
                <Button
                  size="small"
                  type="text"
                  aria-label={`删掉第 ${i + 1} 个「排除」组`}
                  onClick={() => onChange({ ...filter, not: asNot(filter).filter((_, k) => k !== i) })}
                >×</Button>
              </div>
            ))}

            {/* 加一组。**筛选全空时不给这颗**：一份「什么都不筛 或者 什么都
                不筛」的查询没有意义，而且它会让 isFilterEmpty 判成非空、
                筛选栏再也收不起来。 */}
            {!empty && (
              <Button
                size="small"
                type="text"
                onClick={() => onChange({ ...filter, or: [...asOr(filter), emptyFilter()] })}
              >+ 或者…</Button>
            )}

            {/* 「但不要」**空筛选时也给**，跟「或者」那颗相反——「全部，但不要
                #工作」是一句完整、有用的话，而「什么都不筛 或者 什么都不筛」
                不是。`isFilterEmpty` 把排除组算作「筛了」，所以点完这颗筛选栏
                不会收起来。 */}
            <Button
              size="small"
              type="text"
              onClick={() => onChange({ ...filter, not: [...asNot(filter), emptyFilter()] })}
            >+ 但不要…</Button>

            {!empty && (
              <>
                {/* 人话预览。七个下拉加两个开关拼起来到底筛的是什么，只能靠
                    一个个看回去——跟重复规则那一排下面那句预览是同一件事，同一个
                    写法。摆在「N / M 条」前面：先说「筛的是什么」，再说「筛出几条」。 */}
                {summary && <span className="ink-filter-summary" title={summary}>{summary}</span>}
                <span className="ink-filter-count">{matched} / {total} 条</span>
                <Button size="small" onClick={() => onChange(emptyFilter())}>清空</Button>
              </>
            )}
            {/* 存一个什么都不筛的智能清单没有意义——筛选为空时禁用，不是隐藏：
                隐藏的话用户不知道这个功能存在，禁用能看见「要先筛点什么」这个
                前置条件。 */}
            {onSaveAsList && (
              <Button size="small" disabled={empty} onClick={onSaveAsList}>存成智能清单</Button>
            )}
            {/* 收起：只在筛选为空时才可能出现——非空时不给这个按钮，是「非空
                不能收起」这条防线的一半（另一半是上面 `expanded` 的计算），
                没有入口就没有办法把它点没。 */}
            {empty && (
              <Button size="small" onClick={() => setOpen(false)}>收起</Button>
            )}
          </>
        )}
      </div>
    </ConfigProvider>
  );
}
