import { describe, it, expect } from 'vitest';
import { archiveNote } from './archiveNote.js';
import { task } from '../test-utils.js';
import type { List } from '../types.js';

const list = (over: Partial<List> = {}): List =>
  ({ id: 'L1', name: '旧项目', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null, ...over });

describe('archiveNote', () => {
  it('里面还有没了结的任务时说一句：几条、它们留在哪儿、归档到底做了什么', () => {
    const rows = [task({ id: 'a', listId: 'L1' }), task({ id: 'b', listId: 'L1', status: 'doing' })];
    expect(archiveNote(list(), rows)).toBe(
      '已归档「旧项目」。里面 2 条没了结的任务照旧留在「全部」「今天」里——归档只是把这份清单收起来、不再往里放东西。',
    );
  });

  it('**已完成/已放弃的不算**——归档多半正是「这个项目做完了」，把一堆做完的数出来是在制造一个不存在的问题', () => {
    const rows = [task({ id: 'a', listId: 'L1', status: 'done' }), task({ id: 'b', listId: 'L1', status: 'abandoned' })];
    expect(archiveNote(list(), rows)).toBeNull();
  });

  it('搁置的算——口径跟侧栏里那份清单后面挂着的数字（inAllView）完全一致', () => {
    const rows = [task({ id: 'a', listId: 'L1', status: 'later' })];
    expect(archiveNote(list(), rows)).toContain('1 条');
  });

  it('别的清单里的不算', () => {
    const rows = [task({ id: 'a', listId: 'L2' }), task({ id: 'b', listId: null })];
    expect(archiveNote(list(), rows)).toBeNull();
  });

  it('**智能清单不报**——它是一份存下来的查询、不是容器，归档它一条任务都不牵动', () => {
    const smart = list({
      filter: { status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] },
    });
    expect(archiveNote(smart, [task({ id: 'a', listId: 'L1' })])).toBeNull();
  });

  it('空清单不说话——不摆一个说了等于没说的提示', () => {
    expect(archiveNote(list(), [])).toBeNull();
  });
});
