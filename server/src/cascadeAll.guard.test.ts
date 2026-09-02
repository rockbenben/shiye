import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * **三条连带只许经 `cascadeAll` 调用，不许各处再抄一遍那三行。**
 *
 * 这条守的不是风格，是一个**已经发生过三次**的静默 bug：调用方写了三行里的
 * 一部分，剩下的忘了。三次都没有任何东西挡住——类型对、每条连带自己的测试
 * 照样绿、界面不报错，改动就那么少做了一半。
 *
 * - 「接受一条 AI 建议」原来只有 `applyTaskPatch`：接受「把父任务移到清单 B」
 *   之后子任务留在 A，接受「把子任务都勾上」之后一条每周重复的任务就地断链。
 * - 离线改任务（`web/src/lib/dataSource.ts`）同样只有 `applyTaskPatch`：手机上
 *   勾掉一个三层的项目，提示语照样说「连带做完了 5 条子任务」（那句话是界面
 *   自己按服务端的规矩算的，见 `lib/undoDone.ts`），屏幕上那 5 条一条没动。
 * - 离线批量改是同一处的第二个入口，同样漏。
 *
 * 收成一份之后那种漏法**没有位置发生**：要么调 `cascadeAll`，要么一条都没有。
 * 这条断言不让它散回去。
 *
 * ## 例外只有两个
 *
 * `mutate.ts` 自己（定义和 `cascadeAll` 的实现）、`mutate.test.ts`（每条连带
 * 各自的边界得单独测）。别的地方一律走 `cascadeAll`。
 */
const CASCADES = ['cascadeChildrenDone', 'rollUpParentDone', 'cascadeListToChildren'];
const ALLOWED = new Set(['server/src/mutate.ts', 'server/src/mutate.test.ts']);

/** 去掉注释再找——这三个名字在好几处注释里被提到，那不算调用。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sourcesUnder(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('三条连带只有一个调用入口', () => {
  const files = [...sourcesUnder('server/src'), ...sourcesUnder('web/src')];

  /**
   * 先钉住锚点。少了这一条，下面那条断言会在函数被改名之后变成一句永远成立的
   * 废话——守卫还在，守的东西已经没了，而没有任何地方会说一声。
   *
   * **第一版的锚点自己就是恒真的**：它断言 `mutate.ts` 里出现过 `rollUpParentDone(`，
   * 而那个字面量匹配到的是 `export function rollUpParentDone(` 那一行——定义永远
   * 在，删光所有调用照样绿。评审拿这条实测过：把 `app.ts` 两条 PATCH 的连带整个
   * 拆成 `const rows = patched`，这个文件两条断言全绿（`app.test.ts` 红了 5 条，
   * 所以行为本身有测试守着；瞎的是这里）。锚点改成**数调用点**：调用点少了
   * 才是「连带散掉了」，函数定义在不在跟这件事无关。
   */
  it('前提：cascadeAll 真的被调着——单条两处（app.ts、dataSource.ts）、批量一处（patchMany）', () => {
    const calls = (f: string) => stripComments(readFileSync(f, 'utf8')).split('cascadeAll(').length - 1;
    expect(calls('server/src/app.ts'), 'PATCH 单条 / 接受建议').toBeGreaterThanOrEqual(2);
    expect(calls('web/src/lib/dataSource.ts'), '离线 patchTask').toBeGreaterThanOrEqual(1);
    // 批量那条（服务端和离线共用）在 mutate.ts 的 patchMany 里；定义本身不算调用，
    // 所以要求 ≥ 2：一处定义 + 至少一处调用。
    expect(calls('server/src/mutate.ts'), 'patchMany 里那一处').toBeGreaterThanOrEqual(2);
    // 批量入口也得真的走 patchMany，别又各抄一份循环。
    const uses = (f: string) => stripComments(readFileSync(f, 'utf8')).split('patchMany(').length - 1;
    expect(uses('server/src/app.ts'), '批量 PATCH').toBeGreaterThanOrEqual(1);
    expect(uses('web/src/lib/dataSource.ts'), '离线 patchTasksEach').toBeGreaterThanOrEqual(1);
  });

  it('除 mutate.ts / mutate.test.ts 之外，没人直接调这三个', () => {
    const offenders = files
      .filter((f) => !ALLOWED.has(f))
      .flatMap((f) => {
        const src = stripComments(readFileSync(f, 'utf8'));
        return CASCADES.filter((name) => src.includes(`${name}(`)).map((name) => `${f} 调了 ${name}`);
      });
    expect(offenders, '改任务的后续动作走 cascadeAll，别在这儿抄那三行').toEqual([]);
  });
});
