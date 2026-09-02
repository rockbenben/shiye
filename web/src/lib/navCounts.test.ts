import { describe, it, expect } from 'vitest';
import { folderCount, listCounts, tagCount } from './navCounts.js';
import { emptyFilter } from './smartFilter.js';
import { task } from '../test-utils.js';
import type { List, SmartFilter, Task } from '../types.js';

const NOW = new Date(2026, 7, 24, 10, 0);
const t = (over: Partial<Task>) => task(over);
const list = (id: string, filter: SmartFilter | null = null): List =>
  ({ id, name: id, color: '#000', folderId: null, order: 0, archived: false, filter });

describe('listCounts', () => {
  it('数的是还没了结的——做完的、放弃的不算，搁置的算', () => {
    const tasks = [
      t({ id: 'a', listId: 'L1' }),
      t({ id: 'b', listId: 'L1', status: 'later' }),
      t({ id: 'c', listId: 'L1', status: 'done' }),
      t({ id: 'd', listId: 'L1', status: 'abandoned' }),
    ];
    expect(listCounts(tasks, [list('L1')], NOW).get('L1')).toBe(2);
  });

  it('每份清单各数各的，不属于任何清单的一条都不算进去', () => {
    const tasks = [t({ id: 'a', listId: 'L1' }), t({ id: 'b', listId: 'L2' }), t({ id: 'c', listId: null })];
    const got = listCounts(tasks, [list('L1'), list('L2')], NOW);
    expect([got.get('L1'), got.get('L2')]).toEqual([1, 1]);
  });

  it('空清单是 0，也在表里——画不画 0 是渲染层的事', () => {
    expect(listCounts([], [list('L1')], NOW).get('L1')).toBe(0);
  });

  it('**智能清单先按查询筛，再数其中没了结的**——跟点进去「未完成」那一组看到的是同一批', () => {
    const smart = list('S1', { ...emptyFilter(), tags: ['工作'] });
    const tasks = [
      t({ id: 'a', tags: ['工作'] }),
      t({ id: 'b', tags: ['工作'], status: 'done' }),
      t({ id: 'c', tags: ['别的'] }),
    ];
    expect(listCounts(tasks, [smart], NOW).get('S1')).toBe(1);
  });

  it('一份明确只筛已完成的智能清单是 0——那不是算错，点进去「未完成」那组也确实是空的', () => {
    const smart = list('S1', { ...emptyFilter(), status: ['done'] });
    expect(listCounts([t({ id: 'a', status: 'done' })], [smart], NOW).get('S1')).toBe(0);
  });
});

describe('tagCount', () => {
  it('数的是还没了结的，跟清单同一条口径', () => {
    const tasks = [t({ id: 'a', tags: ['工作'] }), t({ id: 'b', tags: ['工作'], status: 'done' })];
    expect(tagCount(tasks, '工作')).toBe(1);
  });

  it('**父标签连子标签一起算**——点进「工作」看得到 #工作/项目A 的任务，那个数就得跟看到的对得上', () => {
    const tasks = [t({ id: 'a', tags: ['工作'] }), t({ id: 'b', tags: ['工作/项目A'] })];
    expect(tagCount(tasks, '工作')).toBe(2);
    expect(tagCount(tasks, '工作/项目A')).toBe(1);
  });

  it('前缀像但不是子标签的不算——#工作台 不属于 #工作', () => {
    expect(tagCount([t({ id: 'a', tags: ['工作台'] })], '工作')).toBe(0);
  });

  it('tags 缺字段（手改文件）不炸', () => {
    const bad = { ...task({ id: 'x' }), tags: undefined } as unknown as Task;
    expect(tagCount([bad], '工作')).toBe(0);
  });
});

describe('folderCount', () => {
  it('把底下那几份清单的数加起来——标题上那个数得跟底下几行对得上，一条不多一条不少', () => {
    const tasks = [t({ id: 'a', listId: 'L1' }), t({ id: 'b', listId: 'L1' }), t({ id: 'c', listId: 'L2' })];
    const counts = listCounts(tasks, [list('L1'), list('L2')], NOW);
    expect(folderCount(counts, [list('L1'), list('L2')])).toBe(3);
  });

  it('**只算传进来的那几份**——归档的清单不在那个标题下面，也就不该算进那个数', () => {
    const tasks = [t({ id: 'a', listId: 'L1' }), t({ id: 'b', listId: 'L2' })];
    const counts = listCounts(tasks, [list('L1'), list('L2')], NOW);
    expect(folderCount(counts, [list('L1')])).toBe(1);
  });

  it('空文件夹是 0', () => {
    expect(folderCount(new Map(), [])).toBe(0);
  });

  it('表里没有那份清单时当 0，不炸', () => {
    expect(folderCount(new Map(), [list('L1')])).toBe(0);
  });
});
