/**
 * 分享接入的**全部判断**。原生那半（android/app/src/main/java/com/rockbenben/shiye/
 * ShareTargetPlugin.java）一个 `if` 都没有——它只把 intent 的四个字段原样发过来，
 * 「这算不算一次分享」「有没有文字」「标题跟正文怎么拼」全在这个文件里判，
 * 因为**判断落进 Java 的那一刻，它就从「有守卫」变成「只能真机验」**
 * （设计正本 2026-08-13-full-rebuild-design.md 第十一节「分享接入」小节）。
 *
 * 这个文件零 import、无状态、不碰时间——`scripts/share-target-wired.test.ts`
 * （node 档）也要 import 它做跨语言字面量对账，别往里加任何浏览器依赖。
 */

/**
 * 插件名。**三处必须一模一样，改一处就得改三处**：
 * ① 这里；② Java 的 `@CapacitorPlugin(name = "ShareTarget")`；
 * ③ 网页层 `registerPlugin(SHARE_PLUGIN_NAME)`（shareNative.ts，读的就是这里）。
 * ①②之间没有编译器，靠 scripts/share-target-wired.test.ts 对账
 * （这是「同一个字面量两侧各写一份、谁都没断言字面量本身」那个形状，
 * 见 parked-all 第 132/133 条）。
 */
export const SHARE_PLUGIN_NAME = 'ShareTarget';

/** 事件名。Java 的 `notifyListeners("shared", …)` 跟这里对账，同上。 */
export const SHARE_EVENT = 'shared';

/**
 * `android.content.Intent.ACTION_SEND` 的字面值。安卓这个常量的值是稳定的
 * 公开 API（`Intent.ACTION_SEND` 的文档值），网页层拿不到 Java 常量，只能写字面量。
 */
export const ACTION_SEND = 'android.intent.action.SEND';

/**
 * 原生那半发过来的一整份数据。**四个字段全是可选的**：Java 那边用
 * `JSObject.put(key, (String) null)`，落到 org.json 的
 * `JSONObject.put(String, Object)` ——**value 为 null 时那个键被移除**
 * （出处 node_modules/@capacitor/android/.../JSObject.java:154-159，核过：
 * 那个重载直接 `super.put`），所以到了 JS 这边是「键缺席」，不是 `null`。
 */
export interface SharePayload {
  action?: string;
  type?: string;
  text?: string;
  subject?: string;
}

/**
 * Java 那半往 JSObject 里放的键，一个不多一个不少（排过序）。
 * 跨语言对账用，见 scripts/share-target-wired.test.ts——**这是 Java→TS
 * 那条接缝上唯一的机器守卫**，改了一边没改另一边它会红。
 */
export const SHARE_PAYLOAD_KEYS = ['action', 'subject', 'text', 'type'] as const;

/**
 * 这一份 payload 该往收件箱里写什么。`null` = 什么都不写。
 *
 * 三种 `null`（三种「什么都没发生」都要有断言，见 parked-all 第 155 条）：
 * ① 根本不是分享——**普通点图标启动也会走到这里**，因为原生那半对每一次
 *    `onNewIntent` 都发事件、不筛（那是判断）。这是最常跑的一格。
 * ② 正文**和**标题都是空白（只有一个空着不算，见下面「只有标题」那段）。
 * ③ （第三种「什么都没发生」是「压根不在原生壳里」，那一格在 shareNative.ts
 *    的 `subscribeShare` 里，不在这个函数里。）
 *
 * **`null` 一律静默，不区分①②**：①每次点图标启动都会发生，为它弹一句
 * 「分享内容为空」是把正常启动变成报错。②确实值得说一声，但调用方自己判得出来
 * （`p.action === ACTION_SEND && shareToInboxText(p) === null`），
 * 不为这一句话把返回类型撑成对象——真要提示时 Task 4 用这个表达式。
 *
 * **`action` 校验，`type` 不校验。** 校验 action 是因为原生那半对每次
 * `onNewIntent` 都发事件，**将来 manifest 多加一个 intent-filter（比如
 * `ACTION_VIEW` 接一个链接），那些 intent 也会顺着同一个回调掉进来**——
 * 这道判断就是这条路的入口闸。type 反过来：它是发送方随手标的（同一段选中文字
 * 在不同 App 里 `text/plain` / `text/html` / 干脆不带），拿它当闸门只会静默吞掉
 * 真的分享；而「分享图片」那种没有 EXTRA_TEXT 的 intent，空文字那道闸已经挡住了
 * ——**多一道判断不多挡任何东西，只多一条测不出差别的分支**。
 *
 * `subject` 的拼法：浏览器分享网页时几乎总是 subject=页面标题、text=URL，
 * 只留 URL 的话收件箱里是一串看不懂的链接——**而收件箱这条是要给 AI 拆解读的，
 * 标题才是它唯一能理解的那半**。但有些 App 把两者设成一样，或者把标题也塞进
 * 正文，那时拼起来就是复读，所以先看 text 里有没有它。标题在前、换行、正文在后：
 * 第一行是人和 AI 都先读到的那行。
 *
 * **只有标题、没有正文 ⇒ 拿标题当正文**（`if (!text) return subject || null`）。
 * ⚠️ **这一条是 Task 4 收尾时改的，改掉了 Task 1 原来那个方向相反的决定**
 * （原文写着「标题单独一句不成条目，不拿它凑数」，还配了一条钉死它的测试）。
 * 原来那个决定错在**只算了「条目质量」这一头，没算「静默丢数据」那一头**：
 * 有些 App 分享书签、分享纯网页标题时 `EXTRA_TEXT` 就是空的，而这一层返回 `null`
 * 之后**下游是彻底静默的**——`subscribeShare` 只在非 `null` 时才回调
 * （shareNative.ts），App.tsx 那条「是分享但为空」也是**刻意不提示**的（理由见
 * 那个 effect 的注释）。三处叠起来的后果是：**他分享了，屏幕上什么都没发生，
 * 没有任何解释，而那段文字已经离开原来那个 App 的上下文了**——正是这一批从头到尾
 * 在防的形状。一条「质量差一点」的收件箱条目，他自己看得见、删得掉、改得动；
 * 一条丢掉的分享他连「丢了」都不知道。**两害相权，宁可让他看见一行标题。**
 *
 * **不去重**：同一段文字分享两次绝大多数时候是真的想记两次，而
 * 「我明明分享了、它没进去」的代价大一个量级；真去重还得知道「最近分享过什么」
 * ——那是状态，这个文件是纯函数。见计划决定六。
 * ⚠️ **原来这儿写的是「技术性重复已经在原生那半结构上消掉了」，那句比代码硬一格**
 * （整分支审查揪出来的）。结构上消掉的是**常见**的那几种：只覆盖 `handleOnNewIntent`
 * 一个回调、留存事件补发前先 remove 所以只消费一次。**剩一条窄路没消掉**：
 * `BridgeActivity.load()` 最后一句是 `this.onNewIntent(getIntent())`
 * （BridgeActivity.java:50），而 Activity **重建**时会重跑 `load()`、`getIntent()`
 * 还是当初那条——所以「**分享把 App 冷启动起来、之后这个 Activity 又被重建**」
 * 会把同一条 SEND intent 投递第二次 ⇒ 收件箱两条。重建时插件是全新实例，
 * 留存事件那套帮不上忙。manifest 的 `configChanges` 已经含
 * orientation/uiMode/density/locale（**旋转和深色切换不触发重建**），
 * 剩下的触发口只有**进程被杀之后恢复**和开发者选项里的**「不保留活动」**——很窄，
 * 而且**只能真机验**。不为它加去重代码：那要状态，而多一条收件箱条目他看得见、
 * 删得掉，静默丢一条他连丢了都不知道。见 android/冒烟清单.md 10c 第 2 条。
 *
 * 「空白」= `String.prototype.trim()` 的那套 Unicode 空白：空格、换行、制表符、
 * 不间断空格 ` `、中文里常见的全角空格 `　`、BOM `﻿` 都算。
 * ponytail: 零宽字符（`​` 之流）不算空白，只有零宽字符的分享会写进一条
 * 看着是空的收件箱条目——真机上没有 App 会这么分享，真遇上了再在这里加一次
 * `replace`，别为它现在多一条分支。
 */
export function shareToInboxText(p: SharePayload): string | null {
  if (p.action !== ACTION_SEND) return null;
  const text = (p.text ?? '').trim();
  const subject = (p.subject ?? '').trim();
  if (!text) return subject || null;
  if (!subject || text.includes(subject)) return text;
  return `${subject}\n${text}`;
}
