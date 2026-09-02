import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { PERSIST_EVERY_MS, dueTasks, fireDailySummary, fireReminders, notifyCommand } from './reminder.js';
import { Bus } from './events.js';
import { DEFAULT_SETTINGS, ensureDataFiles, newTask, readSettings, readTasks, writeSettings, writeTasks, type Task } from './store.js';

// toastRaw() 会 execFile('powershell', ...)——测试环境里没有 PowerShell 可执行，
// 也不该真的去弹一个系统通知。mock 成立刻回调成功，跟真实 powershell.exe 的
// 「进程退出码 0」是同一个观感（reminder.ts 里 err 为 null 就当发出去了）。
// **只换 execFile，其它导出（比如 expand.ts 用的 spawn）用 importOriginal 透传**——
// 之前那版直接整个对象替换成 `{ execFile }`，这个测试文件目前碰不到 spawn，
// 但哪天模块图变了会报出 `spawn is not a function` 这种指向错误方向的错，
// 跟 events.test.ts 包 fs.watch 是同一个手法。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => cb(null)),
  };
});

const NOW = new Date('2026-08-10T12:00:00.000Z');
/** 刚到点（NOW 前一分钟）。**`fireReminders` 的夹具一律用它**：那个函数只补响
 *  「刚错过」的那一段（`CATCH_UP_MS`，一小时），拿一条 9 天前的提醒当夹具测
 *  「会不会发出去」，测的其实是「补不补响攒了很久的那些」——那是另一条测试。 */
const JUST_NOW = '2026-08-10T11:59:00.000Z';
/** 攒了很久的那种：服务停了一整天，这条在停机期间到的点。 */
const LONG_AGO = '2026-08-09T00:00:00.000Z';
const at = (iso: string, extra: Partial<Task> = {}, firedAt: string | null = null) =>
  newTask({ title: '交房租', reminders: [{ at: iso, firedAt }], ...extra });

describe('dueTasks', () => {
  it('提醒时间到了就算到期', () => {
    expect(dueTasks([at('2026-08-10T11:59:00.000Z')], NOW)).toHaveLength(1);
  });

  it('提醒时间还没到不算', () => {
    expect(dueTasks([at('2026-08-10T12:01:00.000Z')], NOW)).toEqual([]);
  });

  it('已经完成的不提醒 —— 做完了还被念叨是最招人烦的一种', () => {
    expect(dueTasks([at('2026-08-01T00:00:00.000Z', { status: 'done' })], NOW)).toEqual([]);
  });

  it('搁置的不提醒 —— 搁置就是「暂时不想看见它」，到点还弹通知/webhook/横幅是让它更吵，跟意图相反', () => {
    expect(dueTasks([at('2026-08-01T00:00:00.000Z', { status: 'later' })], NOW)).toEqual([]);
  });

  it('已经提醒过的不再提醒', () => {
    expect(dueTasks([at('2026-08-01T00:00:00.000Z', {}, '2026-08-01T00:00:01.000Z')], NOW)).toEqual([]);
  });

  it('没设提醒时间的不提醒', () => {
    expect(dueTasks([newTask({ title: '随手记的' })], NOW)).toEqual([]);
  });

  it('提醒时间不是合法时间就跳过，不当成 1970 年狂发 —— 手改文件写错格式是会发生的', () => {
    expect(dueTasks([at('下周三')], NOW)).toEqual([]);
  });
});

describe('fireReminders', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-remind-'));
    process.env.DATA_DIR = dir;
    // 设置现在存在设备本地，不指到临时目录的话下面的 writeSettings 会落到
    // 这台机器真实的平台惯例位置（比如 %APPDATA%\shiye\device.json）。
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    ensureDataFiles();
    // 测试里既不弹通知也不发网络请求：toast 关掉、webhook 留空。
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: '', toastEnabled: false });
    vi.mocked(execFile).mockClear();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.DEVICE_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it('到期任务广播 reminder 并盖上 firedAt', async () => {
    writeTasks([at(JUST_NOW)]);
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'reminder') seen.push(d); });

    const fired = await fireReminders(bus, NOW);

    expect(fired).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(readTasks()[0].reminders[0].firedAt).toBe(NOW.toISOString());
  });

  // 这个场景是这次改造才出现的：改成 reminders 数组之前，一条任务最多一个
  // 提醒时刻，不存在「同一条任务两个提醒同时到期」这回事。现在 sanitizeTaskPatch
  // 不限制数组长度，PATCH / outbox / 手改文件都能造出这种任务，得有测试锁住
  // dueTasks() 的任务级判定和 fireReminders() 的逐条盖章，不然以后谁改坏了
  // 没人知道。
  it('同一条任务上两个提醒同时到期，只广播一次提醒事件，但两条都盖章', async () => {
    writeTasks([newTask({
      title: '交房租',
      reminders: [
        { at: '2026-08-10T11:58:00.000Z', firedAt: null },
        { at: '2026-08-10T11:59:00.000Z', firedAt: null },
      ],
    })]);
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'reminder') seen.push(d); });

    const fired = await fireReminders(bus, NOW);

    // due 是任务的集合不是提醒的集合——用户要的是「这件事该做了」，
    // 不是同一句话说两遍。
    expect(fired).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const reminders = readTasks()[0].reminders;
    expect(reminders[0].firedAt).toBe(NOW.toISOString());
    expect(reminders[1].firedAt).toBe(NOW.toISOString());
  });

  it('同一条任务上一条到期、一条还没到——只盖到期那条的章，没到期那条的 firedAt 仍是 null', async () => {
    writeTasks([newTask({
      title: '交房租',
      reminders: [
        { at: '2026-08-01T00:00:00.000Z', firedAt: null },   // 到期
        { at: '2026-09-01T00:00:00.000Z', firedAt: null },   // 还没到
      ],
    })]);

    await fireReminders(new Bus(), NOW);

    const reminders = readTasks()[0].reminders;
    expect(reminders[0].firedAt).toBe(NOW.toISOString());
    expect(reminders[1].firedAt).toBeNull();
  });

  it('连跑两次只提醒一次', async () => {
    writeTasks([at(JUST_NOW)]);
    const bus = new Bus();
    expect(await fireReminders(bus, NOW)).toHaveLength(1);
    expect(await fireReminders(bus, NOW)).toHaveLength(0);
  });

  it('没有到期任务时一个字节都不写 —— 每 30 秒重写一次文件会把 watcher 和前端刷爆', async () => {
    writeTasks([at('2026-09-01T00:00:00.000Z')]);
    const before = readTasks()[0].updatedAt;
    await fireReminders(new Bus(), NOW);
    expect(readTasks()[0].updatedAt).toBe(before);
    expect(readTasks()[0].reminders[0].firedAt).toBeNull();
  });

  it('webhook 配了就 POST 任务本身', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: 'https://example.com/hook', toastEnabled: false });
    writeTasks([at(JUST_NOW)]);
    const calls: Array<[string, RequestInit | undefined]> = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push([String(url), init as RequestInit]);
      return new Response('ok');
    });

    await fireReminders(new Bus(), NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://example.com/hook');
    expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({ title: '交房租' });
    spy.mockRestore();
  });

  it('webhook 发失败照样盖 firedAt —— 一个连不上的 URL 不该让同一条提醒每 30 秒重发一次', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: 'https://example.com/hook', toastEnabled: false });
    writeTasks([at(JUST_NOW)]);
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('连不上'));

    await expect(fireReminders(new Bus(), NOW)).resolves.toHaveLength(1);
    expect(readTasks()[0].reminders[0].firedAt).toBe(NOW.toISOString());
    spy.mockRestore();
  });

  it('发送期间落地的别的写入不会被回写吞掉 —— firedAt 必须在发送之前就盖章写盘', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: 'https://example.com/hook', toastEnabled: false });
    writeTasks([at(JUST_NOW)]);
    // webhook 发送耗时正是那个危险窗口：这里模拟 AI agent 恰好在这几秒里
    // 往 tasks.json 追加了一个新任务。如果 fireReminders 用发送前读到的
    // 那份快照在发送后整体回写，这条新任务会被无声地抹掉。
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      writeTasks([...readTasks(), newTask({ title: '并发写入的任务' })]);
      return new Response('ok');
    });

    await fireReminders(new Bus(), NOW);

    const titles = readTasks().map((t) => t.title);
    expect(titles).toContain('并发写入的任务');
    spy.mockRestore();
  });
});

// 桌面端在线时，Electron 自己走 Notification（订阅同一个 bus 的 'reminder' 事件），
// PowerShell 只在它不在线时当兜底——两条路同时开会让同一条提醒弹两次
// （已归档的 docs/superpowers/plans/2026-08-20-mature-deps.md 记的正是这个坏法）。
/**
 * 停机期间攒下来的那一批。`isDue` 没有下界——服务停一晚上再开机，第一轮扫描
 * 会把这段时间里所有到点的提醒一起发出去：十几条系统通知同时炸，每条还各起
 * 一个 PowerShell 进程、各发一条 webhook。**那时候「现在响」已经不是提醒，
 * 是打扰**，而它们并没有丢：「今天」收它们（`isReminderOverdue`）、卡片上红着
 * 「过期 N 天」、每日概览也会报。
 */
/**
 * **盖章之前先把设置读出来。**
 *
 * 盖章（`writeTasks` 写 `firedAt`）是不可逆的：`isDue` 一看到 `firedAt` 非空就
 * 永远返回 false，那条提醒从此不会再响。而 `readSettings()` 是会抛的——
 * `device.json` 被外部编辑器或同步盘写坏时 `readJson` 明确选择抛出（它自己的
 * 注释：「绝不静默回落到 fallback」）。
 *
 * 顺序反了的话：章盖上 → 读设置抛出 → `index.ts` 吞成一句 console.warn →
 * **这一批提醒被永久标成「已发」，而一条都没发出去**，除非有人去手改文件。
 * 实测复现过（把 device.json 写成 `{ 这不是 JSON`）。
 */
describe('fireReminders：设置读不出来时不许盖章', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-remind-bad-'));
    process.env.DATA_DIR = dir;
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    ensureDataFiles();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.DEVICE_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it('device.json 坏掉：抛出去，但那条提醒的 firedAt 还是 null', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    writeTasks([newTask({ id: 't1', title: '该响的', due: past, reminders: [{ at: past, firedAt: null }] })]);
    writeFileSync(join(dir, 'device.json'), '{ 这不是 JSON', 'utf8');

    await expect(fireReminders(new Bus())).rejects.toThrow();

    expect(readTasks()[0].reminders[0].firedAt, '章盖上了，而这条提醒一次都没发出去').toBeNull();
  });
});

describe('fireReminders：攒了很久的那些只盖章、不响', () => {
  // **这一组原来没有自己的 beforeEach。** 上一个 describe 的 afterEach 会
  // `delete process.env.DATA_DIR / DEVICE_CONFIG`，于是下面这些 `writeTasks` /
  // `writeSettings` 落到了真机器上：`%APPDATA%\shiye\device.json` 被整份覆盖成
  // DEFAULT_SETTINGS + 下面那条 `webhookUrl`，仓库的 `data/tasks/` 被换成
  // 「旧的」「新的」两个夹具（`writeTasks` 是整目录替换，而 `data/` 不进 git）。
  // 每跑一次 `npm test` 重来一遍。
  //
  // 同一件事另外还在 `scripts/test-setup-node.ts` 兜了一道——那是给「以后又有
  // 谁忘了」准备的网，这里这份是这一组自己该有的隔离，两个都要。
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-stamp-'));
    process.env.DATA_DIR = dir;
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    ensureDataFiles();
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.DEVICE_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it('超过补响窗口的：盖章，但不广播、不弹、不发 webhook', async () => {
    writeTasks([at(LONG_AGO)]);
    writeSettings({ ...DEFAULT_SETTINGS, toastEnabled: true, webhookUrl: 'http://example.test/hook' });
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e) => { if (e === 'reminder') seen.push(e); });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));

    const fired = await fireReminders(bus, NOW);

    expect(fired).toEqual([]);
    expect(seen).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    // **章照样盖**：不盖的话每 30 秒重判一次，手机那边 notifyPlan 的 missed
    // 也会一直挂着它们。
    expect(readTasks()[0].reminders[0].firedAt).not.toBeNull();
    fetchSpy.mockRestore();
  });

  it('窗口之内的照常响——服务重启、合盖一会儿这类「刚错过」的不该被吞掉', async () => {
    writeTasks([at(JUST_NOW)]);
    const bus = new Bus();
    const fired = await fireReminders(bus, NOW);
    expect(fired).toHaveLength(1);
  });

  it('**一条旧的加一条刚到的：那条任务照常响**——「刚才有一条到点了」是任务级的判断', async () => {
    writeTasks([newTask({
      title: '交房租',
      reminders: [
        { at: LONG_AGO, firedAt: null },
        { at: JUST_NOW, firedAt: null },
      ],
    })]);
    const bus = new Bus();
    const fired = await fireReminders(bus, NOW);
    expect(fired).toHaveLength(1);
    // 两条都盖章，跟「同一条任务上两个提醒同时到期」那条一致。
    expect(readTasks()[0].reminders.every((r) => r.firedAt !== null)).toBe(true);
  });

  it('一批里旧的新的都有：只发新的那几条', async () => {
    writeTasks([at(LONG_AGO, { title: '旧的' }), at(JUST_NOW, { title: '新的' })]);
    const bus = new Bus();
    const fired = await fireReminders(bus, NOW);
    expect(fired.map((t) => t.title)).toEqual(['新的']);
    expect(readTasks().every((t) => t.reminders[0].firedAt !== null)).toBe(true);
  });
});

describe('fireReminders：桌面端在线时不再另起 PowerShell', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-remind-desktop-'));
    process.env.DATA_DIR = dir;
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    ensureDataFiles();
    // 这组测试专门要看 toast 起不起 PowerShell，跟别处「关掉 toast 图省事」相反。
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: '', toastEnabled: true });
    vi.mocked(execFile).mockClear();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.DEVICE_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it('桌面端在线：不起 PowerShell（execFile 不被调用），但 bus.emit 照常发给桌面端自己那条通知路径', async () => {
    writeTasks([at(JUST_NOW)]);
    const bus = new Bus();
    bus.markDesktopOnline(NOW);
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'reminder') seen.push(d); });

    const fired = await fireReminders(bus, NOW);

    expect(fired).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('桌面端不在线（从没连过）：照常起 PowerShell 兜底', async () => {
    writeTasks([at(JUST_NOW)]);
    const bus = new Bus(); // 没有任何一条 SSE 连接标记过自己是桌面端

    await fireReminders(bus, NOW);

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile).mock.calls[0][0]).toBe('powershell');
  });

  it('桌面端心跳超过 TTL 窗口没刷新（模拟崩溃/被强杀），回落到「不在线」，重新起 PowerShell 兜底', async () => {
    writeTasks([at(JUST_NOW)]);
    const bus = new Bus();

    // 用假时钟推进真实的经过时间，而不是手工拼一个「更早」的 Date 传给
    // markDesktopOnline——这样走的是 markDesktopOnline() 生产环境里那条默认
    // 参数（`new Date()`）的真实路径，不只是测 isDesktopOnline 的减法逻辑。
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(NOW);
      bus.markDesktopOnline(); // 桌面端连上那一刻的心跳
      vi.setSystemTime(new Date(NOW.getTime() + 71_000)); // 71 秒后：超过 70 秒的 TTL，没有再刷新过

      await fireReminders(bus, new Date());

      expect(execFile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('scripts/toast.ps1', () => {
  it('必须保留 UTF-8 BOM —— 实测在代码页 936（GBK）的 Windows PowerShell 5.1 上，没有 BOM 会把文件里的中文注释解析错乱，进而把 if/else 解析坏掉；这不是编码洁癖，删了它这条提醒就真的弹不出来', () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'toast.ps1');
    const head = readFileSync(script).subarray(0, 3);
    expect(Array.from(head)).toEqual([0xef, 0xbb, 0xbf]);
  });
});

/**
 * 每日概览。**该不该发、发什么在
 * `dailySummary.test.ts`**——这里测落地这一端：盖章、只发一次、空的不发。
 */
describe('fireDailySummary', () => {
  let dir: string;
  const NOW_LOCAL = new Date(2026, 7, 19, 9, 0);
  const dueToday = (title: string) =>
    newTask({ title, due: new Date(2026, 7, 19, 12).toISOString() });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'todo-daily-'));
    process.env.DATA_DIR = dir;
    process.env.DEVICE_CONFIG = join(dir, 'device.json');
    ensureDataFiles();
    writeSettings({ ...DEFAULT_SETTINGS, webhookUrl: '', toastEnabled: false, dailySummaryAt: '08:00' });
    vi.mocked(execFile).mockClear();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    delete process.env.DEVICE_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it('到点了广播一条，正文列出今天要做的', async () => {
    writeTasks([dueToday('写周报')]);
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e, d) => { if (e === 'daily-summary') seen.push(d); });

    const out = await fireDailySummary(bus, NOW_LOCAL);

    expect(out?.title).toBe('今天 1 件事');
    expect(out?.body).toContain('写周报');
    expect(seen).toHaveLength(1);
  });

  it('**一天只发一次**：盖了章，同一天再跑一轮什么都不做', async () => {
    writeTasks([dueToday('写周报')]);
    const bus = new Bus();
    expect(await fireDailySummary(bus, NOW_LOCAL)).not.toBeNull();
    expect(readSettings().dailySummaryOn).toBe('2026-08-19');
    expect(await fireDailySummary(bus, NOW_LOCAL)).toBeNull();
  });

  it('**一件事都没有时不发，但照样盖章**——一条「今天 0 件事」每天准时出现，只会教人忽略这个通知', async () => {
    writeTasks([]);
    const bus = new Bus();
    const seen: unknown[] = [];
    bus.subscribe((e) => { if (e === 'daily-summary') seen.push(e); });

    expect(await fireDailySummary(bus, NOW_LOCAL)).toBeNull();
    expect(seen).toHaveLength(0);
    // 章还是要盖：不盖的话晚上真多出一条任务时会突然推一条「今天 1 件事」，
    // 那时候说已经晚了。
    expect(readSettings().dailySummaryOn).toBe('2026-08-19');
  });

  it('没开（时刻是 null）就一个字节都不写', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, dailySummaryAt: null });
    writeTasks([dueToday('写周报')]);
    expect(await fireDailySummary(new Bus(), NOW_LOCAL)).toBeNull();
    expect(readSettings().dailySummaryOn).toBeNull();
  });

  it('还没到点不发', async () => {
    writeSettings({ ...DEFAULT_SETTINGS, toastEnabled: false, dailySummaryAt: '20:00' });
    writeTasks([dueToday('写周报')]);
    expect(await fireDailySummary(new Bus(), NOW_LOCAL)).toBeNull();
  });
});

/**
 * **持续提醒**（仿滴答清单：「会一直提醒你，直到你进行处理」）。
 *
 * 这个应用的第一性目的是「别漏事」，而**一条没看见的提醒和没设过提醒，结果
 * 完全一样**——横幅关掉那一下就结束了。
 *
 * 它跟这个文件顶部那条原则方向相反（搁置的任务不发提醒，「刚图个清净就被烦到
 * 比不搁置还糟」），所以**默认关、每条各自开**。两条规矩同时存在，都对，
 * 只是适用的任务不同。
 */
describe('dueTasks：持续提醒', () => {
  const NOW_P = new Date('2026-08-20T10:00:00.000Z');
  const ago = (ms: number) => new Date(NOW_P.getTime() - ms).toISOString();
  const withReminder = (over: Partial<Task>, firedAt: string | null) => newTask({
    title: '交房租', reminders: [{ at: ago(60 * 60_000), firedAt }], ...over,
  });

  it('没开这个开关：响过一次就不再响——加它之前的行为，一个字不变', () => {
    const t = withReminder({ persistentReminder: false }, ago(PERSIST_EVERY_MS * 3));
    expect(dueTasks([t], NOW_P)).toEqual([]);
  });

  it('开了、离上次响够久了：再响一次', () => {
    const t = withReminder({ persistentReminder: true }, ago(PERSIST_EVERY_MS + 1000));
    expect(dueTasks([t], NOW_P)).toHaveLength(1);
  });

  it('开了、但离上次响还不够久：不响——不然每 30 秒扫一次就是每 30 秒响一次', () => {
    const t = withReminder({ persistentReminder: true }, ago(PERSIST_EVERY_MS - 1000));
    expect(dueTasks([t], NOW_P)).toEqual([]);
  });

  it.each([['done'], ['later'], ['abandoned']] as const)('%s 了就不再响——「处理」的定义里第一条', (status) => {
    const t = withReminder({ persistentReminder: true, status }, ago(PERSIST_EVERY_MS * 5));
    expect(dueTasks([t], NOW_P)).toEqual([]);
  });

  it('还没响过第一次的走原来那条路，不受这个开关影响', () => {
    const t = withReminder({ persistentReminder: true }, null);
    expect(dueTasks([t], NOW_P)).toHaveLength(1);
  });

  /**
   * `data/tasks/` 是手改得到的文件，`firedAt` 里写着「上周三」是可能的。
   *
   * **这种一律不响**，跟 `isDue` 对坏 `at` 的态度一致：章解析不出来就等于
   * 「不知道上次什么时候响的」，而这一档的整个判断就建立在那个时刻上。
   * 猜一个只有两种猜法，都比不响糟——当成很久以前就是**每 30 秒响一次**，
   * 当成刚刚则是永远不响，那还不如老老实实不响、让它留在「今天」里红着。
   */
  it('章解析不出来：不响，也不抛', () => {
    const t = withReminder({ persistentReminder: true }, '上周三');
    expect(() => dueTasks([t], NOW_P)).not.toThrow();
    expect(dueTasks([t], NOW_P)).toEqual([]);
  });
});

/**
 * 兜底通知的平台分档。原来这一层只有 win32 一条、其余平台第一句就 return——
 * 于是 mac/Linux 上**两层通知一起坏**（桌面版那边的 `toastXml` 在非 Windows 上
 * 是空通知，见 desktop/src/notify.ts），而「到点提醒」是这个应用的第一句承诺。
 *
 * 这里不测 execFile 真的跑起来（测试环境里三个命令一个都没有），测的是
 * 「哪个平台拼哪条命令」和「拼串那一档的转义」——后者是唯一一处真的把用户
 * 写的文字拼进一段会被解释的代码里的地方。
 */
describe('notifyCommand：平台分档', () => {
  const SCRIPT = 'C:\repo\scripts\toast.ps1';

  it('win32：powershell + toast.ps1，标题正文走具名参数（不拼串，所以不需要转义）', () => {
    const c = notifyCommand('win32', '交房租', '截止 今天 18:00', SCRIPT)!;
    expect(c.cmd).toBe('powershell');
    expect(c.args).toContain(SCRIPT);
    expect(c.args[c.args.indexOf('-Title') + 1]).toBe('交房租');
    expect(c.args[c.args.indexOf('-Body') + 1]).toBe('截止 今天 18:00');
  });

  it('darwin：osascript -e display notification，标题正文各自成串', () => {
    const c = notifyCommand('darwin', '交房租', '截止 今天', SCRIPT)!;
    expect(c.cmd).toBe('osascript');
    expect(c.args[0]).toBe('-e');
    expect(c.args[1]).toBe('display notification "截止 今天" with title "交房租"');
  });

  it('linux：notify-send，`--` 收尾选项解析', () => {
    const c = notifyCommand('linux', '交房租', '截止 今天', SCRIPT)!;
    expect(c.cmd).toBe('notify-send');
    expect(c.args).toEqual(['--', '交房租', '截止 今天']);
  });

  it('`-` 开头的标题在 linux 上不会被当成选项——`--` 挡住了', () => {
    const c = notifyCommand('linux', '-1 号方案', '正文', SCRIPT)!;
    expect(c.args[0]).toBe('--');
    expect(c.args[1]).toBe('-1 号方案');
  });

  it('别的平台返回 null（静默跳过），不是硬塞一条跑不起来的命令', () => {
    expect(notifyCommand('freebsd' as NodeJS.Platform, 'a', 'b', SCRIPT)).toBeNull();
  });
});

/**
 * AppleScript 是这三条路里**唯一**把用户写的文字拼进一段会被解释的代码的。
 * 一个裸的 `"` 就能截断 `display notification "…"`，后面的内容变成 AppleScript
 * 代码交给 osascript 执行——而任务标题是用户和 AI 都能写的自由文本。
 */
describe('notifyCommand：AppleScript 转义', () => {
  const script = (title: string, body = '正文') =>
    notifyCommand('darwin', title, body, 'x')!.args[1];

  it('双引号被转义，闭合的引号数量是偶数（没有截断整句）', () => {
    const s = script('他说"马上就好"');
    expect(s).toContain('\\"马上就好\\"');
    // 反斜杠转义之外的裸引号只能是四个字符串定界符
    expect(s.replace(/\\"/g, '').match(/"/g)!.length).toBe(4);
  });

  it('反斜杠先转，不会把为引号插进去的那个反斜杠再吃一遍', () => {
    // 输入是一个字面反斜杠（JS 里写成 '\\'），输出该是两个（AppleScript 的转义）。
    expect(script('C:\\路径')).toBe('display notification "正文" with title "C:\\\\路径"');
  });

  /**
   * **顺序反过来只有在「反斜杠和引号同时出现」时才露馅**，所以必须有这一条。
   * 变异验证抓到过：把两个 replace 调换之后，上面那两条（只有引号、或只有
   * 反斜杠）**全绿**——
   *   只有反斜杠：引号那步什么都没替，结果一样；
   *   只有引号：先替引号得 `\"`，再替反斜杠把它变成 `\\"`，而 `toContain('\\"')`
   *            在 `\\"` 里照样命中，数引号那条也照样过。
   * 反了的话这里会得到 `…\\\\"`——字面反斜杠 + **没转义的引号**，字符串当场截断，
   * 后面的内容交给 osascript 当代码执行。这正是要防的那件事。
   */
  it('反斜杠和引号同时出现时，顺序反了就会露馅（截断整句）', () => {
    expect(script('反斜杠\\然后引号"')).toBe(
      'display notification "正文" with title "反斜杠\\\\然后引号\\""',
    );
  });

  it('真换行被吃掉——AppleScript 的字符串字面量里不能有裸换行', () => {
    const s = script('第一行\n第二行');
    expect(s).not.toContain('\n');
    expect(s).toContain('第一行 第二行');
  });

  it('正文也走同一套转义，不是只转标题', () => {
    expect(script('标题', '他说"好"')).toContain('display notification "他说\\"好\\""');
  });
});
