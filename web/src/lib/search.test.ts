import { describe, expect, it } from 'vitest';
import { searchLists, searchTags, searchTasks } from './search.js';
import { task } from '../test-utils.js';
import type { List, Task } from '../types.js';

const t = (id: string, over: Partial<Task> = {}): Task => task({ id, title: id, ...over });

describe('searchTasks', () => {
  /**
   * **搜索空结果那句文案把「搜哪几样」写死了**（`App.tsx`：「标题、备注、标签、
   * 子任务都会搜」）。那是一句对用户的承诺——他据此判断「换个词」有没有用，
   * 也据此知道搜不到某条任务是因为词不对、还是因为那个字段根本不在范围里。
   *
   * 加一个字段进 `searchTasks` 而文案没跟上，界面就在少报能力；反过来删一个，
   * 界面就在承诺做不到的事。两种都不报错、不红。所以这四样各钉一条。
   */
  it('搜的是标题、备注、标签、子任务这四样——跟空结果那句文案一致', () => {
    const 标题 = t('a', { title: '找这个词' });
    const 备注 = t('b', { notes: '备注里也有找这个词' });
    const 标签 = t('c', { tags: ['找这个词'] });
    const 子任务 = t('d', { subtasks: [{ text: '子任务里的找这个词', done: false }] });
    const 无关 = t('e', { title: '别的' });
    const hit = searchTasks([标题, 备注, 标签, 子任务, 无关], '找这个词').map((x) => x.id);
    expect(hit.sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('空查询返回空——「全部」有自己的去处，搜索框空着不冒充它', () => {
    expect(searchTasks([t('a')], '')).toEqual([]);
    expect(searchTasks([t('a')], '   ')).toEqual([]);
  });

  it('匹配标题', () => {
    expect(searchTasks([t('a', { title: '写周报' }), t('b')], '周报').map((x) => x.id)).toEqual(['a']);
  });

  it('匹配备注', () => {
    expect(searchTasks([t('a', { notes: '找老王要数据' })], '老王').map((x) => x.id)).toEqual(['a']);
  });

  it('匹配子任务文本', () => {
    const a = t('a', { subtasks: [{ text: '打印合同', done: false }] });
    expect(searchTasks([a], '合同').map((x) => x.id)).toEqual(['a']);
  });

  it('匹配标签', () => {
    expect(searchTasks([t('a', { tags: ['家里'] })], '家里').map((x) => x.id)).toEqual(['a']);
  });

  it('英文大小写不敏感', () => {
    expect(searchTasks([t('a', { title: 'Deploy WebDAV' })], 'webdav').map((x) => x.id)).toEqual(['a']);
    // 反过来也要钉住：上面那条的 needle 本来就是全小写，对 needle 侧
    // 做不做 toLowerCase 没有区别——单删 needle 侧那一处，上面那条照样绿。
    // 这里换成大写的 needle，才钉得住 needle 侧的 toLowerCase。
    expect(searchTasks([t('a', { title: 'deploy webdav' })], 'WebDAV').map((x) => x.id)).toEqual(['a']);
  });

  it('一条只出现一次——标题和备注都命中也不重复', () => {
    const a = t('a', { title: '周报', notes: '周报要发给老板' });
    expect(searchTasks([a], '周报')).toHaveLength(1);
  });

  it('不匹配 aiComment——那是 AI 的旁注，不是任务内容', () => {
    const a = t('a', { title: '写周报', aiComment: '按每周五推断的截止时间' });
    // 正向断言先行，同一条 fixture 上验证：标题里的词搜得到。没有这一句，
    // 下面那条纯否定断言对一个整个返回 [] 的坏实现（searchTasks 恒等于
    // 空函数）也会通过——「不匹配」和「什么都不匹配」看起来一样绿。
    expect(searchTasks([a], '周报').map((x) => x.id)).toEqual(['a']);
    // 反向：aiComment 里的词搜不到。
    expect(searchTasks([a], '推断')).toEqual([]);
  });
});

/**
 * 搜清单、搜标签（仿滴答清单搜索页的三个类型）。
 */
describe('searchLists', () => {
  const lists: List[] = [
    { id: 'L1', name: '工作', color: '#000', folderId: null, order: 0, archived: false, filter: null },
    { id: 'L2', name: '工作台账', color: '#000', folderId: null, order: 1, archived: false, filter: null },
    { id: 'L3', name: '归档的工作', color: '#000', folderId: null, order: 2, archived: true, filter: null },
    {
      id: 'L4', name: '工作智能清单', color: '#000', folderId: null, order: 3, archived: false,
      filter: { status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] },
    },
  ];

  it('按名字子串匹配', () => {
    expect(searchLists(lists, '台账').map((l) => l.id)).toEqual(['L2']);
  });

  it('归档的不出现——它们在侧栏里也不出现，搜出来点进去是个找不到回头路的去处', () => {
    expect(searchLists(lists, '工作').map((l) => l.id)).toEqual(['L1', 'L2', 'L4']);
  });

  it('智能清单出现：它照样是个能点进去的去处', () => {
    expect(searchLists(lists, '智能').map((l) => l.id)).toEqual(['L4']);
  });

  it('大小写不敏感', () => {
    const en: List[] = [{ id: 'X', name: 'Work', color: '#000', folderId: null, order: 0, archived: false, filter: null }];
    expect(searchLists(en, 'wor')).toHaveLength(1);
  });

  it('空查询返回空数组，不是返回全部——跟 searchTasks 同一条约定', () => {
    expect(searchLists(lists, '')).toEqual([]);
    expect(searchLists(lists, '   ')).toEqual([]);
  });
});

describe('searchTags', () => {
  const tags = ['工作', '工作台', '生活'];

  it('按子串匹配', () => {
    expect(searchTags(tags, '工作')).toEqual(['工作', '工作台']);
  });

  it('空查询返回空数组', () => {
    expect(searchTags(tags, '  ')).toEqual([]);
  });
});
