import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARE_EVENT, SHARE_PAYLOAD_KEYS, SHARE_PLUGIN_NAME } from '../web/src/lib/sharePlan.js';

// 「写了一个插件类」不等于「壳里有这个插件」。
// scripts/capacitor-plugins-wired.test.ts 那道守卫**盖不到这一个**：它的清单是
// 从根 + 各 workspace 子包的 package.json 里挑出装好后带 `capacitor.android`
// 的包算出来的，而自写插件不是 npm 包，连候选都进不去（那边还有一条
// `@capacitor/` 的 scope 过滤）。`npx cap sync` 生成的
// assets/capacitor.plugins.json 里也不会有它——自写插件唯一的接线点是
// MainActivity 里那一句 registerPlugin()，没人替你写。
//
// 这道守卫断四件事，全落在**进版本库、不是生成**的文件上：
//   ① MainActivity 真的注册了它；
//   ② manifest 的 .MainActivity 里真的有 ACTION_SEND + text/plain
//      （没有它，「办事师爷」压根不出现在系统分享菜单里）；
//   ③④ 跨语言的字面量和键名对账——Java 和 TS 之间**没有编译器**，
//      这是那条接缝上唯一的机器守卫（parked-all 第 132/133 条那个形状：
//      同一个字面量两侧各写一份，两侧的测试各自只断自己那一半）。
//
// **守不住的，老实写在这儿**：Java 编不编得过、`@CapacitorPlugin` 那个注解**在
// 运行时反射得不得出来**（`PluginHandle.java:35` 的 `pluginClass.getAnnotation(…)`，
// 读出来之后才把 PluginHeaders 注进 WebView，`JSExport.java:91`）、分享菜单里到底
// 出不出现「办事师爷」、冷启动时留存事件真不真的补发——四件都只有真机答得出来，见
// android/冒烟清单.md 第 10b 步。
// ⚠️ 这行原先写的是「**注解处理器**有没有真的生成 PluginHeaders」，**是错的**：
// Capacitor 没有注解处理器，`@CapacitorPlugin` 是 `RUNTIME` 保留、靠反射读的。
// 冒烟清单 10b 第 2 格一直写对着，是这个文件头跟它自己指的那份文档打了架。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]) => readFileSync(join(repoRoot, ...parts), 'utf8');

// **两份 Java 一律先剥注释再断言。** 不是洁癖：这两个文件的注释块比代码长一个
// 数量级，而它们**逐字写着自己在断言的那些东西**（「必须排在 super.onCreate()
// 之前」「registerPlugin() 往 bridgeBuilder 里加」…）。第一版没剥就当场撞上了:
// 「registerPlugin 排在 super.onCreate 之前」那条拿 indexOf 找 `super.onCreate(`，
// 找到的是 javadoc 里那句、位置在真正那行**之前**，于是接线明明是对的、守卫却红。
// 反过来同样成立、而且更危险：代码被删光、注释里留着那句话，守卫会**绿**。
// 剥一次，所有 Java 断言一起脱离这个形状。
const stripJavaComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const plugin = stripJavaComments(
  read('android', 'app', 'src', 'main', 'java', 'com', 'rockbenben', 'shiye', 'ShareTargetPlugin.java'),
);
const activity = stripJavaComments(
  read('android', 'app', 'src', 'main', 'java', 'com', 'rockbenben', 'shiye', 'MainActivity.java'),
);
// manifest 同理剥 XML 注释，而且**是打变异时当场撞出来的**：manifest 里那段
// 新注释解释「launchMode="singleTask" 是热启动的前提」，逐字带着这个属性，于是
// `android:launchMode="singleTask"` 在整份文件里出现 **2 次**——真属性一次、
// 注释一次。变异纪律①（先数模式次数，对不上就停）在这里直接兜住了：不剥的话，
// 谁把真属性删了，注释还会替它绿。
const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '');

it('MainActivity 注册了自写插件——自写插件不是 npm 包，cap sync 不会替它接线', () => {
  // 数出现次数、不用 toContain：文件被清空和守卫全绿长得一模一样，
  // 而「恰好 1 次」还顺带挡住「注册了两遍」。
  const hits = activity.match(/registerPlugin\(ShareTargetPlugin\.class\);/g);
  expect(hits).toHaveLength(1);
});

it('registerPlugin 排在 super.onCreate 之前——晚了的话 bridge 已经建好，这个插件不在里面', () => {
  const reg = activity.indexOf('registerPlugin(ShareTargetPlugin.class);');
  const sup = activity.indexOf('super.onCreate(');
  expect(reg).toBeGreaterThan(-1);
  expect(sup).toBeGreaterThan(-1);
  expect(reg).toBeLessThan(sup);
});

// `.MainActivity` 那一块，**下面两条 manifest 断言共用**。整份文件上 toContain
// 会被别的 activity/receiver 里同名的东西满足（形状家族 4：抠规则块之前先证明
// 抠到了），抠不到就是 undefined、两条都会红。
const mainActivity = manifest.match(/<activity[^>]*android:name="\.MainActivity"[\s\S]*?<\/activity>/)?.[0];

it('manifest 的 .MainActivity 里有 ACTION_SEND + text/plain 的 intent-filter', () => {
  expect(mainActivity).toBeTruthy();
  expect(mainActivity).toContain('<action android:name="android.intent.action.SEND" />');
  expect(mainActivity).toContain('<category android:name="android.intent.category.DEFAULT" />');
  expect(mainActivity).toContain('<data android:mimeType="text/plain" />');
});

it('热启动那条路要的 launchMode="singleTask" 还在', () => {
  // 不是这一批加的，但分享的热启动整条依赖它：没有它，分享过来会新建一个
  // Activity 实例而不是走 onNewIntent。它被谁顺手删掉的话这条会红。
  // **这条原先是拿整份 manifest 断的**，跟隔壁那条自己写着的规矩（形状家族 4：
  // 先抠块）打架。现在这份 manifest 只有一个 activity，所以整份搜**今天**假绿
  // 不起来——但「只有一个 activity」是今天的事实，不是这条断言的前提。
  expect(mainActivity).toBeTruthy();
  expect(mainActivity).toContain('android:launchMode="singleTask"');
});

it('插件名两侧一致——Java 的 @CapacitorPlugin(name=) 和 TS 的 SHARE_PLUGIN_NAME', () => {
  const m = plugin.match(/@CapacitorPlugin\(\s*name\s*=\s*"([^"]+)"/);
  expect(m).not.toBeNull();
  expect(m![1]).toBe(SHARE_PLUGIN_NAME);
});

it('事件名两侧一致——Java 的 notifyListeners("…") 和 TS 的 SHARE_EVENT', () => {
  const hits = [...plugin.matchAll(/notifyListeners\(\s*"([^"]+)"/g)];
  expect(hits).toHaveLength(1);
  expect(hits[0]![1]).toBe(SHARE_EVENT);
});

it('payload 的键名和取值两侧一致——键名对上 TS 那份 SharePayload，四句取值原样钉死', () => {
  const keys = [...plugin.matchAll(/data\.put\(\s*"([^"]+)"/g)].map((m) => m[1]!).sort();
  expect(keys).toEqual([...SHARE_PAYLOAD_KEYS]);
  // ⚠️ **上面那条只对键名，不对「键 → 取的是哪个 intent 字段」**——整分支审查
  // 当场演了一发：把 action 和 type 两行的取值互换（`data.put("action",
  // intent.getType())` / `data.put("type", intent.getAction())`），键名集合一个字
  // 没变，**九条断言全绿**。真机后果正是这一批最想防的那个：`p.action` 变成
  // `text/plain` ⇒ `shareToInboxText` 第一句 `p.action !== ACTION_SEND` 就
  // `return null` ⇒ **每一次分享都静默消失，而全仓零红。**
  // 破法不用更聪明的正则，四句原样断掉就行——比那条正则还短。
  // （`plugin` 已经剥过注释：这一批撞过四次「注释里逐字写着 needle」。）
  expect(plugin).toContain('data.put("action", intent.getAction());');
  expect(plugin).toContain('data.put("type", intent.getType());');
  expect(plugin).toContain('data.put("text", intent.getStringExtra(Intent.EXTRA_TEXT));');
  expect(plugin).toContain('data.put("subject", intent.getStringExtra(Intent.EXTRA_SUBJECT));');
});

it('留存事件那一位是 true——冷启动时网页层还没监听，false 会让那一次分享凭空消失', () => {
  // 核过（读的是 node_modules/@capacitor/android 的源码，行号是当场数的）：
  // Plugin.java:661-683 的 notifyListeners(String, JSObject, boolean)，在
  // listeners 为 null 或空时（:664）只有 retainUntilConsumed 为 true 才把 data
  // 追加进 retainedEventArguments（:666-675），否则直接 return（:676）——事件就没了。
  // 补发在 sendRetainedArgumentsForEvent（:712-724）：先 retainedEventArguments
  // .remove(eventName)（:719）**再**遍历补发（:721-723），所以**只消费一次**；
  // 它唯一的调用点是 addEventListener（:627-640）里 listeners 为 null/空的那一支
  // （:636），也就是**第一个**监听者注册的那一刻。
  // 写成 false 的话冷启动分享静默丢，而所有单元测试照样全绿——这就是这一行要有守卫的理由。
  expect(plugin).toMatch(/notifyListeners\([^)]*,\s*true\s*\)/);
});

it('原生那半零判断——那个包底下每一份 Java 里一个分支都没有', () => {
  // 设计正本写死的第①条：判断落进原生的那一刻，它就从「有守卫」变成
  // 「只能真机验」。这条断言是那句话唯一的机器化形式。
  //
  // ⚠️ **原来这条只挡 `if` 和三元，而且只看 ShareTargetPlugin 一个文件**，整分支
  // 审查三发都绕过去了、九条全绿：① 一句
  // `switch (String.valueOf(intent.getAction())) { case "…": return; default: break; }`；
  // ② 把判断挪进 `MainActivity.java`——守卫只拿它断 `registerPlugin`，从不查它的
  // 分支；③ 干脆**新开一个 `.java`**——那时候文件清单是两个写死的路径。
  // 所以现在：needle 扩到 `if/switch/while/for/catch`，文件从**目录里扫**。
  //
  // `MainActivity` 一起套这条：它现在只有 `registerPlugin` 一行，本来就该零分支，
  // 而「把判断挪去隔壁」是最省事的那条绕法。
  //
  // **`&&`/`||` 也挡**（`if` 挡掉之后剩下的短路副作用只能写成
  // `boolean ignored = cond && sideEffect();` 这种）。取舍：这几个文件里的短路
  // 运算符**没有一个不是判断**——「原生那半零判断」这句话本身就把正常用法排除了，
  // 所以这里没有误伤可言；真有哪天需要一个非判断的 `&&`，那说明该改的是这条约束、
  // 不是这条断言，来这儿说明理由再放宽。
  //
  // 注释里的分支不算——每份都先剥 `//` 和 `/* */`（`ShareTargetPlugin` 的 javadoc
  // 里逐字抄着 BridgeActivity 的 `if (this.bridge == null …)`，不剥这条必红）。
  //
  // ponytail: 关键字黑名单不是 Java 解析器，`Optional.filter` / 递归 / 反射这类
  // 绕法它挡不住。真要挡全得上 AST，那要新依赖；这条挡的是**手滑和图省事**，
  // 存心绕的人还有代码审查那道。哪天真被绕过去了，再把这条换成 AST。
  const javaDir = join(repoRoot, 'android', 'app', 'src', 'main', 'java');
  const files = readdirSync(javaDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.java'));
  // 扫到 0 个文件和「全都干净」长得一模一样（形状家族：空集合恒真）。
  expect(files.length).toBeGreaterThanOrEqual(2);
  for (const f of files) {
    const src = stripJavaComments(readFileSync(join(javaDir, f), 'utf8'));
    expect(src, f).not.toMatch(/\b(if|switch|while|for|catch)\s*\(/);
    expect(src, f).not.toMatch(/\?[^:]*:/);
    expect(src, f).not.toMatch(/&&|\|\|/);
  }
});
