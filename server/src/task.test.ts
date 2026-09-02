import { describe, it, expect } from 'vitest';
import { sanitizeTaskPatch, sanitizeProposalPatch, checkTaskPatch, checkProposalPatch, PROPOSABLE } from './task.js';
import type { SanitizeFail, SanitizeOk } from './task.js';
import type { TaskPatch } from './task.js';

describe('校验器：新字段', () => {
  it('reminders 形状对就收', () => {
    expect(sanitizeTaskPatch({ reminders: [{ at: '2026-08-20T10:00:00.000Z', firedAt: null }] })?.reminders)
      .toEqual([{ at: '2026-08-20T10:00:00.000Z', firedAt: null }]);
  });

  it('reminders 里的 at 不是合法时间就整条拒', () => {
    expect(sanitizeTaskPatch({ reminders: [{ at: '下周三', firedAt: null }] })).toBeNull();
  });

  it('priority 只收 0..3', () => {
    expect(sanitizeTaskPatch({ priority: 2 })?.priority).toBe(2);
    expect(sanitizeTaskPatch({ priority: 4 })).toBeNull();
    expect(sanitizeTaskPatch({ priority: '高' })).toBeNull();
  });

  it('tags 必须是字符串数组', () => {
    expect(sanitizeTaskPatch({ tags: ['紧急', '等回复'] })?.tags).toEqual(['紧急', '等回复']);
    expect(sanitizeTaskPatch({ tags: [1] })).toBeNull();
  });

  it('tags 去首尾空白', () => {
    expect(sanitizeTaskPatch({ tags: ['  紧急  '] })?.tags).toEqual(['紧急']);
  });

  it('tags 丢掉空串，含全是空白的', () => {
    expect(sanitizeTaskPatch({ tags: ['紧急', '', '   '] })?.tags).toEqual(['紧急']);
  });

  it('tags 去重且保序：先出现的留下', () => {
    expect(sanitizeTaskPatch({ tags: ['b', 'a', 'b', 'a', 'c'] })?.tags).toEqual(['b', 'a', 'c']);
  });

  it('tags 去重认的是 trim 之后的值', () => {
    expect(sanitizeTaskPatch({ tags: ['紧急', '  紧急  '] })?.tags).toEqual(['紧急']);
  });

  it('repeat 的 every 只收四个值', () => {
    expect(sanitizeTaskPatch({ repeat: { every: 'week', interval: 1, weekdays: [1], until: null } })).not.toBeNull();
    expect(sanitizeTaskPatch({ repeat: { every: '每周', interval: 1, weekdays: [], until: null } })).toBeNull();
  });

  it('repeat.interval 必须是正整数', () => {
    expect(sanitizeTaskPatch({ repeat: { every: 'day', interval: 0, weekdays: [], until: null } })).toBeNull();
    expect(sanitizeTaskPatch({ repeat: { every: 'day', interval: 1.5, weekdays: [], until: null } })).toBeNull();
  });

  it('repeat.monthDay 缺了落 null，给了就得是 1-31 的整数——跟 interval/weekdays/until 同一条', () => {
    const base = { every: 'month', interval: 1, weekdays: [], until: null };
    expect(sanitizeTaskPatch({ repeat: base })?.repeat?.monthDay).toBeNull();
    expect(sanitizeTaskPatch({ repeat: { ...base, monthDay: 31 } })?.repeat?.monthDay).toBe(31);
    expect(sanitizeTaskPatch({ repeat: { ...base, monthDay: null } })?.repeat?.monthDay).toBeNull();
    for (const bad of [0, 32, 1.5, '15', true]) {
      expect(sanitizeTaskPatch({ repeat: { ...base, monthDay: bad } })).toBeNull();
    }
  });

  it('repeat 为 null 合法地表示「不重复」', () => {
    expect(sanitizeTaskPatch({ repeat: null })?.repeat).toBeNull();
  });

  // I-3：AGENTS.md 从没列过 Repeat 的字段形状，model.ts 的类型定义又把
  // interval/weekdays/until 都写成必填——AI 少写任何一个，之前会让整个
  // outbox 文件被拒收，而且拒收信息不指名是哪个字段。这三条锁住「缺键落
  // 默认值，不是校验失败」。
  it('repeat.count（还重复几次）：缺了落 null（一直重复），0 是合法值（这是最后一条）', () => {
    expect(sanitizeTaskPatch({ repeat: { every: 'day' } })?.repeat?.count).toBeNull();
    // 0 不能拒收：那是「这是最后一条，别再生成了」，`nextInstance` 就是这么
    // 读它的——拒收会让一条刚好用完次数的重复任务在最后一次完成时炸出校验失败。
    expect(sanitizeTaskPatch({ repeat: { every: 'day', count: 0 } })?.repeat?.count).toBe(0);
    expect(sanitizeTaskPatch({ repeat: { every: 'day', count: 5 } })?.repeat?.count).toBe(5);
  });

  it('repeat.count 是负数/小数/字符串都拒收', () => {
    expect(sanitizeTaskPatch({ repeat: { every: 'day', count: -1 } })).toBeNull();
    expect(sanitizeTaskPatch({ repeat: { every: 'day', count: 1.5 } })).toBeNull();
    expect(sanitizeTaskPatch({ repeat: { every: 'day', count: '三' } })).toBeNull();
  });

  it('repeat.from 只收 due / done 两个，缺了落 due，别的拒收', () => {
    expect(sanitizeTaskPatch({ repeat: { every: 'day', from: 'done' } })?.repeat?.from).toBe('done');
    expect(sanitizeTaskPatch({ repeat: { every: 'day' } })?.repeat?.from).toBe('due');
    expect(sanitizeTaskPatch({ repeat: { every: 'day', from: '完成' } })).toBeNull();
  });

  it('repeat 缺 interval/weekdays/until 时落默认值，不整条拒收', () => {
    expect(sanitizeTaskPatch({ repeat: { every: 'day' } })?.repeat)
      .toEqual({ every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null });
    expect(sanitizeTaskPatch({ repeat: { every: 'week', weekdays: [1] } })?.repeat)
      .toEqual({ every: 'week', interval: 1, weekdays: [1], until: null, from: 'due', count: null, step: 0, monthDay: null });
  });

  it('repeat.weekdays 缺失时对「每天」这种语义上用不到 weekdays 的重复也一样落 []', () => {
    expect(sanitizeTaskPatch({ repeat: { every: 'day', interval: 2 } })?.repeat)
      .toEqual({ every: 'day', interval: 2, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null });
  });

  it('repeat.weekdays 里有越界或非整数值就拒收——缺键落默认值不等于放松了类型检查', () => {
    expect(sanitizeTaskPatch({ repeat: { every: 'week', interval: 1, weekdays: [7], until: null } })).toBeNull();
    expect(sanitizeTaskPatch({ repeat: { every: 'week', interval: 1, weekdays: [-1], until: null } })).toBeNull();
    expect(sanitizeTaskPatch({ repeat: { every: 'week', interval: 1, weekdays: [1.5], until: null } })).toBeNull();
  });

  it('repeat.until 不是合法 ISO 字符串就拒收', () => {
    expect(sanitizeTaskPatch({ repeat: { every: 'week', interval: 1, weekdays: [1], until: '下个月' } })).toBeNull();
  });

  it('listId 只收字符串或 null', () => {
    expect(sanitizeTaskPatch({ listId: 'list-1' })?.listId).toBe('list-1');
    expect(sanitizeTaskPatch({ listId: null })?.listId).toBeNull();
    expect(sanitizeTaskPatch({ listId: 1 })).toBeNull();
  });

  // completedAt 是服务端自己盖章的事实记录，postponeCount 是服务端自己数的
  // 计数——跟 order/priority 在 outbox 那条路上是同一类：调用方写什么都不算数。
  // 这里选择「悄悄忽略」而不是「类型不对就 400」：调用方传的值不进 out，也不
  // 让整个 patch 失败，行为跟其余「服务端强制归位」的字段一致。见
  // app.ts 里 `born` 那段注释——那句「completedAt 不该由调用方编」以前只在状态
  // 跃迁那一刻兑现，这里让 sanitizeTaskPatch 从源头就不收，两边说法对上。
  it('completedAt 不是白名单字段了：写了也不进 patch，也不会让整条被拒', () => {
    expect(sanitizeTaskPatch({ completedAt: '2026-08-20T10:00:00.000Z' })).toEqual({});
    expect(sanitizeTaskPatch({ completedAt: '下周三' })).toEqual({});
    const withTitle = sanitizeTaskPatch({ title: '标题', completedAt: '2026-08-20T10:00:00.000Z' });
    expect(withTitle).toEqual({ title: '标题' });
    expect(withTitle && 'completedAt' in withTitle).toBe(false);
  });

  it('postponeCount 不是白名单字段了：写了也不进 patch，也不会让整条被拒', () => {
    expect(sanitizeTaskPatch({ postponeCount: 3 })).toEqual({});
    expect(sanitizeTaskPatch({ postponeCount: -1 })).toEqual({});
    const withTitle = sanitizeTaskPatch({ title: '标题', postponeCount: 3 });
    expect(withTitle).toEqual({ title: '标题' });
    expect(withTitle && 'postponeCount' in withTitle).toBe(false);
  });

  it('waitingFor 只收字符串或 null（`stuckNote` 已删，白名单里不再有它）', () => {
    expect(sanitizeTaskPatch({ waitingFor: '等对方回复' })?.waitingFor).toBe('等对方回复');
    expect(sanitizeTaskPatch({ waitingFor: 1 })).toBeNull();
    // 字段删了，也就不在 `TaskPatch` 白名单里了——传了不报错，但不采纳。
    expect(sanitizeTaskPatch({ title: 'x', stuckNote: '卡在审批' } as Record<string, unknown>))
      .not.toHaveProperty('stuckNote');
  });

  /**
   * `reviewedAt` 是回顾那一屏那颗「看过了」盖的章。**人经网页发起的写要收**
   * （那颗按钮走的就是 PATCH /api/tasks/:id），**AI 写的不算数**——后者不在
   * 这里做，在 `outbox.ts` 的 `stripForced` 里，跟 priority/estimateMinutes
   * 同一个套路：校验器只管形状，「该由谁写」是外面信任边界的事。
   */
  /**
   * `section`（清单里的分段，仿滴答清单的「分组」）。这个应用里分段没有实体，
   * 存的就是段名——所以**空串要归 null**：界面上把输入框清空就是「不在任何
   * 分段里」，存一个空字符串会让它变成一个名字为空的分段，分组时冒出一个
   * 没有标题的组。
   */
  it('section：字符串或 null；空串和纯空白归 null，不是变成一个没名字的分段', () => {
    expect(sanitizeTaskPatch({ section: '第一阶段' })?.section).toBe('第一阶段');
    expect(sanitizeTaskPatch({ section: null })?.section).toBeNull();
    expect(sanitizeTaskPatch({ section: '' })?.section).toBeNull();
    expect(sanitizeTaskPatch({ section: '   ' })?.section).toBeNull();
    // 不是字符串整条拒，不静静丢掉——静静丢掉的表现是「输入框里打了字、保存了、
    // 回来还是空的」，而且没有任何报错。
    expect(sanitizeTaskPatch({ section: 1 })).toBeNull();
    expect(sanitizeTaskPatch({ section: ['甲'] })).toBeNull();
  });

  it('reviewedAt 只收 ISO 时间串或 null——坏字符串整条拒，不静静归 null', () => {
    const at = '2026-08-25T00:00:00.000Z';
    expect(sanitizeTaskPatch({ reviewedAt: at })?.reviewedAt).toBe(at);
    expect(sanitizeTaskPatch({ reviewedAt: null })?.reviewedAt).toBeNull();
    // 整条拒（返回 null），而不是把这个字段悄悄丢掉：一个「看过了」没盖上、
    // 又没有任何报错的章，表现是那颗按钮点了没反应。
    expect(sanitizeTaskPatch({ reviewedAt: '上周' })).toBeNull();
    expect(sanitizeTaskPatch({ reviewedAt: 1756080000000 })).toBeNull();
  });

  it('context 只收那五档或者 null——认不得的值整条拒，不静静归 null', () => {
    expect(sanitizeTaskPatch({ context: 'computer' })?.context).toBe('computer');
    expect(sanitizeTaskPatch({ context: 'easy' })?.context).toBe('easy');
    // 清掉情境是合法动作，不是校验失败。
    expect(sanitizeTaskPatch({ context: null })).toHaveProperty('context', null);
    // 不在枚举里的、以及压根不是字符串的，都拒。**拒比归 null 重要**：
    // 静静归 null 的话，AI 写错一个情提名字会变成「保存成功、字段是空」，
    // 而 AGENTS.md 里那句「校验失败会告诉你哪个字段错了」就失效了。
    expect(sanitizeTaskPatch({ context: '电脑前' })).toBeNull();
    expect(sanitizeTaskPatch({ context: 'office' })).toBeNull();
    expect(sanitizeTaskPatch({ context: 1 })).toBeNull();
    // **原型链上的名字也拒。** 原来用 `in` 判，`'__proto__' in {}` 是 true，于是
    // `context: '__proto__'` 校验通过、落盘；界面上 `CONTEXT_LABEL[t.context]`
    // 取回 `Object.prototype`，React 抛「Objects are not valid as a React child」，
    // 这条任务所在的每张卡、每一行全白。
    for (const k of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(sanitizeTaskPatch({ context: k }), k).toBeNull();
    }
  });

  it('attachments 必须是字符串数组', () => {
    expect(sanitizeTaskPatch({ attachments: ['a.png'] })?.attachments).toEqual(['a.png']);
    expect(sanitizeTaskPatch({ attachments: [1] })).toBeNull();
  });

  it('focusSessions 形状对就收，minutes 必须是正数', () => {
    expect(sanitizeTaskPatch({ focusSessions: [{ startedAt: '2026-08-20T10:00:00.000Z', minutes: 25 }] })?.focusSessions)
      .toEqual([{ startedAt: '2026-08-20T10:00:00.000Z', minutes: 25 }]);
    expect(sanitizeTaskPatch({ focusSessions: [{ startedAt: '2026-08-20T10:00:00.000Z', minutes: 0 }] })).toBeNull();
    expect(sanitizeTaskPatch({ focusSessions: [{ startedAt: '不是时间', minutes: 25 }] })).toBeNull();
  });

  /**
   * **这一条放宽了。** 原来只认「每天」，理由是「『每月打卡』不是习惯」——
   * 那句话对，但盖不住滴答明确举的例子「健身，我只需要一周完成 3 次」。
   * 现在「每天」和「每周」都收，别的档位照旧拒。
   */
  it('habit 为真而 repeat 既不是每天也不是每周：拒收', () => {
    expect(sanitizeTaskPatch({ habit: true, repeat: { every: 'month', interval: 1, weekdays: [], until: null } })).toBeNull();
    expect(sanitizeTaskPatch({ habit: true, repeat: { every: 'year', interval: 1, weekdays: [], until: null } })).toBeNull();
    expect(sanitizeTaskPatch({ habit: true, repeat: null })).toBeNull();
  });

  it.each([['day'], ['week']] as const)('habit 为真且 repeat 是「每%s」：收', (every) => {
    expect(sanitizeTaskPatch({ habit: true, repeat: { every, interval: 1, weekdays: every === 'week' ? [1, 3, 5] : [], until: null } })).not.toBeNull();
  });

  it('契约：只设 habit:true 不带 repeat 的局部 patch 一律拒收——校验器拿不到任务原来的 repeat，判断不了合并后是不是每天', () => {
    expect(sanitizeTaskPatch({ habit: true })).toBeNull();
    expect(sanitizeTaskPatch({ habit: true, title: '改个标题顺带标成习惯' })).toBeNull();
  });

  it('habit 为假时不受 repeat 是否每天限制', () => {
    expect(sanitizeTaskPatch({ habit: false, repeat: { every: 'month', interval: 1, weekdays: [], until: null } })).not.toBeNull();
  });
});

describe('提议白名单', () => {
  it('这几个字段都能提', () => {
    for (const k of ['title', 'notes', 'due', 'startAt', 'reminders', 'subtasks', 'tags', 'listId', 'repeat', 'priority', 'waitingFor', 'context']) {
      expect(PROPOSABLE).toContain(k);
    }
  });

  it('reviewedAt 不能提——「人看过没看过」是人的记录，AI 替他盖章等于替他做决定', () => {
    expect(PROPOSABLE).not.toContain('reviewedAt');
  });

  it('section 不能提——怎么给自己的清单分段是他的组织习惯，跟 pinned/parentId 同一类', () => {
    expect(PROPOSABLE).not.toContain('section');
  });

  it('status / order / stuckNote / completedAt / postponeCount 一个都不能提', () => {
    for (const k of ['status', 'order', 'stuckNote', 'completedAt', 'postponeCount', 'source', 'aiComment', 'focusSessions', 'habit', 'attachments']) {
      expect(PROPOSABLE).not.toContain(k);
    }
  });

  it('提了白名单外的字段整条拒收，不是悄悄过滤', () => {
    expect(sanitizeProposalPatch({ due: null, status: 'done' })).toBeNull();
  });
});

describe('checkProposalPatch：说得出是哪个字段、为什么（I2：updates 那条路以前只有裸 null）', () => {
  it.each([
    ['patch 不是对象', 'x', 'patch'],
    ['空 patch', {}, 'patch'],
    ['白名单外的键', { status: 'done' }, 'status'],
    // 这是原始 bug 案例：due 就在白名单（PROPOSABLE）里，patch 也不是空
    // 对象——旧版 sanitizeProposalPatch 返回裸 null，外面拼出来的话对这个
    // 输入是假话。这里直接过 checkTaskPatch，field/reason 应该是真的原因。
    ['due 在白名单里但格式不对', { due: '下周三' }, 'due'],
    ['repeat 在白名单里但形状不对', { repeat: { every: 'fortnight' } }, 'repeat'],
  ])('%s → ok:false，field 指到 %s', (_n, patch, field) => {
    const r = checkProposalPatch(patch);
    expect(r.ok).toBe(false);
    expect((r as SanitizeFail).field).toBe(field);
    const reason = (r as SanitizeFail).reason;
    expect(reason.trim().length).toBeGreaterThan(4);
  });

  it('due 格式错的 reason 里要有 ISO，不是「不在白名单/patch 是空对象」那句旧模板', () => {
    const r = checkProposalPatch({ due: '下周三' });
    expect(r.ok).toBe(false);
    expect((r as SanitizeFail).reason).toContain('ISO');
  });

  it('全都合法 → ok:true', () => {
    expect(checkProposalPatch({ due: '2026-09-01T00:00:00.000Z' }).ok).toBe(true);
  });
});

describe('checkTaskPatch：说得出是哪个字段、为什么', () => {
  it.each([
    ['title 是空白', { title: '   ' }, 'title'],
    ['title 不是字符串', { title: 42 }, 'title'],
    ['notes 不是字符串', { notes: null }, 'notes'],
    ['status 不在四选一里', { status: 'pending' }, 'status'],
    ['due 不是合法 ISO', { due: '下周三' }, 'due'],
    ['reminders 不是数组', { reminders: '明天' }, 'reminders'],
    ['reminders 里的 at 解析不了', { reminders: [{ at: '明早八点', firedAt: null }] }, 'reminders'],
    ['subtasks 里的 text 不是字符串', { subtasks: [{ text: 42, done: false }] }, 'subtasks'],
    ['tags 不是字符串数组', { tags: [1, 2] }, 'tags'],
    ['repeat.every 不在四选一里', { repeat: { every: 'fortnight' } }, 'repeat'],
    ['repeat.interval 是 0', { repeat: { every: 'day', interval: 0 } }, 'repeat'],
    ['habit 为真但 repeat 既不是每天也不是每周', { habit: true, repeat: { every: 'month' } }, 'habit'],
  ])('%s → ok:false，field 指到 %s', (_n, body, field) => {
    const r = checkTaskPatch(body);
    expect(r.ok).toBe(false);
    // 不用 `if (!r.ok)` 收窄——那样断言会在 ok:true 时整个被跳过，
    // 变成一条「实现返回 ok:true 也能通过」的恒真断言。
    expect((r as SanitizeFail).field).toBe(field);
    // reason 要是一句人（和 AI）看得懂的话，不是字段名本身、不是空串。
    const reason = (r as SanitizeFail).reason;
    expect(reason.trim().length).toBeGreaterThan(4);
    expect(reason).not.toBe(field);
  });

  it('全都合法 → ok:true，value 就是清洗后的 patch', () => {
    const r = checkTaskPatch({ title: '  交房租  ', tags: [' 家 ', '', '家'] });
    expect(r.ok).toBe(true);
    expect((r as SanitizeOk<TaskPatch>).value).toEqual({ title: '交房租', tags: ['家'] });
  });

  // 上限方向：只有正向断言的话，「什么都判成不合法」照样能过上面十二条。
  it.each([
    ['repeat 是 null（不重复，合法）', { repeat: null }],
    ['due 是 null（没有截止，合法）', { due: null }],
    ['tags 是空数组', { tags: [] }],
    ['空 patch', {}],
    ['status 四个值都收', { status: 'later' }],
  ])('%s → ok:true', (_n, body) => {
    expect(checkTaskPatch(body).ok).toBe(true);
  });

  it('sanitizeTaskPatch 还是老样子：合法给 patch，不合法给 null', () => {
    expect(sanitizeTaskPatch({ title: '交房租' })).toEqual({ title: '交房租' });
    expect(sanitizeTaskPatch({ title: '  ' })).toBeNull();
  });
});

/**
 * 「打算花多久」（仿滴答清单的「预计番茄/预计时长」，这里只做后一种）。有了它，卡片上
 * 那句「已专注 50 分钟」才有分母——光有累计时长只是个事实，配上估计才是一句
 * 判断（「说好一小时，已经两小时了」）。
 */
describe('checkTaskPatch：estimateMinutes', () => {
  const ok = (v: unknown) => checkTaskPatch({ estimateMinutes: v });

  it('正整数分钟收得下', () => {
    expect(ok(90)).toEqual({ ok: true, value: { estimateMinutes: 90 } });
  });

  it('null = 没估过，收得下', () => {
    expect(ok(null)).toEqual({ ok: true, value: { estimateMinutes: null } });
  });

  it('**0 不算一个估计**——那是「不用做」，不是「花零分钟」', () => {
    expect(ok(0).ok).toBe(false);
  });

  it('负数、小数、超过一天的都拒——超过一天的那不该是一条任务，是一个项目', () => {
    for (const bad of [-30, 12.5, 24 * 60 + 1]) expect(ok(bad).ok, String(bad)).toBe(false);
  });

  it('恰好一天收得下', () => {
    expect(ok(24 * 60).ok).toBe(true);
  });

  it('字符串拒掉，说得出是哪个字段', () => {
    const r = ok('一小时');
    expect(r.ok).toBe(false);
    expect((r as { field: string }).field).toBe('estimateMinutes');
  });
});

/**
 * 「开始时间」（仿 OmniFocus 的 Defer Date）。这一族只测**校验器**这一层：
 * 形状对不对、非法值拒不拒、`in b` 的语义（没传就不动这个字段）。
 * 「在这之前别烦我」那半边语义在界面那侧，另有测试。
 */
describe('startAt：校验这一层', () => {
  it('收 ISO 时间字符串', () => {
    const r = checkTaskPatch({ startAt: '2026-09-01T00:00:00.000Z' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.startAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('收 null（= 随时可以做）', () => {
    const r = checkTaskPatch({ startAt: null });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.startAt).toBeNull();
  });

  it.each([['下周三'], [123], [{}], [[]]])('拒掉非法值 %s', (v) => {
    const r = checkTaskPatch({ startAt: v });
    expect(r.ok).toBe(false);
  });

  it('**没传就不动**——`in b` 的语义，不是「没传当成清空」', () => {
    const r = checkTaskPatch({ title: '改个标题' });
    expect(r.ok).toBe(true);
    expect(r.ok && 'startAt' in r.value).toBe(false);
  });

  /**
   * **不校验「开始晚于截止」。** 那是一句自相矛盾的话，但它是用户的话：多半是
   * 他先填了开始、还没来得及改截止。当场拒掉的代价是那一次编辑整个失败
   * （表单里两个控件，改哪个都可能短暂地不自洽）。
   */
  it('开始晚于截止照样收——那是用户的话，不是格式错误', () => {
    const r = checkTaskPatch({ startAt: '2026-12-01T00:00:00.000Z', due: '2026-09-01T00:00:00.000Z' });
    expect(r.ok).toBe(true);
  });
});
