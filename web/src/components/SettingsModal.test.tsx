import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { SETTING_SECTIONS, SettingsModal } from './SettingsModal.js';
import { getApiBase, setApiBase } from '../lib/apiBase.js';
import type { InboxItem, Proposal, Settings, Task } from '../types.js';

const settings: Settings = { webhookUrl: 'https://x', toastEnabled: true, autoExpand: true, autoExpandDelaySec: 60, focusMinutes: 25, breakMinutes: 5, dailySummaryAt: null, dailySummaryOn: null, defaultListId: null, defaultPriority: 0 as const, defaultDue: 'none' as const, defaultRemindMinutes: null, defaultTags: [], weekStart: 1 as const, smartDate: true, smartStripDate: true, smartTag: true, smartStripTag: true, showLunar: true, showHolidays: true, aiMode: 'cli' as const, aiBaseUrl: '', aiKey: '', aiModel: '' };
const inbox: InboxItem[] = [{ id: 'i1', text: '条目', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] }];
const tasks: Task[] = [{
  id: 't1', title: '任务', notes: '备注', status: 'todo', due: null, startAt: null, endAt: null, reminders: [],
  persistentReminder: false,
  subtasks: [], source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
}];
const proposals: Proposal[] = [{
  id: 'p1', taskId: 't1', patch: { reminders: [{ at: '2026-08-20T01:00:00.000Z', firedAt: null }] },
  reason: '过期五天了', createdAt: '2026-08-12T00:00:00.000Z',
}];

/** 「测试连接」那颗按下去调的就是它。每条用例自己决定它回什么。 */
const testAi = vi.fn(async (_cfg: { baseUrl: string; model: string; apiKey: string }) =>
  ({ ok: true }) as { ok: true } | { ok: false; error: string });

vi.mock('../api.js', () => ({
  api: {
    inbox: vi.fn(async () => inbox),
    tasks: vi.fn(async () => tasks),
    settings: vi.fn(async () => settings),
    proposals: vi.fn(async () => proposals),
    // **`data/` 下的其余四张表也要有桩。** 这份桩原来只有四个方法，跟当时
    // 「导出只导四样」的实现是对称的——补齐实现之后，缺桩会让 `Promise.all`
    // 抛在 `api.lists is not a function` 上，导出静默失败、`capturedBlob` 是 null。
    lists: vi.fn(async () => []),
    folders: vi.fn(async () => []),
    countdowns: vi.fn(async () => []),
    insights: vi.fn(async () => []),
    trash: vi.fn(async () => []),
    testAi: (cfg: { baseUrl: string; model: string; apiKey: string }) => testAi(cfg),
  },
}));

const noop = () => {};

/**
 * 切到某一个分区。**从抽屉换成弹层之后每一页各自渲染**，不是一整张长表单，
 * 所以要断言某一项之前得先站到它那一页上——这几条测试原来是「打开就全在
 * 屏幕上」写的。
 *
 * 页签用的是 `role="tab"`，跟屏幕上一样按名字点，不认内部 class。
 */
const goto = (label: string) => fireEvent.click(screen.getByRole('tab', { name: label }));

// 「导航显示」那一节的三个 prop——这几条测试盯的都是别的东西（导出、保存、
// 读不到设置时不渲染表单），给一份最小的固定值就行，不用为每条各造一份。
const NAV = {
  navOptions: [
    { key: 'today', label: '今天', group: 'tasks' as const, canAuto: true },
    { key: 'quadrant', label: '四象限', group: 'views' as const, canAuto: false },
    { key: 'habits', label: '习惯', group: 'more' as const, canAuto: false },
  ],
  navModes: {},
  onNavModes: () => {},
  lists: [],
};


describe('SettingsModal：导出数据', () => {
  let capturedBlob: Blob | null;
  let capturedFilename: string;

  beforeEach(() => {
    capturedBlob = null;
    capturedFilename = '';
    // jsdom 没实现 createObjectURL/下载；这里拦在同一个位置读到真实内容，
    // 跟在真实浏览器里挂一段 JS 拦截下载是同一个思路，只是搬进单测——
    // 点的是真的「导出数据」按钮，走的是组件里真实的 exportData()，
    // 不是单独把组装逻辑拎出来跑。
    URL.createObjectURL = vi.fn((blob: Blob) => { capturedBlob = blob; return 'blob:mock-url'; });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      capturedFilename = this.download;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('点击真实按钮：产出合法 JSON，data/ 下八张表都在，文件名带时间戳', async () => {
    render(
      <AntApp>
        <SettingsModal {...NAV} open value={settings} onClose={noop} onSave={async () => {}} />
      </AntApp>,
    );

    goto('数据与服务');
    fireEvent.click(screen.getByText('导出数据'));

    await waitFor(() => expect(capturedBlob).not.toBeNull());

    const text = await capturedBlob!.text();
    const parsed = JSON.parse(text);   // 不是合法 JSON 这里直接抛，测试失败

    expect(parsed.inbox).toEqual(inbox);
    expect(parsed.tasks).toEqual(tasks);
    expect(parsed.settings).toEqual(settings);
    // 提议也要在里面：这颗按钮声称是「把 data/ 下的现状打包」，漏一份就是假话。
    expect(parsed.proposals).toEqual(proposals);

    // **`data/` 下的八张表一张都不能少。** 这里原来只断言四份，而实现也真的
    // 只导了四份——清单、文件夹、纪念日、观察、垃圾箱在 JSON 里连键都没有。
    // 界面把这份导出说成「自己给自己多买一层」保险，照它当唯一备份的人，
    // 丢了 data/ 之后才会发现十几份清单一条都没有。
    // 「哪几张表」由 `exportCoverage.guard.test.ts` 跟服务端 `paths()` 对账，
    // 这里只钉住「键都在、而且是数组」——不重复那份名单。
    for (const k of ['lists', 'folders', 'countdowns', 'insights', 'trash'] as const) {
      expect(Array.isArray(parsed[k]), `导出里没有「${k}」——那份备份救不回它`).toBe(true);
    }

    // 带时间戳，连着导出几次文件名不同，不会互相覆盖。
    expect(capturedFilename).toMatch(/^办事师爷数据-\d{8}-\d{6}\.json$/);
  });
});

/**
 * final-review.md I3：这是唯一能改 focusMinutes 的界面，整个文件却只有上面
 * 那一条测试（还是测导出的）——把「番茄钟时长」那个 Form.Item 整段删掉，
 * 125 测试全绿。这里补上「这个输入框确实存在、确实读 draft.focusMinutes、
 * 改了之后点保存确实带着新值发出去」。
 */
describe('SettingsModal：专注时长', () => {
  it('初始显示 draft.focusMinutes；改了之后点保存，onSave 收到的是新值', async () => {
    const onSave = vi.fn(async (_s: Settings) => {});
    render(
      <AntApp>
        <SettingsModal {...NAV} open value={settings} onClose={noop} onSave={onSave} />
      </AntApp>,
    );

    goto('专注');
    const formItem = screen.getByText('专注时长').closest('.ant-form-item') as HTMLElement;
    const input = formItem.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('25');

    fireEvent.change(input, { target: { value: '45' } });
    // antd 给「恰好两个汉字、没有图标」的按钮插了一个空格（「保 存」不是
    // 「保存」）——这里没经过 main.tsx 那层 autoInsertSpace: false，按文字
    // 找先去空白，跟 test-utils.tsx 的 btnIn 同一条理由。
    const saveBtn = screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '保存')!;
    fireEvent.click(saveBtn);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].focusMinutes).toBe(45);
  });
});

/**
 * task-3-brief「地址填错要能改」：只在第一次启动出现的话，填错了这个 App
 * 就废了，得卸载重装——这条要有断言。这里证明设置弹层里**始终**渲染着
 * 那个地址输入框（不用先具备什么条件、不判断当前是不是手机），并且改了
 * 之后真的调用了 setApiBase——跟 ServerSetup.test.tsx 里测的是同一个组件，
 * 这里额外证明的是「它确实被接到了设置弹层里，不是写完了没接线」。
 */
describe('SettingsModal：服务地址——重填的入口不能只在第一次启动出现', () => {
  afterEach(() => {
    setApiBase('');
  });

  it('设置面板里始终有「服务地址」输入框，初始值是当前的 getApiBase()', () => {
    setApiBase('http://192.168.1.5:30035');
    render(
      <AntApp>
        <SettingsModal {...NAV} open value={settings} onClose={noop} onSave={async () => {}} />
      </AntApp>,
    );
    goto('数据与服务');
    const input = screen.getByLabelText('服务地址') as HTMLInputElement;
    expect(input.value).toBe('http://192.168.1.5:30035');
  });

  it('改了地址、点 ServerSetup 自己的「保存」，真的调用了 setApiBase 存下新值', () => {
    setApiBase('http://填错了:30035');
    render(
      <AntApp>
        <SettingsModal {...NAV} open value={settings} onClose={noop} onSave={async () => {}} />
      </AntApp>,
    );
    goto('数据与服务');
    const input = screen.getByLabelText('服务地址') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'http://192.168.1.5:30035' } });

    // **「数据与服务」这一页上只有 ServerSetup 自己那一颗「保存」**：设置
    // 表单那颗只在「这一页真有服务端设置可存」时才画（`needsDraft`），而这一
    // 页存的是这台设备本地的地址，跟服务端那份设置无关——摆一颗对它没用的
    // 按钮只会让人以为没点它就没生效。
    const saveButtons = screen.getAllByRole('button').filter((b) => b.textContent?.replace(/\s/g, '') === '保存');
    expect(saveButtons.length).toBe(1);
    fireEvent.click(saveButtons[0]!);

    expect(getApiBase()).toBe('http://192.168.1.5:30035');
  });
});

/**
 * 整分支审查 I1：`value` 为 `null` = 这台服务的设置**一次都没成功读到过**
 * （离线，或者在线时 `GET /api/settings` 出错）。这个状态下这张表单整个不
 * 渲染——**没有草稿就没有能 PUT 回去的东西**，桌面上真实的 `webhookUrl`
 * 不可能被一份编出来的默认值冲掉。断言的是「表单不存在」，不是「保存被
 * 拦住」：后者意味着 `draft` 里仍然躺着一份编出来的值，下一处疏忽就能把它
 * 送出去。
 */
describe('SettingsModal：一次都没读到过设置时，根本给不出可保存的草稿（整分支审查 I1）', () => {
  const renderNull = () => render(
    <AntApp>
      <SettingsModal {...NAV} open value={null} onClose={noop} onSave={async () => { throw new Error('这条路根本不该被走到'); }} />
    </AntApp>,
  );

  it('表单里的字段一个都不渲染——没有 Webhook 输入框，也没有专注时长', () => {
    renderNull();
    goto('提醒与通知');
    expect(screen.queryByPlaceholderText('https://…')).toBeNull();
    goto('专注');
    expect(screen.queryByText('专注时长')).toBeNull();
  });

  it('设置表单那颗「保存」不存在——站在一页要草稿的分区上也没有', () => {
    renderNull();
    goto('专注');
    const saveButtons = screen.getAllByRole('button').filter((b) => b.textContent?.replace(/\s/g, '') === '保存');
    expect(saveButtons.length).toBe(0);
  });

  it('说清楚为什么是空的，不是让人对着一片空白猜', () => {
    renderNull();
    goto('专注');
    expect(screen.getByText(/还没读到这台服务上的设置/)).toBeTruthy();
  });

  it('「服务地址」照常在——连不上的时候正是最需要能改它的时候（那份存在这台设备本地）', () => {
    renderNull();
    goto('数据与服务');
    expect(screen.getByLabelText('服务地址')).toBeTruthy();
  });
});

/**
 * 「导航显示」**跟着滴答清单拆成了两页**：`功能模块`（模块栏上那几个）和
 * `智能清单`（侧栏上那几个去处）。原来是一页里按段分列，那是抽屉时代的形状
 * ——一条 420px 的窄边栏装不下两级结构，只能靠段标题凑合。
 *
 * 拆开之后「这一项画在哪儿」由**页本身**回答，段标题不用再兼职说这件事，
 * 那句「（在模块栏上）」的后缀也就跟着不需要了（它曾经是「（最左那条竖栏）」，
 * 而那条栏在手机上是横着钉在最上面的，那句话在手机上是错的——同一处修了
 * 两次，第二次直接把病根去掉了）。
 */
describe('SettingsModal：导航显示拆成「功能模块」和「智能清单」两页', () => {
  const show = (over: Partial<Parameters<typeof SettingsModal>[0]> = {}) => render(
    <AntApp>
      <SettingsModal {...NAV} open value={settings} onClose={noop} onSave={async () => {}} {...over} />
    </AntApp>,
  );

  it('「功能模块」那一页列的是模块栏上那两段（换种看法 / 模块），不列「任务」', () => {
    show();
    goto('功能模块');
    expect(screen.getByText('换种看法')).toBeTruthy();
    expect(screen.getByLabelText('四象限的显示方式')).toBeTruthy();
    expect(screen.queryByLabelText('今天的显示方式')).toBeNull();
  });

  it('「智能清单」那一页列的是侧栏上那一段，不列模块', () => {
    show();
    goto('智能清单');
    expect(screen.getByLabelText('今天的显示方式')).toBeTruthy();
    expect(screen.queryByLabelText('四象限的显示方式')).toBeNull();
  });

  it('每一项还是那三档；「有内容时显示」只给挂得出数字的那几项', () => {
    show();
    goto('智能清单');
    const today = screen.getByLabelText('今天的显示方式') as HTMLSelectElement;
    expect([...today.options].map((o) => o.value)).toEqual(['show', 'auto', 'hide']);
    goto('功能模块');
    const quadrant = screen.getByLabelText('四象限的显示方式') as HTMLSelectElement;
    expect([...quadrant.options].map((o) => o.value)).toEqual(['show', 'hide']);
  });

  it('**空段不起标题**——一段里一项都没有时，那行小标题是句废话', () => {
    show({ navOptions: [{ key: 'today', label: '今天', group: 'tasks' as const, canAuto: true }] });
    goto('功能模块');
    expect(screen.queryByText('换种看法')).toBeNull();
  });
});

/**
 * 从抽屉换成弹层这件事本身。
 *
 * 抽屉是「从边上滑出来的一条」，420px 宽，十几项设置在里面只能一路往下滚；
 * 设置是一件要坐下来做的事。照滴答清单那张设置弹层的形状：左边一列分区、
 * 右边正文。
 */
describe('SettingsModal：左边一列分区、右边正文', () => {
  const show = () => render(
    <AntApp>
      <SettingsModal {...NAV} open value={settings} onClose={noop} onSave={async () => {}} />
    </AntApp>,
  );

  it('分区是 tablist，不是一列普通按钮——读屏会报「10 个中的第 3 个」，方向键也能切', () => {
    show();
    expect(screen.getByRole('tablist', { name: '设置分区' })).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(SETTING_SECTIONS.length);
  });

  it('**一次只画一页**：站在「专注」上时，别的页的控件不在 DOM 里', () => {
    show();
    goto('专注');
    expect(screen.getByText('专注时长')).toBeTruthy();
    // 藏起来的话，一次保存会把十几个没在屏幕上的控件一起提交，读屏也会把
    // 所有页的内容一次读完。
    expect(screen.queryByText('识别日期')).toBeNull();
    expect(screen.queryByLabelText('新任务默认清单')).toBeNull();
  });

  it('默认停在第一页（功能模块）', () => {
    show();
    expect(screen.getByRole('tab', { name: '功能模块' }).getAttribute('aria-selected')).toBe('true');
  });
});

/**
 * 新加的那几档设置（仿滴答清单「更多设置 → 任务默认值 / 智能识别」和
 * 「日期与时间 → 每周开始于」）。这里只钉「界面上改得动、保存时真的带出去」，
 * 每一档**做了什么**各有自己的测试（composeDefaults / smartInput / calendar）。
 */
describe('SettingsModal：新加的那几档', () => {
  const showWith = (onSave: (s: Settings) => Promise<void>) => render(
    <AntApp>
      <SettingsModal {...NAV} open value={settings} onClose={noop} onSave={onSave} />
    </AntApp>,
  );
  const clickSave = () => fireEvent.click(
    screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '保存')!,
  );

  it('每周开始于：改成周日，保存时带出去', async () => {
    const onSave = vi.fn(async (_s: Settings) => {});
    showWith(onSave);
    goto('日期与时间');
    expect(screen.getByLabelText('每周开始于')).toBeTruthy();
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // 没动过就是原值——这一条钉的是「这一页真的挂在同一份 draft 上」。
    expect(onSave.mock.calls[0]![0].weekStart).toBe(1);
  });

  it('默认标签：一行逗号分开的字变成数组，中英文逗号都认（中文输入法打出来的是全角）', async () => {
    const onSave = vi.fn(async (_s: Settings) => {});
    showWith(onSave);
    goto('任务默认值');
    fireEvent.change(screen.getByLabelText('新任务默认标签'), { target: { value: '工作，紧急, 工作' } });
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // 去空白、去重。
    expect(onSave.mock.calls[0]![0].defaultTags).toEqual(['工作', '紧急']);
  });

  it('智能识别四个开关都在，「摘掉」那两个在对应的识别关掉时跟着禁用——没认出东西就没什么可摘', () => {
    render(
      <AntApp>
        <SettingsModal {...NAV} open value={{ ...settings, smartDate: false, smartTag: true }} onClose={noop} onSave={async () => {}} />
      </AntApp>,
    );
    goto('智能识别');
    const item = (label: string) => screen.getByText(label).closest('.ant-form-item') as HTMLElement;
    expect(item('把日期从标题里摘掉').querySelector('button')!.hasAttribute('disabled')).toBe(true);
    expect(item('把标签从标题里摘掉').querySelector('button')!.hasAttribute('disabled')).toBe(false);
  });

  it('**保存的是整份，不是当前这一页**——分页只是屏幕上的事，draft 里躺的一直是完整的一份', async () => {
    const onSave = vi.fn(async (_s: Settings) => {});
    showWith(onSave);
    goto('专注');
    const focus = item('专注时长').querySelector('input') as HTMLInputElement;
    fireEvent.change(focus, { target: { value: '45' } });
    goto('日期与时间');
    clickSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // 站在「日期与时间」上点的保存，「专注」那一页刚改的值照样带出去了。
    expect(onSave.mock.calls[0]![0].focusMinutes).toBe(45);
  });

  function item(label: string): HTMLElement {
    return screen.getByText(label).closest('.ant-form-item') as HTMLElement;
  }
});

describe('设置 → AI 拆解：怎么叫 AI', () => {
  const open = (value: Settings, onSave: (v: Settings) => Promise<void> = async () => {}) => {
    render(
      <AntApp>
        <SettingsModal {...NAV} open value={value} onClose={noop} onSave={onSave} />
      </AntApp>,
    );
    goto('AI 拆解');
  };

  /**
   * 默认那档是「本机 Claude Code」，接口那三格连出现都不该出现——没选它的时候
   * 摆三个空框，人会以为不填就用不了 AI，而默认那条路压根不需要它们。
   */
  it('默认走本机命令行时，接口地址/模型/密钥都不画', () => {
    open(settings);
    expect(screen.queryByText('接口地址')).toBeNull();
    expect(screen.queryByText('模型')).toBeNull();
    expect(screen.queryByText('密钥')).toBeNull();
  });

  it('切到「调接口」之后那三格才出现', () => {
    open(settings);
    fireEvent.click(screen.getByRole('radio', { name: '调接口' }));
    expect(screen.getByText('接口地址')).toBeDefined();
    expect(screen.getByText('模型')).toBeDefined();
    expect(screen.getByText('密钥')).toBeDefined();
  });

  it('点一个预置的名字，地址和模型一起填好——省掉去翻文档抄地址', () => {
    open({ ...settings, aiMode: 'api' });
    fireEvent.click(screen.getByText('Google AI Studio'));

    const url = screen.getByPlaceholderText('https://…/v1/chat/completions') as HTMLInputElement;
    expect(url.value).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect((screen.getByPlaceholderText('gemini-3.7-flash') as HTMLInputElement).value).toBe('gemini-3.7-flash');
  });

  /**
   * 本机那两条不带模型名（装了什么模型只有他自己知道）。拿空串去冲掉他已经填好的
   * 那个，等于按一下就把活儿弄丢了。
   */
  it('本机那两条不带模型名：只换地址，已经填好的模型名不动', () => {
    open({ ...settings, aiMode: 'api', aiBaseUrl: 'https://x.test/v1', aiModel: '我自己填的' });
    fireEvent.click(screen.getByText('Ollama（本机）'));

    const url = screen.getByPlaceholderText('https://…/v1/chat/completions') as HTMLInputElement;
    expect(url.value).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect((screen.getByPlaceholderText('gemini-3.7-flash') as HTMLInputElement).value).toBe('我自己填的');
  });

  it('地址框照样能自己写——预置只是起点，不是白名单', () => {
    open({ ...settings, aiMode: 'api' });
    const url = screen.getByPlaceholderText('https://…/v1/chat/completions') as HTMLInputElement;
    fireEvent.change(url, { target: { value: 'http://192.168.1.9:8080/v1' } });
    expect(url.value).toBe('http://192.168.1.9:8080/v1');
  });

  /** 界面读回来的密钥是打码后的形状，不碰它就得原样送回去（服务端认这串 = 保持原样）。 */
  it('保存时把四格一起送出去，没动过的密钥原样带回', async () => {
    // 参数类型要写出来：`vi.fn(async () => {})` 的调用记录在类型上是个空元组，
    // 读 `calls[0][0]` 编译期就红。
    const onSave = vi.fn(async (_v: Settings) => {});
    open({ ...settings, aiMode: 'api', aiBaseUrl: 'https://x.test/v1', aiModel: 'm', aiKey: '••••ijkl' }, onSave);
    // antd 会在恰好两个汉字的按钮里插一个空格，按文字找要先把空白去掉——
    // 跟这个文件上面那两处同一个写法。
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '保存')!);

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      aiMode: 'api', aiBaseUrl: 'https://x.test/v1', aiModel: 'm', aiKey: '••••ijkl',
    });
  });
});

/**
 * **「测试连接」补的是一个真实的缺口**：服务地址那一格早就有这颗按钮，而 AI 这三格
 * 填完之后唯一的验证方式是真跑一次拆解——要等一两分钟、烧一次额度，失败还是以
 * 看板顶上一条红横幅的形式出现，离刚填的这三个框十万八千里。
 */
describe('设置 → AI 拆解：测试连接', () => {
  const open = (value: Settings) => {
    render(
      <AntApp>
        <SettingsModal {...NAV} open value={value} onClose={noop} onSave={async () => {}} />
      </AntApp>,
    );
    goto('AI 拆解');
  };
  const apiCfg = { ...settings, aiMode: 'api' as const, aiBaseUrl: 'https://x.test/v1', aiModel: 'm', aiKey: '••••ijkl' };
  const btn = () => screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '测试连接')!;

  beforeEach(() => { testAi.mockClear(); testAi.mockResolvedValue({ ok: true }); });

  it('本机命令行那一档不画这颗——那条路没有接口可测', () => {
    open(settings);
    expect(screen.queryByText('测试连接')).toBeNull();
  });

  it('把此刻框里那三格送出去，不是存着的那份', async () => {
    open(apiCfg);
    fireEvent.change(screen.getByPlaceholderText('gemini-3.7-flash'), { target: { value: '刚改的模型' } });
    fireEvent.click(btn());
    await waitFor(() => expect(testAi).toHaveBeenCalled());
    expect(testAi.mock.calls[0][0]).toEqual({ baseUrl: 'https://x.test/v1', model: '刚改的模型', apiKey: '••••ijkl' });
  });

  it('通了说一句连接成功', async () => {
    open(apiCfg);
    fireEvent.click(btn());
    await waitFor(() => expect(screen.getByText(/连接成功/)).toBeDefined());
  });

  /** 报错原样显示——「401」三个字没告诉他是钥匙错还是没充值。 */
  it('不通就把接口那句话原样摆出来，不换成一句笼统的「失败」', async () => {
    testAi.mockResolvedValue({ ok: false, error: '接口回了 401：Incorrect API key' });
    open(apiCfg);
    fireEvent.click(btn());
    await waitFor(() => expect(screen.getByText(/Incorrect API key/)).toBeDefined());
  });

  /** 离线时 `api.testAi` 直接抛（offlineUnsupported）。也是「没测成」，不能静默。 */
  it('调用本身抛了也给一句话，不是什么都不显示', async () => {
    testAi.mockRejectedValue(new Error('离线时无法测试 AI 接口，连接服务器之后再试'));
    open(apiCfg);
    fireEvent.click(btn());
    await waitFor(() => expect(screen.getByText(/离线时无法测试 AI 接口/)).toBeDefined());
  });

  /**
   * 一条绿色的「连接成功」挂在**已经被改过**的地址旁边，比没有结论更糟——
   * 他会以为新填的这个也验过了。
   */
  it('改了任何一格就把上一次的结论清掉', async () => {
    open(apiCfg);
    fireEvent.click(btn());
    await waitFor(() => expect(screen.getByText(/连接成功/)).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText('https://…/v1/chat/completions'), { target: { value: 'https://换了.test/v1' } });
    expect(screen.queryByText(/连接成功/)).toBeNull();
  });

  it('点一个预置的名字也算改了，同样清掉', async () => {
    open(apiCfg);
    fireEvent.click(btn());
    await waitFor(() => expect(screen.getByText(/连接成功/)).toBeDefined());

    fireEvent.click(screen.getByText('DeepSeek'));
    expect(screen.queryByText(/连接成功/)).toBeNull();
  });
});
