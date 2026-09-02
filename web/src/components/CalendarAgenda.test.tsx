import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CalendarAgenda } from './CalendarAgenda.js';
import { calendarDays } from '../lib/calendar.js';
import { task } from '../test-utils.js';

const NOW = new Date(2026, 7, 25, 12, 0, 0);
const ANCHOR = new Date(2026, 7, 1);

const at = (d: number, h = 10, min = 0) => new Date(2026, 7, d, h, min).toISOString();

const show = (tasks: ReturnType<typeof task>[], over: Partial<Parameters<typeof CalendarAgenda>[0]> = {}) => {
  const onSelectDay = vi.fn();
  const r = render(
    <CalendarAgenda
      days={calendarDays(tasks, ANCHOR, 'agenda')}
      now={NOW}
      selectedKey={null}
      onSelectDay={onSelectDay}
      {...over}
    />,
  );
  return { ...r, onSelectDay };
};

const times = () => [...document.querySelectorAll('.ink-agenda-time')].map((e) => e.textContent);
const dayNums = () => [...document.querySelectorAll('.ink-agenda-num')].map((e) => e.textContent);

describe('CalendarAgenda：按天从上往下列', () => {
  it('**空的那些天不画**——一份从上往下读的清单里，二十几个「这天没有」中间夹着三条真的安排，是在用留白掩埋内容', () => {
    show([task({ id: 'a', title: '交周报', due: at(25) })]);
    expect(dayNums()).toEqual(['25']);
  });

  it('一天都没有事：说一句话，不摆一片空白', () => {
    show([]);
    expect(screen.getByText('这个月还没有排任何事。')).toBeTruthy();
  });

  it('按日期从早到晚排', () => {
    show([
      task({ id: 'b', title: '晚的', due: at(28) }),
      task({ id: 'a', title: '早的', due: at(3) }),
    ]);
    expect(dayNums()).toEqual(['3', '28']);
  });

  it('左边那一列写时刻', () => {
    show([task({ id: 'a', title: '交周报', due: at(25, 14, 30) })]);
    expect(times()).toEqual(['14:30']);
  });

  it('**全天的写「全天」，不写「00:00」**——本地零点是这个应用表达「整天」的方式，不是真的约在零点', () => {
    show([task({ id: 'a', title: '整天的事', due: at(25, 0, 0) })]);
    expect(times()).toEqual(['全天']);
  });

  it('这个月之外的不进来——`calendarDays` 的 agenda 档不补头尾那几天，那是格子网格为了凑满 6×7 才需要的', () => {
    show([
      task({ id: 'a', title: '这个月的', due: at(25) }),
      task({ id: 'b', title: '下个月的', due: new Date(2026, 8, 3, 10).toISOString() }),
    ]);
    expect(screen.getByText('这个月的')).toBeTruthy();
    expect(screen.queryByText('下个月的')).toBeNull();
  });

  it('点日期把 key 交出去，跟格子里点一天是同一个动作', () => {
    const { onSelectDay } = show([task({ id: 'a', due: at(25) })]);
    fireEvent.click(screen.getByRole('button', { name: /8月25日/ }));
    expect(onSelectDay).toHaveBeenCalledWith('2026-08-25');
  });

  it('给了 onOpen，任务名是个按钮；不给就只是一行字，不是点了没反应的按钮', () => {
    const onOpen = vi.fn();
    show([task({ id: 'a', title: '交周报', due: at(25) })], { onOpen });
    fireEvent.click(screen.getByRole('button', { name: '交周报' }));
    expect(onOpen).toHaveBeenCalledWith('a');

    document.body.innerHTML = '';
    show([task({ id: 'a', title: '交周报', due: at(25) })]);
    expect(screen.queryByRole('button', { name: '交周报' })).toBeNull();
    expect(screen.getByText('交周报')).toBeTruthy();
  });

  it('今天那一天有自己的记号', () => {
    const { container } = show([task({ id: 'a', due: at(25) })]);
    expect(container.querySelector('.ink-agenda-date-today')).not.toBeNull();
  });
});

/**
 * **一场只有时间段、没有截止时间的会**（编辑表单里那三个日期选择器互相独立，
 * 「九点到十二点开会」不填截止时间是最自然的输入）。
 *
 * `timeLabel` 原来写的是 `isAllDay(t) || !t.due`——`isAllDay` 明明已经判它
 * 不是全天了（它那段注释写着「把它扔进全天那一条等于把唯一有用的信息（几点
 * 到几点）丢掉」），后半句 `|| !t.due` 又把它扔了回去，于是左边那一列写着
 * **「全天」**。
 */
describe('CalendarAgenda：有时间段的写起点时刻，不写「全天」', () => {
  const meeting = (over = {}) =>
    task({ id: 'm', title: '开会', due: null, startAt: at(25, 9), endAt: at(25, 12), ...over });

  it('**写 09:00，不写「全天」**', () => {
    show([meeting()]);
    expect(times()).toEqual(['09:00']);
  });

  it('按时间段的起点，不是按 due', () => {
    show([meeting({ due: at(25, 18) })]);
    expect(times()).toEqual(['09:00']);
  });

  it('对照：真的全天（本地零点、没有时间段）还是写「全天」', () => {
    show([task({ id: 'a', title: '纪念日', due: at(25, 0, 0) })]);
    expect(times()).toEqual(['全天']);
  });

  it('对照：什么时间都没有的落不进这一档，一行都不画', () => {
    show([task({ id: 'n', title: '随手记', due: null })]);
    expect(times()).toEqual([]);
  });
});
