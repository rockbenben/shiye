import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 没有测 shell 脚本本身的先例（三个启动脚本一条测试都没有），但「脚本引用的
// 文案文件确实存在、三个脚本共用同一份」是可以测的：读脚本源码，把 cat/type
// 出去的 scripts/msg/*.txt 路径抠出来，断言文件存在、三个脚本用的是同一批名字。
// 防的正是 M4 那种飘法：某个脚本悄悄把引用换回硬编码文案，从这里就再也测不出
// 「三个脚本共用一份」了。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const msgDir = join(repoRoot, 'scripts', 'msg');

const LAUNCHERS = ['启动.cmd', '启动.sh', '启动.command'];
const SHARED = ['banner.txt', 'no-node.txt', 'first-run.txt', 'rebuild.txt'];

const extractMsgFiles = (script: string): string[] => {
  const re = /scripts[\\/]msg[\\/]([\w.-]+\.txt)/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(script))) names.add(m[1]);
  return [...names];
};

describe('三个启动脚本引用的文案文件都存在', () => {
  for (const file of LAUNCHERS) {
    it(`${file} 引用的每个 scripts/msg/*.txt 都在磁盘上`, () => {
      const script = readFileSync(join(repoRoot, file), 'utf8');
      const names = extractMsgFiles(script);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(existsSync(join(msgDir, name))).toBe(true);
      }
    });
  }

  it('banner / no-node / first-run / rebuild 四份文案三个脚本都在引用，没有谁悄悄换回硬编码', () => {
    for (const file of LAUNCHERS) {
      const script = readFileSync(join(repoRoot, file), 'utf8');
      const names = extractMsgFiles(script);
      for (const shared of SHARED) {
        expect(names).toContain(shared);
      }
    }
  });
});
