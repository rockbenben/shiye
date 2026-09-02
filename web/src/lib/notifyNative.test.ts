import type { PermissionState } from '@capacitor/core';
import type { LocalNotificationSchema } from '@capacitor/local-notifications';
import { describe, expect, it } from 'vitest';
import type { Task } from '../types.js';
import { isNativeShell, rescheduleLocalNotifications, type NotifyPort } from './notifyNative.js';
// （nativePort 特意不 import——这些测试一次都不该碰真插件。）

describe('isNativeShell——「只在原生壳里排」的判据', () => {
  // 这条守的是负半：「桌面/浏览器不排」。jsdom/node 里 getPlatform() 是
  // 'web'——这不是测试环境的将就，Electron 的 platform 恰好也是 'web'，
  // 这一格就是真实的桌面场景。它还顺带守住「不许把判据改成单用
  // isPluginAvailable」：这个插件带 web 实现，import 即注册，单用它在
  // 这里会翻成 true、这条测试变红。
  // 正半（真机上恒 true、真的会排）在 jsdom 里装不出来（没有
  // androidBridge），只能真机验——android/冒烟清单.md 第 9 步，不在这里装覆盖。
  it('web 平台（测试环境 = Electron/浏览器同一格）恒 false', () => {
    expect(isNativeShell()).toBe(false);
  });
});

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

const NOW = new Date('2026-09-03T21:47:00+08:00');
const future = (at: string) => ({ at, firedAt: null });
const TASKS = [
  mk({ id: 'a', reminders: [future('2026-09-04T08:13:00+08:00')] }),
  mk({ id: 'b', reminders: [future('2026-09-05T18:24:00+08:00')] }),
];

/**
 * 调用日志式假 port：断言的不只是「调了没有」，还有顺序（先取消后排）。
 *
 * `sent` 收的是**整份 schema**，不是从里面挑几个字段（复审 C2）：只记 `n.id`
 * 的话，`schedule: { at, allowWhileIdle }` 这整个字段过这道接缝时一条断言都没有
 * ——把它整个删掉照样全绿、`tsc` 也零错误（`LocalNotificationSchema.schedule`
 * 是可选的）。而真机上 `schedule == null` 走的是 `LocalNotification.kt`
 * `isScheduled()` 为假那条路，`LocalNotificationManager.kt` 直接
 * `notificationManager.notify(...)`：**32 条通知当场轰进通知栏，到点一条不响**。
 * `toNotificationSchema` 自己的单测（notifyPlan.test.ts）挡不住这个——它验的是
 * 纯函数，出事的接缝在这一层的编排里。
 */
function fakePort(over: Partial<NotifyPort> = {}): { port: NotifyPort; calls: string[]; sent: LocalNotificationSchema[] } {
  const calls: string[] = [];
  const sent: LocalNotificationSchema[] = [];
  const port: NotifyPort = {
    available: () => true,
    checkPermission: async () => { calls.push('check'); return 'granted' as PermissionState; },
    requestPermission: async () => { calls.push('request'); return 'granted' as PermissionState; },
    // 精确闹钟这一问不进 calls：它是只读的（不弹任何东西，见 NotifyPort 上的
    // 出处），调用顺序没什么可守的，进了 calls 反而要把上面每条断言重写一遍。
    // 它真正要按住的是「排出来的那批精确不精确」，那两条断言在 schema 上。
    exactPermission: async () => 'granted' as PermissionState,
    pendingIds: async () => { calls.push('pending'); return []; },
    cancel: async (ids) => { calls.push(`cancel:${ids.join(',')}`); },
    schedule: async (ns) => { sent.push(...ns); calls.push(`schedule:${ns.map((n) => n.id).join(',')}`); },
    ...over,
  };
  return { port, calls, sent };
}

describe('rescheduleLocalNotifications——编排', () => {
  it('不在原生壳里：返回 not-native，一个 port 方法都不碰（桌面 Electron 落这一格）', async () => {
    const { port, calls } = fakePort({ available: () => false });
    expect(await rescheduleLocalNotifications(TASKS, NOW, port)).toBe('not-native');
    expect(calls).toEqual([]);
  });

  it('权限 prompt：先问系统（requestPermissions 弹安卓 13 的对话框），给了就往下走', async () => {
    const { port, calls } = fakePort({
      checkPermission: async () => { calls.push('check'); return 'prompt' as PermissionState; },
    });
    expect(await rescheduleLocalNotifications(TASKS, NOW, port)).toBe('ok');
    expect(calls.slice(0, 2)).toEqual(['check', 'request']);
  });

  it('权限 prompt → 用户当场拒了：返回 denied，不取消不排', async () => {
    const { port, calls } = fakePort({
      checkPermission: async () => { calls.push('check'); return 'prompt' as PermissionState; },
      requestPermission: async () => { calls.push('request'); return 'denied' as PermissionState; },
    });
    expect(await rescheduleLocalNotifications(TASKS, NOW, port)).toBe('denied');
    expect(calls).toEqual(['check', 'request']);
  });

  it('早就 denied：不再弹对话框骚扰（安卓拒过之后 request 也只会静默返回 denied），直接报 denied', async () => {
    const { port, calls } = fakePort({
      checkPermission: async () => { calls.push('check'); return 'denied' as PermissionState; },
    });
    expect(await rescheduleLocalNotifications(TASKS, NOW, port)).toBe('denied');
    expect(calls).toEqual(['check']);
  });

  it('整体重排：先取消 getPending 报的那些（id 现查现删，不重算），后排新一批，顺序不许反', async () => {
    const { port, calls, sent } = fakePort({
      pendingIds: async () => { calls.push('pending'); return [7, 9]; },
    });
    expect(await rescheduleLocalNotifications(TASKS, NOW, port)).toBe('ok');
    expect(calls).toEqual(['check', 'pending', 'cancel:7,9', 'schedule:1,2']);
    // 交给插件的是**整份 schema，逐字段钉死**（复审 C2，理由见 fakePort 上面）。
    // `toEqual` 在这里恰好也按得住「整个 schedule 字段没了」：期望这一侧写着
    // 一个对象，收到 undefined 就是不等。
    expect(sent).toEqual([
      {
        id: 1, title: '任务 a', body: '该做这件事了', isExactNotification: true,
        schedule: { at: new Date('2026-09-04T08:13:00+08:00'), allowWhileIdle: true },
      },
      {
        id: 2, title: '任务 b', body: '该做这件事了', isExactNotification: true,
        schedule: { at: new Date('2026-09-05T18:24:00+08:00'), allowWhileIdle: true },
      },
    ]);
  });

  it('零条可排：取消照跑（昨天排的、今天任务做完了的那条必须清掉），schedule 一次不调——「什么都没发生」这一格', async () => {
    // 把「有东西可排」这道守卫从场景里拿掉（150）：全部任务已完成。
    const done = [mk({ id: 'a', status: 'done', reminders: [future('2026-09-04T08:13:00+08:00')] })];
    const { port, calls } = fakePort({
      pendingIds: async () => { calls.push('pending'); return [3]; },
    });
    expect(await rescheduleLocalNotifications(done, NOW, port)).toBe('ok');
    expect(calls).toEqual(['check', 'pending', 'cancel:3']);
  });

  it('没有旧的可取消：cancel 也不调（不拿空数组去烦插件）', async () => {
    const { port, calls } = fakePort();
    expect(await rescheduleLocalNotifications(TASKS, NOW, port)).toBe('ok');
    expect(calls).toEqual(['check', 'pending', 'schedule:1,2']);
  });

  // 精确闹钟两格。收集的是真的交给插件的那批 schema 上的 isExactNotification
  // ——**断言 true/false 而不是「有没有设」**：这个字段默认就是 true，
  // 「没设」和「设了 true」在插件那边一模一样，只断言「设了」等于没断言。
  const exactness = async (over: Partial<NotifyPort>): Promise<(boolean | undefined)[]> => {
    let seen: (boolean | undefined)[] = [];
    const { port } = fakePort({ ...over, schedule: async (ns) => { seen = ns.map((n) => n.isExactNotification); } });
    expect(await rescheduleLocalNotifications(TASKS, NOW, port)).toBe('ok');
    return seen;
  };

  it('精确闹钟给了：这一批排精确（isExactNotification true）', async () => {
    expect(await exactness({})).toEqual([true, true]);
  });

  it('精确闹钟没给：显式排成不精确（false，不是「不设这个字段」）——默认 true 会让插件每次重排都把人弹进系统「闹钟和提醒」设置页', async () => {
    expect(await exactness({ exactPermission: async () => 'denied' as PermissionState })).toEqual([false, false]);
  });

  it('精确闹钟这一问抛了：cancel 一次都没调过——失败态得是「什么都没动」，不能是「旧的全取消了、新的一条没排」', async () => {
    const { port, calls } = fakePort({
      exactPermission: async () => { throw new Error('拿不到 AlarmManager'); },
      pendingIds: async () => { calls.push('pending'); return [7, 9]; },
    });
    await expect(rescheduleLocalNotifications(TASKS, NOW, port)).rejects.toThrow('拿不到 AlarmManager');
    // 不只是「没 cancel」——schedule 也没调，旧通知原封不动躺在系统里，
    // 下一次 reload() 重排就恢复了。这一条按住的是 exactPermission 的位置。
    expect(calls).toEqual(['check', 'pending']);
  });

  // Task 2 复审转交的那条：排序稳定性的风险源在**调用方**。planNotifications
  // 内部是确定的（V8 稳定排序 + 全程原序遍历），但两条提醒时刻**完全相同**时，
  // 「谁排在前、谁被 32 的窗口切掉」完全由传进来的 tasks 顺序决定——而这一层
  // 拿到的顺序真的不稳，理由在实现里那段注释。真机上的表现是「有时候提醒得到
  // 有时候提醒不到」，这条测试是唯一按得住它的地方。
  it('输入顺序打乱两次，排出来的一模一样——提醒时刻完全相同时「谁被窗口切掉」不许随输入顺序变', async () => {
    // 33 条任务、提醒时刻一模一样：排序键分不开它们，只剩输入顺序决定谁进前 32。
    const same = future('2026-09-04T08:13:00+08:00');
    const many = Array.from({ length: 33 }, (_, i) =>
      mk({ id: `t${String(i + 1).padStart(2, '0')}`, reminders: [same] }));
    // 断言的是真的交给插件的那一批（编号 + 是哪条任务），不是「调了 schedule」。
    const run = async (order: Task[]): Promise<string[]> => {
      let seen: string[] = [];
      const { port } = fakePort({ schedule: async (ns) => { seen = ns.map((n) => `${n.id}:${n.title}`); } });
      expect(await rescheduleLocalNotifications(order, NOW, port)).toBe('ok');
      return seen;
    };
    const a = await run([...many].reverse());
    const b = await run([...many.filter((_, i) => i % 2 === 1), ...many.filter((_, i) => i % 2 === 0)]);
    expect(a).toEqual(b);
    // 不止「两次一致」——钉死是哪 32 条、编号怎么发（按 id 定序，被切掉的是 t33）。
    expect(a).toEqual(many.slice(0, 32).map((t, i) => `${i + 1}:${t.title}`));
  });

  // 复审 I1：多轮重排不许叠着跑。`ids` 在 `pendingIds()` 读进来、`cancel(ids)`
  // 隔着两个 await 才用掉，而 SSE 一次数据变更常连发几个 `data-changed`，每次
  // `reload()` 都换一份新 tasks、各触发一轮。**编号策略把伤害放大到最大**：id
  // 每轮 1..N 重发，落后那轮手里那份「过期」id 恰好等于新那轮刚排上的那批。
  // 这条测试装的就是那个交叠：假 port 把第一轮的 cancel 悬住，中间放第二轮进来。
  it('两轮交叠：先到那轮的 cancel 不许抹掉晚到那轮刚排上的（不串行的话手机归零）', async () => {
    // 手机上现在排着上一轮留下的 [1,2]——这个假 port 记的不只是调用，还有
    // 「这台手机上此刻有哪几条」，因为要断言的正是最后剩下什么。
    let device: number[] = [1, 2];
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let cancels = 0;
    const port: NotifyPort = {
      available: () => true,
      checkPermission: async () => { calls.push('check'); return 'granted' as PermissionState; },
      requestPermission: async () => 'granted' as PermissionState,
      exactPermission: async () => 'granted' as PermissionState,
      pendingIds: async () => { calls.push(`pending:${device.join(',')}`); return [...device]; },
      cancel: async (ids) => {
        calls.push(`cancel:${ids.join(',')}`);
        // 只悬第一轮的：真机上它就是一次跨桥调用，慢一拍再正常不过。
        if (++cancels === 1) await held;
        device = device.filter((id) => !ids.includes(id));
      },
      schedule: async (ns) => {
        calls.push(`schedule:${ns.map((n) => n.id).join(',')}`);
        device = [...device, ...ns.map((n) => n.id)];
      },
    };
    // 第一轮拿的是「任务都做完了」那份数据：只取消、没得排。
    const done = [mk({ id: 'a', status: 'done', reminders: [future('2026-09-04T08:13:00+08:00')] })];
    const first = rescheduleLocalNotifications(done, NOW, port);
    // 紧接着数据又变了（SSE 连发的第二条），这一轮有两条要排。
    const second = rescheduleLocalNotifications(TASKS, NOW, port);
    // 放行之前把微任务全排干（不是 fake timers，这里就一个真的 0 毫秒宏任务）：
    // **第二轮此刻一个 port 方法都不许碰过**。
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['check', 'pending:1,2', 'cancel:1,2']);

    release();
    await Promise.all([first, second]);
    // 两轮首尾相接，不交错：第一轮整个跑完（手机清空），第二轮才开始读 pending。
    expect(calls).toEqual([
      'check', 'pending:1,2', 'cancel:1,2',
      'check', 'pending:', 'schedule:1,2',
    ]);
    // 最要紧的一条：最后手机上是**第二轮**那份，不是空的。不串行的话第一轮那句
    // 悬着的 cancel 会在第二轮 schedule 之后落地，这里就是 `[]`。
    expect(device).toEqual([1, 2]);
  });
});
