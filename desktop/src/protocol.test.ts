import { describe, expect, it } from 'vitest';
import { parseProtocolUri, patchForAction, routeSecondInstance } from './protocol.js';

// 这三个函数不引 electron，是真的能跑、能测到底的代码——跟 main.ts 那边
// 只能靠源文本正则去猜行为不一样（main.test.ts 顶部注释）。这份文件的
// 存在本身就是修复轮 2 的核心：main.test.ts 上一版那几条正则曾经被两种
// 真实的改坏绕过去（换个名字做同一件事、用一行诱饵注释顶替正则的第一次
// 命中）——对这里的测试没有意义，它们从头到尾没有读过任何源文本，只调用
// `import` 进来的真实函数、检查真实返回值：production 代码换成什么名字、
// 周围加多少行注释，都不影响 `routeSecondInstance(argv)` 这次调用到底
// 执行的是哪一段逻辑（模块系统本身保证了这件事——TypeScript 的具名 import
// 是硬绑定，不是文本查找），也不影响它返回的对象长什么样。

describe('parseProtocolUri：合法的两种', () => {
  it('complete', () => {
    expect(parseProtocolUri('todo-desktop://complete?id=abc')).toEqual({ kind: 'complete', id: 'abc' });
  });

  it('snooze', () => {
    expect(parseProtocolUri('todo-desktop://snooze?id=abc')).toEqual({ kind: 'snooze', id: 'abc' });
  });

  // id 不能是写死的：第二个 id 不同的夹具才分得清「读了这一条」和「永远
  // 返回同一个字面量」——跟 notify.test.ts「body 是这一条的标题，不是写死
  // 的」同一个手法。
  it('id 是 URI 里带的那个，不是写死的', () => {
    expect(parseProtocolUri('todo-desktop://complete?id=xyz-999')).toEqual({ kind: 'complete', id: 'xyz-999' });
  });
});

describe('parseProtocolUri：坏输入一律 null，不抛', () => {
  it.each([
    ['hostname 不认识', 'todo-desktop://frobnicate?id=abc'],
    ['没有 id', 'todo-desktop://complete'],
    ['id 是空串', 'todo-desktop://complete?id='],
    ['不是这个协议（http）', 'http://complete?id=abc'],
    ['不是这个协议（另一个自定义 scheme）', 'other-app://complete?id=abc'],
    ['根本不是 URL', 'not a url at all'],
    ['空字符串', ''],
  ])('%s → null', (_n, uri) => {
    expect(() => parseProtocolUri(uri)).not.toThrow();
    expect(parseProtocolUri(uri)).toBeNull();
  });
});

describe('patchForAction：now 是参数，不读全局时钟', () => {
  // 固定的 now——不用 Date.now()/无参数 new Date()，能钉死 at 的具体值。
  const now = new Date('2026-08-19T10:00:00.000Z');

  it("complete → { status: 'done' }", () => {
    expect(patchForAction('complete', now)).toEqual({ status: 'done' });
  });

  it('snooze → 新提醒的 at 是 now + SNOOZE_MINUTES 分钟，firedAt 是 null', () => {
    // SNOOZE_MINUTES 现在是 10——这里直接写死期望值 10:10:00 而不是从
    // notify.ts 读常量再算一遍，是故意的：patchForAction 内部已经从
    // SNOOZE_MINUTES 算过一次，测试如果也从同一个常量算，两边算法一旦
    // 同时错也测不出来（比如都手滑写成 + 分钟 - 1）；写死期望值等于用
    // 一个独立算出来的答案去对账，跟 SNOOZE_MINUTES 改了值这条测试就会
    // 主动报错提醒来更新，而不是悄悄跟着错误的算法一起漂移。
    expect(patchForAction('snooze', now)).toEqual({
      reminders: [{ at: '2026-08-19T10:10:00.000Z', firedAt: null }],
    });
  });

  it('两次调用传相同的 now，结果字节相同——不会在函数内部偷偷再读一次时钟', () => {
    expect(patchForAction('snooze', now)).toEqual(patchForAction('snooze', now));
  });
});

/**
 * 推迟时保住这条任务上别的提醒。这里原来是「整个替换掉 reminders 数组」，
 * 注释写着「等真的有人反馈『推迟之后别的提醒也被吃了』再补」——补的理由不是
 * 有人反馈，是网页那半边改成了「挪刚响的那条」：**同一颗写着「推迟 10 分钟」
 * 的按钮，一边只动一条、一边把这条任务的提醒全清成一条，而且后者在删数据**。
 */
describe('patchForAction：推迟不吃掉别的提醒', () => {
  const now = new Date('2026-08-19T10:00:00.000Z');
  const TEN = '2026-08-19T10:10:00.000Z';

  it('挪刚响过的那一条，没响的原样留着', () => {
    const fired = { at: '2026-08-19T09:00:00.000Z', firedAt: '2026-08-19T09:00:01.000Z' };
    const pending = { at: '2026-08-20T09:00:00.000Z', firedAt: null };
    expect(patchForAction('snooze', now, [fired, pending])).toEqual({
      reminders: [{ at: TEN, firedAt: null }, pending],
    });
  });

  it('好几条都响过：挪 firedAt 最新的那条', () => {
    const old = { at: '2026-08-18T09:00:00.000Z', firedAt: '2026-08-18T09:00:01.000Z' };
    const fresh = { at: '2026-08-19T09:00:00.000Z', firedAt: '2026-08-19T09:00:01.000Z' };
    expect(patchForAction('snooze', now, [old, fresh])).toEqual({
      reminders: [old, { at: TEN, firedAt: null }],
    });
  });

  it('一条盖过章的都没有：追加，不动原来那些', () => {
    const pending = { at: '2026-08-20T09:00:00.000Z', firedAt: null };
    expect(patchForAction('snooze', now, [pending])).toEqual({
      reminders: [pending, { at: TEN, firedAt: null }],
    });
  });

  it('**取任务失败（null）退回老路**：发一条、覆盖掉——取不到时宁可少留几条，也不能让那颗按钮点了没反应', () => {
    expect(patchForAction('snooze', now, null)).toEqual({ reminders: [{ at: TEN, firedAt: null }] });
    expect(patchForAction('snooze', now)).toEqual({ reminders: [{ at: TEN, firedAt: null }] });
  });

  it('「完成」不受影响——它跟别的字段无关，调用方那边也不会为它多跑一次取任务', () => {
    expect(patchForAction('complete', now, [{ at: 'x', firedAt: null }])).toEqual({ status: 'done' });
  });
});

describe('routeSecondInstance：argv 里有没有协议 URI', () => {
  it('有协议 URI → { kind: "protocol", uri }', () => {
    expect(routeSecondInstance(['C:\\app.exe', 'todo-desktop://complete?id=abc'])).toEqual({
      kind: 'protocol',
      uri: 'todo-desktop://complete?id=abc',
    });
  });

  it('没有协议 URI（普通重复启动/双击）→ { kind: "open" }', () => {
    expect(routeSecondInstance(['C:\\app.exe'])).toEqual({ kind: 'open' });
  });

  it('空数组 → { kind: "open" }', () => {
    expect(routeSecondInstance([])).toEqual({ kind: 'open' });
  });

  it('有多个协议 URI 时取第一个（Array#find 的既有语义）', () => {
    expect(
      routeSecondInstance(['C:\\app.exe', 'todo-desktop://complete?id=first', 'todo-desktop://snooze?id=second']),
    ).toEqual({ kind: 'protocol', uri: 'todo-desktop://complete?id=first' });
  });
});

// 修复轮 2 要拦住的两种逃逸，为什么现在拦得住（细节和实测的 mutation 记录
// 在 task-2-report.md，这里只放对应的行为断言）：
describe('C／方向反了：协议 URI 判成 protocol，没有协议 URI 判成 open', () => {
  // C 那次改坏把 if/else 判断对调、配一行诱饵注释混过了正则——诱饵注释
  // 这个维度对这里不成立：`routeSecondInstance` 不是靠字符串位置被断言的，
  // 是被真的调用、返回值被真的比较，产量代码里加多少行注释都不影响这次
  // 调用实际执行的是哪段逻辑。
  it('两种输入的方向不会被对调', () => {
    expect(routeSecondInstance(['todo-desktop://complete?id=x']).kind).toBe('protocol');
    expect(routeSecondInstance(['C:\\app.exe']).kind).toBe('open');
  });
});

describe('A／换个名字弹窗口：三个纯函数不碰任何 Electron API', () => {
  // A 那次改坏是在 main.ts 里加一个跟 openWindow() 内容一样但换了名字的
  // 函数，在 quick action 分支里多调一次——这三个函数的返回值只是纯数据，
  // 不存在「顺手弹个窗口」的副作用可藏，A 那种招数在它们身上没有立足点。
  // main.ts 那部分残留的「调用 openWindow 还是 applyProtocolAction」的
  // 二选一，已经收窄成读 route.kind 做一次判断——这一点点没法在这个沙盒
  // 里执行 main.ts 验证，老实记在 main.test.ts 顶部注释和冒烟清单里。
  it('返回值只含数据字段，没有多余的字段可以偷藏一个函数引用', () => {
    expect(Object.keys(parseProtocolUri('todo-desktop://complete?id=x')!).sort()).toEqual(['id', 'kind']);
    expect(Object.keys(patchForAction('complete', new Date('2026-08-19T00:00:00.000Z'))).sort()).toEqual(['status']);
    expect(Object.keys(routeSecondInstance(['todo-desktop://complete?id=x'])).sort()).toEqual(['kind', 'uri']);
  });
});
