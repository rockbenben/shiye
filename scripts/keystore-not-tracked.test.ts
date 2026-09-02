import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Android release 签名用的是自签名 keystore（scripts/gen-android-keystore.sh 生成），
// 口令从环境变量读，keystore 本身和口令都绝不能进版本库——这条断言直接问 git 本身
// 「现在被跟踪的文件里有没有」，不是猜 .gitignore 写没写对：.gitignore 挡的是
// `git add` 之后不再被动追踪的新文件，挡不住已经被 `git add -f` 强制加过的文件，
// 也没法证明「历史上有没有手滑提交过一次又删掉」——`git ls-files` 问的是「HEAD
// 现在到底跟踪着什么」，这才是真正要防的事。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('自签名 keystore 不进版本库', () => {
  it('git ls-files 里没有任何 .keystore 文件，也没有 keystore.properties', () => {
    const out = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
    const tracked = out.split('\n').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0); // 门槛检查：git 命令本身得真的跑起来了

    const leaked = tracked.filter((f) => f.endsWith('.keystore') || f.split('/').pop() === 'keystore.properties');
    expect(leaked).toEqual([]);
  });
});
