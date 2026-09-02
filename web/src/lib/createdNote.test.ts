import { describe, it, expect } from 'vitest';
import { createdNote } from './createdNote.js';
import { task } from '../test-utils.js';

const NOW = new Date(2026, 7, 24, 12);
const todayEnd = new Date(2026, 7, 24, 23, 59).toISOString();
const fresh = (over = {}) => task({ id: 'n1', title: '新的', status: 'todo', ...over });

describe('createdNote', () => {
  it('「今天」里建了一条今天到期的：看得见，不说话', () => {
    expect(createdNote('today', fresh({ due: todayEnd }), NOW, 'all')).toBeNull();
  });

  it('「今天」里建了一条没时间的：会落进「按来源」，必须说', () => {
    expect(createdNote('today', fresh(), NOW, 'all'))
      .toBe('已添加。没填今天的时间，这条在「按来源」里');
  });

  it('「按来源」筛选停在别的档上：新卡一张都不会出现，说清是筛选挡住了', () => {
    expect(createdNote('source', fresh(), NOW, 'done'))
      .toBe('已添加。当前筛选是「已完成」，这条是待办，清除筛选才看得到');
  });

  it('「按来源」没筛选：不说话', () => {
    expect(createdNote('source', fresh(), NOW, 'all')).toBeNull();
    // 筛选就停在「待办」上，而新任务正是待办——它看得见。
    expect(createdNote('source', fresh(), NOW, 'todo')).toBeNull();
  });

  it('在某个清单里建、也真的归进了那个清单：不说话', () => {
    expect(createdNote('list:L1', fresh({ listId: 'L1' }), NOW, 'all')).toBeNull();
  });

  it('在某个清单里建、却归进了别处：说', () => {
    expect(createdNote('list:L1', fresh({ listId: 'L2' }), NOW, 'all'))
      .toBe('已添加。这条在「按来源」里');
  });

  it('标签那个去处同理', () => {
    expect(createdNote('tag:工作', fresh({ tags: ['工作'] }), NOW, 'all')).toBeNull();
    expect(createdNote('tag:工作', fresh({ tags: [] }), NOW, 'all')).toBe('已添加。这条在「按来源」里');
  });

  it('**「全部」里建的不说话**——它不挑时间不挑清单，新卡当场就列在眼前', () => {
    expect(createdNote('all', fresh(), NOW, 'all')).toBeNull();
  });

  it('收件箱这种不展示任务卡的去处：说', () => {
    expect(createdNote('inbox', fresh(), NOW, 'all')).toBe('已添加。这条在「按来源」里');
  });

  it('tags 是坏数据（不是数组）时不炸——data/tasks/ 是手改得到的文件', () => {
    expect(createdNote('tag:工作', fresh({ tags: null as never }), NOW, 'all'))
      .toBe('已添加。这条在「按来源」里');
  });
});
