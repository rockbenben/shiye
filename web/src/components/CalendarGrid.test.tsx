import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CalendarGrid } from './CalendarGrid.js';
import { calendarDays, type CalDay, type CalMode } from '../lib/calendar.js';

// 跟 calendar.test.ts（Task 2）同一个锚点：2026-08-16 是周日，月视图的头尾
// 补齐（7/27 起，outside）已经被那份测试钉死，这里直接复用同一个锚点，不用
// 重新验证 calendarDays 本身对不对——那是 Task 2 的事，这里只测组件怎么画它。
const ANCHOR = new Date(2026, 7, 16, 12, 0, 0);
const MONTH_DAYS = calendarDays([], ANCHOR, 'month');

// task-5：月视图正文（格子网格本身——42 格、今天/选中标记、格子里的标题、
// 拖到某一天改期）换成了 FullCalendar（CalendarFull.tsx），那部分的测试
// 整体搬到 CalendarFull.test.tsx 了，不在这个文件里重复。CalendarGrid.tsx
// 现在只剩三档共用的导航行（翻页/三个模式按钮/标题）和「月视图接
// CalendarFull、周日视图接调用方给的 children」这个路由决定，这个文件
// 只测这两半。

const setup = (over: Partial<{
  days: CalDay[]; mode: CalMode; anchor: Date; now: Date; selectedKey: string | null;
  onSelectDay: (key: string) => void; onShift: (delta: -1 | 1) => void; onToday: () => void;
  onModeChange: (m: CalMode) => void; onDropOnDay: (taskId: string, dayKey: string) => void;
  children: ReactNode;
}> = {}) => {
  const onSelectDay = vi.fn();
  const onShift = vi.fn();
  const onToday = vi.fn();
  const onModeChange = vi.fn();
  const props = {
    days: MONTH_DAYS, mode: 'month' as CalMode, anchor: ANCHOR, now: ANCHOR, selectedKey: null,
    onSelectDay, onShift, onToday, onModeChange, ...over,
  };
  const { container } = render(<CalendarGrid {...props} />);
  return { container, onSelectDay, onShift, onToday, onModeChange, days: props.days };
};

describe('CalendarGrid：导航行', () => {
  it('上一页/下一页分别调用 onShift(-1)/(1)', () => {
    const { onShift } = setup();
    fireEvent.click(screen.getByRole('button', { name: '上一页' }));
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(onShift).toHaveBeenNthCalledWith(1, -1);
    expect(onShift).toHaveBeenNthCalledWith(2, 1);
  });

  // 「今天」是翻走之后回到当前那一页的唯一可见入口（以前只能切到别的视图再
  // 切回来，靠 calendar 不在 keepMounted 名单里、重挂时 anchor 重置成 now）。
  // 名字是「今天」而不是「回到今天」：三档共用一颗按钮，月视图下它回的是
  // 本月、日视图下回的是今天，「今天」两个字在三档里都读得通。
  it('点「今天」调用 onToday，不动 onShift', () => {
    const { onToday, onShift } = setup();
    fireEvent.click(screen.getByRole('button', { name: '今天' }));
    expect(onToday).toHaveBeenCalledTimes(1);
    expect(onShift).not.toHaveBeenCalled();
  });

  // 修复轮 1 · C-2：每一档各自单独断言，不是只测「周」「日」漏了「月」——
  // `setup()` 默认就在月模式，以前从没有测试真的选过「月」这一档，
  // `onModeChange('month')` 手滑写成别的值不会被任何测试挡住。
  //
  // **三颗按钮换成了一个下拉**（档数从三档长到五档，照滴答清单改的），
  // 断言跟着从「点第几颗」换成「把 select 的值改成哪一档」——测的还是
  // 同一件事：每一档都真的把自己那个字符串交出去了。
  it('每一档都把自己那个 key 交给 onModeChange，五档一个不漏', () => {
    const { onModeChange } = setup();
    const sel = screen.getByLabelText('看哪一档');
    for (const [i, m] of (['day', 'week', 'month', 'year', 'agenda'] as const).entries()) {
      fireEvent.change(sel, { target: { value: m } });
      expect(onModeChange).toHaveBeenNthCalledWith(i + 1, m);
    }
  });
});

// task-3：三档切换——CalendarGrid 只管三档共用的导航行（翻页/三个模式按钮/
// 标题）和「月视图接哪个组件」这个路由决定；周/日两档的正文由调用方
// （CalendarView）通过 children 传进来，这个组件自己不认识 CalendarHours。
describe('CalendarGrid：三档切换（导航行 + 正文哪个组件）', () => {
  // **`aria-pressed` 那一组断言随三颗按钮一起退役**：现在是一个 `<select>`，
  // 「当前在哪一档」由它自己的 `value` 表达（原生控件自带的语义，读屏也照读），
  // 不再需要一个手挂的 aria 属性。测的还是同一件事：每一档下屏幕上都能看出
  // 「现在在这一档」。
  it('每一档下那个下拉的值就是当前档——五档一个不漏', () => {
    for (const m of ['month', 'week', 'day', 'year', 'agenda'] as const) {
      document.body.innerHTML = '';
      setup({ mode: m, days: calendarDays([], ANCHOR, m) });
      expect((screen.getByLabelText('看哪一档') as HTMLSelectElement).value, m).toBe(m);
    }
  });

  it('标题文案：月「YYYY年M月」，周「M月D日 - M月D日」（来自 days 的首尾），日「M月D日 周X」', () => {
    // ANCHOR 是 2026-08-16（周日）。
    const { container: monthC } = setup({ mode: 'month' });
    expect(monthC.querySelector('.ink-cal-heading')!.textContent).toBe('2026年8月');

    const weekDays = calendarDays([], ANCHOR, 'week'); // 8/10（周一）- 8/16（周日）
    const { container: weekC } = setup({ mode: 'week', days: weekDays });
    expect(weekC.querySelector('.ink-cal-heading')!.textContent).toBe('8月10日 - 8月16日');

    const dayDays = calendarDays([], ANCHOR, 'day');
    const { container: dayC } = setup({ mode: 'day', days: dayDays });
    expect(dayC.querySelector('.ink-cal-heading')!.textContent).toBe('8月16日 周日');
  });

  // 修复轮 1 · I-1：上面那条的三个周夹具（8/10-16、8/17-23、8/24-30）全是
  // 同月，起止月份永远相等——把 `headingText` 的周档改成
  // `- ${first.getMonth() + 1}月${last.getDate()}日`（用 first 的月份、last
  // 的日号，把「取哪个月份」的分支写错）374/374 照样全绿，这份夹具测不出来。
  // 补跨月（8/31 周一 - 9/6 周日）和跨年（12/28 周一 - 1/3 周日）各一条，
  // 起止月份/年份都不相等才会露馅。
  it('标题文案：周档跨月/跨年——起止月份不相等时才测得出「取错了哪一头的月份」', () => {
    // 2026-09-02 是周三，mondayOf 落在 8/31（周一），周日是 9/6——跨月不跨年。
    const crossMonthAnchor = new Date(2026, 8, 2, 12, 0, 0);
    const crossMonthDays = calendarDays([], crossMonthAnchor, 'week');
    const { container: crossMonthC } = setup({ mode: 'week', anchor: crossMonthAnchor, days: crossMonthDays });
    expect(crossMonthC.querySelector('.ink-cal-heading')!.textContent).toBe('8月31日 - 9月6日');

    // 2026-12-30 是周三，mondayOf 落在 12/28（周一），周日是 2027-1-3——跨年。
    const crossYearAnchor = new Date(2026, 11, 30, 12, 0, 0);
    const crossYearDays = calendarDays([], crossYearAnchor, 'week');
    const { container: crossYearC } = setup({ mode: 'week', anchor: crossYearAnchor, days: crossYearDays });
    expect(crossYearC.querySelector('.ink-cal-heading')!.textContent).toBe('12月28日 - 1月3日');
  });

  // 上限方向：周/日视图不能出现月格的任何一部分（星期表头 + CalendarFull
  // 的月格网格），不是「有 children 就行」——星期表头也是月格独有的东西。
  // 月视图这一半反过来钉住：忽略 children，画的是 CalendarFull（用它渲染出
  // 来的 FullCalendar 根节点 .fc 当标记，具体格子长什么样是 CalendarFull.
  // test.tsx 的事，这里只关心「路由对不对」）。
  it('月视图忽略 children，画星期表头 + CalendarFull；周/日视图不画月格，画调用方给的 children', () => {
    const marker = <div data-testid="hours-marker">小时格正文</div>;

    const { container: monthC } = setup({ mode: 'month', children: marker });
    expect(monthC.querySelector('.ink-cal-weekdays')).not.toBeNull();
    expect(monthC.querySelector('.fc')).not.toBeNull();
    expect(monthC.querySelector('[data-testid="hours-marker"]')).toBeNull();

    const weekDays = calendarDays([], ANCHOR, 'week');
    const { container: weekC } = setup({ mode: 'week', days: weekDays, children: marker });
    expect(weekC.querySelector('.ink-cal-weekdays')).toBeNull();
    expect(weekC.querySelector('.fc')).toBeNull();
    expect(weekC.querySelector('[data-testid="hours-marker"]')).not.toBeNull();

    const dayDays = calendarDays([], ANCHOR, 'day');
    const { container: dayC } = setup({ mode: 'day', days: dayDays, children: marker });
    expect(dayC.querySelector('.ink-cal-weekdays')).toBeNull();
    expect(dayC.querySelector('.fc')).toBeNull();
    expect(dayC.querySelector('[data-testid="hours-marker"]')).not.toBeNull();
  });

  it('星期表头从「一」到「日」——月视图自己画的那部分没有跟着 CalendarFull 一起搬走', () => {
    const { container } = setup({ mode: 'month' });
    const heads = [...container.querySelectorAll('.ink-cal-weekday')].map((e) => e.textContent);
    // 全量核对顺序，不是只看第一个——「从一开始」不能只测头，漏了尾巴
    // 换成「一二三四五六七」这种错误顺序也测不出来。
    expect(heads).toEqual(['一', '二', '三', '四', '五', '六', '日']);
  });

  it('月视图把 days/now/selectedKey/onSelectDay/onDropOnDay 转发给 CalendarFull——用「点某一天会调用 onSelectDay」这个可观察行为验证转发链路真的接上了，不是断言内部 props（CalendarFull 自己的交互细节在 CalendarFull.test.tsx 里）', async () => {
    const onSelectDay = vi.fn();
    const { container } = setup({ mode: 'month', onSelectDay });
    // FullCalendar 的键盘路径（Enter/Space 选中）不依赖假布局/指针交互引擎，
    // 用这条最省事地确认 CalendarGrid → CalendarFull 的 onSelectDay 转发
    // 是通的——真正测 FullCalendar 交互本身的覆盖面在 CalendarFull.test.tsx。
    const cell = container.querySelector('.fc-daygrid-day')!;
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(onSelectDay).toHaveBeenCalledTimes(1);
    expect(onSelectDay).toHaveBeenCalledWith(MONTH_DAYS[0].key);
  });
});

/**
 * 顶上那一行照滴答清单重排了：**左边大标题，右边一串控件**（档位下拉 +
 * 翻页那一组 + 安排任务）。原来是七颗一样重的按钮挤在一起、标题混在中间。
 */
describe('CalendarGrid：顶上那一行', () => {
  const show = (over: Partial<Parameters<typeof CalendarGrid>[0]> = {}) => render(
    <CalendarGrid
      days={calendarDays([], new Date(2026, 7, 25), 'month')}
      mode="month"
      anchor={new Date(2026, 7, 25)}
      now={new Date(2026, 7, 25, 12)}
      selectedKey={null}
      onSelectDay={() => {}}
      onShift={() => {}}
      onToday={() => {}}
      onModeChange={() => {}}
      {...over}
    />,
  );

  it('**档位是一个下拉，不是一排按钮**——档数从三档长到五档之后，一排按钮已经比标题还长', () => {
    show();
    const sel = screen.getByLabelText('看哪一档') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['日', '周', '月', '年', '日程']);
    expect(sel.value).toBe('month');
  });

  it('换一档把新的档交出去', () => {
    const onModeChange = vi.fn();
    show({ onModeChange });
    fireEvent.change(screen.getByLabelText('看哪一档'), { target: { value: 'year' } });
    expect(onModeChange).toHaveBeenCalledWith('year');
  });

  it('翻页那三颗连成一组，各自有说得出口的名字——「‹」「›」光看字形读屏读不出方向', () => {
    show();
    const group = screen.getByRole('group', { name: '翻页' });
    expect(within(group).getByRole('button', { name: '上一页' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: '今天' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: '下一页' })).toBeTruthy();
  });

  it('标题是这一行的主角，用 heading 不用一段裸文字——它就是这一屏在说的那件事', () => {
    show();
    expect(screen.getByRole('heading', { name: '2026年8月' })).toBeTruthy();
  });

  it('各档标题：月/日程报「YYYY年M月」，年报「YYYY年」', () => {
    const anchor = new Date(2026, 7, 25);
    show({ mode: 'agenda', days: calendarDays([], anchor, 'agenda') });
    expect(screen.getByRole('heading', { name: '2026年8月' })).toBeTruthy();
    document.body.innerHTML = '';
    show({ mode: 'year', days: calendarDays([], anchor, 'year') });
    expect(screen.getByRole('heading', { name: '2026年' })).toBeTruthy();
  });
});
