import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **新任务的默认值只许有一份意思：`newTask`（服务端）和 `newLocalTask`（离线）。**
 *
 * 两边各写一份是有理由的：离线那条路整个跑在浏览器里，引不到服务端的
 * `node:crypto`/`node:fs`。两处的注释都写着「跟服务端 `newTask()` 一字不差」，
 * 理由也写着：**离线建的任务推回桌面之后不该跟在线建的长得不一样**，不然回到
 * 局域网一推就是一次假冲突。
 *
 * 但只靠注释是守不住的——这个仓库这个月已经为「注释说同一条口径、实际飘了」
 * 付过两次账（议程的「已过期」少了全天规则、每日概览漏掉只设提醒的任务）。
 * 这条把那句话变成断言。
 *
 * ## 为什么比源码文本，不比运行结果
 *
 * `newLocalTask` 是模块私有的（`dataSource.ts` 里没导出），而它所在的模块整个
 * 依赖浏览器环境（`localStorage`）。为了测一条不变量把它导出去、或者把 jsdom
 * 拖进来，都比这件事本身贵。
 *
 * 比文本是这个仓库既有的手法——`types.sync.test.ts` 就是逐字比两份接口声明。
 * 这里比的是「字段名 → 默认值字面量」这张表，能抓住两种真实的失败：
 * 一边加了新字段（`Task` 加字段时最容易漏的就是这两处之一），或者同一个字段
 * 两边默认值不同。
 */

/** 三个字段两边必然不同，也**应该**不同：都是现生成的。 */
const GENERATED = new Set(['id', 'createdAt', 'updatedAt']);

/**
 * 从一个工厂函数里抠出「字段名 → 默认值」。
 *
 * 只取顶层缩进的 `name: value,` 那些行——注释行、`...partial` 那行、以及嵌套
 * 对象里更深的缩进都不算。两个文件的缩进不同（服务端 4 空格、web 4 空格），
 * 所以按「行首空白 + 标识符 + 冒号」认，不按固定列数。
 */
function defaultsOf(src: string, startMark: string, spreadMark: string): Record<string, string> {
  const from = src.indexOf(startMark);
  if (from === -1) throw new Error(`没找到 ${startMark}——函数被改名了就把这条守卫的锚点一起改`);
  const to = src.indexOf(spreadMark, from);
  if (to === -1) throw new Error(`${startMark} 里没找到 ${spreadMark}`);
  const body = src.slice(from, to);
  const out: Record<string, string> = {};
  // 一行里可能写了不止一个字段（`waitingFor: null, context: null,`），所以先按
  // 行滤掉注释，再在剩下的文本里全局扫「标识符: 值,」。
  const code = body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  for (const m of code.matchAll(/(?:^|[\s{])([a-zA-Z_$][\w$]*):\s*([^,\n]+),/g)) {
    const [, name, value] = m;
    if (GENERATED.has(name)) continue;
    out[name] = value.trim();
  }
  return out;
}

const server = () => defaultsOf(
  readFileSync('server/src/store.ts', 'utf8'),
  'export function newTask(', '...partial,',
);
const local = () => defaultsOf(
  readFileSync('web/src/lib/dataSource.ts', 'utf8'),
  'function newLocalTask(', '...patch,',
);

describe('新任务的默认值：服务端 ≡ 离线', () => {
  it('两边字段一个不多一个不少', () => {
    expect(Object.keys(local()).sort()).toEqual(Object.keys(server()).sort());
  });

  it('每个字段的默认值也一样', () => {
    const s = server();
    const l = local();
    for (const k of Object.keys(s)) {
      expect(l[k], `字段 ${k} 的默认值两边不一样`).toBe(s[k]);
    }
  });

  it('锚点真的抠到了东西——不是两个空表在相等', () => {
    // `Task` 现在二十几个字段，减去三个现生成的。写个宽松下界，不跟着字段数走。
    expect(Object.keys(server()).length).toBeGreaterThan(15);
  });
});
