import { useState } from 'react';
import { Button } from 'antd';
import type { Task } from '../types.js';
import { suggestGroups } from '../lib/suggest.js';
import { reschedulePatch } from '../lib/reschedule.js';
import { dueChip } from '../lib/dueChip.js';

interface Props {
  tasks: Task[];
  now: Date;
  onPatch: (id: string, patch: Partial<Task>) => void;
  /**
   * 点任务名：跳回那条任务、把它的编辑表单指出来。跟专注统计、习惯页、
   * 「回顾」里点任务名是同一个动作（`App.tsx` 的 `openTask`）。
   *
   * 不给就还是一行字——点了没反应的入口比没有更糟。
   */
  onOpen?: (taskId: string) => void;
}

/**
 * 「推荐任务」面板，挂在「今天」上面。仿滴答清单「今天」右上角那颗灯泡。
 *
 * 存在的理由：「今天」是一份**空得下去**的列表——今天该做的都做完了，它就
 * 只剩一句「今天没有要做的」。但看板上多半还躺着二十条没排时间的任务，它们
 * 在这一屏上一个字都不出现。这个面板回答的就是「那接下来干什么」，判据在
 * `lib/suggest.ts`。
 *
 * **默认收起。** 它是「今天列表之外还有什么」，不是今天要做的事——常驻展开会
 * 把主角挤下去，而这个应用的「今天」是给他一眼看完的。没有任何推荐时连那颗
 * 按钮都不出现：一个点开永远是空的入口比没有更糟。
 */
export function SuggestPanel({ tasks, now, onPatch, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const groups = suggestGroups(tasks, now);
  if (groups.length === 0) return null;
  const total = groups.reduce((n, g) => n + g.tasks.length, 0);

  return (
    <section className="ink-suggest" aria-label="推荐任务">
      <Button size="small" type="text" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} 推荐任务 {total}
      </Button>
      {open && groups.map((g) => (
        <div className="ink-suggest-group" key={g.key}>
          <h2 className="ink-suggest-title">
            {g.title}
            <span className="ink-suggest-hint">{g.hint}</span>
          </h2>
          <ul className="ink-suggest-list">
            {g.tasks.map((t) => {
              const chip = dueChip(t.due, now);
              return (
                <li className="ink-suggest-item" key={t.id}>
                  {/* 名字点得开：跳回那条任务并把它的编辑表单指出来。这一屏
                      回答的是「今天列表之外还有什么」，而看见「这条躺了 30 天」
                      之后想做的**未必**是「加到今天」——也可能是打开它改小、
                      或者干脆放弃。只有那一个动作的话，另外两条路要自己去别的
                      视图里把它找出来。跟专注统计、习惯页、回顾里点任务名是
                      同一个动作（App 的 `openTask`）。 */}
                  {onOpen
                    ? <button type="button" className="ink-suggest-name" style={{ textDecoration: 'underline' }} onClick={() => onOpen(t.id)}>{t.title}</button>
                    : <span className="ink-suggest-name">{t.title}</span>}
                  {/* 有截止时间的把它显出来：「即将到来」那一组不写日期的话，
                      「明天」和「后天」在屏幕上长得一模一样。用的是卡片上那颗
                      chip 的同一份文案（`dueChip`），不另拼一套格式。 */}
                  {chip && <span className="ink-suggest-when">{chip.text}</span>}
                  {t.postponeCount > 0 && <span className="ink-suggest-when">推迟过 {t.postponeCount} 次</span>}
                  {/* 「加到今天」= 把截止时间挪到今天，走的是卡片 ⋯ 里「改期→
                      今天」那一条同一个纯函数（提醒跟着平移、原来几点还是几点）。
                      不另写一份「怎么算今天」——两处算出不一样的结果是这个仓库
                      反复栽的形状。 */}
                  <Button
                    size="small"
                    aria-label={`把「${t.title}」加到今天`}
                    onClick={() => onPatch(t.id, reschedulePatch(t, 'today', now))}
                  >加到今天</Button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
