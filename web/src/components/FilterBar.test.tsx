import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp, Button, ConfigProvider, Select } from 'antd';
import type { List, SmartFilter } from '../types.js';
import { STATUS_LABEL, STATUSES } from '../lib/taskView.js';
import { emptyFilter } from '../lib/smartFilter.js';
import { FilterBar, type FilterBarProps } from './FilterBar.js';
import { btnIn, NoMotion } from '../test-utils.js';
import { ink, theme as appTheme } from '../theme.js';

const LISTS: List[] = [
  { id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
  // 智能清单：filter 非 null。不能出现在「清单」那一维的选项里，见下面
  // 「上限」那组测试。
  { id: 'L2', name: '智能清单', color: '#15803D', folderId: null, order: 1, archived: false, filter: emptyFilter() },
];

const TAGS = ['紧急', '出差'];

// 跟 smartFilter.test.ts 同一个约定：F(over) 在 emptyFilter() 基础上覆盖，
// 保证没提到的字段总是明确的空值，不是漏写。
const F = (over: Partial<SmartFilter> = {}): SmartFilter => ({ ...emptyFilter(), ...over });

function wire(over: Partial<FilterBarProps> = {}): FilterBarProps {
  return {
    filter: emptyFilter(),
    onChange: vi.fn(),
    lists: LISTS,
    allTags: TAGS,
    matched: 3,
    total: 5,
    onSaveAsList: vi.fn(),
    ...over,
  };
}

const show = (over: Partial<FilterBarProps> = {}) => {
  const props = wire(over);
  const utils = render(
    <NoMotion><AntApp><FilterBar {...props} /></AntApp></NoMotion>,
  );
  return { ...utils, props };
};

/** 筛选栏默认收起（task-4-brief）——控件只在展开状态下存在。找到「筛选」
 * 这颗折叠按钮就点开它；筛选本身非空时组件自己会展开、没有这颗按钮，
 * 找不到就什么都不做，不是 bug（跟 btnIn 的查找方式一样按去空白后的文字
 * 比对，避免 antd 恰好两个汉字插空格那个坑，见 test-utils.tsx 顶部注释）。 */
function openFilterBar() {
  const toggle = [...document.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s/g, '') === '筛选');
  if (toggle) fireEvent.click(toggle);
}

/** 打开某个多选/单选下拉，返回当前面板里的选项元素（在 body 末尾的浮层里，
 * 不在渲染出来的子树里，从 document 找——跟 test-utils.tsx 的 pickCardMenu
 * 同一个理由）。 */
function openSelect(label: string) {
  openFilterBar();
  fireEvent.mouseDown(screen.getByRole('combobox', { name: label }));
  return [...document.querySelectorAll('.ant-select-item-option')];
}

function pickOption(label: string, optionText: string) {
  const options = openSelect(label);
  const hit = options.find((e) => e.textContent === optionText);
  if (!hit) throw new Error(`「${label}」下拉里没有「${optionText}」，实际选项：${options.map((e) => e.textContent).join('、')}`);
  fireEvent.click(hit);
}

// task-4-brief「顶部 chrome 收一收」：六个下拉 + 搜索框 + 一个按钮平时是
// 空的，常驻占约 100px 没有意义，收成一颗「筛选」按钮。那条「筛选非空时
// 必须一直可见」的防线（2026-08-17-smart-filter.md 设计②）不能被这次改动
// 破坏——收起的只是「空筛选」这一种情况，见下面最后一条上限断言。
describe('FilterBar：默认收起——task-4-brief', () => {
  it('筛选为空时默认收起：只有一颗「筛选」按钮，六个下拉/输入框/勾选框都不在', () => {
    const { container } = show({ filter: emptyFilter() });
    // 上限：折叠时六个控件一个都找不到。
    expect(screen.queryByRole('combobox', { name: '状态' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '清单' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '标签' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '优先级' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '到期天数' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '只看等待中的' })).toBeNull();
    expect(screen.queryByLabelText('筛选文本')).toBeNull();
    // 中间断言：容器本身还在、折叠按钮真的渲染了（不是整条都没画出来，
    // 导致上面全部 toBeNull 只是恰好成立）。
    expect(screen.getByRole('group', { name: '筛选' })).toBeTruthy();
    expect(btnIn(container, '筛选')).toBeTruthy();
  });

  it('点开「筛选」能展开：六个控件都出现', () => {
    const { container } = show({ filter: emptyFilter() });
    fireEvent.click(btnIn(container, '筛选'));
    expect(screen.getByRole('combobox', { name: '状态' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '清单' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '标签' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '优先级' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '到期天数' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: '只看等待中的' })).toBeTruthy();
    expect(screen.getByLabelText('筛选文本')).toBeTruthy();
  });

  it('筛选非空时自动展开——不用点「筛选」，控件已经在', () => {
    const { container } = show({ filter: F({ text: '周报' }) });
    expect(screen.getByRole('combobox', { name: '状态' })).toBeTruthy();
    expect(screen.getByLabelText('筛选文本')).toBeTruthy();
    // 折叠按钮不该同时出现——展开了就不该还看到「筛选」这颗入口。
    // 修复轮 1 · I-1：`queryByText('筛选')` 是恒真断言——antd 的
    // autoInsertSpace 把这颗恰好两个汉字的按钮渲染成「筛 选」（中间一个
    // 空格），`queryByText('筛选')` 不管按钮在不在都是 null，见
    // test-utils.tsx 顶部 btnIn 的注释。改成跟五行之后「收起」上限同一个
    // 写法：去空白再比对整个按钮列表，不靠精确文字匹配。
    const toggleBtn = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.replace(/\s/g, '') === '筛选');
    expect(toggleBtn).toBeUndefined();
  });

  // 上限断言（task-4-brief 要点②）：筛选非空时不能收起，那条「筛选非空时
  // 必须一直可见」的防线不能被这次改动破坏。
  it('筛选非空时不能收起——上限：没有「收起」这个入口', () => {
    const { container } = show({ filter: F({ text: '周报' }) });
    // 中间断言：确实展开了（不是压根没渲染控件，导致下面「找不到收起
    // 按钮」只是恰好成立）。
    expect(screen.getByRole('combobox', { name: '状态' })).toBeTruthy();
    // 上限：找不到任何文字是「收起」的按钮——非空时这条路径根本没有入口，
    // 不是「有按钮但点了没用」。
    const collapseBtn = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.replace(/\s/g, '') === '收起');
    expect(collapseBtn).toBeUndefined();
  });

  // 修复轮 1 · A：「收起来的是按钮，不是那个框」——边框/底色/内边距
  // （.ink-filter-bar-open）只在展开时才套上，收起时容器只剩纯布局的
  // .ink-filter-bar，没有那颗按钮之外的「面板感」。展开态是上限：这个
  // class 不能被顺手删掉。
  it('收起态没有边框/底色——.ink-filter-bar-open 这个 class 不该出现', () => {
    const { container } = show({ filter: emptyFilter() });
    const bar = container.querySelector('.ink-filter-bar')!;
    expect(bar).toBeTruthy();
    expect(bar.classList.contains('ink-filter-bar-open')).toBe(false);
  });

  it('展开态有边框/底色——上限：.ink-filter-bar-open 这个 class 不能被顺手删掉', () => {
    const { container } = show({ filter: emptyFilter() });
    fireEvent.click(btnIn(container, '筛选'));
    const bar = container.querySelector('.ink-filter-bar')!;
    expect(bar.classList.contains('ink-filter-bar-open')).toBe(true);
  });

  // 修复轮 1 · m-4：24px 点击目标钉在 token 上（boardLocalTheme 的
  // controlHeightSM: 24），不是白捡的 antd 默认值——antd 6 css-var 模式下
  // `height` 声明本身就是 `var(--ant-control-height-sm)`（跟 --ant-color-primary
  // 那套读法同源，见文件顶部「群青」那组测试），读这个自定义属性等于
  // 直接读这颗按钮真实会渲染成多高。
  it('收起态那颗「筛选」按钮的 24px 点击目标钉在 controlHeightSM token 上', () => {
    const { container } = show({ filter: emptyFilter() });
    const btn = btnIn(container, '筛选');
    const h = getComputedStyle(btn).getPropertyValue('--ant-control-height-sm').trim();
    expect(h).toBe('24px');
  });
});

describe('FilterBar：清单那一维不列智能清单——上限', () => {
  it('普通清单在选项里，智能清单不在', () => {
    show();
    const options = openSelect('清单');
    // 中间断言：先证明下拉真的渲染出了普通清单，不是整个选项列表是空的
    // （上限断言在功能没接上时天然成立，见 parked-all.md 第 97 条）。
    expect(options.map((e) => e.textContent)).toContain('工作');
    // 上限：智能清单不出现。
    expect(options.map((e) => e.textContent)).not.toContain('智能清单');
    // 真清单一份 + 末尾那项「不属于任何清单」。
    expect(options.map((e) => e.textContent)).toEqual(['工作', '不属于任何清单']);
  });

  // final-review.md m2：跟 BatchBar.tsx「改清单」、TaskFields.tsx「归到哪个
  // 清单」、Sidebar.tsx 导航同一条规矩——归档清单也不该出现在这一维里。
  it('归档清单也不在选项里，跟 BatchBar/TaskFields/Sidebar 三处对齐', () => {
    const archived: List = { id: 'L3', name: '归档的清单', color: '#000', folderId: null, order: 2, archived: true, filter: null };
    show({ lists: [...LISTS, archived] });
    const options = openSelect('清单');
    // 中间断言：普通清单还在。
    expect(options.map((e) => e.textContent)).toContain('工作');
    // 上限：归档清单不出现。
    expect(options.map((e) => e.textContent)).not.toContain('归档的清单');
    expect(options.map((e) => e.textContent)).toEqual(['工作', '不属于任何清单']);
  });
});

describe('FilterBar：七个维度各自的控件', () => {
  it('状态多选：选中的值原样传出去，不碰别的字段', () => {
    const base = F({ listIds: ['L1'] });
    const { props } = show({ filter: base });
    pickOption('状态', '进行中');
    expect(props.onChange).toHaveBeenCalledWith({ ...base, status: ['doing'] });
  });

  it('清单多选：选中的 id 原样传出去，不碰别的字段', () => {
    const base = F({ tags: ['出差'] });
    const { props } = show({ filter: base });
    pickOption('清单', '工作');
    expect(props.onChange).toHaveBeenCalledWith({ ...base, listIds: ['L1'] });
  });

  it('标签多选：选中的标签原样传出去，不碰别的字段', () => {
    const base = F({ priority: [1] });
    const { props } = show({ filter: base });
    pickOption('标签', '紧急');
    expect(props.onChange).toHaveBeenCalledWith({ ...base, tags: ['紧急'] });
  });

  it('优先级多选：「无」也是一档能选的值，不碰别的字段', () => {
    const base = F({ text: '周报' });
    const { props } = show({ filter: base });
    pickOption('优先级', '中');
    expect(props.onChange).toHaveBeenCalledWith({ ...base, priority: [2] });
  });

  it('到期天数：选一个预设天数，不碰别的字段', () => {
    const base = F({ status: ['todo'] });
    const { props } = show({ filter: base });
    pickOption('到期天数', '3 天内');
    expect(props.onChange).toHaveBeenCalledWith({ ...base, dueWithinDays: 3 });
  });

  /**
   * 「没有时间」跟几档「N 天内」并列在同一个下拉里——日期这一维只能选一档，
   * 所以它不像「不属于任何清单」那样要跟同维度的选择取「或」。哨兵值是一个
   * 中文串、不是 -1（那是一个合法的 dueWithinDays），而且一个字节都不落进
   * SmartFilter：这两条正是下面这两条断言在盯的。
   */
  it('到期天数：选「没有时间」置的是 noDue，不是往 dueWithinDays 里塞一个哨兵数字', () => {
    const base = F({ status: ['todo'] });
    const { props } = show({ filter: base });
    pickOption('到期天数', '没有时间');
    expect(props.onChange).toHaveBeenCalledWith({ ...base, noDue: true, dueWithinDays: null });
  });

  it('**改选一档「N 天内」会把「没有时间」放下**——同一维只能选一档，留着上一档就成了产不出的空集', () => {
    const base = F({ noDue: true });
    const { props } = show({ filter: base });
    pickOption('到期天数', '7 天内');
    expect(props.onChange).toHaveBeenCalledWith({ ...base, noDue: false, dueWithinDays: 7 });
  });

  it('到期天数：清空这一维单独清成 null，不碰别的字段', () => {
    const base = F({ dueWithinDays: 5, hasWaitingFor: true });
    const { props } = show({ filter: base });
    const clearBtn = document.querySelector('.ant-select-clear');
    if (!clearBtn) throw new Error('到期天数的清空按钮没出现');
    fireEvent.click(clearBtn);
    expect(props.onChange).toHaveBeenCalledWith({ ...base, dueWithinDays: null });
  });

  it('只看等待中的：勾选框切到 true，不碰别的字段', () => {
    const base = F({ tags: ['出差'] });
    const { props } = show({ filter: base });
    fireEvent.click(screen.getByRole('checkbox', { name: '只看等待中的' }));
    expect(props.onChange).toHaveBeenCalledWith({ ...base, hasWaitingFor: true });
  });

  it('筛选文本：输入框改动原样传出去，不碰别的字段', () => {
    const base = F({ status: ['todo'] });
    const { props } = show({ filter: base });
    fireEvent.change(screen.getByLabelText('筛选文本'), { target: { value: '周报' } });
    expect(props.onChange).toHaveBeenCalledWith({ ...base, text: '周报' });
  });
});

describe('FilterBar：计数', () => {
  it('筛选为空时不显示计数和清空——上限', () => {
    show({ filter: emptyFilter() });
    // 中间断言：先证明筛选栏真的挂载了（不是整条没渲染）。
    expect(screen.getByRole('group', { name: '筛选' })).toBeTruthy();
    expect(screen.queryByText(/\d+ \/ \d+ 条/)).toBeNull();
    expect(screen.queryByRole('button', { name: '清空' })).toBeNull();
  });

  it('选了状态之后显示「N / M 条」——不是写死的占位符', () => {
    show({ filter: F({ status: ['todo'] }), matched: 2, total: 5 });
    expect(screen.getByRole('group', { name: '筛选' }).textContent).toContain('2 / 5 条');
  });
});

describe('FilterBar：清空', () => {
  it('清空按钮把九个字段全恢复——不是只恢复看得见的那几个', () => {
    const full: SmartFilter = {
      status: ['doing'], listIds: ['L1'], tags: ['紧急'], priority: [2], contexts: [],
      dueWithinDays: 5, hasWaitingFor: true, text: '周报',
      tagsAll: true, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [{ ...emptyFilter(), tags: ['工作'] }],
    };
    const { container, props } = show({ filter: full });
    // 「清空」是恰好两个汉字、没有图标的按钮，antd 会插一个空格渲染成
    // 「清 空」——跟 test-utils.tsx 的 btnIn 同一个坑，见那份文件顶部注释。
    fireEvent.click(btnIn(container, '清空'));
    expect(props.onChange).toHaveBeenCalledWith(emptyFilter());
  });
});

describe('FilterBar：存成智能清单', () => {
  it('筛选为空时不可用——上限', () => {
    show({ filter: emptyFilter() });
    // 筛选栏默认收起（task-4-brief），这颗按钮跟其它控件一样只在展开状态下
    // 存在——先展开。
    openFilterBar();
    // 中间断言：按钮确实渲染了（不是被藏起来，见组件注释：禁用不是隐藏）。
    const btn = screen.getByRole('button', { name: '存成智能清单' });
    // 这个仓库没装 jest-dom，断言 disabled 一律走原生属性，跟
    // InboxSidebar.test.tsx/TaskComposer.test.tsx 同一个约定。
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('筛选非空时可用，点击调用 onSaveAsList', () => {
    const { props } = show({ filter: F({ text: '周报' }) });
    const btn = screen.getByRole('button', { name: '存成智能清单' });
    expect(btn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(btn);
    expect(props.onSaveAsList).toHaveBeenCalledTimes(1);
  });

  it('不给 onSaveAsList 就整个不渲染这颗按钮', () => {
    show({ filter: F({ text: '周报' }), onSaveAsList: undefined });
    expect(screen.queryByRole('button', { name: '存成智能清单' })).toBeNull();
  });
});

// 群青那件事：antd Select 的选中项底色来自 colorPrimary（全局是群青），
// theme.css 的前缀扫描守不到这个——照 TaskCard.test.tsx 修子任务勾选框/
// 编辑态 DatePicker 那套写法，渲染出来读实际的 --ant-color-primary
// 自定义属性（antd 6 的 css-var 模式），不靠 CSS 文本扫描。
describe('FilterBar：Select 的选中底色不是群青', () => {
  it('对照：这份夹具本身确实会让裸 Select 读到群青——不是随手挑的主题恰好不是群青', () => {
    const { container } = render(
      <ConfigProvider theme={appTheme}>
        <AntApp>
          <Select
            className="ink-filter-probe"
            mode="multiple"
            aria-label="探针"
            options={[]}
            value={[]}
            onChange={() => {}}
          />
        </AntApp>
      </ConfigProvider>,
    );
    const el = container.querySelector('.ant-select') as HTMLElement;
    const primary = getComputedStyle(el).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    expect(primary).toBe(ink.ai.toLowerCase());
  });

  it('FilterBar 里所有 Select 读到的 --ant-color-primary 都是你的墨（ink.you），不是群青（ink.ai）', () => {
    const props = wire();
    const { container } = render(
      <ConfigProvider theme={appTheme}>
        <NoMotion><AntApp><FilterBar {...props} /></AntApp></NoMotion>
      </ConfigProvider>,
    );
    // 筛选栏默认收起（task-4-brief），Select 只在展开状态下存在——先展开。
    openFilterBar();
    const selects = container.querySelectorAll('.ant-select');
    // 状态/清单/标签/优先级/情境/到期天数/预计时长，七颗——先证明这份夹具真的
    // 渲染出了全部七颗，不是漏了几颗、断言在空集合上空转。
    // **这个数字本身不是规格**，它的作用是「加了新的 Select 就来这儿看一眼、
    // 确认新那颗也被下面那个循环量到了」。加控件时改它，不是绕开它。
    expect(selects.length).toBe(7);
    selects.forEach((s) => {
      const primary = getComputedStyle(s as HTMLElement).getPropertyValue('--ant-color-primary').trim().toLowerCase();
      expect(primary).toBe(ink.you.toLowerCase());
      expect(primary).not.toBe(ink.ai.toLowerCase());
    });
  });
});

/**
 * 整分支审查 B2：计划顶上那条 ⚠️（antd 组件的选中色读全局 colorPrimary，
 * theme.css 的前缀扫描扫不到）在 task-4 收起态筛选栏上第四次撞上——收起
 * 态整条筛选栏就剩这一颗 antd `<Button>`，上面「Select 的选中底色不是
 * 群青」那组测试只覆盖了展开态的五颗 Select，没有一条断言读过这颗按钮
 * 实际的 `--ant-color-primary`。照同一套写法补上，**先做对照组**证明这份
 * 夹具真的能复现群青（裸 Button 没套 ConfigProvider 时读 antd 默认蓝，
 * 套 appTheme 时读到群青），没有对照组的断言不算数（parked-all.md 反复
 * 出现的教训）。
 */
describe('FilterBar：收起态那颗「筛选」按钮的选中底色不是群青', () => {
  it('对照组一：裸 Button 不套任何 ConfigProvider 时读到 antd 默认蓝，不是这个仓库的任何一种墨——证明这份夹具量的是真实读到的 token，不是巧合', () => {
    const { container } = render(<Button>筛选</Button>);
    const btn = container.querySelector('.ant-btn') as HTMLElement;
    const primary = getComputedStyle(btn).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    expect(primary).toBe('#1677ff');
  });

  it('对照组二：套 appTheme（全局主题）时读到群青——证明这份夹具确实会让裸 Button 读到 ink.ai，不是随手挑的主题恰好不是群青', () => {
    const { container } = render(
      <ConfigProvider theme={appTheme}><Button>筛选</Button></ConfigProvider>,
    );
    const btn = container.querySelector('.ant-btn') as HTMLElement;
    const primary = getComputedStyle(btn).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    expect(primary).toBe(ink.ai.toLowerCase());
  });

  it('FilterBar 收起态那颗「筛选」按钮读到的是你的墨（ink.you），不是群青（ink.ai）——FilterBar 自己的 boardLocalTheme 局部压住了外层的 appTheme', () => {
    const props = wire();
    const { container } = render(
      <ConfigProvider theme={appTheme}>
        <NoMotion><AntApp><FilterBar {...props} /></AntApp></NoMotion>
      </ConfigProvider>,
    );
    // 中间断言：先证明真的是收起态（这颗按钮真的渲染出来了），不是巧合
    // 找到了别的按钮。
    const btn = btnIn(container, '筛选');
    expect(btn).toBeTruthy();
    const primary = getComputedStyle(btn).getPropertyValue('--ant-color-primary').trim().toLowerCase();
    // 变异验证锚点：把这颗按钮换成自套一层
    // `<ConfigProvider theme={{token:{colorPrimary:'#2E3ED4'}}}>` 的
    // `type="primary"` 按钮——这条会红：读到的 --ant-color-primary 会是
    // 群青，不是 ink.you。
    expect(primary).toBe(ink.you.toLowerCase());
    expect(primary).not.toBe(ink.ai.toLowerCase());
  });
});

/**
 * 高级筛选（仿滴答清单）：标签的且/或开关，和多语句「或」查询。
 * 匹配判据在 `lib/smartFilter.test.ts`，这里只测这一条上的控件。
 */
describe('FilterBar：高级筛选', () => {
  it('选了不止一个标签才出现「标签要全中」——一个标签时「任一」和「全部」是同一件事', () => {
    show({ filter: F({ tags: ['工作'] }) });
    expect(screen.queryByText('标签要全中')).toBeNull();
    cleanup();
    show({ filter: F({ tags: ['工作', '紧急'] }) });
    expect(screen.getByText('标签要全中')).toBeTruthy();
  });

  it('勾「标签要全中」报 tagsAll: true, noList: false, noTag: false', () => {
    const { props } = show({ filter: F({ tags: ['工作', '紧急'] }) });
    fireEvent.click(screen.getByText('标签要全中'));
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ tagsAll: true, noList: false, noTag: false }));
  });

  it('筛选为空时没有「+ 或者…」——一份「什么都不筛 或者 什么都不筛」没有意义', () => {
    show({ filter: emptyFilter() });
    openFilterBar();   // 空筛选默认收起，先点开才看得到控件
    expect(screen.queryByText('+ 或者…')).toBeNull();
  });

  it('筛选非空时点「+ 或者…」加一个空组', () => {
    const { props } = show({ filter: F({ priority: [3] }) });
    fireEvent.click(screen.getByText('+ 或者…'));
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ or: [emptyFilter()] }));
  });

  it('「或」组渲染成同一排七个控件——加第八维时不会漏掉「或」组那一份', () => {
    show({ filter: F({ priority: [3], contexts: [], or: [emptyFilter()] }) });
    // 第一组 + 一个「或」组 = 每个 aria-label 各两份
    expect(screen.getAllByLabelText('状态')).toHaveLength(2);
    expect(screen.getAllByLabelText('筛选文本')).toHaveLength(2);
  });

  it('改「或」组只动那一组，第一组原样', () => {
    const { props } = show({ filter: F({ priority: [3], contexts: [], or: [emptyFilter()] }) });
    fireEvent.change(screen.getAllByLabelText('筛选文本')[1], { target: { value: '周报' } });
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({
      priority: [3], contexts: [],
      or: [expect.objectContaining({ text: '周报' })],
    }));
  });

  it('删掉一个「或」组', () => {
    const { props } = show({ filter: F({ priority: [3], contexts: [], or: [emptyFilter()] }) });
    fireEvent.click(screen.getByLabelText('删掉第 1 个「或」组'));
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ or: [] }));
  });
});

/**
 * 状态那一维的选项。原来这个组件手抄了一份四个的 `STATUSES`，而「已放弃」是
 * 后加的第五个——于是在「全部」「某个清单」里筛不出已放弃的任务，尽管
 * 「已完成」那个去处一直给它留着一整组。
 */
describe('FilterBar：状态选项跟 STATUSES 是同一份', () => {
  it('每一个状态都选得到，包括已放弃', () => {
    // 筛选栏默认折叠着——先点开，跟这个文件其余用例同一个开场。
    const { container } = show({ filter: emptyFilter() });
    fireEvent.click(btnIn(container, '筛选'));
    // antd 的 Select 要点一下才渲染选项。
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '状态' }));
    const labels = [...document.querySelectorAll('.ant-select-item-option-content')].map((e) => e.textContent);
    for (const s of STATUSES) expect(labels, s).toContain(STATUS_LABEL[s]);
  });
});

/**
 * 「不属于任何清单」「没有标签」两项（仿滴答清单筛选里的「收集箱」「无标签」）。
 * **算什么在 `lib/smartFilter.test.ts`**，这里只测接线：那两项在不在下拉里、
 * 选了之后拆成的是哪两个布尔量。
 */
describe('FilterBar：「没有清单」「没有标签」', () => {
  it('选「不属于任何清单」发的是 noList: true，listIds 一个都不多', () => {
    const { props } = show();
    pickOption('清单', '不属于任何清单');
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ noList: true, listIds: [] }));
  });

  it('**那个哨兵值一个字节都不进 listIds**——存下来的智能清单里不该有一句中文冒充清单 id', () => {
    const { props } = show({ filter: F({ listIds: ['L1'] }) });
    pickOption('清单', '不属于任何清单');
    const [next] = (props.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect((next as SmartFilter).listIds).toEqual(['L1']);
    expect((next as SmartFilter).noList).toBe(true);
  });

  it('noList 为真时那一项在下拉框里是选中的——不然勾过的条件在界面上看不出来', () => {
    show({ filter: F({ noList: true }) });
    openFilterBar();
    expect(screen.getByRole('combobox', { name: '清单' }).closest('.ant-select')?.textContent)
      .toContain('不属于任何清单');
  });

  it('标签那一维同理', () => {
    const { props } = show();
    pickOption('标签', '没有标签');
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ noTag: true, noDue: false, tags: [] }));
  });
});

/**
 * **这一批补的三维 + 「排除」组**（仿 OmniFocus 的自定义视角规则）。判据在
 * `lib/smartFilter.ts`，这一族测的是接线：控件在不在、点了写回什么形状。
 */
describe('FilterBar：重复 / 还没开始 / 预计时长 / 排除组', () => {
  // **取第一个，不是唯一那个**：排除组用的是同一排控件，渲染出来之后同名的
  // 勾选框有两份。第一个是主组——DOM 顺序就是渲染顺序，主组永远在最前。
  const box = (name: string) => screen.getAllByRole('checkbox', { name })[0]!;

  it.each([
    ['只看重复的', 'isRepeating'],
    ['还没开始的', 'notStarted'],
  ] as const)('「%s」点一下写回 %s: true', (label, key) => {
    const { props } = show();
    openFilterBar();
    fireEvent.click(box(label));
    expect((props.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ [key]: true });
  });

  it('已经勾着的显示为勾上——不是每次都从头开始', () => {
    show({ filter: F({ isRepeating: true, notStarted: true }) });
    openFilterBar();
    expect((box('只看重复的') as HTMLInputElement).checked).toBe(true);
    expect((box('还没开始的') as HTMLInputElement).checked).toBe(true);
  });

  it('预计时长那颗有几档预设，选了写回分钟数', () => {
    const { props } = show();
    openFilterBar();
    // 走这个文件既有的开下拉方式（combobox 角色 + mouseDown），不自己另找一套。
    fireEvent.mouseDown(screen.getAllByRole('combobox', { name: '预计时长' })[0]!);
    const opt = [...document.querySelectorAll('.ant-select-item-option')]
      .find((e) => e.textContent === '≤ 30 分钟');
    fireEvent.click(opt!);
    expect((props.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ estimateWithinMinutes: 30 });
  });

  /**
   * **「但不要」空筛选时也给**，跟「或者」那颗相反：「全部，但不要 #工作」
   * 是一句完整有用的话，而「什么都不筛 或者 什么都不筛」不是。
   */
  it('筛选全空时：没有「+ 或者…」，但有「+ 但不要…」', () => {
    show();
    openFilterBar();
    expect(screen.queryByRole('button', { name: /\+ 或者/ })).toBeNull();
    expect(screen.getByRole('button', { name: /\+ 但不要/ })).toBeTruthy();
  });

  it('点「+ 但不要…」加一个空的排除组', () => {
    const { props } = show();
    openFilterBar();
    fireEvent.click(screen.getByRole('button', { name: /\+ 但不要/ }));
    expect((props.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].not).toHaveLength(1);
  });

  it('排除组渲染成一排同样的控件，前面写「但不要」', () => {
    show({ filter: F({ not: [F({ tags: ['工作'] })] }) });
    openFilterBar();
    expect(screen.getByText('但不要')).toBeTruthy();
    expect(document.querySelector('.ink-filter-not')).not.toBeNull();
  });

  it('排除组能删掉', () => {
    const { props } = show({ filter: F({ not: [F({ tags: ['工作'] })] }) });
    openFilterBar();
    fireEvent.click(screen.getByRole('button', { name: '删掉第 1 个「排除」组' }));
    expect((props.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].not).toEqual([]);
  });

  /**
   * **主组改动不能把排除组弄丢。** 那一行的 onChange 是
   * `{ ...g, or: filter.or, not: filter.not }`——漏掉 `not` 的表现是：
   * 加好排除组之后随便动一下主组的任何控件，排除组当场消失。
   */
  it('改主组时排除组还在', () => {
    const { props } = show({ filter: F({ not: [F({ tags: ['工作'] })] }) });
    openFilterBar();
    fireEvent.click(box('只看等待中的'));
    const next = (props.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(next.not).toHaveLength(1);
    expect(next.hasWaitingFor).toBe(true);
  });
});
