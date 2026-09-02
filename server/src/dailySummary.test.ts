import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDay, parseHhmm, shouldSendSummary, summaryTasks, summaryText, SUMMARY_MAX } from './dailySummary.js';
import { DEFAULT_SETTINGS, type Settings, type Task } from './store.js';

// 全程本地墙钟——钉死时区，断言才不会跟着宿主机飘，跟 repeat.test.ts 同一条。
beforeEach(() => { vi.stubEnv('TZ', 'Asia/Shanghai'); });
afterEach(() => { vi.unstubAllEnvs(); });

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
const task = (over: Partial<Task> & { title: string }): Task => ({
  id: over.title, notes: '', status: 'todo', due: null, startAt: null, endAt: null, reminders: [], persistentReminder: false, subtasks: [],
  source: 'user', aiComment: '', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null, postponeCount: 0,
  waitingFor: null, context: null, attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null,
  parentId: null, ...over,
});

describe('parseHhmm', () => {
  it('认 HH:MM', () => {
    expect(parseHhmm('08:30')).toEqual({ h: 8, m: 30 });
    expect(parseHhmm('00:00')).toEqual({ h: 0, m: 0 });
    expect(parseHhmm('23:59')).toEqual({ h: 23, m: 59 });
  });

  it('别的一律当没设——**不猜一个最接近的合法值**：猜了会让他以为设成功了，而通知在别的时候响', () => {
    for (const bad of ['24:00', '08:60', '8:30', '0830', '', '晚上八点', null, 25]) {
      expect(parseHhmm(bad), String(bad)).toBeNull();
    }
  });
});

describe('localDay', () => {
  it('**本地日期，不是 UTC**——晚上八点之后 toISOString 会算成明天', () => {
    expect(localDay(local(2026, 8, 19, 23, 30))).toBe('2026-08-19');
    expect(localDay(local(2026, 1, 5))).toBe('2026-01-05');
  });
});

describe('shouldSendSummary', () => {
  const NOW = () => local(2026, 8, 19, 9, 0);

  it('没设时刻就不发——默认关，一条每天定时出现的通知得他自己开', () => {
    expect(shouldSendSummary(settings(), NOW())).toBe(false);
  });

  it('还没到点不发', () => {
    expect(shouldSendSummary(settings({ dailySummaryAt: '10:00' }), NOW())).toBe(false);
  });

  it('到点就发', () => {
    expect(shouldSendSummary(settings({ dailySummaryAt: '09:00' }), NOW())).toBe(true);
  });

  it('**过了点也照样发**——机器睡过去、服务重启，那一分钟被跳过时不该整天静默', () => {
    expect(shouldSendSummary(settings({ dailySummaryAt: '07:00' }), NOW())).toBe(true);
  });

  it('今天发过就不再发', () => {
    const s = settings({ dailySummaryAt: '07:00', dailySummaryOn: '2026-08-19' });
    expect(shouldSendSummary(s, NOW())).toBe(false);
  });

  it('昨天发过的不算——第二天照发', () => {
    const s = settings({ dailySummaryAt: '07:00', dailySummaryOn: '2026-08-18' });
    expect(shouldSendSummary(s, NOW())).toBe(true);
  });

  it('时刻写坏了当没设，不发', () => {
    expect(shouldSendSummary(settings({ dailySummaryAt: '早上八点' }), NOW())).toBe(false);
  });
});

describe('summaryTasks', () => {
  const NOW = () => local(2026, 8, 19, 9, 0);
  const at = (d: number, h = 12) => local(2026, 8, d, h).toISOString();

  it('今天到期的算，明天的不算', () => {
    const rows = summaryTasks([
      task({ title: '今天', due: at(19) }),
      task({ title: '明天', due: at(20) }),
    ], NOW());
    expect(rows.map((t) => t.title)).toEqual(['今天']);
  });

  it('**过期没做完的也算今天的**——它们才是最该被点名的', () => {
    const rows = summaryTasks([task({ title: '前天的', due: at(17) })], NOW());
    expect(rows.map((t) => t.title)).toEqual(['前天的']);
  });

  it('做完的、搁置的、放弃的都不算', () => {
    const rows = summaryTasks([
      task({ title: '做完了', due: at(19), status: 'done' }),
      task({ title: '搁置了', due: at(19), status: 'later' }),
      task({ title: '放弃了', due: at(19), status: 'abandoned' }),
      task({ title: '还在', due: at(19) }),
    ], NOW());
    expect(rows.map((t) => t.title)).toEqual(['还在']);
  });

  it('**没有截止时间的不算**——它们不属于任何一天，天天念一遍等于每天说同一串话', () => {
    expect(summaryTasks([task({ title: '没日期' })], NOW())).toEqual([]);
  });

  it('坏日期跳过，不炸', () => {
    expect(summaryTasks([task({ title: '坏的', due: '下周三' })], NOW())).toEqual([]);
  });

  it('按截止时间排，早的在前', () => {
    const rows = summaryTasks([
      task({ title: '晚', due: at(19, 18) }),
      task({ title: '早', due: at(17) }),
    ], NOW());
    expect(rows.map((t) => t.title)).toEqual(['早', '晚']);
  });

  it('**当天 23:59 到期的算今天**，不因为时区换算跑到明天', () => {
    const rows = summaryTasks([task({ title: '今晚', due: local(2026, 8, 19, 23, 59).toISOString() })], NOW());
    expect(rows.map((t) => t.title)).toEqual(['今晚']);
  });
});

describe('summaryText', () => {
  const NOW = () => local(2026, 8, 19, 9, 0);
  const at = (d: number) => local(2026, 8, d, 12).toISOString();

  it('没有过期的就只说件数', () => {
    const t = summaryText([task({ title: '写周报', due: at(19) })], NOW());
    expect(t.title).toBe('今天 1 件事');
    expect(t.body).toBe('· 写周报');
  });

  it('**过期的单独点名**——混在总数里等于把最该被看见的那几件藏起来', () => {
    const rows = summaryTasks([
      task({ title: '昨天的', due: at(18) }),
      task({ title: '今天的', due: at(19) }),
    ], NOW());
    expect(summaryText(rows, NOW()).title).toBe('今天 2 件事，其中 1 件已经过期');
  });

  /**
   * **有截止时间的，由截止时间说了算**——跟网页 `taskView.ts` 的 `isTaskOverdue`
   * 同一条规矩，两处必须说同一句话（见这个文件顶上那段）。
   *
   * 现场数据：截止今天 21:00（没到），提醒昨天 10:00 响过 + 今天 15:00 还没到。
   * 原来取「due 和所有提醒里最早那个」，于是推送写「其中 1 件已经过期」，
   * 而屏幕上那条任务一点问题都没有。
   */
  it('提醒昨天响过、截止时间还没到：不算过期', () => {
    const rows = summaryTasks([task({
      title: '写文章',
      due: local(2026, 8, 19, 21).toISOString(),
      reminders: [
        { at: local(2026, 8, 18, 10).toISOString(), firedAt: null },
        { at: local(2026, 8, 19, 15).toISOString(), firedAt: null },
      ],
    })], NOW());
    expect(summaryText(rows, NOW()).title).toBe('今天 1 件事');
  });

  it('截止时间真的过了，照样点名——闸门只挡「还没到」的', () => {
    const rows = summaryTasks([task({
      title: '写文章', due: at(18),
      reminders: [{ at: local(2026, 8, 19, 15).toISOString(), firedAt: null }],
    })], NOW());
    expect(summaryText(rows, NOW()).title).toBe('今天 1 件事，其中 1 件已经过期');
  });

  /** 没有 due 的那一支不动：那是「卡片编辑器能清空 due 只留提醒」那条路。 */
  it('没设 due、只有一个昨天的提醒：还是算过期', () => {
    const rows = summaryTasks([task({
      title: '写文章', due: null,
      reminders: [{ at: local(2026, 8, 18, 10).toISOString(), firedAt: null }],
    })], NOW());
    expect(summaryText(rows, NOW()).title).toBe('今天 1 件事，其中 1 件已经过期');
  });

  it('最多列五条，剩下的说一句——通知不是列表页，滚不动也点不开', () => {
    const rows = Array.from({ length: 8 }, (_, i) => task({ title: `t${i}`, due: at(19) }));
    const t = summaryText(rows, NOW());
    expect(t.body.split('\n')).toHaveLength(SUMMARY_MAX + 1);
    expect(t.body).toContain('…还有 3 件');
  });
});
