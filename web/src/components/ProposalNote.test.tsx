import { describe, it, expect, vi, afterEach } from 'vitest';
import { App as AntApp } from 'antd';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import type { List, Proposal, Task } from '../types.js';
import { ProposalNote, groupProposals } from './ProposalNote.js';
import { formatWhen } from '../lib/taskView.js';

const byText = (text: string) => screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === text);

const LISTS: List[] = [
  { id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null },
];

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1', title: '写周报', notes: '', status: 'todo',
  due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'ai', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z', order: null,
  listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
  postponeCount: 0, waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null,
  ...over,
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'p1', taskId: 't1', patch: { reminders: [{ at: '2026-08-20T09:00:00.000Z', firedAt: null }] },
  reason: '这条已经过期五天了，看起来在等外部回复', createdAt: '2026-08-12T00:00:00.000Z', ...over,
});

function setup(over: { p?: Proposal; t?: Task; lists?: List[]; onAccept?: () => Promise<unknown>; onDismiss?: () => Promise<unknown> } = {}) {
  const onAccept = over.onAccept ?? vi.fn().mockResolvedValue(undefined);
  const onDismiss = over.onDismiss ?? vi.fn().mockResolvedValue(undefined);
  render(
    <AntApp>
      <ProposalNote p={over.p ?? proposal()} task={over.t ?? task()} lists={over.lists ?? []} onAccept={onAccept} onDismiss={onDismiss} />
    </AntApp>,
  );
  return { onAccept, onDismiss };
}

describe('ProposalNote', () => {
  // 顺手清的时区债：下面这一条断言的是 formatWhen 转出来的本地展示时刻
  // （'17:00'），这个字符串只在东八区才对——UTC 09:00 换算成本地要看运行
  // 测试的机器在哪个时区，之前默认是东八区。跟 dueChip.test.ts/
  // calendar.test.ts 的「东八区」守卫同一个办法：`vi.stubEnv('TZ', …)`
  // 把这一条自己的时区钉死，不依赖宿主机（那两处已经验过 vi.stubEnv 在这个
  // 仓库当前 Node/vitest 组合下对 Date/Intl 立即生效，也验过不能指望 shell
  // 层 `TZ=xxx`——Git Bash 的 MSYS 会吞掉带斜杠的值）。只有这一条测试断言了
  // 具体的本地展示时刻，afterEach 挂在这个 describe 上收尾，其它用例不受
  // 影响。
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 只写新值等于要用户自己回想旧值是什么。
  it('把「从什么变成什么」都写出来，不是只写新值', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    setup({ t: task({ reminders: [{ at: '2026-08-15T09:00:00.000Z', firedAt: null }] }) });

    const row = screen.getByRole('listitem');
    expect(row.textContent).toContain('2026-08-15 17:00');   // 旧值（钉死在东八区）
    expect(row.textContent).toContain('2026-08-20 17:00');   // 新值
  });

  it('旧值原本是空的时候说「空」，不是留一段空白', () => {
    setup({ t: task({ reminders: [] }) });

    expect(screen.getByRole('listitem').textContent).toContain('空');
  });

  it('理由要显示出来——他得看得出为什么这么建议', () => {
    setup();

    expect(screen.getByText(/在等外部回复/)).toBeTruthy();
  });

  // 两次点击分开渲染：成功之后**故意不复位** busy——这条提议马上会因为
  // proposals.json 变化 → SSE → refetch 从列表里消失、整个组件卸载，
  // 这中间按钮保持禁用挡住重复提交。跟「今天」上下移按钮是同一套写法。
  it('接受调 onAccept', async () => {
    const { onAccept } = setup();
    fireEvent.click(byText('接受')!);
    await waitFor(() => expect(onAccept).toHaveBeenCalledWith('p1'));
  });

  it('忽略调 onDismiss', async () => {
    const { onDismiss } = setup();
    fireEvent.click(byText('忽略')!);
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('p1'));
  });

  it('失败时把错误说出来，按钮恢复可点——不能一直转', async () => {
    setup({ onAccept: vi.fn().mockRejectedValue(new Error('没有这条提议')) });

    fireEvent.click(byText('接受')!);

    await waitFor(() => expect(screen.getByText('没有这条提议')).toBeTruthy());
    await waitFor(() => expect(byText('接受')!.hasAttribute('disabled')).toBe(false));
  });

  it('一次只能点一个：接受进行中时忽略也禁用', () => {
    // 永不 resolve，停在进行中这一帧
    setup({ onAccept: vi.fn().mockReturnValue(new Promise(() => {})) });

    fireEvent.click(byText('接受')!);

    expect(byText('忽略')!.hasAttribute('disabled')).toBe(true);
  });
});

describe('groupProposals', () => {
  it('按 taskId 分组，同一条任务上的多条保持原顺序', () => {
    const m = groupProposals([
      proposal({ id: 'a', taskId: 't1' }),
      proposal({ id: 'b', taskId: 't2' }),
      proposal({ id: 'c', taskId: 't1' }),
    ]);

    expect(m.get('t1')?.map((p) => p.id)).toEqual(['a', 'c']);
    expect(m.get('t2')?.map((p) => p.id)).toEqual(['b']);
    expect(m.get('没有的')).toBeUndefined();
  });
});

describe('新值永远完整显示——点「接受」应用的是完整内容', () => {
  const 长文 = '补一句：先花半天只做选型，选完再决定要不要单开一条迁移任务。别一次性把整件事都扛上，那样只会一直拖着。';

  it('新值不截断', () => {
    setup({ p: proposal({ patch: { notes: 长文 } }), t: task({ notes: '旧的' }) });

    expect(screen.getByRole('listitem').textContent).toContain(长文);
  });

  it('旧值可以截——它就在上面那张卡片上原样摆着，截断不丢信息', () => {
    setup({ p: proposal({ patch: { notes: '短的新值' } }), t: task({ notes: 长文 }) });

    const txt = screen.getByRole('listitem').textContent ?? '';
    expect(txt).toContain('…');
    expect(txt).not.toContain(长文);
  });
});

/**
 * 这一批（可编辑字段）刚把 priority/tags/listId/repeat 补进 `PROPOSABLE`
 * 白名单能提议、卡片和编辑表单也认得这四个字段了——但提议卡片本身在那之前
 * 就写死了，FIELD_LABEL 和 show() 都只认旧的五个字段。四个字段各一条，
 * 逐条断言渲染出的是人话（字段名是中文、值不是 [object Object]/裸 uuid），
 * 不是新旧值判断本身——那些已经在别处测过（TaskFields.test.tsx/
 * RepeatFields.test.tsx）。
 */
describe('提议块渲染这一批新补的四个字段——不再是裸英文名和 [object Object]', () => {
  it('priority：字段名是「优先级」，值是「高」/「无」，不是数字', () => {
    setup({ p: proposal({ patch: { priority: 3 } }), t: task({ priority: 0 }) });

    const txt = screen.getByRole('listitem').textContent ?? '';
    expect(txt).toContain('优先级');
    expect(txt).not.toContain('priority');
    expect(txt).toContain('高');   // 新值：PRI_LABEL[3]
    expect(txt).toContain('无');   // 旧值：priority 0，PRI_LABEL 里没有 0
  });

  it('tags：字段名是「标签」，不是裸英文', () => {
    setup({ p: proposal({ patch: { tags: ['工作', '紧急'] } }), t: task({ tags: [] }) });

    const txt = screen.getByRole('listitem').textContent ?? '';
    expect(txt).toContain('标签');
    expect(txt).not.toContain('tags');
    expect(txt).toContain('工作');
    expect(txt).toContain('紧急');
    expect(txt).not.toContain('[object Object]');
  });

  it('listId：字段名是「清单」，值是清单名，不是裸 uuid', () => {
    setup({ p: proposal({ patch: { listId: 'L1' } }), t: task({ listId: null }), lists: LISTS });

    const txt = screen.getByRole('listitem').textContent ?? '';
    expect(txt).toContain('清单');
    expect(txt).not.toContain('listId');
    expect(txt).toContain('工作');   // LISTS 里 L1 的名字
    expect(txt).not.toContain('L1');
  });

  it('listId 指向一个已经被删掉的清单：说「（清单已删）」，不是裸 id', () => {
    setup({ p: proposal({ patch: { listId: '早没了' } }), t: task({ listId: null }), lists: LISTS });

    const txt = screen.getByRole('listitem').textContent ?? '';
    expect(txt).toContain('（清单已删）');
    expect(txt).not.toContain('早没了');
  });

  it('repeat：字段名是「重复」，值是人话，不是 [object Object]', () => {
    setup({
      p: proposal({ patch: { repeat: { every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null } } }),
      t: task({ repeat: null }),
    });

    const txt = screen.getByRole('listitem').textContent ?? '';
    expect(txt).toContain('重复');
    expect(txt).not.toContain('repeat');
    expect(txt).toContain('每周一');   // describeRepeat 的输出，跟卡片上一致
    expect(txt).not.toContain('[object Object]');
    expect(txt).toContain('空');       // 旧值：task.repeat 是 null
  });
});

/**
 * 提议卡上那几个字段的渲染。**这块的规矩是「新值一律完整显示」**——点「接受」
 * 应用的是完整内容，让人批准一份自己看不全的改动是不能接受的。
 */
describe('ProposalNote：提醒全列出来', () => {
  const at = (h: number) => new Date(2026, 7, 20, h).toISOString();

  const show = (patch: Proposal['patch']) => setup({ p: proposal({ patch }) });

  it('**几个提醒就列几个**——这段原来只取第一条（那时候表单也只编辑得了一个）', () => {
    show({ reminders: [{ at: at(9), firedAt: null }, { at: at(18), firedAt: null }] });
    const text = document.body.textContent ?? '';
    expect(text).toContain(formatWhen(at(9)));
    expect(text).toContain(formatWhen(at(18)));
  });

  it('一个就是一个，不多加分隔号', () => {
    show({ reminders: [{ at: at(9), firedAt: null }] });
    expect(document.body.textContent).not.toContain('、');
  });

  it('空数组说「空」，不是一片空白', () => {
    show({ reminders: [] });
    expect(document.body.textContent).toContain('空');
  });

  it('坏掉的那条跳过，不印 Invalid Date', () => {
    show({ reminders: [{ at: '下周三', firedAt: null }, { at: at(9), firedAt: null }] });
    expect(document.body.textContent).not.toContain('Invalid');
  });
});

/**
 * **能被建议修改的每个字段都得有中文名。** 漏一个，AI 提了那个字段的建议时
 * 卡片上就冒出一个裸英文键名——两份名单在不同的包里，只能手工对齐，这条
 * 测试就是那份对齐的执行者。
 */
describe('提议卡的字段名跟服务端白名单对得上', () => {
  /** 用一个该字段的合法值渲染一张提议卡，把整块文字吐回来。 */
  const setupField = (f: string): string => {
    const sample: Record<string, unknown> = {
      title: '新标题', notes: '新备注', due: '2026-08-20T09:00:00.000Z', startAt: null,
      reminders: [{ at: '2026-08-20T09:00:00.000Z', firedAt: null }],
      subtasks: [{ text: '一步', done: false }], tags: ['紧急'], listId: null,
      repeat: { every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null },
      priority: 3, waitingFor: '张老师回邮件',
    };
    cleanup();
    setup({ p: proposal({ patch: { [f]: sample[f] } as Proposal['patch'] }) });
    return document.body.textContent ?? '';
  };
  it('PROPOSABLE 里的每一个都有中文名', async () => {
    const { PROPOSABLE } = await import('../../../server/src/task.js');
    for (const f of PROPOSABLE) {
      const rendered = setupField(f);
      expect(rendered, f).not.toContain(f);   // 不该出现裸英文键名
    }
  });
});
