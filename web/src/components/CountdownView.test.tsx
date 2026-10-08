import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

  /**
   * 日期坏掉（手改 `data/countdowns/` 写了别的）时，卡面上说的是**怎么改对**，
   * 不是「我解析到了什么」。原来那一行是
   * `日期坏了：2026-11-01T16:00:00.000Z`——一串 ISO 时间戳对不上任何一个输入框
   * 的形状（那里收的是 `YYYY-MM-DD`），看完只知道它坏了，不知道该怎么改。
   * 夹具故意用那一串真实踩过的形状，不用「下周三」：机器串才是这条文案要
   * 回答的那一种坏法。
   */
  describe('日期坏掉那一条', () => {
    const BROKEN = '2026-11-01T16:00:00.000Z';

    it('说清要填成什么形状，并点名一颗屏幕上真有的按钮', () => {
      show([cd({ id: 'x', title: '坏的', date: BROKEN })], { onEdit: vi.fn() });
      const bad = screen.getByText(/日期没写对/);
      expect(bad.textContent).toMatch(/年-月-日/);
      expect(bad.textContent).toMatch(/✎/);
      // 「点右边那颗 ✎」不能指空气：同一行得真有一颗「改」的按钮。
      const row = bad.closest('.ink-cd-row') as HTMLElement;
      expect(within(row).getByLabelText('改「坏的」')).toBeTruthy();
    });

    it('原始值不丢——挪进 title，排查的人悬停看得见', () => {
      show([cd({ id: 'x', title: '坏的', date: BROKEN })]);
      expect(screen.getByText(/日期没写对/).getAttribute('title')).toContain(BROKEN);
    });

    it('卡面上不再甩机器串，也没有 NaN 天', () => {
      show([cd({ id: 'x', title: '坏的', date: BROKEN })], { onEdit: vi.fn() });
      const row = screen.getByText(/日期没写对/).closest('.ink-cd-row')?.textContent ?? '';
      expect(row).not.toContain(BROKEN);
      expect(row).not.toMatch(/NaN/);
    });

    /** `onEdit` 没接的时候那一行没有 ✎（按钮本来就按它渲染），那句话就不能
     *  教人去找一个屏幕上没有的东西。 */
    it('没接 onEdit 时不点名 ✎，但照样说清该填成什么形状', () => {
      show([cd({ id: 'x', title: '坏的', date: BROKEN })]);
      const bad = screen.getByText(/日期没写对/);
      expect(bad.textContent).not.toMatch(/✎/);
      expect(bad.textContent).toMatch(/年-月-日/);
    });
  });

  /** 名字那一格在窄屏会被截（实测 390：可视 50px / 全文 56px，「妈妈生日」差
   *  一个字）。jsdom 量不到截断，所以钉的是「它带着自己那份全文」——日历格子里
   *  的事件块（`.fc-event`）和行档的任务标题（`.ink-trow`）都早就这么做了，
   *  这一屏是漏的那一个：截了又没有第二处能读全。 */
  it('名字带全文 title——被截的时候悬停读得全', () => {
    show([cd({ id: 'a', title: '妈妈生日' })]);
    expect(screen.getByText('妈妈生日').getAttribute('title')).toBe('妈妈生日');
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
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '保存')!);
    expect(onEdit).toHaveBeenCalledWith('c1', { title: '期末考试' });
  });

  it('两样都改就都发', () => {
    const onEdit = vi.fn();
    show([row()], { onEdit });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.change(screen.getByLabelText('「期末考」的新名字'), { target: { value: '补考' } });
    fireEvent.change(screen.getByLabelText('「期末考」的新日期'), { target: { value: '2026-09-10' } });
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '保存')!);
    expect(onEdit).toHaveBeenCalledWith('c1', { title: '补考', date: '2026-09-10' });
  });

  it('什么都没改就不发，直接收起来', () => {
    const onEdit = vi.fn();
    show([row()], { onEdit });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '保存')!);
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('「期末考」的新名字')).toBeNull();
  });

  /**
   * **正在改那一行时，这一行只干「改」这一件事。**
   *
   * 实测（1280 行档、点 ✎ 之后一行里八个控件）：编辑态里「每年」「农历」两个
   * 勾选框和那颗「×」原来都还站着。勾选框是**立刻发写**的（同一条 PATCH，不
   * 经过草稿），于是「名字改到一半顺手勾了每年」= 一次半存的状态：名字日期还
   * 在草稿里，重复规则已经落库——而那一行会因 `yearly` 立刻重排（`sortCountdowns`
   * 按天数排），正在输入的那一格当场跳位。× 更要紧：编辑中途一键就能把这条
   * 删掉，确认框挡得住数据，挡不住那一格正在输入的东西。
   */
  it('编辑态收掉「每年」「农历」「×」——这一行只留两个输入框、保存和取消', () => {
    show([row({ yearly: true })], { onEdit: vi.fn() });
    // 进编辑之前三样都在（反向控制：不是「永远不渲染」蒙过下面三条）。
    expect(screen.getByLabelText('「期末考」每年重复')).toBeTruthy();
    expect(screen.getByLabelText('「期末考」按农历算')).toBeTruthy();
    expect(screen.getByLabelText('删掉「期末考」')).toBeTruthy();
    expect(screen.getByRole('listitem').className).not.toContain('ink-cd-row-edit');

    fireEvent.click(screen.getByLabelText('改「期末考」'));
    expect(screen.queryByLabelText('「期末考」每年重复')).toBeNull();
    expect(screen.queryByLabelText('「期末考」按农历算')).toBeNull();
    expect(screen.queryByLabelText('删掉「期末考」')).toBeNull();
    /**
     * **那一行得带上放开折行的那层壳。** 样式表里那条规则有 `theme.css.test.ts`
     * 盯着，组件这边盯着类名——两头都钉住，中间那根线才不是空的：只删类名的话
     * 样式测试照样绿，而真浏览器里名字框会回到 23px 宽。
     */
    expect(screen.getByRole('listitem').className).toContain('ink-cd-row-edit');
  });

  /**
   * **得有一条退路。** 那一行原来只有「保存」——改乱了想收手，只能把改坏的
   * 存下去，或者清空字段赌它「静默丢弃」（`saveEdit` 空名字那支确实是不发就收，
   * 但那是一条没人看得见的暗道）。跟删任务要先确认同一条道理：**没有退路的
   * 动作要给一条明路**。
   */
  it('点「取消」：一个字段都不发、收起来，再点开预填的还是原名', () => {
    const onEdit = vi.fn();
    show([row()], { onEdit });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.change(screen.getByLabelText('「期末考」的新名字'), { target: { value: '改乱了' } });
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '取消')!);

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('「期末考」的新名字')).toBeNull();
    expect(screen.getByText('期末考')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('改「期末考」'));
    expect((screen.getByLabelText('「期末考」的新名字') as HTMLInputElement).value).toBe('期末考');
  });

  it('输入框里按 Esc 跟点「取消」同一件事', () => {
    const onEdit = vi.fn();
    show([row()], { onEdit });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.change(screen.getByLabelText('「期末考」的新日期'), { target: { value: '2026-12-31' } });
    fireEvent.keyDown(screen.getByLabelText('「期末考」的新日期'), { key: 'Escape' });

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('「期末考」的新日期')).toBeNull();
  });

  it('**名字清空了不发**——服务端会拒，而他很可能只是想按回车取消', () => {
    const onEdit = vi.fn();
    show([row()], { onEdit });
    fireEvent.click(screen.getByLabelText('改「期末考」'));
    fireEvent.change(screen.getByLabelText('「期末考」的新名字'), { target: { value: '   ' } });
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '保存')!);
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
