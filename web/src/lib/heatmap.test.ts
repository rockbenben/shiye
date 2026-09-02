import { describe, it, expect } from 'vitest';
import { HEATMAP_LEVELS, heatLevel, heatmapWeeks, monthLabels } from './heatmap.js';

/** 2026-08-19 是周三。 */
const NOW = new Date(2026, 7, 19, 15);

describe('heatmapWeeks', () => {
  it('一周一列，每列七格', () => {
    const cols = heatmapWeeks(NOW);
    expect(cols.every((c) => c.length === 7)).toBe(true);
  });

  it('每一行恒是同一个星期几——补齐到周一，横着扫一行才看得出规律', () => {
    const cols = heatmapWeeks(NOW);
    for (const col of cols) {
      expect(col[0].date.getDay()).toBe(1);   // 周一
      expect(col[6].date.getDay()).toBe(0);   // 周日
    }
  });

  it('最后一格就是今天', () => {
    const cols = heatmapWeeks(NOW);
    const last = cols[cols.length - 1].filter((c) => !c.pad).at(-1)!;
    expect(last.key).toBe('2026-08-19');
  });

  it('第一列开头落在窗口之外的标成 pad——「还没开始统计」跟「那天什么都没做」不是一回事', () => {
    // 窗口 11 天：起点是 8/9（周日），补齐到 8/3（周一），第一列前六格在窗口外。
    // （挑 11 不挑 10 是因为 10 天的起点 8/10 本身就是周一，一格 pad 都没有——
    // 那个窗口测不出这条。）
    const cols = heatmapWeeks(NOW, 1, 11);
    expect(cols[0].filter((c) => c.pad)).toHaveLength(6);
    expect(cols[0][6].key).toBe('2026-08-09');
  });

  it('窗口正好从周一开始时一格 pad 都没有', () => {
    const cols = heatmapWeeks(NOW, 1, 10);   // 起点 8/10，周一
    expect(cols[0].every((c) => !c.pad)).toBe(true);
  });

  it('窗口末尾之后的也标 pad——今天之后那几格不是「没做」', () => {
    const cols = heatmapWeeks(NOW, 1, 10);
    const tail = cols[cols.length - 1];
    // 今天是周三，这一列周四到周日都在今天之后
    expect(tail.filter((c) => c.pad).length).toBeGreaterThan(0);
  });

  it('不重不漏：非 pad 的格子恰好是窗口那些天', () => {
    const cols = heatmapWeeks(NOW, 1, 30);
    const real = cols.flat().filter((c) => !c.pad);
    expect(real).toHaveLength(30);
    expect(new Set(real.map((c) => c.key)).size).toBe(30);
  });
});

describe('heatLevel', () => {
  it('0 或负数是第 0 档', () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(-5, 100)).toBe(0);
  });

  it('**有值至少是第 1 档**——向下取整会让很小的值跟「什么都没做」画得一样', () => {
    expect(heatLevel(1, 10_000)).toBe(1);
  });

  it('等于最大值是最深那档', () => {
    expect(heatLevel(100, 100)).toBe(HEATMAP_LEVELS);
  });

  it('按 max 线性分档——一天 25 分钟的人也该看到有深浅的图', () => {
    expect(heatLevel(25, 100)).toBe(1);
    expect(heatLevel(50, 100)).toBe(2);
    expect(heatLevel(75, 100)).toBe(3);
  });

  it('max 是 0（一年一次都没有）时全是第 0 档，不除以零', () => {
    expect(heatLevel(0, 0)).toBe(0);
    expect(heatLevel(5, 0)).toBe(0);
  });
});

describe('monthLabels', () => {
  it('跨进新月份的那一列才标', () => {
    const cols = heatmapWeeks(NOW, 1, 60);
    const labels = monthLabels(cols);
    expect(labels.filter(Boolean).length).toBeGreaterThan(0);
    // 同一个月里连着的列不重复标
    expect(labels.filter((x) => x === labels.find(Boolean)).length).toBe(1);
  });

  it('长度跟列数一致——界面上一列一个槽位', () => {
    const cols = heatmapWeeks(NOW);
    expect(monthLabels(cols)).toHaveLength(cols.length);
  });
});

describe('monthLabels：挨着的标签不叠字', () => {
  it('相邻两列不会都标上——一列 13px，标签二十来像素，叠出来是「8月月」', () => {
    const cols = heatmapWeeks(NOW);
    const labels = monthLabels(cols);
    for (let i = 1; i < labels.length; i++) {
      expect(!(labels[i] && labels[i - 1]), `第 ${i - 1}、${i} 列都标了：${labels[i - 1]} / ${labels[i]}`).toBe(true);
    }
  });

  it('**首月只占一列时宁可不标**——这是每年都会撞上的那一档，不是边角情况', () => {
    // 窗口从某个月的最后一周开始：第 0 列是上个月，第 1 列就跨进新月份。
    const cols = heatmapWeeks(NOW, 1, 30);
    const labels = monthLabels(cols);
    expect(labels[0] && labels[1]).toBeFalsy();
  });

  it('后面那些整月照标不误——这条修的是碰撞，不是把标签删光', () => {
    expect(monthLabels(heatmapWeeks(NOW)).filter(Boolean).length).toBeGreaterThanOrEqual(11);
  });
});

/**
 * **热力图每一行代表星期几，跟着设置走。**
 *
 * 跟 `focusStats` 那处同源：这儿原来也抄了一份写死周一的 `mondayOf`。后果比
 * 那边轻（错的是行的含义，不是一个数字），但形状一样——同一个应用里两个
 * 「一周从哪天开始」。
 */
describe('heatmapWeeks：列的起点跟着 weekStart 走', () => {
  // 8/26 是周三，30 天窗口的第一天是 7/28（周二）。第一列要**往前**补到那一档的
  // 周首：周一档 7/27、周日档 7/26、周六档 7/25。
  const WED = new Date(2026, 7, 26, 12);
  const firstReal = (ws: 0 | 1 | 6) =>
    heatmapWeeks(WED, ws, 30).flat().find((c) => !c.pad)!.key;
  const firstCell = (ws: 0 | 1 | 6) => heatmapWeeks(WED, ws, 30)[0][0].key;

  it.each([
    [1, '2026-07-27'],
    [0, '2026-07-26'],
    [6, '2026-07-25'],
  ] as const)('weekStart=%s 时第一列第一格是 %s', (ws, want) => {
    expect(firstCell(ws)).toBe(want);
  });

  it('三档的起点互不相同——否则上面那族可能是「参数根本没被读」在相等', () => {
    expect(new Set([0, 1, 6].map((ws) => firstCell(ws as 0 | 1 | 6))).size).toBe(3);
  });

  it('换档不改窗口本身：非 pad 的第一天永远是 30 天前那天', () => {
    for (const ws of [0, 1, 6] as const) expect(firstReal(ws)).toBe('2026-07-28');
  });

  it('每一列都是整七格，三档都是——补齐的是列首，不是把窗口切歪', () => {
    for (const ws of [0, 1, 6] as const) {
      for (const col of heatmapWeeks(WED, ws, 30)) expect(col).toHaveLength(7);
    }
  });

  it('不给这个参数就按周一，跟设置的默认档一致', () => {
    expect(firstCell(1)).toBe(heatmapWeeks(WED, undefined, 30)[0][0].key);
  });
});
