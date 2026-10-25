import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InboxComposer } from './InboxComposer.js';

// 「存下」恰好两个汉字：这个组件测试没有包一层设了 button={{ autoInsertSpace:
// false }} 的 ConfigProvider（那份覆盖只在 main.tsx 真实渲染的应用里生效，
// 见那边的注释），孤立渲染时 antd 仍然会插空格——跟 TaskBoard.test.tsx 等
// 文件同一条防御写法，按中文找按钮先去空白。
const byText = (text: string) => screen.getAllByRole('button').find((b) => b.textContent?.replace(/\s/g, '') === text);

describe('InboxComposer：回车换行，Ctrl+回车提交', () => {
  it('普通回车不提交——中文输入法的候选确认键也走这条，不该被拦下来', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<InboxComposer onSubmit={onSubmit} />);
    const box = screen.getByPlaceholderText(/想到什么写什么/);

    fireEvent.change(box, { target: { value: '第一行' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Ctrl+回车提交', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<InboxComposer onSubmit={onSubmit} />);
    const box = screen.getByPlaceholderText(/想到什么写什么/);

    fireEvent.change(box, { target: { value: '要提交的内容' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledWith('要提交的内容');
  });

  it('按钮照样能提交', () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<InboxComposer onSubmit={onSubmit} />);
    const box = screen.getByPlaceholderText(/想到什么写什么/);

    fireEvent.change(box, { target: { value: '按按钮提交' } });
    fireEvent.click(byText('存下')!);

    expect(onSubmit).toHaveBeenCalledWith('按按钮提交');
  });

  /**
   * 框会在切到「习惯」这类模块、以及宽窄屏切换时被卸载重建。草稿不能跟着
   * 组件一起没——`draftRef` 是它跨挂载的落脚处。
   */
  it('卸载再挂回来，打了一半的字还在——草稿跟着 ref 走，不跟组件走', () => {
    const draftRef = { current: '' };
    const first = render(<InboxComposer draftRef={draftRef} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/想到什么写什么/), { target: { value: '写了一半' } });
    expect(draftRef.current).toBe('写了一半');

    first.unmount();
    render(<InboxComposer draftRef={draftRef} onSubmit={vi.fn()} />);
    expect((screen.getByPlaceholderText(/想到什么写什么/) as HTMLTextAreaElement).value).toBe('写了一半');
  });
});

/**
 * **框自己得说出它叫什么。**
 *
 * 命令面板里那条命令叫「随手记」（`N`），快捷键表里叫「随手记」，空状态那句
 * 「想不清楚就先写进『随手记』」也这么说——而这个框在屏幕上从来没出现过这
 * 三个字。照着那些说明去找的人找不到它。一个动作在整个流程里只用一个词，
 * 这是最后一处还没兑现的。
 */
describe('InboxComposer：框自己的名字', () => {
  it('屏幕上写着「随手记」——别处一律这么叫它', () => {
    render(<InboxComposer onSubmit={vi.fn()} />);
    expect(screen.getByText('随手记')).toBeTruthy();
  });

  it('是个标题不是普通一行字——读屏跳标题时能落在这一段上', () => {
    const { container } = render(<InboxComposer onSubmit={vi.fn()} />);
    expect(container.querySelector('h2.ink-composer-name')?.textContent).toBe('随手记');
  });

  /**
   * 「Ctrl+Enter 存下」在手机上是一条**做不到的指示**（那儿没有 Ctrl 键），窄屏
   * 靠一条 CSS 把它藏掉。规则本身由 `theme.css.test.ts` 盯着；这一条盯的是**另
   * 一半**——类名还挂不挂在这个 span 上。少了它，那条 CSS 还在、但什么都不管，
   * 而两边都不会报错。
   *
   * jsdom 不算引入的样式表，所以这里只能钉类名，钉不了「真的看不见」。
   */
  it('那句快捷键提示带着 ink-kbd-hint——窄屏靠这个类名把它藏掉', () => {
    const { container } = render(<InboxComposer onSubmit={vi.fn()} />);
    const hint = container.querySelector('.ink-kbd-hint');
    expect(hint, '没找到 .ink-kbd-hint').not.toBeNull();
    expect(hint!.textContent).toContain('Ctrl+Enter');
  });
});

describe('InboxComposer：框自己说得出名字', () => {
  /**
   * 打磨稿第一轮量出来的其中一条：整屏有「一个没有可及名字的控件」，就是它。
   * 上面那句「随手记」原本只是摆在旁边的标题，跟框没有发生关系，读屏走到框上
   * 只能念占位符。**断言用 `getByRole(name:)` 而不是读 `aria-labelledby` 属性**
   * ——可及名字是算出来的，属性拼错一个字母（id 对不上）属性看着仍是对的。
   */
  it('可及名字算出来是「随手记」', () => {
    render(<InboxComposer onSubmit={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: '随手记' })).toBeTruthy();
  });
});
