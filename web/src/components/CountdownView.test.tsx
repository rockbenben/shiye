import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { CountdownView } from './CountdownView.js';
import { NoMotion, btnIn, confirmDialog } from '../test-utils.js';
import type { Countdown } from '../types.js';

const NOW = new Date(2026, 7, 19, 15);   // 2026-08-19

const cd = (over: Partial<Countdown> = {}): Countdown => ({
  id: 'c', title: '考试', date: '2026-09-01', yearly: false, lunar: false,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

function show(rows: Countdown[] = [], opts: { onEdit?: (id: string, patch: object) => void } = {}) {
  const onAdd = vi.fn();
  const onDelete = vi.fn();
  const onToggleYearly = vi.fn();
  const onToggleLunar = vi.fn();
  const utils = render(
    <NoMotion><AntApp>
      <CountdownView rows={rows} now={NOW} onAdd={onAdd} onDelete={onDelete} onToggleYearly={onToggleYearly}
        onToggleLunar={onToggleLunar} onEdit={opts.onEdit} />
    </AntApp></NoMotion>,
  );
  return { ...utils, onAdd, onDelete, onToggleYearly, onToggleLunar };
}

describe('CountdownView', () => {
  it('一条都没有时说清楚这是干什么用的——「不是任务、但想知道还有几天」', () => {
    show([]);
    expect(screen.getByText(/还没有纪念日/)).toBeTruthy();
  });

  it('日期默认填今天', () => {
    show([]);
    expect((screen.getByLabelText('日期') as HTMLInputElement).value).toBe('2026-08-19');
  });

  it('名字空着时「添加」是禁用的', () => {
    const { container } = show([]);
    expect(btnIn(container, '添加').hasAttribute('disabled')).toBe(true);
  });

  it('填了名字就能加，报出名字/日期/每年/农历四样', () => {
    const { container, onAdd } = show([]);
    fireEvent.change(screen.getByLabelText('纪念日名字'), { target: { value: '期末考' } });
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-12-20' } });
    fireEvent.click(btnIn(container, '添加'));
    expect(onAdd).toHaveBeenCalledWith('期末考', '2026-12-20', false, false);
  });

  it('加完只清名字，日期和「每年」留着——一次录一批生日是最典型的用法', () => {
    const { container } = show([]);
    fireEvent.change(screen.getByLabelText('纪念日名字'), { target: { value: '期末考' } });
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-12-20' } });
    fireEvent.click(btnIn(container, '添加'));
    expect((screen.getByLabelText('纪念日名字') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('日期') as HTMLInputElement).value).toBe('2026-12-20');
  });

  it('倒数 / 正数 / 就是今天三种说法', () => {
    show([
      cd({ id: 'a', title: '考试', date: '2026-09-01' }),
      cd({ id: 'b', title: '在一起', date: '2026-08-09' }),
      cd({ id: 'c', title: '今天这个', date: '2026-08-19' }),
    ]);
    expect(screen.getByText('还有 13 天')).toBeTruthy();
    expect(screen.getByText('已经 10 天')).toBeTruthy();
    expect(screen.getByText('就是今天')).toBeTruthy();
  });

  it('日期坏掉（手改文件）时说出来，不显示 NaN 天', () => {
    show([cd({ id: 'x', title: '坏的', date: '下周三' })]);
    expect(screen.getByText(/日期坏了/)).toBeTruthy();
  });

  it('切「每年」报上去', () => {
    const { onToggleYearly } = show([cd({ id: 'a', title: '生日', date: '2026-03-10' })]);
    fireEvent.click(screen.getByLabelText('「生日」每年重复'));
    expect(onToggleYearly).toHaveBeenCalledWith('a', true);
  });

  it('删除先问一句——纪念日不进垃圾箱，这一下就是真的没了', async () => {
    const { onDelete } = show([cd({ id: 'a', title: '考试' })]);
    fireEvent.click(screen.getByLabelText('删掉「考试」'));
    const dialog = await confirmDialog();
    expect(dialog.textContent).toContain('不进垃圾箱');
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(btnIn(dialog, '删除'));
    expect(onDelete).toHaveBeenCalledWith('a');
  });
});

/**
 * 改名字/改日期。**这两样以前改不了**：「每年」那个勾选框一直是就地改的
 * （同一条 `PATCH /api/countdowns/:id`），只有标题和日期没有入口——打错一个
 * 字、日子记差一天，只能删了重填。
 */
describe('CountdownView：改名字和日期', () => {
  const row = (over: Partial<Countdown> = {}): Countdown => ({
    id: 'c1', title: '期末考', date: '2026-09-01', yearly: false, lunar: false,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...over,
  });

  it('不给 onEdit 就没有那颗按钮', () => {
    show([row()]);
    expect(screen.queryByLabelText('改「期末考」')).toBeNull();
  });

  it('点了就地换成两个输入框，预填当前的名字和日期', () => {
    show([row()], { onEdit: vi.fn() });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    expect((screen.getByLabelText('「期末考」的新名字') as HTMLInputElement).value).toBe('期末考');
    expect((screen.getByLabelText('「期末考」的新日期') as HTMLInputElement).value).toBe('2026-09-01');
  });

  it('只发**真的改过**的那几个字段——一次什么都不改的写只会白白触发一轮刷新', () => {
    const onEdit = vi.fn();
    show([row()], { onEdit });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.change(screen.getByLabelText('「期末考」的新名字'), { target: { value: '期末考试' } });
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '存下')!);
    expect(onEdit).toHaveBeenCalledWith('c1', { title: '期末考试' });
  });

  it('两样都改就都发', () => {
    const onEdit = vi.fn();
    show([row()], { onEdit });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.change(screen.getByLabelText('「期末考」的新名字'), { target: { value: '补考' } });
    fireEvent.change(screen.getByLabelText('「期末考」的新日期'), { target: { value: '2026-09-10' } });
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '存下')!);
    expect(onEdit).toHaveBeenCalledWith('c1', { title: '补考', date: '2026-09-10' });
  });

  it('什么都没改就不发，直接收起来', () => {
    const onEdit = vi.fn();
    show([row()], { onEdit });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '存下')!);
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('「期末考」的新名字')).toBeNull();
  });

  it('**名字清空了不发**——服务端会拒，而他很可能只是想按回车取消', () => {
    const onEdit = vi.fn();
    show([row()], { onEdit });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.change(screen.getByLabelText('「期末考」的新名字'), { target: { value: '   ' } });
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '存下')!);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('一次只开一个', () => {
    show([row(), row({ id: 'c2', title: '生日' })], { onEdit: vi.fn() });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.click(screen.getByLabelText('改「生日」'));
    expect(screen.queryByLabelText('「期末考」的新名字')).toBeNull();
    expect(screen.getByLabelText('「生日」的新名字')).toBeTruthy();
  });
});

/**
 * 农历那个勾选框（仿滴答清单的「公历/农历」）。**算什么在
 * `lib/countdown.test.ts`**——这里只测接线：什么时候出现、点了发什么。
 */
describe('CountdownView：农历', () => {
  const lunarBox = () => screen.queryByLabelText(/按农历算/);
  const addLunar = () => screen.getAllByRole('checkbox').find(
    (b) => b.parentElement?.textContent?.includes('农历'),
  ) as HTMLInputElement | undefined;

  it('**没勾「每年」时那一格不出现**——不重复的日子按农历算跟按公历算是同一天', () => {
    show();
    expect(addLunar()).toBeUndefined();
  });

  it('勾了「每年」之后才出现', () => {
    show();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);   // 「每年」
    expect(addLunar()).toBeTruthy();
  });

  it('新建时把农历一起发出去', () => {
    const { container, onAdd } = show();
    fireEvent.change(screen.getByLabelText('纪念日名字'), { target: { value: '奶奶生日' } });
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-08-15' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);   // 每年
    fireEvent.click(addLunar()!);                          // 农历
    fireEvent.click(btnIn(container, '添加'));
    expect(onAdd).toHaveBeenCalledWith('奶奶生日', '2026-08-15', true, true);
  });

  it('**没勾「每年」时发出去的农历一定是 false**——存一个不起作用的 true 只会让人以为勾了没反应', () => {
    const { container, onAdd } = show();
    fireEvent.change(screen.getByLabelText('纪念日名字'), { target: { value: '考试' } });
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-09-01' } });
    fireEvent.click(btnIn(container, '添加'));
    expect(onAdd).toHaveBeenCalledWith('考试', '2026-09-01', false, false);
  });

  /**
   * **勾上农历、再把「每年」取消掉**——农历那一格会消失，但它的 state 还留着
   * true。这是 UI 上唯一走得到「lunar 为真而 yearly 为假」的路，也正是
   * `yearly && lunar` 那个与门存在的理由：不加的话这一下会存下一个不起作用的
   * true，下次再勾「每年」，那条纪念日会莫名其妙地变成农历。
   */
  it('**勾了农历再取消「每年」，发出去的农历是 false**——不留一个不起作用的 true', () => {
    const { container, onAdd } = show();
    fireEvent.change(screen.getByLabelText('纪念日名字'), { target: { value: '考试' } });
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-09-01' } });
    const everyYear = screen.getAllByRole('checkbox')[0];
    fireEvent.click(everyYear);        // 每年 ✓
    fireEvent.click(addLunar()!);      // 农历 ✓
    fireEvent.click(everyYear);        // 每年 ✗ —— 农历那一格消失，state 还是 true
    expect(addLunar()).toBeUndefined();
    fireEvent.click(btnIn(container, '添加'));
    expect(onAdd).toHaveBeenCalledWith('考试', '2026-09-01', false, false);
  });

  it('行上：每年的那条才有农历勾选框，点了就地发一个写', () => {
    const { onToggleLunar } = show([cd({ id: 'x', title: '中秋', yearly: true })]);
    fireEvent.click(lunarBox()!);
    expect(onToggleLunar).toHaveBeenCalledWith('x', true);
  });

  it('行上：不是每年的那条没有农历勾选框', () => {
    show([cd({ id: 'y', yearly: false })]);
    expect(lunarBox()).toBeNull();
  });
});
