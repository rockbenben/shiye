import { useEffect, useRef, useState } from 'react';
import type { List, Task } from '../types.js';
import { DEFAULT_GROUP_SORT, SORT_LABEL, regroupSections, type SortBy } from '../lib/grouping.js';
import { SCHEDULE_AXES, SCHEDULE_AXIS_LABEL, axisToGroupBy, unscheduled, type ScheduleAxis } from '../lib/schedulePanel.js';
import { listLabel } from '../lib/listIcon.js';
import { PRI_LABEL_ALL } from './TaskFields.js';

interface Props {
  /** 全量任务；这一栏自己挑出「没日期又没了结」的那些（`unscheduled`）。 */
  tasks: Task[];
  lists: List[];
  now: Date;
  /** 收起这一栏。 */
  onClose: () => void;
  /**
   * 点一条：打开它的详情。**不是必须的**——不给就只是不能点开，拖拽照常。
   * 跟专注统计、习惯页、回顾里点任务名是同一个动作（App 的 `openTask`）。
   */
  onOpen?: (taskId: string) => void;
  /**
   * 手动挪位置（↑/↓）。收到的是**整份当前可见顺序 + 新 order**，跟
   * `TodayView` 的 `onReorder` 是同一份契约、同一个后端批量端点。
   *
   * 不给就不画那两颗按钮——一个点了没反应的入口比没有更糟。
   */
  onReorder?: (pairs: Array<{ id: string; order: number }>) => Promise<unknown>;
}

/**
 * 「安排任务」栏——日历右边那一条（仿滴答清单）。
 *
 * 帮助文档原话：「把安排任务栏打开，你可以在这里查看到所有无日期的任务」
 * 「拖拽到日历中即可」。判据（哪些算「无日期」）在 `lib/schedulePanel.ts`。
 *
 * **拖拽这件事这个组件自己不实现。** 每一行只负责把 `data-task-id` 写在
 * DOM 上、并声明自己是 `.ink-sched-item`；真正把它变成「能拖进 FullCalendar
 * 的外部元素」的是 `CalendarView` 那边挂的 `@fullcalendar/interaction` 的
 * `Draggable`（它要的正是「一个容器 + 一个 itemSelector」）。这么分是因为
 * 落点全在日历那侧：FullCalendar 只认它自己那套外部拖拽协议，让这个组件去
 * 认识日历等于把两边绑死。
 *
 * **↑/↓ 而不是拖着排序。** 行本身的拖拽手势已经被「拖到日历上」占掉了，
 * 同一个手势不能同时表达两件事；再挂一套 `@dnd-kit` 就要为它单开一个抓手，
 * 而这一栏的行只有一行字宽。↑/↓ 写的是同一个 `order` 字段、走同一个批量
 * 端点，键盘也用得了，跟「今天」那份手动排序是同一套东西。
 */
export function SchedulePanel({ tasks, lists, now, onClose, onOpen, onReorder }: Props) {
  const [axis, setAxis] = useState<ScheduleAxis>('list');
  const [sortBy, setSortBy] = useState<SortBy>('default');
  // 收起来的组。**存的是「哪些收起来了」而不是「哪些展开着」**：新出现的组
  // （新建了一个清单、给某条任务打了个新标签）默认该是展开的。
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // 挪完之后把焦点还给同一颗按钮——键盘连按 ↓ 把一条一路挪到底，中途焦点
  // 掉回 body 的话就断了。跟 TodayView 那份是同一个用意，这里只需要最朴素
  // 的一档：记住 id + 方向，重渲染之后按 data 属性找回来。
  const refocus = useRef<{ id: string; dir: 'up' | 'down' } | null>(null);

  const mine = unscheduled(tasks);
  const sections = regroupSections(
    [{ key: 'all', title: '', tasks: mine }],
    { ...DEFAULT_GROUP_SORT, groupBy: axisToGroupBy(axis), sortBy },
    { lists, now },
  );
  // ↑/↓ 算的是**整份可见顺序**（跨组，按屏幕上从上到下），不是组内——
  // `order` 是一个全局字段，只在组内重排会让另一个分组轴下的顺序变得没法解释。
  const flat = sections.flatMap((s) => s.tasks);

  useEffect(() => {
    const want = refocus.current;
    if (!want || busy) return;
    refocus.current = null;
    // 遍历比拼选择器稳：任务 id 来自磁盘上那份手改的 JSON，里面可能有引号
    // 之类会把属性选择器拆坏的字符，而 `CSS.escape` 在 jsdom 里压根不存在
    // （实测这条路会当场抛 TypeError，把整个面板带崩）。
    const row = [...document.querySelectorAll<HTMLElement>('.ink-sched-item')]
      .find((e) => e.dataset.taskId === want.id);
    row?.querySelector<HTMLButtonElement>(`.ink-sched-move[data-dir="${want.dir}"]`)?.focus();
  }, [busy, flat.length]);

  const move = async (id: string, delta: -1 | 1) => {
    if (!onReorder || busy) return;
    const from = flat.findIndex((t) => t.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= flat.length) return;
    const next = [...flat];
    next.splice(to, 0, ...next.splice(from, 1));
    refocus.current = { id, dir: delta < 0 ? 'up' : 'down' };
    setBusy(true);
    try {
      await onReorder(next.map((t, i) => ({ id: t.id, order: i })));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string) => setFolded((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  return (
    <aside className="ink-sched" aria-label="安排任务">
      <div className="ink-sched-head">
        <h2 className="ink-sched-title">安排任务</h2>
        <button type="button" className="ink-sched-close" onClick={onClose}>收起</button>
      </div>

      {/* 三个页签，跟滴答那一栏顶上一字不差。用 role="tablist" 而不是三颗
          普通按钮：读屏会报「3 个中的第 1 个」，方向键也能切。 */}
      <div className="ink-sched-tabs" role="tablist" aria-label="按什么分组">
        {SCHEDULE_AXES.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={axis === a}
            className={`ink-sched-tab${axis === a ? ' ink-sched-tab-active' : ''}`}
            onClick={() => setAxis(a)}
          >{SCHEDULE_AXIS_LABEL[a]}</button>
        ))}
      </div>

      {/* 组内怎么排。复用 `grouping.ts` 那份档位表，不为这一栏另发明一套
          ——「按预计时长」这种档在这儿恰恰最有用（「我今天还剩四十分钟，
          先排哪条」）。 */}
      <label className="ink-sched-sort">
        <span className="ink-sr-only">排序</span>
        <select
          className="ink-sched-select"
          aria-label="排序"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
        >
          {(Object.keys(SORT_LABEL) as SortBy[]).map((s) => (
            <option key={s} value={s}>{SORT_LABEL[s]}</option>
          ))}
        </select>
      </label>

      {mine.length === 0 ? (
        // 空状态是句好消息，不是「没搜到」。
        <p className="ink-empty-note">每一条都排上日期了。</p>
      ) : (
        <div className="ink-sched-groups">
          {sections.map((sec) => {
            const open = !folded.has(sec.key);
            return (
              <section className="ink-sched-group" key={sec.key}>
                <button
                  type="button"
                  className="ink-sched-grouphead"
                  aria-expanded={open}
                  onClick={() => toggle(sec.key)}
                >
                  <span className="ink-grid-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                  {sec.title}
                  <span className="ink-sched-count">{sec.tasks.length}</span>
                </button>
                {open && (
                  <ul className="ink-sched-list" role="list">
                    {sec.tasks.map((t) => {
                      const list = t.listId ? lists.find((l) => l.id === t.listId) : undefined;
                      const i = flat.findIndex((x) => x.id === t.id);
                      return (
                        <li
                          className="ink-sched-item"
                          key={t.id}
                          // FullCalendar 的 Draggable 靠这个把「拖的是哪条」
                          // 传出去，见 CalendarView 里挂它的地方。
                          data-task-id={t.id}
                          title="拖到日历上就给它排上时间"
                        >
                          {/* 清单色只上记号不上字——跟 `.ink-list-dot` 全站
                              同一条规矩（分类色永远不进字）。 */}
                          {list && (
                            <span
                              className="ink-sched-dot"
                              style={{ backgroundColor: list.color }}
                              aria-hidden="true"
                            />
                          )}
                          {onOpen ? (
                            <button type="button" className="ink-sched-name" onClick={() => onOpen(t.id)}>
                              {t.title}
                            </button>
                          ) : <span className="ink-sched-name">{t.title}</span>}
                          {/* 按清单分组时行上不再重复清单名（组标题已经写了），
                              按标签/优先级分组时才补一句它属于哪个清单。 */}
                          {axis !== 'list' && list && (
                            <span className="ink-sched-meta">{listLabel(list.name).text}</span>
                          )}
                          {axis !== 'priority' && t.priority > 0 && (
                            <span className="ink-sched-meta">{PRI_LABEL_ALL[t.priority]}</span>
                          )}
                          {onReorder && (
                            <span className="ink-sched-moves">
                              <button
                                type="button"
                                className="ink-sched-move"
                                data-dir="up"
                                aria-label={`把「${t.title}」往上挪`}
                                disabled={busy || i <= 0}
                                onClick={() => void move(t.id, -1)}
                              >↑</button>
                              <button
                                type="button"
                                className="ink-sched-move"
                                data-dir="down"
                                aria-label={`把「${t.title}」往下挪`}
                                disabled={busy || i < 0 || i >= flat.length - 1}
                                onClick={() => void move(t.id, 1)}
                              >↓</button>
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
}
