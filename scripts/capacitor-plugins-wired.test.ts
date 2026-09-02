import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 「装了 npm 包」不等于「壳里有这个插件」。这个仓库真的栽过两批：
// @capacitor/preferences 装在 web/package.json 里，`npx cap sync` 却从来没把它接进
// android 工程（capacitor.settings.gradle 里零插件工程、capacitor.plugins.json 是
// `[]`），于是真机上走的是插件的 web 兜底，而所有单元测试全程绿的。同一个形状落到
// 本地通知上更狠——web 兜底是浏览器 Notification API，在 WebView 里、应用关着的时候
// 什么都不做，「到点提醒我」整批静默失效，测试照样全绿。
//
// 根因是 CLI 的插件发现范围：node_modules/@capacitor/cli/dist/plugin.js 的
// getDependencies() 只读 `config.app.package` 的 dependencies/devDependencies，
// 也就是**根** package.json（capacitor.config.ts 挨着的那份）——workspace 子包
// 里声明的依赖它一个都看不见。所以插件必须在根 package.json 里也列一份；
// 子包里那份是给 import 用的，两份各管一件事，删哪份都会坏。
//
// **为什么这份清单是算出来的、不是手写两个包名。** 这道守卫存在的全部意义是
// 「以后再加插件时别再潜伏两批」——而手写清单要求加插件的人**记得回来改这个文件**，
// 那正是它没做到才出的事，靠它防它自己等于没防。所以：
//   - 候选从**根 + 每个 workspace 子包**的 package.json 一起收（`npm install
//     --workspace web` 是最顺手的装法，只看根就会在「只装进子包」这一格假绿——
//     而那恰恰就是栽过的那一格）；
//   - 「算不算插件」不用启发式猜包名，用 **CLI 自己的判据**：装好的包的
//     package.json 里有没有 `capacitor.android`（plugin.js 的 resolvePlugin()
//     就是看 `meta.capacitor`）。@capacitor/core、@capacitor/android、
//     @capacitor/cli 都没有这个字段，天然落选，不需要维护排除名单。
//
// 断言落在这两个**进版本库的**生成文件上：assets/capacitor.plugins.json 是
// android/.gitignore 第 99 行忽略掉的（每次 sync 现生成），拿它当断言对象会在
// 「刚 clone、还没 sync」时假红。这两个 gradle 文件是同一次 sync 的同一份插件清单
// 生成的，是可提交、可断言的那一半。
//
// ⚠️ **自写插件（不是 npm 包）这道守卫盖不到**：清单是从 package.json 的依赖里
// 算出来的，自写插件连候选都进不去。它们的接线守卫在
// scripts/share-target-wired.test.ts——别让这份文件的存在骗你以为壳里的插件
// 已经全覆盖了（第 147 条：「我知道这块没覆盖」这句话本身会挡住视线）。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(repoRoot, ...parts), 'utf8'));

const rootPkg = readJson('package.json');
const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };

// 根 + 所有 workspace 子包里声明过的、装好之后带 android 原生实现的 Capacitor 插件。
const declared = new Set<string>(
  [rootPkg, ...rootPkg.workspaces.map((w: string) => readJson(w, 'package.json'))].flatMap(
    (pkg) => Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }),
  ),
);
// ponytail: 只认 @capacitor/* 这个 scope——本仓库现在只用官方插件，直接读
// node_modules/<名字>/package.json 不会因为找不到而炸。哪天装了第三方插件
// （@capawesome/... 一类），把这条 scope 过滤放宽即可，下面两段不用动。
const plugins = [...declared]
  .filter((name) => name.startsWith('@capacitor/'))
  .filter((name) => readJson('node_modules', name, 'package.json').capacitor?.android)
  .sort();

// gradle 工程名照抄 CLI 的规则（@capacitor/cli/dist/android/update.js 44–46 行的
// getGradlePackageName），不自己另写一套拼法。
const gradleProject = (id: string) => `:${id.replace('@', '').replace('/', '-')}`;

// 一条元断言：上面那串过滤要是哪天算空了（改名、换布局），下面的 it.each 会一条都
// 不跑、整个文件假绿。
it('算出来的插件清单不为空', () => {
  expect(plugins.length).toBeGreaterThan(0);
});

describe.each(plugins)('%s 真的接进了 android 壳', (plugin) => {
  const project = gradleProject(plugin);

  it('根 package.json 声明了它——不然下次 cap sync 会把它悄悄拆掉', () => {
    expect(rootDeps).toHaveProperty(plugin);
  });

  it(`capacitor.settings.gradle 里有 ${project} 这个工程`, () => {
    const settings = readFileSync(join(repoRoot, 'android', 'capacitor.settings.gradle'), 'utf8');
    expect(settings).toContain(`include '${project}'`);
  });

  it(`app/capacitor.build.gradle 真的依赖 ${project}`, () => {
    const build = readFileSync(join(repoRoot, 'android', 'app', 'capacitor.build.gradle'), 'utf8');
    expect(build).toContain(`implementation project('${project}')`);
  });
});
