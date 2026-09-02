import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **在 JSX 里把一句中文折行，渲染出来中间会多一个空格。**
 *
 * JSX 把文本节点里的「换行 + 缩进」折成一个空格——对英文正好（单词之间本来就
 * 要空格），对中文就是句子里凭空多一个洞：
 *
 * ```jsx
 * <p>
 *   跑完一轮就会记在这里；忘了
 *   计时的那几段可以在下面补记。
 * </p>
 * ```
 * 屏幕上是「忘了 计时的那几段」。
 *
 * 这类 bug 编译不报、类型不管、单测断言文本时多半也用的是 `toContain` 或正则，
 * 照样绿。
 *
 * **别在这儿记「一共几处」。** 这段先后写过「两处」「十七处」，两次都当场就
 * 过期了：第一个数字是只扫渲染结果得到的（漏了没点开的设置分页、离线横幅），
 * 第二个是判据还只认汉字时得到的（把断行挪到句号后面就绕过去了，而空格照旧）。
 * 要数就跑这条测试，别抄进注释。
 *
 * 扫源码不扫 DOM 的理由倒是不变：渲染态永远只覆盖你恰好走到的那几屏。
 *
 * 判据只看**折行处两边都是汉字**：中英混排时那个空格通常是想要的
 * （「跑完 30 分钟」），所以不碰。
 */

const SKIP = new Set(['node_modules', 'dist', 'build']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx') && !name.includes('.test.')) out.push(p);
  }
  return out;
}

/**
 * 把注释和字符串挖掉再看。**这一步是必须的**：这个仓库的注释全是中文而且行行
 * 折行，不挖的话每个文件都能报出几十条假阳性，守卫当场变成噪音。
 * 字符串字面量里的换行不会被 JSX 折叠，也不该算。
 */
/**
 * 把注释挖掉再看。**这一步是必须的**：这个仓库的注释全是中文而且行行折行，
 * 不挖的话每个文件都能报出几十条假阳性，守卫当场变成噪音。
 *
 * 只挖注释、不挖字符串字面量：跨行的只有模板字符串，而模板里的换行是真换行、
 * 不会被 JSX 折成空格；下面那条「纯文本行」的过滤也把带引号的行排除了。
 * 挖字符串要写的正则里全是双反斜杠，而这个仓库已经在「工具链吃掉反斜杠」上
 * 栽过好几次了，能不写就不写。
 */
function stripComments(src: string): string {
  // **挖掉注释时要把换行留下**：直接替换成空串会把多行注释压没，后面每一行的
  // 行号全部左移，报出来的位置指向别处——第一版就是这样，报的 11 处line号
  // 全是错的，照着去看只会看到不相干的代码。
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // `(^|[^:])` 是必需的：不加的话 `http://192.168.1.5` 里的 `//` 会被当成
    // 注释，把那一行后半截连同中文一起挖掉（设置里那句服务地址说明就是）。
    // `scripts/identity-literals.test.ts` 早踩过并修好了，这儿照抄它那条。
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, pre: string) => pre + blank(m.slice(pre.length)));
}

// **两边都放宽到中文标点**，不只是汉字。上一版只认 `[\u4e00-\u9fff]`，
// 于是「把断行挪到句号后面」就能绕过它——而 JSX 照样折出一个空格，屏幕上是
// 「记在这里； 忘了」。这个盲区不是假想：上一轮就是这么「修」了两处，守卫
// 全绿，空格一个没少。
//
// 不含 ASCII 标点：中英混排时那个空格通常是要的（「跑完 30 分钟」）。
// 破折号和省略号（`——`/`……`）也算：它们天天出现在这些句子的行尾。
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2014\u2026]/;

/** 去掉行内的 JSX 标签，只留会被渲染成文本的那部分。 */
const text = (line: string): string => line.replace(/<[^>]*>/g, '');

describe('JSX 里的中文不许折行——折了会在句子中间多一个空格', () => {
  it('所有 .tsx 里，没有「上一行以汉字结尾、下一行以汉字开头」的 JSX 文本', () => {
    const bad: string[] = [];
    for (const file of walk('web/src')) {
      const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        // **剥掉标签和表达式，再看剩下的文本边界**——不能因为「这一行带 <b>」
        // 就把整对丢掉。上一版就是那么写的，而实测 9 处漏网**全部**发生在带
        // `<b>`/`<strong>` 的行上：那正是需要强调、因而最容易折行的句子。
        const rawA = lines[i].trimEnd();
        const rawB = lines[i + 1].trimStart();
        if (!rawA || !rawB) continue;
        // **判据：文本节点有没有真的跨行。**
        //
        // JSX 只对**同一个文本节点内部**的换行折成空格；两个元素之间的空白
        // （`</button>` 换行 `<button>`）是整个丢掉的，不会渲染出空格。所以
        // 上一行以 `>` 收尾、或者下一行以 `<` 开头，都说明中间隔着元素边界，
        // 不是风险。反过来 `…</b>——` 换行接 `两台设备…` 就是真的：`</b>` 之后
        // 那个破折号仍属于外层那个文本节点，换行照折。
        //
        // 这条替掉了「行里带 `<`/`{` 就整对跳过」那种一刀切——那样会把最需要
        // 强调、因而最容易折行的句子（带 `<b>` 的那些）全部漏掉，实测漏 9 处。
        if (rawA.endsWith('>') || rawB.startsWith('<')) continue;
        // **看括号配不配平，不是「行里有没有 `=`」。** 行内出现 `=`（比如
        // `<b style={{ fontWeight: 600 }}>`）不代表断行落在属性里——边界在哪儿
        // 上面那条已经判过了。按「有没有 `=`」跳过会漏掉真的：设置里那两句就
        // 因为同一行带了个内联样式而逃掉。真正该跳的是**断行落在表达式或模板串
        // 内部**——那种情况下这一行的 `{` 或反引号是不配平的。
        const 未闭合 = (l: string) =>
          (l.split('{').length - l.split('}').length) !== 0 || (l.split('`').length - 1) % 2 !== 0;
        if (未闭合(rawA)) continue;
        const a = text(rawA).trimEnd();
        const b = text(rawB).trimStart();
        if (!a || !b) continue;
        if (!CJK.test(a.slice(-1)) || !CJK.test(b.slice(0, 1))) continue;
        bad.push(`${file}:${i + 1}  「…${a.slice(-10)}」 换行接 「${b.slice(0, 10)}…」`);
      }
    }
    expect(bad, `这几处渲染出来会在中文中间多一个空格：\n${bad.join('\n')}`).toEqual([]);
  });
});
