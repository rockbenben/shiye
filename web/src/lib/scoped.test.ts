import { describe, expect, it } from 'vitest';
import { scopedSections } from './scoped.js';
import { emptyFilter } from './smartFilter.js';
import { task } from '../test-utils.js';
import type { List, Task } from '../types.js';

const NOW = new Date('2026-08-14T12:00:00.000Z');

const t = (id: string, over: Partial<Task> = {}): Task => task({ id, title: id, ...over });

const list = (over: Partial<List> = {}): List =>
  ({ id: 'L1', name: 'L1', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null, ...over });

describe('scopedSections', () => {
  it('不是 list:/tag: 开头的一律 null——由注册表负责', () => {
    expect(scopedSections([], 'today', NOW, new Set(), [])).toBeNull();
    expect(scopedSections([], 'listx', NOW, new Set(), [])).toBeNull();
  });

  it('list: 只装这个清单的任务', () => {
    const tasks = [t('a', { listId: 'L1' }), t('b', { listId: 'L2' }), t('c')];
    const s = scopedSections(tasks, 'list:L1', NOW, new Set(), [])!;
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('tag: 只装带这个标签的任务', () => {
    const tasks = [t('a', { tags: ['家里', '买'] }), t('b', { tags: ['公司'] })];
    const s = scopedSections(tasks, 'tag:家里', NOW, new Set(), [])!;
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('标签名里有冒号也认得出来——只切第一个冒号', () => {
    const tasks = [t('a', { tags: ['项目:035'] })];
    const s = scopedSections(tasks, 'tag:项目:035', NOW, new Set(), [])!;
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('分成「未完成」「已完成」「已放弃」三组，未完成在前', () => {
    const tasks = [t('a', { listId: 'L1' }), t('b', { listId: 'L1', status: 'done' })];
    const s = scopedSections(tasks, 'list:L1', NOW, new Set(), [])!;
    expect(s.map((x) => x.key)).toEqual(['open', 'closed', 'dropped']);
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
    expect(s[1].tasks.map((x) => x.id)).toEqual(['b']);
    // 空组 TaskGrid 整个不渲染，所以这份清单在屏幕上还是两组。
    expect(s[2].tasks).toEqual([]);
  });

  it('**放弃的落「已放弃」，不落「未完成」**——那一组的名字在这时候是句假话：那条不是没做完，是明确决定不做了', () => {
    const tasks = [t('a', { listId: 'L1' }), t('x', { listId: 'L1', status: 'abandoned' })];
    const s = scopedSections(tasks, 'list:L1', NOW, new Set(), [])!;
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
    expect(s[2].tasks.map((x) => x.id)).toEqual(['x']);
  });

  it('搁置的照旧算「未完成」——它还会回来，跟放弃不是一回事', () => {
    const tasks = [t('a', { listId: 'L1', status: 'later' })];
    const s = scopedSections(tasks, 'list:L1', NOW, new Set(), [])!;
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('每一条都落得进某一组——正在编辑、状态刚被点变的那条也是（TaskGrid 的契约）', () => {
    const tasks = (['todo', 'doing', 'done', 'later', 'abandoned'] as const)
      .map((status, i) => t(`s${i}`, { listId: 'L1', status }));
    const s = scopedSections(tasks, 'list:L1', NOW, new Set(['s0']), [])!;
    expect(s.reduce((n, x) => n + x.tasks.length, 0)).toBe(tasks.length);
  });

  it('未完成那组按紧急度排', () => {
    // 'z' 更紧急（due 更早）——期望顺序 ['z','a'] 跟 id 字典序（'a','z'）相反，
    // 改成按 id 排、或者干脆不排，这条都会红，不会跟「巧合按 id 排」的残次
    // 实现混过去。见 simpleViews.test.ts 同名断言的同一条注释。
    const tasks = [
      t('a', { listId: 'L1', due: '2026-08-20T00:00:00.000Z' }),
      t('z', { listId: 'L1', due: '2026-08-15T00:00:00.000Z' }),
    ];
    const s = scopedSections(tasks, 'list:L1', NOW, new Set(), [])!;
    expect(s[0].tasks.map((x) => x.id)).toEqual(['z', 'a']);
  });

  it('keep 里的 id 就算不匹配谓词也留着——正在编辑时改了清单，卡不能连草稿一起消失', () => {
    const tasks = [t('a', { listId: 'L1' }), t('b', { listId: 'L2' })];
    const s = scopedSections(tasks, 'list:L1', NOW, new Set(['b']), [])!;
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('keep 住的任务只能落进一个组——not-done 的不能因为在 keep 里就也混进 closed，done 的也不能混进 open', () => {
    const tasks = [
      t('a', { listId: 'L1', status: 'todo' }),
      // 'b' 不属于 L1，全靠 keep 才留下；它是 done，只该出现在 closed 里，
      // 不该因为「在 keep 里」这个理由又被塞进 open——同一个 id 出现在两个
      // 组会撞 React 的 key（见 TaskGrid.tsx 的文档注释）。
      t('b', { listId: 'L2', status: 'done' }),
    ];
    const s = scopedSections(tasks, 'list:L1', NOW, new Set(['a', 'b']), [])!;
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
    expect(s[1].tasks.map((x) => x.id)).toEqual(['b']);
  });

  describe('智能清单：filter 非 null 时按 applyFilter 取，不看 listId（task-3-brief 要点②）', () => {
    it('filter 为 null（普通清单）：还是按 listId === 取——旧路径没被分叉带偏', () => {
      const lists = [list({ id: 'L1', filter: null })];
      const tasks = [t('a', { listId: 'L1', status: 'doing' }), t('b', { listId: 'L2', status: 'doing' })];
      const s = scopedSections(tasks, 'list:L1', NOW, new Set(), lists)!;
      // 'a' 的 listId 对，纳入；'b' 的 listId 不对，就算它的 status 恰好满足
      // 下面那条智能清单同款 filter 也不该被拉进来——这条走的不是 applyFilter。
      expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
    });

    it('filter 非 null（智能清单）：按 applyFilter 取，listId 对不上也照样进——查询不是容器', () => {
      const lists = [list({ id: 'L1', filter: { ...emptyFilter(), status: ['doing'] } })];
      const tasks = [
        // 'a' listId 是 L1 但 status 是 todo，不满足 filter——不该出现。
        t('a', { listId: 'L1', status: 'todo' }),
        // 'b' listId 是 L2（跟这份「清单」毫无关系），但 status 满足
        // filter——智能清单是存下来的查询，该被 applyFilter 捞进来。
        t('b', { listId: 'L2', status: 'doing' }),
      ];
      const s = scopedSections(tasks, 'list:L1', NOW, new Set(), lists)!;
      expect(s[0].tasks.map((x) => x.id)).toEqual(['b']);
    });

    it('这个 id 在 lists 里找不到（清单被删了/还没拉到）：退回 listId === 那条老路，不炸', () => {
      const tasks = [t('a', { listId: 'L1' })];
      const s = scopedSections(tasks, 'list:L1', NOW, new Set(), [])!;
      expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
    });
  });
});

/**
 * 二级标签（仿滴答清单）：点父标签连子标签的任务一起看。
 */
describe('scopedSections：父标签连子标签一起算', () => {
  it('点「工作」看得到 #工作/项目A 的任务——不然层级只是侧栏上好看一点', () => {
    const tasks = [
      t('a', { tags: ['工作'] }),
      t('b', { tags: ['工作/项目A'] }),
      t('c', { tags: ['生活'] }),
    ];
    const s = scopedSections(tasks, 'tag:工作', NOW, new Set(), [])!;
    expect(s[0].tasks.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });

  it('点子标签只看它自己那些', () => {
    const tasks = [t('a', { tags: ['工作'] }), t('b', { tags: ['工作/项目A'] })];
    const s = scopedSections(tasks, 'tag:工作/项目A', NOW, new Set(), [])!;
    expect(s[0].tasks.map((x) => x.id)).toEqual(['b']);
  });

  it('前缀比较带分隔符——#工作台 不算 #工作 的子标签', () => {
    const s = scopedSections([t('a', { tags: ['工作台'] })], 'tag:工作', NOW, new Set(), [])!;
    expect(s[0].tasks).toEqual([]);
  });
});
