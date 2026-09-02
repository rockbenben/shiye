import { describe, it, expect } from 'vitest';
import { parseSmartInput } from './smartInput.js';

/**
 * 全程用**本地墙钟**造时刻，不用 ISO 字符串——这个模块认出来的「明天下午两点」
 * 是本地时区的两点，用 `'2026-08-22T14:00:00Z'` 当期望值会让这份测试只在 UTC
 * 机器上绿。同一条教训见 `server/src/repeat.test.ts` 顶部。
 */
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const iso = (...a: Parameters<typeof local>) => local(...a).toISOString();

// 2026-08-22 是周六。挑周六是因为「周一」「下周一」在这一天答案不同，
// 正好把 nextWeekday 的 includeToday 分支两边都盖到。
const NOW = local(2026, 8, 22, 10, 0);

describe('parseSmartInput：什么都没认出来', () => {
  it('一句纯文字原样返回，hits 是空的——界面靠这个决定不出提示条', () => {
    const r = parseSmartInput('把冰箱清一遍', NOW);
    expect(r).toEqual({ title: '把冰箱清一遍', due: null, remindAt: null, tags: [], repeat: null, context: null, hits: [] });
  });

  it('空串不炸', () => {
    expect(parseSmartInput('', NOW).hits).toEqual([]);
    expect(parseSmartInput('   ', NOW).title).toBe('   ');
  });

  it('认走之后标题就空了（整句就是一个时间）：整份识别作废，原话还回去', () => {
    // 建一条没有标题的任务比不认这一次糟得多——他多半是在打字打到一半。
    expect(parseSmartInput('明天下午两点', NOW)).toEqual({
      title: '明天下午两点', due: null, remindAt: null, tags: [], repeat: null, context: null, hits: [],
    });
  });
});

describe('parseSmartInput：日期', () => {
  it.each([
    ['今天交周报', iso(2026, 8, 22, 23, 59)],
    ['明天交周报', iso(2026, 8, 23, 23, 59)],
    ['后天交周报', iso(2026, 8, 24, 23, 59)],
    ['大后天交周报', iso(2026, 8, 25, 23, 59)],
    ['下周交周报', iso(2026, 8, 29, 23, 59)],
  ])('%s', (input, due) => {
    expect(parseSmartInput(input, NOW).due).toBe(due);
  });

  it('「大后天」不会被切成「大」+「后天」——长的先认', () => {
    expect(parseSmartInput('大后天交周报', NOW).title).toBe('交周报');
  });

  it('只有日期没有时刻：due 落在那天的 23:59（不是零点，零点会让它当天就被标成已过期），不排提醒', () => {
    const r = parseSmartInput('明天交周报', NOW);
    expect(r.due).toBe(iso(2026, 8, 23, 23, 59));
    // 凭空补一个上午九点是替他定了一个他没说过的闹钟。
    expect(r.remindAt).toBeNull();
  });

  it('周三：最近的那个周三（今天周六，所以是下周三）', () => {
    expect(parseSmartInput('周三体检', NOW).due).toBe(iso(2026, 8, 26, 23, 59));
  });

  it('今天正好是那个星期几时，「周六」是今天、「下周六」是七天后', () => {
    expect(parseSmartInput('周六大扫除', NOW).due).toBe(iso(2026, 8, 22, 23, 59));
    expect(parseSmartInput('下周六大扫除', NOW).due).toBe(iso(2026, 8, 29, 23, 59));
  });

  it('绝对日期：8月30号 / 2027-01-05', () => {
    expect(parseSmartInput('8月30号交房租', NOW).due).toBe(iso(2026, 8, 30, 23, 59));
    expect(parseSmartInput('2027-01-05 年检', NOW).due).toBe(iso(2027, 1, 5, 23, 59));
  });

  it('今年那天已经过去了就算明年——滴答清单对模糊日期的「最近有效」', () => {
    expect(parseSmartInput('1月10号补油漆', NOW).due).toBe(iso(2027, 1, 10, 23, 59));
  });

  it('2月30日这种不存在的日子不认，标题原样留着', () => {
    const r = parseSmartInput('2月30日开会', NOW);
    expect(r.due).toBeNull();
    expect(r.title).toBe('2月30日开会');
  });
});

describe('parseSmartInput：时刻', () => {
  it('明天下午两点：中文数字 + 时段词', () => {
    const r = parseSmartInput('明天下午两点开会', NOW);
    expect(r.due).toBe(iso(2026, 8, 23, 14));
    // 认出了具体时刻就 due 和 reminders 一起写——只写 due 的任务到点只会变红
    // 不会响，是这个仓库反复强调的坑。
    expect(r.remindAt).toBe(r.due);
    expect(r.title).toBe('开会');
  });

  it.each([
    ['明天9点开会', iso(2026, 8, 23, 9)],
    ['明天晚上9点开会', iso(2026, 8, 23, 21)],
    ['明天上午9点半开会', iso(2026, 8, 23, 9, 30)],
    ['明天14:30开会', iso(2026, 8, 23, 14, 30)],
    ['明天十点十五分开会', iso(2026, 8, 23, 10, 15)],
    ['明天中午12点吃饭', iso(2026, 8, 23, 12)],
  ])('%s', (input, due) => {
    expect(parseSmartInput(input, NOW).due).toBe(due);
  });

  it('裸钟点、没说哪天：取最近有效的那一个（此刻上午十点，「9点」指今晚九点）', () => {
    // 滴答清单帮助里的原例。上午 9 点已经过去了，所以是 21:00。
    expect(parseSmartInput('9点提醒我吃药', NOW).due).toBe(iso(2026, 8, 22, 21));
  });

  it('裸钟点、今天两个候选都过去了就落到明天', () => {
    expect(parseSmartInput('9点提醒我吃药', local(2026, 8, 22, 22)).due).toBe(iso(2026, 8, 23, 9));
  });

  it('说了哪天就不做那层推断——「明天9点」是上午九点，不因为此刻是下午被推成晚上', () => {
    expect(parseSmartInput('明天9点开会', local(2026, 8, 22, 16)).due).toBe(iso(2026, 8, 23, 9));
  });

  it('时段词单用不算认出了时刻，整个词还回标题里', () => {
    const r = parseSmartInput('明天下午交周报', NOW);
    expect(r.due).toBe(iso(2026, 8, 23, 23, 59));
    expect(r.remindAt).toBeNull();
    expect(r.title).toBe('下午交周报');
  });
});

describe('parseSmartInput：重复', () => {
  it.each([
    ['每天喝八杯水', { every: 'day', interval: 1, weekdays: [] }],
    ['每周一写周报', { every: 'week', interval: 1, weekdays: [1] }],
    ['每周一三五健身', { every: 'week', interval: 1, weekdays: [1, 3, 5] }],
    ['每月还信用卡', { every: 'month', interval: 1, weekdays: [] }],
    ['每年体检', { every: 'year', interval: 1, weekdays: [] }],
    ['每三天浇花', { every: 'day', interval: 3, weekdays: [] }],
    ['每2周开例会', { every: 'week', interval: 2, weekdays: [] }],
    ['每个工作日打卡', { every: 'week', interval: 1, weekdays: [1, 2, 3, 4, 5] }],
  ])('%s', (input, want) => {
    expect(parseSmartInput(input, NOW).repeat).toMatchObject(want);
  });

  it("认出来的重复一律是到期重复（from: 'due'）——完成重复是他在表单里另点的", () => {
    expect(parseSmartInput('每三天浇花', NOW).repeat?.from).toBe('due');
  });

  it('「每周一」先当重复认掉，剩下的串里没有「周一」再被当成日期认第二遍', () => {
    const r = parseSmartInput('每周一写周报', NOW);
    expect(r.repeat).toMatchObject({ every: 'week', weekdays: [1] });
    expect(r.due).toBeNull();
    expect(r.title).toBe('写周报');
  });

  it('重复 + 日期 + 时刻可以同时出现', () => {
    const r = parseSmartInput('每周一上午9点开例会', NOW);
    expect(r.repeat).toMatchObject({ every: 'week', weekdays: [1] });
    // 今天是周六，最近的周一是 8/24——重复规则点了名星期几，没说哪天就锚在那儿
    expect(r.due).toBe(iso(2026, 8, 24, 9));
    expect(r.title).toBe('开例会');
  });
});

describe('parseSmartInput：标签', () => {
  it('#标签 摘走，一句话里可以有好几个', () => {
    const r = parseSmartInput('交周报 #工作 #紧急', NOW);
    expect(r.tags).toEqual(['工作', '紧急']);
    expect(r.title).toBe('交周报');
  });

  it('全角 ＃ 也认', () => {
    expect(parseSmartInput('交周报 ＃工作', NOW).tags).toEqual(['工作']);
  });

  it('重复的标签只留一个', () => {
    expect(parseSmartInput('交周报 #工作 #工作', NOW).tags).toEqual(['工作']);
  });

  it('标签先摘走，#每周报 里的「每周」不会被当成重复规则', () => {
    const r = parseSmartInput('整理 #每周报', NOW);
    expect(r.tags).toEqual(['每周报']);
    expect(r.repeat).toBeNull();
  });
});

/**
 * `@情境`。GTD 里情境本来就写成 `@电脑前`，而卡片和行上画出来的也正是
 * `@电脑前`——打的和看到的是同一个写法。
 *
 * 这一族里最要紧的是「封闭词表」那两条（`@外出买菜` 切得干净、`@开会` 不认）：
 * 那正是它跟 `#标签` 的分野，也是它不需要识别开关的理由。
 */
describe('parseSmartInput：@情境', () => {
  it('@外出 认出来、从标题里摘掉', () => {
    const r = parseSmartInput('去银行办卡 @外出', NOW);
    expect(r.context).toBe('out');
    expect(r.title).toBe('去银行办卡');
  });

  it('全角 ＠ 也认', () => {
    expect(parseSmartInput('去银行办卡 ＠外出', NOW).context).toBe('out');
  });

  it('五档都认得，认的是 key 不是中文名', () => {
    expect(parseSmartInput('写代码 @电脑前', NOW).context).toBe('computer');
    expect(parseSmartInput('擦窗 @在家', NOW).context).toBe('home');
    expect(parseSmartInput('打电话 @联系人', NOW).context).toBe('contact');
    expect(parseSmartInput('整理桌面 @省力', NOW).context).toBe('easy');
  });

  /**
   * **这条是它跟 `#标签` 的分野。** `takeTags` 认输认得很干脆（「中文里
   * `#工作明天开会` 分不出边界」），所以标签要求后面留个空格。情境的词表是
   * 封闭的五档，边界不用猜。
   */
  it('@外出买菜：词表封闭，切得干干净净——标签那边做不到这件事', () => {
    const r = parseSmartInput('@外出买菜', NOW);
    expect(r.context).toBe('out');
    expect(r.title).toBe('买菜');
  });

  it('@ 后面不是那五个词就不认，原样留在标题里', () => {
    const r = parseSmartInput('@开会 准备材料', NOW);
    expect(r.context).toBeNull();
    expect(r.title).toBe('@开会 准备材料');
  });

  it('**只认行首或空白后面的 @**——邮箱地址里那个不是在标记情境', () => {
    const r = parseSmartInput('回复 zhang@外出', NOW);
    expect(r.context).toBeNull();
    expect(r.title).toBe('回复 zhang@外出');
  });

  it('写了两个：第一个算数，但两个都从标题里摘掉', () => {
    const r = parseSmartInput('买菜 @外出 @在家', NOW);
    expect(r.context).toBe('out');
    expect(r.title).toBe('买菜');
  });

  it('摘掉之后左右不粘在一起', () => {
    expect(parseSmartInput('买菜 @外出 顺便取快递', NOW).title).toBe('买菜 顺便取快递');
  });

  it('整句就是一个情境：跟「整句就是一个时间」同一条——识别作废，原话还回去', () => {
    const r = parseSmartInput('@外出', NOW);
    expect(r.title).toBe('@外出');
    expect(r.context).toBeNull();
    expect(r.hits).toEqual([]);
  });

  /**
   * 那四个开关是给**会误判**的识别用的（「3 月 5 号那版方案」）。`@` 后面必须
   * 紧跟五个固定词之一，误伤不了，所以它不受那几个开关管——关掉标签和日期，
   * 情境照样认。
   */
  it('识别开关关掉也照样认——它不在那四个开关的管辖里', () => {
    const r = parseSmartInput('明天 去银行办卡 #杂事 @外出', NOW, { date: false, tag: false });
    expect(r.context).toBe('out');
  });

  it('跟标签、日期一起用：各认各的', () => {
    const r = parseSmartInput('明天 去银行办卡 #杂事 @外出', NOW);
    expect(r.context).toBe('out');
    expect(r.tags).toEqual(['杂事']);
    expect(r.due).not.toBeNull();
    expect(r.title).toBe('去银行办卡');
  });

  it('hits 里有它，界面那条提示才说得出来', () => {
    expect(parseSmartInput('去银行办卡 @外出', NOW).hits).toContain('@外出');
  });
});

describe('parseSmartInput：hits 是给界面看的人话', () => {
  it('认出几样就有几条，界面拿它画提示条', () => {
    const r = parseSmartInput('明天下午两点交周报 #工作', NOW);
    expect(r.hits).toEqual(['#工作', '明天 下午两点']);
  });

  it('什么都没认出来时是空数组，不是 [""]——界面靠长度决定出不出提示条', () => {
    expect(parseSmartInput('把冰箱清一遍', NOW).hits).toHaveLength(0);
  });
});

/**
 * 相对时间（仿滴答清单的自然语言识别）。「三天后交报告」这类说法在中文里
 * 比「下周三」还常见，而这个解析器原来一个都不认——认出来的只有固定词
 * （明天/后天/下周三）和绝对日期。
 */
describe('parseSmartInput：N 天后 / N 周后 / N 个月后 / N 年后', () => {
  // NOW 是 2026-08-22（周六）上午，跟这个文件其余用例同一个锚点。
  const day = (s: string) => parseSmartInput(s, NOW).due!.slice(0, 10);
  const localDay = (plus: number) => {
    const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + plus, 23, 59);
    return d.toISOString().slice(0, 10);
  };

  it('阿拉伯数字和中文数字都认', () => {
    expect(day('3天后交报告')).toBe(localDay(3));
    expect(day('三天后交报告')).toBe(localDay(3));
  });

  it('「两」也算 2——中文里说「两天后」不说「二天后」', () => {
    expect(day('两天后交报告')).toBe(localDay(2));
  });

  it('十几、二十几都认', () => {
    expect(day('十天后交报告')).toBe(localDay(10));
    expect(day('十五天后交报告')).toBe(localDay(15));
  });

  it('「以后」「之后」跟「后」等价——只认一种是在让人猜', () => {
    expect(day('三天以后交报告')).toBe(localDay(3));
    expect(day('三天之后交报告')).toBe(localDay(3));
  });

  it('N 周后 / N 个星期后 / N 个礼拜后', () => {
    for (const s of ['两周后交报告', '两个星期后交报告', '两个礼拜后交报告']) {
      expect(day(s), s).toBe(localDay(14));
    }
  });

  it('N 个月后', () => {
    const d = new Date(NOW.getFullYear(), NOW.getMonth() + 2, NOW.getDate(), 23, 59);
    expect(day('两个月后交报告')).toBe(d.toISOString().slice(0, 10));
  });

  /**
   * **N 年后**是这一族的第四个，补的是 Things 明写而我们独缺的那一档
   * （《Using Natural Language Input》：「Use *w* for weeks,
   * *mo* for months, and *y* for years」）。「两年后换护照」「三年后车检」
   * 这类事天然就是按年说的。
   */
  it('N 年后', () => {
    const d = new Date(NOW.getFullYear() + 2, NOW.getMonth(), NOW.getDate(), 23, 59);
    expect(day('两年后换护照')).toBe(d.toISOString().slice(0, 10));
    expect(day('3年后车检')).toBe(
      new Date(NOW.getFullYear() + 3, NOW.getMonth(), NOW.getDate(), 23, 59).toISOString().slice(0, 10),
    );
  });

  it('「N 年以后」「N 年之后」也认——跟天/周/月那三档一条规矩', () => {
    const want = new Date(NOW.getFullYear() + 1, NOW.getMonth(), NOW.getDate(), 23, 59).toISOString().slice(0, 10);
    expect(day('一年以后换护照')).toBe(want);
    expect(day('一年之后换护照')).toBe(want);
  });

  it('**「年」不会把「明年」「今年」这种词吃掉**——那要求「年」后面紧跟「后」', () => {
    // 「明年」现在不认（认不出来就是不认），关键是它不该被「N 年后」错认成
    // 某个偏移——`cnNum('明')` 认不出数字，这一档会放行给后面的规则。
    const r = parseSmartInput('明年再说', NOW);
    expect(r.due).toBeNull();
    expect(r.title).toBe('明年再说');
  });

  it('认走之后标题里不留那一段', () => {
    expect(parseSmartInput('三天后交报告', NOW).title).toBe('交报告');
    expect(parseSmartInput('两年后换护照', NOW).title).toBe('换护照');
  });

  it('提示条上说的是人话', () => {
    expect(parseSmartInput('三天后交报告', NOW).hits).toContain('3天后');
  });

  it('跟时刻一起用', () => {
    const r = parseSmartInput('三天后下午三点开会', NOW);
    expect(r.due!.slice(0, 10)).toBe(localDay(3));
    expect(new Date(r.due!).getHours()).toBe(15);
    // 认出了时刻就该有提醒——只写 due 的任务到点只会变红、不会响。
    expect(r.remindAt).toBe(r.due);
  });

  it('**「后天」不受影响**——「三天后」里没有「后天」，两个模式不打架', () => {
    expect(day('后天交报告')).toBe(localDay(2));
    expect(parseSmartInput('后天交报告', NOW).hits).toContain('后天');
  });

  it('「零天后」不认——当 0 会变成今天，而他压根没这么说', () => {
    expect(parseSmartInput('零天后交报告', NOW).due).toBeNull();
  });

  it('认不出数字的整段不认，原话留在标题里', () => {
    const r = parseSmartInput('很多天后交报告', NOW);
    expect(r.due).toBeNull();
    expect(r.title).toBe('很多天后交报告');
  });
});

/**
 * 「半小时后」这一批。跟「N 天后」形状不同：那几个只定哪一天（落 23:59、
 * 不排提醒），这几个定的是**一个瞬间**——说这句话的人要的就是到点响一声。
 */
describe('parseSmartInput：半小时后 / N 小时后 / N 分钟后', () => {
  const at = (s: string) => new Date(parseSmartInput(s, NOW).due!);

  it('半小时后：NOW 是 10:00，落在 10:30', () => {
    const d = at('半小时后提醒我');
    expect([d.getHours(), d.getMinutes()]).toEqual([10, 30]);
  });

  it('N 小时后 / N 分钟后，中文阿拉伯都认', () => {
    expect(at('两小时后开会').getHours()).toBe(12);
    expect(at('2小时后开会').getHours()).toBe(12);
    expect(at('45分钟后开会').getMinutes()).toBe(45);
    expect(at('45分后开会').getMinutes()).toBe(45);
  });

  it('**跨天由 Date 自己进位**——晚上十一点说「三小时后」落在明天凌晨两点', () => {
    const late = local(2026, 8, 22, 23, 0);
    const d = new Date(parseSmartInput('三小时后起床', late).due!);
    expect(d.getDate()).toBe(23);
    expect(d.getHours()).toBe(2);
  });

  it('**同时排一条提醒**——说这句话的人要的就是到点响一声', () => {
    const r = parseSmartInput('半小时后提醒我看火', NOW);
    expect(r.remindAt).toBe(r.due);
  });

  it('跟「N 天后」的区别：那几个只定哪一天，落 23:59、不排提醒', () => {
    const r = parseSmartInput('三天后交报告', NOW);
    expect(new Date(r.due!).getHours()).toBe(23);
    expect(r.remindAt).toBeNull();
  });

  it('认走之后标题里不留那一段，提示条上说人话', () => {
    const r = parseSmartInput('半小时后提醒我看火', NOW);
    expect(r.title).toBe('提醒我看火');
    expect(r.hits).toContain('半小时后');
  });

  it('**不做「最近有效」的推断**——算出来的钟点已经是确切的 24 小时制值', () => {
    // 上午 10:00 + 5 小时 = 15:00，不该被当成裸钟点再推成明天或者别的什么。
    expect(at('五小时后开会').getHours()).toBe(15);
  });

  it('「零分钟后」「认不出数字」都不认，原话留在标题里', () => {
    for (const s of ['零分钟后开会', '很多小时后开会']) {
      expect(parseSmartInput(s, NOW).due, s).toBeNull();
    }
  });

  it('**「三天后」不会被「N 分钟后」那条误吃**——两批模式各认各的量词', () => {
    const r = parseSmartInput('三天后交报告', NOW);
    expect(r.hits).toContain('3天后');
  });
});

/**
 * 两处「吃字」——同一个形状：日期这一步把一个后面还要用的字整个吞掉了。
 * 两个都是实测出来的，不是想出来的。
 */
describe('parseSmartInput：「下下周」不能只认一个「下」', () => {
  it('下下周三 = 下周三再加一周，而且「下」不留在标题里', () => {
    const r = parseSmartInput('下下周三开会', NOW);
    // 2026-08-22 是周六：下周三 = 9/2 的前一周即 8/26，下下周三 = 9/2。
    expect(r.due).toBe(iso(2026, 9, 2, 23, 59));
    // 只认一个「下」时，这里曾经是「下开会」——日期少算一周，标题还被改坏了。
    expect(r.title).toBe('开会');
    expect(r.hits).toEqual(['下下周三']);
  });

  it('下下周 / 下下个月同理', () => {
    expect(parseSmartInput('下下周开会', NOW).title).toBe('开会');
    expect(parseSmartInput('下下周开会', NOW).due).toBe(iso(2026, 9, 5, 23, 59));
    expect(parseSmartInput('下下个月交表', NOW).title).toBe('交表');
    expect(parseSmartInput('下下个月交表', NOW).due).toBe(iso(2026, 10, 22, 23, 59));
  });

  it('**`下+` 不是 `下{1,2}`**：后者在「下下下周」上会犯一模一样的错，而按几个「下」乘几周本来就是这个说法的意思', () => {
    const r = parseSmartInput('下下下周开会', NOW);
    expect(r.title).toBe('开会');
    expect(r.due).toBe(iso(2026, 9, 12, 23, 59));
  });

  it('一个「下」的照旧', () => {
    expect(parseSmartInput('下周三开会', NOW).due).toBe(iso(2026, 8, 26, 23, 59));
    expect(parseSmartInput('下个月交表', NOW).due).toBe(iso(2026, 9, 22, 23, 59));
  });
});

describe('parseSmartInput：「今晚」「明早」里那个字兼着说时段', () => {
  it('**今晚八点是晚上八点**，不是上午八点——`PERIODS` 里一直列着「今晚」，但日期这一步先把「晚」吃掉了，永远轮不到它', () => {
    const r = parseSmartInput('今晚八点开会', NOW);
    expect(r.due).toBe(iso(2026, 8, 22, 20, 0));
    expect(r.remindAt).toBe(iso(2026, 8, 22, 20, 0));
    expect(r.hits).toEqual(['今天 晚上八点']);
  });

  it('明晚八点 = 明天二十点', () => {
    expect(parseSmartInput('明晚八点开会', NOW).due).toBe(iso(2026, 8, 23, 20, 0));
  });

  it('明早九点 = 明天九点（这个以前碰巧是对的：早上本来就不用加 12）', () => {
    expect(parseSmartInput('明早九点开会', NOW).due).toBe(iso(2026, 8, 23, 9, 0));
  });

  it('**他明写的时段压过这个兜底**——「今晚下午三点」自相矛盾，以写出来的那个为准', () => {
    expect(parseSmartInput('今晚下午三点开会', NOW).due).toBe(iso(2026, 8, 22, 15, 0));
  });

  it('没跟钟点时一个字都不多认——「明早开会」还是「开会」+ 明天，不会变成「早上开会」', () => {
    const r = parseSmartInput('明早开会', NOW);
    expect(r.title).toBe('开会');
    expect(r.due).toBe(iso(2026, 8, 23, 23, 59));
    expect(r.remindAt).toBeNull();
  });

  it('「今天」「明天」这种不带时段的，裸钟点照旧走原来那条推断', () => {
    // 今天 8 点已经过去了（现在 10 点），但显式说了「今天」就不顺延——
    // 这条是原有行为，兜底那一步不该把它带偏。
    expect(parseSmartInput('今天八点开会', NOW).due).toBe(iso(2026, 8, 22, 8, 0));
  });
});

/**
 * 两个模糊日期词（仿滴答清单的自然语言识别）。「月底交报表」「周末去爬山」是
 * 日常说法，在这之前一个字都认不出来，整句原样留在标题里。
 */
describe('parseSmartInput：周末 / 月底', () => {
  it('周末 = 最近的周六', () => {
    // NOW 是 2026-08-22 周六。
    expect(parseSmartInput('周末去爬山', NOW).due).toBe(iso(2026, 8, 22, 23, 59));
    expect(parseSmartInput('周末去爬山', local(2026, 8, 24, 10)).due).toBe(iso(2026, 8, 29, 23, 59));
  });

  it('**今天是周日时就是今天**——周日本来就在周末里，把它推到六天后不合常理', () => {
    expect(parseSmartInput('周末去爬山', local(2026, 8, 23, 10)).due).toBe(iso(2026, 8, 23, 23, 59));
  });

  it('本周末 / 这周末跟「周末」一样；下周末再加一周，下下周末再加一周', () => {
    const mon = local(2026, 8, 24, 10);
    expect(parseSmartInput('本周末去爬山', mon).due).toBe(iso(2026, 8, 29, 23, 59));
    expect(parseSmartInput('这周末去爬山', mon).due).toBe(iso(2026, 8, 29, 23, 59));
    expect(parseSmartInput('下周末去爬山', mon).due).toBe(iso(2026, 9, 5, 23, 59));
    expect(parseSmartInput('下下周末去爬山', mon).due).toBe(iso(2026, 9, 12, 23, 59));
  });

  it('**「周末」要排在所有「周…」之前**：不然「下周」先被吃掉，「末」留在标题里', () => {
    expect(parseSmartInput('下周末去爬山', local(2026, 8, 24, 10)).title).toBe('去爬山');
  });

  it('周末后面还能跟钟点', () => {
    const r = parseSmartInput('周末上午十点爬山', local(2026, 8, 24, 10));
    expect(r.due).toBe(iso(2026, 8, 29, 10, 0));
    expect(r.hits).toEqual(['周末 上午十点']);
  });

  it('月底 = 那个月的最后一天，二月也对', () => {
    expect(parseSmartInput('月底结账', local(2026, 8, 24, 10)).due).toBe(iso(2026, 8, 31, 23, 59));
    expect(parseSmartInput('月底结账', local(2027, 2, 3, 10)).due).toBe(iso(2027, 2, 28, 23, 59));
    expect(parseSmartInput('月底结账', local(2028, 2, 3, 10)).due).toBe(iso(2028, 2, 29, 23, 59));
  });

  it('本月底 / 这个月底一样；下个月底、下下个月底往后推', () => {
    const d = local(2026, 8, 24, 10);
    expect(parseSmartInput('本月底结账', d).due).toBe(iso(2026, 8, 31, 23, 59));
    expect(parseSmartInput('这个月底结账', d).due).toBe(iso(2026, 8, 31, 23, 59));
    expect(parseSmartInput('下个月底结账', d).due).toBe(iso(2026, 9, 30, 23, 59));
    expect(parseSmartInput('下下个月底结账', d).due).toBe(iso(2026, 10, 31, 23, 59));
  });

  it('**「月底」要排在「下个月」之前**：不然「下个月」先被吃掉，「底」留在标题里', () => {
    expect(parseSmartInput('下个月底结账', local(2026, 8, 24, 10)).title).toBe('结账');
    // 上限：「下个月」这条本身没被改坏。
    expect(parseSmartInput('下个月交表', local(2026, 8, 24, 10)).due).toBe(iso(2026, 9, 24, 23, 59));
  });

  it('顺手吃掉后面的「前」/「之前」——日期是同一个，不吃的话标题会变成「前交表」', () => {
    expect(parseSmartInput('月底前交表', local(2026, 8, 24, 10)).title).toBe('交表');
    expect(parseSmartInput('月底之前交表', local(2026, 8, 24, 10)).title).toBe('交表');
    expect(parseSmartInput('周末前收拾好', local(2026, 8, 24, 10)).title).toBe('收拾好');
  });

  it('「每周末」是每周六，**排在「每周」之前**——不然「末」会留在标题里', () => {
    const r = parseSmartInput('每周末大扫除', local(2026, 8, 24, 10));
    expect(r.title).toBe('大扫除');
    expect(r.repeat).toMatchObject({ every: 'week', weekdays: [6] });
    expect(r.hits).toEqual(['每周末']);
    // 上限：「每周一」这条没被改坏。
    expect(parseSmartInput('每周一开会', local(2026, 8, 24, 10)).repeat).toMatchObject({ weekdays: [1] });
  });
});

/**
 * 「每周一到周五」「每周三和周五」——比连写的「每周一三五」常见得多，而在这
 * 之前它们会各错两样：只收到第一个星期几，剩下那个被**日期**那一步当成一个
 * 具体日期吃掉（凭空多出一个截止日），分隔符留在标题里。
 */
describe('parseSmartInput：每周几，连写 / 分隔 / 区间', () => {
  const MON = local(2026, 8, 24, 10);
  const wd = (s: string) => parseSmartInput(s, MON).repeat?.weekdays;

  it('区间：每周一到周五 = 周一到周五五天', () => {
    const r = parseSmartInput('每周一到周五晨会', MON);
    expect(r.repeat?.weekdays).toEqual([1, 2, 3, 4, 5]);
    // 修之前这里是「到晨会」，而且还多出一个 8/28 的截止日。
    expect(r.title).toBe('晨会');
    expect(r.due).toBeNull();
  });

  it('分隔：和 / 、 / ， / 空格都认，中间多写一个「周」也认', () => {
    expect(wd('每周三和周五开会')).toEqual([3, 5]);
    expect(wd('每周一、三、五健身')).toEqual([1, 3, 5]);
    expect(wd('每周一,三开会')).toEqual([1, 3]);
    expect(wd('每周一 三 五开会')).toEqual([1, 3, 5]);
  });

  it('连写的老写法一个字没变', () => {
    expect(wd('每周一三五健身')).toEqual([1, 3, 5]);
    expect(wd('每周一开会')).toEqual([1]);
  });

  it('**区间按中文一周的顺序算**：「一至日」是整周——周日在 getDay() 里是 0、排在周一前面，直接按数字展开会得到空集', () => {
    expect(wd('每周一至周日打卡')).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(wd('每周六到周日休息')).toEqual([0, 6]);
  });

  it('**端点反过来（「五到一」）不展开**，只收两个端点——猜它是跨周还是写反了都是在替他决定', () => {
    expect(wd('每周五到周一值班')).toEqual([1, 5]);
  });

  it('后面不是星期几就停下，不乱吃', () => {
    const r = parseSmartInput('每周一和小李开会', MON);
    expect(r.repeat?.weekdays).toEqual([1]);
    expect(r.title).toBe('和小李开会');
  });

  it('「每周末」照旧是每周六——「末」不在星期几那张表里，抢不走', () => {
    expect(wd('每周末大扫除')).toEqual([6]);
  });
});

/**
 * 「每月15号」「每月底」。修之前这两句各错两样：「每月」被吃掉、「15号」/「底」
 * 原样留在标题里（任务叫「15号交房租」「底结账」），而那条月重复没有任何锚点
 * ——`Repeat` 里没有「几号」这个字段，月重复靠任务自己的 `due` 定锚。
 */
describe('parseSmartInput：每月几号 / 每月底', () => {
  const AUG24 = local(2026, 8, 24, 10);

  it('每月15号：重复是「每月」，due 落在下一个 15 号', () => {
    const r = parseSmartInput('每月15号交房租', AUG24);
    expect(r.title).toBe('交房租');
    expect(r.repeat).toMatchObject({ every: 'month' });
    expect(r.due).toBe(iso(2026, 9, 15, 23, 59));
  });

  it('这个月的那天还没过就是这个月，当天也算', () => {
    expect(parseSmartInput('每月15号交房租', local(2026, 8, 10, 10)).due).toBe(iso(2026, 8, 15, 23, 59));
    expect(parseSmartInput('每月15号交房租', local(2026, 8, 15, 10)).due).toBe(iso(2026, 8, 15, 23, 59));
  });

  it('**没有 31 号的月份跳过去**——`new Date(y, 5, 31)` 在 6 月会溢出成 7 月 1 日，那是另一天', () => {
    expect(parseSmartInput('每月31号盘点', local(2026, 6, 10, 10)).due).toBe(iso(2026, 7, 31, 23, 59));
  });

  it('每月底 / 每月最后一天：落在这个月的最后一天', () => {
    expect(parseSmartInput('每月底结账', AUG24).due).toBe(iso(2026, 8, 31, 23, 59));
    expect(parseSmartInput('每月最后一天结账', AUG24).title).toBe('结账');
    expect(parseSmartInput('每月最后一天结账', AUG24).due).toBe(iso(2026, 8, 31, 23, 59));
  });

  it('「每个月10号」也认', () => {
    expect(parseSmartInput('每个月10号还款', AUG24).due).toBe(iso(2026, 9, 10, 23, 59));
  });

  it('后面还能跟钟点', () => {
    const r = parseSmartInput('每月5号上午九点例会', AUG24);
    expect(r.due).toBe(iso(2026, 9, 5, 9, 0));
    expect(r.remindAt).toBe(iso(2026, 9, 5, 9, 0));
  });

  it('**这一支不看有没有认出时刻**，跟「每周一」不一样——星期几进了 repeat.weekdays 什么都没丢，「几号」在 Repeat 里无处可存，不安 due 就真丢了', () => {
    expect(parseSmartInput('每周一写周报', AUG24).due).toBeNull();
    expect(parseSmartInput('每月1号交房租', AUG24).due).toBe(iso(2026, 9, 1, 23, 59));
  });

  it('光说「每月」照旧不安 due', () => {
    const r = parseSmartInput('每月交房租', AUG24);
    expect(r.repeat).toMatchObject({ every: 'month' });
    expect(r.due).toBeNull();
  });

  it('**裸的「N号」照旧不当日期**——「号」是个高频量词，当日期认会把标题改坏', () => {
    expect(parseSmartInput('买3号电池', AUG24)).toMatchObject({ title: '买3号电池', due: null });
    expect(parseSmartInput('1号线换乘', AUG24).title).toBe('1号线换乘');
  });

  it('不是合法的号数就不认那一段，原样留着', () => {
    const r = parseSmartInput('每月32号', AUG24);
    expect(r.due).toBeNull();
    expect(r.title).toBe('32号');
  });
});

/**
 * 「每晚十点睡觉」这类「每 + 时段」。修之前这句话会错两样：认不出重复（「每」和
 * 「晚」原样留在标题里，任务叫「每晚睡觉」），而「十点」成了裸钟点走「最近有效」
 * 的推断——**早上七点说这句话，候选是 10:00 和 22:00，10:00 还没过，于是落在
 * 上午十点**。
 */
describe('parseSmartInput：每晚 / 每早', () => {
  const AM7 = local(2026, 8, 24, 7);

  it('每晚十点 = 每天 + 晚上十点，不是上午十点', () => {
    const r = parseSmartInput('每晚十点睡觉', AM7);
    expect(r.title).toBe('睡觉');
    expect(r.repeat).toMatchObject({ every: 'day' });
    expect(r.due).toBe(iso(2026, 8, 24, 22, 0));
    expect(r.hits).toEqual(['每晚', '晚上十点']);
  });

  it('每早八点 = 每天 + 早上八点', () => {
    expect(parseSmartInput('每早八点起床', AM7).due).toBe(iso(2026, 8, 24, 8, 0));
  });

  it('每夜十一点也认', () => {
    expect(parseSmartInput('每夜十一点睡', AM7).due).toBe(iso(2026, 8, 24, 23, 0));
  });

  it('不跟钟点时只认出重复，标题干净', () => {
    const r = parseSmartInput('每晚跑步', AM7);
    expect(r.title).toBe('跑步');
    expect(r.repeat).toMatchObject({ every: 'day' });
    expect(r.due).toBeNull();
  });

  it('**「每早上八点」整词吃掉，「每早上班」一个字都不动**——两句前四个字一模一样，判据只能看后面有没有钟点', () => {
    expect(parseSmartInput('每早上八点起床', AM7).title).toBe('起床');
    expect(parseSmartInput('每早上八点起床', AM7).due).toBe(iso(2026, 8, 24, 8, 0));
    // 「上」属于「上班」。认不出重复是可以的，把标题改成「班」不行——
    // 少认一次是漏，改坏标题是错。
    expect(parseSmartInput('每早上班', AM7)).toMatchObject({ title: '每早上班', repeat: null, due: null });
    expect(parseSmartInput('每晚上班', AM7)).toMatchObject({ title: '每晚上班', repeat: null });
  });

  it('「每晚上十点」走长的那一支（后面有钟点），「晚上」整个是时段', () => {
    expect(parseSmartInput('每晚上十点睡觉', AM7).due).toBe(iso(2026, 8, 24, 22, 0));
  });

  it('原来的「每天晚上八点」一个字没变——那条走的是「每天」+ 时段词，不经这两条新规则', () => {
    const r = parseSmartInput('每天晚上八点睡觉', AM7);
    expect(r.due).toBe(iso(2026, 8, 24, 20, 0));
    expect(r.hits).toEqual(['每天', '晚上八点']);
  });

  it('「每天」「每周一」这些不受影响', () => {
    expect(parseSmartInput('每天喝水', AM7).hits).toEqual(['每天']);
    expect(parseSmartInput('每周一开会', AM7).hits).toEqual(['每周一']);
  });
});

/**
 * 这一轮修的三件事，都是「拿字符串拼正则」这一族的：
 * ① 模板字符串里的 `\s` 静静地变成字母 `s`（九处），带空格的写法一直认不出来；
 * ② `NUM` 自带一层括号，混进断言里会把后面捕获组的编号顶掉一位；
 * ③ 表达不了的说法要**整句不认**，不能拆成一个错的答案。
 */
describe('parseSmartInput：带空格照样认（模板字符串里的 \s）', () => {
  const NOW2 = local(2026, 8, 24, 10);
  it.each([
    ['3 天后交表', iso(2026, 8, 27, 23, 59)],
    ['2 周后复查', iso(2026, 9, 7, 23, 59)],
    ['45 分钟后出门', iso(2026, 8, 24, 10, 45)],
    ['2 小时后开会', iso(2026, 8, 24, 12, 0)],
    ['每月 15 号交房租', iso(2026, 9, 15, 23, 59)],
  ])('%s', (text, due) => {
    expect(parseSmartInput(text, NOW2).due).toBe(due);
  });

  it('不带空格的老写法一个字没变', () => {
    expect(parseSmartInput('3天后交表', NOW2).due).toBe(iso(2026, 8, 27, 23, 59));
  });
});

describe('parseSmartInput：表达不了的「第几个星期几」整句不认', () => {
  const NOW2 = local(2026, 8, 24, 10);

  it.each([
    '每月第一个周一开会',
    '每月最后一个周五复盘',
    '每月第2个周三例会',
    '每月第一个星期一开会',
    '下个月第一个周一开会',
    '第一个周一开会',
  ])('%s：原话还回去，什么都不认', (text) => {
    expect(parseSmartInput(text, NOW2)).toEqual({
      title: text, due: null, remindAt: null, tags: [], repeat: null, context: null, hits: [],
    });
  });

  it('**为什么不是只在重复那一步不认**：不管的话「周一」会被日期那一步当成一个具体日期吃掉，变成一条叫「每月第一个开会」、排在这周一的任务——认不出的说法被拆成了一个错的答案', () => {
    // 这条钉的是上面那组的理由，用一句真的会走到日期那一步的话来说明：
    // 去掉「第一个」之后，「周一」确实是个日期。
    expect(parseSmartInput('每月周一开会', NOW2).due).not.toBeNull();
  });

  it('「每月第一天」不在拦截范围里——那个能表达（就是 1 号）', () => {
    const r = parseSmartInput('每月第一天结账', NOW2);
    expect(r.title).toBe('结账');
    expect(r.repeat).toMatchObject({ every: 'month', monthDay: 1 });
    expect(r.due).toBe(iso(2026, 9, 1, 23, 59));
  });

  it('**「天」这个量词必须跟着「第」**——不然「每月3天假」会被读成「每月 3 号」，标题只剩「假」', () => {
    // “每月”还是会被当成月重复（那句话确实这么说了），**但不能拿到一个
    // 「3 号」的锚点和一个截止日期**——那才是编出来的。
    const r = parseSmartInput('每月3天假', NOW2);
    expect(r.repeat?.monthDay ?? null).toBeNull();
    expect(r.due).toBeNull();
    expect(r.title).toBe('3天假');
  });
});

/**
 * 「每季度」「每半年」「每隔一天」。这三句在这之前一个字都认不出来（原话
 * 原样留在标题里，不是认错，是没认），而它们都是很常见的说法。
 */
describe('parseSmartInput：每季度 / 每半年 / 每隔一天', () => {
  const NOW3 = local(2026, 8, 24, 10);
  const rep = (s: string) => parseSmartInput(s, NOW3).repeat;

  it('每季度 = 每 3 个月，每半年 = 每 6 个月——不新增 every 档位，它们在模型里就是月加一个 interval', () => {
    expect(rep('每季度汇报')).toMatchObject({ every: 'month', interval: 3 });
    expect(rep('每个季度汇报')).toMatchObject({ every: 'month', interval: 3 });
    expect(rep('每半年体检')).toMatchObject({ every: 'month', interval: 6 });
    expect(parseSmartInput('每季度汇报', NOW3).title).toBe('汇报');
  });

  it('每隔一天 = 每 2 天', () => {
    expect(rep('每隔一天浇花')).toMatchObject({ every: 'day', interval: 2 });
    expect(parseSmartInput('每隔一天浇花', NOW3).title).toBe('浇花');
  });

  it('**「每隔两天」「每隔三天」不认**——严格讲是每 3 天 / 每 4 天，口语里不少人指每 2 天 / 每 3 天；猜哪一个都是替他做决定，而猜错了他看不出来（卡片上写「每 3 天」，他写的是「每隔两天」）', () => {
    for (const s of ['每隔两天浇花', '每隔三天浇花', '每隔5天浇花']) {
      expect(parseSmartInput(s, NOW3)).toMatchObject({ title: s, repeat: null });
    }
  });

  it('**裸的「隔天」也不认**——它在中文里还有「第二天」那个意思（「隔天再打一次电话」是一次性的）', () => {
    expect(parseSmartInput('隔天见', NOW3)).toMatchObject({ title: '隔天见', repeat: null });
    expect(parseSmartInput('隔天浇花', NOW3)).toMatchObject({ title: '隔天浇花', repeat: null });
  });

  it('原来那几档一个字没变', () => {
    expect(rep('每天喝水')).toMatchObject({ every: 'day', interval: 1 });
    expect(rep('每两个月体检')).toMatchObject({ every: 'month', interval: 2 });
    expect(rep('每周一开会')).toMatchObject({ every: 'week', weekdays: [1] });
  });
});

/**
 * 识别开关（仿滴答清单「更多设置 → 智能识别」）。
 *
 * 值得有的理由：这套识别是本机一条正则，它会误判——「3 月 5 号那版方案」里
 * 的「3 月 5 号」是标题的一部分，不是截止日期。在有开关之前，唯一的躲法是
 * 每建一条再手工改回来。
 */
describe('parseSmartInput：识别开关', () => {
  const NOW = new Date(2026, 7, 24, 10, 0, 0);

  it('不给 opts = 四个全开，跟加这组开关之前一字不差', () => {
    const a = parseSmartInput('明天下午两点交周报 #工作', NOW);
    const b = parseSmartInput('明天下午两点交周报 #工作', NOW, { date: true, stripDate: true, tag: true, stripTag: true });
    expect(a).toEqual(b);
    expect(a.title).toBe('交周报');
  });

  it('关掉日期识别：日期原样留在标题里，due/提醒都不设', () => {
    const r = parseSmartInput('明天下午两点交周报', NOW, { date: false });
    expect(r.title).toBe('明天下午两点交周报');
    expect(r.due).toBeNull();
    expect(r.remindAt).toBeNull();
  });

  it('**关掉日期识别连重复规则一起关**——认出来的重复和它的锚点日期是同一次识别的两半，只关一半会留下一条没有锚点的重复：那种任务在「今天」里永远不出现、也不会响', () => {
    const on = parseSmartInput('每周一写周报', NOW);
    expect(on.repeat).not.toBeNull();
    const off = parseSmartInput('每周一写周报', NOW, { date: false });
    expect(off.repeat).toBeNull();
    expect(off.title).toBe('每周一写周报');
  });

  it('关掉标签识别：`#工作` 原样留在标题里，tags 是空的', () => {
    const r = parseSmartInput('交周报 #工作', NOW, { tag: false });
    expect(r.tags).toEqual([]);
    expect(r.title).toBe('交周报 #工作');
  });

  it('**认了但不摘日期**：due 照设，日期那几个字留在标题里——「10 月 1 日国庆值班」摘掉日期就只剩「国庆值班」，而那个日期本来就是标题的一部分', () => {
    const r = parseSmartInput('明天下午两点交周报', NOW, { stripDate: false });
    expect(r.due).not.toBeNull();
    expect(r.title).toBe('明天下午两点交周报');
  });

  it('认了但不摘标签：tags 照设，`#工作` 还在标题里', () => {
    const r = parseSmartInput('交周报 #工作', NOW, { stripTag: false });
    expect(r.tags).toEqual(['工作']);
    expect(r.title).toBe('交周报 #工作');
  });

  it('两个「不摘」一起开：整句原样，但 due 和 tags 都设上了', () => {
    const r = parseSmartInput('明天下午两点交周报 #工作', NOW, { stripDate: false, stripTag: false });
    expect(r.due).not.toBeNull();
    expect(r.tags).toEqual(['工作']);
    expect(r.title).toBe('明天下午两点交周报 #工作');
  });

  it('**标签仍然先摘再接回**——不先摘的话 `#每周报` 里的「每周」会被当成重复规则', () => {
    const r = parseSmartInput('看 #每周报', NOW, { stripTag: false });
    expect(r.repeat).toBeNull();
    expect(r.tags).toEqual(['每周报']);
  });
});

/**
 * 「提前 N 提醒」——《智能识别》 把「提前提醒」单列成一节，
 * 而在这一档之前这半句既不生效、也不从标题里摘掉：**「明天下午三点开会提前
 * 半小时提醒」的标题会变成「开会提前半小时提醒」**，比单纯不认更糟。
 *
 * **出处只有一个标题**：那一节的正文在滴答原站是图片，副本里只剩标题，所以
 * 「滴答具体认哪些写法」查不到。这里只认中文里最直白的那一种。
 */
describe('parseSmartInput：提前 N 提醒', () => {
  /**
   * **中间带空格也要认。**
   *
   * 那条正则原来写的是模板字符串里的单反斜杠 `\s`，而这个文件头部就警告过：
   * **模板字符串里写 `\s` 等于写字母 `s`**——一个“未知转义”，静静地不报错。
   * 于是那个正则实际匹配的是「零个或多个字母 s」。
   *
   * 后果实测过，而且比不认更糟（上面那段注释说的正是这个）：
   * 「明天下午三点开会 提前 30 分钟提醒」→ `remindAt` **等于 `due`**（提前量被丢），
   * 而且「提前 30 分钟提醒」那半句**留在标题里**。不带空格的写法一直是对的，
   * 所以这条从没被发现。这个文件里另外 13 处 `new RegExp` 都写的双反斜杠。
   */
  it('中间的空格要吃掉——不吃的话提前量被丢、那半句还留在标题里', () => {
    const r = parseSmartInput('明天下午三点开会 提前 30 分钟提醒', new Date(2026, 8, 3, 9));
    expect(r.title, '那半句没从标题里摘掉').toBe('开会');
    expect(r.remindAt, '提前量被丢了：remindAt 等于 due').not.toBe(r.due);
    expect(Date.parse(r.due!) - Date.parse(r.remindAt!)).toBe(30 * 60_000);
  });

  // 反向铁证：退化成字母 `s` 的时候这句是**认得出**的。它认不出来，才说明
  // 那个位置真的是空白类。
  it('「提前sss30分钟提醒」不该被认出来', () => {
    const r = parseSmartInput('明天下午三点开会 提前sss30分钟提醒', new Date(2026, 8, 3, 9));
    expect(r.title).toContain('提前sss30分钟提醒');
    expect(r.remindAt).toBe(r.due);
  });

  const at = (h: number, mi = 0, plusDay = 1) =>
    new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + plusDay, h, mi).toISOString();

  it('**提醒往前挪，due 不动**——截止是「什么时候之前得做完」，提醒是「什么时候喊我」', () => {
    const r = parseSmartInput('明天下午三点开会提前半小时提醒', NOW);
    expect(r.due).toBe(at(15));
    expect(r.remindAt).toBe(at(14, 30));
  });

  it('分钟 / 小时 / 天三种单位', () => {
    expect(parseSmartInput('明天下午三点开会提前30分钟提醒', NOW).remindAt).toBe(at(14, 30));
    expect(parseSmartInput('明天下午三点开会提前2小时提醒', NOW).remindAt).toBe(at(13));
    expect(parseSmartInput('明天下午三点开会提前一天提醒', NOW).remindAt).toBe(at(15, 0, 0));
  });

  it('「提醒」两个字可以省', () => {
    expect(parseSmartInput('明天下午三点开会提前半小时', NOW).remindAt).toBe(at(14, 30));
  });

  it('中文数字也认——跟这个文件里别的规则一条口径', () => {
    expect(parseSmartInput('明天下午三点开会提前十分钟提醒', NOW).remindAt).toBe(at(14, 50));
  });

  it('认走之后标题里不留那一段', () => {
    expect(parseSmartInput('明天下午三点开会提前半小时提醒', NOW).title).toBe('开会');
  });

  it('提示条上说得出这一段', () => {
    expect(parseSmartInput('明天下午三点开会提前半小时提醒', NOW).hits.join(' ')).toContain('提前半小时提醒');
  });

  /**
   * **没认出时刻就没有可挪的东西**：只写了日期的任务提醒本来就是空的
   * （这个文件里「只认出日期的不凭空补一个提醒时刻」那条），这时候整条作废，
   * 那半句**原样留在标题里**——摘掉它等于把人写的字吃掉却什么也没做成。
   */
  it('没认出时刻时整条作废，那半句留在标题里', () => {
    const r = parseSmartInput('明天开会提前半小时提醒', NOW);
    expect(r.remindAt).toBeNull();
    expect(r.title).toBe('开会提前半小时提醒');
  });

  it('什么时间都没认出来时同理，一个字都不动', () => {
    const r = parseSmartInput('开会提前半小时提醒', NOW);
    expect(r.due).toBeNull();
    expect(r.title).toBe('开会提前半小时提醒');
  });

  it('**「提前半分钟」「提前半天」不认**——「半」只在小时那一档说得通', () => {
    expect(parseSmartInput('明天下午三点开会提前半分钟提醒', NOW).title).toContain('提前半分钟');
    expect(parseSmartInput('明天下午三点开会提前半天提醒', NOW).title).toContain('提前半天');
  });

  it('关掉日期识别时这一条也跟着不认——它是日期识别的一部分', () => {
    const r = parseSmartInput('明天下午三点开会提前半小时提醒', NOW, { date: false });
    expect(r.remindAt).toBeNull();
    expect(r.title).toBe('明天下午三点开会提前半小时提醒');
  });

  it('跟标签、重复一起用不打架', () => {
    const r = parseSmartInput('每周一下午三点开例会提前十分钟提醒 #工作', NOW);
    expect(r.repeat?.every).toBe('week');
    expect(r.tags).toEqual(['工作']);
    expect(r.title).toBe('开例会');
    expect(r.remindAt).not.toBeNull();
  });
});

describe('临时复现：提前 N 提醒的空格', () => {
  it('带空格的写法认不认得出来', () => {
    for (const t of ['明天下午三点开会 提前 30 分钟提醒', '明天下午三点开会提前30分钟提醒', '明天下午三点开会 提前sss30分钟提醒']) {
      const r = parseSmartInput(t, new Date(2026, 8, 3, 9));
      console.log(JSON.stringify(t), '→ 标题:', JSON.stringify(r.title), '| remindAt:', r.remindAt, '| due:', r.due);
    }
    expect(true).toBe(true);
  });
});
