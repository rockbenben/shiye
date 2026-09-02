import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { TaskDetail } from './TaskDetail.js';
import { btnIn, task } from '../test-utils.js';
import type { Task } from '../types.js';

// 跟 TaskCard.test.tsx 同一份 mock：面板里渲染的就是 TaskCard，它的
// Attachments 子组件会碰 api.js。vi.mock 不跨文件共享，这里单开一份。
vi.mock('../api.js', () => ({
  api: {
    uploadAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    attachmentUrl: vi.fn((id: string, name: string) => `/api/tasks/${id}/attachments/${name}`),
  },
}));

const NOW = new Date(2026, 7, 24, 12);

function show(t: Task, onClose = vi.fn()) {
  const utils = render(
    <AntApp>
      <TaskDetail
        t={t}
        now={NOW}
        lists={[]}
        onPatch={vi.fn()}
        onEditTask={vi.fn(async () => ({}))}
        onDelete={vi.fn()}
        onEditingChange={vi.fn()}
        onClose={onClose}
      />
    </AntApp>,
  );
  return { ...utils, onClose };
}

describe('TaskDetail', () => {
  it('摊开的就是那条任务——面板里渲染的是 TaskCard，不是另搭一份详情', () => {
    show(task({ id: 'x', title: '写周报' }));
    expect(screen.getByText('写周报')).toBeTruthy();
    // 卡片自己那一套（状态按钮）跟着来了，这正是复用 TaskCard 的全部意义。
    // btnIn 比对前先去空白：「搁置」恰好两个汉字，antd 会渲染成「搁 置」
    // （应用在 main.tsx 关掉了 autoInsertSpace，这里没走那层 ConfigProvider）。
    expect(btnIn(document.body, '搁置')).toBeTruthy();
  });

  it('自报是什么区域——读屏要说得出这一栏是干什么的', () => {
    show(task({ id: 'x', title: '写周报' }));
    expect(screen.getByRole('complementary', { name: '任务详情' })).toBeTruthy();
  });

  it('「关闭」只收面板，回调出去让上面决定——它自己不碰任务', () => {
    const { onClose } = show(task({ id: 'x', title: '写周报' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('**打开时焦点收进来**——不收的话用键盘打开一条任务之后，Esc 该关的那个东西根本没被「进入」过', () => {
    show(task({ id: 'x', title: '写周报' }));
    expect(document.activeElement).toBe(screen.getByRole('complementary', { name: '任务详情' }));
  });

  it('换看另一条任务时重新收一次焦点——面板换了内容', () => {
    const { rerender } = show(task({ id: 'x', title: '写周报' }));
    const panel = screen.getByRole('complementary', { name: '任务详情' });
    // 先把焦点挪走，模拟他点了点别处
    (screen.getByRole('button', { name: '关闭' }) as HTMLElement).focus();
    expect(document.activeElement).not.toBe(panel);

    rerender(
      <AntApp>
        <TaskDetail
          t={task({ id: 'y', title: '别的事' })}
          now={NOW}
          lists={[]}
          onPatch={vi.fn()}
          onEditTask={vi.fn(async () => ({}))}
          onDelete={vi.fn()}
          onEditingChange={vi.fn()}
          onClose={vi.fn()}
        />
      </AntApp>,
    );
    expect(screen.getByText('别的事')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('complementary', { name: '任务详情' }));
  });

  it('**同一条任务重渲染时不抢焦点**——`t` 每次 patch 都是新对象，抢一次就等于他打字打到一半光标被拽走', () => {
    const { rerender } = show(task({ id: 'x', title: '写周报' }));
    const close = screen.getByRole('button', { name: '关闭' }) as HTMLElement;
    close.focus();
    // 同一个 id、新对象（一次 patch 之后的样子）
    rerender(
      <AntApp>
        <TaskDetail
          t={task({ id: 'x', title: '写周报', priority: 3 })}
          now={NOW}
          lists={[]}
          onPatch={vi.fn()}
          onEditTask={vi.fn(async () => ({}))}
          onDelete={vi.fn()}
          onEditingChange={vi.fn()}
          onClose={vi.fn()}
        />
      </AntApp>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' }));
  });

  it('不进 Tab 顺序——它是一块区域，不是一个控件', () => {
    show(task({ id: 'x', title: '写周报' }));
    expect(screen.getByRole('complementary', { name: '任务详情' }).getAttribute('tabindex')).toBe('-1');
  });
});

/**
 * 详情面板那张形（仿滴答清单第三栏）：顶上勾选圈 + 日期，下面大标题，再下面
 * 一整块正文，最底下一条清单。**这一族测试盯的是「点一下就地改」这件事**——
 * 面板上最常做的三件事（做没做完、什么时候、写了什么）不该还要先进整张卡的
 * 编辑态。
 */
describe('TaskDetail：滴答那张形', () => {
  function panel(t: Task, over: Partial<ComponentProps<typeof TaskDetail>> = {}) {
    const onEditTask = vi.fn(async () => ({}));
    const onPatch = vi.fn();
    const utils = render(
      <AntApp>
        <TaskDetail
          t={t}
          now={NOW}
          lists={[]}
          onPatch={onPatch}
          onEditTask={onEditTask}
          onDelete={vi.fn()}
          onEditingChange={vi.fn()}
          onClose={vi.fn()}
          {...over}
        />
      </AntApp>,
    );
    return { ...utils, onEditTask, onPatch };
  }

  const notesBox = () => screen.getByRole('button', { name: '备注' });
  const notesInput = () => screen.getByPlaceholderText('备注（打 / 插入格式）') as HTMLTextAreaElement;

  it('**非编辑态渲染 markdown**——正文是 markdown 文本，看的时候看到的是排好版的东西，不是一串 #', () => {
    panel(task({ notes: `# 大标题

- 一条
- 两条` }));
    expect(document.querySelector('.ink-notes-md h1')?.textContent).toBe('大标题');
    expect(document.querySelectorAll('.ink-notes-md li').length).toBe(2);
  });

  it('点一下正文就开始写，看到的是**原始 markdown**，不是渲染后的样子', () => {
    panel(task({ notes: '# 大标题' }));
    fireEvent.click(notesBox());
    expect(notesInput().value).toBe('# 大标题');
    // 写的时候不该还渲染着一份
    expect(document.querySelector('.ink-notes-md h1')).toBeNull();
  });

  it('写完点到别处就落盘，并且渲染回去——不用按保存', async () => {
    const { onEditTask } = panel(task({ id: 'x', notes: '旧的' }));
    fireEvent.click(notesBox());
    fireEvent.change(notesInput(), { target: { value: '## 新的' } });
    fireEvent.blur(notesInput());
    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith('x', { notes: '## 新的' }));
  });

  it('没改就什么都不发——点进去看一眼再点出来不该产生一次写盘', () => {
    const { onEditTask } = panel(task({ notes: '原样' }));
    fireEvent.click(notesBox());
    fireEvent.blur(notesInput());
    expect(onEditTask).not.toHaveBeenCalled();
  });

  it('**Esc 是撤销，不是确认**——打了一半不想要了，按下去不该反而把它存了', () => {
    const { onEditTask } = panel(task({ notes: '原样' }));
    fireEvent.click(notesBox());
    fireEvent.change(notesInput(), { target: { value: '打了一半不想要了' } });
    fireEvent.keyDown(notesInput(), { key: 'Escape' });
    expect(onEditTask).not.toHaveBeenCalled();
    // 撤销之后回到看的样子，屏幕上还是原来那段
    expect(notesBox().textContent).toContain('原样');
  });

  it('**Esc 过一次之后，下一次编辑照样存得进去**——撤销的旗子不能一直立在那儿', async () => {
    const { onEditTask } = panel(task({ id: 'x', notes: '原样' }));
    // 第一次：改了又撤销。按 Esc 时框当场被卸载，浏览器多半根本不派发 blur，
    // 那面旗子没人收——不清的话下一次就轮到它把真的编辑吃掉。
    fireEvent.click(notesBox());
    fireEvent.change(notesInput(), { target: { value: '不要了' } });
    fireEvent.keyDown(notesInput(), { key: 'Escape' });
    // 第二次：这回是认真改的
    fireEvent.click(notesBox());
    fireEvent.change(notesInput(), { target: { value: '这次是真的' } });
    fireEvent.blur(notesInput());
    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith('x', { notes: '这次是真的' }));
  });

  it('还没写过备注的任务也有地方可点——空正文不是一块点不着的空白', () => {
    panel(task({ notes: '' }));
    expect(screen.getByText('写点什么……')).toBeTruthy();
    fireEvent.click(notesBox());
    expect(notesInput().value).toBe('');
  });

  it('「/」菜单在这里照样有——用的就是编辑表单那一个 NotesEditor，不是另写的框', async () => {
    panel(task({ notes: '' }));
    fireEvent.click(notesBox());
    fireEvent.change(notesInput(), { target: { value: '/' } });
    await waitFor(() => expect(screen.getByRole('listbox', { name: '插入' })).toBeTruthy());
  });

  it('标题点一下就地改，回车就是写好了', async () => {
    const { onEditTask } = panel(task({ id: 'x', title: '写周报' }));
    fireEvent.click(screen.getByRole('button', { name: '写周报' }));
    const box = screen.getByLabelText('标题') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '写月报' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(onEditTask).toHaveBeenCalledWith('x', { title: '写月报' }));
  });

  it('**空标题不落盘**——一个空标题覆盖掉原来的等于把这条任务弄没了名字', () => {
    const { onEditTask } = panel(task({ title: '写周报' }));
    fireEvent.click(screen.getByRole('button', { name: '写周报' }));
    const box = screen.getByLabelText('标题') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.blur(box);
    expect(onEditTask).not.toHaveBeenCalled();
  });

  it('顶上那个勾选圈就是「做完了」，不用去翻状态按钮', () => {
    const { onPatch } = panel(task({ id: 'x', title: '写周报' }));
    fireEvent.click(screen.getByRole('button', { name: '把「写周报」标记完成' }));
    expect(onPatch).toHaveBeenCalledWith('x', { status: 'done' });
  });

  it('已完成的再点一下标回待办——跟行档那个圈同一条判据', () => {
    const { onPatch } = panel(task({ id: 'x', title: '写周报', status: 'done' }));
    fireEvent.click(screen.getByRole('button', { name: '把「写周报」标回待办' }));
    expect(onPatch).toHaveBeenCalledWith('x', { status: 'todo' });
  });

  it('日期摆在顶上那一行，**下面不再说第二遍**——同一个事实在一栏里出现两次，第二次只是噪音', () => {
    panel(task({ due: '2026-08-25T10:00:00.000Z' }));
    expect(document.querySelector('.ink-dt-date')).toBeTruthy();
    expect(screen.queryByText('截止')).toBeNull();
  });

  it('**正文紧跟标题**——标签、过期、预计这些记号排在正文后面，不插在标题和正文中间', () => {
    panel(task({ title: '写周报', notes: '正文在这儿', tags: ['周报'] }));
    const panelEl = document.querySelector('.ink-detail')!;
    const order = (sel: string) => [...panelEl.querySelectorAll('*')].indexOf(panelEl.querySelector(sel)!);
    expect(order('.ink-dt-title')).toBeLessThan(order('.ink-dt-notes'));
    expect(order('.ink-dt-notes')).toBeLessThan(order('.ink-tag-chip'));
  });

  it('优先级旗在顶上那一行，不单独占一行——竖排的 Space 会把它摊成孤零零的一行', () => {
    panel(task({ priority: 3 }));
    expect(document.querySelector('.ink-dt-top .ink-dt-flag')).toBeTruthy();
  });

  it('这一栏里不再套一层卡片外壳——一栏之内两层边框', () => {
    panel(task({}));
    expect(document.querySelector('.ink-task-card-plain')).toBeTruthy();
    // 清单色竖条也不画：它是卡片外壳的一部分，清单在页脚说
    expect(document.querySelector('.ink-list-bar')).toBeNull();
  });

  it('**正文还在落盘的时候，双击别处不会打开整张卡的编辑态**——那一下抓到的是旧备注，再按保存就把刚写的盖回去了', () => {
    panel(task({ id: 'x', notes: '旧的' }));
    fireEvent.click(notesBox());
    fireEvent.change(notesInput(), { target: { value: '新写的' } });
    // 双击别处：mousedown 先让它离焦、开始落盘（await 还没回来），紧接着是这一下
    fireEvent.blur(notesInput());
    fireEvent.doubleClick(document.querySelector('.ink-task-card')!);
    // 整张卡的表单没开（开了的话会有「保存」那颗按钮）。btnIn 找不到会抛，
    // 这里要的是「没有」，所以直接查 DOM。
    const saveBtn = [...document.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s/g, '') === '保存');
    expect(saveBtn).toBeUndefined();
  });

  it('清单在页脚，卡片里那个小标签不再画一份', () => {
    panel(task({ listId: 'l1' }), { lists: [{ id: 'l1', name: '家', color: '#8A6F4E', folderId: null, order: 0, archived: false, filter: null }] });
    const foot = document.querySelector('.ink-detail-foot');
    expect(foot?.textContent).toContain('家');
    // 整栏里「家」只出现这一次
    expect(screen.getAllByText('家').length).toBe(1);
  });

  it('没归到任何清单也照样画那条页脚——空着的页脚会让人以为它坏了', () => {
    panel(task({ listId: null }));
    expect(document.querySelector('.ink-detail-foot')?.textContent).toContain('不属于任何清单');
  });
});
