import { describe, it, expect, vi, afterEach } from 'vitest';
import { dueChip, dueText, whenText } from './dueChip.js';
import { URGENT_WITHIN_DAYS } from './agenda.js';

const NOW = new Date(2026, 7, 16, 12, 0, 0); // 2026-08-16 本地时间中午
const at = (y: number, m: number, d: number, h = 9, min = 0): string => new Date(y, m - 1, d, h, min).toISOString();

describe('dueChip：文案', () => {
  it('null → null，不显示', () => {
    expect(dueChip(null, NOW)).toBeNull();
  });

  it('解析不了 → null，不抛', () => {
    expect(dueChip('下周三', NOW)).toBeNull();
  });

  it('今天、带具体时刻 → "今天 HH:mm"', () => {
    expect(dueChip(at(2026, 8, 16, 18, 0), NOW)).toMatchObject({ text: '今天 18:00', overdue: false });
  });

  it('今天、本地零点（没写具体时刻）→ 只显示 "今天"，不带 00:00，**而且当天不算过期**', () => {
    // 这条断言原来写的是 `overdue: true`，还配了一句「NOW 是当天中午，零点
    // 早于它——chronologically 确实 overdue」。那正是被修掉的那个 bug：本地
    // 零点在这个应用里的意思是「这一整天」（`isAllDay`，日历那半一直这么用），
    // 不是「当天最早的那一刻」。照旧的读法，从「安排任务」栏拖一条到今天格子
    // 里，下午看那张卡是「过期 13 小时」——实测过。判据现在统一走
    // `taskView.dueOverdue`，这里不再自己写一份 `t < now`。
    expect(dueChip(at(2026, 8, 16, 0, 0), NOW)).toMatchObject({ text: '今天', overdue: false });
  });

  it('明天 → "明天"，不带时刻', () => {
    expect(dueChip(at(2026, 8, 17, 9, 30), NOW)).toMatchObject({ text: '明天', overdue: false });
  });

  it('明天跨月：8 月 31 日的明天是 9 月 1 日，Date 构造函数自己进位', () => {
    const now31 = new Date(2026, 7, 31, 12, 0, 0);
    expect(dueChip(at(2026, 9, 1, 9), now31)).toMatchObject({ text: '明天', overdue: false });
  });

  it('昨天 → "昨天"，而且是过期的——今天明天都有相对说法，往前一天却掉回日期，而过期一天正是最常见的那种', () => {
    expect(dueChip(at(2026, 8, 15, 9), NOW)).toMatchObject({ text: '昨天', overdue: true });
  });

  it('昨天跨月：9 月 1 日的昨天是 8 月 31 日', () => {
    const now1 = new Date(2026, 8, 1, 12, 0, 0);
    expect(dueChip(at(2026, 8, 31, 9), now1)).toMatchObject({ text: '昨天', overdue: true });
  });

  it('前天不说「前天」——那是卡片上那个记号在回答的问题（overdueLabel），这颗 chip 回答的是「什么时候到期」', () => {
    expect(dueChip(at(2026, 8, 14, 9), NOW)).toMatchObject({ text: '8月14日', overdue: true });
  });

  it('今年内、既非今天也非明天 → "M月D日"', () => {
    expect(dueChip(at(2026, 10, 3, 9), NOW)).toMatchObject({ text: '10月3日', overdue: false });
  });

  it('跨年 → "YYYY年M月D日"', () => {
    expect(dueChip(at(2027, 1, 3, 9), NOW)).toMatchObject({ text: '2027年1月3日', overdue: false });
  });

  it('已过期（due < now）→ overdue: true，文案照常按日期分类算', () => {
    expect(dueChip(at(2026, 8, 1, 9), NOW)).toMatchObject({ text: '8月1日', overdue: true });
  });

  it('还没到 → overdue: false', () => {
    expect(dueChip(at(2026, 12, 1, 9), NOW)).toMatchObject({ text: '12月1日', overdue: false });
  });

  it('due 恰好等于 now 不算过期——严格小于才算', () => {
    const now = new Date(2026, 7, 16, 12, 0, 0, 0);
    expect(dueChip(now.toISOString(), now)!.overdue).toBe(false);
  });

  // 修复轮 1 · I-2：除了「明天跨月」那条，原本所有用例共用同一个 NOW——
  // 把 dueChip.ts 里 `dayKey(now)` 换成写死的 '2026-08-16' 照样 12/12 全绿，
  // 因为没有一条用例真的换过 now。这里同一个 due，换两个不同的 now，从
  // 「今年内」变成「今天」——写死字符串的话第二个断言会失败。
  it('同一个 due，换一个 now 就从「今年内」变成「今天」——now 真的被读了，不是巧合共用同一份夹具', () => {
    const due = at(2026, 10, 3, 9);
    expect(dueChip(due, NOW)).toMatchObject({ text: '10月3日', overdue: false });
    const nowOnThatDay = new Date(2026, 9, 3, 12, 0, 0);
    expect(dueChip(due, nowOnThatDay)).toMatchObject({ text: '今天 09:00', overdue: true });
  });
});

// 顺手清的时区债：这个守卫测的是「dueChip 靠 calendar.ts 的 dayKey 比较本地
// 日期，没有偷懒用 toISOString().slice(0,10)」——UTC 切日期这个 bug 天生只在
// 本地时区不是 UTC 时才会显形（UTC 机器上本地日期跟 UTC 日期天然相同，这道
// 守卫在那种机器上无论 dueChip 实现对不对都会绿，属于摆设）。原来这条测试
// 默认「跑测试的机器是东八区」；实测过 `TZ=UTC` 下这条会直接报红（不是空转
// 报绿——`due.slice(0,10)` 那句自证陷阱的断言本身就先失败了），也就是说
// `npm test` 全绿这句话原来只在东八区机器上为真。
//
// 用 `vi.stubEnv('TZ', …)` 把这条测试自己的时区钉死，不依赖宿主机——跟
// calendar.test.ts 的「东八区」守卫同一个办法、同一个理由：那边已经验证过
// `vi.stubEnv('TZ', …)` 在这个仓库当前的 Node/vitest 组合下对 `Date`/`Intl`
// 立即生效；也验证过不能指望 shell 层 `TZ=xxx npm test` 这种写法——这个仓库
// 的 Bash 工具走的是 Git Bash（MSYS），MSYS 会把带斜杠的环境变量值（比如
// `Asia/Shanghai`）当成 POSIX 路径去转换，转换失败就把这个变量整个丢了，
// `process.env.TZ` 进程内读到的是 `undefined`；换成 PowerShell 设
// `$env:TZ` 完全正常，这是这一个 shell 工具的坑，跟 Node/Windows 本身无关。
describe('dueChip：东八区凌晨那条——日期一律本地，不能用 toISOString().slice(0,10)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('本地凌晨 0:30 的任务算在当天，不是 UTC 换算出来的前一天', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    // 注意：不能沿用模块顶层的 NOW——那个常量在 stub 生效之前、模块刚加载时
    // 就已经按宿主机当时的时区构造好了，是一个固定的 UTC 时刻。这条测试跑在
    // 别的时区机器上时，那个固定时刻经 stub 后的时区重新解读，不一定还落在
    // 「2026-08-16 当地中午」——必须在 stub 生效之后重新 new 一个，跟下面
    // `at()` 现造的 due 处在同一个时区语境里，两边才可比。
    const now = new Date(2026, 7, 16, 12, 0, 0); // 当地中午
    // 当地（东八区）0:30 换算成 UTC 是前一天 16:30，.toISOString().slice(0,10)
    // 切出来的日期字符串会是前一天，跟 now 的本地日期对不上，误判成「不是
    // 今天」。先证明这个陷阱在钉死的时区语境下真实存在，再断言实现绕开了它。
    const due = at(2026, 8, 16, 0, 30);
    expect(due.slice(0, 10)).toBe('2026-08-15');
    // now 是当天中午，00:30 chronologically 也确实过了——这条只盯「落在哪
    // 一天」判对了没有，overdue 那半用同一份夹具在上面的 describe 里单独测。
    expect(dueChip(due, now)).toMatchObject({ text: '今天 00:30', overdue: true });
  });
});

/**
 * `whenText`：卡片上「截止」「提醒」那两个值。
 *
 * 它存在的理由是**两种密度不能对同一件事说两种话**：行档下这条任务读作
 * 「今天 18:00」，切成卡片档原来变成「截止 2026-08-24 18:00」——而卡片上它
 * 左边紧挨着的就是「过期 3 小时」，同一个事实的相对说法和绝对说法并排摆着。
 */
describe('whenText：卡片上的时刻，跟行档一个词', () => {
  it('哪一天的说法跟 dueChip 完全一致——这是它跟 dayText 共用一份实现的意义', () => {
    for (const [y, m, d] of [[2026, 8, 16], [2026, 8, 17], [2026, 8, 15], [2026, 9, 1], [2025, 12, 31]] as const) {
      const iso = at(y, m, d, 14, 30);
      // dueChip 只在「今天」那一档带时刻，所以拿它的文案当前缀比。
      const day = dueChip(iso, NOW)!.text.replace(/ \d\d:\d\d$/, '');
      expect(whenText(iso, NOW)).toBe(`${day} 14:30`);
    }
  });

  it('**零点照样把时刻写出来**——dueChip 那边零点当「没定时刻」是给到期日用的（随口一句「今天」不该显示成定了个零点的闹钟），而提醒定在零点是一个真的闹钟，吞掉时刻会让它看起来没设', () => {
    const midnight = at(2026, 8, 16, 0, 0);
    expect(dueChip(midnight, NOW)!.text).toBe('今天');
    expect(whenText(midnight, NOW)).toBe('今天 00:00');
  });

  it('解析不了就原样吐回，不抛——磁盘上那份是手改的，`taskView.formatWhen` 也是这个态度', () => {
    expect(whenText('下周三', NOW)).toBe('下周三');
  });
});

describe('dueText：到期日那一档，零点不写时刻', () => {
  const NOW = new Date(2026, 7, 25, 13, 0);
  const iso = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

  it('**本地零点只写哪一天**——零点在到期日上的意思是「这一整天」，写成「今天 00:00」看着像定了个零点的闹钟，而且跟「整天的当天不算过期」对不上（实测见过同一张卡上并排写「过期 13 小时」和「截止 今天 00:00」）', () => {
    expect(dueText(iso(2026, 8, 25), NOW)).toBe('今天');
    expect(dueText(iso(2026, 8, 26), NOW)).toBe('明天');
  });

  it('定了钟点的照旧带上', () => {
    expect(dueText(iso(2026, 8, 25, 18, 30), NOW)).toBe('今天 18:30');
    expect(dueText(iso(2026, 8, 26, 9, 0), NOW)).toBe('明天 09:00');
  });

  it('**提醒那一档不走这条**——提醒定在零点是一个真的闹钟，吞掉时刻会让它看起来没设', () => {
    expect(whenText(iso(2026, 8, 25), NOW)).toBe('今天 00:00');
  });
});

describe('dueChip 的 overdue 跟卡片上那个红标签是同一条判据', () => {
  const iso = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

  it('今天的全天任务当天不算过期——原来这里自己写 `t < now`，是同一条规则的第三份拷贝，全天规则补上之后它没跟上，同一条任务会一边红一边不红', () => {
    expect(dueChip(iso(2026, 8, 25), new Date(2026, 7, 25, 13, 0))!.overdue).toBe(false);
    expect(dueChip(iso(2026, 8, 25), new Date(2026, 7, 26, 0, 30))!.overdue).toBe(true);
  });

  it('定了钟点的照旧按时刻比', () => {
    expect(dueChip(iso(2026, 8, 25, 9, 0), new Date(2026, 7, 25, 13, 0))!.overdue).toBe(true);
    expect(dueChip(iso(2026, 8, 25, 18, 0), new Date(2026, 7, 25, 13, 0))!.overdue).toBe(false);
  });
});

/**
 * **「快到期」这一档**（仿 OmniFocus 的 `Due Soon`）。
 *
 * 上面那些用例改成了 `toMatchObject`：它们测的一直是「文案对不对、算不算
 * 过期」，`soon` 是后加的第三个字段，逐条给它硬填一个值等于让十七条用例都去
 * 关心一件它们本来不关心的事。这一族专测它，而且**正反两面都有**。
 */
describe('dueChip：快到期', () => {
  const soonOf = (iso: string, at = NOW) => dueChip(iso, at)?.soon;

  it.each([
    ['今天', 0, true],
    ['明天', 1, true],
    ['三天后（边界之内）', URGENT_WITHIN_DAYS, true],
    ['四天后（边界之外）', URGENT_WITHIN_DAYS + 1, false],
    ['一个月后', 30, false],
  ] as const)('%s → soon=%s', (_n, plusDays, want) => {
    const d = new Date(NOW);
    d.setDate(d.getDate() + plusDays);
    d.setHours(12, 0, 0, 0);
    expect(soonOf(d.toISOString())).toBe(want);
  });

  /**
   * **整日边界，不是「往后推 N 天的同一时刻」。** 跟四象限那条边界是同一个
   * 函数（`agenda.ts` 的 `endOfDay`）——三天后深夜到期也该算快到期，按「同一
   * 时刻」算的话它会被误判成不急。`cells.test.ts` 里有一条一模一样的。
   */
  it('三天后深夜也算快到期', () => {
    const d = new Date(NOW);
    d.setDate(d.getDate() + URGENT_WITHIN_DAYS);
    d.setHours(23, 0, 0, 0);
    expect(soonOf(d.toISOString())).toBe(true);
  });

  /**
   * **过期的不叫「快到期」。** 两者互斥——已经欠着了是另一句话，而且它已经
   * 有自己那身红。不互斥的后果是一条过期任务同时挂上两种样式。
   */
  it('已经过期的 soon=false，overdue=true——两者互斥', () => {
    const chip = dueChip(at(2026, 8, 15, 9), NOW)!;
    expect(chip.overdue).toBe(true);
    expect(chip.soon).toBe(false);
  });

  it('没有 due / 解析不了的没有 chip，也就谈不上快到期', () => {
    expect(dueChip(null, NOW)).toBeNull();
    expect(dueChip('下周三', NOW)).toBeNull();
  });
});
