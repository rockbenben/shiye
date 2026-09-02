import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CommandPalette, type Command } from './CommandPalette.js';
import { NoMotion } from '../test-utils.js';

/** 每条命令自带一个独立的 vi.fn()——断言「哪条 run 被调用了」不会互相踩。 */
const mk = (label: string, hint?: string): Command => ({
  key: label, label, hint, run: vi.fn(),
});

function renderPalette(open: boolean, commands: Command[], onClose = vi.fn()) {
  render(
    <NoMotion>
      <CommandPalette open={open} commands={commands} onClose={onClose} />
    </NoMotion>,
  );
  return onClose;
}

describe('CommandPalette', () => {
  it('打开时输入框自动聚焦', async () => {
    renderPalette(true, [mk('切到「今天」')]);
    // afterOpenChange 是 Modal 打开动画结束后才回调，NoMotion 让动画瞬间完成，
    // 但仍然可能晚于 render() 返回那一刻，findBy/waitFor 兜住这个时序。这个仓库
    // 没装 @testing-library/jest-dom，没有 toHaveFocus，跟 App.test.tsx 里聚焦
    // 断言（:1533/:1548/:1573）同一个写法：比 document.activeElement。
    const input = await screen.findByPlaceholderText('输入命令…');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('打字过滤——匹配 label，不区分大小写', async () => {
    const focus = mk('Focus Mode');
    const today = mk('切到「今天」');
    renderPalette(true, [today, focus]);
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(input, { target: { value: 'FOCUS' } });
    expect(screen.getByText('Focus Mode')).toBeTruthy();
    expect(screen.queryByText('切到「今天」')).toBeNull();
  });

  it('中文能匹配（「日历」搜得到）', async () => {
    const calendar = mk('切到「日历」');
    const kanban = mk('切到「看板」');
    renderPalette(true, [calendar, kanban]);
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(input, { target: { value: '日历' } });
    expect(screen.getByText('切到「日历」')).toBeTruthy();
    expect(screen.queryByText('切到「看板」')).toBeNull();
  });

  it('上下箭头移动高亮，Enter 跑选中那条的 run', async () => {
    const a = mk('苹果');
    const b = mk('香蕉');
    const c = mk('橙子');
    renderPalette(true, [a, b, c]);
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // 0(a) -> 1(b)
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(b.run).toHaveBeenCalledTimes(1);
    expect(a.run).not.toHaveBeenCalled();
    expect(c.run).not.toHaveBeenCalled();
  });

  // final-review.md I2：以前只验「Enter 跑了哪条 run」，验的是 activeIndex
  // 这个数字对不对，不是屏幕上有没有东西跟着动——高亮整个拆掉，箭头键在
  // 用户眼里是死键，这条测不出来。挑第 1 条（非第 0 行）：断言落在第 0 行的
  // 话，「高亮永远停在第一条」这种坏实现也会通过。
  it('上下箭头移动高亮——真的有一条 <li> 的 aria-selected/active class 跟着变，不只是内部数字变', async () => {
    const a = mk('苹果');
    const b = mk('香蕉');
    const c = mk('橙子');
    renderPalette(true, [a, b, c]);
    const input = await screen.findByPlaceholderText('输入命令…');
    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // 0(a) -> 1(b)
    const items = within(listbox).getAllByRole('option');
    expect(items[1].getAttribute('aria-selected')).toBe('true');
    expect(items[1].className).toContain('ink-cmd-item-active');
    expect(items[0].getAttribute('aria-selected')).toBe('false');
    expect(items[0].className).not.toContain('ink-cmd-item-active');
  });

  it('高亮在第一条时按上箭头回到最后一条（环绕）', async () => {
    const a = mk('苹果');
    const b = mk('香蕉');
    const c = mk('橙子');
    renderPalette(true, [a, b, c]);
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // 0(a) 环绕 -> 2(c)
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(c.run).toHaveBeenCalledTimes(1);
    expect(a.run).not.toHaveBeenCalled();
    expect(b.run).not.toHaveBeenCalled();
  });

  it('过滤之后高亮重置到第一条——不是停在一个已经被过滤掉的位置', async () => {
    const apple = mk('苹果');
    const banana = mk('香蕉');
    const orange = mk('橙子');
    const applePie = mk('苹果派');
    const appleVinegar = mk('苹果醋');
    renderPalette(true, [apple, banana, orange, applePie, appleVinegar]);
    const input = await screen.findByPlaceholderText('输入命令…');
    // 高亮挪到最后一条（index 4，苹果醋）
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // 0 环绕 -> 4
    // 过滤到只剩「香蕉」一条（index 0）。没有重置的话 activeIndex 还停在 4，
    // filtered[4] 是 undefined——按 Enter 应该跑的是屏幕上唯一看得见的这条。
    fireEvent.change(input, { target: { value: '香蕉' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(banana.run).toHaveBeenCalledTimes(1);
    expect(apple.run).not.toHaveBeenCalled();
    expect(orange.run).not.toHaveBeenCalled();
    expect(applePie.run).not.toHaveBeenCalled();
    expect(appleVinegar.run).not.toHaveBeenCalled();
  });

  it('一条都没匹配上时说一句话，Enter 什么也不做', async () => {
    const a = mk('苹果');
    renderPalette(true, [a]);
    const input = await screen.findByPlaceholderText('输入命令…');
    fireEvent.change(input, { target: { value: '不存在的命令xyz' } });
    expect(screen.getByText('没有匹配的命令')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(a.run).not.toHaveBeenCalled();
  });

  it('Esc 关闭，调用 onClose；别的键不会', async () => {
    const a = mk('苹果');
    const onClose = renderPalette(true, [a]);
    const input = await screen.findByPlaceholderText('输入命令…');
    // 先证明「不是随便什么键都关」——不然这条断言对「任何按键都调用 onClose」
    // 的实现也成立。
    fireEvent.keyDown(input, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('open 为 false 时什么都不渲染', () => {
    renderPalette(false, [mk('苹果')]);
    expect(screen.queryByPlaceholderText('输入命令…')).toBeNull();
    expect(document.querySelector('.ant-modal')).toBeNull();
  });

  // final-review.md I1：这是快捷键唯一的可发现入口（App.tsx 顶部注释原话），
  // 这一批之前两层都零覆盖——App.tsx 算出 hint 那一层用下面 App.test.tsx
  // 的逐行核对守住，这里守的是 CommandPalette 自己渲染 hint 这一层：传了
  // 就该有 .ink-cmd-key 徽章，没传就不该有。
  it('命令带 hint 时渲染 .ink-cmd-key 徽章，没带 hint 就不渲染', async () => {
    const withHint = mk('切到「今天」', '2');
    const noHint = mk('随手记');
    renderPalette(true, [withHint, noHint]);
    const items = await screen.findAllByRole('option');
    expect(items[0].querySelector('.ink-cmd-key')?.textContent).toBe('2');
    expect(items[1].querySelector('.ink-cmd-key')).toBeNull();
  });

  // final-review.md M3：combobox 语义只做了一半——listbox/option 有了，
  // 输入框自己没有 role="combobox"/aria-controls/aria-activedescendant，
  // 箭头键移动高亮时读屏软件不会念出当前选中哪条。
  it('输入框带 combobox 语义，aria-activedescendant 跟着箭头键走', async () => {
    const a = mk('苹果');
    const b = mk('香蕉');
    renderPalette(true, [a, b]);
    const input = await screen.findByRole('combobox', { name: '命令面板' });
    expect(input.getAttribute('aria-controls')).toBe('ink-cmd-listbox');
    const listbox = screen.getByRole('listbox');
    expect(listbox.id).toBe('ink-cmd-listbox');
    const items = within(listbox).getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(items[0].id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(items[1].id);
  });
});
