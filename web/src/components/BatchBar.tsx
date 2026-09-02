import { useState } from 'react';
import { Button, Dropdown } from 'antd';
import type { List, Status, TaskContext } from '../types.js';
import { CONTEXT_LABEL, CONTEXTS, STATUS_LABEL, STATUSES } from '../lib/taskView.js';
import { PRI_MENU } from './TaskFields.js';
import { POSTPONE_MINUTES, RESCHEDULE_LABEL, type RescheduleTo } from '../lib/reschedule.js';
import { fileableLists } from '../lib/listIcon.js';

/**
 * 选中至少一张卡片之后出现的批量操作条——规格第六节「批量操作」那一行：
 * 一起改状态 / 改清单 / 加标签 / 改优先级 / 改情境 / 改期 / 删除，外加「取消选择」。
 *
 * **纯展示组件。** 每个动作只把「用户想做什么」报给调用方，不知道也不关心
 * 背后走的是批量 PATCH 端点还是别的——删除要不要弹确认框、加标签怎么合并到
 * 每条任务已有的标签数组（选中的任务标签各不相同，没法用同一个 patch 覆盖
 * 所有人），这些都是接线那个 Task 的事，这里不做假设，见 2026-08-17-selection.md
 * Task 4。
 *
 * `count === 0` 直接不渲染——不指望调用方记得「选中为空就别渲染我」，组件
 * 自己兜底这条上限，见 task-3-brief「一张都没选时批量操作条不出现」。
 */
export interface BatchBarProps {
  count: number;
  /** 归到哪个清单的候选表——跟 TaskFields 的 `lists` 同一份数据，格式一样。 */
  lists: List[];
  onChangeStatus: (status: Status) => void;
  /** 批量改期（仿滴答清单的批量「编辑新日期」）。跟卡片 ⋯ 里那组同一套语义：
   *  原来几点还是几点、提醒跟着挪，判据在 lib/reschedule.ts。 */
  onReschedule: (to: RescheduleTo) => void;
  /** 「推迟」（仿滴答清单：一键把选中的时间统统往后挪一小时，应付临时会议、
   *  堵车、插进来的新安排）。分钟数由调用方给，这里只报动作。 */
  onPostpone: (minutes: number) => void;
  /** null 是「不属于任何清单」，跟 Task.listId 的语义一致。 */
  onChangeList: (listId: string | null) => void;
  onAddTag: (tag: string) => void;
  onChangePriority: (priority: 0 | 1 | 2 | 3) => void;
  /**
   * 批量分情境（GTD）。`null` = 清掉情境，跟 `Task.context` 语义一致。
   *
   * **情境这一维比别的维度更需要批量。** GTD 里分情境是 clarify 那一步的
   * 动作，而那一步天生是成批的（「这十二条都是出门办的」）。
   *
   * （单条现在也快了——`lib/taskMenu.ts` 里 ⋯ 有一组「情境」。这一条刚加上时
   * 单条要五步「开菜单 → 编辑 → 展开折叠块 → 选 → 保存」，那时这一颗是唯一
   * 能用的入口。两个都留着：一次分一条和一次分十二条是两种场合。）
   */
  onChangeContext: (context: TaskContext | null) => void;
  onDelete: () => void;
  onClear: () => void;
}

// 值和顺序从 `taskView.ts` 的 `STATUSES` 单一出处拿，不在这儿手抄一份——
// 原来这里是一份写死的四个，「已放弃」是后加的状态，抄的这份没跟上：
// 筛选栏里选不到已放弃的任务，批量操作条也没法把选中的几条一起标成放弃
// （单张卡上的状态按钮一直可以）。`grouping.ts` 的状态分组早就是这么引的
// （直接 import `STATUSES` + `STATUS_LABEL`），这两处是漏网的。
/** 「改期」子菜单的顺序。跟 TaskCard 那份分开：卡片上那组是单条的四个去处，
 *  这里少一个「去掉截止时间」——批量清空所有选中任务的截止时间，误点一下的
 *  代价比单条大一个量级，而它不像「删除」那样有垃圾箱兜底。要清就一条条清。 */
const BATCH_RESCHEDULE: RescheduleTo[] = ['today', 'tomorrow', 'nextWeek'];

/** 「不分情境」那一档的菜单 key。不能用空字符串（antd 菜单的 key 不能为空），
 *  也不能用任何一个真情境名——跟清单下拉那个 `__none__` 同一个写法。 */
const NO_CONTEXT = '__none__';


export function BatchBar({
  count, lists, onChangeStatus, onReschedule, onPostpone, onChangeList, onAddTag, onChangePriority, onChangeContext, onDelete, onClear,
}: BatchBarProps) {
  const [tagDraft, setTagDraft] = useState('');
  if (count === 0) return null;

  return (
    <div className="ink-batch-bar" role="toolbar" aria-label="批量操作">
      <span className="ink-batch-count">已选中 {count} 条</span>

      <Dropdown
        trigger={['click']}
        menu={{
          items: STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s] })),
          onClick: ({ key }) => onChangeStatus(key as Status),
        }}
      >
        <Button size="small">改状态</Button>
      </Dropdown>

      {/* 原生 <select>，不用 antd 的 Select——跟 TaskFields 的清单下拉框同一个
          理由：这里不需要搜索/多选，原生的可访问性判定更简单，测试用
          fireEvent.change 直接可驱动。不写 value（uncontrolled）：这是一个
          「批量把选中的都改成这个清单」的一次性动作，不是在显示「当前值」——
          选中的任务清单本来就可能各不相同，没有唯一的「当前值」可显示。 */}
      <select
        className="ink-batch-list-select"
        aria-label="批量改清单"
        defaultValue=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          onChangeList(v === '__none__' ? null : v);
        }}
      >
        <option value="" disabled>改清单…</option>
        <option value="__none__">不属于任何清单</option>
        {/* 智能清单（filter 非 null）不进候选——它是一份存下来的查询，不是
            容器，把任务的 listId 指到它上面没有意义：那条任务不会因此出现在
            这份智能清单里（智能清单按 applyFilter 取任务，不看 listId，见
            scoped.ts 顶部注释），反而会在导航里哪儿都找不到，见 task-4-brief
            要点③。跟 FilterBar.tsx「清单」那一维同一条规矩（normalLists 那行）。 */}
        {fileableLists(lists).map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>

      <input
        className="ink-batch-tag-input"
        aria-label="批量加标签"
        placeholder="加标签，回车确认"
        value={tagDraft}
        onChange={(e) => setTagDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const name = tagDraft.trim();
          if (!name) return;
          onAddTag(name);
          setTagDraft('');
        }}
      />

      <Dropdown
        trigger={['click']}
        menu={{
          items: PRI_MENU.map((p) => ({ key: String(p.v), label: p.label })),
          onClick: ({ key }) => onChangePriority(Number(key) as 0 | 1 | 2 | 3),
        }}
      >
        <Button size="small">改优先级</Button>
      </Dropdown>

      {/* 情境（GTD）。紧跟在优先级后面——跟编辑表单、筛选栏上那两处同一个
          先后。三处顺序一致，人才不用在每一处重新找一遍。
          「不分情境」排最后，不在五档里插队：它是「取消情境」这个动作，不是
          第六个情境——跟 PRI_MENU 把「无」摆在末尾是同一条。 */}
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            ...CONTEXTS.map((c) => ({ key: c, label: CONTEXT_LABEL[c] })),
            { key: NO_CONTEXT, label: '不分情境' },
          ],
          onClick: ({ key }) => onChangeContext(key === NO_CONTEXT ? null : (key as TaskContext)),
        }}
      >
        <Button size="small">改情境</Button>
      </Dropdown>

      {/* 日期这一维原来整个不在批量操作条上——而「把这五条一起推到明天」正是
          最需要批量的动作之一（滴答清单把它排在批量编辑的第一项）。 */}
      <Dropdown
        trigger={['click']}
        menu={{
          items: BATCH_RESCHEDULE.map((k) => ({ key: k, label: RESCHEDULE_LABEL[k] })),
          onClick: ({ key }) => onReschedule(key as RescheduleTo),
        }}
      >
        <Button size="small">改期</Button>
      </Dropdown>

      {/* 「推迟一小时」单独一颗按钮、不收进「改期」里：它是应付「临时插了个
          会」的当场动作，多一次点开菜单就失去意义了。 */}
      <Button size="small" onClick={() => onPostpone(POSTPONE_MINUTES)}>推迟 1 小时</Button>

      <Button size="small" danger onClick={onDelete}>删除</Button>
      <Button size="small" onClick={onClear}>取消选择</Button>
    </div>
  );
}
