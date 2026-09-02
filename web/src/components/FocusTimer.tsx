import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { holdTitle, releaseTitle } from '../lib/pageTitle.js';
import { Button } from 'antd';
import type { FocusSession } from '../types.js';

/**
 * 全局同一时刻只能有一个番茄钟在跑（task-4-brief「同一时刻只有一个在跑」，
 * 具体挡法自己定：开第二个直接不让开，不是抢过来替换掉第一个——「替换」要
 * 强行打断另一张卡片正在跑的倒计时，而那份状态活在那张卡自己的组件实例里，
 * 没有比「开始时看一眼锁在谁手上」更省事的办法。
 *
 * ponytail: 模块级单例锁，不用 Context/Redux——这是单人单页应用，跨卡片要
 * 协调的只有这一个「谁在跑」。只活在内存里，不持久化：跟规格「关掉页面 =
 * 放弃」同一条道理，刷新页面锁自然清零，不需要专门处理。
 *
 * **锁按组件实例建，不按 taskId 建**（final-review.md C1）。「今天」「按来源」
 * 两个视图是 `keepMounted: true`（views.tsx），切走只是 `hidden`，不卸载——
 * 同一张卡因此会同时挂着**两个** `FocusTimer` 实例，`taskId` 相同不代表它们
 * 是同一个「正在跑的东西」。按 `taskId` 建锁的话，第二个实例发现锁已经是
 * 「自己的 taskId」，会当成重入放行，两个倒计时同时跑，跑完各发一条内容
 * 相同的 PATCH，后一条覆盖前一条，静默丢掉一条 `focusSession`。每个组件
 * 实例调用 `useId()` 拿到的字符串在这个实例的生命周期里唯一且不变，两个
 * 实例即使代表同一个任务也不会撞。
 */
let activeId: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const getSnapshot = () => activeId;

/** 锁必须空着才能拿到。TaskCard 的按钮在锁被占用时已经 disabled，这里是
 *  第二道防线，不指望调用方守规矩——但不用再判断「锁是不是已经是自己的」：
 *  锁键现在是 `useId()`，同一个实例不会重入（`start` 只在没在跑时可点），
 *  「已经是自己的」这个分支不会发生，判断它只会重新打开按 taskId 建锁时
 *  那个洞。 */
function tryAcquire(id: string): boolean {
  if (activeId !== null) return false;
  activeId = id;
  notify();
  return true;
}

/** 幂等：只有锁确实是自己占着才清掉，不是自己的直接忽略——组件卸载时无条件
 *  调用这个也是安全的，不会误放别人的锁（见下面卸载那个 effect）。 */
function release(id: string): void {
  if (activeId === id) {
    activeId = null;
    notify();
  }
}

export interface FocusTimerProps {
  /** 一轮的时长，分钟，来自 Settings.focusMinutes（默认 25）。 */
  minutes: number;
  /**
   * 这一轮在专注哪条任务——**只用来写浏览器标签页的标题**，界面上不显示
   * （卡片上那个标题就在旁边，写两遍是噪音）。不给就只写时间。
   */
  label?: string;
  /**
   * 一轮走完之后歇多久，分钟，来自 `Settings.breakMinutes`（默认 5）。
   * **0 或不给 = 不休息**，走完直接回到「开始专注」，跟加这个之前一模一样。
   */
  breakMinutes?: number;
  /** 倒计时走完时调用一次，带上这次专注的记录——**追加不追加进
   *  task.focusSessions 是调用方的事**（TaskCard.tsx 接线时把它跟已有的
   *  focusSessions 拼起来发 PATCH，不是这个组件替它决定）。中途点「取消」
   *  不会调用这个回调——规格原话「中途放弃不记」，也不会发出任何请求。 */
  onComplete: (session: FocusSession) => void;
  /**
   * **专注那一段跑到一半、这个组件被卸载了**——调一次，让调用方说一声。
   *
   * 「关掉页面 = 放弃」是规格定死的（见下面组件注释），但**卸载不止「关掉
   * 页面」这一种**：切到日历看一眼、把密度从卡片换成行、这张卡被筛掉，都会
   * 卸载它。那几下用户并没有觉得自己在放弃什么，而屏幕上那个走了十八分钟的
   * 倒计时就这么没了，一个字都不说——这是这个应用里为数不多的**静默丢东西**。
   *
   * 不改「不记」这条规矩（持久化要回答「浏览器崩了算不算完成」，那个问题没有
   * 干净的答案），只是不再瞒着。
   *
   * **休息那一段不调**：这一轮的记录在专注结束那一刻就已经发出去了，歇着被
   * 打断没有任何东西会丢。
   */
  onAbandon?: () => void;
}

/**
 * 卡片上的番茄钟。「开始专注」→ 倒计时 →走完自动调 `onComplete`；倒计时中途
 * 「取消专注」→ 什么都不发生，回到「开始专注」。
 *
 * **状态只活在这个组件实例的 `useState` 里，不持久化。** 关掉页面、这张卡被
 * 筛掉/删掉（组件卸载）都等于放弃——跟中途点取消是同一个结果：不追加、不
 * 发请求。这是规格「中途放弃不记」的延伸：持久化了就得回答「浏览器崩了算不算
 * 完成」，那个问题没有干净的答案，干脆不进这扇门。
 */
export function FocusTimer({ minutes, label, breakMinutes = 0, onComplete, onAbandon }: FocusTimerProps) {
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  // 现在跑的是哪一段。`'focus'` 是专注，`'break'` 是歇着——**用一个 phase 而
  // 不是再加一个 `resting` 布尔**：两个布尔能拼出「又在专注又在休息」这种
  // 不存在的状态，而这个组件的整个正确性都建立在「同一时刻只有一件事在跑」
  // 上（见文件顶部那把锁）。
  const [phase, setPhase] = useState<'focus' | 'break'>('focus');
  // 这个组件实例自己的锁键，挂载期间恒定不变——见上面模块顶部注释。
  const lockId = useId();
  const lockHolder = useSyncExternalStore(subscribe, getSnapshot);
  const blocked = lockHolder !== null && lockHolder !== lockId;
  /**
   * **正计时**（仿滴答清单，跟番茄计时并列的另一种计时模式）：
   *
   * > 正计时：以正计时的方式持续记录专注时长，**适合不希望被打断、希望沉浸式
   * > 计时的人群**。
   * >
   * > —— 《如何开始专注》
   *
   * 番茄钟回答的是「我能坚持二十五分钟」，正计时回答的是「这件事到底花了我
   * 多久」——后者是这个应用里 `estimateMinutes`（预计时长）唯一的对照物，
   * 而在这之前它只能靠「补记」事后估一个数填进去。
   *
   * **写成跟倒计时并列的一支，不是把倒计时改成能双向走**：那台机器有截止时刻、
   * 有自动完成、有休息那半段，正计时一样都没有。（滴答那篇讲两种计时模式的
 * 文章里，「休息」只出现在番茄计时那一档的描述里，正计时那段没提——**是没提，
 * 不是明说没有**，这里按「没有」做是我们自己的判断。）
   * 揉成一个的话每一处 `if` 都要多问一次「现在是哪种」，而这个组件的注释里
   * 记着的坑有一半就来自「同一段代码要同时对两种状态成立」。
   *
   * `upFrom` 是开始那一刻的 epoch 毫秒，`null` = 没在正计时。
   */
  const [upFrom, setUpFrom] = useState<number | null>(null);
  const [upSec, setUpSec] = useState(0);
  /** 倒计时那一支在跑。原来叫 `running`——加了正计时之后，那个名字归两支合起来用。 */
  const counting = remainingSec !== null;
  const running = counting || upFrom !== null;
  /** 屏幕上和标签页上显示的那个秒数：倒计时显示还剩多少，正计时显示已经走了多少。 */
  const shownSec = counting ? (remainingSec ?? 0) : upSec;
  // 用绝对的目标时刻算剩余秒数，不是每 tick 减一——跟 ScheduledBanner.tsx
  // 同一个写法，躲开定时器本身的漂移（每次 setInterval 的实际间隔不保证
  // 精确 1000ms）。
  const deadlineRef = useRef(0);
  const startedAtRef = useRef('');
  // 完成时该调的 onComplete，每次渲染都刷新成最新那份——不能靠下面 interval
  // 那个 effect 的闭包：它只在 running 翻转时重开一次，拿到的是「开始那一刻」
  // 的 onComplete。TaskCard 传进来的 onComplete 闭包捕获的是它渲染那一刻的
  // `t.focusSessions`，倒计时跑的这几分钟里如果来过一次 SSE 刷新（别处也
  // 写过 focusSessions），TaskCard 会用新数据重渲染、换一个新的 onComplete
  // 闭包——不走 ref 的话，完成时调用的还是开始那一刻的旧闭包，会把刷新期间
  // 写进去的那条记录连带覆盖掉。ref 保证完成那一刻用的是最新一次渲染给的
  // 那份，而不是开始时钉死的那份（final-review.md C1 附带的那半个后果）。
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  // interval 的闭包只在 `running` 翻转时建一次，而 phase 会在它跑着的时候
  // 从 focus 变成 break——闭包里那个 `phase` 会永远是 'focus'，第二次归零
  // 时会再发一条记录。走 ref 拿当下这一刻的值。
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  /**
   * **专注跑着的时候，把剩余时间写进浏览器标签页**（仿滴答清单
   * 《更新动态》 6 月 3 日那条：「无需返回滴答清单，也能随时
   * 了解当前专注进度」）。
   *
   * 这件事对番茄钟是**本命**的：这个计时器存在的全部意义就是「你切走去干别的
   * 了」——而切走之后它在屏幕上就不存在了，想看一眼剩多久得先切回来，而切回来
   * 正是它要防的那个动作。
   *
   * ## 三处讲究
   *
   * **不自己写 `document.title`，走 `lib/pageTitle.ts` 的「占用 / 交还」**。
   * 原来这儿是「挂载时拍一张原标题的快照、结束时写回去」，两个毛病：
   * 快照会过期（人在番茄钟跑着的时候切了视图，还原写回去的是上一屏的名字），
   * 而且反方向也漏了——切视图那一下 `setBaseTitle` 会直接把秒数盖掉，要等到
   * 下一次跳秒才抢回来，标签页在后台时那个间隔被节流到约一分钟。
   * 现在占用期间写底不碰屏幕，交还时拿的是**当下**的底。
   *
   * **`blocked` 的实例不写。** 同一张卡上会同时挂着两个 `FocusTimer` 实例
   * （见文件顶部那把锁），而 `running` 只对拿到锁的那个为真——所以这里跟着
   * `running` 走就够了，不用再判一次锁。
   *
   * **清理函数一定要还原**：不管是走完、点取消、还是整个组件被卸载
   * （切视图、换密度、这张卡被筛掉），标签页都得变回原来那个。少了这一步，
   * 一个走了一半被卸载的番茄钟会把标题永久钉在某个时刻上。
   */
  useEffect(() => {
    if (!running || typeof document === 'undefined') return undefined;
    return () => { releaseTitle(); };
  }, [running]);

  useEffect(() => {
    if (!running || typeof document === 'undefined') return;
    const m = String(Math.floor(shownSec / 60)).padStart(2, '0');
    const s = String(shownSec % 60).padStart(2, '0');
    // 休息那一段也写，但说清是休息——不然「05:00」看着像专注只剩五分钟。
    const what = phase === 'break' ? '休息' : (label ?? '专注');
    holdTitle(`${m}:${s} · ${what}`);
  }, [running, shownSec, phase, label]);

  useEffect(() => {
    // **收窄到 `counting`**：`running` 现在把正计时也算进来，而这台机器整个
    // 建立在 `deadlineRef` 上——正计时没有截止时刻，让它进来会每秒算出一个
    // 负数、当场「走完」并发一条记录出去。
    if (!counting) return;
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000));
      if (left > 0) {
        setRemainingSec(left);
        return;
      }
      if (phaseRef.current === 'break') {
        // 休息结束：只收拾自己，**不再发一条记录**——歇着不是专注，
        // 这一轮的那条在专注结束那一刻就已经发出去了。
        clearInterval(id);
        release(lockId);
        setRemainingSec(null);
        setPhase('focus');
        return;
      }
      // 专注结束：记录照发（时长按专注那一段算，跟休息无关）。
      onCompleteRef.current({ startedAt: startedAtRef.current, minutes });
      if (breakMinutes > 0) {
        // **这一支不 clearInterval**：接着要跑休息那一段，而 `running` 一直
        // 是 true，这个 effect 不会重跑、不会有第二个 interval 被建出来——
        // 在这儿清掉的话休息的倒计时会当场冻住在初始值，永远走不完。
        // （第一版就是这么写的，三条测试当场红。）
        // **锁不放**：一个番茄是「专注 + 休息」两半，歇着的时候去别的卡上
        // 开一个新的倒计时，等于把这一半跳过了。想跳有「跳过休息」那颗按钮，
        // 那是明说的，不是绕过去的。
        setPhase('break');
        deadlineRef.current = Date.now() + breakMinutes * 60_000;
        setRemainingSec(breakMinutes * 60);
      } else {
        clearInterval(id);
        release(lockId);
        setRemainingSec(null);
      }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 counting 翻转时重开/关掉定时器；
    // minutes/breakMinutes 中途变化不该打断正在走的倒计时；onComplete 中途
    // 变化走上面的 ref，不需要靠重开定时器去拿到最新那份。**phase 也不进
    // 依赖数组**：从专注切到休息时 `counting` 一直是 true，这个 effect 不会
    // 重跑，同一个 interval 接着用——所以循环体里读的是 `phaseRef`，不是
    // 闭包里那个会过期的 `phase`。
  }, [counting]);

  /**
   * 正计时那一支的定时器。**比倒计时那台简单一个数量级**：没有截止时刻、
   * 不会自己走完、不接休息，只是每秒把「走了多久」重算一遍。
   *
   * 秒数**从开始那一刻的时间戳现算**，不是每 tick 加一——跟倒计时那边躲
   * `setInterval` 漂移是同一条理由，而且这一支还要多躲一样：电脑睡一觉醒来，
   * 加一那种写法会少掉睡着的那段，而正计时要的正是墙上那个真实时长。
   */
  useEffect(() => {
    if (upFrom === null) return undefined;
    const id = setInterval(() => {
      setUpSec(Math.max(0, Math.round((Date.now() - upFrom) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [upFrom]);

  // 卸载那一刻还在不在跑专注那一段——`useEffect` 的清理函数读不到 state
  // 的当下值（闭包钉在挂载那一次），只能走 ref。休息那一段不算：这一轮的
  // 记录在专注结束那一刻就已经发出去了。
  const abandonRef = useRef(false);
  abandonRef.current = running && phase === 'focus';
  const onAbandonRef = useRef(onAbandon);
  useEffect(() => { onAbandonRef.current = onAbandon; }, [onAbandon]);

  // 卸载即放弃：不管这一刻是不是真的在跑，无条件尝试放锁——release() 本身
  // 是幂等的，不会误放别人占着的锁。没有这一步的话，这张卡被筛掉/删掉时
  // 全局番茄钟会永久卡死在「锁着」的状态，谁都开不了下一个。
  //
  // **真的在跑的话还要说一声**（`onAbandon`）：切个视图、换个密度都会走到
  // 这儿，而那几下用户并没有觉得自己在放弃什么，见那个 prop 的注释。
  useEffect(() => () => {
    release(lockId);
    if (abandonRef.current) onAbandonRef.current?.();
  }, [lockId]);

  const start = () => {
    if (!tryAcquire(lockId)) return;
    setPhase('focus');
    startedAtRef.current = new Date().toISOString();
    deadlineRef.current = Date.now() + minutes * 60_000;
    setRemainingSec(minutes * 60);
  };

  /** 开始正计时。**跟倒计时抢同一把锁**——「同一时刻只有一个在跑」这条规矩
   *  不分模式，两支都在跑的话专注记录会互相盖。 */
  const startUp = () => {
    if (!tryAcquire(lockId)) return;
    setPhase('focus');
    startedAtRef.current = new Date().toISOString();
    setUpFrom(Date.now());
    setUpSec(0);
  };

  /**
   * **不足一分钟不给记。** `FocusSession.minutes` 是分钟，二十秒四舍五入是 0
   * ——一条 0 分钟的专注记录在统计里什么都不是，在「专注记录」那张表上还占一行。
   *
   * 所以这颗按钮在满一分钟之前是禁用的，而不是点了悄悄不记：这个仓库最怕
   * 「点下去了、什么也没发生」。要在一分钟内退出，旁边那颗「取消」就是。
   */
  const UP_MIN_SEC = 60;
  const finishUp = () => {
    if (upSec < UP_MIN_SEC) return;
    onCompleteRef.current({ startedAt: startedAtRef.current, minutes: Math.round(upSec / 60) });
    release(lockId);
    setUpFrom(null);
    setUpSec(0);
  };

  // 中途取消：只清本地状态、放锁，**不调用 onComplete**——规格「中途放弃
  // 不记」，调用方（TaskCard）没有任何 patch 可发，这里也不该替它编一个。
  const cancel = () => {
    release(lockId);
    setRemainingSec(null);
    // 正计时那一支也一起收拾——这颗按钮在两种模式下都是「不记，退出」。
    setUpFrom(null);
    setUpSec(0);
    setPhase('focus');
  };

  if (running) {
    const m = String(Math.floor(shownSec / 60)).padStart(2, '0');
    const s = String(shownSec % 60).padStart(2, '0');
    // 裸 <span> 分组，不新起一个 CSS 类——这个仓库的约定是每个 .ink- 前缀
    // 类名都要在 theme.css 里有对应规则、在 theme.css.test.ts 里有前缀扫描
    // 断言守着（见那个文件顶部注释）；这里只是把两个已有元素摆一块，没有
    // 独立的视觉规则要定义，加一个不带样式的类名纯属噪音。
    const resting = phase === 'break';
    // 正计时那一支：数字往上走，而且**结束就是记账**——所以它有两颗按钮，
    // 「结束」记下来、「取消」不记。倒计时那边只有一颗，因为那边走完了自己
    // 会记，中途退出的语义只有「不记」一种。
    if (upFrom !== null) {
      const enough = upSec >= UP_MIN_SEC;
      return (
        <span>
          <span className="ink-focus-tag">正计时</span>
          <span
            className="ink-mono"
            aria-live="polite"
            aria-label={`正计时已经走了 ${m} 分 ${s} 秒`}
          >{m}:{s}</span>
          {/* 不足一分钟时禁用，`title` 说明白为什么——一条 0 分钟的记录
              在统计里什么都不是。禁用按钮自己的 title 是它的 accessible
              description，读屏读得到（下面那段注释为这件事考证过）。 */}
          <Button
            size="small"
            onClick={finishUp}
            disabled={!enough}
            title={enough ? undefined : '不到一分钟，记下来也是 0 分钟'}
          >结束</Button>
          <Button size="small" onClick={cancel}>取消</Button>
        </span>
      );
    }
    return (
      <span>
        {/* 休息时前面加一个字，**不换一套样式**：人扫一眼要能分出「这是在
            专注还是在歇着」，而两个状态的形状是一样的（一个倒计时 + 一颗
            退出按钮），换配色只会多一条要守的规则。 */}
        {resting && <span className="ink-focus-tag">休息</span>}
        <span
          className="ink-mono"
          aria-live="polite"
          aria-label={`${resting ? '休息' : '专注'}倒计时还剩 ${m} 分 ${s} 秒`}
        >{m}:{s}</span>
        <Button size="small" onClick={cancel}>{resting ? '跳过休息' : '取消专注'}</Button>
      </span>
    );
  }

  // 被别的卡占着锁时那句解释，**span 和按钮上各挂一份，两份都要**——它们喂的是
  // 两条互不相通的通道，实测（CDP 读 Accessibility 树）确认过：
  //
  //   <button disabled title="…">          name="开始专注"  description="已经在专注…"
  //   <span title="…"><button disabled>     name="开始专注"  description="(无)"
  //   ↑ 那个 span 本身                       role=generic（AT 不会主动播报）
  //
  // 也就是说：**禁用按钮自己的 `title` 是它的 accessible description，读屏读得到**；
  // 挪到无 role 的 span 上就什么都不剩。曾经只留 span 那一份——为了修一个
  // 「Chrome 到底渲不渲染禁用控件 tooltip」这种测不准的鼠标问题，换来一个确证的
  // 读屏回归，而且这个仓库还发着 Capacitor 安卓包，那边压根没有 hover。
  //
  // 两份并存不会读两遍：按钮自己的 title 优先，span 那份只在鼠标那条路上起作用
  // （`.ink-focus-blocked > .ant-btn` 把按钮的指针事件关掉，hit-test 落到 span，
  // 它是个普通元素，tooltip 必然显示）。
  //
  // **span 常驻，只有 className/title 跟着 `blocked` 变**，不是「blocked 时才包
  // 一层」：那样写过一版，两种状态的 JSX 结构不同，React 会把按钮卸载再挂一颗新的
  // ——键盘正停在这颗按钮上的人，会因为别的卡开始专注而把焦点掉回 <body>
  // （FocusTimer.test.tsx 里一条既有测试当场逮住了它，测试红只是表象）。
  const blockedHint = blocked ? '已经在专注另一件事了，一次只能跑一个' : undefined;
  return (
    <span className={blocked ? 'ink-focus-blocked' : undefined} title={blockedHint}>
      <Button size="small" disabled={blocked} onClick={start} title={blockedHint}>开始专注</Button>
      {/* 正计时（仿滴答清单跟番茄计时并列的那一档，见上面 `upFrom` 那段）。
          **摆成第二颗按钮，不是藏进菜单**：它跟「开始专注」是并列的两种开始
          方式，藏一个起来等于说其中一种是次要的——而「这件事到底花我多久」
          跟「我能不能坚持二十五分钟」是两个都常见的问题。
          文案写「正计时」不写「开始正计时」：旁边那颗已经带了「开始」，
          两颗并排时第二个「开始」是纯噪音。 */}
      <Button size="small" disabled={blocked} onClick={startUp} title={blockedHint}>正计时</Button>
    </span>
  );
}
