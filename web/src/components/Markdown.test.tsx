import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from './Markdown.js';

describe('Markdown：五种常见构造都要渲染成对应的元素', () => {
  it.each([
    ['标题', '# 大标题', () => screen.getByRole('heading', { name: '大标题' })],
    ['列表', '- 甲\n- 乙', () => screen.getAllByRole('listitem')],
    ['代码块', '```\ncode\n```', () => document.querySelector('pre code')],
    ['链接', '[去看看](https://example.com)', () => screen.getByRole('link', { name: '去看看' })],
    ['勾选框', '- [x] 做完了', () => screen.getByRole('checkbox')],
  ] as const)('渲染 %s', (_name, source, find) => {
    render(<Markdown source={source} />);
    expect(find()).toBeTruthy();
  });
});

describe('Markdown：链接的安全属性', () => {
  it('带 target=_blank 和 rel=noopener noreferrer——新开的页拿不到 window.opener', () => {
    render(<Markdown source="[去看看](https://example.com)" />);

    const link = screen.getByRole('link', { name: '去看看' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  // final-review.md m4：这个应用的路由本身就是 hash（App.tsx 的
  // viewFromHash），备注里写一个 [去今天](#today) 要是也被强制 target=_blank，
  // 点一下会新开一个标签页、在那个新标签页里打开「当前页 + #today」——变成
  // 开出第二个应用实例，不是正常锚点那样跳到当前页的某处。
  it('锚点链接（#开头）不加 target/rel——点了在当前页跳转，不新开标签页', () => {
    render(<Markdown source="[去今天](#today)" />);

    const link = screen.getByRole('link', { name: '去今天' });
    expect(link.getAttribute('href')).toBe('#today');
    expect(link.getAttribute('target')).toBeNull();
    expect(link.getAttribute('rel')).toBeNull();
  });

  it('空 destination（[go]()）同理不加 target/rel', () => {
    render(<Markdown source="[go]()" />);

    // href="" 的 <a> 不带可访问的 link role（jsdom 的角色计算把它当成没有
    // href），按文字找元素本身，不按 role 找。
    const link = screen.getByText('go');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('target')).toBeNull();
    expect(link.getAttribute('rel')).toBeNull();
  });
});

describe('Markdown：勾选框是只读的', () => {
  it('markdown 里的勾选框是只读的——它是文本，不是 subtasks 那个数据模型', () => {
    render(<Markdown source="- [x] 做完了" />);

    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);

    // 点了没反应——不是 subtasks 那种能勾的东西，checked 状态原样不变。
    const before = checkbox.checked;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(before);
  });
});

describe('Markdown：原始 HTML 不被渲染成元素', () => {
  // 安全断言：notes 是 AI 也会写的字段。这条断言钉住「不装 rehype-raw」这个
  // 决定——哪天有人加了它，这条测试就该红。
  it('<script>/<b> 只当成文本，不会变成真的 DOM 元素', () => {
    render(<Markdown source={'<script>alert(1)</script>\n\n<b>粗</b>'} />);

    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });
});

describe('Markdown：空输入', () => {
  // final-review.md m2：只断言 textContent === '' 拦不住「渲染出一个空的
  // <div class="ink-notes-md"></div>」这种坏实现——textContent 一样是空
  // 字符串。这里补 innerHTML 断言钉住「压根不渲染任何元素」，不是「渲染了
  // 元素但元素恰好没有文字」。
  it('空字符串什么都不渲染，也不炸——连一个空的 .ink-notes-md 容器都不该有', () => {
    const { container } = render(<Markdown source="" />);

    expect(container.textContent).toBe('');
    expect(container.innerHTML).toBe('');
  });
});

describe('Markdown：表格套一层自己滚的容器', () => {
  it('**表格外面包 .ink-notes-md-table**——一张宽表不该把整张卡（进而整页）顶出横向滚动条，那是这个仓库的量测夹具一直在盯的缺陷', () => {
    const { container } = render(<Markdown source={'| 项 | 口径 |\n| --- | --- |\n| 收入 | 财务 |'} />);
    const table = container.querySelector('table');
    expect(table, '表格没渲染出来').not.toBeNull();
    expect(table!.closest('.ink-notes-md-table'), '表格没被包进滚动容器').not.toBeNull();
  });

  it('表头/表体照常渲染，没被那层容器吃掉', () => {
    const { container } = render(<Markdown source={'| 项 | 口径 |\n| --- | --- |\n| 收入 | 财务 |'} />);
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('GFM 任务列表带上 task-list-item 类——CSS 靠它去掉圆点（勾选框本身就是记号，两个记号说同一件事）', () => {
    const { container } = render(<Markdown source={'- [x] 做完了\n- [ ] 还没做'} />);
    expect(container.querySelectorAll('li.task-list-item')).toHaveLength(2);
    expect(container.querySelector('ul.contains-task-list')).not.toBeNull();
  });
});

/**
 * 行内模式（`inline`）：检查事项那一行用的就是它——「跑 `npm run report`」
 * 这种文字在备注里早就渲染成行内代码了，换个字段不该退回一串反引号。
 */
describe('Markdown：行内模式', () => {
  it('**不另起段落**——那个 <p> 是块级的，塞进勾选框的标签里会把文字挤到下一行', () => {
    const { container } = render(<Markdown source="跑 `npm run report`" inline />);
    expect(container.querySelector('p')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('npm run report');
  });

  it('外壳也是 span，不是 div——同一个理由', () => {
    const { container } = render(<Markdown source="普通一句话" inline />);
    const wrap = container.querySelector('.ink-notes-md-inline');
    expect(wrap?.tagName).toBe('SPAN');
  });

  it('不给 inline 时一切照旧——段落还在，外壳还是 div', () => {
    const { container } = render(<Markdown source="普通一句话" />);
    expect(container.querySelector('p')).not.toBeNull();
    expect(container.querySelector('.ink-notes-md')?.tagName).toBe('DIV');
    expect(container.querySelector('.ink-notes-md-inline')).toBeNull();
  });

  it('行内模式下原始 HTML 照样不变成元素——安全边界跟块级模式是同一条', () => {
    const { container } = render(<Markdown source="<b>粗</b>" inline />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>');
  });
});


/**
 * **单个换行就是换行**，所有调用点一视同仁。
 *
 * markdown 的规矩是「软换行 = 一个空格」，而这个应用里这些文字大半是手打的：
 * 随手记那个框（提示语写着「想到什么写什么，不用整理」）、「变成任务」把那段
 * 原文原样搬进 `notes`、以及备注编辑器那个光秃秃的 `<textarea>`。三行敲进去、
 * 看到被空格拼成的一长行（实拍出来的）。
 *
 * 上一版这是个 `breaks` 开关，只给随手记；那漏掉了后两条，于是**同一段文字在
 * 收件箱里是三行、按一下「变成任务」搬到卡片上就成了一行**，而搬它的是应用自己。
 *
 * 实现是一条 `white-space: pre-wrap`，没加 `remark-breaks`。分两头钉：
 * 换行符还在不在 DOM 里（这里），和那条 CSS 在不在、有没有又被某个修饰类关起来
 * （下面那条）——jsdom 不算引入的样式表，只测组件的话两头都测不到。
 */
describe('Markdown：单个换行就是换行', () => {
  it('**换行符真的还在 DOM 里**——CSS 才有东西可画；要是被解析成空格了，再多 CSS 也白搭', () => {
    const nl = String.fromCharCode(10);
    const { container } = render(<Markdown source={['装修这件事', '先去看瓷砖'].join(nl)} />);
    const p = container.querySelector('p')!;
    expect(p.textContent).toBe(['装修这件事', '先去看瓷砖'].join(nl));
  });

  it('那条 CSS 挂在 .ink-notes-md p 上，没被修饰类关起来', () => {
    const css = readFileSync('web/src/theme.css', 'utf8');
    // 锚在**行首**的选择器本身，不用带转义的正则（这个仓库的编辑管道会把
    // 反斜杠-n 变成真换行，正则字面量里带不了）。写成 `.ink-notes-md-xxx p`
    // 的话下面这个 indexOf 就找不着了——「只给某一处开」正是上一版的毛病。
    const RULE = '.ink-notes-md p { white-space: pre-wrap; }';
    const at = css.indexOf(RULE);
    expect(at, `theme.css 里没有 \`${RULE}\``).toBeGreaterThan(0);
    expect(css[at - 1], '那条规则不在行首——被别的选择器前缀限定住了').toBe(String.fromCharCode(10));
  });
});
