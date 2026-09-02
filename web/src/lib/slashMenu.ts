/**
 * 备注框里的「/」菜单（仿滴答清单任务描述里的斜杠命令）。
 *
 * 两个理由，第二个才是主要的：
 * ① 打 `- [ ] ` 这种前缀，手打容易漏空格、漏方括号，打错就不渲染。
 * ② **备注是按 Markdown 渲染的，而界面上一个字都没说过。** 一个纯文本框，
 *    没人会想到里面能写标题和列表——这个菜单同时是那件事的说明书：打一个
 *    斜杠就看见「原来能插这些」。
 *
 * 纯函数，不碰 DOM。插入的位置和光标落点算在这里，`TaskFields` 只负责
 * 把结果写回 textarea。
 */

export interface Snippet {
  /** 菜单里显示的名字。 */
  label: string;
  /** 打 `/` 之后可以敲这些字母来筛。中文输入法下敲中文很别扭，留一条拉丁的路。 */
  keys: string[];
  /** 插进去的文字。`|` 是光标落点的记号，插入后会被去掉。 */
  template: string;
}

/** 光标落点的记号。用一个正文里几乎不会出现的字符，不是 `|`——`|` 是
 *  Markdown 表格的列分隔符，真要插一行表格时会自己撞上自己。 */
const CARET = '\u0001';

export const SNIPPETS: Snippet[] = [
  { label: '标题', keys: ['h', 'h2', 'title', 'bt'], template: `## ${CARET}` },
  { label: '无序列表', keys: ['l', 'ul', 'list', 'lb'], template: `- ${CARET}` },
  { label: '有序列表', keys: ['ol', 'num'], template: `1. ${CARET}` },
  { label: '待办项', keys: ['t', 'todo', 'check', 'db'], template: `- [ ] ${CARET}` },
  { label: '引用', keys: ['q', 'quote', 'yy'], template: `> ${CARET}` },
  { label: '代码块', keys: ['c', 'code', 'dm'], template: '```\n\u0001\n```' },
  { label: '分割线', keys: ['hr', 'line', 'fg'], template: `---\n${CARET}` },
  { label: '链接', keys: ['a', 'link', 'lj'], template: `[${CARET}](https://)` },
  // 行内格式和表格。**渲染器一直支持，菜单一个都没提**——而这个菜单的第二个
  // 理由（也是主要那个）就是「备注按 Markdown 渲染，界面上一个字都没说过」，
  // 它同时是那件事的说明书。说明书漏掉最常用的加粗和斜体，说不通。
  // 删除线和表格是 remark-gfm 给的，`Markdown.tsx` 已经挂着那个插件。
  // 排在原来八条后面，不插队：`/` 之后直接回车一直取第一条，那个行为不改。
  { label: '粗体', keys: ['b', 'bold', 'ct'], template: `**${CARET}**` },
  { label: '斜体', keys: ['i', 'italic', 'xt'], template: `*${CARET}*` },
  { label: '删除线', keys: ['s', 'strike', 'del', 'scx'], template: `~~${CARET}~~` },
  // 行内代码不占 `c`。`c` 本来就已经是三条共用的前缀（待办项的 check、代码块的
  // c/code、粗体的 ct），再让行内代码也挤进去，最常用的代码块要多敲两个字母
  // （`co`）才唯一。`ic` 是 inline-code，跟这张表里几条拉丁缩写同一路。
  { label: '行内代码', keys: ['ic', 'inline', 'hndm'], template: `\`${CARET}\`` },
  // 表格：`|` 正是当初 CARET 不用 `|` 的理由（上面那条注释），到这儿兑现了。
  // 三行是能渲染出来的最小一张表——两列一行数据，多了要删，少了不成表。
  {
    label: '表格',
    keys: ['tb', 'table', 'bg'],
    template: `| ${CARET} |  |
| --- | --- |
|  |  |`,
  },
];

/**
 * 光标处有没有一个正在打的 `/` 命令。没有返回 `null`。
 *
 * **`/` 前面必须是行首或者空白**：`2026/08/22`、`a/b`、网址里的斜杠都不该
 * 弹菜单——那才是斜杠最常见的用法，为了一个快捷入口把它们全变成误触，
 * 是拿常见换少见。
 *
 * 命令里不能有空白：打完 `/标题` 再敲空格就是不想用这个菜单了。
 */
export function slashQuery(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const slash = upto.lastIndexOf('/');
  if (slash < 0) return null;
  const before = slash === 0 ? '' : upto[slash - 1];
  if (before !== '' && !/\s/.test(before)) return null;
  const query = upto.slice(slash + 1);
  if (/\s/.test(query)) return null;
  return { start: slash, query };
}

/** 按当前打的字筛。空查询给全部——刚打下斜杠那一刻正是「让我看看有什么」。 */
export function matchSnippets(query: string): Snippet[] {
  const q = query.trim().toLowerCase();
  if (!q) return SNIPPETS;
  return SNIPPETS.filter((s) => s.label.includes(q) || s.keys.some((k) => k.startsWith(q)));
}

/**
 * 把 `/命令` 那一段换成片段，返回新文本和新的光标位置。
 *
 * 光标落在 `CARET` 记号处——插了 `- [ ] ` 之后光标该在方括号后面等着打字，
 * 插了代码块该落在两行反引号中间。少了这一步，每插一次都要自己再点一下位置。
 */
export function applySnippet(
  text: string, caret: number, start: number, s: Snippet,
): { text: string; caret: number } {
  const body = s.template.replace(CARET, '');
  const at = s.template.indexOf(CARET);
  return {
    text: text.slice(0, start) + body + text.slice(caret),
    // 模板里没有记号就落在整段之后（现在每条都有，这是兜底不是死路）。
    caret: start + (at < 0 ? body.length : at),
  };
}
