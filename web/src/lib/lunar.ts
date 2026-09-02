import cd from 'chinese-days';
import { dayKey } from './calendar.js';
import { holidayDataLastYear } from '../../../server/src/chineseDays.js';

/**
 * 农历 / 节气 / 法定节假日——日历格子里那半行小字。
 *
 * **数据源是 `chinese-days`**（MIT，零运行时依赖，ESM 产物 32KB）。选它是因为
 * 一个包同时给齐了这三样，而这三样的性质完全不同：
 *
 * - **农历**（腊月廿三）和**节气**（立秋）是**算出来的**，天文算法 + 一张压缩
 *   月表，往后几十年都成立，不需要谁来发布；
 * - **法定节假日和调休**（休 / 班）是**发布出来的**——国务院办公厅每年下半年
 *   发一次下一年的放假通知，在那之前**世界上不存在**这个数据，任何算法都编不
 *   出来。这个包把历年通知整理成一张表（`dist/chinese-days.json`，2004 至今），
 *   跟着通知更新版本。
 *
 * 这个区别决定了下面 `holidayMark` 那道年份闸门：表到哪一年为止，就只标到哪一
 * 年。`chinese-days` 自己对表外的日期返回 `work: true`（当普通工作日），照它
 * 直接画的话，2027 年的国庆会被标成「班」——一个**看起来像答案的错答案**，比
 * 什么都不标坏得多。
 *
 * 别的候选：`lunar-javascript` 只有农历和传统节日，没有法定节假日/调休（那半
 * 本来就不是算得出来的）；`chinese-holidays` 拖 moment + request + lodash 三个
 * 运行时依赖进来，为一张日期表不值得。
 */

/** 节气 / 农历日那一行的最大长度——超过就不是「半行小字」了。 */
const MAX_LABEL = 3;

/** 农历正月初一那天写「春节」而不是「初一」，其余传统节日同理。 */
const LUNAR_FESTIVALS: Record<string, string> = {
  '1-1': '春节',
  '1-15': '元宵',
  '2-2': '龙抬头',
  '5-5': '端午',
  '7-7': '七夕',
  '7-15': '中元',
  '8-15': '中秋',
  '9-9': '重阳',
  '12-8': '腊八',
};

/** 公历上的固定节日，跟农历那批同一个位置、同一条优先级下面。 */
const SOLAR_FESTIVALS: Record<string, string> = {
  '1-1': '元旦',
  '2-14': '情人节',
  '3-8': '妇女节',
  '5-1': '劳动节',
  '6-1': '儿童节',
  '10-1': '国庆',
  '12-25': '圣诞',
};

/**
 * 这一天在格子里写的那半行小字。**一格只写一样**，优先级：
 * 公历节日 > 节气 > 农历节日 > 农历日。
 *
 * 为什么是「只写一样」：一格宽 45 到 190 像素不等（390 到 1920），日号已经占
 * 掉一行；再塞两样进去，窄屏上一定是两样都读不出来。
 *
 * （原来这儿还有一句「滴答清单也是一格一样」。同样是关于界面长相的断言，
 * 而 `docs/` 里的图片全被剥掉了，证不了——上面那句宽度的账本来就够。）
 *
 * 为什么公历节日排在节气前面：10 月 1 日那天要说的是「国庆」不是「寒露」。
 */
export function lunarLabel(d: Date): string {
  const solar = SOLAR_FESTIVALS[`${d.getMonth() + 1}-${d.getDate()}`];
  if (solar) return solar;

  const key = dayKey(d);
  const terms = cd.getSolarTerms(key, key);
  if (terms.length > 0 && terms[0].name.length <= MAX_LABEL) return terms[0].name;

  const l = cd.getLunarDate(key);
  // 闰月不写「闰」字：一格塞不下「闰六月初一」，而闰不闰这件事在日历格子这个
  // 尺度上没人靠它做决定——要看的话去年视图或者详情。
  const fest = l.isLeap ? undefined : LUNAR_FESTIVALS[`${l.lunarMon}-${l.lunarDay}`];
  if (fest) return fest;

  // 每月初一写月份（「腊月」「正月」），别的日子写日（「廿三」）——一整个月里
  // 只有一天需要回答「现在是农历几月」，其余日子问的是「几号」。
  return l.lunarDay === 1 ? l.lunarMonCN : l.lunarDayCN;
}

// 「表覆盖到哪一年」搬去了 `server/src/chineseDays.ts`——重复规则里
// 「法定工作日 / 节假日」那两档要用同一个边界，而那边住在 server。
// **搬的时候修了一个 bug**：这儿原来那份判空用的是
// `getHolidaysInRange(y, y)`，而那个重载**默认把周末也算进去**，于是每年都有
// 一百来天、循环一路跑到上限，算出来的「最后一年」是 2099——那道闸门从来
// 没有生效过。没闯出祸是因为下面 `holidayMark` 还有一道「名字里有没有逗号」
// 的检查兜住了。详情见 `chineseDays.ts` 里那个函数上面。

/** 这一天的「休 / 班」记号；不是法定节假日也不是调休上班日就返回 `null`。 */
export type HolidayMark = '休' | '班';

/**
 * 「休」= 放假通知点名的那几天；「班」= 通知里要求补上班的那几天。
 *
 * **普通的周六周日不标**：那是每周都有的事，标出来等于每格都有记号，记号也就
 * 不再是记号了。这里回答的是「这一天跟平常不一样吗」。
 *
 * 判据是**通知里有没有这一天的名字**，不是「是不是周末」。`isHoliday()` 对
 * 普通周六也返回 `true`（它回答的是「这天要不要上班」），拿它当判据就得再补一
 * 个「周末除外」的例外——而那个例外会把国庆七天里的周六周日一起漏掉，屏幕上
 * 是一整块「休」中间空两格（实测长这样，10 月 1、2、5、6、7 有记号，3、4 没
 * 有）。`getDayDetail().name` 分得干净：法定假期那几天是
 * `"National Day,国庆节,3"`，普通周六就是 `"Saturday"`。
 *
 * **表覆盖不到的年份一律返回 `null`**。`chinese-days` 对表外的日期返回
 * `work: true`——照那个画，2027 年的国庆会被标成「班」。宁可不说。
 */
export function holidayMark(d: Date): HolidayMark | null {
  if (d.getFullYear() > holidayDataLastYear()) return null;
  const detail = cd.getDayDetail(dayKey(d));
  // 被点名的那几天，`name` 是 "英文名,中文名,第几天" 三段；普通日子只有一段
  // （英文星期几）。
  if (detail.name.split(',').length < 2) return null;
  return detail.work ? '班' : '休';
}

/** 读屏用的整句：「八月廿一，国庆节假期」这种，屏幕上那半行小字太碎。 */
export function lunarAria(d: Date): string {
  const l = cd.getLunarDate(dayKey(d));
  const mark = holidayMark(d);
  const tail = mark === '休' ? '，放假' : mark === '班' ? '，调休上班' : '';
  return `农历${l.lunarMonCN}${l.lunarDayCN}${tail}`;
}
