import { describe, expect, it } from 'vitest';
import type { Task } from '../types.js';
import { planNotifications, toNotificationSchema } from './notifyPlan.js';

// 全量 Task 工厂——跟 App.test.tsx 的 task() 同形状，就地一份。
function mk(patch: Partial<Task> & { id: string }): Task {
  return {
    title: `任务 ${patch.id}`, notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [],
    persistentReminder: false,
    subtasks: [], source: 'user', aiComment: '', createdAt: '2026-08-30T09:17:00+08:00',
    updatedAt: '2026-08-30T09:17:00+08:00', order: null, listId: null, section: null, tags: [],
    priority: 0, repeat: null, completedAt: null, postponeCount: 0, waitingFor: null, context: null,
 attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...patch,
  };
}

// 固定「现在」：2026-09-03 21:47 北京时间。显式偏移让两个时区档（Asia/Shanghai
// 和 UTC）算出同一个时间轴；时刻特意都不是整点，避开「恰好等于默认值/巧合值」。
const NOW = new Date('2026-09-03T21:47:00+08:00');
const r = (at: string) => ({ at, firedAt: null });

describe('planNotifications——排哪些', () => {
  it('done/later/abandoned 不排；todo/doing 排（了结过的三种都是他已经做过的判断，服务端 dueTasks 同一条规矩）', () => {
    const tasks = [
      mk({ id: 'a', status: 'done', reminders: [r('2026-09-04T08:13:00+08:00')] }),
      mk({ id: 'b', status: 'later', reminders: [r('2026-09-04T08:13:00+08:00')] }),
      // 放弃的原来会排——这一行漏了它，一条明确决定不做的任务照样在提醒时刻
      // 弹出来。服务端那条同源判断（reminder.ts 的 isDue）用的一直是 isSettled。
      mk({ id: 'x', status: 'abandoned', reminders: [r('2026-09-04T08:13:00+08:00')] }),
      mk({ id: 'c', status: 'doing', reminders: [r('2026-09-04T08:13:00+08:00')] }),
    ];
    expect(planNotifications(tasks, NOW).planned.map((p) => p.taskId)).toEqual(['c']);
  });

  it('只排未来：过去的、恰好等于 now 的都不排——方向跟服务端 isDue（at <= now）相反，防重复响的就是这条', () => {
    const tasks = [mk({ id: 'a', reminders: [
      r('2026-09-03T21:46:00+08:00'),          // 过去一分钟
      r('2026-09-03T21:47:00+08:00'),          // 恰好 now，边界：不排
      r('2026-09-03T21:48:00+08:00'),          // 未来一分钟：排
    ] })];
    const { planned } = planNotifications(tasks, NOW);
    expect(planned).toHaveLength(1);
    expect(planned[0].at.getTime()).toBe(Date.parse('2026-09-03T21:48:00+08:00'));
  });

  it('firedAt 非空的未来提醒不排——时间在未来却标成发过，按数据模型不该存在，只可能手改文件造出来，跳过比替它响一声安全', () => {
    const tasks = [mk({ id: 'a', reminders: [
      { at: '2026-09-04T10:26:00+08:00', firedAt: '2026-09-01T08:00:00+08:00' },
    ] })];
    expect(planNotifications(tasks, NOW).planned).toHaveLength(0);
  });

  it('解析不出来的 at（手改文件写了「下周三」）显式跳过，不炸也不排', () => {
    const tasks = [mk({ id: 'a', reminders: [r('下周三'), r('2026-09-05T07:26:00+08:00')] })];
    expect(planNotifications(tasks, NOW).planned).toHaveLength(1);
  });

  it('同一条任务多个未来提醒各排一条', () => {
    const tasks = [mk({ id: 'a', reminders: [r('2026-09-04T08:13:00+08:00'), r('2026-09-04T20:41:00+08:00')] })];
    expect(planNotifications(tasks, NOW).planned).toHaveLength(2);
  });
});

describe('planNotifications——排多少（窗口两半都要断言，153 的教训）', () => {
  // limit 特意用 3，不用默认 32——夹具等于默认值时「传对了」和「传漏了」
  // 长得一模一样（141）。夹具全是未来提醒：这一档只制造 planned/overflow
  // 两半，一条过去的都不掺，免得 missed 的断言跟这里互相遮住。
  it('按时间近的取前 limit 条，id 是批内序号 1..N（输入顺序特意打乱，逼真排序）', () => {
    const tasks = [
      mk({ id: 'late',  reminders: [r('2026-09-06T09:31:00+08:00')] }),
      mk({ id: 'first', reminders: [r('2026-09-04T06:13:00+08:00')] }),
      mk({ id: 'cut',   reminders: [r('2026-09-07T11:52:00+08:00')] }),
      mk({ id: 'mid',   reminders: [r('2026-09-05T18:24:00+08:00')] }),
      mk({ id: 'cut2',  reminders: [r('2026-09-08T15:09:00+08:00')] }),
    ];
    const { planned, overflow } = planNotifications(tasks, NOW, 3);
    expect(planned.map((p) => p.taskId)).toEqual(['first', 'mid', 'late']);  // 排了的这半
    expect(planned.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(overflow).toBe(2);                                                // 没排上的这半
  });

  it('没超窗口时 overflow 是 0——「什么都没切掉」这一格也要有数', () => {
    const tasks = [mk({ id: 'a', reminders: [r('2026-09-04T08:13:00+08:00')] })];
    expect(planNotifications(tasks, NOW, 3).overflow).toBe(0);
  });

  it('默认 limit 是 32', () => {
    // 33 条未来提醒，分钟数从非整点起步、步长 7，避开整点巧合。用 33 不用 32：
    // 夹具刚好等于上限时，「切在 32」和「压根没切」长得一模一样。
    const reminders = Array.from({ length: 33 }, (_, i) =>
      r(new Date(Date.parse('2026-09-04T09:03:00+08:00') + i * 7 * 60_000).toISOString()));
    const { planned, overflow } = planNotifications([mk({ id: 'a', reminders })], NOW);
    expect(planned).toHaveLength(32);
    expect(overflow).toBe(1);
  });
});

// 第三半。overflow 数的是「未来的、被窗口切掉的」，数不出「到点了而谁都没发过」
// 的那些——两个数各管各的，各自要有断言、各自要有变异（153）。
describe('planNotifications——错过的那半（missed）', () => {
  it('时间已过、firedAt 还空着的：不排，但数得出来（离线期间错过的那类，Task 4 拿它做界面提示）', () => {
    const tasks = [mk({ id: 'a', reminders: [
      r('2026-09-02T07:19:00+08:00'),
      r('2026-09-03T13:38:00+08:00'),
    ] })];
    const { planned, overflow, missed } = planNotifications(tasks, NOW, 3);
    expect(planned).toHaveLength(0);
    expect(overflow).toBe(0);
    expect(missed).toBe(2);
  });

  it('没有过去的提醒时 missed 是 0——「什么都没错过」这一格也要有数', () => {
    const tasks = [mk({ id: 'a', reminders: [r('2026-09-04T08:13:00+08:00')] })];
    expect(planNotifications(tasks, NOW, 3).missed).toBe(0);
  });

  it('done 的过去提醒不算错过——做完了就不是「没人管」', () => {
    const tasks = [mk({ id: 'a', status: 'done', reminders: [r('2026-09-02T07:19:00+08:00')] })];
    expect(planNotifications(tasks, NOW, 3).missed).toBe(0);
  });

  it('later 的过去提醒不算错过——搁置的意图就是暂时不想看见它', () => {
    const tasks = [mk({ id: 'a', status: 'later', reminders: [r('2026-09-02T07:19:00+08:00')] })];
    expect(planNotifications(tasks, NOW, 3).missed).toBe(0);
  });

  it('abandoned 的过去提醒也不算错过——「决定不做」比「搁置」更彻底，没有道理反而算他错过了一条', () => {
    const tasks = [mk({ id: 'a', status: 'abandoned', reminders: [r('2026-09-02T07:19:00+08:00')] })];
    expect(planNotifications(tasks, NOW, 3).missed).toBe(0);
  });

  it('firedAt 盖过章的过去提醒不算错过——那是真发过了', () => {
    const tasks = [mk({ id: 'a', reminders: [
      { at: '2026-09-02T07:19:00+08:00', firedAt: '2026-09-02T07:19:03+08:00' },
    ] })];
    expect(planNotifications(tasks, NOW, 3).missed).toBe(0);
  });

  it('解析不出来的 at 既不排也不算错过——「NaN 比较恒 false」只兜得住 planned 那半，兜不住这半', () => {
    // planned 那半就算把 !Number.isNaN 那道拆了也照样是 0（NaN > now 恒 false），
    // 这条是唯一按得住那道守卫的断言：拆了它 NaN 就掉进 missed 里当成「错过一条」。
    const tasks = [mk({ id: 'a', reminders: [r('下周三')] })];
    const { planned, missed } = planNotifications(tasks, NOW, 3);
    expect(planned).toHaveLength(0);
    expect(missed).toBe(0);
  });
});

describe('planNotifications——三半互不串', () => {
  it('planned / overflow / missed 同时非零，各数各的', () => {
    const tasks = [
      mk({ id: 'f1', reminders: [r('2026-09-04T06:13:00+08:00')] }),
      mk({ id: 'f2', reminders: [r('2026-09-05T18:24:00+08:00')] }),
      mk({ id: 'f3', reminders: [r('2026-09-06T09:31:00+08:00')] }),
      mk({ id: 'm1', reminders: [r('2026-09-01T19:22:00+08:00')] }),
      mk({ id: 'm2', reminders: [r('2026-09-02T08:47:00+08:00')] }),
    ];
    const { planned, overflow, missed } = planNotifications(tasks, NOW, 2);
    expect(planned.map((p) => p.taskId)).toEqual(['f1', 'f2']);
    expect(overflow).toBe(1);
    expect(missed).toBe(2);
  });
});

describe('planNotifications——文案（三格：due / notes / 兜底，形状抄服务端 toast()）', () => {
  it('有 due：截止 + 本地格式；title 是任务标题', () => {
    const tasks = [mk({ id: 'a', title: '交水电费', due: '2026-09-05T12:00:00+08:00', startAt: null, reminders: [r('2026-09-04T08:13:00+08:00')] })];
    const p = planNotifications(tasks, NOW).planned[0];
    expect(p.title).toBe('交水电费');
    // 不断言完整格式化串——toLocaleString 的输出随运行时区变，两个时区档都要绿。
    expect(p.body.startsWith('截止 ')).toBe(true);
  });

  it('没 due 有 notes：body 是 notes', () => {
    const tasks = [mk({ id: 'a', notes: '带上上个月的单子', reminders: [r('2026-09-04T08:13:00+08:00')] })];
    expect(planNotifications(tasks, NOW).planned[0].body).toBe('带上上个月的单子');
  });

  it('都没有：兜底「该做这件事了」', () => {
    const tasks = [mk({ id: 'a', reminders: [r('2026-09-04T08:13:00+08:00')] })];
    expect(planNotifications(tasks, NOW).planned[0].body).toBe('该做这件事了');
  });
});

describe('toNotificationSchema——插件参数形状', () => {
  it('id/title/body 原样过去，schedule.at 是那个 Date，allowWhileIdle 开着（Doze 下也要响）', () => {
    const at = new Date('2026-09-04T08:13:00+08:00');
    const s = toNotificationSchema({ id: 7, taskId: 'x', title: '交水电费', body: '该做这件事了', at });
    expect(s.id).toBe(7);
    expect(s.title).toBe('交水电费');
    expect(s.body).toBe('该做这件事了');
    expect(s.schedule?.at).toBe(at);
    expect(s.schedule?.allowWhileIdle).toBe(true);
  });
});
