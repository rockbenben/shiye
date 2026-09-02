import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { ensureAgentFiles } from './agentFiles.js';

let from: string;
let to: string;

beforeEach(() => {
  from = mkdtempSync(join(tmpdir(), 'todo-agentfiles-from-'));
  to = mkdtempSync(join(tmpdir(), 'todo-agentfiles-to-'));

  writeFileSync(join(from, 'AGENTS.md'), '新契约', 'utf8');
  mkdirSync(join(from, 'workflows'));
  writeFileSync(join(from, 'workflows', 'expand.md'), '新流程', 'utf8');
});

afterEach(() => {
  rmSync(from, { recursive: true, force: true });
  rmSync(to, { recursive: true, force: true });
});

describe('ensureAgentFiles：正常场景（from !== to）', () => {
  it('把 AGENTS.md 拷到 to 下', () => {
    ensureAgentFiles({ from, to });
    expect(readFileSync(join(to, 'AGENTS.md'), 'utf8')).toBe('新契约');
  });

  it('把 workflows/ 整个目录（含子文件）拷到 to 下', () => {
    ensureAgentFiles({ from, to });
    expect(readFileSync(join(to, 'workflows', 'expand.md'), 'utf8')).toBe('新流程');
  });

  it('返回值里两样都在 copied，skipped 是空的', () => {
    const r = ensureAgentFiles({ from, to });
    expect(r.copied.sort()).toEqual(['AGENTS.md', 'workflows']);
    expect(r.skipped).toEqual([]);
  });

  it('to 目录本来不存在也没关系——cpSync 自己会建（首次启动 agentCwd 还没建过）', () => {
    const freshTo = join(to, 'not-yet-created');
    ensureAgentFiles({ from, to: freshTo });
    expect(readFileSync(join(freshTo, 'AGENTS.md'), 'utf8')).toBe('新契约');
  });

  // AGENTS.md 和 workflows/ 都是「每次覆盖」，不是「只在不存在时拷」——
  // 只在不存在时拷会让升级后本地那份还是旧契约，AI 照旧契约写、被整批拒收。
  it('AGENTS.md 已经存在也照样覆盖——不是只在缺失时才拷', () => {
    writeFileSync(join(to, 'AGENTS.md'), '旧契约，用户从没见过这个文件', 'utf8');
    ensureAgentFiles({ from, to });
    expect(readFileSync(join(to, 'AGENTS.md'), 'utf8')).toBe('新契约');
  });

  it('workflows/ 已经存在也照样覆盖', () => {
    mkdirSync(join(to, 'workflows'), { recursive: true });
    writeFileSync(join(to, 'workflows', 'expand.md'), '旧流程', 'utf8');
    ensureAgentFiles({ from, to });
    expect(readFileSync(join(to, 'workflows', 'expand.md'), 'utf8')).toBe('新流程');
  });

  // 打包场景下 from 是 resourcesPath，里面还有 server/、CLAUDE.md 这些不该被
  // 拷进 agentCwd 的东西。批发 cpSync(from, to, {recursive:true}) 这种退化
  // 实现会连它们一起倒过去——每次启动往 <userData>/agent/ 塞几百 MB，只测
  // 「AGENTS.md/workflows 拷过去了没」测不出这种「多拷了不该拷的」。
  it('只拷 AGENTS.md 和 workflows/ 这两样——不是把整个 from 目录倒过去', () => {
    writeFileSync(join(from, 'CLAUDE.md'), '排期规矩，跟拆解无关', 'utf8');
    mkdirSync(join(from, 'server'), { recursive: true });
    writeFileSync(join(from, 'server', 'not-agent-stuff.txt'), '不该被拷', 'utf8');

    ensureAgentFiles({ from, to });
    expect(readdirSync(to).sort()).toEqual(['AGENTS.md', 'workflows']);
  });
});

describe('ensureAgentFiles：from === to 整个跳过', () => {
  it('不抛——开发模式下两者都是仓库根，cpSync 把自己拷进自己会 EINVAL', () => {
    // to 里已经有内容；如果没跳过、真的执行了 cpSync(to/workflows, to/workflows)，
    // 目录自拷会抛 EINVAL，这条测试就会失败。
    mkdirSync(join(to, 'workflows'), { recursive: true });
    writeFileSync(join(to, 'AGENTS.md'), '原样不动', 'utf8');
    expect(() => ensureAgentFiles({ from: to, to })).not.toThrow();
  });

  it('两样都进 skipped，copied 是空的——不是「悄悄拷了但没告诉你」', () => {
    const r = ensureAgentFiles({ from: to, to });
    expect(r.copied).toEqual([]);
    expect(r.skipped.sort()).toEqual(['AGENTS.md', 'workflows']);
  });

  it('不碰 to 目录下已有的内容', () => {
    writeFileSync(join(to, 'AGENTS.md'), '原样不动', 'utf8');
    ensureAgentFiles({ from: to, to });
    expect(readFileSync(join(to, 'AGENTS.md'), 'utf8')).toBe('原样不动');
  });

  it('也不会去创建 to 目录本身——跳过是真跳过，不发起任何 fs 调用', () => {
    const notCreated = join(to, 'never-created');
    ensureAgentFiles({ from: notCreated, to: notCreated });
    expect(existsSync(notCreated)).toBe(false);
  });

  // 裸字符串比较（from === to）挡不住「同一个目录、拼法不同」——比如结尾多一个
  // 分隔符。真实触发路径：开发模式下显式设了 DATA_DIR=<repoRoot>/data 时，
  // agentCwd 算的是 dirname(explicit)，字面量可能跟 host.repoRoot 只差一个
  // 尾部分隔符。裸字符串比较会判定「不相等」、照样往下执行 cpSync，对同一个
  // 真实路径自拷会被 cpSync 拒绝（EINVAL），必须用 resolve() 先归一化再比。
  it('结尾多一个路径分隔符也要认出是同一个目录——裸字符串比较认不出', () => {
    writeFileSync(join(to, 'AGENTS.md'), '原样不动', 'utf8');
    expect(() => ensureAgentFiles({ from: to + sep, to })).not.toThrow();
    expect(readFileSync(join(to, 'AGENTS.md'), 'utf8')).toBe('原样不动');
  });
});
