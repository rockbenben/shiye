import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATUS_LABEL, STATUSES } from './taskView.js';

/**
 * **五个状态的中文名只许写死在一处。**
 *
 * 这条守卫是补账补出来的：那五个字符串前后被手抄过**五份**（卡片、看板列头
 * `cells.ts`、「按来源」筛选条、新建任务那句提示、按状态分组 `grouping.ts`），
 * 其中一份的注释还写着「文案在这个仓库里本来就没有单一出处，跟着抄一份是既有
 * 做法」。代价当场兑现过两次：
 *
 * ① 筛选栏和批量操作条各抄了一份**四档**的表，「已放弃」是后加的第五个状态，
 *    两处都没跟上——选不到、也批量标不了。那次修了这两处。
 * ② 「按来源」的筛选条是第三处，那次没顺手修，于是同一个 bug 又多活了很久
 *    （而且它还配着一个 `FILTERS.find(...)!` 的非空断言，档位真变成「已放弃」
 *    就当场炸）。
 *
 * 所以问题从来不是「哪一处漏了」，是**没有任何东西拦着下一次再抄一份**。
 * 这条就是那个东西：源码里除了 `taskView.ts` 自己，谁再写出 `todo: '待办'`
 * 这样的映射字面量，它当场红。
 *
 * 写法照 `keymap.test.ts` 那两条同步测试：**读源码**。运行时反射看不见「有人
 * 手抄了一份常量」这件事——那正是这类缺陷从来没被任何测试拦住过的原因。
 */
const SRC = 'web/src';
const HOME = join('web', 'src', 'lib', 'taskView.ts');
/** 这条测试自己——它的注释里就举着 `todo: '待办'` 当例子。 */
const SELF = join('web', 'src', 'lib', 'statusLabel.guard.test.ts');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : (/\.tsx?$/.test(e.name) ? [p] : []);
  });
}

describe('状态文案：单一出处', () => {
  it('除了 lib/taskView.ts，源码里没有第二份「状态 → 中文名」的映射字面量', () => {
    // `todo: '待办'` 这样的一对——键是状态值、值是它的中文名。四个状态里
    // 命中任意一个就算抄了一份（抄的人不会只抄半张表）。
    // 用 `includes` 不用正则：这个仓库的写法统一是 `todo: '待办'`（一个空格），
    // 而拼一个带 `\s` 的正则要走模板字符串——那里的 `\s` 会静默变成字母 `s`
    // （`smartInput.ts` 顶上记着这个坑，这条测试第一版就踩了）。
    const pairs = STATUSES.map((s) => `${s}: '${STATUS_LABEL[s]}'`);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === HOME || file === SELF) continue;
      const src = readFileSync(file, 'utf8');
      if (pairs.some((pair) => src.includes(pair))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('自己那份还在——上面那条要是因为出处也被删了才绿，等于什么都没守住', () => {
    const src = readFileSync(HOME, 'utf8');
    for (const s of STATUSES) expect(src).toContain(`${s}: '${STATUS_LABEL[s]}'`);
  });
});
