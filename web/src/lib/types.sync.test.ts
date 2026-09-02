import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * server 和 web 是两个独立的包，不引共享包就传不过来，
 * 所以 web/src/types.ts 注定是 server/src/model.ts 里那几个接口的拷贝。
 *
 * 消灭不了就让它会红：改了一边忘了另一边，TypeScript 两边各自都编译得过
 * （web 那边只是在用一个已经不存在的字段），只有运行时才现形。
 */
/**
 * 抠出一段声明。interface 抠到配对的 `}`，type 别名抠到 `;`——
 * **不能用一个「到 } 或 ; 为止」的懒惰模式**：interface 的第一个字段后面就是分号，
 * 那样每次只比到第一个字段，两边一起截断、一起通过，是一个恒绿的假测试。
 * 这几个接口里没有嵌套花括号，所以 `[^}]*` 就能停在正确的位置。
 *
 * `(?:\s+extends\s+\w+)?`：`TrashItem extends Task` 这种形状——名字和 `{` 之间
 * 隔着 `extends Task`，原来「名字后面紧跟 `\s*\{`」的写法接不住，会直接抛错
 * （不是静默通过，两者都会现形）。
 */
const block = (src: string, decl: string): string => {
  const m = src.match(new RegExp(`export (?:interface ${decl}(?:\\s+extends\\s+\\w+)?\\s*\\{[^}]*\\}|type ${decl}\\s*=[^;]*;)`));
  if (!m) throw new Error(`没在源码里找到 ${decl}`);
  return m[0].replace(/\s+/g, ' ').trim();
};

// 类型定义搬去 `model.ts` 了（`store.ts` 现在只剩磁盘层，理由在 model.ts 顶上）。
const serverSrc = readFileSync('server/src/model.ts', 'utf8');
const webSrc = readFileSync('web/src/types.ts', 'utf8');

const NAMES = [
  'Status', 'Subtask', 'Task', 'InboxItem', 'Settings', 'Proposal',
  'Reminder', 'FocusSession', 'Repeat', 'SmartFilter', 'List', 'Folder', 'Insight', 'TrashItem',
  'ConflictFile', 'Countdown', 'TaskContext', 'WeekStart', 'RepeatKind',
];

/**
 * `Outbox*` 三个是 outbox 文件里那三种条目的形状（`unknown[]`）——AI 写的
 * 原始输入，不是 web 要渲染的东西，故意不进同步名单，见 model.ts 里
 * 各自的注释。
 */
const SERVER_ONLY = ['OutboxEntry', 'OutboxUpdateEntry', 'OutboxInsightEntry'];

describe('web 的类型副本跟服务端一致', () => {
  it.each(NAMES)('%s', (name) => {
    expect(block(webSrc, name)).toBe(block(serverSrc, name));
  });

  /**
   * 上面这份 NAMES 曾经飘过一次（`CLAUDE.md` 停在「十三个」，model.ts 实际
   * 已经长到 15 个——见 2026-08-17-debt-sweep #14）：手维护的名单，问题从
   * 来不是「加的时候写错」，是「加第 16 个类型时压根没人想起来这里还有
   * 一份名单」。这条测试从源码直接扫 `export interface`/`export type`，
   * 跟 NAMES 比对，不需要人记得。
   */
  it('NAMES 等于 model.ts 导出的类型减去 server 独有的 Outbox* 三个——飘了这里先红', () => {
    const exported = [...serverSrc.matchAll(/export (?:interface|type) (\w+)/g)]
      .map((m) => m[1])
      .filter((n) => !SERVER_ONLY.includes(n));
    expect([...NAMES].sort()).toEqual([...exported].sort());
  });
});
