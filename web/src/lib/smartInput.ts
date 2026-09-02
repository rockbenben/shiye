import type { Repeat, TaskContext } from '../types.js';
// 情境的中文名从这里来，不在这个文件里抄第二份——那份名单同时供侧栏、
// 筛选栏、卡片记号用，抄一份出来的那天就开始飘。
import { CONTEXT_LABEL, CONTEXTS } from './taskView.js';

/**
 * 「智能识别」——从一句随手写的标题里认出时间、重复、标签。
 *
 * 仿滴答清单：任务添加栏里打「明天下午两点交周报 #工作」，回车就建好，不用
 * 再点开三个控件各填一次。它那边把这件事拆成三块（日期时间 / 重复 / 标签），
 * 这里也是同样三块，不多认别的——`!高` 那种优先级语法它没有，不自己发明。
 *
 * **模板字符串里写 `\s` 等于写 `s`。** 这一文件里的正则有一半是用
 * `new RegExp(…)` 拼出来的（要嵌 `NUM`），JS 里模板字符串的 `\s` 是一个
 * “未知转义”，**静静地变成字母 `s`**（不报错），于是 `\s*` 实际上是
 * “零个或多个字母 s”。因为中文里这几处本来就没空格，它悄声无息地错了很久
 * （实测：「3 天后」「45 分钟后」带空格就认不出来）。拼正则时一律写 `\\s`。
 *
 * **纯函数，只吃字符串和 `now`。** 不写任何字段、不发请求：认出来的东西以
 * 一个 `SmartInput` 交回去，界面拿它去画那条「识别到 …」的提示，用户点
 * 「取消识别」就整份扔掉——识别永远是建议，不是替他做的决定，这跟 AI 建议
 * 要人点「接受」是同一条规矩。
 *
 * **只用在新建任务那条路上**（`TaskComposer`），不用在卡片的编辑态：改一条
 * 已有任务的标题时把「明天」吃掉、顺手把截止时间改了，是他没要过的副作用。
 */
export interface SmartInput {
  /** 去掉被认走的那几段之后的标题。全被认走了就是空串，调用方自己决定怎么办。 */
  title: string;
  due: string | null;
  /**
   * 提醒时刻。**只在真的认出了「几点」时才有值**——只说了「明天」没说几点的，
   * `due` 落在那天的本地零点，提醒留空。给它凭空补一个上午九点是替他定了一个
   * 他没说过的闹钟；而零点响一次比不响更糟。
   */
  remindAt: string | null;
  tags: string[];
  repeat: Repeat | null;
  /** 情境（GTD 的 `@上下文`）。认不出来是 `null`。一句话里最多一个——它是单值字段。 */
  context: TaskContext | null;
  /** 给界面显示的人话，认出一样有一条。空数组 = 什么都没认出来，界面不该出提示条。 */
  hits: string[];
}

const EMPTY = (title: string): SmartInput => ({ title, due: null, remindAt: null, tags: [], repeat: null, context: null, hits: [] });

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 正则里「一个数」的写法：阿拉伯数字或中文数字，两处（时刻、重复间隔）共用。 */
const NUM_BODY = '\\d{1,4}|[零〇一二两三四五六七八九十]{1,3}';
const NUM = `(${NUM_BODY})`;

/** 「三」「十」「十二」「二十三」「23」→ 数字。认不出来返回 null。 */
function cnNum(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  const tens = s.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  if (tens) return (tens[1] ? CN_DIGIT[tens[1]] : 1) * 10 + (tens[2] ? CN_DIGIT[tens[2]] : 0);
  return s.length === 1 && s in CN_DIGIT ? CN_DIGIT[s] : null;
}

/** 周几：日/天都是周日（0）。 */
const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 一次「认走一段」。`re` 命中就把那一段从工作串里挖掉，交给 `use` 处理。
 *
 * 挖掉这一步是这个模块的核心动作：认出来的字面（「明天下午两点」）不该再留在
 * 标题里，那是控件的内容不是标题的内容。挖成空串不补空格——中文本来就不靠
 * 空格分词，补了反而在「交周报」中间留个洞，最后统一压一次连续空白。
 */
function take(src: string, re: RegExp, use: (m: RegExpMatchArray) => boolean): string {
  const m = src.match(re);
  if (!m || m.index === undefined) return src;
  if (!use(m)) return src;
  return src.slice(0, m.index) + src.slice(m.index + m[0].length);
}

/** 本地某一天的零点。跨月/跨年由 Date 构造函数自己进位，不手写。 */
const startOfDay = (base: Date, plusDays = 0): Date =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + plusDays);

/**
 * 从 `from` 出发、到下一个星期 `wd` 的那天。`includeToday` 为假时今天不算数
 * （「下周三」在周三那天说的是下周那个周三）。
 */
function nextWeekday(from: Date, wd: number, includeToday: boolean): Date {
  const diff = (wd - from.getDay() + 7) % 7;
  return startOfDay(from, diff === 0 && !includeToday ? 7 : diff);
}

/**
 * 下一个「几号」。这个月的那天还没过（含今天）就是这个月，过了就是下个月。
 * `'last'` 是月底——`new Date(y, m + 1, 0)` 取的就是第 m 个月的最后一天，
 * 不用记每个月几天，闰年二月也对。
 *
 * 31 号这种：**没有 31 号的月份直接跳过去**，落在下一个有 31 号的月份。
 * `new Date(y, m, 31)` 在 6 月会溢出成 7 月 1 日，那是另一天、不是他说的那天。
 */
function nextMonthDay(now: Date, day: number | 'last'): Date {
  if (day === 'last') return new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const n: number = day;
  const today = startOfDay(now).getTime();
  for (let i = 0; i < 24; i++) {
    const d: Date = new Date(now.getFullYear(), now.getMonth() + i, n);
    if (d.getDate() === n && d.getTime() >= today) return d;
  }
  // 走不到：任何 1-31 都在两年内出现过。兜底不抛，跟这个文件里别处一样。
  return startOfDay(now);
}

/** 日期词末尾那个字对应哪个时段词。「天」「日」不带时段，落 `undefined`。 */
const PERIOD_CHAR: Record<string, string | undefined> = { 早: '早上', 晚: '晚上' };

interface DatePart {
  day: Date;
  label: string;
  /**
   * 这个日期词自己带的时段（「今**晚**八点」的「晚上」）。
   *
   * 「今晚」「明早」这类词一个字兼两个身份：前一半说哪天，后一半说上午还是
   * 晚上。日期这一步先跑，整词吃掉之后，后面「八点」就成了裸钟点——`PERIODS`
   * 里明明列着 `今晚|明晚`，却永远轮不到它，于是「今晚八点开会」落在**上午
   * 八点**（还是个已经过去的时刻）。这里把那半句交出去，`takeTime` 在自己
   * 没认出时段词时拿它兜底。
   */
  period?: string;
}
interface TimePart { hour: number; minute: number; explicitPeriod: boolean; label: string }

/**
 * 认「哪一天」。认不出来返回 null，`rest` 原样。
 *
 * 顺序是有讲究的：**长的先认**。「大后天」要排在「后天」前面，「下周三」要排在
 * 「周三」前面——短的先命中的话，「大后天」会被切成「大」+「后天」。
 */
function takeDate(src: string, now: Date): { rest: string; part: DatePart | null } {
  let part: DatePart | null = null;
  const hit = (day: Date, label: string, period?: string) => { part = { day, label, period }; return true; };

  // 绝对日期：2026-08-25 / 2026年8月25日 / 8月25号 / 8/25
  let rest = take(src, /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/, (m) => {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // 2 月 30 日这种：Date 会溢出成 3 月 2 日，跟他写的不是一回事，宁可不认。
    if (d.getMonth() !== Number(m[2]) - 1) return false;
    return hit(d, `${m[1]}年${Number(m[2])}月${Number(m[3])}日`);
  });
  if (part) return { rest, part };

  rest = take(rest, /(\d{1,2})[月/](\d{1,2})[日号]?/, (m) => {
    const [mon, day] = [Number(m[1]), Number(m[2])];
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return false;
    let d = new Date(now.getFullYear(), mon - 1, day);
    if (d.getMonth() !== mon - 1) return false;
    // 「最近有效的那一个」——滴答清单对模糊日期的规矩。今年的这天已经过去了
    // （八月说「1月10号」），指的是明年那天，不是三个月前那天。
    if (d.getTime() < startOfDay(now).getTime()) d = new Date(now.getFullYear() + 1, mon - 1, day);
    return hit(d, `${mon}月${day}日`);
  });
  if (part) return { rest, part };

  // 「N 天后」/「N 周后」/「N 个月后」（仿滴答清单的自然语言识别）。
  // 认「以后」也认「之后」：三种说法完全等价，只认一种是在让人猜。
  // 跟下面那几个固定词不会互相吃掉：「三天后」里没有「后天」（那要求「后」紧跟「天」，
  // 这里是「天后」）。
  rest = take(rest, new RegExp(`${NUM}\\s*天(?:以|之)?后`), (m) => {
    const n = cnNum(m[1]);
    if (n === null || n < 1) return false;
    return hit(startOfDay(now, n), `${n}天后`);
  });
  if (part) return { rest, part };

  rest = take(rest, new RegExp(`${NUM}\\s*(?:个)?(?:周|星期|礼拜)(?:以|之)?后`), (m) => {
    const n = cnNum(m[1]);
    if (n === null || n < 1) return false;
    return hit(startOfDay(now, n * 7), `${n}周后`);
  });
  if (part) return { rest, part };

  rest = take(rest, new RegExp(`${NUM}\\s*个?月(?:以|之)?后`), (m) => {
    const n = cnNum(m[1]);
    if (n === null || n < 1) return false;
    const d = startOfDay(now);
    // setMonth 自己进位；31 号加一个月会溢出到下月初——这里是「大约 N 个月后」，
    // 一天的偏差不值得为它写一套夹逼。
    d.setMonth(d.getMonth() + n);
    return hit(d, `${n}个月后`);
  });
  if (part) return { rest, part };

  /**
   * 「N 年后」。**排在月那一档后面**：`个?月` 那条要求「月」字，跟「年」不冲突，
   * 顺序其实无所谓——但摆在一起读得出这是同一族的第四个。
   *
   * 出处是 Things 的自然语言输入（《Using Natural Language Input》：
   * 「Use *w* for weeks, *mo* for months, and ***y* for years**」）——我们有天、
   * 周、月三档，独缺年。「两年后换护照」「三年后车检」这类事天然就是按年说的。
   *
   * **跟月那档一样用 `setFullYear`，不换算成 365 天**：闰年差一天，而人说
   * 「两年后」要的是日历上的同一天。2 月 29 日加一年会溢出成 3 月 1 日——
   * 跟月那档同一个态度，这是「大约 N 年后」，一天的偏差不值得为它写夹逼。
   */
  rest = take(rest, new RegExp(`${NUM}\\s*年(?:以|之)?后`), (m) => {
    const n = cnNum(m[1]);
    if (n === null || n < 1) return false;
    const d = startOfDay(now);
    d.setFullYear(d.getFullYear() + n);
    return hit(d, `${n}年后`);
  });
  if (part) return { rest, part };

  rest = take(rest, /大后天/, () => hit(startOfDay(now, 3), '大后天'));
  if (part) return { rest, part };
  rest = take(rest, /后天/, () => hit(startOfDay(now, 2), '后天'));
  if (part) return { rest, part };
  // 「明早」「今晚」这类：后一个字既是词的一部分，也是时段。整词吃掉、把时段
  // 交给下一步，见 `DatePart.period`。
  rest = take(rest, /明([天日早晚])/, (m) => hit(startOfDay(now, 1), '明天', PERIOD_CHAR[m[1]]));
  if (part) return { rest, part };
  rest = take(rest, /今([天日早晚])/, (m) => hit(startOfDay(now), '今天', PERIOD_CHAR[m[1]]));
  if (part) return { rest, part };

  // 「周末」（仿滴答清单的自然语言识别）。**排在所有「周…」之前**：`下+周` 那条
  // 会把「下周末」里的「下周」先吃掉、把「末」留在标题里，跟「下下周三」当初
  // 那个坑一模一样。
  //
  // 落在**周六**。「今天就是周六」算今天；**「今天是周日」也算今天**——周日本来
  // 就在周末里，把它推到六天之后不合常理，而那正是 `nextWeekday(…, 6, true)`
  // 会给出的答案。这是这个词唯一需要特判的一天。
  rest = take(rest, /(下*)(?:这|本)?(?:周|星期|礼拜)末(?:之?前)?/, (m) => {
    const ahead = m[1].length * 7;
    const base = m[1].length === 0 && now.getDay() === 0
      ? startOfDay(now)
      : nextWeekday(now, 6, true);
    return hit(startOfDay(base, ahead), `${m[1]}周末`);
  });
  if (part) return { rest, part };

  // 「下周三」/「下星期三」：下一个那天，今天正好是周三也算下周那个。
  // **`下+` 不是 `下`**：写「下下周三」时，只认一个「下」会同时错两样——日期
  // 少算一周，而且那个多出来的「下」原样留在标题里（实测「下下周三开会」变成
  // 一条叫「下开会」的任务）。用 `下+` 不用 `下{1,2}`：后者在「下下下周」上
  // 会犯一模一样的错，而按几个「下」乘几周本来就是这个说法的意思。
  rest = take(rest, /(下+)(?:周|星期|礼拜)([一二三四五六日天])/, (m) =>
    hit(startOfDay(nextWeekday(now, WEEKDAY[m[2]], false), (m[1].length - 1) * 7), `${m[1]}周${m[2]}`));
  if (part) return { rest, part };
  // 「周三」/「这周三」：最近的那个周三，今天就是周三就是今天。
  // 「周三」/「这周三」：最近的那个周三，今天就是周三就是今天。
  rest = take(rest, /(?:这|本)?(?:周|星期|礼拜)([一二三四五六日天])/, (m) =>
    hit(nextWeekday(now, WEEKDAY[m[1]], true), `周${m[1]}`));
  if (part) return { rest, part };

  rest = take(rest, /(下+)(?:周|星期|礼拜)/, (m) => hit(startOfDay(now, 7 * m[1].length), `${m[1]}周`));
  if (part) return { rest, part };
  // 「月底」。**排在「下个月」之前**：那条会把「下个月底」里的「下个月」先吃掉、
  // 把「底」留在标题里。落在那个月的最后一天——`setMonth(m + 1)` 之后取第 0 天
  // 就是上个月的末日，不用记每个月几天，也自动处理闰年二月。
  //
  // 顺手吃掉后面的「前」/「之前」（「月底前交表」）：日期是同一个，不吃的话那个
  // 「前」会留在标题里变成「前交表」。**只有这两个模糊词这么做**——「明天前」
  // 「下周三前」没人这么说，为它们也加一遍是在为不存在的说法写代码。
  rest = take(rest, /(下*)(?:这|本)?个?月底(?:之?前)?/, (m) => {
    const d = new Date(now.getFullYear(), now.getMonth() + m[1].length + 1, 0);
    return hit(startOfDay(d), m[1] ? `${m[1]}个月底` : '月底');
  });
  if (part) return { rest, part };
  rest = take(rest, /(下+)个?月/, (m) => {
    const d = startOfDay(now);
    d.setMonth(d.getMonth() + m[1].length);
    return hit(d, `${m[1]}个月`);
  });
  return { rest, part };
}

/** 时段词 → 怎么把 12 小时制的钟点摆到 24 小时上。 */
const PERIODS: Array<{ re: RegExp; adjust: (h: number) => number }> = [
  { re: /凌晨|半夜|夜里/, adjust: (h) => (h === 12 ? 0 : h) },
  { re: /早上|早晨|一早|上午/, adjust: (h) => (h === 12 ? 0 : h) },
  { re: /中午/, adjust: (h) => (h < 11 ? h + 12 : h) },
  { re: /下午|傍晚/, adjust: (h) => (h < 12 ? h + 12 : h) },
  { re: /晚上|今晚|明晚/, adjust: (h) => (h === 12 ? 0 : h < 12 ? h + 12 : h) },
];

/**
 * 认「几点」。`hasDate` 决定要不要对裸钟点做「最近有效」的推断，见下面。
 *
 * `fallback` 是日期那一步顺出来的时段（`DatePart.period`，「今**晚**八点」的
 * 「晚上」）：**只在这句话里一个时段词都没有时才用**——他要是又写了「今晚下午
 * 三点」（自相矛盾，但输入框里什么都可能），以他明写的那个为准。
 */
function takeTime(
  src: string, now: Date, hasDate: boolean, fallback?: string,
): { rest: string; part: TimePart | null } {
  let period: { adjust: (h: number) => number; label: string } | null = null;
  let rest = src;
  for (const p of PERIODS) {
    const before = rest;
    rest = take(rest, p.re, (m) => { period = { adjust: p.adjust, label: m[0] }; return true; });
    if (rest !== before) break;
  }
  if (!period && fallback) {
    const p = PERIODS.find((x) => x.re.test(fallback));
    if (p) period = { adjust: p.adjust, label: fallback };
  }

  let part: TimePart | null = null;
  const build = (h: number, min: number, shown: string): boolean => {
    if (h < 0 || h > 23 || min < 0 || min > 59) return false;
    let hour = period ? period.adjust(h) : h;
    // 裸钟点、而且没说是哪天：取「最近有效的那一个」——滴答清单帮助里的原例，
    // 下午四点说「9点提醒我」指的是今晚九点。候选只有 h 和 h+12 两个，都过去了
    // 就落到明天的 h。**说了哪天就不做这层推断**：「明天9点」是上午九点，
    // 不该因为此刻是下午就被推成明天晚上。
    if (!period && !hasDate && h >= 1 && h <= 12) {
      const today = startOfDay(now).getTime();
      const cand = [h, h + 12]
        .map((x) => today + ((x % 24) * 60 + min) * 60_000)
        .filter((t) => t > now.getTime());
      hour = cand.length > 0 ? new Date(cand[0]).getHours() : h;
    }
    part = { hour, minute: min, explicitPeriod: period !== null, label: `${period ? period.label : ''}${shown}` };
    return true;
  };

  // 14:30 / 14：30
  const before = rest;
  rest = take(rest, /(\d{1,2})\s*[:：]\s*(\d{2})/, (m) => build(Number(m[1]), Number(m[2]), `${m[1]}:${m[2]}`));
  if (part) return { rest, part };
  rest = before;

  // 两点半 / 9点 / 十点十五分 / 3点整
  rest = take(rest, new RegExp(`${NUM}\\s*[点時时](?:\\s*(半|一刻|整)|\\s*${NUM}\\s*分?)?`), (m) => {
    const h = cnNum(m[1]);
    if (h === null) return false;
    const min = m[2] === '半' ? 30 : m[2] === '一刻' ? 15 : m[2] === '整' ? 0 : m[3] ? cnNum(m[3]) : 0;
    if (min === null) return false;
    return build(h, min, m[0].trim());
  });
  if (part) return { rest, part };

  // 时段词单用（「明天下午交周报」）不算认出了时刻——那只是个模糊的说法，
  // 给它安一个 14:00 是替他编的。把时段词还回标题里。
  return { rest: src, part: null };
}

/**
 * 一串星期几 →去重排好序的 0-6 列表。认三种写法，可以混着来：
 *
 * - 连写：「一三五」
 * - 分隔：「一、三、五」「三和周五」（分隔符和多余的「周」都跳过）
 * - 区间：「一到五」「一至日」
 *
 * 区间按**中文一周的顺序**算，不是按 `Date.getDay()` 的 0-6：「一到日」是整周，
 * 而周日在 `getDay()` 里是 0、排在周一前面，直接按数字展开会得到空集。所以
 * 内部把日/天记成 7，展开完再折回 0。
 *
 * **端点反过来（「五到一」）不展开**，只收两个端点：那是个没人这么说的写法，
 * 猜它是「跨周」还是「写反了」都是在替他决定。
 */
function weekdayRun(run: string): number[] {
  const ORDER = (c: string) => (WEEKDAY[c] === 0 ? 7 : WEEKDAY[c]);
  const out: number[] = [];
  let pendingRange = false;
  for (const ch of run) {
    if (ch in WEEKDAY) {
      const n = ORDER(ch);
      const prev = out.length > 0 ? out[out.length - 1] : null;
      if (pendingRange && prev !== null && prev < n) {
        for (let x = prev + 1; x <= n; x++) out.push(x);
      } else {
        out.push(n);
      }
      pendingRange = false;
      continue;
    }
    if (ch === '到' || ch === '至' || ch === '-' || ch === '~' || ch === '—') pendingRange = true;
    // 别的（分隔符、空格、多余的「周」）跳过，不影响下一个星期几。
  }
  return [...new Set(out.map((n) => n % 7))].sort((a, b) => a - b);
}

/** 「每月 15 号」记下来的那个 15；`'last'` 是「每月底」。没说就是 `null`。 */
type MonthDay = number | 'last' | null;

interface RepeatHit {
  rest: string;
  repeat: Repeat | null;
  label: string;
  monthDay: MonthDay;
  /** 「每**晚**十点」里那半句时段，交给 `takeTime` 兜底，跟 `DatePart.period`
   *  同一个用法、同一个理由。 */
  period?: string;
  /**
   * **这句话里有一条这个应用表达不了的重复规则，整句都别认。**
   *
   * 现在只有一种：「每月第一个周一」「每月最后一个周五」这类「第几个星期几」。
   * `Repeat` 里没有这个概念（`weekdays` 说的是「每周的哪几天」，不是「这个月
   * 的第几个」），硬凑不出来。
   *
   * 光在这儿不认还不够——`takeDate` 紧接着会把剩下的「周一」当成一个**具体
   * 日期**吃掉，于是「每月第一个周一开会」变成一条叫「第一个开会」、排在下周一
   * 的任务：**认不出的说法被拆成了一个错的答案**，比一个字都不认糟得多。所以
   * 这一支直接让整次识别作废，原话原样还回去，跟「认完标题空了」那条同一个
   * 处理（见 `parseSmartInput` 末尾）。
   */
  bail?: boolean;
}

/** 认重复。「每周一」要排在日期之前认，不然「周一」会先被当成日期吃掉。 */
function takeRepeat(src: string): RepeatHit {
  // 表达不了的那一种先挡下来，见 `RepeatHit.bail`。**放在最前面**：下面任何
  // 一条规则先咬到「每月」，这一句就已经被拆开了。
  if (new RegExp(`(?:第\\s*${NUM}|最后一)\\s*个\\s*(?:周|星期|礼拜)[一二三四五六日天]`).test(src)) {
    return { rest: src, repeat: null, label: '', monthDay: null, bail: true };
  }
  let repeat: Repeat | null = null;
  let label = '';
  let monthDay: MonthDay = null;
  let period: string | undefined;
  const hit = (r: Repeat, l: string, md: MonthDay = null, pd?: string) => {
    repeat = r; label = l; monthDay = md; period = pd; return true;
  };
  const base = { interval: 1, weekdays: [] as number[], until: null, from: 'due' as const, count: null, step: 0, monthDay: null };

  /**
   * 「每晚十点睡觉」这类「每 + 时段」。**两条规则，长的先试、而且要求后面跟着
   * 钟点**——这是中文里一个真的分不开的歧义：
   *
   * - `每早上八点起床`：「早上」是时段，「八点」是钟点。
   * - `每早上班`：「上」属于「上班」，时段只有「早」。
   *
   * 两句的前四个字一模一样。判据只能看后面有没有钟点：有就整词吃掉，没有就
   * 只吃一个字。反过来（一律只吃一个字）会在「每早上八点」上把「上」留在标题里；
   * 一律吃整词会把「每早上班」变成一条叫「班」的任务。
   *
   * 认下来是**每天重复**加一个时段：「每晚十点」是每天晚上十点，不是每晚一次
   * 但不知道几点。时段跟 `DatePart.period` 走同一条路交给 `takeTime` 兜底——
   * 少了它，「每晚十点」会走裸钟点那条「最近有效」的推断：早上七点说这句话，
   * 候选是 10:00 和 22:00，10:00 还没过，于是落在**上午十点**。
   */
  const PERIOD_WORD: Record<string, string> = {
    早: '早上', 早上: '早上', 早晨: '早上', 晚: '晚上', 晚上: '晚上', 夜: '晚上', 夜里: '晚上',
  };
  // 提示条上写「每早」「每晚」，不写「每天早上」：后面那半句紧接着还会出现一次
  // （时刻那一份的 label 是「早上八点」），写全了就成了「每天早上 · 早上八点」。
  const daily = (word: string) => {
    const p = PERIOD_WORD[word];
    return hit({ ...base, every: 'day' }, p === '早上' ? '每早' : '每晚', null, p);
  };
  // 长的那一支：后面必须跟着钟点（`(?=…)` 只前瞻、不吃掉）。
  let rest = take(src, new RegExp(`每(早上|早晨|晚上|夜里)(?=\\s*(?:${NUM}\\s*[点時时]|\\d{1,2}\\s*[:：]))`), (m) => daily(m[1]));
  if (repeat) return { rest, repeat, label, monthDay, period };
  rest = take(rest, /每(早|晚|夜)(?![上晨里])/, (m) => daily(m[1]));
  if (repeat) return { rest, repeat, label, monthDay, period };

  /**
   * 「每季度」「每半年」——就是月重复的两个常用说法（3 个月 / 6 个月）。
   * 不新增 `every` 档位：它们在模型里就是 `month` 加一个 `interval`，多一档
   * 会让 `nextOccurrence`、`describeRepeat`、`.ics` 的 RRULE 三处都多一个分支，
   * 而答案跟现在一模一样。
   */
  rest = take(rest, /每(?:个)?季度/, () => hit({ ...base, every: 'month', interval: 3 }, '每季度'));
  if (repeat) return { rest, repeat, label, monthDay, period };
  rest = take(rest, /每半年/, () => hit({ ...base, every: 'month', interval: 6 }, '每半年'));
  if (repeat) return { rest, repeat, label, monthDay, period };

  /**
   * 「每隔一天」= 每 2 天。
   *
   * **只认「一」这一档。** 「每隔一天」在现代中文里几乎只有一个读法（隔一天做
   * 一次，也就是每两天）；而「每隔两天」真的分不出来——严格讲是每 3 天，
   * 口语里不少人指每 2 天。猜哪一个都是替他做决定，而猜错了他看不出来
   * （卡片上写的是「每 3 天」，他写的是「每隔两天」，两句话对不上号）。
   * **还要求带「每」。** 裸的「隔天」在中文里还有另一个常用意思——「第二天」
   * （「隔天再打一次电话」是一次性的，不是重复），分不出来就不认。
   * 不认的那几档原话留在标题里，跟 `!高`、裸的「N 号」同一条规矩：
   * 分不出来的就不猬。
   */
  rest = take(rest, /每隔(?:一)?天/, () => hit({ ...base, every: 'day', interval: 2 }, '每 2 天'));
  if (repeat) return { rest, repeat, label, monthDay, period };

  rest = take(rest, /每(?:个)?工作日/, () => hit({ ...base, every: 'week', weekdays: [1, 2, 3, 4, 5] }, '每个工作日'));
  if (repeat) return { rest, repeat, label, monthDay, period };

  // 「每周末」：每周六。**必须排在下面「每周」之前**——那条会把「每周」先吃掉、
  // 把「末」留在标题里（实测「每周末大扫除」变成一条叫「末大扫除」的任务），
  // 跟「下周末」在日期那边同一个坑。
  rest = take(rest, /每(?:个)?(?:周|星期|礼拜)末/, () =>
    hit({ ...base, every: 'week', weekdays: [6] }, '每周末'));
  if (repeat) return { rest, repeat, label, monthDay, period };

  // 「每周一三五」：连着的几个星期几一起收，一个一个认会漏掉后面两个。
  // **中间可以有分隔符**（「每周一、三、五」「每周三和周五」）**也可以是区间**
  // （「每周一到周五」）——这两种写法比连写常见得多，而在这之前它们会各错两样：
  // 「每周一到周五晨会」只收到周一，剩下的「到周五」里「周五」被日期那一步当成
  // 一个**具体日期**吃掉（凭空多出一个截止日），「到」留在标题里变成「到晨会」。
  rest = take(rest, /每(?:周|星期|礼拜)([一二三四五六日天](?:\s*(?:[、，,和跟与]|到|至|-|~|—)?\s*(?:周|星期|礼拜)?[一二三四五六日天])*)/, (m) => {
    const days = weekdayRun(m[1]);
    if (days.length === 0) return false;
    return hit({ ...base, every: 'week', weekdays: days }, `每周${days.map((d) => WEEKDAY_LABEL[d]).join('、')}`);
  });
  if (repeat) return { rest, repeat, label, monthDay, period };

  // 「每月15号」「每月底」「每月最后一天」。**必须在这儿认掉，不能留给日期那一步**：
  // 那边不认裸的「15号」——「号」在中文里是个高频量词（3 号电池、1 号线、5 号
  // 文件），当日期认会把标题改坏。而**紧跟在「每月」后面**的「15号」没有这个
  // 歧义，所以只在这个位置认。
  //
  // 认下来还得**把那一天记住**：`Repeat` 里没有「几号」这个字段（月重复靠任务
  // 自己的 `due` 定锚），只把「15号」从标题里抹掉、不落到 due 上，等于把他刚说
  // 的那半句话弄丢了——比留在标题里更糟。所以这一条跟「每周一」不一样：那边
  // 星期几进了 `repeat.weekdays`，什么都没丢，可以不安 due（见 parseSmartInput
  // 里的判断①）；这边不安就真丢了。
  // `NUM` 自己带一层括号，这里不要再包一层——包了 `底` 那一支就成了第 3 组，
  // 而下面读的是 m[2]，会在「每月底」上拿 `undefined` 去 cnNum。
  rest = take(rest, /每(?:个)?月[ 	]*(?:底|最后一[天日])/, () =>
    hit({ ...base, every: 'month', monthDay: 31 }, '每月底', 'last'));
  if (repeat) return { rest, repeat, label, monthDay, period };
  // 「第」可选：「每月15号」和「每月第一天」都要认。但**「天」这个量词必须跟着
  // 「第」**——不然「每月3天假」会被读成「每月 3 号」，标题只剩下「假」。
  rest = take(rest, new RegExp(`每(?:个)?月\\s*(第)?\\s*${NUM}\\s*(号|日|天)`), (m) => {
    if (m[3] === '天' && !m[1]) return false;
    const n = cnNum(m[2]);
    if (n === null || n < 1 || n > 31) return false;
    return hit({ ...base, every: 'month', monthDay: n }, `每月 ${n} 号`, n);
  });
  if (repeat) return { rest, repeat, label, monthDay, period };

  rest = take(rest, new RegExp(`每\\s*${NUM}\\s*(天|周|星期|个?月|年)`), (m) => {
    const n = cnNum(m[1]);
    if (n === null || n < 1) return false;
    const unit = m[2].includes('月') ? 'month' : m[2] === '天' ? 'day' : m[2] === '年' ? 'year' : 'week';
    const cn = unit === 'month' ? '个月' : unit === 'day' ? '天' : unit === 'year' ? '年' : '周';
    return hit({ ...base, every: unit, interval: n }, `每 ${n} ${cn}`);
  });
  if (repeat) return { rest, repeat, label, monthDay, period };

  rest = take(rest, /每(天|日|周|星期|礼拜|个?月|年)/, (m) => {
    const u = m[1];
    const every = u === '天' || u === '日' ? 'day' : u.includes('月') ? 'month' : u === '年' ? 'year' : 'week';
    const cn = { day: '每天', week: '每周', month: '每月', year: '每年' }[every];
    return hit({ ...base, every }, cn);
  });
  return { rest, repeat, label, monthDay, period };
}

/** `#标签`。半角全角都收，一句话里可以有好几个。 */
function takeTags(src: string): { rest: string; tags: string[] } {
  const tags: string[] = [];
  // 标签到空白或者下一个 # 为止。中文里 `#工作明天开会` 分不出边界，那是
  // 输入法的锅不是这里的——要求标签后面留个空格是通用做法（滴答清单同样）。
  const rest = src.replace(/[#＃]([^\s#＃]+)/g, (_all, name: string) => {
    const t = name.trim();
    if (t && !tags.includes(t)) tags.push(t);
    return '';
  });
  return { rest, tags };
}

/** 中文名 → 情境的 key。从 `CONTEXT_LABEL` 反过来生成，不手写第二份。 */
const CTX_BY_LABEL = new Map<string, TaskContext>(CONTEXTS.map((c) => [CONTEXT_LABEL[c], c]));

/**
 * `@情境`。GTD 里情境本来就写成 `@电脑前`，而这个应用的卡片和行上**画出来的
 * 也正是 `@电脑前`**——打的和看到的是同一个写法，不用另记一套。
 *
 * **词表是封闭的五档，这是它跟 `#标签` 最要紧的区别。** `takeTags` 那边的注释
 * 认输认得很干脆：「中文里 `#工作明天开会` 分不出边界，那是输入法的锅」，所以
 * 标签要求后面留个空格。这里不用——只匹配已知的那五个词，`@外出买菜` 切得
 * 干干净净：`外出` 是情境，`买菜` 留在标题里。
 *
 * 同理**不给它加识别开关**。那四个开关（仿滴答清单）存在的理由是那套识别会
 * 误判——「3 月 5 号那版方案」里的日期是标题的一部分。而 `@` 后面必须紧跟着
 * 五个固定词之一才算数，误伤不了；为一个恒定值加一个开关是这个仓库自己反对
 * 的事（见 CONTRIBUTING「不会红的」那节的态度）。
 *
 * **只认行首或空白后面的 `@`**：`a@b.com` 里那个 `@` 不是在标记情境。
 *
 * 单值字段，所以**第一个算数**；但认出来的每一个都从标题里摘掉——一句话里写
 * 了两个情境的人不是想把第二个留在标题里当字。
 */
function takeContext(src: string): { rest: string; context: TaskContext | null } {
  let found: TaskContext | null = null;
  // 正则从 `CONTEXTS` 现拼，不写死那五个词——名单改了这里自动跟上。
  const re = new RegExp(`(^|[\\s])[@＠](${CONTEXTS.map((c) => CONTEXT_LABEL[c]).join('|')})`, 'g');
  const rest = src.replace(re, (_all, lead: string, label: string) => {
    if (!found) found = CTX_BY_LABEL.get(label) ?? null;
    // 前面那个空白原样还回去：摘掉 `@外出` 不该把它左边那个空格也吃掉，
    // 不然「买菜 @外出 顺便取快递」会粘成「买菜顺便取快递」。
    return lead;
  });
  return { rest, context: found };
}

/**
 * 「提前 N 分钟/小时/天提醒」——《智能识别》 把「提前提醒」
 * 单列成一节。
 *
 * **它跟这个文件里别的规则形状不同**：别的都在回答「哪一天/几点」，这一条
 * 回答的是「提醒摆在截止时间之前多久」——它不产生日期，只产生一个偏移量，
 * 要等 `due` 定下来之后才算得出绝对时刻。所以它单独抠一趟，认出来的偏移
 * 一路带到最后拼装那一步。
 *
 * **认不出截止时间时整条作废，那半句原样留在标题里**（见调用处）：一个
 * 「提前半小时」没有参照物，摘掉它等于把人写的字吃掉却什么也没做成。
 *
 * ## 出处只有一个标题
 *
 * 那一节的正文在滴答原站是**图片**，抓下来的文本里只剩标题。所以「滴答具体
 * 认哪些写法」查不到——这里只认
 * 中文里最直白的那一种（「提前 N 分钟/小时/天提醒」，「提醒」两个字可省），
 * 没有照着谁抄。多认几种写法是以后的事，别为此把这段注释里的「出处」升级成
 * 「照着做的」。
 *
 * 「延后提醒」同样只有标题，而且中文里几乎没人这么说（要晚点提醒，人会直接
 * 写晚点那个时刻）——不做。
 */
function takeRemindBefore(src: string): { rest: string; minutes: number | null; label: string } {
  const re = new RegExp(`提前\\s*(半|${NUM_BODY})\\s*(分钟|分|小时|个小时|天)\\s*(?:提醒)?`);
  const m = re.exec(src);
  if (!m) return { rest: src, minutes: null, label: '' };
  const unit = m[2];
  // 「提前半小时」——「半」只在小时那一档说得通（「提前半分钟」没人说，
  // 「提前半天」是个模糊的说法不是十二小时）。
  const n = m[1] === '半' ? (unit === '小时' || unit === '个小时' ? 0.5 : null) : cnNum(m[1]);
  if (n === null || n <= 0) return { rest: src, minutes: null, label: '' };
  const per = unit === '分钟' || unit === '分' ? 1 : unit === '天' ? 60 * 24 : 60;
  const minutes = Math.round(n * per);
  return { rest: src.replace(m[0], ''), minutes, label: m[0].trim() };
}

/**
 * 「半小时后」/「N 小时后」/「N 分钟后」——仿滴答清单。
 *
 * 跟「N 天后」那一批**形状不同**：那几个只确定哪一天（落 23:59、不排提醒），
 * 而「半小时后」确定的是**一个瞬间**——日期和钟点一起定下来了，而且说这句话
 * 的人要的就是到点响一声。所以它同时产出 `day` 和 `time`，后面那段拼回去
 * 就自然会排上提醒。
 *
 * 算出来的是一个绝对时刻，再拆成那一天 + 那个钟点：晚上十一点说「三小时后」
 * 落在明天凌晨两点，跨天由 Date 自己进位，不手写。
 */
function takeRelativeMoment(
  src: string, now: Date,
): { rest: string; day: Date; time: TimePart } | null {
  let at: Date | null = null;
  let label = '';

  const grab = (re: RegExp, minutesOf: (m: RegExpMatchArray) => number | null): string => take(src, re, (m) => {
    const mins = minutesOf(m);
    if (mins === null || mins < 1) return false;
    at = new Date(now.getTime() + mins * 60_000);
    return true;
  });

  // 「半小时」单独一条，排在前面：「半」不是一个数字，cnNum 认不出它。
  let rest = grab(/半小时(?:以|之)?后/, () => { label = '半小时后'; return 30; });
  if (at) return { rest, day: startOfDay(at), time: momentTime(at, label) };

  rest = grab(new RegExp(`${NUM}\\s*个?小时(?:以|之)?后`), (m) => {
    const n = cnNum(m[1]);
    if (n === null) return null;
    label = `${n}小时后`;
    return n * 60;
  });
  if (at) return { rest, day: startOfDay(at), time: momentTime(at, label) };

  rest = grab(new RegExp(`${NUM}\\s*分钟?(?:以|之)?后`), (m) => {
    const n = cnNum(m[1]);
    if (n === null) return null;
    label = `${n}分钟后`;
    return n;
  });
  if (at) return { rest, day: startOfDay(at), time: momentTime(at, label) };

  return null;
}

/** 把一个绝对时刻拆成这个模块用的 `TimePart`。`explicitPeriod` 算真：
 *  算出来的钟点已经是 24 小时制的确切值，不该再过一遍「最近有效」的推断。 */
const momentTime = (at: Date, label: string): TimePart =>
  ({ hour: at.getHours(), minute: at.getMinutes(), explicitPeriod: true, label });

/**
 * 识别开关（仿滴答清单「更多设置 → 智能识别」）。**不给就是四个全开**
 * ——那是加这组开关之前的行为，一个字都没变。
 *
 * 为什么值得有：这套识别是本机一条正则，它会误判——「3 月 5 号那版方案」
 * 里的「3 月 5 号」是标题的一部分，不是截止日期。在有开关之前，唯一的躲法是
 * 每建一条再手工改回来。滴答清单把「认不认」和「认了要不要从标题里摘掉」
 * 分成两个开关，这里照抄：**摘不摘是另一个问题**——「10 月 1 日国庆值班」
 * 摘掉日期只剩「国庆值班」，而那个日期本来就是他想留在标题里的。
 *
 * **这儿原来写着「那四个」，指的是下面这四个字段。** 那是句对不上的话：
 * 《智能识别》 全篇四节讲的是四类**识别能力**（日期和时间 /
 * 重复 / 提前提醒 / 延后提醒），不是四个开关；语料里查得到的开关只有
 * 「智能识别日期」一个。上面那句「分成两个开关」是站得住的，别再往上加数字。
 */
export interface SmartOptions {
  date?: boolean;
  stripDate?: boolean;
  tag?: boolean;
  stripTag?: boolean;
}

/**
 * 主入口。识别顺序：情境 → 标签 → 重复 → 日期 → 时刻。
 *
 * 每一步都从上一步剩下的串里认，不是各认各的原串——`#每周报` 里的「每周」
 * 不该被当成重复规则，先把标签摘走就不会有这个问题；同理「每周一」先当重复
 * 认掉，剩下的串里就没有「周一」可以再被当成日期认第二遍。
 */
export function parseSmartInput(raw: string, now: Date, opts: SmartOptions = {}): SmartInput {
  const input = raw ?? '';
  if (!input.trim()) return EMPTY(input);

  // 关掉日期识别连重复规则一起关：「每周一写周报」认出来的是一条重复规则 +
  // 一个锚点日期，两者是同一次识别的两半，只关一半会留下一条没有锚点的重复
  // ——那种任务在「今天」里永远不出现、也不会响，等于只记了一条规则。
  const wantDate = opts.date !== false;
  const wantTag = opts.tag !== false;

  const hits: string[] = [];

  // 情境**排在最前面**，理由跟「标签先摘走」一模一样：后面每一步都从摘干净的
  // 那份往下认。摘早了不会误伤——`@` 后面必须是那五个固定词之一。
  //
  // **它不受 `opts` 里那四个开关管**（那四个是给会误判的识别用的，见
  // `takeContext` 上面那段），所以这一行没有 `wantXxx` 守卫。
  const ctx = takeContext(input);
  if (ctx.context) hits.push(`@${CONTEXT_LABEL[ctx.context]}`);

  const taken = wantTag ? takeTags(ctx.rest) : { rest: ctx.rest, tags: [] as string[] };
  // 认了但不摘：标签照样进 `tags`，标题原样留着。**后面几步仍然从「摘掉标签
  // 的那份」往下认**（`#每周报` 里的「每周」不该被当成重复规则，那正是先摘
  // 标签的理由）；只有最后拼标题时才决定要不要把它放回去。
  const noTags = taken.rest;
  const tags = taken.tags;
  if (tags.length > 0) hits.push(tags.map((t) => `#${t}`).join(' '));

  const rep = wantDate
    ? takeRepeat(noTags)
    : { rest: noTags, repeat: null, label: '', monthDay: null, period: undefined, bail: false } as ReturnType<typeof takeRepeat>;
  const { rest: noRepeat, repeat, label: repeatLabel, monthDay, period: repeatPeriod, bail } = rep;
  // 表达不了的重复说法：整次识别作废，原话还回去。理由在 `RepeatHit.bail`。
  if (bail) return EMPTY(input);
  if (repeat) hits.push(repeatLabel);

  // 「半小时后」这一批一次定下日期和钟点，所以先试它——试成了就不再走下面
  // 那两步（那两步会把已经认走的串再扫一遍，认不出东西，但白跑）。
  const moment = wantDate ? takeRelativeMoment(noRepeat, now) : null;
  const { rest: noDate, part: date } = !wantDate ? { rest: noRepeat, part: null } : moment
    // 日期这一份的 label 留空：下面那句提示是 `[date.label, time.label]` 拼出来
    // 的，两边都写「半小时后」会显示成「半小时后 半小时后」。这一批的整句话
    // 由 time 那一份说完，date 只是为了让「说了哪天」这个判断成立（那样
    // 「已经过去了顺延一天」那条就不会对一个刚算出来的未来时刻动手）。
    ? { rest: moment.rest, part: { day: moment.day, label: '' } }
    : takeDate(noRepeat, now);
  const { rest: noTime, part: time } = moment
    ? { rest: moment.rest, part: moment.time }
    : wantDate
      ? takeTime(noDate, now, date !== null, date?.period ?? repeatPeriod)
      : { rest: noDate, part: null };

  // 「提前 N 提醒」——只产生一个偏移，不产生日期，所以在日期/时刻都认完之后
  // 再抠。**从 `noTime` 上抠**：前面那几步已经把日期和钟点摘走了，剩下的串里
  // 「提前半小时」不会跟它们互相吃。
  const before = wantDate ? takeRemindBefore(noTime) : { rest: noTime, minutes: null, label: '' };

  // 落在哪一天。几种来源，从确定到含糊：
  let day = date ? date.day : null;
  // ⓪ 「每月15号」「每月底」——**这一支不看有没有认出时刻**，跟下面①不一样。
  //    理由在 takeRepeat 里那条规则上面：星期几进了 `repeat.weekdays`，不安 due
  //    也没丢东西；「几号」在 `Repeat` 里无处可存，不安 due 就真丢了。取的是
  //    「下一个那天」：这个月的还没过就是这个月，过了就是下个月。
  if (!day && monthDay !== null) day = nextMonthDay(now, monthDay);
  // ① 没说哪天，但重复规则点了名星期几（「每周一上午9点开例会」）：锚在最近的
  //    那个周一。没有锚点的重复任务在「今天」里永远不出现、也不会响，等于只
  //    记了一条规则。**只在同时认出了时刻时才锚**——见下面 due 那段，不带时刻
  //    的日期落在 23:59，给一条「每周一写周报」安一个周一 23:59 是编出来的。
  if (!day && time && repeat?.every === 'week' && repeat.weekdays.length > 0) {
    day = nextWeekday(now, repeat.weekdays[0], true);
  }
  // ② 只说了时刻（「9点开会」）：先摆到今天，过去了下面那步会顺延。
  if (!day && time) day = startOfDay(now);
  // ③ 没说日期、锚出来的那一刻已经过去了：顺延一个周期。**显式说了日期的不动**
  //    ——他说「今天下午两点」而现在三点，那是他自己的判断，不该被替他改成明天。
  if (day && time && !date) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute);
    if (at.getTime() <= now.getTime()) {
      day = startOfDay(day, repeat?.every === 'week' && repeat.weekdays.length > 0 ? 7 : 1);
    }
  }

  let due: string | null = null;
  let remindAt: string | null = null;
  if (day) {
    // 没认出时刻的落 **23:59**，不是本地零点。零点在这个界面里有歧义：`dueChip`
    // 把它当成「整天、不带时刻」只显示「明天」，而 `isOverdue` 拿它当一个真实
    // 时刻——于是「明天交周报」到了那天的 00:01 就被标成已过期，红一整天。
    // 两处判据对不上是那边的事，这里不去改一个被八处引用的函数，直接落在
    // 那一天的末尾：意思准（「这天之内」）、红得也对（过了那天才红）。
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time?.hour ?? 23, time?.minute ?? 59);
    due = at.toISOString();
    // 有具体时刻才排提醒。**due 和 reminders 是两件事**，只写 due 的任务到点
    // 只会变红、不会响——这是这个仓库反复强调的坑（AGENTS.md「due 和 reminders
    // 各管各的」），所以认出了时刻就两个一起写，不留一个看着像设了闹钟的空壳。
    // 反过来，只认出日期的不凭空补一个提醒时刻，那是替他定了个没说过的闹钟。
    if (time) remindAt = due;
    // 「提前 N」：把提醒往前挪，**不动 due**。两件事——截止时间是「什么时候
    // 之前得做完」，提醒是「什么时候喊我一声」。
    //
    // **只在真的排上了提醒时才生效**：只认出日期没认出时刻的任务，提醒本来
    // 就是空的（上面那句），「提前半小时」没有可挪的东西——那时候整条作废，
    // 那半句原样留在标题里，见下面 `base` 那一行。
    if (remindAt && before.minutes !== null) {
      remindAt = new Date(Date.parse(remindAt) - before.minutes * 60_000).toISOString();
    }
    hits.push([date?.label, time?.label, remindAt && before.minutes !== null ? before.label : null]
      .filter(Boolean).join(' '));
  }

  // 标题：默认是「把认走的那几段都摘掉」剩下的。
  //
  // 「日期不摘」= 退回到只摘了标签的那一份（`noTags`，日期那几个字还在里面）。
  //
  // 「标签不摘」= 把 `#标签` **接回末尾**，不是原位放回。原位放回要记住每段
  // 被摘走的位置再插回去，而后面几步（重复/日期/时刻）又在这份串上继续删了
  // 别的段，位置早就对不上了。接回末尾的代价是「#家里 换灯泡」会变成
  // 「换灯泡 #家里」——而人打标签绝大多数就写在末尾，这一档下多数时候一个字
  // 都不会动。**先摘再接回**这一步不能省：后面几步必须从「摘掉标签的那份」
  // 往下认（`#每周报` 里的「每周」不该被当成重复规则，那正是先摘标签的理由）。
  const stripDate = opts.stripDate !== false;
  const stripTag = opts.stripTag !== false;
  // 「提前 N 提醒」认出来了、而且真的用上了，才把那半句从标题里摘掉。用不上
  // 的时候（没排上提醒）原样留着——摘掉它等于把人写的字吃掉却什么也没做成。
  const usedBefore = remindAt !== null && before.minutes !== null;
  const base = stripDate ? (usedBefore ? before.rest : noTime) : noTags;
  const title = (stripTag ? base : [base.trim(), ...tags.map((t) => `#${t}`)].filter(Boolean).join(' '))
    .replace(/\s+/g, ' ').trim();
  // 认走之后标题空了（整句就是「明天下午两点」）：这不是一条任务，是一个时间。
  // 整份识别作废，把原话还回去让他自己看着办，别建一条没有标题的任务。
  if (!title) return EMPTY(input);

  return { title, due, remindAt, tags, repeat, context: ctx.context, hits: hits.filter(Boolean) };
}
