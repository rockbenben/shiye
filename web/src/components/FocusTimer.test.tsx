import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { setBaseTitle, releaseTitle } from '../lib/pageTitle.js';
import { FocusTimer } from './FocusTimer.js';

// 跟 ScheduledBanner.test.tsx 同一条约定：这个文件不涉及 hash 路由，用完整的
// vi.useFakeTimers()（不是日历那批 App.test.tsx 里限定 toFake: ['Date'] 的
// 写法）没问题——那个限定是为了不饿死 App.test.tsx 里 hash 路由和 waitFor 的
// 轮询，这个文件里两者都不存在。每个用到假时钟的用例结束后都要还原，不然
// 状态会漏到下一个 it()。
afterEach(() => {
  vi.useRealTimers();
});

describe('FocusTimer：开始 → 倒计时 → 结束', () => {
  it('初始只有「开始专注」按钮，没有倒计时显示', () => {
    render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: '开始专注' })).toBeTruthy();
    expect(screen.queryByText(/^\d{2}:\d{2}$/)).toBeNull();
  });

  it('点「开始专注」：换成倒计时 + 「取消专注」，「开始专注」不再出现', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={5} onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));

    expect(screen.getByText('05:00')).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消专注' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '开始专注' })).toBeNull();
  });

  it('时长可配：minutes=45 时初始倒计时是 45:00，不是写死的 25:00', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={45} onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));

    expect(screen.getByText('45:00')).toBeTruthy();
  });

  it('倒计时跟着时间推进——过 10 秒，05:00 变成 04:50', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={5} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));

    act(() => { vi.advanceTimersByTime(10_000); });

    expect(screen.getByText('04:50')).toBeTruthy();
  });

  it('倒计时走完：调用一次 onComplete，参数是 { startedAt: 开始那一刻的 ISO 字符串, minutes: 配置的时长 }；按钮变回「开始专注」', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T03:00:00.000Z'));
    const onComplete = vi.fn();
    render(<FocusTimer minutes={1} onComplete={onComplete} />);

    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    act(() => { vi.advanceTimersByTime(60_000); });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({ startedAt: '2026-08-17T03:00:00.000Z', minutes: 1 });
    expect(screen.getByRole('button', { name: '开始专注' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消专注' })).toBeNull();
  });

  /**
   * 「追加写成覆盖」这条变异盯的是 TaskCard.tsx 那层接线（onComplete 拿到的
   * 一条记录跟已有的 focusSessions 怎么拼），不是这个组件自己——FocusTimer
   * 压根不知道这张卡已经攒了几条 session，见 TaskCard.test.tsx 那组。
   *
   * 这里守的是「中途放弃不记」：取消之后 onComplete 一次都不会被调用，哪怕
   * 之后继续推进时间——不是「暂停了一下还会自己完成」，是彻底不算数了。
   */
  it('中途点「取消」：onComplete 不会被调用（哪怕之后继续推进时间），按钮回到「开始专注」', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<FocusTimer minutes={5} onComplete={onComplete} />);

    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    fireEvent.click(screen.getByRole('button', { name: '取消专注' }));

    expect(screen.getByRole('button', { name: '开始专注' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消专注' })).toBeNull();

    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

/**
 * 「同一时刻只有一个在跑」——task-4-brief 明说这条要有上限断言，不能出现
 * 两个同时倒计时。这里选的口径是「挡住」：第二个的「开始专注」按钮直接
 * disabled，不是抢过来把第一个的倒计时打断。
 *
 * **这两条现在就是 C1 的直接回归测试。** 组件不再收 `taskId` prop（见
 * final-review.md C1：锁改成按 `useId()` 建之后，`taskId` 相不相同已经跟
 * 锁没关系了）——这两个 `<FocusTimer>` 实例除了各自的 `useId()` 之外什么
 * 都不认，就是「今天」「按来源」两个 `keepMounted` 视图同时挂着同一张卡时
 * 的真实处境：调用方是不是传了同一个 `taskId`，锁都必须互斥。旧实现（锁按
 * `taskId` 建）在这里会失败：两个实例用不同 `taskId` 时锁本来就生效，测不出
 * C1——C1 恰恰是「两个实例代表同一个任务」时锁形同虚设，而组件现在压根拿不到
 * 「任务是谁」这个信息，所以「互斥」这件事无论如何都只能靠实例本身，不能靠
 * 调用方传的标识符，这两条测试也就自动覆盖了 C1 的场景。
 */
describe('FocusTimer：全局同一时刻只能有一个在跑（上限断言）', () => {
  it('A 开始之后，B 的「开始专注」被禁用；A 结束之后 B 重新可点', () => {
    vi.useFakeTimers();
    const a = render(<FocusTimer minutes={1} onComplete={vi.fn()} />);
    const b = render(<FocusTimer minutes={1} onComplete={vi.fn()} />);
    const btnA = within(a.container).getByRole('button', { name: '开始专注' }) as HTMLButtonElement;
    const btnB = within(b.container).getByRole('button', { name: '开始专注' }) as HTMLButtonElement;

    expect(btnB.disabled).toBe(false);

    fireEvent.click(btnA);
    expect(btnB.disabled).toBe(true);
    // A 真的在跑，不是按钮换了个禁用态却什么都没发生——两者都要看得到。
    expect(within(a.container).getByText('01:00')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(60_000); });   // A 走完，释放锁

    expect(within(b.container).getByRole('button', { name: '开始专注' }).hasAttribute('disabled')).toBe(false);
  });

  /**
   * 那句「为什么这颗按不动」要真的够得着。
   *
   * 原来它是 `<Button disabled title="…">`：禁用的表单控件不派发指针事件，
   * 浏览器那条 tooltip 路径跟着断掉，这句话在 Chrome 里一次都没露过面——而它是
   * 整个产品里唯一解释全局单计时器锁的文案。现在挂在外面包的那层 span 上，
   * 按钮的指针事件由 `.ink-focus-blocked > .ant-btn` 关掉（theme.css，那条规则
   * 自己也有断言守着），命中的是 span 本身。
   *
   * 断言分成四半，少哪一半都能让一个坏实现蒙混过去：① 那句话**span 和按钮上
   * 各有一份**——按钮那份是禁用按钮的 accessible description（读屏唯一读得到的
   * 那条通道，CDP 读 AX 树实测过），span 那份供鼠标 hover（按钮的指针事件被
   * `.ink-focus-blocked > .ant-btn` 关掉，hit-test 落到 span）。曾经只留 span
   * 那一份，读屏那条通道就整个断了，这条断言就是钉住「别再只留一份」；
   * ② 按钮**仍然是 disabled**（不是为了让 tooltip 出来就把锁松掉）；③ 没被挡住
   * 的时候类名和两份 title 都不在——不然「永远挂着 blocked 样式」也能让前两条
   * 全绿；④ 两种状态之间**是同一颗按钮节点**，不是卸载重挂——键盘停在这颗按钮
   * 上的人不该因为别的卡开始专注就把焦点掉回 <body>。
   */
  it('被挡住时那句解释 span 和按钮上各一份、按钮照旧 disabled；解锁后都不在，且全程是同一颗按钮', () => {
    vi.useFakeTimers();
    const a = render(<FocusTimer minutes={1} onComplete={vi.fn()} />);
    const b = render(<FocusTimer minutes={1} onComplete={vi.fn()} />);
    const btnB = within(b.container).getByRole('button', { name: '开始专注' }) as HTMLButtonElement;

    // ③ 没被挡住：类名和那句话都不在。
    expect(b.container.querySelector('.ink-focus-blocked')).toBeNull();
    expect(within(b.container).queryAllByTitle(/一次只能跑一个/)).toHaveLength(0);

    fireEvent.click(within(a.container).getByRole('button', { name: '开始专注' }));

    // ① 两条通道都在：外层 span（鼠标）+ **每一颗按钮自己**（读屏的
    //    accessible description）。数字不写死——闲着时那儿现在有两颗按钮
    //    （「开始专注」和「正计时」），将来多一颗的话这条该跟着一起过，
    //    而不是为了一个魔法数字变红。
    const HINT = '已经在专注另一件事了，一次只能跑一个';
    const holders = within(b.container).getAllByTitle(HINT);
    const btns = within(b.container).getAllByRole('button');
    expect(holders).toHaveLength(btns.length + 1);
    expect(btns.every((x) => x.getAttribute('title') === HINT)).toBe(true);
    const wrap = holders.find((el) => el.tagName === 'SPAN')!;
    expect(wrap).toBeDefined();
    expect(wrap.classList.contains('ink-focus-blocked')).toBe(true);
    // 按钮那一份是读屏唯一读得到的通道，**不许**再被挪走。
    expect(btnB.getAttribute('title')).toBe(HINT);
    expect(wrap.contains(btnB)).toBe(true);
    // ② 锁没有因为这次改写而松掉。④ 而且还是最初那一颗（引用没换）。
    expect(btnB.disabled).toBe(true);
    expect(within(b.container).getByRole('button', { name: '开始专注' })).toBe(btnB);

    act(() => { vi.advanceTimersByTime(60_000); });   // A 走完，释放锁

    // ③ 解锁之后类名和**两份** title 一起消失，按钮仍然是同一颗。
    expect(b.container.querySelector('.ink-focus-blocked')).toBeNull();
    expect(within(b.container).queryAllByTitle(/一次只能跑一个/)).toHaveLength(0);
    expect(btnB.disabled).toBe(false);
    expect(within(b.container).getByRole('button', { name: '开始专注' })).toBe(btnB);
  });

  it('A 开始后中途取消：B 的锁也跟着释放，不是只有「走完」才放', () => {
    vi.useFakeTimers();
    const a = render(<FocusTimer minutes={5} onComplete={vi.fn()} />);
    const b = render(<FocusTimer minutes={5} onComplete={vi.fn()} />);
    const btnA = within(a.container).getByRole('button', { name: '开始专注' });

    fireEvent.click(btnA);
    expect((within(b.container).getByRole('button', { name: '开始专注' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(a.container).getByRole('button', { name: '取消专注' }));

    expect((within(b.container).getByRole('button', { name: '开始专注' }) as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * I6：卸载即放弃那个 effect（`useEffect(() => () => release(lockId),
   * [lockId])`）没有断言守着——这道守卫防的是「卡片被筛掉/删掉时全局番茄钟
   * 永久卡死」，改筛选栏、改搜索词、切一个非 keepMounted 的视图、SSE 把这条
   * 任务删掉都会走到这条路径。这里不模拟真实卸载原因，直接调 RTL 的
   * `unmount()`：A 在跑的时候被卸载（既没等它走完，也没点取消），B 的锁必须
   * 跟着放开。
   */
  it('A 在跑的时候被卸载（卡片被筛掉/删掉）：B 的锁也跟着释放', () => {
    vi.useFakeTimers();
    const a = render(<FocusTimer minutes={5} onComplete={vi.fn()} />);
    const b = render(<FocusTimer minutes={5} onComplete={vi.fn()} />);

    fireEvent.click(within(a.container).getByRole('button', { name: '开始专注' }));
    expect((within(b.container).getByRole('button', { name: '开始专注' }) as HTMLButtonElement).disabled).toBe(true);

    a.unmount();

    expect((within(b.container).getByRole('button', { name: '开始专注' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * C1 附带的第二个坑：`onComplete` 闭包如果在开始那一刻就钉死，倒计时跑的
 * 这几分钟里如果父组件（TaskCard）因为 SSE 刷新换了一份新的 `onComplete`
 * （新闭包捕获的是刷新后的 `t.focusSessions`），完成时调用的还是旧闭包，会
 * 把刷新期间已经落盘的那条记录连带覆盖掉——final-review.md C1「PROBE 3」。
 * 这里不模拟 TaskCard/SSE，直接对着 `FocusTimer` 自己验：开始之后用新的
 * `onComplete` 重渲染，走完时必须调用新的那个，不是开始时那个。
 */
describe('FocusTimer：onComplete 走 ref，不钉死在开始那一刻', () => {
  it('倒计时开始后父组件重渲染换了新的 onComplete：走完时调用的是最新那个，不是开始时那个', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<FocusTimer minutes={1} onComplete={first} />);

    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    rerender(<FocusTimer minutes={1} onComplete={second} />);
    act(() => { vi.advanceTimersByTime(60_000); });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

/**
 * 休息（仿滴答清单番茄钟的短休息）。番茄工作法本来是「专注一段 + 歇一小段」
 * 两半，这个应用一直只有前一半：倒计时归零、记一条，然后什么都不说。
 */
describe('FocusTimer：一轮之后的休息', () => {
  /** 跑满 `minutes` 分钟。定时器每秒一跳，多跳一秒确保过了零点。 */
  const runOut = (minutes: number) => act(() => { vi.advanceTimersByTime(minutes * 60_000 + 1000); });

  it('**breakMinutes 不给就是加这个之前的行为**：走完直接回到「开始专注」', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<FocusTimer minutes={1} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    runOut(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '开始专注' })).toBeTruthy();
  });

  it('breakMinutes 是 0 也一样——0 有明确含义「不休息」', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={1} breakMinutes={0} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    runOut(1);
    expect(screen.getByRole('button', { name: '开始专注' })).toBeTruthy();
  });

  it('设了就接着走休息：出现「休息」两个字和「跳过休息」，倒计时重新开始', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={1} breakMinutes={5} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    runOut(1);

    expect(screen.getByText('休息')).toBeTruthy();
    expect(screen.getByRole('button', { name: '跳过休息' })).toBeTruthy();
    expect(screen.getByLabelText(/休息倒计时还剩 04 分 59 秒/)).toBeTruthy();
  });

  it('**专注那条记录只发一次**——休息不是专注，它结束时不该再发一条', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<FocusTimer minutes={1} breakMinutes={1} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    runOut(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    // 记的时长是专注那一段，跟休息无关。
    expect(onComplete.mock.calls[0][0].minutes).toBe(1);

    runOut(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '开始专注' })).toBeTruthy();
  });

  it('「跳过休息」当场回到「开始专注」，也不发记录', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<FocusTimer minutes={1} breakMinutes={5} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    runOut(1);
    fireEvent.click(screen.getByRole('button', { name: '跳过休息' }));
    expect(screen.getByRole('button', { name: '开始专注' })).toBeTruthy();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('**休息时锁不放**——一个番茄是专注加休息两半，歇着的时候不该在别的卡上开新的', () => {
    vi.useFakeTimers();
    render(
      <>
        <span data-testid="甲"><FocusTimer minutes={1} breakMinutes={5} onComplete={vi.fn()} /></span>
        <span data-testid="乙"><FocusTimer minutes={1} breakMinutes={5} onComplete={vi.fn()} /></span>
      </>,
    );
    fireEvent.click(within(screen.getByTestId('甲')).getByRole('button', { name: '开始专注' }));
    runOut(1);
    // 甲在休息；乙那颗「开始专注」还是禁用的。
    expect(within(screen.getByTestId('甲')).getByRole('button', { name: '跳过休息' })).toBeTruthy();
    expect(within(screen.getByTestId('乙')).getByRole('button', { name: '开始专注' }).hasAttribute('disabled')).toBe(true);
  });

  it('休息走完把锁放掉，别的卡又能开了', () => {
    vi.useFakeTimers();
    render(
      <>
        <span data-testid="甲"><FocusTimer minutes={1} breakMinutes={1} onComplete={vi.fn()} /></span>
        <span data-testid="乙"><FocusTimer minutes={1} breakMinutes={1} onComplete={vi.fn()} /></span>
      </>,
    );
    fireEvent.click(within(screen.getByTestId('甲')).getByRole('button', { name: '开始专注' }));
    runOut(1);
    runOut(1);
    expect(within(screen.getByTestId('乙')).getByRole('button', { name: '开始专注' }).hasAttribute('disabled')).toBe(false);
  });
});

/**
 * 卸载 = 放弃，**但要说一声**。「关掉页面 = 放弃」是规格定死的，可卸载不止
 * 那一种：切到日历看一眼、把密度从卡片换成行、这张卡被筛掉，都会卸载它——
 * 那几下用户并没有觉得自己在放弃什么，而那个走了十八分钟的倒计时就这么没了。
 */
describe('FocusTimer：中途被卸载', () => {
  const runOut = (minutes: number) => act(() => { vi.advanceTimersByTime(minutes * 60_000 + 1000); });

  it('专注跑到一半被卸载：调一次 onAbandon', () => {
    vi.useFakeTimers();
    const onAbandon = vi.fn();
    const { unmount } = render(<FocusTimer minutes={25} onComplete={vi.fn()} onAbandon={onAbandon} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    act(() => { vi.advanceTimersByTime(60_000); });

    unmount();

    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it('**压根没开始就卸载：不说话**——没丢任何东西', () => {
    const onAbandon = vi.fn();
    const { unmount } = render(<FocusTimer minutes={25} onComplete={vi.fn()} onAbandon={onAbandon} />);
    unmount();
    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('**自己点「取消专注」之后再卸载：不说话**——那一下是他自己按的，已经知道了', () => {
    vi.useFakeTimers();
    const onAbandon = vi.fn();
    const { unmount } = render(<FocusTimer minutes={25} onComplete={vi.fn()} onAbandon={onAbandon} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    fireEvent.click(screen.getByRole('button', { name: '取消专注' }));

    unmount();

    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('**休息那一段被卸载：不说话**——这一轮的记录在专注结束那一刻就已经发出去了，没丢东西', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    const onAbandon = vi.fn();
    const { unmount } = render(<FocusTimer minutes={1} breakMinutes={5} onComplete={onComplete} onAbandon={onAbandon} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    runOut(1);
    expect(onComplete).toHaveBeenCalledTimes(1);

    unmount();

    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('走完整整一轮（不休息）之后卸载：不说话', () => {
    vi.useFakeTimers();
    const onAbandon = vi.fn();
    const { unmount } = render(<FocusTimer minutes={1} onComplete={vi.fn()} onAbandon={onAbandon} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    runOut(1);

    unmount();

    expect(onAbandon).not.toHaveBeenCalled();
  });

  it('不给 onAbandon 也不炸——加这个之前的调用方一个字都不用改', () => {
    vi.useFakeTimers();
    const { unmount } = render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    expect(() => unmount()).not.toThrow();
  });
});

/**
 * **浏览器标签页上的倒计时**（仿滴答清单：「无需返回滴答清单，也能随时了解
 * 当前专注进度」）。
 *
 * 这件事对番茄钟是本命的：这个计时器存在的全部意义就是「你切走去干别的了」
 * ——而切走之后它在屏幕上就不存在了，想看一眼剩多久得先切回来，而切回来正是
 * 它要防的那个动作。
 */
describe('FocusTimer：写进浏览器标签页', () => {
  // **底必须由 setBaseTitle 摆出来，不能直接写 document.title。**
  // 计时器现在走 lib/pageTitle.ts 的「占用 / 交还」，交还时它回到的是那个
  // 模块里的**底**，跟 document.title 当前是什么无关。这里如果只写
  // document.title、不设底，那底就还是模块加载时的默认值「办事师爷」——
  // 跟这个常量恰好一样，于是三条还原用例会**因为巧合而绿**，把常量改成别的
  // 字符串就会红，而红的样子像计时器坏了。
  const ORIGINAL = '今天 · 办事师爷';
  const setUp = () => { setBaseTitle('今天'); };
  const start = () => fireEvent.click(screen.getByRole('button', { name: '开始专注' }));

  afterEach(() => { releaseTitle(); setBaseTitle(''); });

  it('没开始时不动标题', () => {
    setUp();
    render(<FocusTimer minutes={5} label="写周报" onComplete={vi.fn()} />);
    expect(document.title).toBe(ORIGINAL);
  });

  it('跑起来就写成「剩余时间 · 任务标题」', () => {
    vi.useFakeTimers();
    setUp();
    render(<FocusTimer minutes={5} label="写周报" onComplete={vi.fn()} />);

    start();

    expect(document.title).toBe('05:00 · 写周报');
  });

  it('每一秒都跟着走，不是只写一次', () => {
    vi.useFakeTimers();
    setUp();
    render(<FocusTimer minutes={5} label="写周报" onComplete={vi.fn()} />);
    start();

    act(() => { vi.advanceTimersByTime(61_000); });

    expect(document.title).toBe('03:59 · 写周报');
  });

  it('不给 label 就只写「专注」——这个 prop 是可选的', () => {
    vi.useFakeTimers();
    setUp();
    render(<FocusTimer minutes={5} onComplete={vi.fn()} />);
    start();
    expect(document.title).toBe('05:00 · 专注');
  });

  /**
   * **休息那一段说清是休息。** 不然「05:00」看着像专注只剩五分钟，而实际上
   * 那一轮已经走完了。
   */
  it('休息那一段写「休息」，不是任务标题', () => {
    vi.useFakeTimers();
    setUp();
    render(<FocusTimer minutes={1} breakMinutes={5} label="写周报" onComplete={vi.fn()} />);
    start();

    act(() => { vi.advanceTimersByTime(61_000); });

    // 秒数不钉死：61 秒那一刻专注刚结束、休息已经走了一格（实测 04:59）。
    // 这一条测的是**说不说「休息」**——把秒数写进断言只会让它为一拍的时序
    // 变化假红，而那一拍不是这条要守的东西。
    expect(document.title).toMatch(/^0[0-4]:\d\d · 休息$/);
    expect(document.title).not.toContain('写周报');
  });

  /**
   * **还原是这一族里最要紧的一条。** 少了它，一个走了一半被卸载的番茄钟会把
   * 标题永久钉在某个时刻上——而卸载不止「关掉页面」：切视图、换密度、这张卡
   * 被筛掉，都会卸载它（这个组件的 `onAbandon` 上面写着同一件事）。
   */
  it('点「取消专注」：标题还原', () => {
    vi.useFakeTimers();
    setUp();
    render(<FocusTimer minutes={5} label="写周报" onComplete={vi.fn()} />);
    start();
    expect(document.title).not.toBe(ORIGINAL);

    fireEvent.click(screen.getByRole('button', { name: '取消专注' }));

    expect(document.title).toBe(ORIGINAL);
  });

  it('跑到一半被卸载：标题也还原', () => {
    vi.useFakeTimers();
    setUp();
    const { unmount } = render(<FocusTimer minutes={5} label="写周报" onComplete={vi.fn()} onAbandon={vi.fn()} />);
    start();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(document.title).not.toBe(ORIGINAL);

    unmount();

    expect(document.title).toBe(ORIGINAL);
  });

  /**
   * 交还时回到的是 `lib/pageTitle.ts` 里那个**底**，不是屏幕上一秒那串时间。
   * 这条以前叫「原标题只记一次」，说的是已经删掉的快照机制；现在没有快照可
   * 过期，真正要守的是「交还之后回到底，而不是停在最后写的那串秒数」。
   */
  it('交还之后回到底，不是停在上一秒写的那串时间', () => {
    vi.useFakeTimers();
    setUp();
    render(<FocusTimer minutes={5} label="写周报" onComplete={vi.fn()} />);
    start();
    act(() => { vi.advanceTimersByTime(3_000); });

    fireEvent.click(screen.getByRole('button', { name: '取消专注' }));

    expect(document.title).toBe(ORIGINAL);
  });
});

/**
 * **正计时**（仿滴答清单跟番茄计时并列的另一档：「以正计时的方式持续记录专注
 * 时长，适合不希望被打断、希望沉浸式计时的人群」）。
 *
 * 它跟倒计时最大的不同在**结束的语义**：倒计时走完了自己记账，中途退出只有
 * 「不记」一种意思，所以一颗按钮就够；正计时**结束就是记账**，所以必须有两颗
 * ——「结束」记下来、「取消」不记。
 */
describe('FocusTimer：正计时', () => {
  const startUp = () => fireEvent.click(screen.getByRole('button', { name: '正计时' }));
  /**
   * **两个汉字的按钮要按正则找。** antd 会在两个 CJK 字符之间插一个空格
   * （「结束」渲染成「结 束」），`{ name: '结束' }` 精确匹配不上——三个字
   * 以上的（「正计时」「开始专注」）不受影响，所以这个文件里别的查询照旧。
   */
  const btn = (name: string) =>
    screen.getByRole('button', { name: new RegExp(name.split('').join('\\s*')) }) as HTMLButtonElement;

  it('闲着的时候两种开始方式并排摆着——它们是并列的两个问题，藏一个等于说它次要', () => {
    render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    expect(screen.getByRole('button', { name: '开始专注' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '正计时' })).toBeTruthy();
  });

  it('**数字往上走**，不是往下——这是它跟番茄钟唯一看得见的区别', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    startUp();
    expect(screen.getByText('00:00')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(65_000); });
    expect(screen.getByText('01:05')).toBeTruthy();
  });

  it('**不会自己结束**——沉浸式计时的全部意义就是没有那个上限', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<FocusTimer minutes={25} onComplete={onComplete} />);
    startUp();
    // 跑过一整轮番茄的时长，什么都不该发生。
    act(() => { vi.advanceTimersByTime(30 * 60_000); });
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText('30:00')).toBeTruthy();
  });

  it('点「结束」记一条，时长是真的走了多久', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<FocusTimer minutes={25} onComplete={onComplete} />);
    startUp();
    act(() => { vi.advanceTimersByTime(7 * 60_000); });
    fireEvent.click(btn('结束'));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].minutes).toBe(7);
  });

  /**
   * **不足一分钟时那颗按钮是禁用的，不是点了悄悄不记。**
   * `FocusSession.minutes` 是分钟，二十秒四舍五入是 0——一条 0 分钟的记录在
   * 统计里什么都不是，在「专注记录」那张表上还占一行。而「点下去了、什么也
   * 没发生」是这个仓库最怕的那一类。
   */
  it('不到一分钟：「结束」是禁用的，而且说得出为什么', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    startUp();
    act(() => { vi.advanceTimersByTime(20_000); });
    const stop = btn('结束');
    expect(stop.disabled).toBe(true);
    expect(stop.getAttribute('title')).toContain('不到一分钟');
  });

  it('满一分钟之后就点得动了', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    startUp();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(btn('结束').disabled).toBe(false);
  });

  it('「取消」不记——跟倒计时中途退出同一条规矩', () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<FocusTimer minutes={25} onComplete={onComplete} />);
    startUp();
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    fireEvent.click(btn('取消'));
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '正计时' })).toBeTruthy();
  });

  /**
   * **跟倒计时抢同一把锁。** 「同一时刻只有一个在跑」这条规矩不分模式——
   * 两支同时跑的话，两条专注记录的时间段会重叠，而专注统计整个建立在
   * 「这些时间段互不重叠」上。
   */
  it('正计时跑着的时候，别的卡开不了番茄钟，也开不了正计时', () => {
    vi.useFakeTimers();
    const a = render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    const b = render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    fireEvent.click(within(a.container).getByRole('button', { name: '正计时' }));

    for (const name of ['开始专注', '正计时']) {
      const el = within(b.container).getByRole('button', { name }) as HTMLButtonElement;
      expect(el.disabled, `${name} 该被挡住`).toBe(true);
    }
  });

  it('反过来也一样：番茄钟跑着的时候「正计时」是禁用的', () => {
    vi.useFakeTimers();
    const a = render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    const b = render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    fireEvent.click(within(a.container).getByRole('button', { name: '开始专注' }));
    expect((within(b.container).getByRole('button', { name: '正计时' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('结束之后锁放掉了——不然一次正计时会把全局番茄钟永久卡死', () => {
    vi.useFakeTimers();
    const a = render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    const b = render(<FocusTimer minutes={25} onComplete={vi.fn()} />);
    fireEvent.click(within(a.container).getByRole('button', { name: '正计时' }));
    act(() => { vi.advanceTimersByTime(120_000); });
    // 同样按正则找：这颗按钮在 a 那份容器里，helper 用的是全局 screen。
    fireEvent.click(within(a.container).getByRole('button', { name: /结\s*束/ }));
    expect((within(b.container).getByRole('button', { name: '开始专注' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('**标签页上写的是已经走了多久**，跟屏幕上一致——切走之后它是唯一的进度来源', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={25} label="写周报" onComplete={vi.fn()} />);
    startUp();
    act(() => { vi.advanceTimersByTime(3 * 60_000); });
    expect(document.title).toBe('03:00 · 写周报');
  });

  it('**不接休息**——滴答那边正计时也不接，而「歇五分钟」对沉浸式计时没有意义', () => {
    vi.useFakeTimers();
    render(<FocusTimer minutes={25} breakMinutes={5} onComplete={vi.fn()} />);
    startUp();
    act(() => { vi.advanceTimersByTime(120_000); });
    fireEvent.click(btn('结束'));
    // 回到闲着，不是进休息。
    expect(screen.getByRole('button', { name: '正计时' })).toBeTruthy();
    expect(screen.queryByText('休息')).toBeNull();
  });
});
