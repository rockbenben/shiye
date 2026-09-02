import { describe, it, expect } from 'vitest';
import { checkCountdownPatch, isDateString } from './countdown.js';

describe('isDateString', () => {
  it('YYYY-MM-DD 才算', () => {
    expect(isDateString('2026-09-01')).toBe(true);
    for (const bad of ['2026/09/01', '2026-9-1', '', '下周三', '2026-09-01T00:00:00Z', 42, null]) {
      expect(isDateString(bad), String(bad)).toBe(false);
    }
  });

  it('**不存在的日子不算**——只判格式的话 2026-02-30 能过，构造回去会溢出成 3 月 2 日', () => {
    expect(isDateString('2026-02-30')).toBe(false);
    expect(isDateString('2026-13-01')).toBe(false);
    expect(isDateString('2026-04-31')).toBe(false);
  });

  it('闰年的 2 月 29 算，平年不算', () => {
    expect(isDateString('2028-02-29')).toBe(true);
    expect(isDateString('2027-02-29')).toBe(false);
  });
});

describe('checkCountdownPatch', () => {
  it('三个键都合法时收下', () => {
    const r = checkCountdownPatch({ title: ' 考试 ', date: '2026-09-01', yearly: true });
    expect(r.ok && r.value).toEqual({ title: '考试', date: '2026-09-01', yearly: true });
  });

  it('只给一个键也行——PATCH 要能只改一个字段', () => {
    const r = checkCountdownPatch({ yearly: true });
    expect(r.ok && r.value).toEqual({ yearly: true });
  });

  it('未知键整条拒收，不是悄悄过滤掉', () => {
    expect(checkCountdownPatch({ title: '考试', 别的: 1 }).ok).toBe(false);
  });

  it('标题去空白之后不能是空的', () => {
    expect(checkCountdownPatch({ title: '   ' }).ok).toBe(false);
  });

  it('日期不合法时点名是 date 这个字段——横幅要说清改哪儿', () => {
    const r = checkCountdownPatch({ date: '2026-02-30' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.field).toBe('date');
  });

  it('yearly 不是布尔值就拒收', () => {
    expect(checkCountdownPatch({ yearly: '是' }).ok).toBe(false);
  });

  it('请求体不是对象', () => {
    expect(checkCountdownPatch(null).ok).toBe(false);
    expect(checkCountdownPatch('x').ok).toBe(false);
  });
});

/**
 * 农历那一档（仿滴答清单：「点击日期，可选择设置为公历或农历」）。校验器这边
 * 只管「给了的话合不合法」——「农历只在每年下成立」那条**不在这儿判**，理由
 * 写在校验器里那段注释上。
 */
describe('checkCountdownPatch：lunar', () => {
  it('布尔值收下', () => {
    const r = checkCountdownPatch({ lunar: true });
    expect(r.ok && r.value.lunar).toBe(true);
  });

  it('不是布尔值就拒收，跟 yearly 一条规矩', () => {
    const r = checkCountdownPatch({ lunar: '农历' });
    expect(r.ok).toBe(false);
  });

  it('**只带 lunar 一个键也收**——PATCH 得能只改一个字段', () => {
    const r = checkCountdownPatch({ lunar: false });
    expect(r.ok && Object.keys(r.value)).toEqual(['lunar']);
  });

  it('lunar 为真、yearly 没给：收下不拦——那是无害的自相矛盾，见校验器里那段', () => {
    expect(checkCountdownPatch({ lunar: true }).ok).toBe(true);
  });

  it('还是不认没见过的键', () => {
    expect(checkCountdownPatch({ 农历: true }).ok).toBe(false);
  });
});
