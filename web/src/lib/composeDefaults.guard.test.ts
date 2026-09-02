import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **`ComposeDefaults` 的每一个字段都得真的有人读。**
 *
 * 这个对象回答的是「站在哪一屏里建，那条新任务该长什么样」。它有两个消费点，
 * 而且必须两个都接：列表顶上那行「添加任务」（`smartDraft`）和「新任务」表单
 * （`TaskComposer` 拼初始草稿那一段）。
 *
 * **它已经静默漏过一次，而且是整整一个字段。** `context` 加进来时，
 * `composeDefaults()` 里那条分支写了、注释也写了（「站在某个情境里建，就落那个
 * 情境——跟标签同一条理由」），但 `smartDraft` 的返回里没有这个字段、
 * `TaskComposer` 拼草稿时也没读——**两个消费点都把它丢在地上**，于是那句话从加上
 * 那天起就是假的。
 *
 * 后果正是这个模块自己为 `listId` 写下的那个形状：站在「外出」里建一条，它不出现
 * 在「外出」里，**建完那一屏一点变化都没有，跟建失败长得一模一样**。
 *
 * 而且什么都不会红：`smartDraft` 的返回类型是现写的一个内联类型，少一个字段
 * typecheck 不管；`{ ...emptyDraft(), ...built }` 这种展开少一个键也照样编译。
 *
 * ## 为什么扫源码，不是跑一遍
 *
 * 「两个消费点都读到了」这件事，跑起来测要么渲染整个 `TaskComposer`（这个仓库
 * 为 App 级渲染的耗时付过账，见 `App.test.tsx` 里那条 15s 注释），要么给每个字段
 * 各写一对用例——而真正要拦的是**下一个字段被漏掉**，那正好是「有没有人读」这
 * 一句话。跟 `types.sync.test.ts`、`newTaskParity.guard.test.ts` 同一个手法。
 *
 * 这条只管「读没读」，不管读得对不对——后者是各字段自己的用例。
 */

/** `ComposeDefaults` 声明里顶层缩进两格的那些字段名。注释行不算。 */
function fieldsOf(): string[] {
  const src = readFileSync('web/src/lib/composeDefaults.ts', 'utf8');
  const from = src.indexOf('export interface ComposeDefaults {');
  if (from === -1) throw new Error('没找到 export interface ComposeDefaults——改名了就把这条守卫的锚点一起改');
  const end = src.indexOf('\n}', from);
  if (end === -1) throw new Error('ComposeDefaults 的声明没有收尾的大括号');
  return [...src.slice(from, end).matchAll(/^ {2}([a-zA-Z_$][\w$]*)\??:/gm)].map((m) => m[1]);
}

/** 两个消费点的源码接起来。`smartDraft` 在 composeDefaults.ts 自己文件里。 */
function consumers(): string {
  return readFileSync('web/src/lib/composeDefaults.ts', 'utf8')
    + readFileSync('web/src/components/TaskComposer.tsx', 'utf8');
}

describe('ComposeDefaults：每个字段都得有人读', () => {
  it('两个消费点（smartDraft / TaskComposer）合起来，每个字段至少被读一次', () => {
    const src = consumers();
    for (const f of fieldsOf()) {
      // `defaults.x` 和 `defaults?.x` 都算。TaskComposer 那边 prop 是可选的。
      const read = src.includes(`defaults.${f}`) || src.includes(`defaults?.${f}`);
      expect(read, `ComposeDefaults.${f} 算出来了，但「添加任务」和「新任务」两处都没读它——那个字段的预填是假的`).toBe(true);
    }
  });

  it('锚点真的抠到了字段——不是空名单在空转', () => {
    expect(fieldsOf().length).toBeGreaterThan(4);
    expect(fieldsOf()).toContain('context');
  });
});
