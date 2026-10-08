import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { TaskFields, emptyDraft, type TaskDraft } from './TaskFields.js';
import { NoMotion, addField } from '../test-utils.js';
import type { List } from '../types.js';

const show = (over: Partial<TaskDraft> = {}, lists: List[] = []) => {
  const onChange = vi.fn();
  const { container } = render(
    <NoMotion><AntApp>
      <TaskFields value={{ ...emptyDraft(), ...over }} onChange={onChange} lists={lists} />
    </AntApp></NoMotion>,
  );
  return { onChange, container };
};

const LISTS: List[] = [
  { id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
  { id: 'L2', name: '生活', color: '#15803D', folderId: null, order: 1, archived: false, filter: null },
  { id: 'L3', name: '归档了的', color: '#0E7490', folderId: null, order: 2, archived: true, filter: null },
  // 智能清单：filter 非 null。不能出现在「归到哪个清单」的候选里——见下面
  // 「智能清单不进候选」那条，task-4-brief 要点③。
  {
    id: 'L4', name: '智能清单', color: '#7E22CE', folderId: null, order: 3, archived: false,
    filter: { status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] },
  },
];

describe('TaskFields：字段顺序', () => {
  it('重复规则紧跟在日期字段后面，不隔着优先级按钮——「什么时候」（含多久一次）该挨在一起，「多重要」是下一件事', () => {
    const { container } = render(
      <NoMotion><AntApp>
        <TaskFields value={emptyDraft()} onChange={() => {}} lists={LISTS} />
      </AntApp></NoMotion>,
    );
    // repeat 留 null（不展开重复规则内部那颗 DatePicker），列表里只有一个
    // 会匹配 .ant-picker 的东西是「截止/提醒」那两颗——省得跟重复规则展开后
    // 自己那颗「重复截止」DatePicker 混在一起，把顺序断言搅浑。
    addField('重复');
    addField('优先级');
    addField('清单');
    addField('标签');
    const sel = ['.ant-picker', '.ink-repeat-row', '.ink-pri-btn', '.ink-list-select', '.ink-tag-row'];
    const order = [...container.querySelectorAll(sel.join(','))]
      .map((el) => sel.find((s) => el.matches(s)))
      // 折叠连续重复：两颗日期选择器都算 .ant-picker，三颗优先级按钮都算
      // .ink-pri-btn，只关心「这一类记号第一次出现在哪」。
      .filter((s, i, arr) => i === 0 || s !== arr[i - 1]);
    expect(order).toEqual(['.ant-picker', '.ink-repeat-row', '.ink-pri-btn', '.ink-list-select', '.ink-tag-row']);
  });

  /**
   * **那一行 `<summary>` 要跟折叠区里装的东西对得上。**
   *
   * 它写的是「收起来的时候你看不见的是哪几样」。列漏了的那几个字段等于在说
   * 「这儿没有」——人会去别处找，或者以为这个应用没有这个功能。
   *
   * 已经漏过三个：`waitingFor`、`estimateMinutes` 是当初加字段时没跟上，
   * `context`（情境）是后来加的、同样没跟上。三个都是「加了字段、忘了这行」。
   *
   * 这条拿**里面真的渲染出来的控件**去比，不是对着一份手抄的名单——加字段的人
   * 只要给它一个 `aria-label`（这个表单里每个控件都有），这条就会红。
   */


  it('「＋ 加一项」的菜单要跟能对上的属性一致——加了字段忘了进菜单会红', () => {
    const { container } = render(
      <NoMotion><AntApp>
        <TaskFields value={emptyDraft()} onChange={() => {}} lists={LISTS} />
      </AntApp></NoMotion>,
    );
    // 这条守卫的**职责没变**：它盯的是「每一维都摸得到、且各处叫同一个名字」。
    // 变的是它去哪儿看——原来那行 `<summary>` 手抄八个名字（加字段时漏过三次：
    // `waitingFor`、`estimateMinutes`、`context`），现在没那一行了，能对上的只有
    // 「＋ 加一项」菜单里的那些按钮。
    const NAMES: Array<[string, string]> = [
      ['重复', '重复'],
      ['在等谁或等什么', '在等谁'],
      ['预计时长（分钟）', '预计时长'],
      ['什么条件下能做', '情境'],
      ['归到哪个清单', '清单'],
      ['加标签', '标签'],
    ];
    const menu = [...container.querySelectorAll('[aria-label^="加一项："]')]
      .map((e) => (e.getAttribute('aria-label') ?? '').replace('加一项：', ''));
    for (const [, short] of NAMES) {
      expect(menu, `「＋ 加一项」菜单里没有「${short}」——这一维谁也加不出来`).toContain(short);
    }
    // 优先级没有 aria-label（三颗按钮各自带文字），单独钉一句。
    expect(menu).toContain('优先级');
    // 分段/上级这两维以前就漏在 summary 之外过，一起钉住。
    expect(menu).toContain('分段');
    expect(menu).toContain('上级任务');
    // 反过来也要成立：菜单里列的每一维，点下去得真的长出东西（挡「菜单列了个
    // 不存在的字段」）。挑一维验一次机制，其余各维由它们自己的用例覆盖。
    fireEvent.click(screen.getByLabelText('加一项属性'));
    fireEvent.click(screen.getByLabelText('加一项：优先级'));
    expect(container.querySelector('.ink-pri-btn')).toBeTruthy();
  });
});

/**
 * 2026-08-17-debt-sweep #6：偶尔用一次的表单摊开 12 个控件（选了「每周」之后
 * 21 个）读起来吵——measure-ui.mjs 量出来的数字。重复/优先级/清单/标签四组
 * 收进一个 <details>，默认收起。
 *
 * jsdom 不实现「关闭的 <details> 隐藏非 summary 子节点」这条 UA 默认样式
 * （见 node_modules/jsdom 的 default-stylesheet.css，没有那条规则），所以
 * 上面「优先级」「标签」「清单」几组直接用 getByRole/getByLabelText 找控件的
 * 测试，不管 <details> 开没开都照样能找到、点得到——那些测试测不出「默认收起」
 * 这件事本身有没有做对，得单独断言 `open` 这个 DOM 属性。
 */


describe('TaskFields：优先级', () => {
  it('emptyDraft 的优先级是 0（无）——新建任务不替人做判断', () => {
    expect(emptyDraft().priority).toBe(0);
  });

  it('四个档位都能选到，选中的值原样传出去', () => {
    const { onChange } = show();
    addField('优先级');
    fireEvent.click(screen.getByRole('button', { name: '高' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ priority: 3 }));
  });

  it('再点一次当前档位就清回 0——不用另外找一个「无」按钮', () => {
    const { onChange } = show({ priority: 3 });
    fireEvent.click(screen.getByRole('button', { name: '高' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ priority: 0 }));
  });

  it('当前档位标成按下状态，别的没有', () => {
    show({ priority: 2 });
    expect(screen.getByRole('button', { name: '中' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '高' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '低' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('改优先级不碰别的字段', () => {
    // 精确匹配、不用 objectContaining——这条测试的题目就是「不碰别的字段」，
    // objectContaining 只挡得住「丢字段」，挡不住「悄悄改了没在断言里列出来
    // 的那个字段」（比如把 remindAt 一起清空）。改成 draft 全量展开之后，
    // 以后 TaskDraft 加新字段这条断言自动纳入，不用回来补。
    const over = { title: '写周报', notes: '找老王要数据', due: '2026-08-20T00:00:00.000Z', reminders: ['2026-08-21T09:00:00.000Z'] };
    const draft = { ...emptyDraft(), ...over };
    const { onChange } = show(over);
    addField('优先级');
    fireEvent.click(screen.getByRole('button', { name: '低' }));
    expect(onChange).toHaveBeenCalledWith({ ...draft, priority: 1 });
  });
});

describe('TaskFields：标签', () => {
  it('emptyDraft 的标签是空数组', () => {
    expect(emptyDraft().tags).toEqual([]);
  });

  it('输入框回车加一个', () => {
    const { onChange } = show();
    addField('标签');
    const box = screen.getByLabelText('加标签');
    fireEvent.change(box, { target: { value: '工作' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tags: ['工作'] }));
  });

  it('去首尾空白', () => {
    const { onChange } = show();
    addField('标签');
    const box = screen.getByLabelText('加标签');
    fireEvent.change(box, { target: { value: '  工作  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tags: ['工作'] }));
  });

  it('空的和纯空白不加——服务端现在也会清洗，但这一层挡在 onChange 之前，不该让空标签先在界面上闪一下', () => {
    const { onChange } = show();
    addField('标签');
    const box = screen.getByLabelText('加标签');
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('重复的不加第二遍', () => {
    const { onChange } = show({ tags: ['工作'] });
    const box = screen.getByLabelText('加标签');
    fireEvent.change(box, { target: { value: '工作' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  // 上面「重复的不加第二遍」走的是否定分支（不重复的名字回车不生效），验证不到
  // 「新名字到底有没有接在已有标签后面」——`tags: [name]`（把整份列表换成只有
  // 新加的这一个）在那条测试下跟正确实现 `tags: [...value.tags, name]` 长得
  // 一模一样，都是「onChange 没被调用」。这条测试必须用已有非空标签 + 一个
  // 新名字，才测得出「追加」和「覆盖」的区别——现实后果是加第二个标签会把
  // 第一个冲掉。
  it('第二个标签追加在已有的后面，不是把前面的冲掉', () => {
    const { onChange } = show({ tags: ['工作'] });
    const box = screen.getByLabelText('加标签');
    fireEvent.change(box, { target: { value: '生活' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tags: ['工作', '生活'] }));
  });

  it('每个胶囊各删各的——不是永远删第一个', () => {
    const { onChange } = show({ tags: ['甲', '乙', '丙'] });
    fireEvent.click(screen.getByRole('button', { name: '删掉标签 乙' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tags: ['甲', '丙'] }));
  });
});

describe('TaskFields：清单', () => {
  it('emptyDraft 的 listId 是 null', () => {
    expect(emptyDraft().listId).toBeNull();
  });

  it('选一个清单，id 原样传出去', () => {
    const { onChange } = show({}, LISTS);
    addField('清单');
    fireEvent.change(screen.getByLabelText('归到哪个清单'), { target: { value: 'L2' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ listId: 'L2' }));
  });

  it('归档的清单不出现在选项里', () => {
    show({}, LISTS);
    addField('清单');
    const opts = [...screen.getByLabelText('归到哪个清单').querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toContain('工作');
    expect(opts).not.toContain('归档了的');
  });

  it('一条清单都没有时下拉仍然在——藏掉的话用户永远不知道有这回事', () => {
    show({}, []);
    addField('清单');
    const select = screen.getByLabelText('归到哪个清单');
    expect(select).toBeTruthy();
    // 光断言下拉框存在挡不住「把 <option value=""> 那一行删掉」这种变异——
    // select 本身还在，只是空的，实测这条没变红。补一条断言那个选项确实在，
    // 才逼得出「藏掉唯一选项」和「藏掉整个下拉框」的区别。
    const opts = [...select.querySelectorAll('option')].map((o) => o.textContent);
    // 那个「没有」的选项现在只写一个字：字段名交给了左边那颗常驻标签
    // （`.ink-field-cap`「清单」），选项里再念一遍「不属于任何清单」是同一件事
    // 说两遍。**断言强度没变**——还是整个选项列表逐字相等，删掉那一行照样红。
    expect(opts).toEqual(['无']);
  });

  // 审查 Minor：归档的清单默认不进候选，但一条任务当下就挂在某个后来被
  // 归档的清单上时，得给它开个例外——不然下拉框显示「无」，
  // 跟旁边 TaskCard 卡片上照样画着的竖条/清单名自相矛盾（TaskCard 的
  // lists.find() 不看 archived）。
  it('已经归到一个后来被归档的清单：下拉框仍然选中它、选项里也看得到，不假装成「无」', () => {
    show({ listId: 'L3' }, LISTS); // L3 = '归档了的'，archived: true
    const select = screen.getByLabelText('归到哪个清单') as HTMLSelectElement;
    expect(select.value).toBe('L3');
    const opts = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toContain('归档了的');
  });

  it('选「不属于任何清单」写回 null，不是空字符串', () => {
    const { onChange } = show({ listId: 'L1' }, LISTS);
    fireEvent.change(screen.getByLabelText('归到哪个清单'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ listId: null }));
  });

  // 上限：智能清单（filter 非 null）不进候选——把任务的 listId 指到一个
  // 查询上，那条任务在导航里哪儿都找不到（智能清单按 applyFilter 取任务，
  // 不看 listId），见 task-4-brief 要点③。
  it('智能清单不进候选——上限', () => {
    show({}, LISTS);
    addField('清单');
    const opts = [...screen.getByLabelText('归到哪个清单').querySelectorAll('option')].map((o) => o.textContent);
    // 中间断言：先证明普通清单确实在候选里，不是整个下拉是空的
    // （上限断言在功能没接上时天然成立，见 parked-all.md 第 97 条）。
    expect(opts).toContain('工作');
    expect(opts).not.toContain('智能清单');
  });
});

/**
 * 提醒的「提前多久」预设（仿滴答清单）。**算什么在 `lib/remindPreset.test.ts`**
 * ——这里只测接线：什么时候出现、点了发什么、哪一颗亮。
 */
describe('TaskFields：提醒预设', () => {
  const DUE = new Date(2026, 7, 20, 9).toISOString();
  const preset = (label: string) =>
    screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === label.replace(/\s/g, ''));

  const START = new Date(2026, 7, 20, 9).toISOString();
  const END = new Date(2026, 7, 20, 12).toISOString();

  it('什么时间都没设，整排不出现——「提前」没有参照物，点了算不出时刻', () => {
    show();
    expect(preset('准时')).toBeUndefined();
  });

  it('有截止时间就摆出来', () => {
    show({ due: DUE });
    expect(preset('提前 30 分钟')).toBeTruthy();
  });

  /**
   * **这一条是第六批留下的半截。** 时间段是上一批加的（`startAt`+`endAt`，
   * 日历上占一段高度），提醒预设却还整排锚死在 `due` 上——于是一场只有时间段、
   * 没有截止时间的会，**一档都点不出来**。锚点判据现在跟日历落格共用
   * `calendarAnchor`，见 `lib/remindPreset.ts` 的 `remindAnchorAt`。
   */
  it('**只有时间段、没有截止时间的会，现在也摆得出来**——按起点算', () => {
    const { onChange } = show({ due: null, startAt: START, endAt: END });
    expect(preset('提前 30 分钟')).toBeTruthy();
    fireEvent.click(preset('提前 30 分钟')!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      reminders: [new Date(2026, 7, 20, 8, 30).toISOString()],
    }));
  });

  it('**有时间段时「结束时」多出一颗**（仿滴答清单），点出来就是结束那一刻', () => {
    const { onChange } = show({ due: null, startAt: START, endAt: END });
    expect(preset('结束时')).toBeTruthy();
    fireEvent.click(preset('结束时')!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reminders: [END] }));
  });

  it('没有时间段就没有「结束时」这一颗——摆一颗点了算不出时刻的按钮比没有更糟', () => {
    show({ due: DUE });
    expect(preset('结束时')).toBeUndefined();
  });

  it('**「准时」和「结束时」各亮各的**——分钟数一样，锚点不一样', () => {
    show({ due: null, startAt: START, endAt: END, reminders: [END] });
    expect(preset('结束时')!.getAttribute('aria-pressed')).toBe('true');
    expect(preset('准时')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('点一档发的是算好的绝对时刻——不用自己看一眼截止再心算', () => {
    const { onChange } = show({ due: DUE });
    fireEvent.click(preset('提前 30 分钟')!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      reminders: [new Date(2026, 7, 20, 8, 30).toISOString()],
    }));
  });

  it('对得上的那一颗是按下去的，别的没有', () => {
    show({ due: DUE, reminders: [new Date(2026, 7, 20, 8, 30).toISOString()] });
    expect(preset('提前 30 分钟')!.getAttribute('aria-pressed')).toBe('true');
    expect(preset('准时')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('自己挑的绝对时刻对不上任何一档，一颗都不亮——不谎报', () => {
    show({ due: DUE, reminders: [new Date(2026, 7, 20, 8, 31).toISOString()] });
    for (const p of ['准时', '提前 5 分钟', '提前 30 分钟', '提前 1 小时', '提前 1 天', '提前 2 天']) {
      expect(preset(p)!.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('再点一次按下去的那颗就清掉提醒——点亮的是开关，不是拔不出来的单选钮', () => {
    const { onChange } = show({ due: DUE, reminders: [new Date(2026, 7, 20, 8, 30).toISOString()] });
    fireEvent.click(preset('提前 30 分钟')!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reminders: [] }));
  });
});

/**
 * 备注框里的「/」菜单（仿滴答清单任务描述里的斜杠命令）。**算什么在
 * `lib/slashMenu.test.ts`**——那边测什么时候该弹、光标落哪；这里只测接线。
 */
describe('TaskFields：备注的「/」菜单', () => {
  const notes = () => screen.getByPlaceholderText(/^备注/) as HTMLTextAreaElement;

  /**
   * **这一组要一个有状态的外壳**，不能用上面那个 `show()`：那个把 `value`
   * 钉死在夹具上（`onChange` 只是个 spy），textarea 是受控的，打进去的字
   * 下一帧就被回滚成原样——而「/」菜单整个就是「随着框里的文字变化」这件事。
   */
  const showLive = () => {
    const onChange = vi.fn();
    function Harness() {
      const [v, setV] = useState<TaskDraft>(emptyDraft());
      return (
        <TaskFields
          value={v}
          onChange={(next) => { onChange(next); setV(next); }}
          lists={[]}
        />
      );
    }
    render(<NoMotion><AntApp><Harness /></AntApp></NoMotion>);
    return { onChange };
  };

  /**
   * 菜单里那几条。**必须限定在 listbox 里面**：这张表单里还有原生 `<select>`
   * （归到哪个清单、上级任务），`<option>` 元素的隐含 role 就是 `option`，
   * 满页 `getAllByRole('option')` 会把它们一起捞进来。
   */
  const options = () => within(screen.getByRole('listbox', { name: '插入' })).getAllByRole('option');

  /** 在备注框里打字并把光标放到末尾——jsdom 的 change 不会自己动 selection。 */
  const type = (text: string) => {
    const el = notes();
    fireEvent.change(el, { target: { value: text, selectionStart: text.length } });
    return el;
  };

  it('占位符就把这件事说出来——备注按 Markdown 渲染，界面上以前一个字都没说过', () => {
    showLive();
    expect(notes().placeholder).toContain('/');
  });

  it('打一个斜杠就弹出全部片段', () => {
    showLive();
    type('/');
    expect(screen.getByRole('listbox', { name: '插入' })).toBeTruthy();
    expect(within(screen.getByRole('listbox', { name: '插入' })).getByRole('option', { name: '代码块' })).toBeTruthy();
  });

  it('接着打字就筛', () => {
    showLive();
    type('/todo');
    expect(options().map((o) => o.textContent)).toEqual(['待办项']);
  });

  it('**日期里的斜杠不弹**——那才是斜杠最常见的用法', () => {
    showLive();
    type('2026/08/22');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('筛不到就收起来，不摆一个空框', () => {
    showLive();
    type('/zzz');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('点一条：把 /命令 换成片段发出去', () => {
    const { onChange } = showLive();
    type('买菜 /l');
    fireEvent.mouseDown(within(screen.getByRole('listbox', { name: '插入' })).getByRole('option', { name: '无序列表' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ notes: '买菜 - ' }));
  });

  it('第一条默认选中，↓ 换一条，回车插的是换过之后那条', () => {
    const { onChange } = showLive();
    const el = type('/');
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ notes: '- ' }));
  });

  it('Esc 收起来，什么都不插', () => {
    const { onChange } = showLive();
    const el = type('/');
    onChange.mockClear();
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('**菜单没开时回车就是换行**——那是备注框最基本的行为，不能看情况', () => {
    const { onChange } = showLive();
    const el = type('买菜');
    onChange.mockClear();
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

/**
 * 多个提醒。表单以前只编辑得到第一个，第二条及以后靠 TaskCard 保存时
 * `t.reminders.slice(1)` 原样接回去才没被抹掉——也就是说 AI 拆出来的、
 * 或者别处写进去的第二个提醒，在界面上既看不见也删不掉。
 */
describe('TaskFields：多个提醒', () => {
  const pickers = () => screen.getAllByPlaceholderText(/提醒时间|再提醒一次/);

  it('一个都没有时摆一个空的——那个空选择器本身就是「加一个」按钮', () => {
    show();
    expect(pickers()).toHaveLength(1);
    expect(pickers()[0].getAttribute('placeholder')).toBe('提醒时间');
  });

  it('**已有的每个都摆出来，末尾再多一个空的**', () => {
    show({ reminders: ['2026-08-20T01:00:00.000Z', '2026-08-20T02:00:00.000Z'] });
    expect(pickers()).toHaveLength(3);
    expect(pickers()[2].getAttribute('placeholder')).toBe('再提醒一次');
  });

  it('第二个及以后**看得见**——以前它们在界面上既看不见也删不掉', () => {
    show({ reminders: ['2026-08-20T01:00:00.000Z', '2026-08-20T02:00:00.000Z'] });
    expect((pickers()[1] as HTMLInputElement).value).toBeTruthy();
  });

  it('两档预设可以同时点亮，加的是两个提醒不是换掉一个', () => {
    const DUE = new Date(2026, 7, 20, 9).toISOString();
    const both = [new Date(2026, 7, 19, 9).toISOString(), new Date(2026, 7, 20, 8, 30).toISOString()];
    show({ due: DUE, reminders: both });
    const on = (label: string) => screen.getAllByRole('button')
      .find((b) => b.textContent?.replace(/\s/g, '') === label.replace(/\s/g, ''))!
      .getAttribute('aria-pressed');
    expect(on('提前 1 天')).toBe('true');
    expect(on('提前 30 分钟')).toBe('true');
  });

  it('点一档时把它加进现有的那几个里，不覆盖', () => {
    const DUE = new Date(2026, 7, 20, 9).toISOString();
    const dayBefore = new Date(2026, 7, 19, 9).toISOString();
    const { onChange } = show({ due: DUE, reminders: [dayBefore] });
    fireEvent.click(screen.getAllByRole('button')
      .find((b) => b.textContent?.replace(/\s/g, '') === '提前30分钟')!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      reminders: [dayBefore, new Date(2026, 7, 20, 8, 30).toISOString()],
    }));
  });
});

/**
 * 「当成习惯」。**这个字段以前界面上根本没有入口**：习惯那个去处、连续天数、
 * 月度打卡表、日历上的打卡记号整套都在，而唯一能标出一个习惯的办法是手改
 * `data/tasks/` 下的 JSON——那一页的空状态还写着「把一条任务标记成习惯」，
 * 指着一个不存在的开关。
 */
describe('TaskFields：当成习惯', () => {
  const DAILY = { every: 'day' as const, interval: 1, weekdays: [], until: null, from: 'due' as const, count: null, step: 0, monthDay: null };
  const box = () => screen.queryByLabelText(/当成习惯/);

  it('不重复的任务上不出现', () => {
    show();
    expect(box()).toBeNull();
  });

  it('**「每天」「每周」以外的重复档上不出现**——习惯那些去处只认这两档，别的档标了也不会出现在那儿，一个勾了没反应的勾选框比没有更糟', () => {
    show({ repeat: { ...DAILY, every: 'month', monthDay: 1 } });
    expect(box()).toBeNull();
  });

  it('选了「每天」就出现', () => {
    show({ repeat: DAILY });
    expect(box()).toBeTruthy();
  });

  /** 「一周三次」也是习惯——这是放宽之后新加的那一档，见 `habit.ts` 的 `HABIT_EVERY`。 */
  it('选了「每周」也出现', () => {
    show({ repeat: { ...DAILY, every: 'week', weekdays: [1, 3, 5] } });
    expect(box()).toBeTruthy();
  });

  it('勾上报出去', () => {
    const { onChange } = show({ repeat: DAILY });
    fireEvent.click(box()!);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ habit: true }));
  });

  it('已经是习惯的显示成勾着的', () => {
    show({ repeat: DAILY, habit: true });
    expect((box() as HTMLInputElement).checked).toBe(true);
  });

  /**
   * 重复改成当不了习惯的档时，这个标记要跟着清掉。**不清会卡死**：勾选框只在
   * 「每天」「每周」时才渲染，而 `habit` 还是 true——这条任务就成了一个
   * **哪儿都不显示、又在界面上取消不掉的习惯**。
   */
  const pickEvery = (label: string) => {
    fireEvent.change(screen.getByLabelText('重复'), { target: { value: label } });
  };

  it('**改成当不了习惯的重复档时，一并取消习惯标记**——不取消的话它就卡在一个界面上回不去的状态里', () => {
    const { onChange } = show({ repeat: DAILY, habit: true });
    pickEvery('month');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ habit: false }));
  });

  /** 反过来：**「每天」改「每周」不该清掉它**，两档都当得了习惯。
   *  这一条是从上面那条里分出来的——原来「每天 → 每周」就是清掉的那一支。 */
  it('「每天」改「每周」时留着——两档都当得了习惯', () => {
    const { onChange } = show({ repeat: DAILY, habit: true });
    pickEvery('week');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ habit: true }));
  });

  it('改成「不重复」同理', () => {
    const { onChange } = show({ repeat: DAILY, habit: true });
    pickEvery('');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ repeat: null, habit: false }));
  });

  it('仍然是「每天」时不动它——改间隔、改截止都不该把习惯标记弄没', () => {
    const { onChange } = show({ repeat: DAILY, habit: true });
    fireEvent.change(screen.getByLabelText('每几个'), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ habit: true }));
  });
});

/**
 * 「在等」。这个字段**服务端和 AI 一直都写得进**（AGENTS.md：「等张老师回
 * 邮件」是原文里的事实，AI 拆解时就能填），筛选栏也一直有「只看等待中的」
 * ——只有人自己没有任何地方能填它、也没有任何地方能清掉它。
 */
describe('TaskFields：在等', () => {
  const box = () => screen.getByLabelText('在等谁或等什么') as HTMLInputElement;

  it('已有的值显示出来', () => {
    show({ waitingFor: '张老师回邮件' });
    expect(box().value).toBe('张老师回邮件');
  });

  it('没在等时是空的，不是字符串 "null"', () => {
    show();
    addField('在等谁');
    expect(box().value).toBe('');
  });

  it('填了报上去', () => {
    const { onChange } = show();
    addField('在等谁');
    fireEvent.change(box(), { target: { value: '张老师回邮件' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ waitingFor: '张老师回邮件' }));
  });

  it('**清空就是 null，不是空字符串**——「只看等待中的」按 null 和空白一起判，留个空串等于还在等', () => {
    const { onChange } = show({ waitingFor: '张老师回邮件' });
    fireEvent.change(box(), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ waitingFor: null }));
  });

  it('只打了空格也算清空', () => {
    const { onChange } = show({ waitingFor: '张老师回邮件' });
    fireEvent.change(box(), { target: { value: '   ' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ waitingFor: null }));
  });
});

/**
 * 键盘保存 / 键盘取消。**哪个键算什么在 `lib/keymap.test.ts`（含输入法守卫）**，
 * 这里只测接线：挂在哪两个框上、没挂在哪些框上。
 */
describe('TaskFields：键盘保存 / 取消', () => {
  const showKeys = (over: Partial<TaskDraft> = {}) => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <NoMotion><AntApp>
        <TaskFields
          value={{ ...emptyDraft(), ...over }}
          onChange={vi.fn()}
          lists={LISTS}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </AntApp></NoMotion>,
    );
    return { onSubmit, onCancel, container };
  };

  const title = () => screen.getByPlaceholderText('标题');
  const notes = () => screen.getByPlaceholderText('备注（支持 Markdown，输入 / 插入格式）');

  it('标题框里回车 = 保存——这个表单一展开光标就在这儿，键盘那条路只差这最后一下', () => {
    const { onSubmit } = showKeys();
    fireEvent.keyDown(title(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('备注框里回车**不**保存——那是换行，是多行框最基本的行为', () => {
    const { onSubmit } = showKeys();
    fireEvent.keyDown(notes(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('备注框里 Ctrl + 回车保存', () => {
    const { onSubmit } = showKeys();
    fireEvent.keyDown(notes(), { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('两个框里 Esc 都是取消', () => {
    const a = showKeys();
    fireEvent.keyDown(title(), { key: 'Escape' });
    expect(a.onCancel).toHaveBeenCalledTimes(1);
  });

  it('输入法组字中按回车不保存——那一下是上屏候选词', () => {
    const { onSubmit } = showKeys();
    fireEvent.keyDown(title(), { key: 'Enter', keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('**标签输入框里的回车是「加上这个标签」，不保存**——它自己那条路不能被抢走', () => {
    const { onSubmit } = showKeys();
    addField('标签');
    fireEvent.change(screen.getByLabelText('加标签'), { target: { value: '写作' } });
    fireEvent.keyDown(screen.getByLabelText('加标签'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('**日期框里的 Esc 不取消编辑**——那一下是「关掉这个弹层」，冒到外面就成了「按一下 Esc 关个日期框、顺手把草稿全扔了」', () => {
    const { onCancel } = showKeys();
    fireEvent.keyDown(screen.getByPlaceholderText('截止时间'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('不给这两个 prop 就是老样子，一个键都不认', () => {
    render(
      <NoMotion><AntApp>
        <TaskFields value={emptyDraft()} onChange={vi.fn()} lists={LISTS} />
      </AntApp></NoMotion>,
    );
    // 不抛就算过：没有 onSubmit/onCancel 时那两个分支整个不执行。
    fireEvent.keyDown(screen.getByPlaceholderText('标题'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByPlaceholderText('标题'), { key: 'Escape' });
  });
});

// ── 备注的「写 / 看」两态 ──
// 斜杠菜单插的就是 markdown，但插完是**盲写**的：存了才知道长什么样。
// 这颗开关补的是那一半——不做富文本编辑器，源码始终是那段纯文本。
describe('TaskFields：备注预览', () => {
  const MD = '## 交接\n\n- 找搬家公司\n- 退租提前 **30 天**\n\n> 押金月底退';

  it('**备注空的时候不出现这颗按钮**——空备注上摆一颗「预览」是让人去预览一片空白', () => {
    const { container } = show({ notes: '' });
    expect(container.querySelector('.ink-md-toggle')).toBeNull();
    show({ notes: '   ' });
    expect(document.querySelectorAll('.ink-md-toggle')).toHaveLength(0);
  });

  it('写了东西才出现', () => {
    const { container } = show({ notes: '随便写点' });
    expect(within(container).getByRole('button', { name: '预览' })).toBeTruthy();
  });

  it('点「预览」：编辑框换成渲染结果，按钮变「继续写」', () => {
    const { container } = show({ notes: MD });
    expect(container.querySelector('.ink-slash-wrap')).not.toBeNull();

    fireEvent.click(within(container).getByRole('button', { name: '预览' }));

    expect(container.querySelector('.ink-slash-wrap'), '编辑框该收起来').toBeNull();
    const pv = container.querySelector('.ink-md-preview');
    expect(pv, '预览框没出现').not.toBeNull();
    expect(pv!.querySelector('h2')?.textContent).toBe('交接');
    expect(pv!.querySelectorAll('li')).toHaveLength(2);
    expect(pv!.querySelector('strong')?.textContent).toBe('30 天');
    expect(pv!.querySelector('blockquote')).not.toBeNull();
    expect(within(container).getByRole('button', { name: '继续写' })).toBeTruthy();
  });

  it('**点「继续写」切回去，源码一个字没变**——这是「两态切换」跟「富文本编辑器」的分界：那边编辑的是渲染结果，这边编辑的始终是同一段纯文本', () => {
    const { container } = show({ notes: MD });
    fireEvent.click(within(container).getByRole('button', { name: '预览' }));
    fireEvent.click(within(container).getByRole('button', { name: '继续写' }));
    const ta = container.querySelector('.ink-slash-wrap textarea') as HTMLTextAreaElement;
    expect(ta, '编辑框该回来').not.toBeNull();
    expect(ta.value).toBe(MD);
  });

  it('aria-pressed 说清这颗是个开关，不是个动作按钮', () => {
    const { container } = show({ notes: MD });
    const btn = within(container).getByRole('button', { name: '预览' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(within(container).getByRole('button', { name: '继续写' }).getAttribute('aria-pressed')).toBe('true');
  });
});
/**
 * 一格一行、**只渲染上过屏的属性**（batch5 的三段式重构，E2）。
 *
 * 原来是一个 `<details>` 一展开把九个字段全倒出来：摊开 12 个控件、选了「每周」
 * 之后 21 个（measure-ui.mjs 量的，见 2026-08-17-debt-sweep #6）。参照的三家
 * （滴答 / Todoist / Things）一致是：默认露出的不超过 5 个，没填的不占地方，
 * 靠一个「＋」请出来。
 */
describe('TaskFields：属性行与「＋ 加一项」', () => {
  const rows = (c: HTMLElement) =>
    [...c.querySelectorAll('.ink-frow-nm')].map((e) => e.textContent);

  it('新建时空白表单没有那些可选格子，只有「＋ 加一项」列着它们', () => {
    const { container } = show();
    const r = rows(container);
    for (const name of ['重复', '清单', '标签', '优先级']) {
      expect(r, `没设过的「${name}」不该一上来就摆着`).not.toContain(name);
    }
    const menu = container.querySelector('[aria-label="加一项属性"]');
    expect(menu, '「＋ 加一项」不见了——那些字段就没有入口了').toBeTruthy();
  });

  it('每一行右边都有那颗 ›，包括「＋ 加一项」——入口跟字段长得一样，人才知道它也能点开', () => {
    const { container } = show();
    const wraps = [...container.querySelectorAll('.ink-frow-wrap')];
    expect(wraps.length).toBeGreaterThan(1);
    for (const w of wraps) {
      expect(w.querySelector('.ink-frow-chev'), `${w.querySelector('.ink-frow-nm')?.textContent} 那一行少了箭头`).toBeTruthy();
    }
  });

  it('「＋ 加一项」那串点名不占值槽——它是入口，不是这条任务的什么属性', () => {
    const { container } = show();
    const add = container.querySelector('[aria-label="加一项属性"]');
    expect(add?.querySelector('.ink-frow-val'), '点名串用了 .ink-frow-val：它会跟「截止 10月3日」一样粗，读起来像个值').toBeFalsy();
    expect(add?.querySelector('.ink-frow-hint')?.textContent).toContain('重复');
  });

  it('「＋ 加一项」分三段摆，分组之后一维都不能丢', () => {
    const { container } = show();
    fireEvent.click(screen.getByLabelText('加一项属性'));
    const groups = [...container.querySelectorAll('.ink-fadd-group')].map((g) => ({
      cap: g.querySelector('.ink-fadd-cap')?.textContent,
      items: [...g.querySelectorAll('[aria-label^="加一项："]')]
        .map((e) => (e.getAttribute('aria-label') ?? '').replace('加一项：', '')),
    }));
    expect(groups.map((g) => g.cap)).toEqual(['节奏', '归属', '标记']);
    // 摊平之后必须正好是那九维、不重不漏——分组是排版，不是筛子。
    expect(groups.flatMap((g) => g.items).sort()).toEqual(
      ['上级任务', '分段', '在等谁', '情境', '优先级', '标签', '清单', '预计时长', '重复'].sort(),
    );
    // 「归属」那一组是三个容器（清单 / 分段 / 上级任务）——分组的理由就在这儿，
    // 它们原来散在菜单两头。
    expect(groups.find((g) => g.cap === '归属')!.items).toEqual(['清单', '分段', '上级任务']);
  });

  it('这条任务本来带着的属性，一上来就有一格、而且写着值', () => {
    const { container } = show({ priority: 3, tags: ['界面'], listId: 'L1', waitingFor: '张老师回邮件' }, LISTS);
    const text = container.textContent ?? '';
    expect(text).toContain('优先级');
    expect(text).toContain('高');
    expect(text).toContain('#界面');
    expect(text).toContain('工作');
    expect(text).toContain('张老师回邮件');
  });

  it('点「＋ 加一项」挑一维，那一格就出来并当场展开', () => {
    const { container } = show();
    addField('预计时长');
    expect(rows(container)).toContain('预计时长');
    expect(screen.getByLabelText('预计时长（分钟）')).toBeTruthy();
  });

  it('清空一个值，那一格**不会当场消失**——人正在改它，控件不能被抽走', () => {
    const { onChange } = show({ waitingFor: '张老师回邮件' });
    const box = screen.getByLabelText('在等谁或等什么') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '' } });
    expect(onChange).toHaveBeenCalled();
    expect(rows(containerOf(box))).toContain('在等谁');
  });

  it('同一时刻只开一格：点开「清单」之后「标签」那一格是收着的', () => {
    const { container } = show({ tags: ['a'], listId: 'L1' }, LISTS);
    const closed = () => [...container.querySelectorAll('.ink-frow-editor-closed')].length;
    const listRow = [...container.querySelectorAll('.ink-frow')]
      .find((b) => b.textContent?.includes('清单'))!;
    fireEvent.click(listRow);
    expect(screen.getByLabelText('归到哪个清单').closest('.ink-frow-editor-closed')).toBeNull();
    expect(closed()).toBeGreaterThan(0);
  });
});

const containerOf = (el: HTMLElement) => el.closest('.ink-frow-wrap') as HTMLElement;

// ============================================================================
// 一列的左边线（batch9 I-2 / I-3）：图标列没了、标题与备注不画自己那一圈
// ============================================================================

describe('TaskFields：属性行那一列的左边线', () => {
  /**
   * 十行属性原来一列里两种记号语言：📅 📍 🏷 是彩色 emoji（跟着系统字体换脸，
   * 而且「重复」在卡片上画 ↻、在这里画 🔁——同一件事两个记号），⚑ ▤ ↳ ⏱ 是
   * 单色字形。每行本来就写着名字，所以整列去掉。这条钉住它不回来。
   */
  it('属性行里没有图标列——名字就是那一行的开头', () => {
    const { container } = show();
    expect(container.querySelector('.ink-frow .ink-frow-ic'), '图标列又长回来了').toBeNull();
  });

  it('「＋ 加一项」的 ＋ 写在名字里（它是动作，不是记号，不该占一列）', () => {
    const { container } = show();
    const add = [...container.querySelectorAll('.ink-frow-nm')].find((e) => e.textContent?.includes('加一项'));
    expect(add?.textContent).toBe('＋ 加一项');
  });

  /**
   * 标题框和备注框各带一圈细边框，跟卡片自己那一圈同色——三层框线读成「框里有
   * 框」。去掉里面两圈之后，这一屏只剩卡片那一圈 + 段与段之间的底线。
   * 类挂没挂上是 JSX 这一半的判据（样式那一半在 theme.css.test.ts 钉）。
   */
  it('标题框和备注框都挂着「不画自己那一圈」那个类', () => {
    const { container } = show();
    expect(container.querySelector('input.ink-field-bare'), '标题框没挂上').toBeTruthy();
    expect(container.querySelector('textarea.ink-field-bare'), '备注框没挂上').toBeTruthy();
  });
});

// ============================================================================
// smartPreview：行上显示「按这句话建出来会长什么样」（batch9 I-5）
// ============================================================================

/**
 * 按名字找某一维那一行。**不能拿 `textContent.includes(名字)` 找**——
 * 「＋ 加一项」那一行的点名里也写着「标签 · 情境 · 清单」，按文字找会撞上它
 * （第一版就是这么假通过的）。认名字那一格才对。
 */
const attrRow = (root: ParentNode, name: string): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>('.ink-frow')].find((r) => r.querySelector('.ink-frow-nm')?.textContent === name);

describe('TaskFields：smartPreview 只改行上显示的那个值', () => {
  const open = (over: Partial<TaskDraft> = {}, preview?: TaskDraft) => render(
    <NoMotion><AntApp>
      <TaskFields value={{ ...emptyDraft(), ...over }} onChange={() => {}} lists={LISTS} smartPreview={preview} />
    </AntApp></NoMotion>,
  );
  const dateRow = () => (document.querySelector('.ink-frow') as HTMLElement).textContent ?? '';

  it('草稿里没有日期、preview 里有：行上显示那个日期，并挂一颗「识别」', () => {
    open({}, { ...emptyDraft(), due: new Date(2026, 7, 25, 15, 0).toISOString() });
    expect(dateRow()).toContain('截止 8月25日 15:00');
    expect(document.querySelector('.ink-frow-smart')?.textContent).toBe('识别');
  });

  it('不传 preview：行上还是草稿那份，也没有「识别」', () => {
    open();
    expect(dateRow()).toContain('未设置');
    expect(document.querySelector('.ink-frow-smart')).toBeNull();
  });

  /**
   * 行说的和编辑器里的必须是各的：行上是「这句话会建出什么」，编辑器里是
   * 「你亲手填了什么」。混成一份的话，识别就变成了一次偷偷改写草稿。
   */
  it('编辑器里仍然是草稿那份（点开不是 preview 那个值）', () => {
    open({}, { ...emptyDraft(), due: new Date(2026, 7, 25, 15, 0).toISOString() });
    fireEvent.click(document.querySelector('.ink-frow') as HTMLElement);
    const input = screen.getByLabelText('截止') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  /**
   * 标签那一行**不是一上来就在的**：那一屏只画「已经设过的」和「加过的」两样，
   * 而光靠 preview 里有个标签并不构成「设过」——那正是要的样子：认出来的东西
   * 不该凭空在表单上多出一行来。所以这条测的是**行已经在**的时候：草稿里一个、
   * 句子里又一个，行上显示两个并说明其中一个是认出来的。
   */
  it('标签行已经在屏上时：句子里那个也显示出来，并挂「识别」', () => {
    const { container } = open({ tags: ['家里'] }, { ...emptyDraft(), tags: ['家里', '工作'] });
    const row = attrRow(container, '标签');
    expect(row?.textContent).toContain('#家里 #工作');
    expect(row?.querySelector('.ink-frow-smart')).toBeTruthy();
  });

  it('只有 preview 里有标签、草稿里没有：不凭空多出一行标签', () => {
    open({}, { ...emptyDraft(), tags: ['工作'] });
    expect(attrRow(document, '标签'), '识别不该在表单上凭空加一栏').toBeUndefined();
  });
});

/**
 * 「这条提醒响过没有」——在这之前 `firedAt` **全仓库零处渲染**。
 *
 * 关掉提醒横幅之后没有任何地方能回答这个问题（那个 × 只摘横幅、一字节不改数据），
 * 而「响过没有」正是他决定改期、还是干脆删掉这个提醒的唯一依据。
 *
 * 草稿里只有时刻（`TaskDraft.reminders` 是 `string[]`）——`firedAt` 是服务端盖的章，
 * 让草稿去带它等于允许编辑过程中改掉它。所以显示用、编辑不用，两份分开走。
 */
describe('TaskFields：响过的提醒', () => {
  const AT = '2026-08-20T01:00:00.000Z';

  const showFired = (fired?: Array<{ at: string; firedAt: string | null }>) => render(
    <NoMotion><AntApp>
      <TaskFields value={{ ...emptyDraft(), due: AT, reminders: [AT] }} onChange={() => {}} lists={LISTS} fired={fired} />
    </AntApp></NoMotion>,
  );

  it('响过了就写一句「已提醒」', () => {
    showFired([{ at: AT, firedAt: '2026-08-20T01:00:03.000Z' }]);
    expect(screen.getByText('已提醒')).toBeTruthy();
  });

  it('**还没响的不写**——一颗没响过的提醒标成「已提醒」，比不标更坏', () => {
    showFired([{ at: AT, firedAt: null }]);
    expect(screen.queryByText('已提醒')).toBeNull();
  });

  it('**时刻对不上就不写**，安静地不画，不报「状态异常」——草稿里那个时刻是他刚改的，那是另一条提醒了', () => {
    showFired([{ at: '2026-08-19T01:00:00.000Z', firedAt: '2026-08-19T01:00:03.000Z' }]);
    expect(screen.queryByText('已提醒')).toBeNull();
  });

  it('新建任务不传这一份（压根没有响过的东西）——一样不报错、不画', () => {
    showFired(undefined);
    expect(screen.queryByText('已提醒')).toBeNull();
  });
});
/**
 * 「提前多久」那排按钮在什么时间都没填时**整排消失**——这是对的（提前是相对
 * 某个时刻往前推，没有那个时刻这句话就没有主语）。但**留一句话说明为什么没有**，
 * 是这批里最要紧的一处：一排按钮凭空不见，跟「提醒坏了」长得一模一样，而那正是
 * 新用户在这个表单里最容易撞上的误解。
 */
describe('TaskFields：算不出「提前多久」的参照物时', () => {
  it('**说清楚为什么没有，并指出补哪一格**——不是让那一排悄悄消失', () => {
    show({ reminders: [] });
    expect(screen.getByText(/提前多久.*参照物/)).toBeTruthy();
  });

  it('**不编一个兜底锚点**——提前是相对某个时刻往前推，没有那个时刻这句话就没有主语', () => {
    // 兜底锚点（拿创建时间、拿今天）是在替人选一个他没选过的参照物。
    show({ reminders: [] });
    expect(screen.queryByRole('button', { name: '提前 30 分钟' })).toBeNull();
  });

  it('填了截止时间之后，那一排回来、这句话消失', () => {
    show({ due: '2026-08-20T01:00:00.000Z', reminders: [] });
    expect(screen.getByRole('button', { name: '提前 30 分钟' })).toBeTruthy();
    expect(screen.queryByText(/提前多久.*参照物/)).toBeNull();
  });
});