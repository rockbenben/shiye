import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * `mutate.ts` / `repeat.ts` 存在的唯一理由是「平台无关，能被 web 打包」——
 * 这份契约今天没有任何自动化守卫。`npm test`（typecheck + vitest）对它完全免疫：
 * 谁手滑把 `import type { Task }` 写成 `import { readTasks }`，两边都照样全绿——
 * server 侧引 `store.ts` 完全合法，要等 Task 2 真的把这个文件打进 web 的包才会
 * 现形，隔着一整个 Task 才炸。
 *
 * 这里直接读源码文本：除了 `import type`（编译产物里整行擦掉，不影响打包）之外，
 * 不许出现任何 `from 'node:...'`——那会把一个 node 内置模块焊进这两个文件的
 * 模块图，web 打包时要么报错、要么被 vite 悄悄 externalize 成一个浏览器里
 * 用不了的空壳。
 */
const IMPORT_RE = /import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;/g;

const FILES = ['server/src/mutate.ts', 'server/src/repeat.ts', 'server/src/push.ts'];

describe('mutate.ts / repeat.ts / push.ts 平台无关：只许 import type 引用 node: 内置模块', () => {
  it.each(FILES)('%s', (file) => {
    const src = readFileSync(file, 'utf8');
    const badImports = [...src.matchAll(IMPORT_RE)]
      .map((m) => m[0])
      .filter((stmt) => /from\s+['"]node:/.test(stmt) && !/^import\s+type\b/.test(stmt));
    expect(badImports).toEqual([]);
  });
});
