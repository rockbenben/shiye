import { describe, it, expect } from 'vitest';
import { sanitizeListPatch, sanitizeFolderPatch, checkListPatch, checkFolderPatch, INK_AI } from './list.js';
import type { SanitizeFail, SanitizeOk } from './task.js';
import type { ListPatch, FolderPatch } from './list.js';

describe('清单白名单', () => {
  it('已知字段都能改', () => {
    expect(sanitizeListPatch({ name: '工作' })?.name).toBe('工作');
    expect(sanitizeListPatch({ color: '#8B5E34' })?.color).toBe('#8B5E34');
    expect(sanitizeListPatch({ folderId: 'f1' })?.folderId).toBe('f1');
    expect(sanitizeListPatch({ folderId: null })?.folderId).toBeNull();
    expect(sanitizeListPatch({ order: 3 })?.order).toBe(3);
    expect(sanitizeListPatch({ archived: true })?.archived).toBe(true);
  });

  it('白名单外的字段整条拒收，不是悄悄过滤——PATCH 原来是裸展开，这里补的就是这道信任边界', () => {
    expect(sanitizeListPatch({ name: '工作', 别的字段: 1 })).toBeNull();
    // id 不在白名单里：不是「传了不采纳」，是整条请求直接拒收。
    expect(sanitizeListPatch({ id: '篡改' })).toBeNull();
  });

  it('名字为空或纯空白拒收', () => {
    expect(sanitizeListPatch({ name: '' })).toBeNull();
    expect(sanitizeListPatch({ name: '   ' })).toBeNull();
  });

  it('颜色必须是 #RRGGBB', () => {
    expect(sanitizeListPatch({ color: '#000' })).toBeNull();
    expect(sanitizeListPatch({ color: 'red' })).toBeNull();
    expect(sanitizeListPatch({ color: 123 })).toBeNull();
  });

  it('群青不能当清单色，大小写都挡', () => {
    expect(sanitizeListPatch({ color: INK_AI })).toBeNull();
    expect(sanitizeListPatch({ color: '#2e3ed4' })).toBeNull();
  });

  it('folderId 只收字符串或 null', () => {
    expect(sanitizeListPatch({ folderId: 1 })).toBeNull();
  });

  it('order 必须是有限数字', () => {
    expect(sanitizeListPatch({ order: '第一' })).toBeNull();
    expect(sanitizeListPatch({ order: Number.NaN })).toBeNull();
  });

  it('archived 必须是布尔值', () => {
    expect(sanitizeListPatch({ archived: 'true' })).toBeNull();
  });

  it('filter 为 null 合法，表示「这不是智能清单」', () => {
    expect(sanitizeListPatch({ filter: null })?.filter).toBeNull();
  });

  it('filter 形状对就收——嵌套结构，七个必填字段都要齐', () => {
    const filter = { status: ['todo'], listIds: [], tags: ['紧急'], priority: [1, 2], contexts: ['computer'], dueWithinDays: 3, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] };
    expect(sanitizeListPatch({ filter })?.filter).toEqual(filter);
  });

  it('**noList / noTag / noDue 缺了不算错，落 false**——它们是后加的，加之前存下来的智能清单里没有这几个键，拒收会让一批本来好好的清单突然打不开（跟 tagsAll 同一条）', () => {
    const legacy = { status: [], listIds: ['L1'], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, or: [] };
    // `contexts` 跟它们同一批（情境是后加的一维），缺了落空数组。
    // isRepeating / notStarted / estimateWithinMinutes / not 是再后来那一批
    // （仿 OmniFocus 的自定义视角规则），同一条待遇：缺了落默认值，不是拒收。
    expect(sanitizeListPatch({ filter: legacy })?.filter)
      .toEqual({
        ...legacy, contexts: [], noList: false, noTag: false, noDue: false,
        isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [],
      });
  });

  it('noList / noTag / noDue 不是布尔值就整条拒收', () => {
    const base = { status: [], listIds: [], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] };
    expect(sanitizeListPatch({ filter: { ...base, noList: 'true' } })).toBeNull();
    expect(sanitizeListPatch({ filter: { ...base, noTag: 1 } })).toBeNull();
    expect(sanitizeListPatch({ filter: { ...base, noDue: 'yes' } })).toBeNull();
  });

  it('filter 少一个字段就整条拒收', () => {
    const { text: _text, ...missing } = { status: ['todo'], listIds: [], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] };
    expect(sanitizeListPatch({ filter: missing })).toBeNull();
  });

  it('filter 里塞进白名单外的键——整个 filter 拒收，这是嵌套结构里最容易被漏掉的一层', () => {
    const filter = { status: [], listIds: [], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false, text: '', 别的: 1 };
    expect(sanitizeListPatch({ filter })).toBeNull();
  });

  it('filter.status 里出现不合法的状态值——整个 filter 拒收', () => {
    const filter = { status: ['乱写的'], listIds: [], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] };
    expect(sanitizeListPatch({ filter })).toBeNull();
  });

  it('filter.priority 只收 0..3', () => {
    const base = { status: [], listIds: [], tags: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] };
    expect(sanitizeListPatch({ filter: { ...base, priority: [0, 3] } })).not.toBeNull();
    expect(sanitizeListPatch({ filter: { ...base, priority: [4] } })).toBeNull();
  });
});

describe('文件夹白名单', () => {
  it('name / order 能改', () => {
    expect(sanitizeFolderPatch({ name: '项目' })?.name).toBe('项目');
    expect(sanitizeFolderPatch({ order: 2 })?.order).toBe(2);
  });

  it('白名单外的字段整条拒收', () => {
    expect(sanitizeFolderPatch({ name: '项目', id: '篡改' })).toBeNull();
  });

  it('名字为空拒收', () => {
    expect(sanitizeFolderPatch({ name: '   ' })).toBeNull();
  });
});

describe('checkListPatch：说得出是哪个字段、为什么', () => {
  it.each([
    ['请求体不是对象', '一个字符串', 'body'],
    ['白名单外的键', { name: '工作', 别的字段: 1 }, '别的字段'],
    ['id 不在白名单里，整条拒收', { id: '篡改' }, 'id'],
    // 空字符串键：`.find()` 返回 '' 是真的找到了坏键，但 '' 是 falsy——
    // 用 `if (badKey)` 判断会把它当成「没找到」放过去，见 list.ts 的注释。
    ['空字符串键——不能被 falsy 判断放过去', { '': 1 }, ''],
    ['name 是空白', { name: '   ' }, 'name'],
    ['name 不是字符串', { name: 42 }, 'name'],
    ['color 不是 #RRGGBB', { color: '#000' }, 'color'],
    ['color 不是字符串', { color: 123 }, 'color'],
    ['color 是群青', { color: INK_AI }, 'color'],
    ['color 是群青（小写）', { color: '#2e3ed4' }, 'color'],
    ['folderId 不是字符串或 null', { folderId: 1 }, 'folderId'],
    ['order 不是有限数', { order: Number.NaN }, 'order'],
    ['archived 不是布尔值', { archived: 'true' }, 'archived'],
    ['filter 不是对象', { filter: 'x' }, 'filter'],
    ['filter 少一个字段', {
      filter: { status: [], listIds: [], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false },
    }, 'filter'],
    ['filter 里有白名单外的键', {
      filter: { status: [], listIds: [], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false, text: '', 别的: 1 },
    }, 'filter'],
  ])('%s → ok:false，field 指到 %s', (_n, body, field) => {
    const r = checkListPatch(body);
    expect(r.ok).toBe(false);
    // 不用 `if (!r.ok)` 收窄——那样断言会在 ok:true 时整个被跳过，变成一条
    // 「实现返回 ok:true 也能通过」的恒真断言。
    expect((r as SanitizeFail).field).toBe(field);
    const reason = (r as SanitizeFail).reason;
    expect(reason.trim().length).toBeGreaterThan(4);
    expect(reason).not.toBe(field);
  });

  it('白名单外的键：reason 里点名是哪个键，不是一句「字段不合法」', () => {
    const r = checkListPatch({ name: '工作', 别的字段: 1 });
    expect(r.ok).toBe(false);
    expect((r as SanitizeFail).reason).toContain('别的字段');
  });

  it('color 两种失败原因不一样：格式错跟「用了群青」不是同一句话', () => {
    const badFormat = checkListPatch({ color: '#000' });
    const inkAi = checkListPatch({ color: INK_AI });
    expect(badFormat.ok).toBe(false);
    expect(inkAi.ok).toBe(false);
    const formatReason = (badFormat as SanitizeFail).reason;
    const inkReason = (inkAi as SanitizeFail).reason;
    expect(inkReason).toContain('群青');
    expect(formatReason).not.toContain('群青');
    expect(formatReason).not.toBe(inkReason);
  });

  it('全都合法 → ok:true，value 就是清洗后的 patch', () => {
    const r = checkListPatch({ name: '  工作  ', color: '#8B5E34' });
    expect(r.ok).toBe(true);
    expect((r as SanitizeOk<ListPatch>).value).toEqual({ name: '工作', color: '#8B5E34' });
  });

  // 上限方向：只有正向断言的话，「什么都判成不合法」照样能过上面的失败用例。
  it.each([
    ['filter 为 null（不是智能清单，合法）', { filter: null }],
    ['空 patch', {}],
    ['合法颜色', { color: '#8B5E34' }],
    ['filter 形状齐全', { filter: { status: ['todo'], listIds: [], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] } }],
  ])('%s → ok:true', (_n, body) => {
    expect(checkListPatch(body).ok).toBe(true);
  });

  it('sanitizeListPatch 还是老样子：合法给 patch，不合法给 null', () => {
    expect(sanitizeListPatch({ name: '工作' })).toEqual({ name: '工作' });
    expect(sanitizeListPatch({ name: '  ' })).toBeNull();
  });
});

describe('checkFolderPatch：说得出是哪个字段、为什么', () => {
  it.each([
    ['请求体不是对象', 42, 'body'],
    ['白名单外的键', { name: '项目', id: '篡改' }, 'id'],
    ['空字符串键——不能被 falsy 判断放过去', { '': 1 }, ''],
    ['name 是空白', { name: '   ' }, 'name'],
    ['order 不是有限数', { order: Number.POSITIVE_INFINITY }, 'order'],
  ])('%s → ok:false，field 指到 %s', (_n, body, field) => {
    const r = checkFolderPatch(body);
    expect(r.ok).toBe(false);
    expect((r as SanitizeFail).field).toBe(field);
    const reason = (r as SanitizeFail).reason;
    expect(reason.trim().length).toBeGreaterThan(4);
    expect(reason).not.toBe(field);
  });

  it('白名单外的键：reason 里点名是哪个键', () => {
    const r = checkFolderPatch({ name: '项目', id: '篡改' });
    expect(r.ok).toBe(false);
    expect((r as SanitizeFail).reason).toContain('id');
  });

  it.each([
    ['空 patch', {}],
    ['合法 name', { name: '项目' }],
  ])('%s → ok:true', (_n, body) => {
    expect(checkFolderPatch(body).ok).toBe(true);
  });

  it('全都合法 → ok:true，value 就是清洗后的 patch', () => {
    const r = checkFolderPatch({ name: '  项目  ', order: 2 });
    expect(r.ok).toBe(true);
    expect((r as SanitizeOk<FolderPatch>).value).toEqual({ name: '项目', order: 2 });
  });

  it('sanitizeFolderPatch 还是老样子：合法给 patch，不合法给 null', () => {
    expect(sanitizeFolderPatch({ name: '项目' })).toEqual({ name: '项目' });
    expect(sanitizeFolderPatch({ name: '  ' })).toBeNull();
  });
});

/**
 * 高级筛选那两个字段（仿滴答清单）：`tagsAll` 和 `or`。
 */
describe('checkSmartFilter：tagsAll / or', () => {
  const base = {
    status: [], listIds: [], tags: [], priority: [], dueWithinDays: null, hasWaitingFor: false, text: '',
  };
  const filterOf = (v: unknown) => sanitizeListPatch({ filter: v })?.filter;

  it('两个都不给：落默认值，不算校验失败——加它们之前存下来的智能清单没有这两个键', () => {
    expect(filterOf(base)).toMatchObject({ tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [] });
  });

  it('给了就收下', () => {
    expect(filterOf({ ...base, tagsAll: true, noList: false, noTag: false })).toMatchObject({ tagsAll: true });
    expect(filterOf({ ...base, or: [base] })?.or).toHaveLength(1);
  });

  it('tagsAll 不是布尔值：拒收', () => {
    expect(sanitizeListPatch({ filter: { ...base, tagsAll: '是' } })).toBeNull();
  });

  it('or 不是数组：拒收', () => {
    expect(sanitizeListPatch({ filter: { ...base, or: 'x' } })).toBeNull();
  });

  it('or 里那一组自己形状不对：整条拒收', () => {
    expect(sanitizeListPatch({ filter: { ...base, or: [{ ...base, priority: [9] }] } })).toBeNull();
  });

  it('**「或」组只能嵌一层**——or 里那几组自己不能再有 or', () => {
    // 不拦的话一份存下来的查询能长成一棵任意深的树，筛选栏画不出来、人也读不懂，
    // 而它是会被写进 data/lists/ 长期留着的。
    expect(sanitizeListPatch({ filter: { ...base, or: [{ ...base, or: [base] }] } })).toBeNull();
  });

  it('or 里那几组自己的 or 是空数组：正常收下', () => {
    expect(sanitizeListPatch({ filter: { ...base, or: [{ ...base, or: [] }] } })?.filter?.or).toHaveLength(1);
  });
});
