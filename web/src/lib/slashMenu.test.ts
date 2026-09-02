import { describe, it, expect } from 'vitest';
import { applySnippet, matchSnippets, slashQuery, SNIPPETS } from './slashMenu.js';

const byLabel = (label: string) => SNIPPETS.find((s) => s.label === label)!;

describe('slashQuery', () => {
  it('行首的斜杠认', () => {
    expect(slashQuery('/', 1)).toEqual({ start: 0, query: '' });
  });

  it('空白后面的斜杠认', () => {
    expect(slashQuery('买菜 /l', 5)).toEqual({ start: 3, query: 'l' });
  });

  it('换行后面的也算行首', () => {
    expect(slashQuery('第一行\n/t', 6)).toEqual({ start: 4, query: 't' });
  });

  it('**日期和网址里的斜杠不弹**——那才是斜杠最常见的用法', () => {
    expect(slashQuery('2026/08/22', 10)).toBeNull();
    expect(slashQuery('https://a.com/b', 15)).toBeNull();
    expect(slashQuery('a/b', 3)).toBeNull();
  });

  it('命令里出现空白就当作不用了', () => {
    expect(slashQuery('/标题 然后', 5)).toBeNull();
  });

  it('光标在斜杠前面时不认——只看光标左边那一段', () => {
    expect(slashQuery('买菜 /l', 2)).toBeNull();
  });

  it('压根没有斜杠', () => {
    expect(slashQuery('买菜', 2)).toBeNull();
  });
});

describe('matchSnippets', () => {
  it('刚打下斜杠时给全部——那一刻正是「让我看看有什么」', () => {
    expect(matchSnippets('')).toHaveLength(SNIPPETS.length);
  });

  it('按拉丁键筛（中文输入法下敲中文很别扭，留一条拉丁的路）', () => {
    expect(matchSnippets('todo').map((s) => s.label)).toEqual(['待办项']);
  });

  it('按中文名也筛得到——「代码」两条都命中（代码块和行内代码），顺序照 SNIPPETS', () => {
    expect(matchSnippets('代码').map((s) => s.label)).toEqual(['代码块', '行内代码']);
    expect(matchSnippets('分割').map((s) => s.label)).toEqual(['分割线']);
  });

  it('筛不到就是空——调用方据此收起菜单，不摆一个空框', () => {
    expect(matchSnippets('zzz')).toEqual([]);
  });

  it('每条都至少能被它自己的第一个键筛到', () => {
    for (const s of SNIPPETS) {
      expect(matchSnippets(s.keys[0]), s.label).toContain(s);
    }
  });
});

describe('applySnippet', () => {
  it('把 /命令 那一段换成片段，光标落在记号处', () => {
    // "买菜 /l" 光标在末尾（6）
    const r = applySnippet('买菜 /l', 6, 3, byLabel('无序列表'));
    expect(r.text).toBe('买菜 - ');
    expect(r.caret).toBe(5);
  });

  it('待办项的光标落在方括号后面，不是整段末尾之外', () => {
    const r = applySnippet('/t', 2, 0, byLabel('待办项'));
    expect(r.text).toBe('- [ ] ');
    expect(r.caret).toBe(6);
  });

  it('**代码块的光标落在两行反引号中间**——落在末尾的话每次都要自己再点回去', () => {
    const r = applySnippet('/c', 2, 0, byLabel('代码块'));
    expect(r.text).toBe('```\n\n```');
    expect(r.caret).toBe(4);
  });

  it('链接的光标落在方括号里等着打字', () => {
    const r = applySnippet('/a', 2, 0, byLabel('链接'));
    expect(r.text).toBe('[](https://)');
    expect(r.caret).toBe(1);
  });

  it('光标右边的文字原样留着', () => {
    // "/l 后面" 光标在 2
    const r = applySnippet('/l 后面', 2, 0, byLabel('无序列表'));
    expect(r.text).toBe('-  后面');
  });

  it('插进去的文字里没有那个光标记号', () => {
    for (const s of SNIPPETS) {
      expect(applySnippet('/x', 2, 0, s).text, s.label).not.toContain('\u0001');
    }
  });
});

/**
 * 后加的五条：行内格式和表格。**渲染器一直支持，菜单一个都没提**，而这个菜单
 * 的主要理由就是「备注按 Markdown 渲染，界面上一个字都没说过」——它同时是那件
 * 事的说明书，说明书漏掉最常用的加粗和斜体说不通。
 */
describe('SNIPPETS：行内格式和表格', () => {
  const byLabel = (label: string) => SNIPPETS.find((s) => s.label === label)!;
  const insert = (label: string) => applySnippet('', 0, 0, byLabel(label));

  it.each([
    ['粗体', '****', 2],
    ['斜体', '**', 1],
    ['删除线', '~~~~', 2],
    ['行内代码', '``', 1],
  ])('%s 插进去是 %s，光标落在中间', (label, text, caret) => {
    expect(insert(label)).toEqual({ text, caret });
  });

  it('表格是能渲染出来的最小一张：表头 + 分隔行 + 一行数据，光标在第一格', () => {
    const { text, caret } = insert('表格');
    expect(text.split('\n')).toEqual(['|  |  |', '| --- | --- |', '|  |  |']);
    expect(text[caret - 1]).toBe(' ');
    expect(text.slice(0, caret)).toBe('| ');
  });

  it('**原来那八条一个字都没动**，新的排在后面——`/` 之后直接回车一直取第一条', () => {
    expect(SNIPPETS.slice(0, 8).map((s) => s.label))
      .toEqual(['标题', '无序列表', '有序列表', '待办项', '引用', '代码块', '分割线', '链接']);
    expect(SNIPPETS).toHaveLength(13);
  });

  it('**行内代码不占 `c`**：`c` 本来就已经是三条共用的前缀（check / code / ct），再让行内代码也挤进去，最常用的代码块要多敲两个字母才唯一', () => {
    // 这一条钉的是「没有变得更挤」，不是「c 只有一条」——'c' 从来就不唯一。
    expect(matchSnippets('c').map((s) => s.label)).toEqual(['待办项', '代码块', '粗体']);
    expect(matchSnippets('co').map((s) => s.label)).toEqual(['代码块']);
    expect(matchSnippets('ic').map((s) => s.label)).toEqual(['行内代码']);
    expect(matchSnippets('ct').map((s) => s.label)).toEqual(['粗体']);
  });
});
