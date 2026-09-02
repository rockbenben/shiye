import cd from 'chinese-days';

/**
 * `chinese-days` 的访问层——**农历换算和「休 / 班」判定在这个仓库里唯一的入口**。
 *
 * ## 为什么在 server 而不是 web
 *
 * 用它的有两处：日历格子上那半行小字（`web/src/lib/lunar.ts`），和重复规则里
 * 「农历每年 / 每月」「法定工作日 / 节假日」那四档（`server/src/repeat.ts`）。
 * 后者住在 server，而 web **反过来引 server 的 `repeat.ts`**（`repeatProjection.ts`
 * 等四处），所以放在这边两边都够得着；反过来放在 web，server 引不到
 * （两个包的 rootDir 约束，见 `mutate.ts` 顶部）。
 *
 * `chinese-days` 因此也进了 `server/package.json`——它本来只在 web 那份里。
 * 包本身没变（MIT、零运行时依赖、ESM 产物 32KB + 一张 JSON 表），挑它的四问
 * 记在 `web/src/lib/lunar.ts` 顶部，这儿不重复。
 *
 * ## 表的边界是这个模块存在的第二个理由
 *
 * 农历和节气是**算出来的**，往后几十年都成立。**法定节假日和调休是发布出来的**
 * ——国务院办公厅每年下半年发一次下一年的通知，在那之前世界上不存在这个数据。
 * 而 `chinese-days` 对表外的日期一律答 `work: true`（当普通工作日）：照它直接
 * 用，2027 年的国庆会被算成上班日，而「法定工作日每天重复」会安静地把假期也
 * 排进去——一个**看起来像答案的错答案**。
 */

/** 表的第一年。`chinese-days` 的放假通知整理自 2004 年起。 */
const FIRST_YEAR = 2004;

let lastKnownYear: number | null = null;

/**
 * 法定节假日表覆盖到哪一年为止。
 *
 * **第三个参数 `false` 是这个函数的全部要害。** 它原来住在 `lunar.ts` 里，写的是
 * `getHolidaysInRange(`${y}-01-01`, `${y}-12-31`)`，注释说「每年至少有元旦，所以
 * 『空』只可能意味着『没数据』」——**而那个重载默认把周末也算进去**，于是每一年
 * 都有一百来天，循环一路跑到上限，算出来的「最后一年」是 2099。
 *
 * 也就是说：那道为「别把 2027 年的国庆标成班」而写的闸门，**从来没有生效过**。
 * 它没闯出祸，是因为 `holidayMark` 后面还有一道「名字里有没有逗号」的检查兜住了
 * （表外的日子名字就是 `"Friday"`）。一道防线失灵、另一道恰好补上——两道都在的
 * 时候看不出来，而这一批要用它做**真的**判断（重复规则），先把它修对。
 */
export function holidayDataLastYear(): number {
  if (lastKnownYear !== null) return lastKnownYear;
  let y = FIRST_YEAR;
  // 上限 2100 纯粹是防死循环，不是对数据的预期。
  for (; y < 2100; y++) {
    if (cd.getHolidaysInRange(`${y}-01-01`, `${y}-12-31`, false).length === 0) break;
  }
  lastKnownYear = y - 1;
  return lastKnownYear;
}

/** 这一年在表里吗。表外的一切「休 / 班」判断都必须先过这一关。 */
export const holidayYearKnown = (year: number): boolean =>
  year >= FIRST_YEAR && year <= holidayDataLastYear();

/** 本地日期的 `YYYY-MM-DD`。不用 `toISOString()`——那是 UTC，东八区凌晨会退一天。 */
export const dayKeyOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * **法定工作日**：要上班的那些天。周末和法定假期不算，**调休补班的那几天算**
 * （2026-10-10 就是这么一天）。
 *
 * 表外一律 `false`，不是 `cd.isWorkday` 的 `true`——理由见文件顶部那段。
 */
export function isLegalWorkday(d: Date): boolean {
  if (!holidayYearKnown(d.getFullYear())) return false;
  return cd.isWorkday(dayKeyOf(d));
}

/**
 * **法定节假日**：放假通知点名的那几天，**不含普通的周六周日**。
 *
 * 判据跟 `lunar.ts` 的 `holidayMark` 一字不差、也是同一个理由：`cd.isHoliday()`
 * 对普通周六也返回 `true`（它回答的是「这天要不要上班」）。拿它当判据就得再补
 * 一条「周末除外」，而那条例外会把国庆七天里的周六周日一起漏掉。
 * `getDayDetail().name` 分得干净：被点名的那几天是 `"National Day,国庆节,3"`
 * 三段，普通周六只有一段（英文星期几）。
 */
export function isLegalHoliday(d: Date): boolean {
  if (!holidayYearKnown(d.getFullYear())) return false;
  const detail = cd.getDayDetail(dayKeyOf(d));
  return !detail.work && detail.name.split(',').length >= 2;
}

/** 一个公历日期对应的农历年月日。 */
export function lunarOf(d: Date): { year: number; month: number; day: number } {
  const l = cd.getLunarDate(dayKeyOf(d));
  return { year: l.lunarYear, month: l.lunarMon, day: l.lunarDay };
}

/**
 * 农历年月日对应的公历日期。那一天不存在（月小却要三十）就**截到当月最后一天**
 * ——跟公历「每月 31 号」碰上二月退到 28 是同一条约定（`repeat.ts` 的 `month`
 * 分支），不新发明一种。
 *
 * **必须往返验证**：`getSolarDateFromLunar('2027-09-30')` 不报错，它会安静地
 * 滚到十月初一（实测）。不验的话，一条「农历九月三十」的重复会在小月那年
 * 漂进十月，而且此后再也回不来。
 *
 * 闰月一律取**非闰的那个月**（`leapMonthDate` 不取）：一年里闰月最多一个、
 * 而且哪一年闰哪个月没有规律，跟着闰走会让「农历每年」这条重复的间隔忽长忽短。
 */
export function solarFromLunar(year: number, month: number, day: number): Date | null {
  for (let d = day; d >= 1; d--) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    let solar: string;
    try {
      solar = cd.getSolarDateFromLunar(key).date;
    } catch {
      return null;
    }
    if (!solar) return null;
    const back = cd.getLunarDate(solar);
    if (back.lunarMon === month && back.lunarDay === d && !back.isLeap) {
      const [y, m, dd] = solar.split('-').map(Number);
      return new Date(y!, m! - 1, dd!);
    }
  }
  return null;
}
