import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **量测夹具注进页面的那两段代码，必须是完整的。**
 *
 * `tools/measure-ui.mjs` 把一大段带注释的浏览器代码拼进模板字符串里，交给
 * `Runtime.evaluate` 跑。**注释里出现一个反引号，外面那个模板字符串就在那儿
 * 提前闭合**——而这不会报语法错：截断处后面的字符照样能parse成别的东西，
 * 文件加载得进去，`node --check` 也过。
 *
 * 这不是假想。它真发生过：那段代码自己写着「注意：这一整段是拼进
 * Runtime.evaluate 的模板字符串里的，**注释里不能出现反引号**」，而**紧接着的
 * 下一条注释就用了反引号**（写 markdown 勾选框的那个 `- [ ]`）。结果是模板在
 * 那儿断开，`[ ]` 被当成一个数组字面量后面跟着调用括号，跑起来抛
 * `TypeError: [] is not a function`——整个夹具起手就死，一屏都量不了。
 *
 * 而 `tools/` 不在 vitest 的 include 里（node 档收的是 server/web/desktop/scripts），
 * 所以那份工具坏了之后**没有任何东西会说一声**。这条守卫住在 scripts/ 就是为了
 * 补上这一句——跟这个目录里别的几条（launchers / share-target-wired）同一个位置、
 * 同一个理由：盯的是仓库自己的工具，不是产品代码。
 *
 * 判据照着 JS 引擎的读法来：从 `expression: ` 后面那个反引号起，读到**下一个**
 * 反引号为止，那正是引擎会看到的那一段；然后拿 `new Function` 过一遍。断开的话
 * 那一段是残缺的（括号收不拢），当场抛。
 */

const BT = String.fromCharCode(96);

/**
 * 模板串里的插值（`${...}`）换成一个常量再 parse——它们是拼接时才有值的洞，
 * 原样留着当 JS 读当然不合法，那是这条守卫自己的噪音，不是被测对象的问题。
 * 不用正则：这个仓库的编辑管道会吃掉反斜杠，写 `\$\{` 迟早被改坏。
 */
function fillHoles(code: string): string {
  const OPEN = '$' + '{';
  let out = '';
  let i = 0;
  for (;;) {
    const at = code.indexOf(OPEN, i);
    if (at === -1) return out + code.slice(i);
    const close = code.indexOf('}', at);
    if (close === -1) return out + code.slice(i);
    out += code.slice(i, at) + '0';
    i = close + 1;
  }
}

/** 把每个 `expression: <模板串>` 的内容按引擎的读法抠出来。 */
function injected(): string[] {
  const src = readFileSync('tools/measure-ui.mjs', 'utf8');
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const key = src.indexOf('expression: ' + BT, from);
    if (key === -1) break;
    const start = key + ('expression: ' + BT).length;
    const end = src.indexOf(BT, start);
    if (end === -1) throw new Error('有一个 expression 模板串没有收尾的反引号');
    out.push(src.slice(start, end));
    from = end + 1;
  }
  return out;
}

describe('tools/measure-ui.mjs：注进页面的代码是完整的', () => {
  it('抠得到那几段——锚点没了就把这条守卫的锚点一起改', () => {
    expect(injected().length).toBeGreaterThanOrEqual(2);
  });

  it('**每一段都能单独 parse**——注释里混进一个反引号就会在那儿断开，而那不报语法错', () => {
    injected().forEach((code, i) => {
      expect(
        () => new Function(fillHoles(code)),
        '第 ' + (i + 1) + ' 段注进页面的代码 parse 不了：多半是某条注释里写了反引号，'
          + '把外面那个模板字符串提前闭合了。夹具会在跑起来的第一下抛 TypeError。',
      ).not.toThrow();
    });
  });
});
