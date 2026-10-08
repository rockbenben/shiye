import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDay, parseHhmm, shouldSendSummary, summaryTasks, summaryText, todayProgress, SUMMARY_MAX } from './dailySummary.js';
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

/**
 * 任务栏进度条要的那三个数（桌面端 `GET /api/summary` 就是它）。
 *
 * **「还剩几件」跟 `summaryTasks` 是同一批**（还没了结的那些）——那正是网页
 * 「今天」那一屏显示的数。而 `total` 多了**已经做完的**：进度条要的是一个
 * 比例，只给「还剩几件」画不出来。
 */
describe('todayProgress', () => {
  const NOW = () => local(2026, 8, 19, 9, 0);
  const at = (d: number, h = 12) => local(2026, 8, d, h).toISOString();

  it('今天一共几件 / 做完几件 / 还剩几件', () => {
    const p = todayProgress([
      task({ title: '做完了', due: at(19), status: 'done' }),
      task({ title: '还在', due: at(19) }),
      task({ title: '还在2', due: at(19) }),
    ], NOW());
    expect(p).toEqual({ total: 3, done: 1, remaining: 2 });
  });

  it('**搁置和放弃不算「做完」**——那是「不做」，不是「做完了」', () => {
    const p = todayProgress([
      task({ title: '搁置', due: at(19), status: 'later' }),
      task({ title: '放弃', due: at(19), status: 'abandoned' }),
      task({ title: '做完', due: at(19), status: 'done' }),
      task({ title: '还在', due: at(19) }),
    ], NOW());
    expect(p.done).toBe(1);
    // 搁置和放弃「了结了」，所以不占「还剩」——跟 summaryTasks 同一口径。
    expect(p.remaining).toBe(1);
    expect(p.total).toBe(4);
  });

  it('**「还剩」跟 summaryTasks 是同一批**——网页「今天」显示几件，这里就剩几件', () => {
    const rows = [
      task({ title: '做完了', due: at(19), status: 'done' }),
      task({ title: '还在', due: at(19) }),
      task({ title: '过期的', due: at(17) }),
      task({ title: '明天的', due: at(20) }),
    ];
    expect(todayProgress(rows, NOW()).remaining).toBe(summaryTasks(rows, NOW()).length);
  });

  it('今天没安排就是三个 0——桌面端据此不画那条进度条', () => {
    expect(todayProgress([task({ title: '明天的', due: at(20) })], NOW())).toEqual({ total: 0, done: 0, remaining: 0 });
  });

  it('坏日期不算，也不炸', () => {
    expect(todayProgress([task({ title: '坏的', due: '下周三' })], NOW())).toEqual({ total: 0, done: 0, remaining: 0 });
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

  /**
   * **跨天的那几条要跟「今天要清的」分开数。** 网页头上那一行已经分了两档
   * （`web/src/lib/workload.ts` 的 `todayMetaLabel`），推送这边原来只说
   * 「今天 3 件事」——同一天同一批任务，屏幕上说「今天要清 2 件，另 1 件在做着」，
   * 通知里说「3 件」，而那条「在做着」的是一个要做五天的活在推进，不是今天清得掉的。
   * 这个仓库对「两个数字各说各的」最敏感，见这个文件顶上那段。
   */
  describe('两档：今天要清的 / 在做着的', () => {
    /** 8-17 开始、8-22 截止：今天（8-19）走到第 3 天。 */
    const doing = (over: Partial<Task> = {}) => task({ title: '铺地板', startAt: at(17), due: at(22), ...over });

    it('两档都有就各数各的，「已过期」数在要清那一档', () => {
      const rows = summaryTasks([
        task({ title: '昨天的', due: at(18) }),
        task({ title: '今天的', due: at(19) }),
        doing(),
      ], NOW());
      expect(summaryText(rows, NOW()).title).toBe('今天 3 件事（今天要清 2 件，1 件已过期），另 1 件在做着');
    });

    it('整排都在做着时不报「今天要清 0 件」——那是句没人接着说的话', () => {
      const rows = summaryTasks([doing(), doing({ title: '另一件' })], NOW());
      expect(summaryText(rows, NOW()).title).toBe('今天 2 件事，都在做着');
    });

    /**
     * **这一条盯的是「分档只在真有两档时才出现」。** 上面那几条既有的钉死了
     * 一句「今天 2 件事，其中 1 件已经过期」——没有跨天任务时那一句一个字都不能动，
     * 一个天天收推送的人不该因为有人加了个字段就换一种读法。
     */
    it('没有跨天的那几条时，那句和原来一字不差', () => {
      const rows = summaryTasks([task({ title: '昨天的', due: at(18) }), task({ title: '今天的', due: at(19) })], NOW());
      expect(summaryText(rows, NOW()).title).toBe('今天 2 件事，其中 1 件已经过期');
      expect(summaryText(rows, NOW()).title).not.toContain('在做着');
    });
  });

  /**
   * **概览在晚上发的时候，「今天几点截止」那几条已经欠着了——推送原来看不见。**
   *
   * 上面那句注释写着「跟网页 `taskView.ts` 的 `isTaskOverdue` 是同一条规矩」，
   * 而那条规矩是**分两档**的：落在本地零点的（全天）按天比，定了具体钟点的按
   * 时刻比（`dueOverdue` 上面有整段理由）。原来那份只抄了按天那一半，
   * 于是「截止今天 18:00」那条在 21:00 的屏幕上写着「过期 3 小时」、卡片一片红，
   * 推送却报「1 件都没过期」。实测出来的：同一份数据同一时刻，屏幕那句是
   * 「今天要清 6 件，5 件已过期」，推送那句是「今天要清 6 件，1 件已过期」。
   */
  describe('按天还是按时刻：跟屏幕上那个红标签同一条', () => {
    const evening = local(2026, 8, 19, 21, 0);

    it('截止今天 18:00、概览 21:00 发：算过期', () => {
      const rows = summaryTasks([task({ title: '交总结', due: local(2026, 8, 19, 18).toISOString() })], evening);
      expect(summaryText(rows, evening).title).toBe('今天 1 件事，其中 1 件已经过期');
    });

    it('全天那种（落在本地零点）今天之内不算过期——那一整天的期限还没走完', () => {
      const rows = summaryTasks([task({ title: '交总结', due: local(2026, 8, 19, 0, 0).toISOString() })], evening);
      expect(summaryText(rows, evening).title).toBe('今天 1 件事');
    });

    it('全天那种过了今天才算过期', () => {
      const rows = summaryTasks([task({ title: '交总结', due: local(2026, 8, 19, 0, 0).toISOString() })], local(2026, 8, 20, 9));
      expect(summaryText(rows, local(2026, 8, 20, 9)).title).toBe('今天 1 件事，其中 1 件已经过期');
    });
  });
});
