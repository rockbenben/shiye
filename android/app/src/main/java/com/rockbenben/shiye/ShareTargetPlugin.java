package com.rockbenben.shiye;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 分享接入的原生那半。**这是这个仓库唯一一份自写原生代码，也是唯一一份
 * vitest 里一行都跑不到的生产代码**——不是「没测」，是测不了，连 tsc 都够不着。
 *
 * 所以它只做一件事：把 intent 的四个字段**原样**发成一个事件。
 * **一个 `if` 都没有**：这是不是一次分享、文字空不空、标题要不要跟正文拼、
 * 要不要去重、存哪儿、失败了说什么——全部在网页层
 * （web/src/lib/sharePlan.ts），那半有测试。
 * **判断落进这里的那一刻，它就从「有守卫」变成「只能真机验」**
 * （设计正本 docs/superpowers/specs/2026-08-13-full-rebuild-design.md
 * 第十一节「分享接入」小节）。接线本身由
 * scripts/share-target-wired.test.ts 守着，含「这个文件里一个 if 都没有」那条。
 *
 * **冷启动和热启动为什么只需要覆盖这一个回调**（读的是
 * node_modules/@capacitor/android 的源码，不是记得；行号当场数过）：
 * - 热启动：manifest 里 launchMode="singleTask" ⇒ 安卓复用现有 Activity ⇒
 *   BridgeActivity.onNewIntent(197-206 行) ⇒ Bridge.onNewIntent(1300-1307 行)
 *   逐个插件调 handleOnNewIntent(1301-1303 行)。
 * - 冷启动：BridgeActivity.load() 建完 bridge 之后，**最后一句就是
 *   `this.onNewIntent(getIntent())`**（BridgeActivity.java:51）⇒ 同一个回调。
 * ⚠️ **所以千万别再在 Plugin.load() 里发一次**：那样冷启动会发两遍，而
 * 「同一次分享只存一条」就得靠去重——那是判断，只能在网页层，等于凭空造出
 * 一个问题还把它塞进测不了的这一半。
 *
 * **不判空**：BridgeActivity.onNewIntent 里已经有
 * `if (this.bridge == null || intent == null) return;`（201 行），
 * 这里永远拿不到 null。多判一次就是把一个不会发生的分支写进测不了的代码。
 *
 * **notifyListeners 第三个参数 true = retainUntilConsumed**：冷启动时这个
 * 回调跑在 WebView 加载 JS **之前**，那一刻一个监听者都没有。
 * Plugin.java:661-683 在没有监听者时（:664）把 data 追加进
 * retainedEventArguments（:666-675），false 的话那一支直接 return（:676）、
 * 事件就没了。补发在 sendRetainedArgumentsForEvent（:712-724）：**先
 * remove（:719）再遍历补发（:721-723），所以只消费一次，WebView 重载不会重放**；
 * 它唯一的调用点是 addEventListener（:627-640）里 listeners 为 null/空的那一支
 * （:636），也就是**第一个**监听者注册的那一刻。
 * ⚠️ 以上全部来自读源码，**不是真机验过的**——真机那半见
 * android/冒烟清单.md 第 10b 步。
 *
 * **为什么是 Java 不是 Kotlin**（设计正本的字面是 Kotlin）：app 模块现在
 * 没有 Kotlin 工具链——android/app/build.gradle 只 apply 了
 * 'com.android.application'，android/build.gradle 的 buildscript classpath
 * 里没有 kotlin-gradle-plugin（@capacitor/local-notifications 是 Kotlin，
 * 但它在自己的 android/build.gradle 里带了一份 buildscript，跟 app 模块无关）。
 * 写 Kotlin 要改两个构建文件，而这一批不跑 gradle 构建、改坏了要等装 APK
 * 那一刻才炸。MainActivity 本来就是 Java，挨着放，零构建改动。
 * 设计正本要的是「自写最小插件、原生那半零判断」，语言不是那句话的内容。
 *
 * 键为 null 时 JSObject.put(String,String)（JSObject.java:154-159）直接转
 * org.json.JSONObject.put(String,Object)，**那个键被移除**，所以网页那边收到的
 * 是「键缺席」——SharePayload 四个字段全可选就是这么来的。
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    @Override
    protected void handleOnNewIntent(Intent intent) {
        JSObject data = new JSObject();
        data.put("action", intent.getAction());
        data.put("type", intent.getType());
        data.put("text", intent.getStringExtra(Intent.EXTRA_TEXT));
        data.put("subject", intent.getStringExtra(Intent.EXTRA_SUBJECT));
        notifyListeners("shared", data, true);
    }
}
