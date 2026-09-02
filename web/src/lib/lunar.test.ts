import { describe, expect, it } from 'vitest';
import { holidayMark, lunarAria, lunarLabel } from './lunar.js';

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe('lunarLabel：一格只写一样', () => {
  it('节气那天写节气', () => {
    expect(lunarLabel(d(2026, 8, 7))).toBe('立秋');
    expect(lunarLabel(d(2026, 8, 23))).toBe('处暑');
  });

  it('农历传统节日写节日名，不写「初一」', () => {
    expect(lunarLabel(d(2026, 2, 17))).toBe('春节'); // 丙午年正月初一
    expect(lunarLabel(d(2026, 9, 25))).toBe('中秋'); // 八月十五
  });

  it('**公历节日排在节气前面**——10 月 1 日那天要说的是「国庆」，不是「寒露」', () => {
    expect(lunarLabel(d(2026, 10, 1))).toBe('国庆');
  });

  it('每月初一写农历月份，别的日子写农历日——一个月里只有一天需要回答「农历几月」', () => {
    expect(lunarLabel(d(2026, 10, 10))).toBe('九月'); // 九月初一
    expect(lunarLabel(d(2026, 8, 25))).toBe('十三');
  });

  it('写出来的都不超过 3 个字——一格宽的时候只有半行位置', () => {
    for (let i = 0; i < 366; i++) {
      const day = new Date(2026, 0, 1 + i);
      expect(lunarLabel(day).length, `${day.toDateString()} → ${lunarLabel(day)}`).toBeLessThanOrEqual(3);
    }
  });
});

describe('holidayMark：只回答「这一天跟平常不一样吗」', () => {
  it('法定节假日标「休」', () => {
    expect(holidayMark(d(2026, 10, 1))).toBe('休'); // 国庆
    expect(holidayMark(d(2026, 2, 17))).toBe('休'); // 春节
    expect(holidayMark(d(2026, 1, 1))).toBe('休'); // 元旦
  });

  it('调休要上班的周末标「班」', () => {
    expect(holidayMark(d(2026, 1, 4))).toBe('班'); // 周日，元旦调休
    expect(holidayMark(d(2026, 10, 10))).toBe('班'); // 周六，国庆调休
  });

  it('**普通周末不标**——每周都有的事，标出来等于每格都有记号', () => {
    expect(holidayMark(d(2026, 8, 22))).toBeNull(); // 普通周六
    expect(holidayMark(d(2026, 8, 23))).toBeNull(); // 普通周日
  });

  it('**长假中间的周末照样标「休」**——判据是通知里点没点这一天的名，不是这天是不是周末；拿「周末除外」当例外会让国庆七天中间空两格', () => {
    expect(holidayMark(d(2026, 10, 3))).toBe('休'); // 周六，在国庆假期里
    expect(holidayMark(d(2026, 10, 4))).toBe('休'); // 周日，在国庆假期里
    // 国庆那一整块七天，一天不落。
    for (let i = 1; i <= 7; i++) expect(holidayMark(d(2026, 10, i)), `10 月 ${i} 日`).toBe('休');
  });

  it('普通工作日不标', () => {
    expect(holidayMark(d(2026, 8, 25))).toBeNull();
  });

  it('**数据覆盖不到的年份一律不标**——chinese-days 对表外日期返回 work:true，照那个画会把 2027 国庆标成「班」，一个看起来像答案的错答案', () => {
    expect(holidayMark(d(2027, 10, 1))).toBeNull();
    expect(holidayMark(d(2027, 2, 6))).toBeNull();
    expect(holidayMark(d(2030, 5, 1))).toBeNull();
  });

  it('农历和节气不受那道年份闸门影响——它们是算出来的，不靠谁发布', () => {
    expect(lunarLabel(d(2030, 2, 4))).toBe('立春');
    // 2030 年的正月初一是 2 月 3 日（立春前一天）——这条顺带钉住「农历新年
    // 每年在公历上跳」这件事真的被算出来了，不是写死的表。
    expect(lunarLabel(d(2030, 2, 3))).toBe('春节');
    expect(lunarLabel(d(2027, 2, 6))).toBe('春节');
  });
});

describe('lunarAria：读屏读的是整句，不是屏幕上那半行碎字', () => {
  it('普通日子只报农历', () => {
    expect(lunarAria(d(2026, 8, 25))).toBe('农历七月十三');
  });

  it('放假和调休各自说清楚', () => {
    expect(lunarAria(d(2026, 10, 1))).toContain('放假');
    expect(lunarAria(d(2026, 10, 10))).toContain('调休上班');
  });
});
