import { describe, it, expect, vi } from 'vitest';
import { App as AntApp, ConfigProvider } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '../types.js';
import dayjs from 'dayjs';
import { TaskComposer } from './TaskComposer.js';
import { DATETIME_FORMAT } from './TaskFields.js';
import { ink, theme as appTheme } from '../theme.js';
import { addField } from '../test-utils.js';

// 按中文找按钮先去空白：孤立渲染时没有 main.tsx 那层 autoInsertSpace: false，
// antd 仍会给两字按钮插空格。跟 InboxComposer.test.tsx 同一条防御写法。
const byText = (text: string) => screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === text);

// 「今天」的成员资格按本地日历日算，所以这里不能用固定的 UTC 'Z' 时间戳——
// 那样测试结果会跟着跑测试的机器时区飘。NOW 和 due 都走本地语义，
// 跟 lib/taskView.test.ts 里 LOCAL_NOW / localIso 同一套写法。
const NOW = new Date(2026, 7, 12, 12, 0, 0);
const localIso = (y: number, m: number, d: number, h = 0, mi = 0): string => new Date(y, m - 1, d, h, mi).toISOString();

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', title: '买牛奶', notes: '', status: 'todo',
  due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), order: null,
  listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...over,
});

function setup(props: Partial<React.ComponentProps<typeof TaskComposer>> = {}) {
  const onCreate = props.onCreate ?? vi.fn().mockResolvedValue(task());
  const onClose = props.onClose ?? vi.fn();
  render(
    <AntApp>
      <TaskComposer view="today" boardFilter="all" now={NOW} lists={[]} onCreate={onCreate} onClose={onClose} {...props} />
    </AntApp>,
  );
  return { onCreate, onClose };
}

describe('TaskComposer：手工建任务', () => {
  it('把填的四个字段原样交给 onCreate', async () => {
    const { onCreate } = setup();

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '  买牛奶  ' } });
    fireEvent.change(screen.getByPlaceholderText(/^备注/), { target: { value: '低脂的' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: '买牛奶', notes: '低脂的', due: null, startAt: null, endAt: null, reminders: [] }),
    ));
  });

  it('标题框里回车直接建——这个表单一展开光标就在标题框里，键盘那条路只差这最后一下（仿滴答清单）', async () => {
    const { onCreate } = setup();

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '买牛奶' } });
    fireEvent.keyDown(screen.getByPlaceholderText('标题'), { key: 'Enter' });

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: '买牛奶' })));
  });

  it('Esc 关掉表单，跟旁边那颗「取消」同一个动作', () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByPlaceholderText('标题'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('标题空着时回车什么都不发——跟「添加」按钮禁用是同一条判断（submit 自己挡），不是两套', () => {
    const { onCreate } = setup();
    fireEvent.keyDown(screen.getByPlaceholderText('标题'), { key: 'Enter' });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('标题空着时按钮是禁用的——不发一条注定被服务端 400 的请求', () => {
    const { onCreate } = setup();

    // 这个仓库没装 jest-dom，断言 disabled 一律走原生属性，跟 InboxSidebar.test.tsx 一致。
    expect(byText('添加')!.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '   ' } });
    expect(byText('添加')!.hasAttribute('disabled')).toBe(true);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('成功之后收起表单', async () => {
    const { onClose } = setup();

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '买牛奶' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // 这个仓库栽过五次的那一类 bug：写成功了，界面看上去什么也没发生。
  it('在「今天」里建了一条不会出现在「今天」的任务，要说清楚它去哪了', async () => {
    setup({ onCreate: vi.fn().mockResolvedValue(task({ due: null, startAt: null, endAt: null, reminders: [] })) });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '以后再说的事' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(screen.getByText(/在「按来源」里/)).toBeTruthy());
  });

  it('这条确实会进「今天」时，不要多此一举地解释', async () => {
    const 今天到期 = task({ due: localIso(2026, 8, 12, 18, 0) });
    setup({ onCreate: vi.fn().mockResolvedValue(今天到期) });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '今天要做的' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(screen.getByText('已添加')).toBeTruthy());
    expect(screen.queryByText(/在「按来源」里/)).toBeNull();
  });

  // TaskComposer 跟卡片编辑态共用同一份 TaskFields（见 TaskFields.tsx 顶部
  // 注释）——理论上加一个字段两边自动都有，但这是「理论上」，Task 1 的 brief
  // 明确要求跑一遍确认，不能假设共用组件就自动生效。
  it('新建表单里也有优先级三档按钮，选中的值原样交给 onCreate', async () => {
    const { onCreate } = setup();

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '买牛奶' } });
    addField('优先级');
    fireEvent.click(screen.getByRole('button', { name: '高' }));
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 3 }),
    ));
  });

  it('创建失败时表单和草稿都留着，不能把用户刚打的字弄丢', async () => {
    const { onClose } = setup({ onCreate: vi.fn().mockRejectedValue(new Error('磁盘满了')) });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '别弄丢我' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(screen.getByText('磁盘满了')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText('标题') as HTMLInputElement).value).toBe('别弄丢我');
  });
});

/**
 * 任务默认值（仿滴答清单「设置 → 更多设置 → 任务默认值」）：新表单打开时
 * 预填的清单和优先级。
 */
describe('TaskComposer：任务默认值', () => {
  const LISTS = [
    { id: 'L1', name: '工作', color: '#000', folderId: null, order: 0, archived: false, filter: null },
    { id: 'GONE', name: '归档了的', color: '#000', folderId: null, order: 1, archived: true, filter: null },
  ];

  it('不传 defaults 就什么都不预填——读不到设置时不该编一份出来', async () => {
    const { onCreate } = setup();
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '买牛奶' } });
    fireEvent.click(byText('添加')!);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ listId: null, priority: 0 }),
    ));
  });

  it('预填的清单和优先级会跟着任务一起交出去', async () => {
    const { onCreate } = setup({ lists: LISTS, defaults: { listId: 'L1', priority: 2 } });
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '买牛奶' } });
    fireEvent.click(byText('添加')!);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ listId: 'L1', priority: 2 }),
    ));
  });

  it('预填的清单已经不存在（删了）就当没设——不然存下去这条任务在导航里哪儿都找不到', async () => {
    const { onCreate } = setup({ lists: LISTS, defaults: { listId: '删掉了', priority: 0 } });
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '买牛奶' } });
    fireEvent.click(byText('添加')!);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ listId: null })));
  });

  it('预填的清单已归档也当没设——归档的清单不在下拉候选里，界面会跟数据自相矛盾', async () => {
    const { onCreate } = setup({ lists: LISTS, defaults: { listId: 'GONE', priority: 0 } });
    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '买牛奶' } });
    fireEvent.click(byText('添加')!);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ listId: null })));
  });

  it('预填之后用户改回「不属于任何清单」，不会被下一次渲染推回去', () => {
    setup({ lists: LISTS, defaults: { listId: 'L1', priority: 0 } });
    const select = screen.getByLabelText('归到哪个清单') as HTMLSelectElement;
    expect(select.value).toBe('L1');
    fireEvent.change(select, { target: { value: '' } });
    expect((screen.getByLabelText('归到哪个清单') as HTMLSelectElement).value).toBe('');
  });
});

/**
 * 智能识别（仿滴答清单）。**判据本身在 `lib/smartInput.test.ts` 里测**——
 * 那边 43 条覆盖「明天下午两点」「每周一」「#标签」这些认法；这里只测接线：
 * 提示条出不出、认走的东西有没有真的进 onCreate、「取消识别」管不管用、
 * 手填过的字段会不会被识别覆盖掉。两边不重复同一批用例。
 */
/**
 * 切去处的时候 App 那条 `[view, query, filter, boardFilter]` 清理会把这张表单
 * 关掉（组件卸载），而草稿活在它自己的 `useState` 里——不接住的话切一下侧栏
 * 就把刚打的标题吃掉。接住它的是 `lib/draftStash.ts`（那边管卡片编辑态，
 * 这儿用键 `'new-task'`）。
 */
describe('TaskComposer：切走再回来，草稿不该被吃掉', () => {
  const open = (props: Partial<React.ComponentProps<typeof TaskComposer>> = {}) => render(
    <AntApp>
      <TaskComposer view="today" boardFilter="all" now={NOW} lists={[]} onCreate={vi.fn()} onClose={vi.fn()} {...props} />
    </AntApp>,
  );
  const titleValue = () => (screen.getByPlaceholderText('标题') as HTMLInputElement).value;
  const typeTitle = (v: string) => fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: v } });
  /** 日期那一格收起时把值写在行上（「截止 8月25日 23:59」），第一行就是它。 */
  const dateRow = () => (document.querySelector('.ink-frow') as HTMLElement).textContent ?? '';

  it('卸载（切去处）之后重新打开：刚打的标题还在', () => {
    const first = open();
    typeTitle('写季度报表');
    first.unmount();
    open();
    expect(titleValue()).toBe('写季度报表');
  });

  it('按「取消」之后再打开：不恢复——那是他明确说过「这条不建了」', () => {
    const first = open();
    typeTitle('写季度报表');
    fireEvent.click(byText('取消')!);
    first.unmount();
    open();
    expect(titleValue()).toBe('');
  });

  it('建好了之后不再恢复：下一次开表单不该凭空冒出已经变成任务的那份字', async () => {
    const onCreate = vi.fn().mockResolvedValue(task());
    const first = open({ onCreate });
    typeTitle('写季度报表');
    fireEvent.click(byText('添加')!);
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    first.unmount();
    open();
    expect(titleValue()).toBe('');
  });

  it('点了日历上某一天才开表单：那一天盖过草稿里的旧日期，但字留着', () => {
    const first = open({ defaults: { listId: null, priority: 0, due: localIso(2026, 8, 20, 23, 59) } });
    typeTitle('写季度报表');
    first.unmount();
    const day = localIso(2026, 8, 25, 23, 59);
    open({ defaults: { listId: null, priority: 0, due: day }, pinnedDue: day });
    expect(titleValue(), '文字是他打的，该还回来').toBe('写季度报表');
    expect(dateRow()).toContain('8月25日');
    expect(dateRow(), '「点了那天」是这一刻说的话，比草稿里的旧日期新').not.toContain('8月20日');
  });

  it('没有 pinnedDue 时不拿设置里的默认截止盖草稿：预填排在草稿后面（控件 > 标题 > 预填）', () => {
    const first = open({ defaults: { listId: null, priority: 0, due: localIso(2026, 8, 20, 23, 59) } });
    typeTitle('写季度报表');
    first.unmount();
    open({ defaults: { listId: null, priority: 0, due: localIso(2026, 8, 25, 23, 59) } });
    expect(dateRow(), '他动过手的那份草稿排在预填前面').toContain('8月20日');
  });

  it('一字未改就切走再开：这一次该套的预填照常套上', () => {
    // 挂载时那份初值本身就带着预填。原样存了再原样恢复，第二次打开拿到的
    // 是「上一次的初值」而不是「这一次的预填」——浏览器实测过这一条：日期那一格
    // 从「截止 10月3日 23:59」变成「未设置」。没动过手就没有值得留的东西。
    const first = open({ defaults: { listId: null, priority: 0, due: localIso(2026, 8, 20, 23, 59) } });
    first.unmount();
    open({ defaults: { listId: null, priority: 0, due: localIso(2026, 8, 25, 23, 59) } });
    expect(dateRow()).toContain('8月25日');
  });
});

describe('TaskComposer：智能识别', () => {
  const typeTitle = (v: string) => fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: v } });

  it('认出来的东西摆在提示条上，标题会变成什么也说清楚——认走的字会从标题里消失，事后才发现跟建错了没区别', () => {
    setup();
    typeTitle('明天下午两点交周报 #工作');
    const st = screen.getByRole('status');
    expect(st.textContent).toContain('#工作');
    // 原来这里断的是 `hits` 拼出来的那一句「明天 下午两点」——batch9 把「识别到什么」
    // 从一句话改成**一段一颗 chip**（要点某一段单独撤，见 SmartHint），于是
    // 「明天」和「下午两点」是两颗而不是一句里的两个词。断言跟着换成逐颗，
    // 覆盖比原来更细：连「哪几段各自成一颗」都钉住了。
    expect([...st.querySelectorAll('.ink-smart-chip')].map((e) => e.textContent)).toEqual(['明天', '下午两点', '#工作']);
    expect(st.textContent).toContain('交周报');
  });

  it('被读走的那几个字在提示条上**划掉**，不是只报一个结果标题', () => {
    setup();
    typeTitle('明天下午两点交周报 #工作');
    const st = screen.getByRole('status');
    expect([...st.querySelectorAll('.ink-smart-gone')].map((e) => e.textContent)).toEqual(['明天', '下午两点', '#工作']);
    expect(st.querySelector('.ink-smart-kept')).toBeNull();
    // 划掉之外，原话里没被读走的字要原样在那儿——不然这条只是把标题抄了一遍。
    expect(st.querySelector('.ink-smart-echo')?.textContent).toContain('交周报');
  });

  it('「认了但不摘」那一档不划掉，改成虚线：那几个字明明还在标题里', () => {
    setup({ defaults: { listId: null, priority: 0, smart: { stripDate: false } } });
    typeTitle('明天下午两点交周报');
    const st = screen.getByRole('status');
    expect(st.querySelectorAll('.ink-smart-gone').length).toBe(0);
    expect([...st.querySelectorAll('.ink-smart-kept')].map((e) => e.textContent)).toEqual(['明天', '下午两点']);
    expect(st.textContent).toContain('这几个字留在标题里');
  });

  it('什么都没认出来时不出提示条', () => {
    setup();
    typeTitle('把冰箱清一遍');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('提交时把认出来的东西一起交给 onCreate：标题去掉那几段，due/提醒/标签都填上', async () => {
    const { onCreate } = setup();
    typeTitle('明天下午两点交周报 #工作');
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: '交周报',
      due: localIso(2026, 8, 13, 14),
      // 认出了具体时刻就 due 和提醒一起写——只写 due 的任务到点只会变红不会响
      reminders: [localIso(2026, 8, 13, 14)],
      tags: ['工作'],
    })));
  });

  it('「取消识别」之后按原话建，一个字都不动', async () => {
    const { onCreate } = setup();
    typeTitle('明天下午两点交周报 #工作');
    fireEvent.click(byText('取消识别')!);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: '明天下午两点交周报 #工作', due: null, startAt: null, endAt: null, reminders: [], tags: [],
    })));
  });

  /**
   * 全局那颗「取消识别」管的是整句；这一条管**一段**。认错的常见形状是
   * 「一句里三个词认对了两个」——那时候要撤一个不该被迫三个全撤。
   * 走的是 `parseIgnoring`（遮字重解析），跟 QuickAdd 那边同一条判据，
   * 但这里的合并多一层「控件 > 标题 > 预填」，所以这张表单自己也要有一条证人。
   */
  it('点掉提示条上「明天」那颗：那几个字回到标题，「下午两点」照认（落今天 14:00）', async () => {
    const { onCreate } = setup();
    typeTitle('明天下午两点交周报 #工作');
    const chip = [...screen.getByRole('status').querySelectorAll('.ink-smart-chip')]
      .find((c) => c.textContent === '明天');
    fireEvent.click(chip!);
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: '明天交周报',
      due: localIso(2026, 8, 12, 14, 0),
      tags: ['工作'],
    })));
  });

  /**
   * batch9 I-5：屏幕上不许同时站着两个日期而只有一个有记号。
   * 原来预填的「截止 今天 23:59」一直写在日期那一行上，而按「添加」真的落
   * 句子里那个——行上那个值从头到尾不动（它动的是草稿，识别只动合并结果）。
   * 现在行显示合并后的那份并挂「识别」，编辑器里仍是空的。
   */
  it('日期那一行显示句子里认出来的那个日期，并挂「识别」；编辑器里仍是空的', () => {
    setup();
    typeTitle('明天下午三点交周报');
    const row = document.querySelector('.ink-frow') as HTMLElement;
    expect(row.textContent).toContain('截止 8月13日 15:00');
    expect(row.querySelector('.ink-frow-smart')?.textContent).toBe('识别');
    fireEvent.click(row);
    expect((screen.getByLabelText('截止') as HTMLInputElement).value, '点开之后里面该是空的——那是没挑过的意思').toBe('');
  });

  it('没打字时行上写的就是草稿那份，没有「识别」', () => {
    setup();
    const row = document.querySelector('.ink-frow') as HTMLElement;
    expect(row.querySelector('.ink-frow-smart')).toBeNull();
  });
  it('取消过之后再打字也不会自己回来——他明确说过的「别认」不该被一个字的输入撤销', () => {
    setup();
    typeTitle('明天开会');
    fireEvent.click(byText('取消识别')!);
    typeTitle('明天下午两点开会');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('手填过的截止时间不会被识别覆盖——落到控件上的那次表达更明确', async () => {
    const { onCreate } = setup();
    typeTitle('明天下午两点交周报');
    // DatePicker 直接打字比模拟点日历稳，跟别处一样走 change + Enter。
    // 打进去的字要跟控件的 `format` 对得上（`TaskFields.DATETIME_FORMAT`，
    // 到分不到秒）——多打一个 `:00`，antd 解析不出来，这一次 change 被当成
    // 没输入，`onCreate` 里就没有 due，测试在 waitFor 里干等到超时。
    const picker = screen.getByPlaceholderText('截止时间');
    fireEvent.change(picker, { target: { value: dayjs(localIso(2026, 9, 1, 8)).format(DATETIME_FORMAT) } });
    fireEvent.keyDown(picker, { key: 'Enter' });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: '交周报',
      due: localIso(2026, 9, 1, 8),
    })));
  });
});

// final-review.md I3：这个表单从来没被任何一层 boardLocalTheme 盖住过——
// 跟 TaskCard.test.tsx 那组「编辑态的 DatePicker 不能是群青」同一个盲区、
// 同一个手法，外层套 appTheme（main.tsx 真正在用的那份全局主题）模拟真实
// 场景，读 antd 6 挂在 `.ant-picker` 根节点上的 --ant-color-primary。
describe('TaskComposer：DatePicker 不能是群青（I3，final-review.md）', () => {
  it('截止/提醒两个 DatePicker 读到的 --ant-color-primary 都是你的墨，不是群青', () => {
    const { container } = render(
      <ConfigProvider theme={appTheme}>
        <AntApp>
          <TaskComposer view="today" boardFilter="all" now={NOW} lists={[]} onCreate={vi.fn()} onClose={vi.fn()} />
        </AntApp>
      </ConfigProvider>,
    );
    const pickers = container.querySelectorAll('.ant-picker');
    expect(pickers).toHaveLength(3);   // 开始 + 截止 + 提醒（「开始时间」是后加的，仿 OmniFocus 的 Defer Date）
    pickers.forEach((p) => {
      const primary = getComputedStyle(p as HTMLElement).getPropertyValue('--ant-color-primary').trim().toLowerCase();
      expect(primary).toBe(ink.you.toLowerCase());
      expect(primary).not.toBe(ink.ai.toLowerCase());
    });
  });
});

/**
 * 打开时预填的截止日期（日历上的「在这天新建」把日期带过来）。跟
 * `listId`/`priority` 那两个「任务默认值」不是一回事：那两个是设置里的长期
 * 偏好，这个是**这一次**打开的上下文。
 */
describe('TaskComposer：预填截止日期', () => {
  const DUE = new Date(2026, 7, 18, 23, 59).toISOString();

  it('带进来就预填，建出来的任务带着那个日期', async () => {
    const { onCreate } = setup({ defaults: { listId: null, priority: 0, due: DUE } });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '去看房' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ due: DUE })));
  });

  it('不带就还是空的——顶上那个「新任务」不该带着上回在日历里点的那天', () => {
    setup({ defaults: { listId: null, priority: 0 } });
    expect((screen.getByPlaceholderText('截止时间') as HTMLInputElement).value).toBe('');
  });
});

/**
 * 在清单/标签那个去处里新建。**这两个去处以前建完之后这一屏一点变化都没有**
 * ——任务按设置里的默认清单走（多半是「不属于任何清单」），跟建失败长得一模
 * 一样，而那正是 `report()` 存在的理由。
 */
describe('TaskComposer：在当前去处里新建', () => {
  it('预填的清单/标签会带进建出来的任务里', async () => {
    const { onCreate } = setup({
      view: 'list:L1',
      defaults: { listId: 'L1', priority: 0, tags: [] },
      lists: [{ id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null }],
    });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '写周报' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ listId: 'L1' })));
  });

  it('标签那个去处预填标签', async () => {
    const { onCreate } = setup({ view: 'tag:紧急', defaults: { listId: null, priority: 0, tags: ['紧急'] } });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '救火' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ tags: ['紧急'] })));
  });

  it('情境那个去处预填情境——跟标签那条一个模子', async () => {
    const { onCreate } = setup({ view: 'context:out', defaults: { listId: null, priority: 0, context: 'out' } });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '去银行办卡' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ context: 'out' })));
  });

  /**
   * 表单里情境是个看得见的下拉，一上来就预填成「外出」（站在那一屏）。这一条钉的是
   * **标题里打出来的字压过那个预填**——判据在 `mergePicked`，跟 due 那条 ③ 同一个。
   */
  it('站在「外出」那一屏，标题里写 @电脑前：听他打的那个，不是预填的', async () => {
    const { onCreate } = setup({ view: 'context:out', defaults: { listId: null, priority: 0, context: 'out' } });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '写代码 @电脑前' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ context: 'computer', title: '写代码' })));
  });

  it('**落进当前去处时不再说「这条在按来源里」**——它当场就看得见，那句话是在说一件不成立的事', async () => {
    const created = task({ listId: 'L1' });
    setup({
      view: 'list:L1',
      onCreate: vi.fn().mockResolvedValue(created),
      defaults: { listId: 'L1', priority: 0, tags: [] },
      lists: [{ id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null }],
    });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '写周报' } });
    fireEvent.click(byText('添加')!);

    expect(await screen.findByText('已添加')).toBeTruthy();
  });

  it('对照：没落进当前去处时那句话还在——比如清单视图里建了一条不属于这个清单的', async () => {
    setup({
      view: 'list:L1',
      onCreate: vi.fn().mockResolvedValue(task({ listId: null })),
      defaults: { listId: null, priority: 0, tags: [] },
    });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '写周报' } });
    fireEvent.click(byText('添加')!);

    expect(await screen.findByText(/在「按来源」里/)).toBeTruthy();
  });
});

/**
 * 预填的日期 vs 标题里打出来的日期。**预填不算「他手填过」**——站在「今天」里
 * 打开表单，due 一上来就是今天；这时候他在标题里写「明天下午两点」，该听标题。
 */
describe('TaskComposer：预填的日期让位给标题里写的', () => {
  const TODAY = new Date(2026, 7, 12, 23, 59).toISOString();

  it('**标题里写了日期就用标题的**，不被预填盖住', async () => {
    const { onCreate } = setup({ defaults: { listId: null, priority: 0, due: TODAY, tags: [] } });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '明天下午两点交周报' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    const sent = vi.mocked(onCreate).mock.calls[0][0] as unknown as { due: string };
    // NOW 是 2026-08-12，明天 = 8/13 14:00
    expect(new Date(sent.due).getDate()).toBe(13);
    expect(new Date(sent.due).getHours()).toBe(14);
  });

  it('标题里没写日期时预填还在——只是让位，不是被清掉', async () => {
    const { onCreate } = setup({ defaults: { listId: null, priority: 0, due: TODAY, tags: [] } });

    fireEvent.change(screen.getByPlaceholderText('标题'), { target: { value: '买牛奶' } });
    fireEvent.click(byText('添加')!);

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ due: TODAY })));
  });

  // 「自己在控件里挑过的压过标题」那条不在这儿测：antd 的 DatePicker 在
  // jsdom 里没法用一次 change 驱动（要整套弹层交互），而那条规则已经被
  // `lib/composeDefaults.test.ts` 的 `mergePicked` 直接盖住了——把它从组件里
  // 抽出来正是为了这个。
});

/**
 * 截止/提醒两个框显示到**分**，不显示秒。
 *
 * antd 的 `showTime` 默认吐 `YYYY-MM-DD HH:mm:ss`，于是整个应用里唯一带秒的
 * 时间显示就落在这两个框里——而任务的截止时间没有一处用得到秒（提醒按分钟
 * 排，卡片和行档都只显示到分）。见 2026-08-12-ux-audit.md「时间戳带秒」。
 */
describe('TaskComposer：时间不带秒', () => {
  it('填好之后输入框里是「YYYY-MM-DD HH:mm」，末尾没有那个 :00', () => {
    setup();
    const picker = screen.getByPlaceholderText('截止时间') as HTMLInputElement;
    fireEvent.change(picker, { target: { value: dayjs(localIso(2026, 9, 1, 8)).format(DATETIME_FORMAT) } });
    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(picker.value).toBe('2026-09-01 08:00');
    expect(picker.value).not.toMatch(/:\d\d:\d\d$/);
  });
});

// ============================================================================
// Esc 关这张表单（batch9 I-6）：回车能提交，Esc 就得能退出，而且从表单里**任何**一处
// ============================================================================

describe('TaskComposer：Esc', () => {
  const esc = (el: Element) => fireEvent.keyDown(el, { key: 'Escape' });

  /**
   * 标题框和备注框本来就接了 Esc（`formKey` 判成 cancel），缺的是焦点在别处的时候
   * ——光标停在「添加」上按 Esc，屏幕上什么都不发生，只能挪鼠标去点「取消」。
   */
  it('焦点在「添加」按钮上：Esc 走 onClose，跟点「取消」同一个动作', () => {
    const { onClose } = setup();
    esc(byText('添加')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('焦点在卡片空白处（表单根上）也关得掉', () => {
    const { onClose } = setup();
    esc(document.querySelector('.ink-task-composer')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * 弹层控件里的 Esc 意思是「把这个弹层收起来」，不是「把整张表单作废」。
   * 日期面板开着时按 Esc 顺手关掉整张表单，等于他改错一个字就把这条整个丢了。
   */
  it('日期面板开着时：Esc 不关表单（那一下是面板自己的）', () => {
    const { onClose } = setup();
    fireEvent.click(document.querySelector('.ink-frow') as HTMLElement);
    const picker = document.querySelector('.ant-picker input') as HTMLElement;
    expect(picker, '夹具没把日期那一行点开').toBeTruthy();
    esc(picker);
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * 这条钉的是「两道让路」里的另一道：标题框自己处理过 Esc 并且 preventDefault，
   * 根上那个处理器就该让开。让开失败的表现是 `dismiss()` 跑两遍——今天看不出来
   * （都是关表单），哪天 onClose 带上计数或者副作用，就多关一次。
   */
  it('标题框里按 Esc 只关一次（框自己接了，根上不该再来一遍）', () => {
    const { onClose } = setup();
    esc(screen.getByPlaceholderText('标题'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
