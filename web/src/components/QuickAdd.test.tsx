import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { QuickAdd } from './QuickAdd.js';
import { task } from '../test-utils.js';
import type { ComposeDefaults } from '../lib/composeDefaults.js';
import type { List } from '../types.js';
import type { TaskDraft } from './TaskFields.js';

const NOW = new Date(2026, 7, 24, 12);
const SMART_ON = { date: true, stripDate: true, tag: true, stripTag: true };
const NO_DEFAULTS: ComposeDefaults = { listId: null, priority: 0, due: null, tags: [], context: null, remindMinutes: null, smart: SMART_ON };

function show(opts: {
  view?: string;
  defaults?: ComposeDefaults;
  indent?: boolean;
  wide?: boolean;
  lists?: List[];
  onToggleForm?: () => void;
  formOpen?: boolean;
  onCreate?: (d: TaskDraft) => Promise<ReturnType<typeof task>>;
} = {}) {
  const created: TaskDraft[] = [];
  const onToggleForm = opts.onToggleForm ?? vi.fn();
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
        lists={opts.lists ?? []}
        wide={opts.wide}
        onToggleForm={onToggleForm}
        formOpen={opts.formOpen ?? false}
      />
    </AntApp>,
  );
  const input = screen.getByLabelText('添加任务') as HTMLInputElement;
  const type = (v: string) => fireEvent.change(input, { target: { value: v } });
  const enter = () => fireEvent.submit(input.closest('form')!);
  return { created, input, type, enter, onToggleForm };
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

  it('右端那颗按钮开合整张表单——滴答清单桌面版加任务只有「任务添加栏」这一个地方，附加选项挂在输入框右侧', () => {
    const onToggleForm = vi.fn();
    show({ onToggleForm });
    fireEvent.click(screen.getByRole('button', { name: '新任务表单' }));
    // **一次点击只报一次意图，开还是合由持有表单的那一层决定**：这一层自己
    // 不数「现在是开着还是关着」，两份状态迟早对不上。
    expect(onToggleForm).toHaveBeenCalledTimes(1);
  });

  it('表单收着的时候：aria-expanded=false、字形是 ⌄', () => {
    show();
    const btn = screen.getByRole('button', { name: '新任务表单' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toBe('⌄');
  });

  it('表单开着的时候：aria-expanded=true、字形翻成 ⌃——不然只有读屏知道状态', () => {
    show({ formOpen: true });
    const btn = screen.getByRole('button', { name: '新任务表单' });
    expect(btn.getAttribute('aria-expanded'), '表单开着而按钮说没开，那是假状态').toBe('true');
    expect(btn.textContent).toBe('⌃');
  });

  it('屏幕上不写「完整表单」那四个字，名字仍然叫「新任务表单」', () => {
    show();
    expect(screen.queryByText('完整表单'), 'batch4 加的可见文字，用户看了实物之后不要了').toBeNull();
    expect(screen.getByRole('button', { name: '新任务表单' })).toBeTruthy();
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
    expect(await screen.findByText('已添加。没定时间，这条在「按来源」里')).toBeTruthy();
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

// ============================================================================
// 提示条上逐词取消（batch9 I-1）：一句里认对两个、认错一个时，不该被迫三个全撤
// ============================================================================

describe('QuickAdd：点掉某一段的识别', () => {
  const chips = () => [...screen.getByRole('status').querySelectorAll('.ink-smart-chip')];
  const chipTexts = () => chips().map((c) => c.textContent);
  const typeAndChip = (v: string, t: string) => {
    const h = show();
    h.type(v);
    const hit = chips().find((c) => c.textContent === t);
    if (!hit) throw new Error(`提示条上没有「${t}」这颗 chip，实际是 ${JSON.stringify(chipTexts())}`);
    return { ...h, chip: hit };
  };

  it('认出来的每一段是一颗 chip，按识别到的顺序排', () => {
    const { type } = show();
    type('明天下午三点开会 #工作');
    expect(chipTexts()).toEqual(['明天', '下午三点', '#工作']);
  });

  it('点掉「明天」：那几个字回到标题里，「下午三点」照认（落今天 15:00 而不是明天）', async () => {
    const { created, chip, enter } = typeAndChip('明天下午三点开会 #工作', '明天');
    fireEvent.click(chip);
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].title).toBe('明天开会');
    expect(created[0].due).toBe(new Date(2026, 7, 24, 15, 0).toISOString());
    expect(created[0].tags).toEqual(['工作']);
  });

  it('点掉的那颗 chip 从提示条上消失，其余照在——撤一段不牵连别段', () => {
    const { chip } = typeAndChip('明天下午三点开会 #工作', '明天');
    fireEvent.click(chip);
    expect(chipTexts()).toEqual(['下午三点', '#工作']);
  });

  /**
   * 这一行是「连着记五条」的形状，所以每一次「别认」的寿命只能是**一条**。
   * 不重置的话：上一条里点掉了「明天」，下一条同样写了「明天」，它静静地不认——
   * 屏幕上那颗 chip 也不在了，看不出被谁撤的。
   */
  it('建完一条之后重置：下一句同样的话，那颗 chip 又回来了', async () => {
    const { created, chip, enter, type } = typeAndChip('明天下午三点开会 #工作', '明天');
    fireEvent.click(chip);
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    type('明天下午三点开会 #工作');
    expect(chipTexts()).toEqual(['明天', '下午三点', '#工作']);
  });

  /**
   * 撤过的东西记在 `起点|那几个字` 上（见 `smartSpanKey`）。这条钉的是改字之后
   * **既不多撤也不少撤**：删掉「#工作」让后面各段的位置没变、字没变，所以
   * 「明天」还是撤着的（不该悄悄还回来一条他撤过的识别），也不有一颗旧键
   * 伸手管到别的字上。
   */
  it('改字之后：撤过的那段还撤着，没撤的照认', () => {
    const { chip, type } = typeAndChip('明天下午三点开会 #工作', '明天');
    fireEvent.click(chip);
    expect(chipTexts()).toEqual(['下午三点', '#工作']);
    type('明天下午三点开会');
    expect(chipTexts()).toEqual(['下午三点']);
  });
});

// ============================================================================
// 输入框右端那一簇（batch9 I-4）：日期 · 清单 · ⌄
// ============================================================================

describe('QuickAdd：那一簇', () => {
  const LISTS: List[] = [
    { id: 'L1', name: '家里', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
    // 归档的、智能清单都不该出现在候选里（判据跟表单那个下拉框同源）。
    { id: 'L2', name: '另一个', color: '#15803D', folderId: null, order: 1, archived: false, filter: null },
    { id: 'L3', name: '归档清单', color: '#8B8378', folderId: null, order: 2, archived: true, filter: null },
  ];
  const chipTexts = () => [...document.querySelectorAll('.ink-quickadd-chip')].map((e) => e.textContent);
  const pick = (label: string) => {
    const item = [...document.querySelectorAll('.ant-dropdown-menu-item')].find(
      (e) => e.textContent === label,
    ) as HTMLElement | undefined;
    if (!item) throw new Error(`菜单里没有「${label}」，实际是 ${JSON.stringify([...document.querySelectorAll('.ant-dropdown-menu-item')].map((e) => e.textContent))}`);
    fireEvent.click(item);
  };

  it('空着的一行不摆那一簇，⌄ 照旧在——它是开整张表单的唯一入口，不能跟着收', () => {
    show();
    expect(document.querySelector('.ink-quickadd-chip')).toBeNull();
    expect(screen.getByRole('button', { name: '新任务表单' })).toBeTruthy();
  });

  it('一打字那一簇就出来：日期 + 清单', () => {
    const { type } = show({ lists: LISTS });
    type('写周报');
    expect(chipTexts()).toEqual(['日期', '清单']);
  });

  it('一份能归的清单都没有时不摆清单那颗——摆了就是一颗点开是空菜单的按钮', () => {
    const { type } = show({ lists: LISTS.filter((l) => l.archived) });
    type('写周报');
    expect(chipTexts()).toEqual(['日期']);
  });

  it('点日期 chip 选「明天」：建出来的任务截止落在明天全天', async () => {
    const { created, type, enter } = show({ lists: LISTS });
    type('写周报');
    fireEvent.click(document.querySelectorAll('.ink-quickadd-chip')[0]);
    pick('明天');
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    //  NOW 是 2026-08-24 12:00；「明天」= 25 号本地零点（全天就是这么表达的）。
    expect(created[0].due).toBe(new Date(2026, 7, 25, 0, 0).toISOString());
    expect(created[0].title).toBe('写周报');
  });

  /**
   * 这一条是那簇存在的全部理由的反面检查：chip 上写的和建出来用的必须是同一
   * 件事。挑过的排在他打的字前面（`mergePicked` 的 ①），因为点开 chip 是一次
   * 更明确的表达。
   */
  it('标题里认出来的日期 与 挑过的日期 同时存在时，听挑的那个', async () => {
    const { created, type, enter } = show({ lists: LISTS });
    type('明天写周报');
    fireEvent.click(document.querySelectorAll('.ink-quickadd-chip')[0]);
    pick('本周五');
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    // 23:59 不是笔误：认出来的「明天」本来就是**那天结束**（`smartInput.ts` 里
    // 那句「没认出时刻的落 23:59，零点在这个界面里有歧义」），而挑一天只换日期、
    // 保留已有的时分（跟表单日期那一行的快捷档同一条规矩）。
    expect(created[0].due).toBe(new Date(2026, 7, 28, 23, 59).toISOString());
    // 「明天」那两个字的遭遇跟表单里一样：被认走就不进标题。
    expect(created[0].title).toBe('写周报');
  });

  it('挑过的时分保留：先认出「下午三点」再挑「明天」，落明天 15:00 不是明天零点', async () => {
    const { created, type, enter } = show({ lists: LISTS });
    type('明天下午三点写周报');
    fireEvent.click(document.querySelectorAll('.ink-quickadd-chip')[0]);
    pick('明天');
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].due).toBe(new Date(2026, 7, 25, 15, 0).toISOString());
  });

  // 单独一条，不接在上面那条后面：同一回合里 render 两次会留下两个输入框，
  // 那时候任何一句 getByLabelText 都是在说假话。
  it('句子里没有时间时挑一天：chip 上只有日期、不跟一个 00:00——本地零点就是这个应用说「全天」的方式', () => {
    const { type } = show({ lists: LISTS });
    type('写周报');
    fireEvent.click(document.querySelectorAll('.ink-quickadd-chip')[0]);
    pick('明天');
    expect(document.querySelectorAll('.ink-quickadd-chip')[0].textContent).toBe('8月25日');
  });

  /**
   * 站在某份清单里时那一颗 chip 上已经写着这份清单的名字（预填）。再点一次
   * 同一个名字不该被记成「他挑的」——`mergePicked` 的 ① 就是这么判的，而它判的
   * 依据（挑的 == 预填）在界面上唯一的可见结果就是这颗 chip 还留着虚线边。
   */
  it('挑的正好是站着的那份清单时，那颗 chip 还是「认出来的」那一档（没被记成挑过）', () => {
    const { type } = show({ lists: LISTS, defaults: { ...NO_DEFAULTS, listId: 'L1' } });
    type('买灯丝');
    const before = document.querySelectorAll('.ink-quickadd-chip')[1];
    expect(before.textContent).toBe('家里');
    expect(before.className).toContain('ink-quickadd-chip-smart');
    fireEvent.click(before);
    pick('家里');
    const after = document.querySelectorAll('.ink-quickadd-chip')[1];
    expect(after.textContent).toBe('家里');
    expect(after.className).toContain('ink-quickadd-chip-smart');
    // 换一份才算真挑过：虚线边当场变实线。
    fireEvent.click(after);
    pick('另一个');
    expect(document.querySelectorAll('.ink-quickadd-chip')[1].className).not.toContain('ink-quickadd-chip-smart');
  });
  it('点清单 chip 选一份清单：建出来的任务归进去，哪怕站着的地方没有预填', async () => {
    const { created, type, enter } = show({ lists: LISTS });
    type('买灯丝');
    fireEvent.click(document.querySelectorAll('.ink-quickadd-chip')[1]);
    pick('家里');
    enter();
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].listId).toBe('L1');
  });

  /**
   * 值是从标题里认出来的、不是挑的：chip 用虚线边说这件事（跟表单行末那颗
   * 「识别」同一句话）。混在一起的话，「明天」到底是这句里写的还是他点的，
   * 屏幕上就分不出来了。
   */
  it('认出日期时那颗 chip 挂「认出来的」那一档；自己挑过之后变实线', () => {
    const { type } = show({ lists: LISTS });
    type('明天写周报');
    const due = document.querySelectorAll('.ink-quickadd-chip')[0];
    expect(due.textContent).toBe('8月25日 23:59');
    expect(due.className).toContain('ink-quickadd-chip-smart');
    fireEvent.click(due);
    pick('本周五');
    const after = document.querySelectorAll('.ink-quickadd-chip')[0];
    expect(after.textContent).toBe('8月28日 23:59');
    expect(after.className).not.toContain('ink-quickadd-chip-smart');
  });
});
