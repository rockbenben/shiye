import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { QuickAdd } from './QuickAdd.js';
import { task } from '../test-utils.js';
import type { ComposeDefaults } from '../lib/composeDefaults.js';
import type { TaskDraft } from './TaskFields.js';

const NOW = new Date(2026, 7, 24, 12);
const SMART_ON = { date: true, stripDate: true, tag: true, stripTag: true };
const NO_DEFAULTS: ComposeDefaults = { listId: null, priority: 0, due: null, tags: [], context: null, remindMinutes: null, smart: SMART_ON };

function show(opts: {
  view?: string;
  defaults?: ComposeDefaults;
  indent?: boolean;
  wide?: boolean;
  onOpenForm?: () => void;
  onCreate?: (d: TaskDraft) => Promise<ReturnType<typeof task>>;
} = {}) {
  const created: TaskDraft[] = [];
  const onOpenForm = opts.onOpenForm ?? vi.fn();
  const onCreate = opts.onCreate ?? (async (d: TaskDraft) => {
    created.push(d);
    return task({ id: 'new', title: d.title, due: d.due, listId: d.listId, tags: d.tags });
  });
  render(
    <AntApp>
      <QuickAdd
        onCreate={onCreate}
        view={opts.view ?? 'all'}
        boardFilter="all"
        now={NOW}
        defaults={opts.defaults ?? NO_DEFAULTS}
        indent={opts.indent}
        wide={opts.wide}
        onOpenForm={onOpenForm}
      />
    </AntApp>,
  );
  const input = screen.getByLabelText('添加任务') as HTMLInputElement;
  const type = (v: string) => fireEvent.change(input, { target: { value: v } });
  const enter = () => fireEvent.submit(input.closest('form')!);
  return { created, input, type, enter, onOpenForm };
}

describe('QuickAdd', () => {
  it('打一句话回车就建好', async () => {
    const { created, type, enter } = show();
    type('买牛奶');
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].title).toBe('买牛奶');
  });

  it('**建完输入框清空、留在原地**——这一行的形状是「连着记五条」，不是建完就收', async () => {
    const { input, type, enter } = show();
    type('买牛奶');
    enter();
    await waitFor(() => expect(input.value).toBe(''));
    // 还挂在那儿，接着能打下一条
    expect(screen.getByLabelText('添加任务')).toBeTruthy();
  });

  it('空的 / 只有空格的不建——回车不该发一条没有标题的任务', async () => {
    const { created, type, enter } = show();
    enter();
    type('   ');
    enter();
    await new Promise((r) => setTimeout(r, 0));
    expect(created).toHaveLength(0);
  });

  it('预填跟着当前这个去处走：清单、优先级、标签、日期都带上', async () => {
    const { created, type, enter } = show({
      view: 'list:L1',
      defaults: { listId: 'L1', priority: 2, due: '2026-08-24T15:59:00.000Z', tags: ['工作'], context: null, remindMinutes: null, smart: SMART_ON },
    });
    type('写周报');
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      listId: 'L1', priority: 2, tags: ['工作'], due: '2026-08-24T15:59:00.000Z',
    });
  });

  it('认自然语言：「明天下午两点交周报」把时间摘走，标题只剩正事', async () => {
    const { created, type, enter } = show();
    type('明天下午两点交周报');
    expect(screen.getByText(/识别到/)).toBeTruthy();
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].title).toBe('交周报');
    expect(created[0].due).not.toBeNull();
    expect(created[0].reminders).toHaveLength(1);
  });

  it('**标题里写出来的日期压过去处的预填**——站在「今天」里写「明天开会」，建的是明天', async () => {
    const today = new Date(2026, 7, 24, 23, 59).toISOString();
    const { created, type, enter } = show({
      view: 'today',
      defaults: { listId: null, priority: 0, due: today, tags: [], context: null, remindMinutes: null, smart: SMART_ON },
    });
    type('明天开会');
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].due).not.toBe(today);
    expect(new Date(created[0].due!).getDate()).toBe(25);
  });

  it('「取消识别」之后那句话原样进标题', async () => {
    const { created, type, enter } = show();
    type('明天下午两点交周报');
    fireEvent.click(screen.getByRole('button', { name: '取消识别' }));
    expect(screen.queryByText(/识别到/)).toBeNull();
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].title).toBe('明天下午两点交周报');
    expect(created[0].due).toBeNull();
  });

  it('**「取消识别」只管这一条**——建完要重置，不然一次「别认」会静静管住后面每一条', async () => {
    const { input, type, enter } = show();
    type('明天下午两点交周报');
    fireEvent.click(screen.getByRole('button', { name: '取消识别' }));
    enter();
    await waitFor(() => expect(input.value).toBe(''));
    type('后天开会');
    expect(screen.getByText(/识别到/)).toBeTruthy();
  });

  it('右端那颗按钮开的是整张表单——滴答清单桌面版加任务只有「任务添加栏」这一个地方，附加选项挂在输入框右侧', () => {
    const onOpenForm = vi.fn();
    show({ onOpenForm });
    fireEvent.click(screen.getByRole('button', { name: '新任务表单' }));
    expect(onOpenForm).toHaveBeenCalledTimes(1);
  });

  it('**它不提交这一行**——按钮写死 type="button"，不然点它会顺手建一条空任务', () => {
    const { created, type } = show();
    type('还没想好');
    fireEvent.click(screen.getByRole('button', { name: '新任务表单' }));
    expect(created).toHaveLength(0);
  });

  it('Esc 清空输入框', () => {
    const { input, type } = show();
    type('打错了');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
  });

  it('新卡就在这一屏里时不弹话——连记五条弹五次「已添加」是噪音', async () => {
    const { created, type, enter } = show({ view: 'all' });
    type('买牛奶');
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(screen.queryByText(/已添加/)).toBeNull();
  });

  it('新卡不在这一屏里时要说——「写成功了界面没反应」是这个仓库栽过五次的坏', async () => {
    const { created, type, enter } = show({ view: 'today' });
    type('买牛奶');
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(await screen.findByText('已添加。没填今天的时间，这条在「按来源」里')).toBeTruthy();
  });

  it('indent 让左边多空 28px——「今天」的行留了那一段给排序抓手，不跟着让就跟下面每个勾选圈错开 24px', () => {
    const { input } = show({ indent: true });
    expect(input.closest('form')!.className).toContain('ink-quickadd-indent');
  });

  it('不给 indent 就不让——别的去处的行没有那段抓手位，让了反而错开', () => {
    const { input } = show();
    expect(input.closest('form')!.className).not.toContain('ink-quickadd-indent');
  });

  // 封顶那个 token（`--row-measure`）是行档的宽度。卡档下面的 `.ink-card-grid`
  // 铺满整列，这一行不跟着铺满就比它下面的卡片短一大截——实测 1920 下短 686px。
  it('wide 把封顶去掉——卡档/瀑布流下面铺满整列，这一行也得铺满', () => {
    const { input } = show({ wide: true });
    expect(input.closest('.ink-quickadd-wrap')!.className).toContain('ink-quickadd-wrap-wide');
  });

  it('不给 wide 就照旧封在 --row-measure 里——行档下面那一列行也封在同一个 token 上', () => {
    const { input } = show();
    expect(input.closest('.ink-quickadd-wrap')!.className).not.toContain('ink-quickadd-wrap-wide');
  });

  it('建失败时那句话留在框里，不清空——清空等于把他刚打的字连同失败一起弄丢', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('服务端挂了'));
    const { input, type, enter } = show({ onCreate });
    type('买牛奶');
    enter();
    expect(await screen.findByText('服务端挂了')).toBeTruthy();
    expect(input.value).toBe('买牛奶');
  });
});

/**
 * **一个东西只用一个名字。**
 *
 * 这颗按钮开的那张表单在别处一直叫「新任务表单」：快捷键表写着
 * `C 新任务表单`，设置里两条「新任务默认清单/优先级」的说明写着「只影响
 * 「新任务」表单的初值」。按钮原来自称「填完整的表单」——那是一句描述，
 * 不是名字，于是同一个东西在屏幕上有三种叫法。
 */
describe('QuickAdd：那颗 ⌄ 的名字跟它开的表单一致', () => {
  it('可访问名是「新任务表单」，不是一句描述', () => {
    show();
    expect(screen.getByRole('button', { name: '新任务表单' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '填完整的表单' })).toBeNull();
  });
});
