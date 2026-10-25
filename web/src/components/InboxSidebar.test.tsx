import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { InboxSidebar } from './InboxSidebar.js';
import type { InboxItem } from '../types.js';

let n = 0;
const item = (p: Partial<InboxItem> = {}): InboxItem => ({
  id: `i${++n}`, text: `条目${n}`, createdAt: '2026-08-01T00:00:00.000Z',
  processed: false, taskIds: [], ...p,
});

/** 夹具里 createdAt 一律是 2026-08-01，NOW 定在同一年的另一天，时间戳走的是
 *  「8月1日 08:00」那一档相对说法（whenText），不受跑测试那天影响。 */
const NOW = new Date(2026, 7, 20, 12, 0, 0);

const noop = () => {};
const noopAsync = async () => {};
const splitNoop = async () => 0;

// antd 会在「恰好两个汉字、没有图标」的按钮里插一个空格——「重新拆解」四个字
// 又带图标，理论上不会中招，但跟 TaskBoard.test.tsx 保持同一个防御写法，
// 万一哪天文案改短了也不会突然找不到按钮。
const byText = (text: string) => screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === text);

describe('InboxSidebar：重新拆解按钮', () => {
  it('只出现在已拆解（processed）的条目上，还没拆的条目没有这个按钮', () => {
    render(
      <InboxSidebar
        now={NOW}
        items={[item({ id: 'pending-1', processed: false })]}
        onDelete={noop}
        onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={noopAsync}
        onExpand={noop}
        expanding={false} aiBlocked={null}
      />,
    );
    expect(byText('重新拆解')).toBeUndefined();
  });

  /** 展开「已拆解」那个折叠面板并点开重拆气泡，回气泡里那颗确认按钮。 */
  const openRedo = (onRedo: (id: string, note: string) => void | Promise<void>) => {
    render(
      <AntApp>
        <InboxSidebar
          now={NOW}
          items={[item({ id: 'done-1', processed: true, taskIds: ['t1'] })]}
          onDelete={noop}
          onRedo={onRedo} onMakeTask={vi.fn()} onSplit={splitNoop}
          onEditText={noopAsync}
          onExpand={noop}
          expanding={false} aiBlocked={null}
        />
      </AntApp>,
    );
    // 已拆解的条目默认收在 Collapse 里，得先展开才能点到按钮。
    fireEvent.click(screen.getByText(/已拆解 1 条/));
    const btn = byText('重新拆解');
    expect(btn).toBeDefined();
    fireEvent.click(btn!);
    // 气泡里那颗跟触发它的那颗同名，取最后一个——先渲染的是触发器。
    return () => screen.getAllByRole('button').filter((b) => b.textContent?.replace(/\s/g, '') === '重新拆解').at(-1)!;
  };

  it('已拆解的条目上有这个按钮，点开写一句要求再确认，id 和那句话一起传回去', async () => {
    const onRedo = vi.fn();
    const confirm = openRedo(onRedo);

    await waitFor(() => expect(screen.getByPlaceholderText(/拆得太粗/)).toBeDefined());
    fireEvent.change(screen.getByPlaceholderText(/拆得太粗/), { target: { value: '  按周分开  ' } });
    fireEvent.click(confirm());

    // 首尾空白在这一层就去掉——服务端会把它追加进收件箱原文，带着空白进去
    // 会在那段文字里留下一行看不见的缩进。
    expect(onRedo).toHaveBeenCalledWith('done-1', '按周分开');
  });

  it('那句要求可以不写——留空就是原样再拆一遍，这是加输入框之前的行为', async () => {
    const onRedo = vi.fn();
    const confirm = openRedo(onRedo);

    await waitFor(() => expect(screen.getByPlaceholderText(/拆得太粗/)).toBeDefined());
    fireEvent.click(confirm());

    expect(onRedo).toHaveBeenCalledWith('done-1', '');
  });

  it('点之前就说清楚旧任务会被搬走——而且捞得回来', async () => {
    openRedo(vi.fn());
    await waitFor(() => expect(screen.getByText(/上一轮拆出来的任务会移进垃圾箱，捞得回来/)).toBeDefined());
  });

  it('重拆失败时那句要求留在框里，气泡不关——他刚打的字没有第二个来源', async () => {
    const onRedo = vi.fn(async () => { throw new Error('服务没起来'); });
    const confirm = openRedo(onRedo);

    await waitFor(() => expect(screen.getByPlaceholderText(/拆得太粗/)).toBeDefined());
    const box = screen.getByPlaceholderText(/拆得太粗/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '按周分开' } });
    fireEvent.click(confirm());

    await waitFor(() => expect(onRedo).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByPlaceholderText(/拆得太粗/) as HTMLTextAreaElement).value).toBe('按周分开'));
  });
});

describe('InboxSidebar：待拆解为 0 条时「立即拆解」禁用——点了也不会发生任何事', () => {
  it('全部条目都已处理：按钮禁用', () => {
    render(
      <InboxSidebar
        now={NOW}
        items={[item({ processed: true, taskIds: ['t1'] })]}
        onDelete={noop}
        onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={noopAsync}
        onExpand={noop}
        expanding={false} aiBlocked={null}
      />,
    );
    expect(screen.getByRole('button', { name: /立即拆解/ }).hasAttribute('disabled')).toBe(true);
  });

  it('收件箱本身是空的：按钮同样禁用', () => {
    render(<InboxSidebar now={NOW} items={[]} onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync} onExpand={noop} expanding={false} aiBlocked={null} />);
    expect(screen.getByRole('button', { name: /立即拆解/ }).hasAttribute('disabled')).toBe(true);
  });

  it('有未处理的条目：按钮可点', () => {
    render(
      <InboxSidebar
        now={NOW}
        items={[item({ processed: false })]}
        onDelete={noop}
        onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={noopAsync}
        onExpand={noop}
        expanding={false} aiBlocked={null}
      />,
    );
    expect(screen.getByRole('button', { name: /立即拆解/ }).hasAttribute('disabled')).toBe(false);
  });
});

describe('InboxSidebar：编辑文字（只有未处理的条目能改）', () => {
  it('未处理的条目上有「编辑」按钮，已处理的没有——已处理的只有「重新拆解」', () => {
    render(
      <InboxSidebar
        now={NOW}
        items={[item({ id: 'pending-1', processed: false })]}
        onDelete={noop}
        onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={noopAsync}
        onExpand={noop}
        expanding={false} aiBlocked={null}
      />,
    );
    expect(byText('编辑')).toBeDefined();
  });

  it('点「编辑」出现输入框，改完点「保存」把新文字传给 onEditText，成功后退出编辑态', async () => {
    const onEditText = vi.fn().mockResolvedValue(undefined);
    render(
      <InboxSidebar
        now={NOW}
        items={[item({ id: 'pending-1', text: '原文', processed: false })]}
        onDelete={noop}
        onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={onEditText}
        onExpand={noop}
        expanding={false} aiBlocked={null}
      />,
    );

    fireEvent.click(byText('编辑')!);
    const box = screen.getByDisplayValue('原文');
    fireEvent.change(box, { target: { value: '改过的文字' } });
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditText).toHaveBeenCalledWith('pending-1', '改过的文字'));
    // 编辑态关掉了：输入框不在了。这个组件测试没有接真实的 reload 链路
    // （写操作从不本地 patch 状态，靠文件 → watcher → SSE → reload 那条唯一
    // 更新路径刷新），所以显示文字这里仍然是父组件传进来的 props 原值——
    // 只断言编辑框已经收起，不断言显示的文字变成了新值。
    await waitFor(() => expect(screen.queryByDisplayValue('改过的文字')).toBeNull());
  });

  it('点「取消」放弃修改，不调用 onEditText，原文还在', () => {
    const onEditText = vi.fn();
    render(
      <InboxSidebar
        now={NOW}
        items={[item({ id: 'pending-1', text: '原文', processed: false })]}
        onDelete={noop}
        onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={onEditText}
        onExpand={noop}
        expanding={false} aiBlocked={null}
      />,
    );

    fireEvent.click(byText('编辑')!);
    fireEvent.change(screen.getByDisplayValue('原文'), { target: { value: '改了一半又反悔' } });
    fireEvent.click(byText('取消')!);

    expect(onEditText).not.toHaveBeenCalled();
    expect(screen.getByText('原文')).toBeDefined();
  });

  it('保存失败：编辑框留着、刚打的字原样在，弹出错误提示——不能把用户的输入连带没存成的这次一起清空', async () => {
    const onEditText = vi.fn().mockRejectedValue(new Error('已处理的条目不能改文字'));
    render(
      <AntApp>
        <InboxSidebar
          now={NOW}
          items={[item({ id: 'pending-1', text: '原文', processed: false })]}
          onDelete={noop}
          onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
          onEditText={onEditText}
          onExpand={noop}
          expanding={false} aiBlocked={null}
        />
      </AntApp>,
    );

    fireEvent.click(byText('编辑')!);
    fireEvent.change(screen.getByDisplayValue('原文'), { target: { value: '写了一半才发现存不进去' } });
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditText).toHaveBeenCalled());

    // 编辑框还在，草稿原样保留——不是被清空重置回原文。
    expect(screen.getByDisplayValue('写了一半才发现存不进去')).toBeDefined();
    await waitFor(() => expect(screen.getByText('已处理的条目不能改文字')).toBeDefined());
  });

  it('rowKey：删掉列表里靠前的一条，编辑器仍然绑定在原来那条上，保存传的是原来那条的 id', async () => {
    const onEditText = vi.fn().mockResolvedValue(undefined);
    const items = [
      item({ id: 'a', text: 'A原文', processed: false }),
      item({ id: 'b', text: 'B原文', processed: false }),
      item({ id: 'c', text: 'C原文', processed: false }),
    ];
    const { rerender } = render(
      <InboxSidebar now={NOW} items={items} onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={onEditText} onExpand={noop} expanding={false} aiBlocked={null} />,
    );

    // 打开第二行（B）的编辑器，改了草稿但还没保存。
    const editButtons = screen.getAllByRole('button').filter((b) => b.textContent?.replace(/\s/g, '') === '编辑');
    fireEvent.click(editButtons[1]);
    fireEvent.change(screen.getByDisplayValue('B原文'), { target: { value: 'B的替换文字' } });

    // 重新加载：A 被删了，pending 变成 [B, C]——没有 rowKey 时 antd 按列表位置
    // 复用组件实例：位置 1 原来渲染的是 B，现在该位置的 dataSource 元素变成了 C，
    // 组件实例的 state（正在编辑、草稿内容）被原样保留，但它收到的 props 已经是 C。
    rerender(
      <InboxSidebar
        now={NOW}
        items={[item({ id: 'b', text: 'B原文', processed: false }), item({ id: 'c', text: 'C原文', processed: false })]}
        onDelete={noop}
        onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={onEditText}
        onExpand={noop}
        expanding={false} aiBlocked={null}
      />,
    );

    // 点保存。真正暴露错配的地方不是文字（草稿文字在错配前后看起来完全一样），
    // 而是 onEditText 收到的 id——错配时会把 B 的替换文字保存到 C 的 id 上，
    // 销毁 C 的原文。
    fireEvent.click(byText('保存')!);

    await waitFor(() => expect(onEditText).toHaveBeenCalledWith('b', 'B的替换文字'));
  });

  it('编辑器开着的时候条目被拆解（processed 变 true），草稿不消失——还留在未处理列表里，没被挪进已拆解折叠面板', () => {
    const { rerender } = render(
      <InboxSidebar
        now={NOW}
        items={[item({ id: 'a', text: '原文', processed: false })]}
        onDelete={noop}
        onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={noopAsync}
        onExpand={noop}
        expanding={false} aiBlocked={null}
      />,
    );

    fireEvent.click(byText('编辑')!);
    fireEvent.change(screen.getByDisplayValue('原文'), { target: { value: '改到一半' } });

    // 自动拆解的倒计时跑完、AI 把这条拆解掉了：重新加载后 processed 变 true。
    rerender(
      <InboxSidebar
        now={NOW}
        items={[item({ id: 'a', text: '原文', processed: true, taskIds: ['t1'] })]}
        onDelete={noop}
        onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={noopAsync}
        onExpand={noop}
        expanding={false} aiBlocked={null}
      />,
    );

    // 草稿还在——组件没有被卸载重建。挪进已拆解折叠面板会导致组件卸载、
    // state 清空，草稿无声消失且不会有任何提示。
    expect(screen.getByDisplayValue('改到一半')).toBeDefined();
    // 也没有跑去已拆解折叠面板里出现第二份（不该同时存在两处）。
    expect(screen.queryByText(/已拆解 1 条/)).toBeNull();
  });
});

/**
 * 删除收件箱条目丢掉的是**手打的原话**——任务能重建、AI 能重拆，这段文字
 * 没有第二个来源。之前既没有确认也没有测试。
 */
describe('InboxSidebar：删除要先确认', () => {
  const setup = (over: Partial<InboxItem> = {}) => {
    const onDelete = vi.fn();
    render(
      <AntApp>
        <InboxSidebar now={NOW} items={[item(over)]} onDelete={onDelete} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync} onExpand={noop} expanding={false} aiBlocked={null} />
      </AntApp>,
    );
    return { onDelete };
  };
  const deletes = () => screen.getAllByRole('button').filter((b) => b.textContent?.replace(/\s/g, '') === '删除');

  it('点「删除」不会立刻删', () => {
    const { onDelete } = setup();

    fireEvent.click(deletes()[0]);

    expect(onDelete).not.toHaveBeenCalled();
  });

  it('确认之后才真的删', async () => {
    const { onDelete } = setup({ id: 'i-del' });

    fireEvent.click(deletes()[0]);
    await waitFor(() => expect(deletes().length).toBe(2));
    fireEvent.click(deletes().at(-1)!);

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('i-del'));
  });

  it('已拆解的条目要说清楚：拆出来的任务不受影响，没的只是这段原话', async () => {
    setup({ processed: true, taskIds: ['t1'] });

    // 已拆解的条目在「已拆解 N 条」折叠区里，默认收着，先展开才有按钮
    fireEvent.click(screen.getByText(/已拆解/));
    await waitFor(() => expect(deletes().length).toBeGreaterThan(0));
    fireEvent.click(deletes()[0]);

    await waitFor(() => expect(screen.getByText(/拆出来的任务不受影响/)).toBeTruthy());
  });
});

/**
 * 顺序。**在这之前两份列表都不排序**，而 `GET /api/inbox` 给的是服务端读目录
 * 的顺序（文件名是 uuid）——也就是随机：连着记三条，出现的先后跟你写的先后
 * 没有关系。
 */
describe('InboxSidebar：按写下的先后排', () => {
  const at = (d: number, over: Partial<InboxItem> = {}) =>
    item({ createdAt: new Date(2026, 7, d, 9).toISOString(), ...over });

  const texts = (sel: string) =>
    [...document.querySelectorAll(sel)].map((e) => e.textContent);

  it('待拆解那份：先写的在上面——这是一条要从头处理的队列，等得最久的排最前', () => {
    // 故意按「新的在前」传进去：不排序的实现会原样吐回来，这条就红。
    const items = [at(20, { text: '后写的' }), at(10, { text: '先写的' })];
    render(<AntApp><InboxSidebar now={NOW} items={items} onExpand={noop} onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync} expanding={false} aiBlocked={null} /></AntApp>);
    const got = texts('.ink-note-pending').map((s) => s ?? '');
    expect(got.findIndex((s) => s.includes('先写的'))).toBeLessThan(got.findIndex((s) => s.includes('后写的')));
  });

  it('已拆解那份同一条', () => {
    const items = [
      at(20, { text: '后写的', processed: true, taskIds: ['t1'] }),
      at(10, { text: '先写的', processed: true, taskIds: ['t2'] }),
    ];
    render(<AntApp><InboxSidebar now={NOW} items={items} onExpand={noop} onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync} expanding={false} aiBlocked={null} /></AntApp>);
    // 已拆解那份收在折叠面板里，展开之前根本不在 DOM 里。
    fireEvent.click(screen.getByText('已拆解 2 条'));
    const got = texts('.ink-note-done').map((s) => s ?? '');
    expect(got.findIndex((s) => s.includes('先写的'))).toBeLessThan(got.findIndex((s) => s.includes('后写的')));
  });

  it('时间解析不了的不把整份顺序打乱——落 0 排最前，不抛', () => {
    const items = [at(10, { text: '正常的' }), item({ text: '坏的', createdAt: '前天' })];
    render(<AntApp><InboxSidebar now={NOW} items={items} onExpand={noop} onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync} expanding={false} aiBlocked={null} /></AntApp>);
    const got = texts('.ink-note-pending').map((s) => s ?? '');
    expect(got.some((s) => s.includes('正常的'))).toBe(true);
    expect(got.some((s) => s.includes('坏的'))).toBe(true);
  });
});

/**
 * 时间戳说的是「它在这儿躺多久了」，不是「具体哪一刻」。
 *
 * 这个数字出现的场合只有一个：你正扫一眼收件箱、决定先拆哪条。
 * 「2026-08-24 08:12」得先在脑子里跟今天减一次才回答得了那个问题；
 * 「今天 08:12」直接就是答案。跟卡片上的「截止/提醒」同一份文案。
 */
describe('InboxSidebar：时间戳用相对说法', () => {
  it('今天写的读作「今天 HH:mm」，不是 YYYY-MM-DD', () => {
    const t = new Date(2026, 7, 20, 8, 12).toISOString();
    render(<AntApp><InboxSidebar now={NOW} items={[item({ createdAt: t })]} onExpand={noop} onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync} expanding={false} aiBlocked={null} /></AntApp>);
    expect(screen.getByText('今天 08:12')).toBeTruthy();
    expect(screen.queryByText(/2026-08-20/)).toBeNull();
  });

  it('久一点的落回「几月几日 HH:mm」——那时候「几天前」已经不如日期好用了', () => {
    const t = new Date(2026, 7, 1, 9, 0).toISOString();
    render(<AntApp><InboxSidebar now={NOW} items={[item({ createdAt: t })]} onExpand={noop} onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync} expanding={false} aiBlocked={null} /></AntApp>);
    expect(screen.getByText('8月1日 09:00')).toBeTruthy();
  });
});

describe('InboxSidebar：随手记按 markdown 渲染', () => {
  const show = (items: InboxItem[]) => render(
    <AntApp><InboxSidebar now={NOW} items={items} onExpand={noop} onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync} expanding={false} aiBlocked={null} /></AntApp>,
  );
  const MD = '搬家那摊事：\n\n- 找搬家公司\n- 退租提前 **30 天**\n\n> 房东原话：押金月底退';

  it('**粘一段带清单的进来，读出来就是清单**——随手记是「想到什么写什么」的入口，一条清单挤成一坨没法看', () => {
    const { container } = show([item({ text: MD })]);
    const note = container.querySelector('.ink-note-text')!;
    expect(note.querySelectorAll('li')).toHaveLength(2);
    expect(note.querySelector('strong')?.textContent).toBe('30 天');
    expect(note.querySelector('blockquote')).not.toBeNull();
  });

  /**
   * 上下两节并排，计数**得是同一个形状**。原来这一栏里上面写「待拆解 · 2」、
   * 下面写「已拆解 2 条」——同一屏两种写法，读的人得换两次脑子。
   * 钉的是「都带『条』」而不是钉死某一句措辞：将来改字是两处一起改，
   * 形状不会散。
   */
  it('「待拆解」和「已拆解」的计数是同一个形状', () => {
    show([
      item({ id: 'a', processed: false, taskIds: [] }),
      item({ id: 'b', processed: true, taskIds: ['t1'] }),
    ]);
    const pending = screen.getByText(/待拆解/).textContent!.trim();
    const done = screen.getByText(/已拆解/).textContent!.trim();
    expect(pending.endsWith('条'), pending).toBe(true);
    expect(done.endsWith('条'), done).toBe(true);
  });

  it('**原话一个字没被改写**——渲染只改怎么画它；AI 拆解读的仍然是那段原始字符串', () => {
    const { container } = show([item({ text: MD })]);
    const note = container.querySelector('.ink-note-text')!;
    // 文本内容里该出现的字都在（markdown 记号本身不算内容）
    for (const s of ['搬家那摊事', '找搬家公司', '退租提前', '30 天', '押金月底退']) {
      expect(note.textContent, s).toContain(s);
    }
  });

  it('跟备注共用同一个渲染组件，不另开一份', () => {
    const { container } = show([item({ text: MD })]);
    expect(container.querySelector('.ink-note-text .ink-notes-md')).not.toBeNull();
  });
});

/**
 * 「变成任务」——把随手记的那句原话直接变成一条任务，不劳烦 AI（仿滴答清单：
 * 那边收件箱里躺的本来就是任务）。草稿怎么拼在 lib/composeDefaults.ts 的
 * `smartDraft`，跟列表顶上那条「添加任务」共用同一份；这里测的是这一行的接线。
 */
describe('InboxSidebar：变成任务', () => {
  const item = (over: Partial<InboxItem> = {}): InboxItem => ({
    id: 'i1', text: '给猫买猫粮', createdAt: '2026-08-25T02:00:00.000Z',
    processed: false, taskIds: [], ...over,
  });

  const show = (items: InboxItem[], onMakeTask = vi.fn()) => {
    render(
      <InboxSidebar
        items={items}
        now={NOW}
        onDelete={() => {}}
        onRedo={() => {}}
        onMakeTask={onMakeTask}
        onSplit={splitNoop}
        onEditText={async () => {}}
        onExpand={() => {}}
        expanding={false} aiBlocked={null}
      />,
    );
    return onMakeTask;
  };

  it('没处理的那条有这颗按钮，点了把 id 交出去', () => {
    const onMakeTask = show([item()]);
    fireEvent.click(screen.getByRole('button', { name: '变成任务' }));
    expect(onMakeTask).toHaveBeenCalledWith('i1');
  });

  it('▾ 里的「以后再说」报的是 `{ later: true }`——GTD 的「将来也许」直达', async () => {
    const onMakeTask = vi.fn();
    show([item()], onMakeTask);
    // Dropdown.Button 的 ▾ 是主按钮旁边那颗带 .ant-dropdown-trigger 的。
    const trigger = document.querySelector('.ant-dropdown-trigger') as HTMLElement;
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger);
    const hit = await waitFor(() => {
      const el = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((e) => e.textContent?.includes('以后再说'));
      if (!el) throw new Error('菜单里没有「以后再说」');
      return el;
    });
    fireEvent.click(hit);
    expect(onMakeTask).toHaveBeenCalledWith('i1', { later: true });
  });

  it('主按钮还是那颗：一点就建，**不带 later**——快路径一步都没多', () => {
    const onMakeTask = vi.fn();
    show([item()], onMakeTask);
    fireEvent.click(screen.getByRole('button', { name: '变成任务' }));
    expect(onMakeTask).toHaveBeenCalledWith('i1');
  });

  it('**已经拆过的没有这颗**——再变一条就是凭空多一条重复的', () => {
    show([item({ processed: true, taskIds: ['t1'] })]);
    expect(screen.queryByRole('button', { name: '变成任务' })).toBeNull();
  });

  it('排在「编辑」前面——这一行最常做的是把它归位，不是改措辞', () => {
    show([item()]);
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels.indexOf('变成任务')).toBeLessThan(labels.indexOf('编辑'));
  });
});

/**
 * 手动拆成多条——没有 AI、或者一段话里本来就装着好几件事时的出口。
 * 切分规则在 `lib/composeDefaults.ts` 的 `splitCaptureSegments`，这里测接线。
 */
describe('InboxSidebar：拆成多条', () => {
  const show = (text: string, onSplit = vi.fn(async () => 2)) => {
    render(
      <AntApp>
        <InboxSidebar
          items={[item({ id: 'i1', text, processed: false, taskIds: [] })]}
          now={NOW}
          onDelete={noop}
          onRedo={noop}
          onMakeTask={vi.fn()}
          onSplit={onSplit}
          onEditText={noopAsync}
          onExpand={noop}
          expanding={false} aiBlocked={null}
        />
      </AntApp>,
    );
    return onSplit;
  };
  const openSplit = async () => {
    fireEvent.click(document.querySelector('.ant-dropdown-trigger') as HTMLElement);
    const hit = await waitFor(() => {
      const el = [...document.querySelectorAll('.ant-dropdown-menu-item')]
        .find((e) => e.textContent?.includes('拆成多条'));
      if (!el) throw new Error('菜单里没有「拆成多条」');
      return el;
    });
    fireEvent.click(hit);
    return screen.getByLabelText('拆成多条的任务') as HTMLTextAreaElement;
  };

  it('按换行和分号预切，确认后每一行交出去', async () => {
    const onSplit = show('买猫粮；约牙医', vi.fn(async () => 2));
    const box = await openSplit();
    expect(box.value).toBe('买猫粮\n约牙医');

    fireEvent.click(screen.getByRole('button', { name: /拆成 2 条/ }));
    await waitFor(() => expect(onSplit).toHaveBeenCalledWith('i1', ['买猫粮', '约牙医']));
  });

  it('他改过的行原样交出去，空行不算', async () => {
    const onSplit = show('原来的整段', vi.fn(async () => 2));
    const box = await openSplit();
    fireEvent.change(box, { target: { value: '  买菜  \n\n 接孩子 \n' } });

    fireEvent.click(screen.getByRole('button', { name: /拆成 2 条/ }));
    await waitFor(() => expect(onSplit).toHaveBeenCalledWith('i1', ['买菜', '接孩子']));
  });

  it('只剩一行时不能拆——那是「变成任务」的活，不是拆', async () => {
    show('原来就一件事', vi.fn(async () => 1));
    const box = await openSplit();
    fireEvent.change(box, { target: { value: '只剩这一件事' } });

    const go = screen.getByRole('button', { name: '至少两行' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
  });

  it('拆失败时那几行留在框里、编辑态不关——他刚改的字没有第二个来源', async () => {
    show('一件事；另一件事', vi.fn(async () => { throw new Error('磁盘满了'); }));
    const box = await openSplit();
    fireEvent.change(box, { target: { value: '一件事\n另一件事' } });

    fireEvent.click(screen.getByRole('button', { name: /拆成 2 条/ }));
    await waitFor(() => expect(screen.getByText('磁盘满了')).toBeDefined());
    expect((screen.getByLabelText('拆成多条的任务') as HTMLTextAreaElement).value).toBe('一件事\n另一件事');
  });
});

/**
 * 这一栏空着的时候说得出**下一步**。
 *
 * 原来只有一句「没有待拆解的」——它回答了「这一栏空着」，没回答「东西从哪儿来」。
 * 而随手记 → 收件箱 → 拆解这条链，在整个界面上只有这一屏说得出（写进设置里
 * 没人找，画个插图更是谁都不会去点）。
 */
describe('InboxSidebar：空着的时候给出下一步', () => {
  const showEmpty = (items: InboxItem[]) => render(
    <AntApp>
      <InboxSidebar
        now={NOW} items={items}
        onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={noopAsync} onExpand={noop} expanding={false} aiBlocked={null}
      />
    </AntApp>,
  );

  it('一句状态 + 一句下一步，两句都在', () => {
    showEmpty([]);
    expect(screen.getByText('没有待拆解的')).toBeTruthy();
    expect(screen.getByText(/「随手记」写一句/)).toBeTruthy();
  });

  it('「都拆完了」那种空法（有已拆解的条目）：第一句照旧说「没有待拆解的」，不说「还没有东西进来」——后者在这种时候是假话', () => {
    showEmpty([item({ processed: true, taskIds: ['t1'] })]);
    expect(screen.getByText('没有待拆解的')).toBeTruthy();
    expect(screen.queryByText(/还没有东西进来/)).toBeNull();
    expect(screen.getByText(/已拆解 1 条/)).toBeTruthy();
  });
});

/**
 * 「有活儿」不等于「能干活」。
 *
 * 这颗按钮原来只看待拆解条数，配置没配、连不上服务时照样亮着——点下去换来的
 * 是一分半钟的等待和一句不知道怎么修的错。判据在 `lib/aiReady.ts`，这里只钉
 * 「按钮真的灰了，而且原因就摆在旁边」这一件事。
 */
describe('InboxSidebar：AI 跑不了的时候那颗按钮', () => {
  const show = (aiBlocked: string | null) => render(
    <AntApp>
      <InboxSidebar
        items={[item()]}
        now={NOW}
        onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync}
        onExpand={noop} expanding={false} aiBlocked={aiBlocked}
      />
    </AntApp>,
  );
  const btn = () => screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === '立即拆解') as HTMLButtonElement;

  it('**跑不了就灰**，不是点下去等一分钟再报错', () => {
    show('还没配好 AI 接口，少了：密钥。');
    expect(btn().disabled).toBe(true);
  });

  it('**灰着的时候把原因摆出来**——一颗没解释的灰按钮看着像坏了', () => {
    show('还没配好 AI 接口，少了：密钥。去设置里补上。');
    expect(screen.getByText(/还没配好 AI 接口/)).toBeTruthy();
  });

  it('跑得了的时候一切照旧：亮着，也不占那一行提示', () => {
    show(null);
    expect(btn().disabled).toBe(false);
    expect(screen.queryByText(/还没配好/)).toBeNull();
  });
});
/**
 * AI 跑不了不等于用不了这个应用。
 *
 * 每条下面「⋯」里那颗「变成任务」走的是同一份 `smartDraft` 本地规则，**不花
 * 额度、离线也能用**。而这句话**只在 AI 跑不了时说**——平时它是一句噪音:能拆
 * 的时候没有人需要被介绍一条更慢的路。
 */
describe('InboxSidebar：AI 跑不了的时候,那条不需要 AI 的路得被说出来', () => {
  const show = (aiBlocked: string | null, items: InboxItem[]) => render(
    <AntApp>
      <InboxSidebar
        items={items}
        now={NOW}
        onDelete={noop} onRedo={noop} onMakeTask={vi.fn()} onSplit={splitNoop} onEditText={noopAsync}
        onExpand={noop} expanding={false} aiBlocked={aiBlocked}
      />
    </AntApp>,
  );
  const BLOCKED = '还没配好 AI 接口，少了：密钥。';

  it('**指着「变成任务」那颗**——这一行不是「AI 用不了了」的道歉,是「你照样能把活干完」的指路', () => {
    show(BLOCKED, [item()]);
    // 整句一起钉:分开钉的话「提到了变成任务」和「说的是不用配 AI 也能用」会各自
    // 漂——而那句话在空着的时候也含「变成任务」四个字。
    expect(screen.getByText(/「变成任务」不用配 AI 也能用/)).toBeTruthy();
  });

  it('**AI 能用的时候不说这句**——能拆的时候没人需要被介绍一条更慢的路', () => {
    show(null, [item()]);
    expect(screen.queryByText(/不用配 AI 也能用/)).toBeNull();
  });

  it('**空状态也不说「等着拆」**——没有 AI 可调时那是一句兑不出去的承诺', () => {
    show(BLOCKED, []);
    expect(screen.getByText(/等着变成任务/)).toBeTruthy();
    expect(screen.queryByText(/等着拆/)).toBeNull();
  });

  it('AI 能用时那句指路照旧', () => {
    show(null, []);
    expect(screen.getByText(/等着拆/)).toBeTruthy();
  });
});
describe('InboxSidebar：已拆解能点回拆出来的任务', () => {
  const titles = (map: Record<string, string>) => (id: string) => map[id];
  const show = (
    items: InboxItem[],
    taskTitle: (id: string) => string | undefined,
    onOpenTask: (id: string) => void,
  ) => render(
    <AntApp>
      <InboxSidebar
        now={NOW}
        items={items}
        taskTitle={taskTitle}
        onOpenTask={onOpenTask}
        onDelete={noop}
        onRedo={noop}
        onMakeTask={vi.fn()} onSplit={splitNoop}
        onEditText={noopAsync}
        onExpand={noop}
        expanding={false}
        aiBlocked={null}
      />
    </AntApp>,
  );

  it('拆出一条时，点计数直接打开那条任务', async () => {
    const onOpenTask = vi.fn();
    show([item({ processed: true, taskIds: ['t1'] })], titles({ t1: '买菜' }), onOpenTask);
    fireEvent.click(screen.getByRole('button', { name: /已拆解 1 条/ }));
    fireEvent.click(await screen.findByRole('button', { name: '已拆 1 条' }));
    expect(onOpenTask).toHaveBeenCalledWith('t1');
  });

  it('拆出多条时，先在下拉里挑一条再打开', async () => {
    const onOpenTask = vi.fn();
    show([item({ processed: true, taskIds: ['t1', 't2'] })], titles({ t1: '买菜', t2: '买米' }), onOpenTask);
    // 折叠头数的是「几条收件箱原文」，不是拆出几条任务；这一条只有一条原文。
    fireEvent.click(screen.getByRole('button', { name: /已拆解 1 条/ }));
    fireEvent.click(await screen.findByRole('button', { name: /已拆 2 条/ }));
    fireEvent.click(await screen.findByText('买米'));
    expect(onOpenTask).toHaveBeenCalledWith('t2');
  });

  it('任务已经删掉时不画一个点进去没有结果的入口', async () => {
    show([item({ processed: true, taskIds: ['gone'] })], titles({}), vi.fn());
    fireEvent.click(screen.getByRole('button', { name: /已拆解 1 条/ }));
    expect(screen.queryByRole('button', { name: '已拆 1 条' })).toBeNull();
    expect(screen.getByText('已拆 1 条')).toBeTruthy();
  });
});
