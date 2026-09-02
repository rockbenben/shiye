import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ebbinghausGap, nextOccurrence, nextInstance, skipPatch } from './repeat.js';
import type { Repeat, Task } from './store.js';
import { REPEAT_KINDS } from './store.js';
import { sanitizeTaskPatch } from './task.js';

// 整分支审查 E：既有的时区债，第三处。夹具原来用固定 UTC 'Z' 时间戳
// （`D('2026-08-14T09:00:00.000Z')`）构造，注释断言「这是本地周五」——这个
// 假设只在宿主机时区大致落在 UTC-8 附近才成立。`TZ=Pacific/Midway`（UTC-11）
// 下实测四条红：2026-08-14T09:00:00.000Z 在 -11 时区本地是 08-13 22:00
// （周四，不是周五）。`nextOccurrence` 全程按本地墙钟算（`getDay()`/
// `setDate()`），断言那半又用 `toISOString().slice(0,10)` 把结果读回
// UTC——两头各自依赖宿主机时区，方向还相反，只有凑在一起结果恰好落在同一
// 日历天时才会算对，Pacific/Midway 下两头一起偏，实测值精确对上：期望
// 2026-08-17、拿到 2026-08-18；期望 2026-02-28、拿到 2026-03-01。
//
// 这正是 `agenda.test.ts` 顶上「不能用固定 UTC 时间戳」那条规矩被违反的样子：不能用固定
// UTC 'Z' 时间戳，NOW 和所有 due 都改用不带时区的本地 Date 构造。技术手法
// 跟 calendar.test.ts/dueChip.test.ts/ProposalNote.test.tsx 同一套——
// `vi.stubEnv('TZ', 'Asia/Shanghai')` 把这份文件自己的时区钉死，不依赖宿主
// 机（那三处已经验过这招在这个仓库当前的 Node/vitest 组合下对 Date/Intl
// 立即生效）。
//
// **模块顶层在 stubEnv 生效之前构造好的 Date 常量不能复用**：那是按宿主机
// 当时的时区烤进internal 时间戳的一个固定瞬间，stub 之后再读它的
// getDate()/getDay() 会是拿新时区去解读一个用旧时区烤出来的瞬间，不等于
// 「重新按新时区构造」。`local()`/`localDateStr()` 只是函数，模块顶层定义
// 安全（不构造 Date）；真正调用它们、现造 Date 的地方全部留在 `it()` 内部，
// `beforeEach` 早于每个 `it()` 的函数体执行，stub 保证已经生效。
beforeEach(() => {
  vi.stubEnv('TZ', 'Asia/Shanghai');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** 本地分量构造，不经过 UTC 'Z' 字符串——跟 calendar.test.ts 的 `at()` 同一条道理。 */
const local = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date =>
  new Date(y, m - 1, d, h, mi, s, ms);

/** 读回本地日期分量，不用 `toISOString().slice(0,10)`——那半是 UTC 镜头，
 *  跟 `nextOccurrence` 本地墙钟算出来的答案不是同一个参照系，见上面文件
 *  顶部的说明。 */
const localDateStr = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', title: '写周报', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
    reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    order: null, listId: null, section: null, tags: [], priority: 0, repeat: null,
    completedAt: null, postponeCount: 0, waitingFor: null, context: null,
    attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...over,
  };
}

const R = (o: Partial<Repeat> = {}): Repeat =>
  ({ every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null, ...o });

describe('nextOccurrence', () => {
  it('每天', () => {
    const from = local(2026, 8, 14, 9);
    expect(nextOccurrence(R({ every: 'day' }), from)?.toISOString())
      .toBe(local(2026, 8, 15, 9).toISOString());
  });

  it('每 3 天', () => {
    const from = local(2026, 8, 14, 9);
    expect(nextOccurrence(R({ every: 'day', interval: 3 }), from)?.toISOString())
      .toBe(local(2026, 8, 17, 9).toISOString());
  });

  it('每周（不指定星期几）就是 +7 天', () => {
    const from = local(2026, 8, 14, 9);
    expect(nextOccurrence(R({ every: 'week' }), from)?.toISOString())
      .toBe(local(2026, 8, 21, 9).toISOString());
  });

  it('每周一：从周五出发落到下周一', () => {
    // 2026-08-14 是本地周五——local() 直接钉死本地日期分量，不经过 UTC，
    // 这条注释在任何时区下都成立，不依赖宿主机/stub 选了哪个时区。
    const from = local(2026, 8, 14, 9);
    const got = nextOccurrence(R({ every: 'week', weekdays: [1] }), from);
    expect(got!.getDay()).toBe(1);
    expect(localDateStr(got!)).toBe('2026-08-17');
  });

  /**
   * **`interval > 1` 时要跳过中间那 n-1 周。**
   *
   * 这个分支原来完全不看 `interval`：「每 2 周的周一三五」实际是**每周**都走
   * （实测 9/7 起是 9/9 → 9/11 → 9/14 → 9/16 → 9/18，第二周一次都没跳）。
   * 而界面上 interval 那个数字框和星期几按钮是同时给的、卡片说明写着「每 2 周的
   * 周一三五」、导出的 RRULE 也带过 `INTERVAL=2`——三处各说各的，只有真正会响的
   * 那一处是错的。
   *
   * **周边界用规则自己的锚点（名单里最小的那个星期几），不用 `Settings.weekStart`**：
   * 那是每台机器的显示偏好，一条重复任务的节奏不该因为换台机器就变。
   */
  it('每 2 周的周一三五：本组内照走，跨组时跳掉中间那一周', () => {
    const rule = R({ every: 'week', interval: 2, weekdays: [1, 3, 5] });
    const seq: string[] = [];
    let d = local(2026, 9, 7, 9);   // 周一
    for (let i = 0; i < 5; i += 1) { d = nextOccurrence(rule, d)!; seq.push(`${d.getMonth() + 1}/${d.getDate()}`); }
    expect(seq, '第二周没跳过——interval 被忽略了').toEqual(['9/9', '9/11', '9/21', '9/23', '9/25']);
  });

  it('每 2 周的周五：隔周一次', () => {
    const rule = R({ every: 'week', interval: 2, weekdays: [5] });
    let d = local(2026, 9, 7, 9);
    const seq: string[] = [];
    for (let i = 0; i < 3; i += 1) { d = nextOccurrence(rule, d)!; seq.push(`${d.getMonth() + 1}/${d.getDate()}`); }
    expect(seq).toEqual(['9/18', '10/2', '10/16']);
  });

  // interval 是 1 的那一支不能被影响——这是绝大多数任务走的路。
  it('每 1 周的周一三五：一周不跳，跟以前一样', () => {
    const rule = R({ every: 'week', interval: 1, weekdays: [1, 3, 5] });
    let d = local(2026, 9, 7, 9);
    const seq: string[] = [];
    for (let i = 0; i < 4; i += 1) { d = nextOccurrence(rule, d)!; seq.push(`${d.getMonth() + 1}/${d.getDate()}`); }
    expect(seq).toEqual(['9/9', '9/11', '9/14', '9/16']);
  });

  it('每周一三五：从周五出发落到下周一，不是下下周五', () => {
    const from = local(2026, 8, 14, 9);
    const got = nextOccurrence(R({ every: 'week', weekdays: [1, 3, 5] }), from);
    expect(localDateStr(got!)).toBe('2026-08-17');
  });

  it('每周一三五：从周一出发落到周三', () => {
    const from = local(2026, 8, 17, 9);
    const got = nextOccurrence(R({ every: 'week', weekdays: [1, 3, 5] }), from);
    expect(localDateStr(got!)).toBe('2026-08-19');
  });

  it('每月', () => {
    const from = local(2026, 8, 14, 9);
    expect(nextOccurrence(R({ every: 'month' }), from)?.toISOString())
      .toBe(local(2026, 9, 14, 9).toISOString());
  });

  it('每月 31 号遇到只有 30 天的月份，落在月末不是溢出到下个月', () => {
    // 原生 setMonth 会把 1/31 + 1 个月变成 3/3，这是必须挡的
    const from = local(2026, 1, 31, 9);
    const got = nextOccurrence(R({ every: 'month' }), from);
    expect(localDateStr(got!)).toBe('2026-02-28');
  });

  it('**记了 monthDay 就回得去**：31 号在二月 clamp 到 28，三月回到 31，不是从此漂在 28 号', () => {
    // 这正是加 monthDay 之前的错：只看当前那条的日号，1/31 → 2/28 之后，
    // 下一次从 28 算起，3 月就成了 28 号，再也回不到 31。
    const feb = nextOccurrence(R({ every: 'month', monthDay: 31 }), local(2026, 1, 31, 9));
    expect(localDateStr(feb!)).toBe('2026-02-28');
    const mar = nextOccurrence(R({ every: 'month', monthDay: 31 }), feb!);
    expect(localDateStr(mar!)).toBe('2026-03-31');
  });

  it('没记过 monthDay 的（这个字段之前的老数据）行为一字不变——退回当前那条的日号', () => {
    const feb = nextOccurrence(R({ every: 'month' }), local(2026, 1, 31, 9));
    expect(localDateStr(feb!)).toBe('2026-02-28');
    expect(localDateStr(nextOccurrence(R({ every: 'month' }), feb!)!)).toBe('2026-03-28');
  });

  it('monthDay 只管月重复，别的档位不读它', () => {
    expect(localDateStr(nextOccurrence(R({ every: 'day', monthDay: 31 }), local(2026, 1, 5, 9))!))
      .toBe('2026-01-06');
  });

  it('每年', () => {
    const from = local(2026, 8, 14, 9);
    expect(nextOccurrence(R({ every: 'year' }), from)?.toISOString())
      .toBe(local(2027, 8, 14, 9).toISOString());
  });

  it('超过 until 就不再生成', () => {
    const from = local(2026, 8, 14, 9);
    expect(nextOccurrence(R({ every: 'day', until: local(2026, 8, 14, 23, 59, 59).toISOString() }), from))
      .toBeNull();
  });

  it('刚好等于 until 还算数', () => {
    const from = local(2026, 8, 14, 9);
    expect(nextOccurrence(R({ every: 'day', until: local(2026, 8, 15, 9).toISOString() }), from))
      .not.toBeNull();
  });
});

describe('nextInstance', () => {
  it('没有 repeat 就不生成', () => {
    expect(nextInstance(task({ status: 'done' }), local(2026, 8, 14, 10))).toBeNull();
  });

  it('有 due：按 due 往后推，不是按完成时刻——连续拖延不该让周期漂移', () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'week' }),
    }), local(2026, 8, 14, 10))!;
    expect(next.due).toBe(local(2026, 8, 17, 9).toISOString());
  });

  it('**第一次推进时把锚点补上**：老数据（表单里点出来的月重复）没有 monthDay，用当时那条的日号记下来', () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 1, 31, 9).toISOString(), repeat: R({ every: 'month' }),
    }), local(2026, 1, 31, 10))!;
    // 这一次照旧 clamp 到 2/28，但下一条带着 monthDay: 31——三月就回得去了。
    expect(next.due).toBe(local(2026, 2, 28, 9).toISOString());
    expect(next.repeat?.monthDay).toBe(31);
    const mar = nextInstance({ ...next, status: 'done' }, local(2026, 2, 28, 10))!;
    expect(mar.due).toBe(local(2026, 3, 31, 9).toISOString());
  });

  it('已经记过的不覆盖——monthDay 一旦有值就是唯一出处', () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 2, 28, 9).toISOString(), repeat: R({ every: 'month', monthDay: 31 }),
    }), local(2026, 2, 28, 10))!;
    expect(next.repeat?.monthDay).toBe(31);
  });

  it('别的重复档位不补锚点——那个字段只有月重复读', () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 1, 31, 9).toISOString(), repeat: R({ every: 'week' }),
    }), local(2026, 1, 31, 10))!;
    expect(next.repeat?.monthDay).toBeNull();
  });

  it('没有 due 的月重复补不出锚点，也不该瞎补', () => {
    const next = nextInstance(task({
      status: 'done', due: null, repeat: R({ every: 'month' }),
    }), local(2026, 1, 31, 10))!;
    expect(next.repeat?.monthDay).toBeNull();
  });

  it("from: 'done'：按完成那一刻往后推，不是按 due——「每三天做一次」拖到今天做完，下一次就从今天算", () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'day', interval: 3, from: 'done' }),
    }), local(2026, 8, 14, 10))!;
    // 到期重复会给 8/13（10 号加三天），完成重复给 8/17（14 号加三天）
    expect(next.due).toBe(local(2026, 8, 17, 10).toISOString());
  });

  it("from: 'done' 时提醒相对 due 的偏移量守得住——不是跟着完成时刻平移，那会让「截止前一小时」跑到截止之后", () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'day', interval: 3, from: 'done' }),
      reminders: [{ at: local(2026, 8, 10, 8).toISOString(), firedAt: null }],
    }), local(2026, 8, 14, 10))!;
    // 新 due 是 8/17 10:00，提醒原本比 due 早一小时，新的一条也该早一小时
    expect(next.reminders).toEqual([{ at: local(2026, 8, 17, 9).toISOString(), firedAt: null }]);
  });

  it('没有 due：新的一条也没有 due，不凭空长出一个', () => {
    const next = nextInstance(task({ status: 'done', repeat: R({ every: 'day' }) }), local(2026, 8, 14, 10))!;
    expect(next.due).toBeNull();
  });

  it('提醒整体平移，firedAt 全部重置', () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'week' }),
      reminders: [{ at: local(2026, 8, 10, 8).toISOString(), firedAt: local(2026, 8, 10, 8, 0, 1).toISOString() }],
    }), local(2026, 8, 14, 10))!;
    expect(next.reminders).toEqual([{ at: local(2026, 8, 17, 8).toISOString(), firedAt: null }]);
  });

  it('没有 due 时提醒按完成时刻平移——习惯类靠这条才响得起来', () => {
    const at = local(2026, 8, 14, 10);
    const next = nextInstance(task({
      status: 'done', repeat: R({ every: 'day' }), habit: true,
      reminders: [{ at: local(2026, 8, 14, 9).toISOString(), firedAt: local(2026, 8, 14, 9, 0, 1).toISOString() }],
    }), at)!;
    expect(next.reminders).toEqual([{ at: local(2026, 8, 15, 9).toISOString(), firedAt: null }]);
  });

  it("count（还重复几次）到 0 就不再生成——滴答清单的「按次数结束重复」", () => {
    const done = task({ status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'week', count: 0 }) });
    expect(nextInstance(done, local(2026, 8, 14, 10))).toBeNull();
  });

  it('count 每生成一条减一，带给下一条', () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'week', count: 3 }),
    }), local(2026, 8, 14, 10))!;
    expect(next.repeat?.count).toBe(2);
  });

  it('count 是 null（一直重复）时原样传下去，不会变成数字', () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'week' }),
    }), local(2026, 8, 14, 10))!;
    expect(next.repeat?.count).toBeNull();
  });

  it('count 字段缺失（加这个字段之前的老数据）当成一直重复，行为跟加它之前一字不差', () => {
    const legacy = { every: 'week', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null } as unknown as Repeat;
    const next = nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: legacy,
    }), local(2026, 8, 14, 10));
    expect(next).not.toBeNull();
    expect(next!.due).toBe(local(2026, 8, 17, 9).toISOString());
  });

  it('新的一条是全新 id、todo、清零的计数', () => {
    const at = local(2026, 8, 14, 10);
    const prev = task({
      id: 'old', status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'week' }),
      completedAt: local(2026, 8, 14, 10).toISOString(), postponeCount: 5, order: 3,
 focusSessions: [{ startedAt: local(2026, 8, 14, 9).toISOString(), minutes: 25 }],
    });
    const next = nextInstance(prev, at)!;
    expect(next.id).not.toBe('old');
    expect(next.status).toBe('todo');
    expect(next.completedAt).toBeNull();
    expect(next.postponeCount).toBe(0);
    expect(next.order).toBeNull();
    expect(next.focusSessions).toEqual([]);

    // 「不等于写死的旧 id」挡不住「写死一个不一样的常量」——两次调用生成的 id
    // 必须互不相同，才能确认真的是每次都现生成，不是碰巧写了个别的常量。
    const a = nextInstance(prev, at)!;
    const b = nextInstance(prev, at)!;
    expect(a.id).not.toBe(b.id);

    // 诞生时刻是**传进来的完成时刻**，不是函数自己去读一次系统时钟。
    // 语义上「这条实例什么时候诞生的」就该等于上一条什么时候完成的；
    // 顺带让 nextInstance 除了 randomUUID 之外保持纯函数，可断言。
    expect(next.createdAt).toBe(at.toISOString());
    expect(next.updatedAt).toBe(at.toISOString());
  });

  it('子任务带过去但全部重置成没做', () => {
    const next = nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'week' }),
      subtasks: [{ text: '找数据', done: true }, { text: '写初稿', done: true }],
    }), local(2026, 8, 14, 10))!;
    expect(next.subtasks).toEqual([{ text: '找数据', done: false }, { text: '写初稿', done: false }]);
  });

  it('标题/清单/标签/优先级/重复规则本身都带过去', () => {
    const rule = R({ every: 'week', weekdays: [1] });
    const next = nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: rule,
      title: '写周报', listId: 'L1', tags: ['工作'], priority: 2, habit: false, waitingFor: '张老师',
    }), local(2026, 8, 14, 10))!;
    expect(next.title).toBe('写周报');
    expect(next.listId).toBe('L1');
    expect(next.tags).toEqual(['工作']);
    expect(next.priority).toBe(2);
    expect(next.repeat).toEqual(rule);
    expect(next.waitingFor).toBe('张老师');
  });

  it('过了 until 就不生成', () => {
    expect(nextInstance(task({
      status: 'done', due: local(2026, 8, 10, 9).toISOString(),
      repeat: R({ every: 'week', until: local(2026, 8, 12, 0).toISOString() }),
    }), local(2026, 8, 14, 10))).toBeNull();
  });

  it('拖过不止一个周期：新的一条不会一出生就已经过期——不然下一个 tick 就被当成迟到通知炸出去', () => {
    // due 是完成时刻（at，08-14）三周前，「每天」推一次还是过去。
    const at = local(2026, 8, 14, 10);
    const next = nextInstance(task({
      status: 'done', due: local(2026, 7, 24, 9).toISOString(), repeat: R({ every: 'day' }),
      reminders: [{ at: local(2026, 7, 24, 9).toISOString(), firedAt: null }],
    }), at)!;
    expect(Date.parse(next.due!)).toBeGreaterThan(at.getTime());
    expect(Date.parse(next.reminders[0].at)).toBeGreaterThan(at.getTime());
  });
});

/**
 * 艾宾浩斯记忆法（仿滴答清单）。间隔表和它是怎么从帮助文档那句「1，2，4，7，
 * 15」推出来的，见 repeat.ts 的 `EBBINGHAUS_GAPS`。
 */
describe('艾宾浩斯重复', () => {
  it('间隔表就是文档里那串累计天数的差：1→2→4→7→15，之后每次 +15', () => {
    // 从「学习那天」出发，一步一步走，累计天数要落在 1/2/4/7/15/30 上
    expect(ebbinghausGap(0)).toBe(1);   // 第 1 天 → 第 2 天
    expect(ebbinghausGap(1)).toBe(2);   // 第 2 天 → 第 4 天
    expect(ebbinghausGap(2)).toBe(3);   // 第 4 天 → 第 7 天
    expect(ebbinghausGap(3)).toBe(8);   // 第 7 天 → 第 15 天
    expect(ebbinghausGap(4)).toBe(15);  // 之后每次 +15
    expect(ebbinghausGap(99)).toBe(15);
  });

  it('step 是脏值（手改文件）时当成 0，不返回 undefined', () => {
    expect(ebbinghausGap(-1)).toBe(1);
    expect(ebbinghausGap(1.5)).toBe(1);
  });

  it('nextOccurrence 按当前 step 算间隔，不看 interval', () => {
    const from = local(2026, 8, 14, 9);
    // interval 故意给个大数：这一档下它没有意义，读了就会算错
    expect(nextOccurrence(R({ every: 'ebbinghaus', step: 0, monthDay: null, interval: 99 }), from)?.toISOString())
      .toBe(local(2026, 8, 15, 9).toISOString());
    expect(nextOccurrence(R({ every: 'ebbinghaus', step: 3, monthDay: null }), from)?.toISOString())
      .toBe(local(2026, 8, 22, 9).toISOString());
  });

  it('完成一次之后 step 往前推一格——不推的话它会永远停在第一个间隔上，变成「每天」', () => {
    const done = task({ status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'ebbinghaus', step: 0, monthDay: null }) });
    const next = nextInstance(done, local(2026, 8, 10, 10))!;
    expect(next.repeat?.step).toBe(1);
    // step 0 的间隔是 1 天
    expect(next.due).toBe(local(2026, 8, 11, 9).toISOString());
  });

  it('走完整条曲线：连续完成六次，累计天数落在 1/2/4/7/15/30 上', () => {
    const start = local(2026, 8, 1, 9);
    let cur = task({ status: 'done', due: start.toISOString(), repeat: R({ every: 'ebbinghaus', step: 0, monthDay: null }) });
    const days: number[] = [];
    for (let i = 0; i < 5; i++) {
      const next = nextInstance(cur, new Date(Date.parse(cur.due!) + 3600_000))!;
      days.push(Math.round((Date.parse(next.due!) - start.getTime()) / 86_400_000) + 1);
      cur = { ...next, status: 'done' };
    }
    // 学习当天是第 1 天，所以后面五次落在 2、4、7、15、30
    expect(days).toEqual([2, 4, 7, 15, 30]);
  });

  it('step 只在艾宾浩斯这一档往前推，别的档位原样不动', () => {
    const done = task({ status: 'done', due: local(2026, 8, 10, 9).toISOString(), repeat: R({ every: 'week', step: 0, monthDay: null }) });
    expect(nextInstance(done, local(2026, 8, 10, 10))!.repeat?.step).toBe(0);
  });
});


/**
 * 跳过本次（仿滴答清单重复任务的「跳过」）。
 *
 * 「下一次落在哪」那套算法跟 `nextInstance` 是同一份（`advance`），上面已经
 * 测透——这里只测**跳过跟完成不一样的地方**：不产生新记录、不盖完成章、
 * 哪些字段留着、哪些重置。
 */
describe('skipPatch', () => {
  const NOW = () => local(2026, 8, 14, 10);
  const daily = (over: Partial<Task> = {}) =>
    task({ due: local(2026, 8, 14, 9).toISOString(), repeat: R({ every: 'day' }), ...over });

  it('挪到下一次，日期跟完成走的是同一套算法', () => {
    const p = skipPatch(daily(), NOW())!;
    expect(localDateStr(new Date(p.due))).toBe('2026-08-15');
  });

  /**
   * **时间段跟着 `due` 一起平移。**
   *
   * 少了这一条，跳过一次会议之后 `due` 走到下周、而 `startAt`/`endAt` 还钉在
   * **刚被跳过的那一周**。`calendarAnchor` 有时间段时按起点落格，于是日历上
   * 那场会仍然画在已经跳过的那次，每跳一次错得更远。实测复现过（走真实的
   * `POST /api/tasks/:id/skip`）：due 到 9/11，startAt/endAt 还是 9/4。
   *
   * `applyTaskPatch` 里那条「只挪 startAt 就补 endAt」的补偿分支救不了——它的
   * 条件是 patch 里得先有 `startAt`，而这个 patch 原来一个都不带。
   */
  it('有时间段的：两端跟着 due 一起走，时长不变', () => {
    const p = skipPatch(task({
      due: local(2026, 9, 4, 12).toISOString(),
      startAt: local(2026, 9, 4, 9).toISOString(),
      endAt: local(2026, 9, 4, 12).toISOString(),
      repeat: R({ every: 'week' }),
    }), local(2026, 9, 3, 9))!;
    expect(new Date(p.startAt!).getDate(), '时间段还钉在被跳过的那一周').toBe(new Date(p.due).getDate());
    expect(Date.parse(p.endAt!) - Date.parse(p.startAt!)).toBe(3 * 3600_000);
  });

  it('没有时间段的：两端是 null，不凭空造一个', () => {
    const p = skipPatch(task({ due: local(2026, 9, 4, 12).toISOString(), repeat: R({ every: 'week' }) }), local(2026, 9, 3, 9))!;
    expect(p.startAt).toBeNull();
    expect(p.endAt).toBeNull();
  });

  it('**不盖完成章、不产生新记录**——这正是它存在的理由：不想做那次跑步，又不愿意为了不断掉打卡去按「完成」', () => {
    const p = skipPatch(daily({ habit: true }), NOW())!;
    // **只钉「不许出现哪几个键」，不写死整份名单。**
    // 写死名单的话，任何一次正当的扩充都会红，而红的表现是「你加的字段不对」
    // ——它真正想守的其实只有下面这两句（不盖完成章、不产生新记录）。
    // 这条曾经把一个缺陷钉住过：`startAt`/`endAt` 该跟着 `due` 一起平移，
    // 补上之后这行断言当场红，看起来像「修错了」。
    for (const forbidden of ['completedAt', 'status']) {
      expect(forbidden in p, `跳过不该动 ${forbidden}`).toBe(false);
    }
    expect('completedAt' in p).toBe(false);
    expect('status' in p).toBe(false);
  });

  it('提醒跟着挪同样的量，章清掉——不清的话挪过去的那条永远不会响', () => {
    const p = skipPatch(daily({
      reminders: [{ at: local(2026, 8, 14, 8).toISOString(), firedAt: '2026-08-14T00:00:00.000Z' }],
    }), NOW())!;
    expect(p.reminders[0].at).toBe(local(2026, 8, 15, 8).toISOString());
    expect(p.reminders[0].firedAt).toBeNull();
  });

  it('勾掉的检查项重置——那两项属于被放弃的那一次', () => {
    const p = skipPatch(daily({ subtasks: [{ text: '拉数据', done: true }] }), NOW())!;
    expect(p.subtasks).toEqual([{ text: '拉数据', done: false }]);
  });

  it('次数减一：一门上五次的课，翘掉一次也还是在那五个日子里结束', () => {
    expect(skipPatch(daily({ repeat: R({ count: 3 }) }), NOW())!.repeat.count).toBe(2);
  });

  it('次数用完了就跳不动——跟完成一样，不该凭空多出一次', () => {
    expect(skipPatch(daily({ repeat: R({ count: 0 }) }), NOW())).toBeNull();
  });

  it('艾宾浩斯的步数往前走一格，按下一档间隔排', () => {
    const p = skipPatch(daily({ repeat: R({ every: 'ebbinghaus', step: 0, monthDay: null }) }), NOW())!;
    expect(p.repeat.step).toBe(1);
  });

  it('不重复的任务跳不了', () => {
    expect(skipPatch(task({ due: local(2026, 8, 14, 9).toISOString() }), NOW())).toBeNull();
  });

  it('没有 due 的重复任务跳不了——屏幕上不会有任何东西变，一个点了看不出发生什么的入口比没有更糟', () => {
    expect(skipPatch(task({ repeat: R({ every: 'day' }) }), NOW())).toBeNull();
  });

  it('过了 until 就跳不动，不会画出一次永远不会到的日期', () => {
    expect(skipPatch(daily({ repeat: R({ until: local(2026, 8, 14, 23).toISOString() }) }), NOW())).toBeNull();
  });

  it('拖过好几个周期的，一次跳到「现在之后」的那一次，不落在过去', () => {
    const p = skipPatch(task({
      due: local(2026, 7, 20, 9).toISOString(), repeat: R({ every: 'day' }),
    }), NOW())!;
    expect(localDateStr(new Date(p.due))).toBe('2026-08-15');
  });
});

/**
 * 「开始时间」在重复任务上的表现。**跟提醒一样整体平移**——不平移的话每一次
 * 实例都背着上一次的开始时间，那个时刻早就过去了，「还没开始」这个记号从第二
 * 次起再也不出现，字段等于只在第一条上有效。
 *
 * 这一族是照着 `estimateMinutes` 当初被漏掉的那条路补的：`nextInstance` 用
 * `...done` 展开，新字段默认就是「原样带过去」，而原样对时间类字段几乎总是错的。
 */
describe('nextInstance：startAt 跟着平移', () => {
  const DONE = new Date('2026-09-15T10:00:00.000Z');

  it('每周重复：开始时间往后挪一周，跟 due 挪同样的量', () => {
    const t = task({
      title: '每周报销',
      due: '2026-09-15T10:00:00.000Z',
      startAt: '2026-09-10T01:00:00.000Z',
      repeat: { every: 'week', interval: 1, weekdays: [], monthDay: null, count: null, until: null, from: 'due', step: 0 },
    });
    const next = nextInstance(t, DONE)!;
    const deltaDue = Date.parse(next.due!) - Date.parse(t.due!);
    const deltaStart = Date.parse(next.startAt!) - Date.parse(t.startAt!);
    expect(deltaStart).toBe(deltaDue);
    expect(next.startAt).toBe('2026-09-17T01:00:00.000Z');
  });

  it('没设开始时间的原样是 null——不凭空长出一个', () => {
    const t = task({
      title: '每周报销',
      due: '2026-09-15T10:00:00.000Z',
      startAt: null,
      repeat: { every: 'week', interval: 1, weekdays: [], monthDay: null, count: null, until: null, from: 'due', step: 0 },
    });
    expect(nextInstance(t, DONE)!.startAt).toBeNull();
  });

  it('开始时间解析不了就原样带过去，不抛也不印 Invalid Date', () => {
    const t = task({
      title: '每周报销',
      due: '2026-09-15T10:00:00.000Z',
      startAt: '下周三',
      repeat: { every: 'week', interval: 1, weekdays: [], monthDay: null, count: null, until: null, from: 'due', step: 0 },
    });
    expect(nextInstance(t, DONE)!.startAt).toBe('下周三');
  });
});


/**
 * **结构性守卫：`Task` 加了新字段，这里必须做一次决定。**
 *
 * `nextInstance` 是「展开 `...done` 再覆写几个」的写法，好处是短，代价是
 * **新字段默认被带过去，而不带过去才是对的那些会静静漏掉**。已经漏两次：
 *
 * - `estimateMinutes`：反过来的漏——`duplicate.ts` 当时没跟上，副本丢了预估；
 * - `attachments`：这一次。上周那份报告的 PDF 被带给了下一条，而附件按任务 id
 *   分目录存，新实例那个目录是空的——盘上那条任务在声称一份它没有的附件。
 *
 * 形式跟 `web/src/lib/duplicate.ts` 的 COPIED/DROPPED 守卫一样：两张名单加起来必须
 * 恰好是 `Task` 的全部字段，不重不漏。**只在测试里，不重构产品代码**：把
 * `nextInstance` 改成逐字段列举会是一个大得多、也危险得多的 diff。
 */
describe('nextInstance：字段归属的结构性守卫', () => {
  /** 每个字段都给**非默认值**，否则「带过去」和「重置」分不开。 */
  const full = (): Task => task({
    id: 'old-1', title: '写周报', notes: '记得附上图',
    status: 'done', due: '2026-09-01T01:00:00.000Z', startAt: '2026-08-31T01:00:00.000Z',
    endAt: '2026-08-31T04:00:00.000Z', persistentReminder: true,
    reminders: [{ at: '2026-09-01T00:00:00.000Z', firedAt: '2026-09-01T00:00:01.000Z' }],
    subtasks: [{ text: '拉数据', done: true }],
    source: 'ai', aiComment: '拆解时的记录',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
    order: 5, listId: 'L1', tags: ['工作'], priority: 3,
    repeat: R({ every: 'week', count: 4 }),
    completedAt: '2026-09-01T02:00:00.000Z', postponeCount: 2,
    waitingFor: '等张老师', context: 'computer',
    attachments: ['上周的.pdf'], estimateMinutes: 45,
    focusSessions: [{ startedAt: '2026-09-01T00:30:00.000Z', minutes: 25 }],
    habit: true, pinned: true, parentId: 'p1', section: '第一阶段',
    reviewedAt: '2026-08-30T00:00:00.000Z',
  });

  /** 新实例上**不一样**的（重置、平移、重新生成）。 */
  const RESET = [
    'id', 'due', 'startAt', 'reminders', 'subtasks', 'repeat', 'status',
    'completedAt', 'postponeCount', 'focusSessions', 'attachments', 'order',
    'createdAt', 'updatedAt', 'reviewedAt', 'endAt',
  ] as const;

  /** 新实例上**原样带过去**的。 */
  const CARRIED = [
    'title', 'notes', 'source', 'aiComment', 'listId', 'section', 'tags', 'priority', 'persistentReminder',
    'waitingFor', 'context', 'estimateMinutes', 'habit', 'pinned', 'parentId',
  ] as const;

  const at = () => local(2026, 9, 1, 10);

  it('两张名单加起来恰好是 Task 的全部字段，不重不漏', () => {
    expect([...RESET, ...CARRIED].sort()).toEqual(Object.keys(full()).sort());
  });

  it('CARRIED 里的每一个都原样带过去了', () => {
    const before = full();
    const next = nextInstance(before, at())!;
    for (const k of CARRIED) {
      expect(next[k], `${k} 本该原样带过去`).toEqual(before[k]);
    }
  });

  it('RESET 里的每一个都真的变了——夹具每个字段都是非默认值，变不变分得开', () => {
    const before = full();
    const next = nextInstance(before, at())!;
    for (const k of RESET) {
      expect(next[k], `${k} 本该重置/平移`).not.toEqual(before[k]);
    }
  });

  it('附件清空，不是带上上一条的——附件按任务 id 分目录存，新 id 那个目录是空的', () => {
    expect(nextInstance(full(), at())!.attachments).toEqual([]);
  });
});

/**
 * **农历重复 / 法定工作日 / 法定节假日**——仿滴答清单，出处在
 * 《设置重复任务》。数据来自 `chinese-days`，访问层是
 * `chineseDays.ts`（那儿写着为什么农历没有年份边界、而节假日有）。
 */
const rule = (over: Partial<Repeat>): Repeat => ({
  every: 'day', interval: 1, weekdays: [], until: null, from: 'due', count: null, step: 0, monthDay: null, ...over,
});
const nextStr = (r: Repeat, from: Date) => {
  const n = nextOccurrence(r, from);
  return n === null ? null : localDateStr(n);
};

describe('nextOccurrence：农历每年 / 每月', () => {
  // 农历八月十五（中秋）：2026 年落在公历 9/25，2027 年落在 9/15。
  it('农历每年：中秋跟着农历走，不是公历同一天', () => {
    expect(nextStr(rule({ every: 'lunar-year' }), local(2026, 9, 25))).toBe('2027-09-15');
  });

  it('农历每月：初一到下一个初一', () => {
    // 2026-09-11 是农历七月三十…用初一更稳：先确认基准那天的农历。
    const first = nextStr(rule({ every: 'lunar-month' }), local(2026, 9, 25));
    // 八月十五 → 九月十五，公历 10/24。
    expect(first).toBe('2026-10-24');
  });

  it('农历每月跨年：腊月 + 1 落到下一个农历年的正月', () => {
    // 2027-01-08 是农历腊月初一 → 下一个是正月初一（2027 春节 2/6）。
    const got = nextStr(rule({ every: 'lunar-month' }), local(2027, 1, 8));
    expect(got).toBe('2027-02-06');
  });

  /**
   * **月小的那年截到廿九，而且锚点记得住。**
   * `getSolarDateFromLunar('2027-09-30')` 不报错，它会安静地滚到十月初一——
   * 不做往返验证的话，一条「农历九月三十」的重复会漂进十月，此后再也回不来。
   */
  it('农历九月三十：小月那年截到廿九，不滚进十月', () => {
    const got = nextStr(rule({ every: 'lunar-year', monthDay: 30 }), local(2026, 11, 8));
    // 2026 农历九月三十 = 公历 11/8；2027 年九月只有廿九天。
    expect(got).not.toBeNull();
    expect(got).toBe('2027-10-28');   // 2027 农历九月廿九
  });

  it('时刻不动——这一档只换日期', () => {
    const n = nextOccurrence(rule({ every: 'lunar-year' }), local(2026, 9, 25, 14, 30));
    expect([n!.getHours(), n!.getMinutes()]).toEqual([14, 30]);
  });
});

describe('nextOccurrence：法定工作日 / 法定节假日', () => {
  it('工作日：周五的下一个是周一', () => {
    // 2026-08-21 周五 → 08-24 周一
    expect(nextStr(rule({ every: 'workday' }), local(2026, 8, 21))).toBe('2026-08-24');
  });

  it('工作日：跨过国庆整段假期', () => {
    // 2026-09-30 周三是上班日，下一个上班日要跳过 10/1–10/7 的假期
    const got = nextStr(rule({ every: 'workday' }), local(2026, 9, 30));
    expect(got).not.toBe('2026-10-01');
    expect(Date.parse(got!)).toBeGreaterThan(Date.parse('2026-10-05'));
  });

  it('工作日：调休补班那天算工作日', () => {
    // 2026-10-10 是周六，但放假通知要求补班
    expect(nextStr(rule({ every: 'workday' }), local(2026, 10, 9))).toBe('2026-10-10');
  });

  it('节假日：普通周六周日不算——那是「每周末」，另一档', () => {
    // 2026-08-21 周五的下一个「法定节假日」不该是 8/22 周六
    const got = nextStr(rule({ every: 'holiday' }), local(2026, 8, 21));
    expect(got).not.toBe('2026-08-22');
    // 下一个被放假通知点名的日子是中秋（农历八月十五，2026 年落在 9/25），
    // 不是国庆——这条顺带交叉印证了上面农历那一族的换算。
    expect(got).toBe('2026-09-25');
  });

  it('interval 数的是命中的天数，不是日历天', () => {
    const one = nextStr(rule({ every: 'workday', interval: 1 }), local(2026, 8, 21));
    const three = nextStr(rule({ every: 'workday', interval: 3 }), local(2026, 8, 21));
    expect(one).toBe('2026-08-24');
    expect(three).toBe('2026-08-26');
  });

  /**
   * **走出表就收工。** 放假通知是发布出来的，表到哪年为止就只能排到哪年；
   * `chinese-days` 对表外的日期一律答「要上班」，照它往下排会把下一年的国庆
   * 安静地排成工作日。宁可让这条重复结束。
   */
  it('表覆盖不到的年份：返回 null，这条重复到此为止', () => {
    expect(nextStr(rule({ every: 'workday' }), local(2035, 3, 3))).toBeNull();
    expect(nextStr(rule({ every: 'holiday' }), local(2035, 3, 3))).toBeNull();
  });
});

/**
 * **`REPEAT_KINDS`（运行时名单）和 `RepeatKind`（类型）必须是同一个集合。**
 *
 * TS 没有「这个数组必须穷举这个联合」的原生断言：`satisfies readonly RepeatKind[]`
 * 只挡住「多写了一个不存在的档」，**挡不住少写**。而少写的后果精确到一句话——
 * 类型上选得出来、校验器不认，表现是「界面里点得了、保存回来 400」。
 *
 * 这条把两边的**个数**钉死。加一档时它会红，提醒你去 `REPEAT_KINDS` 补上。
 */
describe('重复档位：名单和类型同源', () => {
  it('每一档都能通过校验——名单里没有一个是校验器不认的', () => {
    for (const every of REPEAT_KINDS) {
      expect(sanitizeTaskPatch({ repeat: { ...rule({}), every } }), every).not.toBeNull();
    }
  });

  it('名单外的档位一律拒收', () => {
    expect(sanitizeTaskPatch({ repeat: { ...rule({}), every: 'fortnight' } })).toBeNull();
  });

  it('名单有九档——加一档没在这儿改，说明 REPEAT_KINDS 或类型有一边没跟上', () => {
    // 这个数字本身没有意义，它的作用是**强制你在加档时来这儿看一眼**：
    // 类型加了、名单没加（或者反过来）时，上面两条都可能照样绿。
    expect(REPEAT_KINDS).toHaveLength(9);
    expect(new Set(REPEAT_KINDS).size).toBe(REPEAT_KINDS.length);
  });
});

/**
 * **时间段跟着一起平移。** 一场每周九点到十二点的会，下一条也该是九点到
 * 十二点——`endAt` 不平移的话新实例会背着上一次的结束时刻，时间段整个错位
 * （而且时长会变，因为 `startAt` 平移了、`endAt` 没有）。
 */
describe('nextInstance：时间段两端平移同样的量', () => {
  it('startAt / endAt 一起挪，时长不变', () => {
    const done = task({
      status: 'done',
      due: '2026-09-01T01:00:00.000Z',
      startAt: '2026-09-01T01:00:00.000Z',
      endAt: '2026-09-01T04:00:00.000Z',
      repeat: rule({ every: 'week' }),
    });
    const next = nextInstance(done, new Date('2026-09-01T05:00:00.000Z'))!;
    const span = (t: { startAt: string | null; endAt: string | null }) =>
      Date.parse(t.endAt!) - Date.parse(t.startAt!);
    expect(span(next)).toBe(span(done));
    // 而且真的往后挪了一周，不是原样带过去。
    expect(Date.parse(next.startAt!)).toBeGreaterThan(Date.parse(done.startAt!));
  });

  it('只有 startAt、没有 endAt：endAt 还是 null，不凭空长出一个结束时刻', () => {
    const done = task({
      status: 'done', due: '2026-09-01T01:00:00.000Z',
      startAt: '2026-09-01T01:00:00.000Z', endAt: null, repeat: rule({ every: 'week' }),
    });
    expect(nextInstance(done, new Date('2026-09-01T05:00:00.000Z'))!.endAt).toBeNull();
  });

  it('endAt 解析不出来：原样带过去，不抛也不吃掉', () => {
    const done = task({
      status: 'done', due: '2026-09-01T01:00:00.000Z',
      startAt: '2026-09-01T01:00:00.000Z', endAt: '下周三', repeat: rule({ every: 'week' }),
    });
    expect(nextInstance(done, new Date('2026-09-01T05:00:00.000Z'))!.endAt).toBe('下周三');
  });
});
