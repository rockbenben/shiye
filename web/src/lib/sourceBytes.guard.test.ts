import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **源码里不许有控制字符。**
 *
 * 这条也是补账补出来的：`web/src/components/FocusStats.tsx` 里有一个真的 `NUL`
 * 字节，藏在一句 `key={g.key ?? '…none'}` 里（那个字面量本该是 `'__none__'`）。
 * 它一个字都不显示、TypeScript 也照收——React 的 key 是什么字符都无所谓，测试
 * 全绿，构建照过。
 *
 * **它坏的是工具，不是程序**：一个字节就让整个文件被当成二进制。`grep`/`ripgrep`
 * 只回一句「Binary file … matches」不给行号，`git diff` 拒绝显示内容，编辑器
 * 里也看不出任何异常。也就是说，**这个文件从此对所有基于文本的搜索是隐形的**
 * ——而这个仓库有好几条测试正是靠读源码工作的（`keymap.test.ts` 的两条同步
 * 测试、`statusLabel.guard.test.ts`）。
 *
 * 挡的范围：ASCII 控制字符里除了 `\t`(9)、`\n`(10)、`\r`(13) 之外的全部。
 */
const ROOTS = ['web/src', 'server/src', 'desktop/src'];
const EXT = /\.(tsx?|css|json|html|md)$/;
const ALLOWED = new Set([9, 10, 13]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p);
    return EXT.test(e.name) ? [p] : [];
  });
}

describe('源码字节', () => {
  it('没有控制字符——一个 NUL 就能让整个文件对 grep/git diff 隐形', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const buf = readFileSync(file);
        const hit = buf.findIndex((c) => c < 32 && !ALLOWED.has(c));
        if (hit >= 0) offenders.push(`${file}:${buf[hit]}@${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * **孤立的 CR（不跟着 LF 的那个）也要拦。**
   *
   * 上面那条把 13 放进了 `ALLOWED`——对，CRLF 行尾里的 CR 是正常的。代价是它
   * 分不出「行尾的 CR」和「句子中间冒出来的 CR」，而后者是同一类隐形损坏：
   *
   * - `web/src/lib/composeDefaults.ts` 的一段注释本来写的是转义序列
   *   `` `/\r?\n/` ``（反斜杠加 r），文件里却是**真的 CR 和 LF 字节**——那句话
   *   讲的恰恰是 CR 的处理，而它自己被 CR 毁掉了。
   * - `web/src/lib/smartInput.ts` 有两处行尾**丢了 LF**，只剩 CR。编辑器把那
   *   几行显示成一长条。
   *
   * 两处都没有任何东西发现过：上面那条放行 13，typecheck 不管注释，
   * 而 `git status` 也是干净的——**git 遇到孤立 CR 会拒绝规范化行尾**
   * （`git add --renormalize` 对这两个文件一动不动），于是它们成了整个仓库里
   * 仅有的两个「已提交内容带 CRLF」的源文件，一直躺着。
   *
   * 判据只认「CR 后面紧跟 LF」，别的一律算。文件末尾那个孤零零的 CR 同样算。
   */
  it('没有孤立的 CR——那不是行尾，是句子里混进来的字节', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const buf = readFileSync(file);
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === 13 && buf[i + 1] !== 10) {
            offenders.push(`${file}@${i}：${JSON.stringify(buf.subarray(Math.max(0, i - 20), i + 5).toString('utf8'))}`);
            break;
          }
        }
      }
    }
    expect(offenders, '孤立 CR 会毁掉那一行的内容，而且让 git 从此拒绝规范化这个文件的行尾').toEqual([]);
  });
});
