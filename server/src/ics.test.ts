import { describe, expect, it } from 'vitest';
import { rruleFor, toIcs } from './ics.js';
import type { Countdown, Task } from './store.js';

const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: '交房租', notes: '', status: 'todo', due: '2026-08-20T09:00:00.000Z', startAt: null, endAt: null,
  reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null,
  completedAt: null, postponeCount: 0, waitingFor: null, context: null,
  attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...p,
});

describe('toIcs：骨架', () => {
  it('空任务也产出一份合法的空日历', () => {
    const s = toIcs([]);
    expect(s).toContain('BEGIN:VCALENDAR');
    expect(s).toContain('VERSION:2.0');
    expect(s).toContain('END:VCALENDAR');
    expect(s).not.toContain('BEGIN:VEVENT');
  });

  it('行尾是 CRLF，不是 LF——RFC 5545 明确要求，折行续行同样要守', () => {
    // 短标题不触发折行，只覆盖得到顶层 join；换成长标题（会折行）才能同时
    // 覆盖 foldLine 内部续行的那次 join——两处都要产出 \r\n，不是只有一处。
    const long = '一二三四五六七八九十'.repeat(4);
    const s = toIcs([task({ title: long })]);
    expect(s).toContain('\r\n');
    expect(s.split('\r\n').length).toBeGreaterThan(5);
    // 不该有落单的 \n
    expect(s.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('toIcs：选哪些任务', () => {
  it('没有 due 的不导出——放进日历没有意义', () => {
    expect(toIcs([task({ due: null })])).not.toContain('BEGIN:VEVENT');
  });

  it('已完成的不导出', () => {
    expect(toIcs([task({ status: 'done' })])).not.toContain('BEGIN:VEVENT');
  });

  it('todo / doing / later 都导出', () => {
    for (const status of ['todo', 'doing', 'later'] as const) {
      expect(toIcs([task({ status })])).toContain('BEGIN:VEVENT');
    }
  });

  // 「放弃」这个状态是后加的，这条判断当时停在只认 done——一件已经决定不做的
  // 事继续占着日历上那一天，跟「全部」那个去处的规矩也对不上（那边一直是
  // 「排除已完成和已放弃，保留搁置」）。
  it('已放弃的不导出', () => {
    expect(toIcs([task({ status: 'abandoned' })])).not.toContain('BEGIN:VEVENT');
  });

  it('**搁置的有事件、但没有闹钟**——日历上看得见 ≠ 到点要响', () => {
    const later = task({ status: 'later', reminders: [{ at: '2026-08-31T00:00:00.000Z', firedAt: null }] });
    const s = toIcs([later]);
    expect(s).toContain('BEGIN:VEVENT');
    // reminder.ts 明确拒绝给搁置的任务发提醒；VALARM 是同一个提醒换条路走到
    // 他手机上，而且是这个应用关不掉的那条路。
    expect(s).not.toContain('BEGIN:VALARM');
  });

  it('对照：同一条不搁置时闹钟是在的——上面那条不是把 VALARM 整个测没了', () => {
    const live = task({ reminders: [{ at: '2026-08-31T00:00:00.000Z', firedAt: null }] });
    expect(toIcs([live])).toContain('BEGIN:VALARM');
  });

  it('多条就是多个 VEVENT', () => {
    const s = toIcs([task({ id: 'a' }), task({ id: 'b' })]);
    expect(s.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it('解析不了的 due 静默跳过那一条，不带走整份日历——同步进来的坏数据（比如原文写着「下周三」）不该让其余任务全部消失', () => {
    const s = toIcs([task({ id: 'bad', due: '下周三' }), task({ id: 'good' })]);
    expect(s.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(s).not.toContain('UID:bad@');
    expect(s).toContain('UID:good@');
  });
});

describe('toIcs：一条 VEVENT 的内容', () => {
  it('UID 带上任务 id——同一条任务重新导出后日历 App 认得出是同一个', () => {
    expect(toIcs([task({ id: 'abc-123' })])).toContain('UID:abc-123');
  });

  it('DTSTART 是 due 那一刻，UTC 基本格式', () => {
    expect(toIcs([task({ due: '2026-08-20T09:00:00.000Z' })]))
      .toContain('DTSTART:20260820T090000Z');
  });

  it('DTSTAMP 是任务集合里最新的 updatedAt，不读时钟——两台机器算出来的字节才会一致', () => {
    const s = toIcs([
      task({ id: 'a', updatedAt: '2026-08-10T00:00:00.000Z' }),
      task({ id: 'b', updatedAt: '2026-08-15T10:00:00.000Z' }),
    ]);
    expect(s).toContain('DTSTAMP:20260815T100000Z');
  });

  it('取的是最大值，跟数组里的顺序无关', () => {
    const s = toIcs([
      task({ id: 'a', updatedAt: '2026-08-15T10:00:00.000Z' }),
      task({ id: 'b', updatedAt: '2026-08-10T00:00:00.000Z' }),
    ]);
    expect(s).toContain('DTSTAMP:20260815T100000Z');
  });

  it('SUMMARY 是标题', () => {
    expect(toIcs([task({ title: '写周报' })])).toContain('SUMMARY:写周报');
  });

  it('有提醒就加 VALARM，相对 DTSTART 的偏移', () => {
    const s = toIcs([task({
      due: '2026-08-20T09:00:00.000Z', startAt: null,
      reminders: [{ at: '2026-08-20T08:30:00.000Z', firedAt: null }],
    })]);
    expect(s).toContain('BEGIN:VALARM');
    expect(s).toContain('TRIGGER:-PT30M');   // 提前 30 分钟
  });

  it('没有提醒就没有 VALARM', () => {
    expect(toIcs([task({ reminders: [] })])).not.toContain('BEGIN:VALARM');
  });

  it('提醒晚于 due 时 TRIGGER 是正偏移 PT{n}M，不是 -PT{n}M——写成负号是不合法的 dur-value', () => {
    const s = toIcs([task({
      due: '2026-08-20T09:00:00.000Z', startAt: null,
      reminders: [{ at: '2026-08-20T09:30:00.000Z', firedAt: null }],
    })]);
    expect(s).toContain('TRIGGER:PT30M');
  });

  it('多个提醒是多个 VALARM，不是只取第一个', () => {
    const s = toIcs([task({
      due: '2026-08-20T09:00:00.000Z', startAt: null,
      reminders: [
        { at: '2026-08-20T08:30:00.000Z', firedAt: null },
        { at: '2026-08-19T09:00:00.000Z', firedAt: null },
      ],
    })]);
    expect(s.match(/BEGIN:VALARM/g)).toHaveLength(2);
  });
});

describe('toIcs：转义与折行', () => {
  it('逗号、分号、反斜杠要转义——标题里带逗号很常见', () => {
    const s = toIcs([task({ title: '买菜, 顺便取快递; 别忘了' })]);
    expect(s).toContain('SUMMARY:买菜\\, 顺便取快递\\; 别忘了');
  });

  it('备注里的换行转成 \\n', () => {
    const s = toIcs([task({ notes: '第一行\n第二行' })]);
    expect(s).toContain('DESCRIPTION:第一行\\n第二行');
  });

  it('超过 75 字节的行要折——中文一个字三字节，标题稍长就会超', () => {
    // 40 个汉字 = 120 字节，加上 "SUMMARY:" 远超 75
    const long = '一二三四五六七八九十'.repeat(4);
    const s = toIcs([task({ title: long })]);
    for (const line of s.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8'), `这一行超了 75 字节：${line}`).toBeLessThanOrEqual(75);
    }
    // 折行的续行必须以一个空格开头（RFC 5545）
    expect(s).toMatch(/\r\n /);
  });

  it('折行不会把一个汉字劈成两半', () => {
    const long = '一二三四五六七八九十'.repeat(4);
    const s = toIcs([task({ title: long })]);
    // 折完再拼回去，应该还是原来那串
    const unfolded = s.replace(/\r\n /g, '');
    expect(unfolded).toContain(`SUMMARY:${long}`);
  });
});

/**
 * RRULE。**这个应用一刻只有一条真实记录**（完成一条才生成下一条），不写 RRULE
 * 的话，订阅这份日历的人看到「每周一开例会」只出现一次，之后每个周一都是空的。
 */
describe('toIcs：重复任务导出 RRULE', () => {
  const R = (over: Partial<NonNullable<Task['repeat']>> = {}): Task['repeat'] => ({
    every: 'week', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null, ...over,
  });
  const line = (t: Task) => toIcs([t]).split('\r\n').find((l) => l.startsWith('RRULE:')) ?? null;

  it('四种固定频率各自对得上', () => {
    expect(line(task({ repeat: R({ every: 'day' }) }))).toBe('RRULE:FREQ=DAILY');
    expect(line(task({ repeat: R({ every: 'week' }) }))).toBe('RRULE:FREQ=WEEKLY');
    expect(line(task({ repeat: R({ every: 'month' }) }))).toBe('RRULE:FREQ=MONTHLY');
    expect(line(task({ repeat: R({ every: 'year' }) }))).toBe('RRULE:FREQ=YEARLY');
  });

  /**
   * **指定了星期几时也照写 `INTERVAL`。**
   *
   * 这里曾经反过来断言「不写」——因为当时 `repeat.ts` 的 week 分支**根本不看
   * interval**（「每 2 周的周一三五」实际每周都走），导出写 `INTERVAL=2` 会让
   * 订阅端隔周、而应用每周提醒，同一条任务在两处给出不同的日子。
   *
   * 那个 bug 修好之后（`nextOccurrence` 里「跳过中间那 n-1 周」那段），两边就
   * 对上了，豁免撤掉。留这条是为了钉住「两边一致」这件事本身。
   */
  it('每 2 周 + 指定星期几：照写 INTERVAL，跟应用的行为一致', () => {
    const out = line(task({ repeat: R({ every: 'week', interval: 2, weekdays: [1, 3, 5] }) }));
    expect(out).toContain('BYDAY=');
    expect(out, '应用现在真的隔周走了，导出不该少说').toContain('INTERVAL=2');
  });
  /**
   * **`WKST` 跟应用的锚点一致。** 应用算「每 N 周」的周边界时锚在名单里最小的
   * 星期几上；RRULE 不写 `WKST` 默认 `MO`，名单里有周日时两边就对不上。RFC 5545
   * 自己的例子：每 2 周的 SU,TU，`WKST=SU` 是 8/5, 8/17, 8/19, 8/31（应用就是
   * 这么响的），默认 `MO` 是 8/5, 8/10, 8/19, 8/24——手机日历画的日子跟应用
   * 提醒的日子不一样。`INTERVAL=1` 时不影响，所以只在 n > 1 时写。
   */
  // WKST 等于 BYDAY 的第一项（都是名单里最小的那天，经同一个 UTC 平移）——
  // 按这个关系断言，而不是写死 `SU`：DTSTART 写的是 UTC，跨时区跑测试时
  // 星期几会平移一天，BYDAY 和 WKST 一起移，关系不变。
  const wkstMatchesFirstByday = (out: string | null) => {
    expect(out).not.toBeNull();
    out = out!;
    const byday = /BYDAY=([A-Z]{2})/.exec(out)?.[1];
    expect(byday).toBeDefined();
    expect(out).toContain(`WKST=${byday}`);
  };
  it('每 2 周 + 名单里有周日：WKST 锚在周日（BYDAY 的第一项），跟应用一致', () => {
    wkstMatchesFirstByday(line(task({ repeat: R({ every: 'week', interval: 2, weekdays: [0, 2] }) })));
  });
  it('每 2 周、名单从周一起：WKST=MO——跟默认一样，但写出来两边才是同一份判据', () => {
    wkstMatchesFirstByday(line(task({ repeat: R({ every: 'week', interval: 2, weekdays: [1, 3, 5] }) })));
  });
  it('每 1 周指定了星期几：不写 WKST——那时它不影响任何日子，写了是废话', () => {
    expect(line(task({ repeat: R({ every: 'week', interval: 1, weekdays: [0, 2] }) }))).not.toContain('WKST');
  });
  it('每 2 周、没指定星期几：照写——那一支应用是真的隔周走', () => {
    expect(line(task({ repeat: R({ every: 'week', interval: 2 }) }))).toContain('INTERVAL=2');
  });
  it('interval 大于 1 才写 INTERVAL——写 INTERVAL=1 是句废话', () => {
    expect(line(task({ repeat: R({ every: 'day', interval: 3 }) }))).toBe('RRULE:FREQ=DAILY;INTERVAL=3');
    expect(line(task({ repeat: R({ every: 'day', interval: 1 }) }))).not.toContain('INTERVAL');
  });

  it('**BYDAY 按 DTSTART 转成 UTC 之后那一天写**——这个文件全程 UTC 时刻、不引 VTIMEZONE，按本地那一天写会让整串事件差一整天', () => {
    // due 是 2026-08-24T01:00:00Z：在 UTC 是周一，跑测试的机器在 UTC+8 时本地
    // 也是周一（09:00），位移为 0。断言写成「跟 dueDate 的 UTC 星期几对得上」，
    // 不写死 MO——那样这条测试自己会跟着宿主机时区飘，正是它要防的那种错。
    const due = '2026-08-24T01:00:00.000Z';
    const d = new Date(due);
    const shift = (d.getUTCDay() - d.getDay() + 7) % 7;
    const names = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const got = line(task({ due, repeat: R({ every: 'week', weekdays: [1, 3, 5] }) }));
    expect(got).toBe(`RRULE:FREQ=WEEKLY;BYDAY=${[1, 3, 5].map((x) => names[(x + shift) % 7]).join(',')}`);
  });

  it('BYDAY 只在周重复时写', () => {
    expect(line(task({ repeat: R({ every: 'month', weekdays: [1] }) }))).toBe('RRULE:FREQ=MONTHLY');
  });

  it('until 写成 UNTIL', () => {
    expect(line(task({ repeat: R({ every: 'day', until: '2026-12-31T15:59:00.000Z' }) })))
      .toBe('RRULE:FREQ=DAILY;UNTIL=20261231T155900Z');
  });

  it('**count 是「还要再几次」，COUNT 是「一共几次」——当前这条自己也算一次，要 +1**', () => {
    expect(line(task({ repeat: R({ every: 'day', count: 3 }) }))).toBe('RRULE:FREQ=DAILY;COUNT=4');
    // 0 = 这是最后一条：COUNT=1。
    expect(line(task({ repeat: R({ every: 'day', count: 0 }) }))).toBe('RRULE:FREQ=DAILY;COUNT=1');
  });

  it('两个都设了只写 UNTIL——RFC 5545 明令两者不能同时出现', () => {
    const got = line(task({ repeat: R({ every: 'day', until: '2026-12-31T15:59:00.000Z', count: 3 }) }));
    expect(got).toContain('UNTIL=');
    expect(got).not.toContain('COUNT=');
  });

  it('**完成重复不写**：下一次几号取决于他哪天做完，压根不是固定节律', () => {
    expect(line(task({ repeat: R({ every: 'day', from: 'done' }) }))).toBeNull();
  });

  it('**艾宾浩斯不写**：间隔走 1/2/3/8/15 那张表，RRULE 没有这种频率', () => {
    expect(line(task({ repeat: R({ every: 'ebbinghaus' }) }))).toBeNull();
  });

  it('不重复的任务照旧一个 RRULE 都没有', () => {
    expect(line(task())).toBeNull();
    expect(rruleFor(task(), new Date('2026-08-20T09:00:00.000Z'))).toBeNull();
  });

  it('RRULE 摆在 DTSTART 之后、SUMMARY 之前——顺序不是必须的，但别把它塞进 VALARM 里', () => {
    const s = toIcs([task({ repeat: R({ every: 'day' }) })]);
    const ls = s.split('\r\n');
    expect(ls.indexOf('RRULE:FREQ=DAILY')).toBeGreaterThan(ls.findIndex((l) => l.startsWith('DTSTART:')));
    expect(ls.indexOf('RRULE:FREQ=DAILY')).toBeLessThan(ls.findIndex((l) => l.startsWith('SUMMARY:')));
  });
});

/**
 * 纪念日也进 `.ics`。**应用自己的日历默认就标着它们**（`showCountdowns` 默认开），
 * 而导出的那份里一条都没有——生日、考试、纪念日恰恰是最想出现在手机日历里的东西。
 */
describe('toIcs：纪念日', () => {
  const cd = (over: Partial<Countdown> = {}): Countdown => ({
    id: 'c1', title: '生日', date: '2026-12-01', yearly: false, lunar: false,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...over,
  });
  const lines = (cs: Countdown[]) => toIcs([], cs).split('\r\n');

  it('**恒全天**（VALUE=DATE），不是任务那种时刻点——纪念日的粒度就是「哪一天」', () => {
    expect(lines([cd()])).toContain('DTSTART;VALUE=DATE:20261201');
  });

  it('**日期字面原样用，不转 UTC**——转了会在负时区里提前一天，而「生日是哪天」跟时区无关', () => {
    // 这条钉的是「没有 T…Z」：一旦有人把它改成 formatUtc，这里立刻红。
    const got = lines([cd({ date: '2026-01-01' })]).find((l) => l.startsWith('DTSTART'));
    expect(got).toBe('DTSTART;VALUE=DATE:20260101');
  });

  it('每年重复的写 RRULE:FREQ=YEARLY，不重复的不写', () => {
    expect(lines([cd({ yearly: true })])).toContain('RRULE:FREQ=YEARLY');
    expect(lines([cd({ yearly: false })]).some((l) => l.startsWith('RRULE'))).toBe(false);
  });

  it('**UID 另起一个 cd- 前缀**——纪念日和任务是两张表、id 各自生成，撞了订阅方会把两条当成同一件事', () => {
    expect(lines([cd()]).find((l) => l.startsWith('UID:'))).toMatch(/^UID:cd-c1@/);
  });

  it('日期写坏了（手改文件）静默跳过，不带走整份日历', () => {
    const s = toIcs([task()], [cd({ date: '下个月' })]);
    expect(s).toContain('BEGIN:VEVENT');            // 任务那条还在
    expect(s).not.toContain('SUMMARY:生日');
  });

  it('不传第二个参数时行为一个字没变——十几处调用点只有服务端那一处要改', () => {
    expect(toIcs([task()])).toBe(toIcs([task()], []));
  });

  it('标题里的逗号照样转义，跟任务那边同一条', () => {
    expect(lines([cd({ title: '生日,大寿' })])).toContain('SUMMARY:生日\\,大寿');
  });
});

/**
 * **有时间段的写 DTEND**——订阅方那边它才是一段，不是一个点。
 *
 * DTSTART 仍然是 `due`（没换成 `startAt`）：重复规则整个锚在 DTSTART 上，
 * 换起点会让每一条重复任务的周期跟着变，文件顶部那段解释过。这里只补上
 * 「有多长」这一半。
 */
describe('ics：时间段导出成 DTEND', () => {
  const lines = (t: Partial<Task>) => toIcs([task({ id: 'e1', ...t })]).split('\r\n');

  it('endAt 晚于 due：写一行 DTEND', () => {
    const out = lines({ due: '2026-09-01T01:00:00.000Z', startAt: '2026-09-01T01:00:00.000Z', endAt: '2026-09-01T04:00:00.000Z' });
    expect(out).toContain('DTSTART:20260901T010000Z');
    expect(out).toContain('DTEND:20260901T040000Z');
  });

  it('没有 endAt：一行 DTEND 都没有——绝大多数任务，行为一个字不变', () => {
    const out = lines({ due: '2026-09-01T01:00:00.000Z', endAt: null });
    expect(out.some((l) => l.startsWith('DTEND'))).toBe(false);
  });

  /**
   * **`endAt <= due` 时不写。** RFC 5545 §3.8.2.2 规定 DTEND 必须严格晚于
   * DTSTART，写了是一份非法的 .ics——而「结束早于开始」这种自相矛盾的话
   * 校验器是有意收下的（那是用户的话），到这一层必须挡住。
   */
  it.each([
    ['结束早于 due', '2026-08-31T23:00:00.000Z'],
    ['结束等于 due', '2026-09-01T01:00:00.000Z'],
  ])('%s：不写 DTEND，不产出一份非法的 .ics', (_n, endAt) => {
    const out = lines({ due: '2026-09-01T01:00:00.000Z', endAt });
    expect(out.some((l) => l.startsWith('DTEND'))).toBe(false);
  });

  it('endAt 解析不出来：不写，也不抛', () => {
    const out = lines({ due: '2026-09-01T01:00:00.000Z', endAt: '下周三' });
    expect(out.some((l) => l.startsWith('DTEND'))).toBe(false);
  });
});

/**
 * **农历的每年不写 RRULE。** 跟 `rruleFor` 对 `lunar-year` 的处理一字不差：
 * 农历跟公历不是等间隔的（一个农历年在 353 到 385 天之间跳），
 * `FREQ=YEARLY` 展开出来每年都会差十几天——写了就是撒谎。
 */
describe('toIcs：农历纪念日', () => {
  const cdl = (over: Partial<Countdown> = {}): Countdown => ({
    id: 'c9', title: '农历生日', date: '2026-12-01', yearly: true, lunar: true,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', ...over,
  });

  it('农历 + 每年：不写 RRULE，就是一个单次事件——那正是它真实的样子', () => {
    const s = toIcs([], [cdl()]);
    expect(s).toContain('SUMMARY:农历生日');
    expect(s).not.toContain('RRULE');
  });

  it('公历 + 每年照旧写 FREQ=YEARLY——这一条一个字节没变', () => {
    expect(toIcs([], [cdl({ lunar: false })])).toContain('RRULE:FREQ=YEARLY');
  });

  it('农历但不重复：本来就没有 RRULE，这一条只是把边界说全', () => {
    expect(toIcs([], [cdl({ yearly: false })])).not.toContain('RRULE');
  });
});
