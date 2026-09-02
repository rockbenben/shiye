import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { canBeHabit, isHabit } from './habit.js';
import { HABIT_EVERY, REPEAT_KINDS } from '../../../server/src/store.js';
import { task } from '../test-utils.js';

/** 一份合法的重复规则，只换 `every` 那一格。 */
const BASE = { every: 'day' as const, interval: 1, weekdays: [], until: null, from: 'due' as const, count: null, step: 0, monthDay: null };

/**
 * **「这个重复档能不能当习惯」只许有一份答案。**
 *
 * 这条守卫是被一次真实的分叉逼出来的。习惯从「只有每天」放宽到「每天或每周」
 * 时，这个判断当时散在**七个地方**，只改动了其中五个：
 *
 * - `App.tsx`（新建任务）和 `TaskCard.tsx`（保存编辑）里那两句还写着
 *   `repeat?.every === 'day' ? habit : false`——表单让你勾上「当成习惯」，
 *   一按保存服务端收到的就是 `habit: false`。**勾得上、存不住**，
 *   而两处都编译得过，没有任何一处报错；
 * - `calendarMarks.ts` 同样漏了，后果是那条习惯打得了卡、日历上不出现打卡记号。
 *
 * 三处的共同点是：它们都不在「习惯」这个词的搜索半径里（一个叫「新建任务」、
 * 一个叫「保存」、一个叫「日历标记」），而 `every === 'day'` 这个写法在别处
 * 有正当用途（`repeat.ts` 算下一次、`ics.ts` 出 RRULE），grep 也分不出来。
 *
 * 所以钉两件事：判据本身的行为，和**别处不许再写一遍**。
 */

/** 跟着走的前端源码（跳过测试、依赖、产物）。 */
function sources(dir = 'web/src', out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('habit：能当习惯的重复档', () => {
  it.each(REPEAT_KINDS)('%s：`canBeHabit` 的答案跟 HABIT_EVERY 一致', (every) => {
    expect(canBeHabit({ ...BASE, every }))
      .toBe((HABIT_EVERY as readonly string[]).includes(every));
  });

  it('名单是「每天」和「每周」两种——加第三种就来改这条，顺手想一遍月度打卡表怎么画', () => {
    expect([...HABIT_EVERY].sort()).toEqual(['day', 'week']);
  });

  it('不重复的任务当不了习惯——习惯的定义里就含着「反复做」', () => {
    expect(canBeHabit(null)).toBe(false);
    expect(canBeHabit(undefined)).toBe(false);
  });

  it('`isHabit` 还要求真的标了记号——重复档对上了不等于人想打卡', () => {
    expect(isHabit(task({ habit: true, repeat: BASE }))).toBe(true);
    expect(isHabit(task({ habit: false, repeat: BASE }))).toBe(false);
    expect(isHabit(task({ habit: true, repeat: null }))).toBe(false);
  });

  /**
   * **锚在「同一行里既问 habit 又问 every」上**，不是扫 `every === 'day'`——
   * 后者在 `repeat.ts`、`ics.ts`、`smartInput.ts` 里都有正当用途，扫它等于
   * 把一堆无关的行也算进来，这条断言要么恒红要么被迫维护一份豁免名单，
   * 而豁免名单自己就是下一个会飘的东西。
   *
   * 上面那三处漏掉的写法（`t.habit || t.repeat?.every !== 'day'`、
   * `d.repeat?.every === 'day' ? d.habit : false`）全都命中这个形状。
   */
  it('除了 habit.ts，没有第二处自己判「重复档能不能当习惯」', () => {
    const bad: string[] = [];
    for (const f of sources()) {
      if (f.endsWith('/habit.ts')) continue; // 正本
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\bhabit\b/i.test(line) && /\bevery\b/.test(line) && !line.trim().startsWith('*')) {
          bad.push(`${f}:${i + 1}`);
        }
      });
    }
    expect(bad, '这些地方又自己判了一遍「能不能当习惯」，改判据时会漏掉它们——改成 `canBeHabit` / `isHabit`').toEqual([]);
  });

  it('那条扫描真的在扫东西——不是路径写错了在扫空目录', () => {
    expect(sources().length).toBeGreaterThan(50);
  });
});
