import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **自己按的按钮不用 `type="primary"`。**
 *
 * 这个应用的主色（`theme.ts` 的 `colorPrimary`）是群青 `ink.ai`，而群青在这套
 * 设计里有确切的意思：**这是 AI 产出的东西**（README「双色墨水」那节）。所以
 * `type="primary"` 不是「这颗按钮比较重要」的意思，是「这颗按钮属于 AI」。
 * 表示分量的是 `variant`：`color="default" variant="solid"` 就是一颗最重的
 * 墨黑按钮，跟设置面板的「保存」、卡片编辑态的「保存」是同一个写法。
 *
 * ## 这条守卫是补账补出来的
 *
 * 约定本身在三处注释里写得清清楚楚（`InboxComposer.tsx`、`SettingsModal.tsx`、
 * `TaskCard.tsx`，各自还写了理由），**但没有任何东西拦着它**。于是收件箱侧栏
 * 新加的「重新拆解」确认按钮照手感写了 `type="primary"`，一路过了 typecheck、
 * 过了 4900 条测试、过了构建——最后是截图肉眼看出来那颗是蓝的。
 *
 * 「写在注释里的约定」和「会红的约定」差的就是这一次。
 *
 * ## 扫法
 *
 * 先剥注释再找：那三处注释里都逐字写着 `type="primary"`（正是在说「别用这个」），
 * 不剥的话这条测试第一次跑就红在三份文档上。剥法保留行数，报错能指到行。
 */
const ROOT = 'web/src';
const EXT = /\.tsx$/;
/** 测试文件里出现 `type="primary"` 是在断言别人的行为，不是在画按钮。 */
const SKIP = /\.test\.tsx$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'dist' ? [] : walk(p);
    return EXT.test(e.name) && !SKIP.test(e.name) ? [p] : [];
  });
}

/**
 * 把块注释（含 JSX 里那种花括号包起来的）和行注释里的内容抹成空格，
 * **换行一个不动**——行号要能对上。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, head: string) => head + ' '.repeat(m.length - head.length));
}

describe('群青只给 AI：自己按的按钮不用 type="primary"', () => {
  it('web/src 下的组件里一个 type="primary" 都没有', () => {
    const hits: string[] = [];
    for (const file of walk(ROOT)) {
      stripComments(readFileSync(file, 'utf8')).split(/\r?\n/).forEach((line, i) => {
        if (/type=["']primary["']/.test(line)) hits.push(`${file}:${i + 1}`);
      });
    }
    expect(hits, `这几处会拿到群青（AI 的颜色）。要一颗最重的按钮就写 color="default" variant="solid"：\n${hits.join('\n')}`)
      .toEqual([]);
  });

  /**
   * 剥注释这一步本身要能证明是活的：那三处写着约定的注释就是现成的样本，
   * 一处都不该被算成违规。剥错了（比如漏了 JSX 里那种花括号包起来的注释）这条会红。
   */
  it('注释里逐字写着 type="primary" 的那几处不算——它们正是在说「别用」', () => {
    const documented = ['InboxComposer.tsx', 'SettingsModal.tsx', 'TaskCard.tsx', 'ServerSetup.tsx']
      .map((n) => walk(ROOT).find((f) => f.endsWith(n)))
      .filter((f): f is string => !!f);
    expect(documented.length, '这四个文件都该存在——改名了就把这里跟着改').toBe(4);

    for (const file of documented) {
      const raw = readFileSync(file, 'utf8');
      expect(raw, `${file} 该在注释里写着这条约定`).toMatch(/type=["']primary["']/);
      expect(stripComments(raw), `${file} 剥注释之后不该还剩 type="primary"`).not.toMatch(/type=["']primary["']/);
    }
  });
});
