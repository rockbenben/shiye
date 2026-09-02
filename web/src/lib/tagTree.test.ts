import { describe, it, expect } from 'vitest';
import { splitTag, tagTree, taggedWith, renameTagPatches, deleteTagPatches } from './tagTree.js';

describe('splitTag', () => {
  it('没有斜杠就没有层级', () => {
    expect(splitTag('工作')).toEqual(['工作', null]);
  });

  it('一个斜杠：父 + 子', () => {
    expect(splitTag('工作/项目A')).toEqual(['工作', '项目A']);
  });

  it('只做两级——第一个斜杠之后整段都是子标签的名字', () => {
    expect(splitTag('工作/项目A/一期')).toEqual(['工作', '项目A/一期']);
  });

  it('开头或结尾是斜杠：当没有层级，不产出空名字的节点', () => {
    expect(splitTag('/工作')).toEqual(['/工作', null]);
    expect(splitTag('工作/')).toEqual(['工作/', null]);
  });
});

describe('tagTree', () => {
  it('扁平的标签原样成为顶层', () => {
    expect(tagTree(['生活', '工作']).map((n) => n.name)).toEqual(['工作', '生活']);
  });

  it('带斜杠的挂到父下面，label 只显示斜杠后面那段——不重复父标签的名字', () => {
    const tree = tagTree(['工作', '工作/项目A']);
    expect(tree.map((n) => n.name)).toEqual(['工作']);
    expect(tree[0].children.map((c) => ({ name: c.name, label: c.label })))
      .toEqual([{ name: '工作/项目A', label: '项目A' }]);
  });

  it('父标签自己没有任务时也建出来，标成 real: false——它只是被子标签推导出来的分组', () => {
    const tree = tagTree(['工作/项目A']);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: '工作', real: false });
    expect(tree[0].children.map((c) => c.name)).toEqual(['工作/项目A']);
  });

  it('先出现子标签、后出现父标签本身：real 补成 true，不重复建一个节点', () => {
    const tree = tagTree(['工作/项目A', '工作']);
    expect(tree).toHaveLength(1);
    expect(tree[0].real).toBe(true);
  });

  it('同一个父下面多个子标签，各自按名字排', () => {
    const tree = tagTree(['工作/乙', '工作/甲']);
    expect(tree[0].children.map((c) => c.label)).toEqual(['甲', '乙']);
  });

  it('空数组不炸', () => {
    expect(tagTree([])).toEqual([]);
  });
});

describe('taggedWith', () => {
  it('自己那个标签算', () => {
    expect(taggedWith(['工作'], '工作')).toBe(true);
  });

  it('**父标签连子标签一起算**——不然层级只是侧栏上好看一点，点进去还是空的', () => {
    expect(taggedWith(['工作/项目A'], '工作')).toBe(true);
  });

  it('点子标签只看它自己那些，不把兄弟标签的任务捞进来', () => {
    expect(taggedWith(['工作/项目B'], '工作/项目A')).toBe(false);
  });

  it('前缀比较带上分隔符——`#工作台` 不是 `#工作` 的子标签', () => {
    expect(taggedWith(['工作台'], '工作')).toBe(false);
  });

  it('一条任务的多个标签里命中任意一个就算', () => {
    expect(taggedWith(['生活', '工作/项目A'], '工作')).toBe(true);
  });

  it('没有标签的任务不算', () => {
    expect(taggedWith([], '工作')).toBe(false);
  });
});

/**
 * 标签重命名 / 删除（仿滴答清单的标签管理）。补的是一个只能一条条改的坑：
 * 标签就是任务上的字符串，打错一个字之前只能把每条任务都打开改一遍。
 */
describe('renameTagPatches', () => {
  const T = (id: string, ...tags: string[]) => ({ id, tags });

  it('改名，只碰带着它的那几条', () => {
    expect(renameTagPatches([T('a', '工作'), T('b', '生活')], '工作', '事务'))
      .toEqual([{ id: 'a', patch: { tags: ['事务'] } }]);
  });

  it('**子标签一起改**——不然层级当场断成两棵树', () => {
    expect(renameTagPatches([T('a', '工作/紧急')], '工作', '事务'))
      .toEqual([{ id: 'a', patch: { tags: ['事务/紧急'] } }]);
  });

  it('#工作台 不受牵连——前缀比较带分隔符，跟 taggedWith 同一条规则', () => {
    expect(renameTagPatches([T('a', '工作台')], '工作', '事务')).toEqual([]);
  });

  it('改成一个它本来就有的名字时去重，不留两个一模一样的标签', () => {
    expect(renameTagPatches([T('a', '工作', '事务')], '工作', '事务'))
      .toEqual([{ id: 'a', patch: { tags: ['事务'] } }]);
  });

  it('别的标签原样留着、顺序不动', () => {
    expect(renameTagPatches([T('a', '甲', '工作', '乙')], '工作', '事务')[0].patch.tags)
      .toEqual(['甲', '事务', '乙']);
  });

  it('空名字 / 只有空白 / 跟原名一样，一条都不发', () => {
    const rows = [T('a', '工作')];
    expect(renameTagPatches(rows, '工作', '')).toEqual([]);
    expect(renameTagPatches(rows, '工作', '   ')).toEqual([]);
    expect(renameTagPatches(rows, '工作', '工作')).toEqual([]);
  });

  it('新名字去掉首尾空白', () => {
    expect(renameTagPatches([T('a', '工作')], '工作', ' 事务 ')[0].patch.tags).toEqual(['事务']);
  });

  it('改成一个更深的名字也行——把一个标签挪到别人下面', () => {
    expect(renameTagPatches([T('a', '紧急'), T('b', '紧急/客户')], '紧急', '工作/紧急'))
      .toEqual([
        { id: 'a', patch: { tags: ['工作/紧急'] } },
        { id: 'b', patch: { tags: ['工作/紧急/客户'] } },
      ]);
  });
});

describe('deleteTagPatches', () => {
  const T = (id: string, ...tags: string[]) => ({ id, tags });

  it('**只把标签摘掉，不动任务**——一个标签是一种叫法，不是一个容器', () => {
    expect(deleteTagPatches([T('a', '工作', '甲')], '工作'))
      .toEqual([{ id: 'a', patch: { tags: ['甲'] } }]);
  });

  it('子标签一起摘', () => {
    expect(deleteTagPatches([T('a', '工作/紧急')], '工作'))
      .toEqual([{ id: 'a', patch: { tags: [] } }]);
  });

  it('#工作台 不受牵连', () => {
    expect(deleteTagPatches([T('a', '工作台')], '工作')).toEqual([]);
  });

  it('没有任何任务带着它就一条都不发', () => {
    expect(deleteTagPatches([T('a', '生活')], '工作')).toEqual([]);
  });
});
