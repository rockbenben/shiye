import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAllConflicts } from './conflicts.js';
import { paths } from './store.js';
import { invalidate } from './entityStore.js';

// 包一层 readdirSync，只为数「真的读了几次盘」——listAllConflicts 对 `paths()`
// 里每个目录各调一次 entityStore.listConflicts，缓存要挂在全部目录上，不能只挂一个。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});
const readdirMock = vi.mocked(readdirSync);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'todo-conflicts-'));
  process.env.DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const put = (kind: string, file: string) => {
  const d = join(dir, kind);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), '{}', 'utf8');
};

describe('listAllConflicts', () => {
  it('一个冲突副本都没有时返回空数组', () => {
    put('tasks', 'aaa.json');
    expect(listAllConflicts()).toEqual([]);
  });

  it('认出坚果云/Nextcloud 那种「(冲突副本 …)」', () => {
    put('tasks', 'aaa.json');
    put('tasks', 'aaa (冲突副本 2026-08-15).json');
    expect(listAllConflicts()).toEqual([{ kind: 'tasks', file: 'aaa (冲突副本 2026-08-15).json' }]);
  });

  it('同一个目录里不止一份冲突副本，两份都要报——变异 slice(0, 1) 只报第一份会漏掉第二份', () => {
    put('tasks', 'aaa.json');
    put('tasks', 'aaa (冲突副本 2026-08-15).json');
    put('tasks', 'bbb (冲突副本 2026-08-15).json');
    expect(listAllConflicts().map((c) => c.file).sort()).toEqual([
      'aaa (冲突副本 2026-08-15).json',
      'bbb (冲突副本 2026-08-15).json',
    ]);
  });

  it('认出 Syncthing 那种 .sync-conflict-…', () => {
    put('inbox', 'bbb.sync-conflict-20260815-120000-ABCDEFG.json');
    expect(listAllConflicts()).toEqual([
      { kind: 'inbox', file: 'bbb.sync-conflict-20260815-120000-ABCDEFG.json' },
    ]);
  });

  // 「上限方向」：只扫 tasks 的实现也能过上面那两条
  it('paths() 里的目录全扫，不是只扫 tasks——再加一种实体时不该悄悄漏掉', () => {
    for (const kind of Object.keys(paths())) put(kind, `x (冲突副本 1).json`);
    expect(listAllConflicts().map((c) => c.kind).sort()).toEqual(Object.keys(paths()).sort());
  });

  it('目录不存在就当没有，不抛——新 clone 下来 data/ 是空的', () => {
    expect(() => listAllConflicts()).not.toThrow();
    expect(listAllConflicts()).toEqual([]);
  });

  it('正常文件一个都不报', () => {
    put('tasks', 'aaa.json');
    put('tasks', 'bbb.json');
    put('lists', 'ccc.json');
    expect(listAllConflicts()).toEqual([]);
  });

  it('缓存挂在全部目录上，不是只挂了一个——命中缓存时再 reload 不会有任何一个目录重新 readdirSync', () => {
    for (const kind of Object.keys(paths())) put(kind, 'aaa.json');
    listAllConflicts(); // 焐热每个目录各自的缓存
    readdirMock.mockClear();
    listAllConflicts();
    listAllConflicts();
    // 只挂了其中一个目录的话，其余每个目录每次 reload 都会各贡献一次 readdirSync，
    // 这里就不会是 0。
    expect(readdirMock).not.toHaveBeenCalled();
  });

  it('invalidate 单个目录之后，只有那一个目录重新读盘，其余六个仍然命中缓存', () => {
    for (const kind of Object.keys(paths())) put(kind, 'aaa.json');
    listAllConflicts();
    invalidate(paths().tasks);
    readdirMock.mockClear();
    listAllConflicts();
    expect(readdirMock).toHaveBeenCalledTimes(1);
    expect(readdirMock).toHaveBeenCalledWith(paths().tasks);
  });
});
