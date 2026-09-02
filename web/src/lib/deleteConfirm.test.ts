import { describe, it, expect } from 'vitest';
import { deleteOneConfirm, deleteManyConfirm } from './deleteConfirm.js';
import { task } from '../test-utils.js';

const TRASH_ONE = '会先进垃圾箱，想反悔可以在那里还原；只是暂时不想看见的话，用「搁置」更轻。';

describe('deleteOneConfirm', () => {
  it('标题带上是哪一条——菜单是从某张卡上点开的，问「删除这条？」答不出「哪条」', () => {
    expect(deleteOneConfirm(task({ id: 'a', title: '交房租' }), []).title).toBe('删掉「交房租」？');
  });

  it('没有子任务时就是原来那句，一个字不多', () => {
    const t = task({ id: 'a' });
    expect(deleteOneConfirm(t, [t]).content).toBe(TRASH_ONE);
  });

  /**
   * 服务端删父任务时子任务**跟着一起进垃圾箱**（`softDeleteTasks`，仿滴答清单）。
   * 一次点击带走的不止一条，就必须在按下去之前说清带走几条——这个文件存在的
   * 全部理由。
   */
  it('**有子任务时把「它们会跟着一起删」说出来**，连同「还原时一起回来」', () => {
    const p = task({ id: 'p', title: '装修' });
    const rows = [p, task({ id: 'a', parentId: 'p' }), task({ id: 'b', parentId: 'p' })];
    expect(deleteOneConfirm(p, rows).content)
      .toBe(`它的 2 条子任务会跟着一起进垃圾箱，还原时一起回来。${TRASH_ONE}`);
  });

  it('意外的那句排在前面——跟删清单那个确认框同一个顺序：先说这一下会牵动什么，再说有没有退路', () => {
    const p = task({ id: 'p' });
    const content = deleteOneConfirm(p, [p, task({ id: 'a', parentId: 'p' })]).content;
    expect(content.indexOf('子任务')).toBeLessThan(content.indexOf('垃圾箱'));
  });
});

describe('deleteManyConfirm', () => {
  it('标题报条数', () => {
    expect(deleteManyConfirm(['a', 'b'], []).title).toBe('删除选中的 2 条？');
  });

  it('「搁置」那半句换成批量的说法——批量操作条本来就有「改状态」这个入口', () => {
    expect(deleteManyConfirm(['a'], []).content).toContain('批量改成「搁置」更轻');
  });

  it('**父子都选中时不算孤儿**——孩子本来就跟着一起进垃圾箱，算进去是虚报一个不存在的后果', () => {
    const rows = [task({ id: 'p' }), task({ id: 'a', parentId: 'p' })];
    expect(deleteManyConfirm(['p', 'a'], rows).content).not.toContain('子任务');
  });

  it('只选中父亲：那一条孩子会跟着删，说出来', () => {
    const rows = [task({ id: 'p' }), task({ id: 'a', parentId: 'p' })];
    expect(deleteManyConfirm(['p'], rows).content).toContain('它们底下还有 1 条子任务会跟着一起进垃圾箱');
  });

  it('只选中孩子：没有别的会被带走', () => {
    const rows = [task({ id: 'p' }), task({ id: 'a', parentId: 'p' })];
    expect(deleteManyConfirm(['a'], rows).content).not.toContain('子任务');
  });
});

/**
 * **删除确认数的是整棵子树**（放开到五层之后）。只数一层的后果很具体：
 * 确认框说「3 条」，实际进垃圾箱的是十四条——而这句话存在的全部意义就是
 * 「这一下会牵动什么」。
 */
describe('deleteConfirm：整棵子树', () => {
  const tree = [
    task({ id: 'p', title: '装修' }),
    task({ id: 'k', parentId: 'p' }),
    task({ id: 'g', parentId: 'k' }),
    task({ id: 'g2', parentId: 'k' }),
    task({ id: 'z' }),
  ];

  it('单条：数的是子树全部 3 条，不是直接子任务那 1 条', () => {
    expect(deleteOneConfirm(tree[0]!, tree).content).toContain('3 条子任务');
  });

  /**
   * **超过一层就把层数说出来。**「3 条」和「3 条（最深 3 层）」在屏幕上一样长，
   * 而后者意味着他正在删掉一整棵结构。
   */
  it('超过一层：把层数也说出来', () => {
    expect(deleteOneConfirm(tree[0]!, tree).content).toContain('最深 3 层');
  });

  it('只有一层：不说层数——每次都挂一句是噪音', () => {
    const flat = [task({ id: 'p', title: '装修' }), task({ id: 'k', parentId: 'p' })];
    const out = deleteOneConfirm(flat[0]!, flat).content;
    expect(out).toContain('1 条子任务');
    expect(out).not.toContain('最深');
  });

  it('没有子任务：那半句整个不出现', () => {
    expect(deleteOneConfirm(tree[4]!, tree).content).not.toContain('子任务');
  });

  /**
   * 批量那边**仍然只数「没被选中的」**：父子都在选中集合里时那个孩子已经算在
   * 「选中的 N 条」里了，再数一遍就是把同一条报两次。这一条跟改成整棵子树
   * 之前一字不差。
   */
  it('批量：孙辈也算，但已经选中的不重复数', () => {
    expect(deleteManyConfirm(['p'], tree).content).toContain('3 条子任务');
    expect(deleteManyConfirm(['p', 'k'], tree).content).toContain('2 条子任务');
  });
});
