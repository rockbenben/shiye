import { describe, it, expect } from 'vitest';
import { listLabel, fileableLists, groupListsByFolder, movePatches } from './listIcon.js';

describe('listLabel', () => {
  it('开头的 emoji 变成图标，剩下的是名字', () => {
    expect(listLabel('🏠 家里')).toEqual({ icon: '🏠', text: '家里' });
  });

  it('emoji 和名字之间没有空格也认', () => {
    expect(listLabel('💼工作')).toEqual({ icon: '💼', text: '工作' });
  });

  it('国旗是两个 Regional Indicator，要整个吃掉', () => {
    expect(listLabel('🇨🇳 出差')).toEqual({ icon: '🇨🇳', text: '出差' });
  });

  it('ZWJ 序列整串是一个图标——不然会把「👨」当图标、把后半截当名字', () => {
    expect(listLabel('👨‍💻 开发')).toEqual({ icon: '👨‍💻', text: '开发' });
  });

  it('带变体选择符的也认（❤️ 是 ❤ + U+FE0F）', () => {
    expect(listLabel('❤️ 健康')).toEqual({ icon: '❤️', text: '健康' });
  });

  it('带肤色修饰符的也认', () => {
    expect(listLabel('👍🏽 好评')).toEqual({ icon: '👍🏽', text: '好评' });
  });

  it('没有 emoji 就原样返回，icon 是 null', () => {
    expect(listLabel('工作')).toEqual({ icon: null, text: '工作' });
  });

  it('开头是数字不算图标——「1月计划」不能被切成图标「1」+ 名字「月计划」', () => {
    expect(listLabel('1月计划')).toEqual({ icon: null, text: '1月计划' });
  });

  it('emoji 不在开头就不算', () => {
    expect(listLabel('工作 💼')).toEqual({ icon: null, text: '工作 💼' });
  });

  it('整个名字就是一个 emoji 时不拆——拆完导航上会出现一条没有文字的项', () => {
    expect(listLabel('🏠')).toEqual({ icon: null, text: '🏠' });
    expect(listLabel('🏠   ')).toEqual({ icon: null, text: '🏠   ' });
  });

  it('只吃开头那一个，第二个 emoji 留在名字里', () => {
    expect(listLabel('🏠🚗 车库')).toEqual({ icon: '🏠', text: '🚗 车库' });
  });

  it('空名字不炸', () => {
    expect(listLabel('')).toEqual({ icon: null, text: '' });
  });
});

/**
 * 「一条任务能归到哪几个清单」。这份判据以前在 TaskFields / BatchBar /
 * FilterBar 各手抄了一份，三处的注释各自在提醒对方别改歪——收成这一个函数，
 * 卡片 ⋯ 里的「移动到」是第四个调用方。
 */
describe('fileableLists', () => {
  const L = (over: Partial<{ id: string; archived: boolean; filter: unknown; order: number }> = {}) =>
    ({ id: 'l1', name: '工作', archived: false, filter: null, order: 0, ...over });

  it('普通清单进候选', () => {
    expect(fileableLists([L()]).map((l) => l.id)).toEqual(['l1']);
  });

  it('智能清单不进——它是一份存下来的查询，不是容器，指过去那条任务哪儿都找不到', () => {
    expect(fileableLists([L({ id: 's', filter: { text: '' } })])).toEqual([]);
  });

  it('归档了的不进——归档的意思就是别再往里放东西', () => {
    expect(fileableLists([L({ id: 'a', archived: true })])).toEqual([]);
  });

  it('**任务本来就在那个已归档的清单里时，那个清单留着**——否则什么都没动就保存会把它静默挪走', () => {
    expect(fileableLists([L({ id: 'a', archived: true })], 'a').map((l) => l.id)).toEqual(['a']);
  });

  /**
   * **按 `order` 排，不是按传进来的顺序。** 这四个调用方（任务 ⋯ 的「移动到」、
   * 批量操作条、筛选栏按清单、任务详情的清单下拉）拿到的 `lists` 是服务端读目录
   * 的顺序，跟侧栏那份按 `order` 排的对不上——两三份清单时没人看得出来，十几份时
   * 每次「移动到」都得重新扫一遍，因为它不是他自己用上移/下移排出来的那个顺序。
   */
  it('按 order 排，跟侧栏一致——传进来乱序也要排回去', () => {
    const messy = [L({ id: 'c', order: 2 }), L({ id: 'a', order: 0 }), L({ id: 'b', order: 1 })];
    expect(fileableLists(messy).map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('不改调用方那份数组', () => {
    const xs = [L({ id: 'b', order: 1 }), L({ id: 'a', order: 0 })];
    fileableLists(xs);
    expect(xs.map((l) => l.id)).toEqual(['b', 'a']);
  });

  it('keepId 救不了智能清单——它压根不能当容器，跟归不归档是两回事', () => {
    expect(fileableLists([L({ id: 's', filter: {} })], 's')).toEqual([]);
  });
});

/**
 * 清单按文件夹分组（仿滴答清单）。补的是一个整块存在于服务端、界面上一处
 * 都没有的东西：`Folder` 表、`List.folderId`、四条 CRUD 路由都在，侧栏一直平铺。
 */
describe('groupListsByFolder', () => {
  const L = (id: string, order: number, folderId: string | null = null) => ({ id, order, folderId });
  const F = (id: string, name: string, order: number) => ({ id, name, order });

  it('没有文件夹时就一组，全是顶层', () => {
    expect(groupListsByFolder([L('a', 0), L('b', 1)], []))
      .toEqual([{ folder: null, lists: [L('a', 0), L('b', 1)] }]);
  });

  it('**顶层那组排最前**——多数人只把一部分清单收进文件夹，剩下的是天天点的', () => {
    const g = groupListsByFolder([L('in', 0, 'f1'), L('top', 1)], [F('f1', '工作', 0)]);
    expect(g.map((x) => x.folder?.name ?? '顶层')).toEqual(['顶层', '工作']);
  });

  it('文件夹按自己的 order，里面的清单按清单的 order', () => {
    const g = groupListsByFolder(
      [L('b', 1, 'f1'), L('a', 0, 'f1')],
      [F('f2', '乙', 1), F('f1', '甲', 0)],
    );
    expect(g.map((x) => x.folder?.name)).toEqual(['甲', '乙']);
    expect(g[0].lists.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('**空文件夹也出现**——看不见的话「移到文件夹」里会冒出侧栏上根本没有的名字', () => {
    const g = groupListsByFolder([], [F('f1', '空的', 0)]);
    expect(g).toEqual([{ folder: { id: 'f1', name: '空的' }, lists: [] }]);
  });

  it('一份清单都没有、一个文件夹都没有 → 空数组，不出一个空的顶层组', () => {
    expect(groupListsByFolder([], [])).toEqual([]);
  });

  it('**指向不存在的文件夹的清单当顶层**——悬空 id 不该让整份清单从侧栏消失', () => {
    const g = groupListsByFolder([L('a', 0, '已经删了的')], []);
    expect(g).toEqual([{ folder: null, lists: [L('a', 0, '已经删了的')] }]);
  });
});

/**
 * 上移 / 下移（仿滴答清单侧栏能拖着重排）。补的是又一个「建出来就冻住」的
 * 字段：`order` 在建的那一刻定死，之后没有任何入口能改。
 */
describe('movePatches', () => {
  const R = (id: string, order: number) => ({ id, order });

  it('上移：跟前一个换位置，只发变了的那两条', () => {
    expect(movePatches([R('a', 0), R('b', 1), R('c', 2)], 'b', -1))
      .toEqual([{ id: 'b', order: 0 }, { id: 'a', order: 1 }]);
  });

  it('下移：跟后一个换位置', () => {
    expect(movePatches([R('a', 0), R('b', 1), R('c', 2)], 'a', 1))
      .toEqual([{ id: 'b', order: 0 }, { id: 'a', order: 1 }]);
  });

  it('已经在头/尾就什么都不发——调用方据此把按钮禁掉', () => {
    const rows = [R('a', 0), R('b', 1)];
    expect(movePatches(rows, 'a', -1)).toEqual([]);
    expect(movePatches(rows, 'b', 1)).toEqual([]);
  });

  it('不在这一段里的 id 什么都不发', () => {
    expect(movePatches([R('a', 0)], '别处的', -1)).toEqual([]);
  });

  it('**order 本来就错乱（重复/空洞）时整段捋直**——只换两个值会把错乱留在原地', () => {
    // 三条都是 0：排序后按原顺序，把 c 上移应该得到 a / c / b 并重编 0,1,2
    expect(movePatches([R('a', 0), R('b', 0), R('c', 0)], 'c', -1))
      .toEqual([{ id: 'c', order: 1 }, { id: 'b', order: 2 }]);
  });

  it('按 order 排，不按数组顺序——传进来的次序不该影响结果', () => {
    expect(movePatches([R('c', 2), R('a', 0), R('b', 1)], 'c', -1))
      .toEqual([{ id: 'c', order: 1 }, { id: 'b', order: 2 }]);
  });

  it('只有一条时上下都不动', () => {
    expect(movePatches([R('a', 0)], 'a', -1)).toEqual([]);
    expect(movePatches([R('a', 0)], 'a', 1)).toEqual([]);
  });
});
