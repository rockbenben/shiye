/**
 * 全局键盘事件 → 动作的纯翻译层。见 task-1-brief.md。
 *
 * 只负责「这个事件该翻成哪个动作」，不挂监听、不 `preventDefault`——那是
 * 后面挂钩子的 Task 的事。这里是纯函数，好测、也好复用到命令面板。
 */

import type { RescheduleTo } from './reschedule.js';

export type KeyAction =
  | { kind: 'new' } // N —— 随手记，往收件箱里丢一段话
  | { kind: 'compose' } // C —— 「新任务」表单（带智能识别），见 App.tsx 那两个入口的注释
  | { kind: 'search' } // /
  | { kind: 'view'; index: number } // 1..9 → 导航上第 index 个（从 0 起）
  | { kind: 'palette' } // Ctrl/Cmd+K
  | { kind: 'edit' } // E —— 选中恰好一张卡时进入它的编辑态，见 2026-08-17-selection.md Task 4
  | { kind: 'delete' } // Delete（只收这一个，不收 Backspace——它在浏览器里有历史包袱）
  | { kind: 'done' } // D —— 把选中的几条标成已完成
  | { kind: 'due'; to: RescheduleTo } // T / M / W —— 把选中的几条改到今天 / 明天 / 下周
  | { kind: 'help' } // ? —— 弹出快捷键一览，仿滴答清单（它那边也是 ?）
  | { kind: 'escape' }; // Esc

/** 只读事件需要的那几个字段——测试里好造，也不依赖真 DOM 事件。 */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  /** 事件源是不是输入框（`<input>`/`<textarea>`/contenteditable）。 */
  inField?: boolean;
  /**
   * 已废弃但在「输入法正在吃这个键」这件事上仍是最可靠信号之一的老属性：
   * 输入法组字期间，Windows Chrome 报的 keyCode 是 229，跟 `key` 实际是什么
   * 字符无关（个别浏览器/输入法组合下 `key` 已经是真实字符，keyCode 照样是
   * 229）。见下面 keyAction 里的用法。
   */
  keyCode?: number;
}

export function keyAction(e: KeyLike): KeyAction | null {
  // 中文输入法组字中，keydown 照样触发（key 可能是 'Process' 或实际字符）。
  // 组字中连 Esc 都不放行——那一下是取消组字，不是关面板。这是两道守卫里的
  // 第一道，第二道是下面的 inField；isComposing 在个别输入法/浏览器组合下
  // 不可靠，两道都要才顶得住。
  if (e.isComposing) return null;
  // 第三道、老办法：keyCode 229 是输入法正在吃这个键的信号，跟 isComposing
  // 时序不同——不依赖 compositionstart 有没有来得及派发，覆盖的正是
  // isComposing 在组字第一个 keydown 上必然是 false 的那一刻。
  if (e.keyCode === 229) return null;

  // Ctrl/Cmd+K：唯一带修饰键、且输入框里也认的分支——带修饰键天然不跟打字冲突。
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    return { kind: 'palette' };
  }

  // Esc 是输入框里的第二个例外：「从输入框退出来」。
  if (e.key === 'Escape') return { kind: 'escape' };

  // 剩下的（新建/搜索/切视图）不认任何修饰键，输入框里一律不触发。
  if (e.inField || e.ctrlKey || e.metaKey || e.altKey) return null;

  if (e.key === 'n' || e.key === 'N') return { kind: 'new' };
  // **建任务的另一条路一直没有键。** `N` 走的是「随手记」——往收件箱丢一段话、
  // 等 AI 拆（默认 60 秒）；而「已经知道自己要做什么」的时候该走的是「新任务」
  // 表单，标题里写「明天下午两点交周报 #工作」当场就成一条任务（`smartInput`）。
  // 键盘上快的那一个通向慢的那条路，反过来了。用 `C`（compose/create）：`N`
  // 被随手记占着，而 `Shift+N` 跟大写锁定下的 `N` 分不干净。
  if (e.key === 'c' || e.key === 'C') return { kind: 'compose' };
  if (e.key === 'e' || e.key === 'E') return { kind: 'edit' };
  // 只收 'Delete'，不收 'Backspace'：后者在浏览器里是「返回上一页」的历史
  // 包袱（没有输入框接住的时候），批量删除不该借这个键。
  if (e.key === 'Delete') return { kind: 'delete' };
  // 「完成」是这个应用里最高频的一步，而键盘上一直没有它——编辑（E）和删除
  // （Delete）都有，唯独最常做的那件事要用鼠标点。用 `D`（done）不用空格：
  // 空格在页面上是「往下翻一屏」，抢过来会让整页失去滚动。
  if (e.key === 'd' || e.key === 'D') return { kind: 'done' };
  // 改期三档，跟卡片 ⋯ 里那组、批量操作条那组是同一套语义（`reschedulePatch`）。
  // T = today，M = tomorrow，W = week。**没有「去掉截止时间」那一档**：
  // 它在这三个里是唯一不可逆的一步（原来那个日期没别处记着），不该只隔着
  // 一个误触。
  if (e.key === 't' || e.key === 'T') return { kind: 'due', to: 'today' };
  if (e.key === 'm' || e.key === 'M') return { kind: 'due', to: 'tomorrow' };
  if (e.key === 'w' || e.key === 'W') return { kind: 'due', to: 'nextWeek' };
  if (e.key === '/') return { kind: 'search' };
  // `?` 在美式键盘上是 Shift + `/`。**不能顺手写成「shiftKey && key === '/'」**：
  // `e.key` 报的已经是上档字符 `?`，而别的布局（法/德键盘）按出 `?` 用的根本
  // 不是 Shift+/。认字符本身，不认怎么按出来的——上面那几个分支挡掉了
  // ctrl/meta/alt，没挡 shift，正是为了让这一支收得到。
  if (e.key === '?') return { kind: 'help' };
  if (e.key.length === 1 && e.key >= '1' && e.key <= '9') {
    return { kind: 'view', index: e.key.charCodeAt(0) - 49 };
  }

  return null;
}

/**
 * 判「这个事件的目标落在一个可交互元素上」——input/textarea/contenteditable
 * 三种基础判据，外加调用方按需追加的选择器（比如 Task 3 卡片选中要多挡
 * `button, a`：点在按钮/链接上不该触发选中）。**两处判断共用这一个函数，
 * 不重开第二份选择器**——见 task-2-brief「Step 1: 先读」。
 *
 * contenteditable 用属性选择器 `[contenteditable]:not([contenteditable="false"])`
 * 不用 `target.isContentEditable`：jsdom 29 没实现这个 DOM 属性（实测），用它
 * 会让测试里现造的 contenteditable 节点永远判 false。
 */
export function isInteractiveTarget(target: EventTarget | null, extra = ''): boolean {
  // `select` 也算「在打字」：原生下拉框展开时按字母是首字母定位（type-ahead），
  // 那个按键同时会冒到 window 的 keydown 上。漏了它，批量条里那个选清单的下拉
  // 里按 `d` 定位到「读书」，`d` 同时把选中的三条任务全标成已完成——从一个
  // 还开着的下拉框里。同一个洞在分组栏、任务字段的清单选择、日历模式、
  // 专注统计的选择器上都有。
  const base = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  const selector = extra ? `${base}, ${extra}` : base;
  return target instanceof HTMLElement && target.closest(selector) !== null;
}

/** 从一个 DOM 事件里读出 `KeyLike`——`inField` 的判定在这里，单独可测。 */
export function toKeyLike(e: KeyboardEvent): KeyLike {
  const target = e.target;
  // input/textarea/contenteditable 三种都用一个选择器判——contenteditable
  // 区域打字时 keydown 的 target 可能是里面某个子节点，closest 一并接住。
  const inField = isInteractiveTarget(target);
  return {
    key: e.key,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    isComposing: e.isComposing,
    inField,
    keyCode: e.keyCode,
  };
}

/**
 * 编辑表单里这一下键盘是什么意思——**保存 / 取消 / 不管**。
 *
 * 跟上面 `keyAction` 分开：那份回答的是「整页范围内这个键是哪条命令」，输入框
 * 里几乎一律不认；这份专门回答输入框**里面**的事，两者的判据方向相反，合成
 * 一个会变成一堆互相排除的分支。
 *
 * **共用的是那三道输入法守卫**（`isComposing` / `keyCode === 229`）。这在这里
 * 比在 `keyAction` 里还要紧：中文输入法按回车是**上屏候选词**，不是「我写完了」
 * ——漏了这道，打「明天交周报」在选词那一下就把表单存了。
 *
 * `plainEnter` 只给单行标题框开：备注是多行文本框，那里的回车永远是换行
 * （`TaskFields` 里那条注释：「不能因为多了个菜单就变得看情况」，多了个保存
 * 快捷键同理），要保存按 Ctrl/Cmd + 回车。
 */
export type FormKey = 'submit' | 'cancel';

export function formKey(e: KeyLike, opts: { plainEnter?: boolean } = {}): FormKey | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'Escape') return 'cancel';
  if (e.key !== 'Enter') return null;
  if (e.ctrlKey || e.metaKey) return 'submit';
  return opts.plainEnter ? 'submit' : null;
}
