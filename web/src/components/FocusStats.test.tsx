import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { FocusStats } from './FocusStats.js';
import { task } from '../test-utils.js';
import type { FocusSession, Task, WeekStart } from '../types.js';

const local = (y: number, mo: number, d: number, h = 9) => new Date(y, mo - 1, d, h);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();
const NOW = local(2026, 8, 19, 12);

const withSessions = (id: string, sessions: FocusSession[], over: Partial<Task> = {}) =>
  task({ id, title: id, focusSessions: sessions, ...over });

/** `message.useApp()` 要一层 `<AntApp>`，所有渲染都经这一个入口。
 *  `now` / `weekStart` 可覆盖：总览那四格旁边的小字说的是「这一档盖了哪几天」，
 *  要验跨月、跨年、周日档三种范围就得能换日子。 */
function show(tasks: Task[], opts: {
  onPatch?: (id: string, patch: Partial<Task>) => void;
  now?: Date;
  weekStart?: WeekStart;
  onOpen?: (taskId: string) => void;
} = {}) {
  const onPatch = opts.onPatch ?? vi.fn();
  const utils = render(
    <AntApp><FocusStats tasks={tasks} now={opts.now ?? NOW} weekStart={opts.weekStart} onPatch={onPatch}
      onOpen={opts.onOpen} /></AntApp>,
  );
  return { ...utils, onPatch };
}

/** 某一格的名字 + 旁边那行日期，连起来当一句读（「本周9月28日–10月3日」）。
 *  按名字找、拿它父节点的整句文本，而不是 `getByText(/本周/)`——那样「本周」
 *  出现在哪儿都能匹配到，钉不住「范围就写在这格的名字旁边」这件事。 */
const cellLine = (label: string) =>
  screen.getByText(label).parentElement?.textContent ?? '';

/** 不接 onPatch 的那一份——「补记」整块不该渲染。 */
const showReadonly = (tasks: Task[]) =>
  render(<AntApp><FocusStats tasks={tasks} now={NOW} /></AntApp>);

const btn = (text: string) =>
  screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === text);

describe('FocusStats', () => {
  it('一次都没专注过：说一句话，不画三张空图表——空图看着像坏了，而这是新机器上的常态', () => {
    const { container } = show([task({ id: 'a' })]);
    expect(screen.getByText(/还没有专注记录/)).toBeTruthy();
    expect(container.querySelector('.ink-fstat-trend')).toBeNull();
  });

  it('四个总览格子都在', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    for (const label of ['今天', '本周', '本月', '至今']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  /**
   * 每格旁边那一行小字说的是「这一档盖了哪几天」。
   *
   * 实测的起因：10 月 3 日那一屏上「本周 3 小时 45 分」摆在「本月 2 小时 6 分」
   * 上面，第一反应是「本月包含本周，怎么反而少」。数是对的（本周从 9 月 28 日
   * 起，跨了月），缺的是范围。逐字钉整句，不拆成「包含 9 月」这种说法——
   * 范围写成「9月28日–10月3日」还是「9/28–10/3」还是漏了年份，界面上都是
   * 一眼能看出来的差别，测试也该看得见。
   *
   * 「至今」那一格没有日期：它数的是全部记录，一天都没被排除在外。这一条
   * 断言在它身上——少一格日期是设计，多一格编出来的是噪音。
   */
  it('三格报出自己盖的那几天，「至今」不报', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    expect(cellLine('今天')).toBe('今天8月19日');
    expect(cellLine('本周')).toBe('本周8月17日–19日');
    expect(cellLine('本月')).toBe('本月8月1日–19日');
    expect(cellLine('至今')).toBe('至今');
  });

  /** 同月省掉后一边的月：「8月1日–19日」不是「8月1日–8月19日」——一格那么窄，
   *  重复的月名只会把真正要看的日子挤下去。 */
  it('同月不重复月名，跨月两边都写', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 10, 3), minutes: 25 }])], { now: local(2026, 10, 3, 12) });
    expect(cellLine('本月')).toBe('本月10月1日–3日');
    expect(cellLine('本周')).toBe('本周9月28日–10月3日');
  });

  /** 跨到上个月那一周：起点写在 9 月。「本月为什么比本周少」这句话没有第四个
   *  地方可说——它就靠这两行的月份不一样说出来。 */
  it('跨月的那一周把「本月比本周少」答完了：本周起点在上个月，本月在这个月 1 号', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 10, 3), minutes: 25 }])], { now: local(2026, 10, 3, 12) });
    expect(cellLine('本周')).toMatch(/^本周9月/);
    expect(cellLine('本月')).toMatch(/^本月10月1日/);
  });

  /** 上限截到今天：那一天（这周的周日）还没过完，一条记录也落不进去。 */
  it('范围不写到还没到的那天', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 10, 3), minutes: 25 }])], { now: local(2026, 10, 3, 12) });
    expect(cellLine('本周')).not.toMatch(/10月4日/);
  });

  /** 「本周」的窗口跟着 `Settings.weekStart` 挪，跟那个数字同源（`focusStats.test.ts`
   *  里钉的是数字这一头，两头痛一起才说明是同一批边界）。 */
  it('周首设置一改，窗口起点跟着挪', () => {
    const s = [withSessions('a', [{ startedAt: iso(2026, 8, 26), minutes: 25 }])];
    const first = show(s, { now: local(2026, 8, 26, 12) });
    expect(cellLine('本周')).toBe('本周8月24日–26日');
    first.unmount();   // 不拆掉上一份，第二次渲染会让 getByText('本周') 撞到两个
    show(s, { now: local(2026, 8, 26, 12), weekStart: 0 });
    expect(cellLine('本周')).toBe('本周8月23日–26日');
  });

  /** 跨年的那一周补上年份：不补的话「12月28日–1月2日」看着像把日期写反了。 */
  it('跨年写年份', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 1, 2), minutes: 25 }])], { now: local(2026, 1, 2, 12) });
    expect(cellLine('本周')).toBe('本周2025年12月29日–1月2日');
    expect(cellLine('今天')).toBe('今天1月2日');
  });

  it('趋势图十四根柱子，一天一根——没有记录的那天也有槽位', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    // 限定在这一张图里数：页面上还有一张 24 根柱子的「一天里的分布」，
    // 两张有意用同一套柱子样式，按 class 满页数会把两份加在一起。
    const trend = screen.getByRole('group', { name: '最近两周的趋势' });
    expect(trend.querySelectorAll('.ink-fstat-bar-slot')).toHaveLength(14);
  });

  it('柱子带可访问名，不只有 title——title 在有内容的元素上不会成为可访问名', () => {
    show([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    expect(screen.getByLabelText('2026-08-19 25 分钟')).toBeTruthy();
  });

  it('排行榜按分钟排，显示时长和次数', () => {
    show([
      withSessions('少的', [{ startedAt: iso(2026, 8, 19), minutes: 10 }]),
      withSessions('多的', [{ startedAt: iso(2026, 8, 19), minutes: 90 }]),
    ]);
    // 三张表（按类别 / 按任务 / 最近记录）用的是同一套行样式，各自报名字，
    // 按名字取那一份——原来靠 `.slice(0, 2)` 数位置，前面一多出一张表就错。
    const rank = screen.getByRole('list', { name: '按任务的排行' });
    const names = [...rank.querySelectorAll('.ink-fstat-rank-name')];
    expect(names.map((el) => el.textContent)).toEqual(['多的', '少的']);
    // 每一行都带着全文 `title`：这一行刻意不折行（换行会让排行扫下来是锯齿，
    // 理由写在 theme.css 那条注释里），省略号只解决「不撑破」，不解决「那是
    // 哪一条」——实测 390 上这里原来是「截了没兜底」。
    for (const el of names) expect(el.getAttribute('title')).toBe(el.textContent);
    expect(screen.getAllByText('1 小时 30 分').length).toBeGreaterThan(0);
  });

  it('年度热力图在——跟两周柱状图回答的不是同一个问题（这一年的形状 vs 最近怎么样）', () => {
    const { container } = show([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    expect(container.querySelector('.ink-heat-grid')).not.toBeNull();
    expect(screen.getByLabelText(/这一年的专注热力图/)).toBeTruthy();
  });

  it('排行榜截断了要说出来——看起来是全部、其实只有前十，会让人以为时间只花在这十件事上', () => {
    show(Array.from({ length: 12 }, (_, i) =>
      withSessions(`t${i}`, [{ startedAt: iso(2026, 8, 19), minutes: i + 1 }])));
    expect(screen.getByText(/另外还有 2 条/)).toBeTruthy();
  });

  it('刚好十条时不出那句话', () => {
    show(Array.from({ length: 10 }, (_, i) =>
      withSessions(`t${i}`, [{ startedAt: iso(2026, 8, 19), minutes: i + 1 }])));
    expect(screen.queryByText(/另外还有/)).toBeNull();
  });
});

/**
 * 补记 / 删记录（仿滴答清单的「补记专注记录」「删除专注记录」）。
 * 算什么在 `lib/focusStats.test.ts`，这里只测接线。
 */
describe('FocusStats：补记', () => {
  it('不给 onPatch 就整块不渲染——一个点了没反应的表单比没有更糟', () => {
    showReadonly([withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }])]);
    expect(screen.queryByLabelText('补记到哪条任务')).toBeNull();
  });

  it('一条记录都没有时补记入口照样在——那正是这个功能最典型的用法', () => {
    show([task({ id: 'a', title: '写周报' })]);
    expect(screen.getByLabelText('补记到哪条任务')).toBeTruthy();
  });

  it('没选任务 / 没填时长时「补记」是禁用的，不发一条编出来的记录', () => {
    show([task({ id: 'a', title: '写周报' })]);
    expect(btn('补记')!.hasAttribute('disabled')).toBe(true);
  });

  it('填全之后补记，发的是追加那一条的 patch', () => {
    const { onPatch } = show([task({ id: 'a', title: '写周报' })]);
    fireEvent.change(screen.getByLabelText('补记到哪条任务'), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('专注了多少分钟'), { target: { value: '40' } });
    fireEvent.click(btn('补记')!);
    expect(onPatch).toHaveBeenCalledWith('a', expect.objectContaining({
      focusSessions: [expect.objectContaining({ minutes: 40 })],
    }));
  });

  it('记录列表上每条都能删——补记必须配一张删得掉的列表，不然是单向门', () => {
    const { onPatch } = show([withSessions('写周报', [{ startedAt: iso(2026, 8, 19, 14), minutes: 25 }])]);
    const del = screen.getAllByRole('button')
      .find((b) => b.getAttribute('aria-label')?.startsWith('删掉「写周报」'))!;
    fireEvent.click(del);
    expect(onPatch).toHaveBeenCalledWith('写周报', { focusSessions: [] });
  });
});

/**
 * 另外两种切法（仿滴答清单「专注时间分布」和「专注时长分布」）。**算什么在
 * `lib/focusStats.test.ts`**，这里只测接线：摆出来了没、那两句解释在不在。
 */
describe('FocusStats：什么时候专注 / 花在哪一类上', () => {
  const LISTS = [{ id: 'L1', name: '工作' }];
  const at = (h: number, m = 25) => ({ startedAt: iso(2026, 8, 19, h), minutes: m });

  const showWith = (tasks: Task[]) =>
    render(<AntApp><FocusStats tasks={tasks} lists={LISTS} now={NOW} /></AntApp>);

  it('一天二十四根柱子，跟两周那张分得开', () => {
    showWith([withSessions('a', [at(14)])]);
    const hours = screen.getByRole('group', { name: '一天里的分布' });
    expect(hours.querySelectorAll('.ink-fstat-bar-slot')).toHaveLength(24);
  });

  it('**说「记录最多的是」，不说「你最擅长在」**——数据说得出前者，说不出后者', () => {
    showWith([withSessions('a', [at(14)])]);
    expect(screen.getByText(/记录最多的是 14:00–15:00/)).toBeTruthy();
  });

  it('有清单时默认按清单分，列出清单名', () => {
    showWith([withSessions('a', [at(14)], { listId: 'L1' })]);
    const rank = screen.getByRole('list', { name: '按类别的分布' });
    expect(within(rank).getByText('工作')).toBeTruthy();
  });

  it('切到按标签，列出标签名，**并且把「加起来会超过总数」说出来**', () => {
    showWith([withSessions('a', [at(14)], { tags: ['写作', '紧急'] })]);
    fireEvent.change(screen.getByLabelText('分布按什么分'), { target: { value: 'tag' } });
    const rank = screen.getByRole('list', { name: '按类别的分布' });
    expect(within(rank).getByText('写作')).toBeTruthy();
    expect(screen.getByText(/各项加起来会比总时长多/)).toBeTruthy();
  });

  it('按清单那一档不出那句话——一条任务只在一个清单里，那是真的划分', () => {
    showWith([withSessions('a', [at(14)], { listId: 'L1' })]);
    expect(screen.queryByText(/各项加起来会比总时长多/)).toBeNull();
  });

  it('不给 lists 时只剩「按标签」可选——一份全是裸 uuid 的分布不如不显示', () => {
    render(<AntApp><FocusStats tasks={[withSessions('a', [at(14)], { listId: 'L1' })]} now={NOW} /></AntApp>);
    const sel = screen.getByLabelText('分布按什么分') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['tag']);
  });
});

/**
 * 点任务名跳回那条任务。补的是一处「看得见、够不着」：这一屏告诉你「这三小时
 * 花在『写周报』上」，而那条任务在这儿点不开——得自己记住标题，切到别的视图
 * 再找一遍。跟习惯页那颗、「回顾」里点关联任务是同一个动作。
 */
describe('FocusStats：点任务名跳回去', () => {
  const rows = [withSessions('写周报', [{ startedAt: iso(2026, 8, 19), minutes: 90 }])];

  it('排行榜里的名字是可点的，带上那条任务的 id', () => {
    const onOpen = vi.fn();
    render(<AntApp><FocusStats tasks={rows} now={NOW} onOpen={onOpen} /></AntApp>);
    const rank = screen.getByRole('list', { name: '按任务的排行' });
    const name = within(rank).getByRole('button', { name: '写周报' });
    // 可点那支是另一个元素（`RankName` 分 button / span 两支），`title` 得各自
    // 钉一遍——只测 span 那一支的话，按钮这半边的 title 删掉也没人红。
    expect(name.getAttribute('title')).toBe('写周报');
    fireEvent.click(name);
    expect(onOpen).toHaveBeenCalledWith('写周报');
  });

  it('最近的记录那张表里也能点', () => {
    const onOpen = vi.fn();
    render(<AntApp><FocusStats tasks={rows} now={NOW} onOpen={onOpen} /></AntApp>);
    const recent = screen.getByRole('list', { name: '最近的专注记录' });
    fireEvent.click(within(recent).getByRole('button', { name: '写周报' }));
    expect(onOpen).toHaveBeenCalledWith('写周报');
  });

  it('**按类别那张不能点**——一个标签没有「那条任务」可跳', () => {
    const onOpen = vi.fn();
    render(<AntApp><FocusStats tasks={[withSessions('a', [{ startedAt: iso(2026, 8, 19), minutes: 25 }], { tags: ['写作'] })]} now={NOW} onOpen={onOpen} /></AntApp>);
    const rank = screen.getByRole('list', { name: '按类别的分布' });
    expect(within(rank).queryByRole('button', { name: '写作' })).toBeNull();
    // 类别名（清单/标签/情境）跟任务标题一样不受控，同一份兜底挂上。
    expect(within(rank).getByText('写作').getAttribute('title')).toBe('写作');
  });

  it('不给 onOpen 就还是一行字——点了没反应的入口比没有更糟', () => {
    render(<AntApp><FocusStats tasks={rows} now={NOW} /></AntApp>);
    const rank = screen.getByRole('list', { name: '按任务的排行' });
    expect(within(rank).queryByRole('button', { name: '写周报' })).toBeNull();
    expect(within(rank).getByText('写周报')).toBeTruthy();
  });
});
