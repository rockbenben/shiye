import { describe, it, expect } from 'vitest';
import { composeDefaults, mergePicked, smartDraft, splitCapture } from './composeDefaults.js';
import type { List } from '../types.js';

const list = (over: Partial<List> = {}): List =>
  ({ id: 'L1', name: '工作', color: '#C2410C', folderId: null, order: 0, archived: false, filter: null, ...over });

const SETTINGS = {
  defaultListId: 'D', defaultPriority: 2 as const,
  // 新加的这几个一律取「不预填 / 全开」那一档，也就是它们存在之前的行为——
  // 下面那批既有断言因此一个字都不用改。它们自己的行为另有一组测试。
  defaultDue: 'none' as const, defaultRemindMinutes: null, defaultTags: [],
  smartDate: true, smartStripDate: true, smartTag: true, smartStripTag: true,
};
/** 既有断言里那份「四个全开」的 smart，逐条写一遍太吵，抽出来。 */
const SMART_ON = { date: true, stripDate: true, tag: true, stripTag: true };
const NOW = new Date(2026, 7, 20, 10, 0);
const EMPTY_FILTER = {
  status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: null,
  hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false, noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [], or: [],
};

describe('composeDefaults', () => {
  it('普通去处：按设置里的「任务默认值」走', () => {
    expect(composeDefaults('all', [], SETTINGS, null, NOW))
      .toEqual({ listId: 'D', priority: 2, due: null, tags: [], context: null, remindMinutes: null, smart: SMART_ON });
  });

  it('没有设置（还没读到）时什么都不预填，不自己编一份默认值出来', () => {
    expect(composeDefaults('all', [], null, null, NOW))
      .toEqual({ listId: null, priority: 0, due: null, tags: [], context: null, remindMinutes: null, smart: SMART_ON });
  });

  it('**清单那个去处：落进那个清单**，盖掉设置里的默认清单', () => {
    expect(composeDefaults('list:L1', [list()], SETTINGS, null, NOW).listId).toBe('L1');
  });

  it('标签那个去处：预填那个标签', () => {
    expect(composeDefaults('tag:紧急', [], SETTINGS, null, NOW).tags).toEqual(['紧急']);
  });

  /**
   * 这条分支上一版**一条测试都没有**，而它的两个消费点（`smartDraft`、
   * `TaskComposer`）当时都没读这个字段——于是「站在某个情境里建，就落那个情境」
   * 这句话从加上那天起就是假的：站在「外出」里建一条，它不出现在「外出」里，
   * 那一屏一点变化都没有，跟建失败长得一模一样（`listId` 那段注释里写的正是
   * 这个形状）。「有没有人读」由 `composeDefaults.guard.test.ts` 盯着，这条只管
   * 算得对不对。
   */
  it('情境那个去处：预填那个情境', () => {
    expect(composeDefaults('context:out', [], SETTINGS, null, NOW).context).toBe('out');
  });

  it('别的去处不预填情境——它整个来自「站在哪一屏」', () => {
    expect(composeDefaults('today', [], SETTINGS, null, NOW).context).toBeNull();
    expect(composeDefaults('tag:紧急', [], SETTINGS, null, NOW).context).toBeNull();
  });

  it('**智能清单不预填**——它是一份存下来的查询、不是容器，指过去那条任务哪儿都找不到', () => {
    const smart = list({ id: 'S1', filter: EMPTY_FILTER });
    expect(composeDefaults('list:S1', [smart], SETTINGS, null, NOW).listId).toBe('D');
  });

  it('**已归档的清单不预填**——归档的意思就是别再往里放东西', () => {
    expect(composeDefaults('list:L1', [list({ archived: true })], SETTINGS, null, NOW).listId).toBe('D');
  });

  it('指向一个已经删掉的清单时退回设置里的默认，不留一个死 id', () => {
    expect(composeDefaults('list:没了', [list()], SETTINGS, null, NOW).listId).toBe('D');
  });

  it('日历带过来的那一天原样带上，跟去处那一层不打架', () => {
    const due = new Date(2026, 7, 18, 23, 59).toISOString();
    const r = composeDefaults('list:L1', [list()], SETTINGS, due, NOW);
    expect(r.due).toBe(due);
    expect(r.listId).toBe('L1');
  });

  it('优先级一律来自设置——去处说明不了「多重要」', () => {
    expect(composeDefaults('list:L1', [list()], SETTINGS, null, NOW).priority).toBe(2);
    expect(composeDefaults('tag:紧急', [], SETTINGS, null, NOW).priority).toBe(2);
  });

  it('标签名里有冒号也切得对——只切第一个 `tag:` 前缀', () => {
    expect(composeDefaults('tag:工作/紧急', [], SETTINGS, null, NOW).tags).toEqual(['工作/紧急']);
  });
});

/**
 * 「今天」那个去处。它的成员资格就是「今天要做」，在那儿建一条不带时间的
 * 任务，卡片会落进「按来源」——这一屏一点变化都没有，跟建失败长得一模一样。
 */
describe('composeDefaults：今天', () => {
  it('预填今天的 23:59', () => {
    const r = composeDefaults('today', [], null, null, NOW);
    const d = new Date(r.due!);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()])
      .toEqual([2026, 7, 20, 23, 59]);
  });

  it('**不是零点**——零点会被当成一个真实时刻，那天 00:01 就标成过期、红一整天', () => {
    expect(new Date(composeDefaults('today', [], null, null, NOW).due!).getHours()).toBe(23);
  });

  it('日历带过来的那一天优先——那是他刚点出来的一个具体日子，比「你正站在今天」明确得多', () => {
    const picked = new Date(2026, 7, 25, 23, 59).toISOString();
    expect(composeDefaults('today', [], null, picked, NOW).due).toBe(picked);
  });

  it('别的去处不预填日期——「接下来」按时间分组，没有哪一天是它的意思', () => {
    for (const v of ['all', 'upcoming', 'done', 'kanban']) {
      expect(composeDefaults(v, [], null, null, NOW).due, v).toBeNull();
    }
  });
});

/**
 * 截止时间听谁的。这条原来内联在 `TaskComposer` 的 `merged()` 里，抽出来是
 * 因为「他自己在控件里挑过的最强」那一支在组件测试里够不着——antd 的
 * DatePicker 在 jsdom 里没法用一次 change 驱动。
 */
describe('mergePicked', () => {
  const A = '2026-08-20T15:59:00.000Z';   // 预填
  const B = '2026-08-25T01:00:00.000Z';   // 他在控件里挑的
  const C = '2026-08-13T06:00:00.000Z';   // 标题里认出来的

  it('①**控件里挑过的最强**——跟预填不一样了就是动过', () => {
    expect(mergePicked(B, A, C)).toBe(B);
  });

  it('②没动过控件时听标题——预填只是一个上下文猜测，不该压过他打出来的字', () => {
    expect(mergePicked(A, A, C)).toBe(C);
  });

  it('③标题里也没日期时，预填还在——只是让位，不是被清掉', () => {
    expect(mergePicked(A, A, null)).toBe(A);
  });

  it('没有预填时，控件里的照旧压过标题（原来的规矩没变）', () => {
    expect(mergePicked(B, null, C)).toBe(B);
    expect(mergePicked(B, undefined, C)).toBe(B);
  });

  it('控件空着就听标题', () => {
    expect(mergePicked(null, null, C)).toBe(C);
    expect(mergePicked(null, A, C)).toBe(C);
  });

  it('三个都没有就是没设截止时间', () => {
    expect(mergePicked(null, null, null)).toBeNull();
  });

  it('**他把预填的那个清掉了**：控件空、标题也没写 → 就是没有，不把预填塞回去', () => {
    expect(mergePicked(null, A, null)).toBeNull();
  });
});

/**
 * `smartDraft`：一行原话 → 一份任务草稿。**两个调用方共用**——列表顶上那条
 * 「添加任务」（QuickAdd）和收件箱里的「变成任务」。这一族测的正是「两处进来
 * 建出同一条任务」这件事本身。
 */
/** 换行符写成常量：这份源文件自己的行尾是混合的（仓库里 31 个文件如此），
 *  在字面里直接敲 
 容易在工具链里被改掉。 */
const CR = String.fromCharCode(13);
const NEWLINE = String.fromCharCode(10);
const CRLF = CR + NEWLINE;

describe('smartDraft', () => {
  const NOW = new Date(2026, 7, 25, 10, 0, 0);
  const D = {
    listId: 'L9', priority: 1 as const, due: null, tags: ['底子'],
    context: null, remindMinutes: null as number | null, smart: {},
  };
  // 真实链路传的是 remindPreset 的同名函数；这里给一个可预测的桩，测的是
  // 「什么时候该调它、什么时候不该」，不是它自己算得对不对（那边另有测试）。
  const preset = (due: string | null, minutes: number) => (due ? `提前${minutes}:${due}` : null);

  it('认不出东西时，原话就是标题；设置里的默认值照落', () => {
    const d = smartDraft('给猫买猫粮', D, NOW, { presetToRemindAt: preset });
    expect(d.title).toBe('给猫买猫粮');
    expect(d.listId).toBe('L9');
    expect(d.priority).toBe(1);
    expect(d.tags).toEqual(['底子']);
  });

  it('标题里的日期认出来、并从标题里摘掉', () => {
    const d = smartDraft('明天 给猫买猫粮', D, NOW, { presetToRemindAt: preset });
    expect(d.title).toBe('给猫买猫粮');
    expect(d.due).not.toBeNull();
  });

  it('标题里的标签并进默认标签，不重复', () => {
    const d = smartDraft('买猫粮 #采购 #底子', D, NOW, { presetToRemindAt: preset });
    expect(d.tags).toEqual(['底子', '采购']);
  });

  /**
   * 「添加任务」那一行走的是这条路（`QuickAdd` 把返回值展开进 `emptyDraft()`），
   * 所以情境得**在返回值里**——`smartDraft` 上一版整个没有这个字段，展开一个不
   * 存在的键不会报错，站在「外出」里敲一条就落不进「外出」。
   */
  it('站在某个情境那一屏里敲的，情境跟着草稿走', () => {
    const d = smartDraft('去银行办卡', { ...D, context: 'out' }, NOW, { presetToRemindAt: preset });
    expect(d.context).toBe('out');
  });

  it('标题里写 @外出 就落外出——「添加任务」那一行不用去开表单', () => {
    const d = smartDraft('去银行办卡 @外出', D, NOW, { presetToRemindAt: preset });
    expect(d.context).toBe('out');
    expect(d.title).toBe('去银行办卡');
  });

  /**
   * **打出来的字压过预填**，这是 `mergePicked` 那条 ③ 的同一个形状：站在「外出」
   * 那一屏里敲 `@电脑前`，预填的「外出」只是一个上下文猜测，而他刚刚亲手打了
   * 另一个。
   */
  it('站在「外出」那一屏里打 @电脑前：听他打的那个', () => {
    const d = smartDraft('写代码 @电脑前', { ...D, context: 'out' }, NOW, { presetToRemindAt: preset });
    expect(d.context).toBe('computer');
  });

  it('标题里没写就还是站的那一屏那个', () => {
    const d = smartDraft('去银行办卡', { ...D, context: 'out' }, NOW, { presetToRemindAt: preset });
    expect(d.context).toBe('out');
  });

  it('**按掉智能识别之后回到预填**——那颗开关的意思就是「这一趟别认」', () => {
    const d = smartDraft('写代码 @电脑前', { ...D, context: 'out' }, NOW, { smartOff: true, presetToRemindAt: preset });
    expect(d.context).toBe('out');
  });

  it('**smartOff 时一个都不认**——那颗开关按掉之后，原话原样进标题', () => {
    const d = smartDraft('明天 给猫买猫粮', D, NOW, { smartOff: true, presetToRemindAt: preset });
    expect(d.title).toBe('明天 给猫买猫粮');
    expect(d.due).toBeNull();
    expect(d.repeat).toBeNull();
  });

  it('**没有 due 就不落默认提醒**——没有截止时间就没有「提前」的参照物', () => {
    const d = smartDraft('给猫买猫粮', { ...D, context: null, remindMinutes: 30 }, NOW, { presetToRemindAt: preset });
    expect(d.due).toBeNull();
    expect(d.reminders).toEqual([]);
  });

  it('有 due 时才按设置里的「默认提前多久」落一条提醒', () => {
    const d = smartDraft('明天 给猫买猫粮', { ...D, context: null, remindMinutes: 30 }, NOW, { presetToRemindAt: preset });
    expect(d.reminders).toHaveLength(1);
    expect(d.reminders[0]).toContain('提前30:');
  });

  it('标题里亲口说的提醒优先于设置里的默认提前量', () => {
    const d = smartDraft('明天 9:00 提醒我 给猫买猫粮', { ...D, context: null, remindMinutes: 30 }, NOW, { presetToRemindAt: preset });
    expect(d.reminders[0]).not.toContain('提前30:');
  });
});


/**
 * `splitCapture`：一段随手记 → 标题 + 备注。从 `App.tsx` 里抽出来的纯函数——
 * 在那儿要验它得渲染整个 App，而那一次渲染实测会把用例压到 15s 超时线上（全量
 * 跑时红、单跑绿）。跟 `smartDraft` 当初从 `QuickAdd` 搬出来同一条理由。
 */
describe('splitCapture', () => {
  it('多行：第一行当标题，剩下的整段原样进备注（内部的空行也留着）', () => {
    expect(splitCapture(['装修这件事', '先去看瓷砖', '', '预算不要超'].join(NEWLINE)))
      .toEqual({ head: '装修这件事', body: ['先去看瓷砖', '', '预算不要超'].join(NEWLINE) });
  });

  it('就一行：标题是它，备注是空串——不能因为加了分行就给单行的也塞点什么', () => {
    expect(splitCapture('给猫买猫粮')).toEqual({ head: '给猫买猫粮', body: '' });
  });

  it('首行是空行：往下找第一个非空行当标题，不是拿一个空标题回去', () => {
    const r = splitCapture(['', '   ', '真正的标题', '备注'].join(NEWLINE));
    expect(r.head).toBe('真正的标题');
    expect(r.body).toBe('备注');
  });

  it('整段都是空白：退回整段（调用方自己有 `if (!title) return` 兜底）', () => {
    expect(splitCapture('   ')).toEqual({ head: '', body: '' });
  });

  it('CRLF：备注每行末尾不留回车符', () => {
    const r = splitCapture(['标题', '第一行备注', '第二行备注'].join(CRLF));
    expect(r.head).toBe('标题');
    expect(r.body).toBe(['第一行备注', '第二行备注'].join(NEWLINE));
    expect(r.body).not.toContain(CR);
  });
});
