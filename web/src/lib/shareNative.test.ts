import { describe, expect, it } from 'vitest';
import { ACTION_SEND, type SharePayload } from './sharePlan.js';
import { nativeSharePort, subscribeShare, type SharePort } from './shareNative.js';
// `nativeSharePort` 在下面那几条编排测试里**一次都不碰**（它们全走假 port）。
// 它只出现在文件最后那个 describe 里，验的是薄壳两半里**在 jsdom 里验得了的那半**
// （`available()`）；另一半（订阅之后真的收得到原生事件）没有原生桥，只能真机验，
// 见 android/冒烟清单.md 第 10 步。
// ⚠️ 「薄壳测不了」这句**只对一半成立**，别把可测的那半也一起划进「只能真机验」
// ——上一批就是这么漏的（parked-all 第 147 条：诚实写了「这块没有自动化测试」，
// 结果可测的那半也跟着没人写）。

/**
 * 假原生桥。**它自己一个判断都不做**：`emit` 收到什么就原样交给监听者。
 *
 * 这一条是有意的——接缝 C（`SharePayload` 穿过 port）要断的就是「整份 payload
 * 原样到了 `shareToInboxText` 手里」（parked-all 第 158 条：替身切得对、而穿过
 * 替身的那份数据没人验，是这个仓库最贵的一类假绿）。替身要是在中间挑字段、
 * 补默认值，穿过去的就是替身的想象，生产代码把 payload 拆散了也照样绿。
 *
 * `log` 用对象不用三个 let：数字是值类型，`return { subscribes }` 那份拿回去
 * 就冻住了，后面再订阅也不会变——这种断言恒等于初始值，永远绿。
 */
function fakePort(over: Partial<SharePort> = {}): {
  port: SharePort;
  emit: (payload: SharePayload) => void;
  log: { subscribes: number; unsubscribes: number };
} {
  const log = { subscribes: 0, unsubscribes: 0 };
  let listener: ((payload: SharePayload) => void) | null = null;
  const port: SharePort = {
    available: () => true,
    onShared: (cb) => {
      log.subscribes += 1;
      listener = cb;
      return () => { log.unsubscribes += 1; };
    },
    ...over,
  };
  // 没人订阅就 emit ⇒ 当场抛，**不许静默地什么都不做**：那样「测试自己写错了、
  // 事件压根没发出去」会伪装成「onText 没被调」，而那正好是好几条断言的期望值
  // （155 那几格），真错会被自己的期望盖住。
  const emit = (payload: SharePayload): void => {
    if (!listener) throw new Error('测试自己写错了：还没订阅就 emit');
    listener(payload);
  };
  return { port, emit, log };
}

/**
 * 变异清单（收尾时逐格打一发，整个文件跑、不加 `-t`；实现里**不留**这些改动）：
 * ① `shareToInboxText(payload)` → `shareToInboxText({ text: payload.text })`
 *    ⇒ 「整份 payload 穿过去」必须红（158 的判据）；
 * ①b 只丢 `subject`：→ `shareToInboxText({ action: payload.action, text: payload.text })`
 *    ⇒ 同一条必须红。**①b 比①严**：①连 `action` 一起丢了，它红是因为「不算分享」，
 *    不能证明 `subject` 有人验；只有①b 红才说明那条断言断的是拼出来的整份文本。
 * ② 删掉 `if (!port.available()) return () => {};` ⇒ 「不在原生壳里」那条必须红；
 * ③ `return port.onShared(...)` → 订阅照做、但返回 `() => {}` ⇒ 「清理函数」那条必须红；
 * ④ 删掉 `if (text !== null)`（直接 `onText(text!)`）⇒ 「不是分享那条」必须红；
 * ⑤ `port.onShared(cb)` 调两遍 ⇒ 「恰好订阅 1 次」必须红；
 * ⑥ 给回调加一道内容去重 ⇒ 「连发两条一样的」必须红。
 */
describe('subscribeShare——把原生事件接到网页层的编排', () => {
  it('不在原生壳里（桌面/浏览器：这个插件没有 web 实现，available 恒 false）⇒ onShared 一次都没被调，而且返回的清理函数照样能安全调', () => {
    // 断的是 `onShared` 的调用次数本身，**不是「addInbox 没被调」那种下游推理**
    // （155 的第三格：三种「什么都没发生」里的「压根不在原生壳里」这一种，
    // 另外两种是 sharePlan.ts 那个纯函数的事）。
    const { port, log } = fakePort({ available: () => false });
    const stop = subscribeShare(port, () => { throw new Error('桌面上不该有任何分享文本进来'); });
    expect(log.subscribes).toBe(0);
    // 清理函数得能白调：React 卸载时不看这一路走没走通，照样调 cleanup。
    expect(() => stop()).not.toThrow();
    expect(log.unsubscribes).toBe(0);
  });

  it('在原生壳里 ⇒ 恰好订阅 1 次（不是「至少 1 次」：订两遍的话一条分享进两条收件箱，而原生那半只发一遍）', () => {
    const { port, log } = fakePort();
    subscribeShare(port, () => {});
    expect(log.subscribes).toBe(1);
  });

  it('整份 payload 穿过去：四个字段都在 ⇒ onText 恰好收到「标题\\n正文」那一份（接缝 C，158）', () => {
    const { port, emit } = fakePort();
    const got: string[] = [];
    subscribeShare(port, (text) => got.push(text));
    emit({
      action: ACTION_SEND,
      type: 'text/plain',
      subject: 'Rust 的所有权模型',
      text: 'https://example.invalid/ownership',
    });
    // 收集数组整份 `toEqual`：一条断言同时按住「恰好一次」和「实参一字不差」。
    expect(got).toEqual(['Rust 的所有权模型\nhttps://example.invalid/ownership']);
  });

  it('action 不是 SEND 但带着正文 ⇒ onText 不被调；而且订阅没被这一条掐断，紧接着那条真分享照样进来', () => {
    // 夹具只违反 `action` 这一条（150：Task 1 现场演过——拿「MAIN 且没 text」当
    // 夹具的话，空文字那道守卫会先挡住，删掉 action 守卫这一格照样绿）。
    // 顺带按住「拒掉一条不许顺手退订」：第二条真分享还得进得来。
    const { port, emit } = fakePort();
    const got: string[] = [];
    subscribeShare(port, (text) => got.push(text));
    emit({ action: 'android.intent.action.VIEW', text: '这条是从别的 intent-filter 掉进来的，不该进收件箱' });
    emit({ action: ACTION_SEND, text: '这条才是真的分享' });
    expect(got).toEqual(['这条才是真的分享']);
  });

  it('清理函数被调用 ⇒ port 的退订恰好被调 1 次（React effect 的 cleanup 直接用它；漏退订这个仓库栽过）', () => {
    const { port, log } = fakePort();
    const stop = subscribeShare(port, () => {});
    // 调之前先断 0：不然「订阅那一刻就退了」也能让下面那句绿。
    expect(log.unsubscribes).toBe(0);
    stop();
    expect(log.unsubscribes).toBe(1);
  });

  it('同一次订阅里连发三条（前两条一模一样）⇒ onText 被调 3 次、每次都是当场那一份——这一层不去重（决定六）', () => {
    // 两条一模一样的：按住「没有内容去重」。同一段文字分享两次绝大多数时候是
    // 真的想记两次，而「我明明分享了、它没进去」的代价大一个量级。
    // 第三条换一份：按住「每次拿的是当场那份 payload」，不是缓存住的第一份。
    const { port, emit, log } = fakePort();
    const got: string[] = [];
    subscribeShare(port, (text) => got.push(text));
    emit({ action: ACTION_SEND, text: '周五之前把押金退了' });
    emit({ action: ACTION_SEND, text: '周五之前把押金退了' });
    emit({ action: ACTION_SEND, subject: '退租清单', text: '搬家那天要把水电燃气都抄表' });
    expect(got).toEqual([
      '周五之前把押金退了',
      '周五之前把押金退了',
      '退租清单\n搬家那天要把水电燃气都抄表',
    ]);
    // 三条事件、一次订阅：编排不许每来一条就重订一次。
    expect(log.subscribes).toBe(1);
  });
});

describe('nativeSharePort——薄壳里在 jsdom 里验得了的那半', () => {
  // **这条测试有牙，是因为判据只有 `isPluginAvailable` 一条。**
  // `isPluginAvailable('ShareTarget')` = 「registeredPlugins 里那份的 platforms 含
  // 当前 platform」或「原生 PluginHeaders 里有」，而 platforms 是
  // `new Set([...Object.keys(jsImplementations), ...])`（出处
  // node_modules/@capacitor/core/dist/index.js `:49-59` 和 `:178`）。
  // ⇒ 哪天有人给 `registerPlugin(SHARE_PLUGIN_NAME)` **补上第二个参数**（一个 web
  // 实现），platforms 就含上 'web'、这一句当场翻 true、**这条测试红**——那也正是
  // 该红的时候：桌面上凭空多出一条分享路径。把判据改成 `() => true` 同理。
  //
  // ⚠️ **别顺手加 `Capacitor.isNativePlatform() &&`**（上一批 notifyNative.ts 是那么
  // 写的，理由在那个文件里，那条理由在这个插件上不成立）：加了之后 jsdom 里
  // isNativePlatform() 恒 false 会**替这条断言兜住**，上面说的两种坏改法就再也
  // 红不起来了——这条测试会变成一条永远绿的摆设（150 那条的反向：想清楚新加的
  // 守卫会不会把已有的那道遮死）。
  // **这句不是推理，是量过的**：给 registerPlugin 补上 `{ web: … }` 之后，
  // 判据只有 isPluginAvailable 时这条**红**（退出码 1）；把 `isNativePlatform() &&`
  // 加回去、web 实现照样留着，它**绿**（退出码 0）。两发变异的记录在
  // .superpowers/sdd/2026-08-24-share-target/task-3-report.md。
  //
  // 正半（真机上恒 true）在 jsdom 里装不出来（没有 androidBridge、没有
  // PluginHeaders），只能真机验，android/冒烟清单.md 第 10 步。
  it('web 平台（Electron/浏览器/jsdom 是同一格）恒 false——桌面上订阅压根不发生', () => {
    expect(nativeSharePort.available()).toBe(false);
  });
});
