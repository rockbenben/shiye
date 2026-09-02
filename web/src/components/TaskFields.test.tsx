import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { TaskFields, emptyDraft, type TaskDraft } from './TaskFields.js';
import { NoMotion } from '../test-utils.js';
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
  it('折叠区那行标题跟里面的字段对得上——加了字段忘了改这行会红', () => {
    const { container } = render(
      <NoMotion><AntApp>
        <TaskFields value={emptyDraft()} onChange={() => {}} lists={LISTS} />
      </AntApp></NoMotion>,
    );
    const summary = container.querySelector('.ink-more-summary')!.textContent ?? '';
    // aria-label 是给读屏的整句话（「在等谁或等什么」），summary 里是短名
    // （「在等谁」）——这张表把两者对上。加字段时这里加一行，summary 里加一段。
    const NAMES: Array<[string, string]> = [
      ['重复', '重复'],
      ['在等谁或等什么', '在等谁'],
      // 这一条原来是「打算花多久（分钟）」——同一个字段在屏幕上有过三个名字
      // （placeholder「预计分钟」/ aria-label「打算花多久」/ 别处「预计时长」），
      // 现在统一成「预计时长」。这张表本来就是在盯「两处叫法对不对得上」，
      // 只是它对不上的那一对不在它的检查范围里：它比 summary，没比 placeholder。
      ['预计时长（分钟）', '预计时长'],
      ['什么条件下能做', '情境'],
      ['归到哪个清单', '清单'],
      ['加标签', '标签'],
    ];
    const inside = [...container.querySelectorAll('.ink-more-fields [aria-label]')]
      .map((e) => e.getAttribute('aria-label') ?? '');
    for (const [label, short] of NAMES) {
      expect(inside, `折叠区里没渲染出「${label}」——这张表过期了，改它`).toContain(label);
      expect(summary, `折叠区里有「${label}」，但那行标题没提「${short}」`).toContain(short);
    }
    // 优先级没有 aria-label（三颗按钮各自带文字），单独钉一句。
    expect(summary).toContain('优先级');

    /**
     * **有 placeholder 的，那句话也得是同一个名字。**
     *
     * 上面那张表只比了 aria-label 和 summary 两处，而「预计时长」这个字段的
     * 第三个名字恰恰藏在 placeholder 里（当时写着「预计分钟」）——两处对得上、
     * 第三处对不上，这道守卫一直是绿的。同一样东西在一屏上有两个叫法，人得先
     * 认出它们是一回事才用得上。
     *
     * **只比「名字」那一截，不比整句。** placeholder 除了当名字还常常兼着举例
     * （「在等…（比如「张老师回邮件」）」）——那是正当的，一个标签负责命名、
     * 一个例子负责示范，不是两个名字。所以从第一个 `（` 或 `…` 处截断再比：
     * 截出来的是名字，后面那半是例子。
     *
     * 判据是**包含关系**不是全等：屏幕上那句短（「预计时长」），给读屏的那句
     * 整（「预计时长（分钟）」），后者含前者即可。
     */
    const nameOf = (s: string) => s.split(/[（…]/)[0].trim();
    const withPlaceholder = [...container.querySelectorAll('.ink-more-fields [placeholder]')]
      .map((e) => ({ ph: e.getAttribute('placeholder') ?? '', al: e.getAttribute('aria-label') ?? '' }))
      .filter((x) => x.ph && x.al);
    expect(withPlaceholder.length, '折叠区里一个带 placeholder 的控件都没有，这条守卫成了摆设').toBeGreaterThan(0);
    for (const { ph, al } of withPlaceholder) {
      expect(al, `placeholder 写「${ph}」、aria-label 写「${al}」——同一个字段两个名字`).toContain(nameOf(ph));
    }
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
describe('TaskFields：折叠区默认收起（#6）', () => {
  it('新建（emptyDraft，四项都是默认值）时默认收起', () => {
    const { container } = show();
    const details = container.querySelector('details.ink-more-fields') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
  });

  it('编辑一条已经设了优先级的任务时默认展开——不能把已经填的东西藏起来', () => {
    const { container } = show({ priority: 2 });
    const details = container.querySelector('details.ink-more-fields') as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it('编辑一条已经有标签的任务时默认展开', () => {
    const { container } = show({ tags: ['工作'] });
    const details = container.querySelector('details.ink-more-fields') as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it('编辑一条已经归了清单的任务时默认展开', () => {
    const { container } = show({ listId: 'L1' }, LISTS);
    const details = container.querySelector('details.ink-more-fields') as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it('编辑一条已经有重复规则的任务时默认展开', () => {
    const { container } = show({ repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null } });
    const details = container.querySelector('details.ink-more-fields') as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });
});

describe('TaskFields：优先级', () => {
  it('emptyDraft 的优先级是 0（无）——新建任务不替人做判断', () => {
    expect(emptyDraft().priority).toBe(0);
  });

  it('四个档位都能选到，选中的值原样传出去', () => {
    const { onChange } = show();
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
    const box = screen.getByLabelText('加标签');
    fireEvent.change(box, { target: { value: '工作' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tags: ['工作'] }));
  });

  it('去首尾空白', () => {
    const { onChange } = show();
    const box = screen.getByLabelText('加标签');
    fireEvent.change(box, { target: { value: '  工作  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tags: ['工作'] }));
  });

  it('空的和纯空白不加——服务端现在也会清洗，但这一层挡在 onChange 之前，不该让空标签先在界面上闪一下', () => {
    const { onChange } = show();
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
    fireEvent.change(screen.getByLabelText('归到哪个清单'), { target: { value: 'L2' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ listId: 'L2' }));
  });

  it('归档的清单不出现在选项里', () => {
    show({}, LISTS);
    const opts = [...screen.getByLabelText('归到哪个清单').querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toContain('工作');
    expect(opts).not.toContain('归档了的');
  });

  it('一条清单都没有时下拉仍然在——藏掉的话用户永远不知道有这回事', () => {
    show({}, []);
    const select = screen.getByLabelText('归到哪个清单');
    expect(select).toBeTruthy();
    // 光断言下拉框存在挡不住「把 <option value=""> 那一行删掉」这种变异——
    // select 本身还在，只是空的，实测这条没变红。补一条断言那个选项确实在，
    // 才逼得出「藏掉唯一选项」和「藏掉整个下拉框」的区别。
    const opts = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toEqual(['不属于任何清单']);
  });

  // 审查 Minor：归档的清单默认不进候选，但一条任务当下就挂在某个后来被
  // 归档的清单上时，得给它开个例外——不然下拉框显示「不属于任何清单」，
  // 跟旁边 TaskCard 卡片上照样画着的竖条/清单名自相矛盾（TaskCard 的
  // lists.find() 不看 archived）。
  it('已经归到一个后来被归档的清单：下拉框仍然选中它、选项里也看得到，不假装成「不属于任何清单」', () => {
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
    expect(box().value).toBe('');
  });

  it('填了报上去', () => {
    const { onChange } = show();
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
  const notes = () => screen.getByPlaceholderText('备注（打 / 插入格式）');

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
    const { onSubmit, container } = showKeys();
    (container.querySelector('details') as HTMLDetailsElement).open = true;
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
