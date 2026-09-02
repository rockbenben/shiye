import { useEffect, useRef } from 'react';
import { Modal } from 'antd';
import type { List, Task } from '../types.js';
import { dueChip } from '../lib/dueChip.js';
import { listLabel } from '../lib/listIcon.js';
import { STATUS_LABEL } from '../lib/taskView.js';
import { NavIcon } from './NavIcon.js';

interface Props {
  open: boolean;
  onClose: () => void;
  query: string;
  onQuery: (q: string) => void;
  /** 已经按 `query` 筛过的那一批，调用方算（`searchTasks`），这里只管画。 */
  hits: Task[];
  /**
   * 这个实例里到底有没有任务。**只用来分空态的档**，不参与筛选。
   *
   * 少了它，一个刚装好、一条任务都没有的实例上，随便打个字看到的是「没有匹配
   * 的任务」——那是句误导：真实原因不是「这个词没命中」，是「压根没有东西可搜」，
   * 而这两种情况该给的下一步完全不同（换个词 vs 先去建一条）。空实例上实测过。
   */
  hasAnyTask: boolean;
  now: Date;
  lists: List[];
  /** 点中一条：交给调用方去「切到装得下它的去处 + 摊在详情面板里」。 */
  onOpen: (id: string) => void;
  /** 「看全部结果」——去「搜索」那个去处，那儿是完整的一列，带筛选和分组。 */
  onSeeAll: () => void;
}

/** 弹层里最多列几条。再多就该去「搜索」那个去处看，那儿有筛选和分组。 */
const MAX = 8;

/**
 * 搜索弹层（仿滴答清单）。
 *
 * **搜索是一个动作，不是一个去处**——滴答那边它在最左那条竖栏上，点开是一个
 * 浮在整屏之上的框，不是把右边那一栏换掉。这跟日历/习惯/四象限不一样：那几个
 * 切过去之后你就在那儿了，而搜索是「找一下，然后回到你本来在做的事」。
 *
 * 所以它**不进视图注册表**，也不占数字键：它是 `App` 一层的一个开关，跟设置
 * 抽屉、命令面板同一类。
 *
 * 这一版把原来长在清单侧栏顶上的那个搜索框整个搬了过来——那个框有个绕不过去
 * 的毛病：侧栏只有任务模块才渲染，站在习惯/日历上按 `/` 是一个完全没反应的键
 * （曾经靠「先切回任务模块再聚焦」打补丁，那是在给一个放错位置的东西加绷带）。
 */
export function SearchModal({ open, onClose, query, onQuery, hits, hasAnyTask, now, lists, onOpen, onSeeAll }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开就把光标放进去——这个弹层唯一的用途就是打字。`open` 从假变真那一刻
  // 才聚焦；antd 的 Modal 是下一帧才挂出 DOM，所以要等一拍。
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const shown = hits.slice(0, MAX);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      // 不要标题栏：一个搜索框本身就说清楚了它是什么，再加一行「搜索」是废话。
      // closable=false 同理——Esc 和点外面都关得掉（antd 自带），而右上角那个
      // × 会跟输入框抢这一屏唯一的视觉重点。
      title={null}
      closable={false}
      width={560}
      // 往上挪一点：搜索弹层出现在视线偏上的位置是这一类控件的惯例（命令面板
      // 同款），正中间会盖住结果列表本来该在的地方。
      style={{ top: 96 }}
      destroyOnHidden
      classNames={{ body: 'ink-searchmodal' }}
      aria-label="搜索"
    >
      <div className="ink-searchmodal-box">
        <span className="ink-searchmodal-icon"><NavIcon name="search" /></span>
        <input
          ref={inputRef}
          className="ink-searchmodal-input"
          type="search"
          aria-label="搜索任务"
          placeholder="搜索任务、标签"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            // 回车 = 「看全部结果」。一条都没打就回车什么也不做——跳去一个空
            // 搜索结果页是白跑一趟。
            if (e.key === 'Enter' && query.trim()) { onSeeAll(); onClose(); }
          }}
        />
      </div>

      {query.trim() === '' ? (
        // 空态说一句人话，不摆一个空列表——空列表看着像「搜不到」，而这时候
        // 是「还没搜」。
        <p className="ink-searchmodal-empty">打字就开始找。标题、备注、标签、子任务都在找的范围里。</p>
      ) : hits.length === 0 ? (
        <p className="ink-searchmodal-empty">
          {hasAnyTask
            ? '没有匹配的任务。换个词试试。'
            : '这儿还没有任务。关掉这个框，在任务列表上面那行「添加任务」写一条。'}
        </p>
      ) : (
        <>
          <ul className="ink-searchmodal-list" role="list">
            {shown.map((t) => {
              const chip = dueChip(t.due, now);
              const list = t.listId ? lists.find((l) => l.id === t.listId) : undefined;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className="ink-searchmodal-hit"
                    onClick={() => { onOpen(t.id); onClose(); }}
                  >
                    <span className="ink-searchmodal-title">{t.title}</span>
                    {/* **不是「待办」就说出来。** 搜索是这个应用里唯一一个
                        把所有状态混在一起给你看的地方（「已完成」和「搁置」
                        平时各在各的去处），而在这之前一条已完成的任务在这
                        一列里跟一条待办长得一模一样——点进去才发现它早就做完
                        了。「待办」是默认状态，说出来只是噪音，不画。 */}
                    {t.status !== 'todo' && (
                      <span className="ink-searchmodal-meta">{STATUS_LABEL[t.status] ?? t.status}</span>
                    )}
                    {/* 右边挂「哪个清单 · 什么时候」——搜出五条同名的任务时，
                        分得开它们的正是这两样。 */}
                    {list && <span className="ink-searchmodal-meta">{listLabel(list.name).text}</span>}
                    {chip && <span className="ink-searchmodal-meta">{chip.text}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {/* 截断了要说出来——看起来是全部、其实只有前八条，跟专注统计那张
              排行榜同一条规矩。 */}
          {hits.length > MAX && (
            <button type="button" className="ink-searchmodal-more" onClick={() => { onSeeAll(); onClose(); }}>
              还有 {hits.length - MAX} 条，看全部结果
            </button>
          )}
        </>
      )}
    </Modal>
  );
}
