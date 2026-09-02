import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { List } from '../types.js';
import { STATUS_LABEL, STATUSES } from '../lib/taskView.js';
import { BatchBar, type BatchBarProps } from './BatchBar.js';
import { btnIn, NoMotion } from '../test-utils.js';

const LISTS: List[] = [
  { id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
  { id: 'L2', name: '归档了的', color: '#15803D', folderId: null, order: 1, archived: true, filter: null },
  // 智能清单：filter 非 null。不能出现在「改清单」的候选里——见下面
  // 「智能清单不进候选」那条，task-4-brief 要点③。
  {
    id: 'L3', name: '智能清单', color: '#7E22CE', folderId: null, order: 2, archived: false,
    filter: { status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] },
  },
];

function wire(over: Partial<BatchBarProps> = {}): BatchBarProps {
  return {
    count: 3,
    lists: LISTS,
    onChangeStatus: vi.fn(),
    onReschedule: vi.fn(),
    onPostpone: vi.fn(),
    onChangeList: vi.fn(),
    onAddTag: vi.fn(),
    onChangePriority: vi.fn(),
    onChangeContext: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn(),
    ...over,
  };
}

// antd Dropdown 的菜单是异步展开的，NoMotion 关掉动画（跟本仓库所有卡片
// 测试同一套装置，见 test-utils.tsx）。菜单挂在 body 末尾的浮层里，
// 不在 render 出来的子树里，从 document 找。
async function openMenu(triggerLabel: string, itemLabel: string) {
  fireEvent.click(screen.getByRole('button', { name: triggerLabel }));
  const item = await waitFor(() => {
    const hit = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((e) => e.textContent === itemLabel);
    if (!hit) throw new Error(`「${triggerLabel}」菜单里没有「${itemLabel}」`);
    return hit;
  });
  fireEvent.click(item);
}

const show = (over: Partial<BatchBarProps> = {}) => {
  const props = wire(over);
  const utils = render(
    <NoMotion><AntApp><BatchBar {...props} /></AntApp></NoMotion>,
  );
  return { ...utils, props };
};

describe('BatchBar：一张都没选时不出现——上限', () => {
  it('count === 0：整条不渲染，不是渲染一个空的/隐藏的', () => {
    const { container } = show({ count: 0 });
    expect(container.querySelector('.ink-batch-bar')).toBeNull();
    // 上限方向：连 role="toolbar" 都不该出现，不是靠 CSS 藏起来。
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});

describe('BatchBar：显示选中数量', () => {
  it('count 出现在文本里，换一个数字就换一个数字——不是写死的占位符', () => {
    const { rerender } = show({ count: 3 });
    expect(screen.getByRole('toolbar').textContent).toContain('3');

    rerender(
      <NoMotion><AntApp><BatchBar {...wire({ count: 12 })} /></AntApp></NoMotion>,
    );
    expect(screen.getByRole('toolbar').textContent).toContain('12');
    expect(screen.getByRole('toolbar').textContent).not.toContain('3 ');
  });
});

describe('BatchBar：改状态', () => {
  it('从下拉里点一个状态，onChangeStatus 收到那个状态——不是随便哪个', async () => {
    const { props } = show();
    await openMenu('改状态', '进行中');
    expect(props.onChangeStatus).toHaveBeenCalledWith('doing');
    expect(props.onChangeStatus).toHaveBeenCalledTimes(1);
  });

  // 原来这条写死四个，而「已放弃」是后加的状态——这个组件手抄了一份 STATUSES
  // 没跟上，于是选中十条已经不做了的任务，没法一起标成放弃（单张卡上一直
  // 可以）。改成从 `taskView.STATUSES` 现取，这条也跟着按那份单一出处断言，
  // 以后再加状态两边一起动。
  it('**每一个状态都在菜单里**——这份列表跟 taskView.STATUSES 是同一份，不是手抄的', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: '改状态' }));
    const labels = await waitFor(() => {
      const items = [...document.querySelectorAll('.ant-dropdown-menu-item')];
      if (items.length === 0) throw new Error('菜单还没展开');
      return items.map((e) => e.textContent);
    });
    expect(labels.sort()).toEqual(STATUSES.map((s) => STATUS_LABEL[s]).sort());
    expect(labels).toContain('已放弃');
  });
});

describe('BatchBar：改清单', () => {
  it('选一个清单，onChangeList 收到那个清单的 id', () => {
    const { props } = show();
    fireEvent.change(screen.getByLabelText('批量改清单'), { target: { value: 'L1' } });
    expect(props.onChangeList).toHaveBeenCalledWith('L1');
  });

  it('选「不属于任何清单」，onChangeList 收到 null——不是字符串 "__none__"', () => {
    const { props } = show();
    fireEvent.change(screen.getByLabelText('批量改清单'), { target: { value: '__none__' } });
    expect(props.onChangeList).toHaveBeenCalledWith(null);
  });

  it('归档的清单不进候选', () => {
    show();
    const select = screen.getByLabelText('批量改清单') as HTMLSelectElement;
    const optionLabels = [...select.options].map((o) => o.textContent);
    expect(optionLabels).not.toContain('归档了的');
  });

  // 上限：智能清单（filter 非 null）不进候选——把任务的 listId 指到一个
  // 查询上，那条任务在导航里哪儿都找不到（智能清单按 applyFilter 取任务，
  // 不看 listId），见 task-4-brief 要点③。
  it('智能清单不进候选——上限', () => {
    show();
    const select = screen.getByLabelText('批量改清单') as HTMLSelectElement;
    const optionLabels = [...select.options].map((o) => o.textContent);
    // 中间断言：先证明普通清单确实在候选里，不是整个下拉是空的
    // （上限断言在功能没接上时天然成立，见 parked-all.md 第 97 条）。
    expect(optionLabels).toContain('工作');
    expect(optionLabels).not.toContain('智能清单');
  });
});

describe('BatchBar：加标签', () => {
  it('输入框回车，onAddTag 收到去空白之后的标签，输入框清空', () => {
    const { props } = show();
    const input = screen.getByLabelText('批量加标签') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  紧急  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onAddTag).toHaveBeenCalledWith('紧急');
    expect(input.value).toBe('');
  });

  it('空白输入回车不触发', () => {
    const { props } = show();
    const input = screen.getByLabelText('批量加标签');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onAddTag).not.toHaveBeenCalled();
  });

  it('回车之外的键不触发', () => {
    const { props } = show();
    const input = screen.getByLabelText('批量加标签');
    fireEvent.change(input, { target: { value: '紧急' } });
    fireEvent.keyDown(input, { key: 'a' });
    expect(props.onAddTag).not.toHaveBeenCalled();
  });
});

describe('BatchBar：改优先级', () => {
  it('从下拉里点一档，onChangePriority 收到对应的数字', async () => {
    const { props } = show();
    await openMenu('改优先级', '高');
    expect(props.onChangePriority).toHaveBeenCalledWith(3);
  });

  it('点「无」传 0——批量清空优先级的入口', async () => {
    const { props } = show();
    await openMenu('改优先级', '无');
    expect(props.onChangePriority).toHaveBeenCalledWith(0);
  });
});

/**
 * 改情境（GTD）。这一维比别的维度更需要批量：分情境是 clarify 那一步的动作，
 * 而那一步天生成批（「这十二条都是出门办的」）。
 */
describe('BatchBar：改情境', () => {
  it('从下拉里点一档，onChangeContext 收到的是英文 key、不是中文名', async () => {
    const { props } = show();
    await openMenu('改情境', '电脑前');
    // 存进 `data/tasks/` 的是英文 key（model.ts 的 TaskContext）——拿中文名当
    // key 传下去的话，服务端校验会整条拒，而界面上看不出区别。
    expect(props.onChangeContext).toHaveBeenCalledWith('computer');
  });

  it('点「不分情境」传 null——批量清掉情境的入口，不是传一个叫 __none__ 的假情境', async () => {
    const { props } = show();
    await openMenu('改情境', '不分情境');
    expect(props.onChangeContext).toHaveBeenCalledWith(null);
  });
});

describe('BatchBar：删除 / 取消选择', () => {
  it('点删除，onDelete 被调用——不弹确认（那是调用方的事，见组件顶部注释）', () => {
    const { container, props } = show();
    // 「删除」是「恰好两个汉字、没有图标」的按钮，antd 会插一个空格渲染成
    // 「删 除」——跟 test-utils.tsx 里 btnIn 自己的注释同一个坑，用它而不是
    // getByRole 按文字精确匹配。
    fireEvent.click(btnIn(container, '删除'));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('点取消选择，onClear 被调用', () => {
    const { props } = show();
    fireEvent.click(screen.getByRole('button', { name: '取消选择' }));
    expect(props.onClear).toHaveBeenCalledTimes(1);
  });
});

/**
 * 日期这一维（仿滴答清单的批量「编辑新日期」和「推迟」）。**算什么在
 * `lib/reschedule.test.ts`**——这里只测这一条上有没有这两个入口、报的动作对
 * 不对，跟这个文件里别的用例同一个分工（它是个纯展示组件）。
 */
describe('BatchBar：改期 / 推迟', () => {
  it('「改期」菜单里三个去处，点了报上去', async () => {
    const w = wire();
    render(<NoMotion><AntApp><BatchBar {...w} /></AntApp></NoMotion>);

    fireEvent.click(btnIn(document.body, '改期'));
    const item = await waitFor(() => {
      const hit = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((e) => e.textContent?.replace(/\s/g, '') === '明天');
      if (!hit) throw new Error('菜单里没有「明天」');
      return hit;
    });
    fireEvent.click(item);
    expect(w.onReschedule).toHaveBeenCalledWith('tomorrow');
  });

  it('「改期」里没有「去掉截止时间」——批量清空所有选中任务的截止时间，误点的代价比单条大一个量级，而它没有垃圾箱兜底', async () => {
    render(<NoMotion><AntApp><BatchBar {...wire()} /></AntApp></NoMotion>);
    fireEvent.click(btnIn(document.body, '改期'));
    await waitFor(() => expect(document.querySelectorAll('.ant-dropdown-menu-item').length).toBeGreaterThan(0));
    const labels = [...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => e.textContent);
    expect(labels).not.toContain('去掉截止时间');
  });

  it('「推迟 1 小时」是一颗裸按钮，不收进菜单——它是应付「临时插了个会」的当场动作', () => {
    const w = wire();
    render(<NoMotion><AntApp><BatchBar {...w} /></AntApp></NoMotion>);
    fireEvent.click(btnIn(document.body, '推迟1小时'));
    expect(w.onPostpone).toHaveBeenCalledWith(60);
  });
});
