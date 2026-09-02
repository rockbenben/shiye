import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * **网页包里不许出现 node 内置。**
 *
 * 这条守的是一次实打实的白屏，而且是这个仓库里第一次出现「四千多条测试全绿、
 * 打出来的包一加载就死」：
 *
 * ```
 * TypeError: (0 , bI.fileURLToPath) is not a function
 * ```
 *
 * 成因：`server/src/store.ts` 当时同时是「数据模型」和「磁盘层」，顶层有一句
 * `const here = dirname(fileURLToPath(import.meta.url))`。而网页按既有约定直接引
 * `server/src/*.js` 共用纯逻辑（`dataSource.ts` 引 `mutate.js` 是最早那条），于是
 * 两条链把整个磁盘层拖进了网页包：
 *
 * ```
 * web/src/lib/habit.ts       → store.js                        （为了一个 HABIT_EVERY）
 * web/src/lib/dataSource.ts  → mutate.js → task.js → store.js
 * ```
 *
 * Vite 把 `node:url` externalize 成浏览器里的空壳，那一行在**模块顶层**执行，
 * React 根本没 mount，整页白屏。
 *
 * **为什么没有任何一层拦住它**：`npm test` 跑在 node 里（`fileURLToPath` 真实
 * 存在），typecheck 和 `vite build` 都不执行这一行——build 只在日志里留了一句
 * 「Module "node:fs" has been externalized for browser compatibility」，一条谁都
 * 没当回事的警告。模型层切去 `model.ts` 之后那句警告也消失了，而**一条消失的
 * 警告不是守卫**：下一个人只要在网页够得到的模块里值导入一次 `store.js`，白屏
 * 就原样回来，测试照样全绿。
 *
 * 所以这里机械地走一遍：从 `web/src` 的每个非测试文件出发，沿**值导入**做传递
 * 闭包，任何够得到的模块只要引了 `node:` 内置就红，并把整条链路打出来——报的是
 * 「谁把它拉进来的」，不是「有个文件引了 node:fs」，因为前者才是要改的地方。
 *
 * **`import type` 不算**：那是编译期的东西，`tsc` 会整句擦掉，打不进包。所以
 * `mutate.ts` 里 `import type { Task } from './store.js'` 是完全正当的，这条守卫
 * 也不该拦它——拦了就会逼着人把类型也搬走，那是没有收益的改动。
 */

const ROOT = resolve(__dirname, '../../..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * 一个文件里的**值导入**说明符。
 *
 * 三种要排掉的写法：`import type { X } from` / `import { type X } from`（整句都是
 * 类型）/ `export type { X } from`。剩下的——具名值导入、默认导入、命名空间导入、
 * 副作用导入（`import './x.js'`）、以及 `export * from`（它真的会把那个模块拉进
 * 运行时）——都算。
 */
function valueImports(src: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) continue;                       // import type … / export type …
    const clause = m[2];
    if (clause.trim().startsWith('{')) {
      const names = clause.replace(/[{}]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
      // 花括号里**每一个**都带 `type ` 前缀，整句就是纯类型导入
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    out.push(m[3]);
  }
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

/** 相对说明符 → 真实文件。`.js` 是 TS 的 ESM 写法，盘上是 `.ts`/`.tsx`。 */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;     // 包名或 node: 内置，不往下走
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, '');
  for (const ext of ['.ts', '.tsx']) {
    try { statSync(base + ext); return base + ext; } catch { /* 试下一个 */ }
  }
  return null;
}

const rel = (p: string) => p.slice(ROOT.length + 1).replace(/\\/g, '/');

/** 从 web/src 出发的传递闭包。返回 `文件 → 把它拉进来的那条链`。 */
function reachable(): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; via: string[] }> = tsFiles(join(ROOT, 'web/src')).map((f) => ({ file: f, via: [] }));
  while (queue.length) {
    const { file, via } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, via);
    let src: string;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    for (const spec of valueImports(src)) {
      const next = resolveSpec(file, spec);
      if (next && !seen.has(next)) queue.push({ file: next, via: [...via, rel(file)] });
    }
  }
  return seen;
}

describe('网页包：够得到的模块一个都不许引 node 内置', () => {
  const graph = reachable();

  it('**一条都没有**——有的话下面会写出是谁把它拉进来的', () => {
    const bad: string[] = [];
    for (const [file, via] of graph) {
      const src = readFileSync(file, 'utf8');
      for (const spec of valueImports(src)) {
        if (!spec.startsWith('node:')) continue;
        bad.push(`${rel(file)} 值导入了 ${spec}\n    链路: ${[...via, rel(file)].join(' → ')}`);
      }
    }
    expect(bad, `\n${bad.join('\n')}\n`).toEqual([]);
  });

  /**
   * 上面那条要是因为「一个文件都没扫到」而绿，就是一道摆设。这里钉住闭包真的
   * 走进了 `server/src`——网页共用服务端纯逻辑是这个仓库的既有约定，不是意外。
   */
  it('清点：闭包确实走进了 server/src，不是一条边都没走就绿了', () => {
    const server = [...graph.keys()].filter((f) => rel(f).startsWith('server/src/'));
    expect(server.length).toBeGreaterThan(0);
    // 这几条是既有约定里明写的共用模块，掉了任何一条说明闭包算漏了。
    const names = server.map((f) => rel(f));
    expect(names).toContain('server/src/mutate.ts');
    expect(names).toContain('server/src/repeat.ts');
    expect(names).toContain('server/src/model.ts');
  });

  /**
   * **`import type` 必须被放行。** 少了这一条，有人会为了让守卫变绿而把类型
   * 也搬来搬去——而类型根本打不进包，那种改动是纯粹的噪音。
   */
  it('`import type` 不算值导入：`mutate.ts` 引 `store.ts` 的类型是正当的，闭包不该把 store.ts 拉进来', () => {
    const names = [...graph.keys()].map(rel);
    expect(names).not.toContain('server/src/store.ts');
    // 对照：那句 import type 真的还在，上面那条不是因为它被删了才绿的。
    expect(readFileSync(join(ROOT, 'server/src/mutate.ts'), 'utf8'))
      .toContain("import type { InboxItem, Proposal, Task, TrashItem, Subtask } from './store.js';");
  });
});
