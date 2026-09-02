import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { TrashView } from './TrashView.js';
import { NoMotion, task, confirmDialog, btnIn } from '../test-utils.js';
import { whenText } from '../lib/dueChip.js';
import type { TrashItem } from '../types.js';

const item = (over: Partial<TrashItem> = {}): TrashItem =>
  ({ ...task(), deletedAt: '2026-08-13T00:00:00.000Z', ...over });

/** 夹具里 deletedAt 一律 2026-08-13，NOW 定在同一年往后一点，「删于……」
 *  落在「几月几日 HH:mm」那一档，不受跑测试那天影响。 */
const NOW = new Date(2026, 7, 20, 12, 0, 0);

const show = (
  items: TrashItem[],
  on: Partial<{ onRestore: () => void; onPurge: () => void; onPurgeAll: () => void }> = {},
) =>
  render(
    <NoMotion><AntApp>
      <TrashView items={items} now={NOW} onRestore={on.onRestore ?? vi.fn()} onPurge={on.onPurge ?? vi.fn()}
        onPurgeAll={on.onPurgeAll} />
    </AntApp></NoMotion>,
  );

describe('TrashView', () => {
  it('空的时候一行安静的字', () => {
    show([]);
    expect(screen.getByText(/垃圾箱是空的/)).toBeTruthy();
  });

  it('列出标题和删除时间，空状态那句话跟着消失——不是无条件叠在列表上面', () => {
    const it_ = item({ id: 'a', title: '要删的' });
    show([it_]);
    expect(screen.getByText('要删的')).toBeTruthy();
    // 没有这条的话，「无条件同时渲染空文案和列表」这种退化实现也能让上面
    // 那句和其它测试全绿——真实界面上会变成列表上方永远挂着「垃圾箱是空的」。
    expect(screen.queryByText('垃圾箱是空的')).toBeNull();

    // 显示的是删除时间（deletedAt），不是创建时间（createdAt）——fixture 里
    // 两者差 12 天。期望值用 whenText 本身现算，不写死日期字符串，断言才
    // 不会跟着跑测试的机器时区飘（同一条教训见 taskView.test.ts 里 formatWhen
    // 那组测试的注释）。没有这条断言的话，把组件里的 whenText(t.deletedAt)
    // 悄悄换成 whenText(t.createdAt) 照样全绿——界面上会变成显示创建时间，
    // 看起来完全正常，却在说谎。
    expect(screen.getByText(new RegExp(whenText(it_.deletedAt, NOW)))).toBeTruthy();
    expect(screen.queryByText(new RegExp(whenText(it_.createdAt, NOW)))).toBeNull();

    // **「删于」在前，时间在后。** 原来是「2026-08-13 08:00 删除」——末尾那个
    // 光秃秃的「删除」跟它右边那两颗按钮（还原/彻底删除）长得像同一类东西。
    expect(screen.getByText(/^删于 /)).toBeTruthy();
  });

  it('点「还原」带上这条的 id', () => {
    const onRestore = vi.fn();
    show([item({ id: 'a', title: '要删的' })], { onRestore });
    fireEvent.click(screen.getByRole('button', { name: '还原' }));
    expect(onRestore).toHaveBeenCalledWith('a');
  });

  it('多条的时候各点各的——不是永远点到第一条', () => {
    // 这是「只测一条测不出索引写死」的那类陷阱
    const onRestore = vi.fn();
    show([item({ id: 'a', title: '甲' }), item({ id: 'b', title: '乙' })], { onRestore });
    const row = screen.getByText('乙').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: '还原' }));
    expect(onRestore).toHaveBeenCalledWith('b');
  });

  it('最近删的排最前', () => {
    // id 故意跟正确顺序反着来（更早删的那条 id 字母序更小）：如果实现偷懒
    // 按 id 字典序排（比如 a.id.localeCompare(b.id)）而不是真的看 deletedAt，
    // 排出来的顺序会是「旧的」在前——跟这条断言要的「新的在前」正好相反，
    // 能把这类假绿逮出来。之前 'old'/'new' 这两个 id 字母序恰好跟正确答案
    // 顺序重合，掩盖了这个洞。
    show([
      item({ id: 'aaa-deleted-earlier', title: '旧的', deletedAt: '2026-08-01T00:00:00.000Z' }),
      item({ id: 'zzz-deleted-later', title: '新的', deletedAt: '2026-08-13T00:00:00.000Z' }),
    ]);
    const titles = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(titles[0]).toContain('新的');
  });

  it('「彻底删除」要确认，确认之后才带上 id', async () => {
    const onPurge = vi.fn();
    show([item({ id: 'a', title: '永别' })], { onPurge });
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }));
    expect(onPurge).not.toHaveBeenCalled();            // 还没确认
    fireEvent.click(btnIn(await confirmDialog(), '彻底删除'));
    expect(onPurge).toHaveBeenCalledWith('a');
  });

  it('「彻底删除」多条的时候也各点各的——不是永远确认到第一条', async () => {
    // 跟上面「还原」那条同一类陷阱：只用一个条目测不出 onOk 里的 id 是不是
    // 写死了第一条（比如 onOk: () => onPurge(sorted[0].id)）。
    const onPurge = vi.fn();
    show([item({ id: 'a', title: '甲' }), item({ id: 'b', title: '乙' })], { onPurge });
    const row = screen.getByText('乙').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: '彻底删除' }));
    fireEvent.click(btnIn(await confirmDialog(), '彻底删除'));
    expect(onPurge).toHaveBeenCalledWith('b');
  });

  // 「还原是半程 undo」——服务端还原时不会补回收件箱关联和 AI 建议，还会清掉
  // order。用户点「还原」很容易以为是完整撤销，这句说明必须在，而且不管垃圾箱
  // 空不空都要在（空的时候更该在：那是他下次删东西之前唯一能看到这句话的地方）。
  it('顶部有一句安静的说明：还原是半程 undo（垃圾箱空的时候）', () => {
    show([]);
    expect(screen.getByText(/还原只找回任务本身/)).toBeTruthy();
  });

  it('这句说明在有内容的时候也在——不是只在空状态分支里才有', () => {
    show([item({ id: 'a', title: '要删的' })]);
    expect(screen.getByText(/还原只找回任务本身/)).toBeTruthy();
  });
});

/**
 * 清空垃圾箱（仿滴答清单）。补的是一个只能一条条点的坑：垃圾箱从来不会自己清
 * ——这个应用不做「30 天后自动清理」（那是在一个定时器上悄悄删他的数据），
 * 于是删得越多它越长，清掉两百条要点四百下。
 */
describe('TrashView：清空', () => {
  it('不给 onPurgeAll 就没有这颗按钮', () => {
    show([item({ id: 'a' })]);
    expect(screen.queryByText(/清空垃圾箱/)).toBeNull();
  });

  it('**空的时候也不摆**——一个「清空 0 条」除了占位置什么都没说', () => {
    show([], { onPurgeAll: vi.fn() });
    expect(screen.queryByText(/清空垃圾箱/)).toBeNull();
  });

  it('按钮上带条数', () => {
    show([item({ id: 'a' }), item({ id: 'b' })], { onPurgeAll: vi.fn() });
    expect(screen.getByText('清空垃圾箱（2）')).toBeTruthy();
  });

  it('**先弹确认，说清一共几条、附件也会删**——这是这个应用里最不可逆的一步，连垃圾箱都没有垃圾箱了', async () => {
    const onPurgeAll = vi.fn();
    show([item({ id: 'a' }), item({ id: 'b' })], { onPurgeAll });

    fireEvent.click(screen.getByText('清空垃圾箱（2）'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('2');
    expect(dialog.textContent).toContain('附件');
    expect(onPurgeAll).not.toHaveBeenCalled();

    fireEvent.click(btnIn(dialog, '清空'));
    await waitFor(() => expect(onPurgeAll).toHaveBeenCalled());
  });
});
