import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 的 toast 通知认 AppUserModelID（AUMID）。它在这个仓库里写了**两份**：
// electron-builder.yml 的 `appId`（打包时写进开始菜单快捷方式），和 main.ts 里
// 显式的 `app.setAppUserModelId(...)`（兜住「从安装目录直接双击 exe」和开发模式，
// 那两条路快捷方式覆盖不到）。main.ts 那段注释自己就写着「字面量跟
// electron-builder.yml 的 appId 保持一致」——**但在这个文件之前，没有任何东西
// 守着这句话**。
//
// 两份对不上的表现，是这个仓库最怕的那种：**不报错、不红、什么都不说**。
// Windows 拿着一个它不认识的 AUMID，把 toast 直接吞掉；开发机上多半照常弹
// （开发模式走的是另一条路），只有装过 NSIS 版的那台机器上「到点提醒我」静默失效。
// 改包名（com.qingwhat.todo → com.rockbenben.shiye 那次）正是会把两份撞散的事件，
// 而当时两处一个在 .yml、一个在 .ts，改漏一个 tsc 和全部 2317 条测试都不会吭声。
//
// **只守这一条。** 安卓那边的 applicationId / package_name / custom_url_scheme
// 跟 Electron 的 appId 恰好是同一个字符串，但那是两个平台各自的身份，没有
// 「必须相等」这回事，硬绑上会在以后想给安卓单独换包名时假红。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8');

// 先剥注释再匹配。main.ts 那段注释**逐字写着** `appId: com.rockbenben.shiye`，
// 不剥的话「代码被删光、注释还留着」会绿——share-target 那批一次撞出四例
// 「注释里含有断言要找的串」，这是同一个形状，不再踩第二遍。
//
// 抽成函数而不是每处抄一遍那两条 `.replace`：这个文件是「身份字面量对」的登记处，
// 现在两对、以后还会加，抄第三遍的那次必然会漏掉其中一半（漏掉块注释那条的话，
// 断言就会去匹配文档注释里的示例字符串，照样绿）。
// 行注释那条的 `(^|[^:])` 不能省：不带它的话 `//` 会在 `http://localhost` 中间
// 命中，把那一行的后半截当成注释删掉。实测 main.ts 里有两行真的被这么截过——
// `const URL = \`http://localhost:${PORT}\`;`（L18）和 `${PROTOCOL}://`（L365）。
// 现在还没造成假绿，纯粹是运气：下面三条断言要找的串恰好都在别的行上。哪天有人
// 在含 `://` 的那一行上加一条断言、或者把字面量挪过去，这个守卫就会**静默变哑**
// ——而它存在的全部意义就是在改名漏改时叫一声。
//
// ponytail: 只挡 `scheme://` 这一类，不做真正的词法扫描。天花板是字符串字面量
// 里**不跟在冒号后面**的双斜杠（`const s = 'a // b'`）照样会被误删——这个仓库
// 现在一处都没有，真出现了再说。
//
// 兄弟文件 `share-target-wired.test.ts` 的 `stripJavaComments` 是同一份实现，
// **那边不用跟着改**：它剥的是 android/ 下那几个 .java，实测一行含 `://` 的
// 代码都没有。为一个不存在的复用把两份抽成公共 helper，反而是多一处要维护的东西。
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const main = stripComments(read('desktop', 'src', 'main.ts'));
const yml = read('desktop', 'electron-builder.yml').replace(/^\s*#.*$/gm, '');

it('main.ts 的 AUMID 跟 electron-builder.yml 的 appId 是同一个字符串', () => {
  const calls = [...main.matchAll(/app\.setAppUserModelId\('([^']+)'\)/g)];
  // 引号可有可无：`appId: "com.x.y"` 和 `appId: com.x.y` 在 YAML 里是同一个值。
  // 第一版没吃掉引号，加引号这种纯改写会**假红**——守卫在没出事的时候叫，
  // 跟它在出事的时候不叫一样会被人关掉。
  const ids = [...yml.matchAll(/^appId:\s*["']?([^"'\s]+)["']?\s*$/gm)];

  // **两个都要先断“真的找到了”。** 少了这两条，正则哪天匹配不上（函数改名、
  // yml 换成引号包起来的写法、文件被清空），两边都是 undefined，
  // `toBe` 直接绿——这条守卫会在它最该说话的那一刻变哑。
  expect(calls).toHaveLength(1);
  expect(ids).toHaveLength(1);

  expect(calls[0][1]).toBe(ids[0][1]);
});

// 第二对：`%APPDATA%` 下的目录名，同样写了两份。
//
// - `server/src/store.ts` 的 `deviceConfigPath()` 拼 `<平台惯例位置>/<名字>/device.json`
// - `desktop/src/main.ts` 的 `const USER_DATA_DIR = join(app.getPath('appData'), <名字>)`
//
// Electron 的 userData 默认按 `productName`（办事师爷）算，那句 setPath 存在的
// 全部意义就是把它拉到跟设置同一个目录里去——**两份飘了，%APPDATA% 下就会并排
// 躺着两个文件夹**（一个装设置、一个装桌面版的任务数据），看着像装了两个应用。
// 不报错、不红，只有打开资源管理器翻到那一层才看得见。
const store = stripComments(read('server', 'src', 'store.ts'));

it('设置目录名跟 Electron 的 userData 目录名是同一个字符串——%APPDATA% 下只该有一个文件夹', () => {
  // store.ts 那行长这样：join(APPDATA || XDG || ~/.config, 'shiye', 'device.json')
  const cfg = [...store.matchAll(/,\s*'([^']+)',\s*'device\.json'\)/g)];
  // main.ts 那行长这样：const USER_DATA_DIR = join(app.getPath('appData'), 'shiye')
  const ud = [...main.matchAll(/USER_DATA_DIR\s*=\s*join\([^,]+,\s*'([^']+)'\)/g)];

  // 同上：两侧都要先断“真的匹配到了”，否则正则一失效就是 undefined === undefined。
  expect(cfg).toHaveLength(1);
  expect(ud).toHaveLength(1);

  expect(cfg[0][1]).toBe(ud[0][1]);

  // 算出来的目录还得**真的设进去**。只比字面量的话，`app.setPath` 那一行被删掉
  // （或者改成设别的 name）这条守卫照样绿，而那正是「%APPDATA% 下又变回两个
  // 文件夹」最省事的走法。
  expect(main).toMatch(/app\.setPath\('userData',\s*USER_DATA_DIR\)/);
});

/**
 * 剥注释这一步自己也要有人守。
 *
 * 上面每一条断言都建立在「stripComments 只删掉注释、不碰代码」这个前提上，而这个
 * 前提破过一次：行注释那条正则原来是裸的 `/\/\/.*$/gm`，会在 `http://` 中间命中，
 * 把 main.ts 里两行代码的后半截当注释删掉。当时没红，是因为要找的串恰好都在别的
 * 行上——这种「靠运气绿着」的状态没有任何东西拦得住它变成真的假绿。
 *
 * 判据不写「某一行必须原样保留」（那样每次改 main.ts 都要回来改测试），而是
 * 「删掉的必须只有注释」：URL 里的双斜杠还在、块注释符号没有落单残留。
 */
it('stripComments 只删注释，不咬代码里的 `://`', () => {
  const raw = read('desktop', 'src', 'main.ts');
  const stripped = stripComments(raw);

  // 原始文件里确实存在含 `://` 的代码行——先钉住这个前提，不然哪天那两行没了，
  // 下面那条断言会变成一句永远成立的废话。
  expect(raw, 'main.ts 里应当有含 :// 的代码').toMatch(/:\/\//);
  // 剥完之后它还在：说明 `//` 那条规则没把 URL 从中间劈开。
  expect(stripped, 'stripComments 把代码里的 :// 一起吃掉了').toMatch(/:\/\//);

  // 块注释成对剥干净，没有落单的 /* 或 */ 残留——有残留就说明非贪婪匹配跨过了
  // 一段本该保留的代码，那种破坏比截断半行更难察觉。
  expect(stripped.match(/\/\*/g) ?? [], '剥完还剩下 /*').toHaveLength(0);
  expect(stripped.match(/\*\//g) ?? [], '剥完还剩下 */').toHaveLength(0);

  // 注释确实被删了（上限断言）：main.ts 的注释里逐字写着 appId，不剥的话
  // 上面第一条断言会因为「注释里那句」而假绿，那正是 stripComments 存在的理由。
  expect(raw).toContain('appId: com.rockbenben.shiye');
  expect(stripped, '注释根本没被剥掉').not.toContain('appId: com.rockbenben.shiye');
});

/**
 * 第三对：**界面上写给用户看的那两个数据路径**，跟 `store.ts` 的 `paths()`。
 *
 * `BoardErrorBoundary` 存在的全部意义是「看板崩了，告诉他去哪个文件里找」。它把
 * 路径**渲染出来**，而路径的正本在 `store.ts` 的 `paths()`——两处手写，没人守。
 *
 * 已经飘过一次，而且飘的方向最糟：存储从早年那两份 `data/tasks.json` /
 * `data/inbox.json` 搬成了「一个实体一个文件」的目录（`data/tasks/`、`data/inbox/`），
 * 界面上那句话没跟着改。**照它去找的人什么也找不到**，比不提示更糟；而这个组件
 * 平时不出现，坏了也没有任何东西会叫。
 *
 * **判据不是「这个目录在磁盘上存在」**：`data/` 整个是 gitignore 的运行时数据，
 * 全新克隆里一个文件都没有，拿存在性当判据的守卫会在 CI 上假红——守卫在没出事的
 * 时候叫，跟它在出事的时候不叫一样会被人关掉（同上面 appId 那条的教训）。
 * 判据是**这两个名字来自 `paths()`，而且界面把它们写成目录（带结尾斜杠）**。
 */
const boundary = stripComments(read('web', 'src', 'components', 'BoardErrorBoundary.tsx'));

it('错误提示里的数据路径来自 store.ts 的 paths()，而且写成目录不是单文件', () => {
  // paths() 那几行长这样：  tasks: join(dataDir(), 'tasks'),
  const dirs = [...store.matchAll(/^\s{2}(\w+): join\(dataDir\(\), '([^']+)'\),$/gm)].map((m) => m[2]);
  // 先钉前提：正则匹配不上时下面会变成「空集合里的每一个都合格」那种永远成立的废话。
  expect(dirs).toContain('tasks');
  expect(dirs).toContain('inbox');

  // 界面里 <code>…</code> 包着的、形如 data/xxx 的那几处。
  const shown = [...boundary.matchAll(/<code>data\/([A-Za-z0-9_.-]*)\/?<\/code>/g)].map((m) => m[1]);
  expect(shown.length, '界面上一个数据路径都没找到——组件改写过的话这条守卫要跟着改').toBeGreaterThan(0);

  for (const name of shown) {
    expect(dirs, `界面上写着 data/${name}，而 paths() 里没有这个目录`).toContain(name);
  }

  // **写成目录**：`data/tasks/` 而不是 `data/tasks.json`。少了这条，搬回单文件
  // 名字照样对得上，而那正是上次飘的形状。
  for (const name of shown) {
    expect(boundary, `data/${name} 该带结尾斜杠，表示它是一个目录`).toContain(`<code>data/${name}/</code>`);
  }
  expect(boundary, '界面上不该再出现早年那种单文件路径').not.toMatch(/data\/(tasks|inbox)\.json<\/code>/);
});

/**
 * 第四对：**Node 的最低版本，写了三份**。
 *
 * - `package.json` 的 `engines.node`（`npm ci` 真正会拒的那道）
 * - `.github/workflows/ci.yml` 的 `node-version`（CI 实际跑的那个）
 * - `README.md`「上手」那句「要 Node N 以上」（照着装的人只看这句）
 *
 * 已经飘过：`engines` 是 `>=24.0.0`、CI 跑 24，而 README 写着「要 Node 20.19 以上」。
 * **照 README 装 Node 20 的人，`npm ci` 当场被 engines 拒掉**——而这是新人的第一步。
 * 三份都是手写的，改一处不会有任何地方吭声。
 */
it('Node 最低版本：package.json / CI / README 三处说的是同一个大版本', () => {
  const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
  const want = /(\d+)/.exec(pkg.engines?.node ?? '')?.[1];
  expect(want, 'package.json 里没有 engines.node').toBeTruthy();

  const ci = read('.github', 'workflows', 'ci.yml');
  const ciVers = [...ci.matchAll(/node-version:\s*'?(\d+)/g)].map((m) => m[1]);
  expect(ciVers.length, 'ci.yml 里没找到 node-version').toBeGreaterThan(0);
  for (const v of ciVers) expect(v, 'CI 的 node-version 跟 engines 对不上').toBe(want);

  const readme = read('README.md');
  const said = [...readme.matchAll(/要 Node (\d+)/g)].map((m) => m[1]);
  expect(said.length, 'README 里没找到「要 Node N 以上」那句——改写了就把这条守卫的锚点一起改').toBe(1);
  expect(said[0], 'README 说的 Node 版本跟 engines 对不上——照它装的人第一步就被 npm 拒').toBe(want);
});
