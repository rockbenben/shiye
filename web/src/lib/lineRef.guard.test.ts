import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **注释里不许写 `某文件.ts:123` 这种行号引用。**
 *
 * 行号会飘，而且飘了没有任何东西会红。一次全量审计把这类引用逐条对过：
 * **35 处里 25 处指错了**——目标行上是空行、注释的收尾那一行、一条 import，或者一段
 * 完全无关的代码。它们不是一开始就写错的，是被后来的改动挤走的（`model.ts`
 * 从 `store.ts` 拆出去那次一口气挤掉了好几条）。
 *
 * 更糟的是它**看起来很精确**：读的人会照着行号跳过去，然后对着一段不相干的
 * 代码琢磨半天，怀疑的是自己而不是注释。
 *
 * 改成写符号名（`store.ts 的 aiSeesSameData()`、`app.ts 里 beat 那个 setInterval`）
 * ——符号被改名时 grep 得到，被删掉时也找得到，而行号两样都做不到。
 */

// **`release` 必须在里面。** `desktop/release/` 是 electron-builder 的产物、
// gitignore 掉的，里面还躺着 AGENTS.md 和 workflows/ 的冻结副本——走进去的话
// 这条守卫的红绿就取决于本机上一次打包是什么时候，CI 绿、开发机红，而且指着
// 一个改源码也修不掉的路径。兄弟守卫 `server/src/agentsMd.guard.test.ts` 早就
// 声明了正确的那一套，照抄。
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|css|mjs|yml|md)$/.test(name)) out.push(p);
  }
  return out;
}

describe('注释里不写行号引用——行号会飘，符号名不会', () => {
  it('全仓库没有 `xxx.ts:123` 这种引用', () => {
    // `:数字` 也可能是别的东西（端口、时间 12:30），所以只认「文件名 + 冒号 +
    // 数字」这一种形状，而且文件名必须带 .ts/.tsx/.css/.mjs 后缀。
    const re = /[A-Za-z0-9_./-]+\.(?:tsx|ts|css|mjs)[:：]\d{1,4}/g;
    const bad: string[] = [];
    // **扫的范围要对得上用例名里那句「全仓库」。** 上一版只走三个 src 目录、
    // 只收 .ts/.tsx/.css——而它自己的正则里就写着 .mjs，那一档形同虚设；
    // `desktop/electron-builder.yml` 里当时正躺着一条 `server/src/index.ts:16`，
    // 守卫全绿。工具脚本、配置和 md 里的行号一样会飘，一样会把人指错地方。
    // `desktop` 已经涵盖 `desktop/src`，两个都列会把桌面端源码扫两遍、报两遍。
    for (const dir of ['web/src', 'server/src', 'tools', 'scripts', 'desktop', 'android']) {
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        // 跳过自己：这个文件的用例名和注释里就写着 `xxx.ts:123` 当例子。
        if (file.endsWith('lineRef.guard.test.ts')) continue;
        readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
          for (const m of line.match(re) ?? []) bad.push(`${file}:${i + 1}  ${m}`);
        });
      }
    }
    expect(bad, `这几处写了行号，改成符号名：\n${bad.join('\n')}`).toEqual([]);
  });
});
