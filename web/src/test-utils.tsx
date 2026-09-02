import { ConfigProvider } from 'antd';
import type { PropsWithChildren } from 'react';
import { fireEvent, waitFor } from '@testing-library/react';
import type { Task } from './types.js';

/**
 * 关掉 antd 的动画。**测试专用**，不是产品配置。
 *
 * 跟 `test-setup.ts` 里补 matchMedia/ResizeObserver 是同一类东西：填 jsdom 的
 * 坑，不是在测什么。jsdom 不实现 CSS 过渡，`transitionend` / `animationend`
 * 永远不会派发——任何靠离场动画结束才卸载的元素，在 jsdom 里会**永久留在
 * DOM 里**。
 *
 * 现在踩到这条的是看板：它用 antd `Masonry` 排卡片，Masonry 内部是
 * `CSSMotionList`。「点了筛选，被滤掉的那张卡不在了」这条断言会失败，而真
 * 浏览器里是好的（实测：切到「已完成」，看板上只剩那一条）。
 *
 * `motion: false` 这个 token 经 ConfigProvider 的 MotionWrapper 传进 rc-motion
 * 的 context，rc-motion 读到 false 会**整个跳过动画**，元素当场卸载。注意不能
 * 靠「把动画时长设成 0」——那样事件一样不会来，还是等不到。
 *
 * 为什么不写进 `test-setup.ts`：rc-motion 的 `supportTransition` 是模块加载时
 * 就算好的常量（读 `document.createElement('div').style` 有没有 transition），
 * 并且在导入那一刻就传给了 `genCSSMotionList(supportTransition)`，事后改不动。
 * 只能从 React 树上层用 context 覆盖，所以必须包在渲染外面。
 */
export function NoMotion({ children }: PropsWithChildren) {
  return <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>;
}

/**
 * 任务卡上「编辑」「删除」收进了一颗 ⋯ 里（见 TaskCard），点它们要先开菜单。
 * 这一步在好几个测试文件里重复，抽出来——菜单的 DOM 形状是 antd 的实现细节，
 * 变了只该改这一处。
 *
 * **全部用纯 DOM 查询，不用 getByRole。** `getByRole` 会让 jsdom 现算一遍
 * 可访问性树；在 App.test.tsx 那种整棵应用的大树上，实测把测试从两位数毫秒
 * 拖到几十秒（App.test.tsx 里有一整段注释记着这件事）。按 class / textContent
 * 找不触发那一层。
 *
 * `scope`：页面上有多棵子树时限定在哪一棵里找 ⋯（比如只在「今天」面板里）。
 * `nth`：范围内有多张卡时点第几张的（从 0 数起）。
 *
 * **`label` 的联合类型只收固定的菜单项，不收清单名那种数据驱动的项**（「移动到」
 * 那一组的每一项是一个清单的名字）。把夹具里的清单名塞进这个联合，等于每加一条
 * 用别的名字的测试就要来改一次这里，而这个联合存在的意义正是「写错一个固定项的
 * 名字当场红」——两者不能兼得，数据驱动的那几项在各自的测试里自己点。
 */
export async function pickCardMenu(label: '编辑' | '删除' | '今天' | '明天' | '下周' | '去掉截止时间' | '置顶' | '取消置顶' | '创建副本' | '跳过本次', opts: { scope?: HTMLElement; nth?: number } = {}) {
  const { scope = document.body, nth = 0 } = opts;
  const triggers = [...scope.querySelectorAll('button')].filter((b) => b.textContent === '⋯');
  if (!triggers[nth]) throw new Error(`范围内只有 ${triggers.length} 颗 ⋯，取不到第 ${nth + 1} 颗`);
  fireEvent.click(triggers[nth]);
  // 菜单挂在 body 末尾的浮层里，不在 scope 里面，所以从 document 找。
  const item = await waitFor(() => {
    const hit = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((e) => e.textContent?.replace(/\s/g, '') === label);
    if (!hit) throw new Error(`菜单里没有「${label}」`);
    return hit;
  });
  fireEvent.click(item);
}

/**
 * 走完「删除」这条路：开菜单 → 点删除 → 在确认框里点掉那颗红的删除按钮。
 * 确认框是 modal.confirm，按钮跟卡片上的不在同一棵子树里，锁定弹框再找，
 * 别在整页里按文字瞎找。
 */
export async function deleteCard(opts: { scope?: HTMLElement; nth?: number } = {}) {
  await pickCardMenu('删除', opts);
  fireEvent.click(btnIn(await confirmDialog(), '删除'));
}

/** 等 modal.confirm 那个框出现并返回它。 */
export const confirmDialog = () =>
  waitFor(() => {
    const d = document.querySelector<HTMLElement>('.ant-modal-confirm');
    if (!d) throw new Error('确认框还没出现');
    return d;
  });

/**
 * 在某个范围里按中文找按钮，比对前先去掉空白。
 *
 * antd 会往「恰好两个汉字、没有图标」的按钮里插一个空格：文本是「删 除」不是
 * 「删除」。应用在 main.tsx 用 `button={{ autoInsertSpace: false }}` 关掉了这个
 * 行为，但测试直接渲染组件、不经过那层 ConfigProvider，所以在测试里它还开着。
 */
export function btnIn(scope: HTMLElement, label: string): HTMLElement {
  const hit = [...scope.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s/g, '') === label);
  if (!hit) throw new Error(`这个范围里没有「${label}」按钮`);
  return hit;
}

/**
 * `@dnd-kit` 的键盘拖拽（`KeyboardSensor` + `sortableKeyboardCoordinates`）
 * 靠 `getBoundingClientRect()` 判断「往哪个方向按能碰到下一个目标」——jsdom
 * 不算真实布局，这个方法永远返回全零的矩形，方向判断不出来，箭头键按了跟
 * 没按一样（实测过：不 mock 直接测，拖拽在 jsdom 里纹丝不动）。这里按
 * `selector` 命中的元素在文档里出现的顺序，手填一份假矩形：
 * - 不给 `columns`：一维堆叠，`vertical` 决定纵向（每个元素隔 `gap` px，
 *   今天视图的行、看板的四列用这个）还是横向。
 * - 给 `columns`：二维网格（行优先，`columns` 个一行换下一行），格宽/格高
 *   都是 `gap` px——四象限的 2×2（上下两行按重要程度、左右两列按紧急程度）
 *   用这个，1D 的横向/纵向堆叠算不出「同一列换一行」这种移动。
 *
 * **只在测试里用**——真实浏览器有真布局，这层完全不参与，产品代码不
 * import 这个函数。返回还原函数，测试结束（`afterEach`/用例内部 `finally`）
 * 要调用，不然会污染同一个文件里其它不需要它的用例。
 */
export function mockDndRects(selector: string, opts: { vertical?: boolean; gap?: number; columns?: number } = {}): () => void {
  const { vertical = true, gap = 300, columns } = opts;
  const orig = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const own = this.matches(selector) ? this : this.closest(selector);
    const all = [...document.querySelectorAll(selector)];
    const idx = own ? Math.max(all.indexOf(own), 0) : 0;
    const [left, top] = columns
      ? [(idx % columns) * gap, Math.floor(idx / columns) * gap]
      : vertical ? [0, idx * gap] : [idx * gap, 0];
    const base = { x: left, y: top, left, top, right: left + gap - 20, bottom: top + (columns ? gap - 20 : vertical ? 40 : 100), width: gap - 20, height: columns ? gap - 20 : vertical ? 40 : 100 };
    return { ...base, toJSON: () => base } as DOMRect;
  };
  return () => { Element.prototype.getBoundingClientRect = orig; };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * 一次完整的键盘拖拽：聚焦抓手 → Space 拿起 → 依次按 `keys` 里的方向键 →
 * Space 放下。**步骤之间必须让出一个宏任务**——`@dnd-kit` 的
 * `KeyboardSensor` 用 `setTimeout(0)` 延迟挂真正的 keydown 监听器（避免
 * 抓取到激活自己的那次按键），同步连续 `fireEvent` 的话，后续按键会在
 * 监听器挂上之前就已经派发完，`@dnd-kit` 读不到（实测踩过：不 await 直接
 * 连续 fire，`onDragEnd` 永远不会触发）。`keys` 传 `code`（`'ArrowRight'`
 * 这种），不传就是「拿起来立刻放下」（用来测「拖回原地」那条守卫）。
 */
export async function keyboardDrag(handle: HTMLElement, keys: string[] = []): Promise<void> {
  handle.focus();
  fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
  await tick();
  for (const code of keys) {
    fireEvent.keyDown(handle, { code, key: code });
    await tick();
  }
  fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
  await tick();
}

/**
 * 真的按一次 Tab（复审修复轮 1 · I4）——**jsdom 不实现浏览器的 Tab 键焦点
 * 移动**：那是渲染引擎自己的行为，不是哪个 JS 事件处理器响应了
 * `keydown{key:'Tab'}` 才发生的，`fireEvent.keyDown(el, {key:'Tab'})` 在
 * jsdom 里只是派发一个事件，不会真的挪动 `document.activeElement`——早前
 * 这个仓库的拖拽测试测「Tab 到抓手」全部改用了 `handle.focus()` 或者先
 * `fireEvent.mouseEnter` 让抓手出现再直接聚焦它，跳过了「它是不是真的排在
 * 正向 Tab 顺序里」这个问题本身，被复审点名——用例名字写着「Tab」，断言却
 * 没有真的验证 Tab 顺序。
 *
 * 这里按浏览器默认 Tab 顺序里最常见、也是这个仓库目前唯一用到的那一种
 * 情况实现：**没有任何元素使用正的 `tabindex`**（`tabindex` 要么是 `0`
 * 要么缺省，都归入同一优先级），退化成「按 DOM 顺序」——这正是原生
 * `<button>`、`useDraggable`/`useSortable` 给的 `tabIndex: 0` 共同满足的
 * 前提，不需要再实现 `tabindex > 0` 优先排前面那一层更复杂的规则
 * （ponytail：够用就好，这个仓库到目前为止没有任何地方用正的 tabindex，
 * 真的用上那一层再补）。`disabled`/`tabIndex === -1`/隐藏的元素直接排除。
 * 从 `document.activeElement` 在这份列表里的下标 +1 开始找下一个，不在
 * 列表里（比如当前聚焦在 `<body>`）就从头找第一个。
 *
 * **不靠 `offsetParent`/`getBoundingClientRect` 判断「看不看得见」**——
 * jsdom 不做布局，`offsetParent` 对任何元素永远返回 `null`（实测过），
 * 拿它当「隐藏」的判据会把这个仓库里所有元素都判成隐藏，`pressTab` 会
 * 整个失灵。这份代码库里「隐藏」只有一种真正的形状：条件渲染，元素压根
 * 不进 DOM（`.ink-trow-more` 那类）——那种天然被 `querySelectorAll` 排除，
 * 不需要另外过滤；`opacity: 0`（`.ink-trow-handle-hidden` 那类，I4 这次
 * 特意选的正是「视觉藏起来但 Tab 摸得到」）必须留在这份列表里，不能被
 * 误当成「隐藏」滤掉。
 */
export function pressTab(scope: ParentNode = document): void {
  const FOCUSABLE = 'button, [tabindex], input, a[href], select, textarea';
  const nodes = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1,
  );
  const cur = document.activeElement;
  const idx = cur instanceof HTMLElement ? nodes.indexOf(cur) : -1;
  const next = nodes[idx + 1];
  next?.focus();
}

/**
 * FullCalendar 的月格（CalendarFull.tsx，task-5）走它自己的指针交互引擎
 * （PointerDragging → FeaturefulElementDragging → HitDragging → 具体的
 * Interaction 类：DateClicking / EventDragging / MoreLinkClicking），不是
 * 原生 HTML5 drag/drop——`fireEvent.dragStart/dragOver/drop` 那一套在这里
 * 完全用不上，得用 mousedown/mousemove/mouseup 模拟真实指针，这条踩了很久
 * 才趟出来，见 task-5-report.md「依赖四问」那节。
 *
 * 这套引擎在 jsdom 下有两个硬需求，缺一个整条交互链路都不会跑，实测确认过：
 * ① `document.elementFromPoint`——jsdom 压根没实现这个方法（不是「行为不
 *   对」，是调用就抛 `TypeError: ... elementFromPoint is not a function`），
 *   每次 pointerdown/pointermove 的 hit-test（点在哪个格子上）都要调它。
 * ② `Element.getBoundingClientRect`——jsdom 不算布局，默认全零矩形，
 *   FullCalendar 拿它换算「这个坐标落在哪一列」，全零矩形换算出来的位置
 *   全部重叠在原点，hit-test 会失败或者失真。
 * 两者都要有，`dateClick`/`eventDrop`/`moreLinkClick` 才会真的触发，跟
 * `mockDndRects`（上面，给 `@dnd-kit` 用）是同一类必要的 jsdom 补丁，只是
 * 补的是不同的库、不同的 API。
 *
 * 把 42 个格子摆成 7 列 × 6 行、每格 `cell` px 的网格，`getBoundingClientRect`
 * 按「离它最近的 `.fc-daygrid-day` 祖先在这套假网格里的位置」返回矩形
 * （够不到格子的其它元素给一个足够大的兜底矩形，覆盖住整个 7×6 网格），
 * `elementFromPoint` 反过来按坐标换算该落在哪个格子。两者必须在 `render()`
 * 之前装好——FullCalendar 挂载时会做一次列宽相关的初始测量并缓存，测量用的
 * 是当时的 `getBoundingClientRect`，`render()` 之后再装的话缓存的还是全零
 * 矩形，测过一次就晚了（实测过这个顺序问题：先 render 再装，点选和拖拽都
 * 测不出来）。
 *
 * 返回还原函数，用法跟 `mockDndRects` 一样：测试结束要调用，不然会污染同一
 * 个文件里排在后面的用例。
 *
 * **task-6 修复轮 1（复审 C1/I1）：上一版这里的注释是错的，逐条记一下纠正
 * 过程，别再犯同一种「没验过的假设当成事实」**——
 *
 * 上一版声称"周/日视图小时槽的坐标缓存（`colCoords`）靠 `ResizeObserver`
 * 驱动的 `clientWidth`，这个仓库的 `ResizeObserver` 是空壳，回调永不触发，
 * 所以 `colCoords` 永远建不出来，小时槽点/拖测不出来"——**`grep -r
 * ResizeObserver node_modules/@fullcalendar/` 是 0 处命中**，FullCalendar
 * 6.1.21 压根不用这个 API。`clientWidth` 真正的来源是
 * `SimpleScrollGrid.handleSizing()`（`componentDidMount` 里直接同步调用
 * 一次，`this.context.addResizeHandler(this.handleSizing)` 订阅窗口
 * resize 事件做后续更新，不是 `ResizeObserver`），读的就是
 * `getBoundingClientRect().width`——这个函数原本给的假矩形早就能喂饱它。
 *
 * **真正的卡点（I1）**：这个函数只垫了 `offsetHeight`，没垫 `clientHeight`。
 * FullCalendar 算"这个容器有没有滚动条挡住内容"用的是
 * `computeScrollbarWidthsForEl(el) = { x: el.offsetHeight -
 * el.clientHeight, y: el.offsetWidth - el.clientWidth }`（`internal-
 * common.js`，`computeEdges()` 里调用，结果被当成 `scrollbarBottom` 从
 * clipping 矩形的下边界里扣掉）。jsdom 里 `clientHeight` 对任何元素恒为
 * `0`——只垫 `offsetHeight: 960` 会让 `x` 算出 `960 - 0 = 960`，每一层
 * clipping 祖先的可用矩形因此凭空缩掉 960px 高度，`OffsetTracker.
 * isWithinClipping()` 对 timeGrid 那片区域（Y 坐标动辄大几百）的坐标
 * 恒判定"不在裁剪范围内"，`HitDragging` 因此从不把命中判定真的派发给
 * `TimeCols.queryHit`——不是"建不出坐标缓存"，是坐标缓存建好了，命中判定
 * 那一步在更早的地方就把它挡在外面了。补一份跟 `offsetHeight` 数值相同的
 * `clientHeight`（`x` 算出 `0`，没有虚假的滚动条宽度）之后，`TimeCols`
 * 的命中判定完全走得通，实测（探针）：`PositionCache.leftToIndex`/
 * `topToIndex` 各调用 16 次，拖拽落点精确落在测试坐标算出来的那一格
 * （比全天带的约 1 格系统漂移更准——时间轴的事件块给了它自己那一格的
 * 矩形当碰撞基准，不会被 `useSubjectCenter` 拖偏）。
 * ⚠️ **这句"精确"的射程要说清楚**：`elementFromPoint`/`getBoundingClientRect`
 * 在这套假布局里是硬映射——`colIdx * cell` 这套矩形公式既用来喂给
 * FullCalendar 的命中判定，也用来给 `fcSlotPoint`（下面）生成测试坐标
 * （格子正中心），两边用的是**同一个公式**。这验证的是"`CalendarFull`
 * 正确地把 FullCalendar 内部命中管线算出的列/小时转发给了 `onDropOnSlot`"，
 * **不是**"FullCalendar 在真实浏览器的像素噪声/亚像素舍入下有多鲁棒"——
 * 任何手写假布局都得这样构造坐标，不算造假，但下结论时用词要对。
 *
 * ⚠️ **`offsetHeight`/`clientHeight` 这两个垫片数值的容错比想象中松**：
 * 复审二分过阈值——两者差值在 560 以内命中判定照样全绿，差到 640 才开始
 * 出现红。这里两个垫片凑巧都写成 960（差值 0），属于"用对了但没卡到
 * 刚好卡住"的那种精确，不是"精确验证了这个差值必须是 0"——真正兜住
 * 回归的是变异测试本身（把 `clientHeight` 整个删掉，差值变成 960，
 * 落在会红的那一侧），不是这两个数字本身的巧合。
 *
 * **修复**：① 给 `Element.prototype.clientHeight` 也垫一份跟
 * `offsetHeight` 相同的值（960）；② 给 `.fc-timegrid-col`（不含
 * `.fc-timegrid-axis`）、`.fc-timegrid-slots` 里的每一行（`slatCoords` 的
 * els）、timeGrid 的三个根容器（`.fc-timegrid-body`/`-cols`/`-slots`）、
 * 以及事件块自己（挂在它所在的列 + 自己的内联 `top` 样式上，避免碰撞
 * 校准把落点拖偏）各配一套不跟 dayGrid 网格重叠的假矩形——摆在
 * `dayGrid` 那 6 行网格正下方（`TG_TOP = cell * 8`，留出安全间距），
 * `elementFromPoint` 按 Y 坐标是否越过 `TG_TOP` 二选一路由到 dayGrid 格子
 * 还是 timeGrid 列。全天带（`.fc-daygrid-day`，这个函数原本覆盖的范围）
 * 完全不受影响，两套矩形互不重叠。
 */
/** timeGrid 假矩形的 Y 轴起点——跟 `installFullCalendarFakeLayout` 内部
 *  用的同一个换算，`fcSlotPoint`/`fcTimeGridDrag` 复用它，两处不能各自
 *  写一份数字（漂开就是新一轮 118/123/124 那个坑）。 */
const TIMEGRID_TOP = (cell: number) => cell * 8;
/** 时间轴每小时槽的高度——跟 `theme.css` 的 `.fc-timegrid-slot { height:
 *  40px }` 同一个数字，纯粹是假布局内部自洽用的常量，真实布局不依赖它。 */
const TIMEGRID_SLOT_H = 40;

export function installFullCalendarFakeLayout(cell = 100): () => void {
  const origRect = Element.prototype.getBoundingClientRect;
  const origElementFromPoint = document.elementFromPoint;
  const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const origClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return 960; },
  });
  // 关键修复（I1）：跟 offsetHeight 配对，见上面的长注释——只垫 offsetHeight
  // 会让 computeScrollbarWidthsForEl 算出一条假的 960px「滚动条」，把每层
  // clipping 祖先的可用矩形凭空缩掉这么多，timeGrid 区域的坐标恒判定为
  // 「裁剪范围外」。
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get() { return 960; },
  });

  // timeGrid 假矩形摆在 dayGrid 6 行网格（Y: 0-6*cell）正下方，留两格
  // 安全间距，两套矩形永不重叠。TG_TOP/SLOT_H 是模块级常量，`fcSlotPoint`/
  // `fcTimeGridDrag`（下面）用同一份，不各自维护一份数字。
  const TG_TOP = TIMEGRID_TOP(cell);
  const SLOT_H = TIMEGRID_SLOT_H;
  const timeCols = () => [...document.querySelectorAll('td.fc-timegrid-col')].filter((c) => c.hasAttribute('data-date'));
  const slatRows = () => [...document.querySelectorAll('.fc-timegrid-slots tr')];
  const rect = (left: number, top: number, right: number, bottom: number) => ({
    x: left, y: top, width: right - left, height: bottom - top,
    top, left, right, bottom, toJSON() { return {}; },
  }) as DOMRect;

  Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const cellEl = this.closest('.fc-daygrid-day') as HTMLElement | null;
    if (cellEl) {
      const cells = [...document.querySelectorAll('.fc-daygrid-day')];
      const idx = cells.indexOf(cellEl);
      const col = idx % 7;
      const row = Math.floor(idx / 7);
      const left = col * cell;
      const top = row * cell;
      return rect(left, top, left + cell, top + cell);
    }
    // 时间轴列（colCoords 的 els）——每列一份独立矩形，24 小时槽高。
    const colIdx = timeCols().indexOf(this);
    if (colIdx >= 0) return rect(colIdx * cell, TG_TOP, colIdx * cell + cell, TG_TOP + 24 * SLOT_H);
    // 小时行（slatCoords 的 els）——每行一份独立矩形。
    const slatIdx = slatRows().indexOf(this);
    if (slatIdx >= 0) return rect(0, TG_TOP + slatIdx * SLOT_H, 7 * cell, TG_TOP + (slatIdx + 1) * SLOT_H);
    // timeGrid 的三个根容器：跟整片时间轴区域同一个坐标原点。
    if (this.classList?.contains('fc-timegrid-body')
      || this.classList?.contains('fc-timegrid-cols')
      || this.classList?.contains('fc-timegrid-slots')) {
      return rect(0, TG_TOP, 7 * cell, TG_TOP + 24 * SLOT_H);
    }
    // 事件块自己：落在它所在的那一列 + 它自己的内联 top 样式（不是列的
    // 整个矩形）——不这样做的话 FullCalendar 拖拽开始时用于碰撞校准的
    // `useSubjectCenter` 会拿事件块的矩形跟命中格的矩形取交集再重新定位
    // 拖拽起点，事件块矩形如果等于整列（24 小时高）会把落点算歪。
    const evHost = this.closest('.fc-timegrid-event-harness') as HTMLElement | null;
    if (evHost) {
      const host = evHost.closest('td.fc-timegrid-col') as HTMLElement | null;
      const ci = host ? timeCols().indexOf(host) : 0;
      const top = TG_TOP + parseFloat(evHost.style.top || '0');
      return rect(ci * cell, top, ci * cell + cell, top + SLOT_H);
    }
    // 兜底：给 `.fc`/`.fc-view-harness`/`.fc-scroller`/`.ink-cal-timegrid`
    // 这些没有专门分支的祖先容器一个够用的矩形，别让它们把 dayGrid 或
    // timeGrid 任何一片区域裁掉。
    // ⚠️ **这个数字不能随便改大**（实测过，不是猜的）：`OffsetTracker.
    // isWithinClipping` 用的裁剪矩形要经过 `computeScrollbarWidthsForEl`
    // 扣掉一份"滚动条宽度"（`offsetHeight - clientHeight`，见上面
    // `clientHeight` 那道垫片的注释）——`clientHeight` 垫成 960 时这个值是
    // 0（不扣），但如果这道垫片将来被误删/漏加，这个值会变成 960，从
    // 兜底矩形的下边界凭空削掉 960px。改成 2000（不是更保险的一个大数字，
    // 比如最初图省事写的 10000）就是为了让这类回归**测得出来**：`TG_TOP +
    // 24 * SLOT_H = 800 + 960 = 1760`，`2000 - 960 = 1040 < 1760`，
    // `clientHeight` 那道垫片一旦失效，timeGrid 区域的坐标会真的落到裁剪
    // 范围外、命中判定失败、拖拽测试会红——这道兜底矩形本身也是这个模块的
    // 一部分回归防线，不是随手写的占位数字（这条踩过一次：最初写 10000 时
    // 用变异测试验证 `clientHeight` 垫片的必要性，10000 - 960 = 9040 还是
    // 远大于 1760，把 I1 那个修复的必要性完全测不出来——改小之后重打同一个
    // 变异，4 条测试真的红了）。
    return rect(0, 0, 2000, 2000);
  };
  document.elementFromPoint = ((x: number, y: number) => {
    if (y >= TG_TOP) {
      const cols = timeCols();
      return cols[Math.floor(x / cell)] ?? null;
    }
    const col = Math.floor(x / cell);
    const row = Math.floor(y / cell);
    const cells = [...document.querySelectorAll('.fc-daygrid-day')];
    return cells[row * 7 + col] ?? null;
  }) as typeof document.elementFromPoint;
  return () => {
    Element.prototype.getBoundingClientRect = origRect;
    document.elementFromPoint = origElementFromPoint;
    if (origClientHeight) Object.defineProperty(Element.prototype, 'clientHeight', origClientHeight);
    if (origOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', origOffsetHeight);
  };
}

/** 格子中心点的假坐标——跟 `installFullCalendarFakeLayout` 用同一套「7 列、
 *  每格 `cell` px」换算。 */
export function fcCellCenter(idx: number, cell = 100) {
  return { x: (idx % 7) * cell + 50, y: Math.floor(idx / 7) * cell + 50 };
}

/** 点选（不是拖拽）：mousedown + mousemove（原地）+ mouseup。`minDistance`
 *  对点选类交互（DateClicking）是 0，不需要真的移动就能触发，但
 *  `mirror.stop()` 的收尾是异步的（内部 `setTimeout(fn, 0)`），所以调用方
 *  要 `await waitFor(...)`，不能同步断言结果。 */
export function fcClickCell(el: Element, point: { x: number; y: number }): void {
  const opts = { button: 0, clientX: point.x, clientY: point.y };
  fireEvent.mouseDown(el, opts);
  fireEvent.mouseMove(document, opts);
  fireEvent.mouseUp(document, opts);
}

/**
 * 拖拽：mousedown 在源格中心 → 10 步移动到目标格中心 → 目标格再停 4 帧 →
 * mouseUp。两个数字都是实测出来的，不是随便定的：
 * - 10 步移动：FullCalendar 的 `eventDragMinDistance` 默认 5px，一次性从
 *   src 跳到 dst（哪怕跨了好几格）反而不触发——`FeaturefulElementDragging`
 *   要通过一次真正超过阈值的 `pointermove` 才会把 `isDistanceSurpassed`
 *   置真，只有 mousedown 那一下不够。
 * - 目标格再停 4 帧：最后一两次移动偶尔会因为坐标换算的舍入误差落空
 *   （`HitDragging.queryHitForOffset` 返回 null），`EventDragging.
 *   handleHitUpdate` 在 `isFinal` 的最后一次不会再更新 `validMutation`
 *   （只有非 final 的 hitupdate 才写），所以真正生效的是「最后一次成功
 *   算出格子的那次 hitupdate」，不是「移动到的最后一个坐标」——多停几帧
 *   让它有机会稳定收敛到目标格，不稳定的话会读到更靠前经过的格子。
 *
 * 这套推导过程见 task-5-report.md「依赖四问」——先用一次性跳转、不停帧，
 * `eventDrop` 完全不触发；一层层加 `elementFromPoint`/`getBoundingClientRect`
 * /多步移动/停帧，每加一层都用临时的 console.log 探针确认到底卡在哪个内部
 * 环节（`HitDragging.handlePointerDown`→`EventDragging.handlePointerDown`→
 * `tryStartDrag`→`handleMove`→`handleHitUpdate`→`handleDragEnd`），不是靠猜。
 *
 * `towardIdx` 是「往哪个方向拖」，不是「精确落在哪一格」——这套假布局的坐标
 * 换算跟 FullCalendar 内部的 `useSubjectCenter` 校准逻辑不是完全同一个坐标
 * 系，实测会有大约一格的系统性偏移（真实浏览器里像素连续，不会有这层因为
 * 「格子矩形是手写死数字」带来的跳变）。调用方要断言「落到了具体哪一天」的
 * 话，读 `eventDrop`/`onDropOnDay` 回调实际收到的那个 key，不要假设它一定
 * 等于 `towardIdx` 对应的那天。
 */
export function fcDragEvent(eventEl: Element, fromIdx: number, towardIdx: number, cell = 100): void {
  const src = fcCellCenter(fromIdx, cell);
  const dst = fcCellCenter(towardIdx, cell);
  fireEvent.mouseDown(eventEl, { button: 0, clientX: src.x, clientY: src.y });
  for (let i = 1; i <= 10; i++) {
    const x = src.x + (dst.x - src.x) * (i / 10);
    const y = src.y + (dst.y - src.y) * (i / 10);
    fireEvent.mouseMove(document, { clientX: x, clientY: y });
  }
  for (let i = 0; i < 4; i++) {
    fireEvent.mouseMove(document, { clientX: dst.x, clientY: dst.y });
  }
  fireEvent.mouseUp(document, { button: 0, clientX: dst.x, clientY: dst.y });
}

/** 时间轴（周/日视图，`installFullCalendarFakeLayout` 里 timeGrid 那半）
 *  某一列某一小时格中心点的假坐标——`colIdx` 是第几列（0 起），`hour` 是
 *  第几小时（0-23）。跟 `fcCellCenter` 是同一类换算，只是坐标系不同
 *  （dayGrid 是 7×6 平铺，timeGrid 是 7 列 × 24 小时，且整片摆在
 *  dayGrid 网格下方）。 */
export function fcSlotPoint(colIdx: number, hour: number, cell = 100) {
  return { x: colIdx * cell + cell / 2, y: TIMEGRID_TOP(cell) + hour * TIMEGRID_SLOT_H + TIMEGRID_SLOT_H / 2 };
}

/** 时间轴版的 `fcDragEvent`——同一套「10 步移动 + 停 4 帧」手法（见
 *  `fcDragEvent` 的长注释，两者共用同一个推导过程），只是起点/终点用
 *  `fcSlotPoint` 换算（列 + 小时），不是 `fcCellCenter`（42 格里的下标）。
 *  时间轴这边事件块的假矩形挂在它自己那一格上（不是整列），碰撞校准不会
 *  把落点拖偏——实测拖拽精确落在 `fcSlotPoint` 算出的那一格，比全天带/
 *  月格约一格的系统性偏移更准，调用方可以直接断言「精确落在哪一格」，
 *  不用像 `fcDragEvent` 那样退回「只断言往哪个方向拖」。
 *  ⚠️ 这个"精确"是假布局的坐标映射保证的（`getBoundingClientRect`/
 *  `elementFromPoint` 跟 `fcSlotPoint` 用同一个 `colIdx * cell` 公式），
 *  验证的是「`CalendarFull` 正确转发了命中结果」，不是「FullCalendar
 *  在真实像素噪声下有多鲁棒」——见 `installFullCalendarFakeLayout` 头顶
 *  长注释里对这句话的详细说明。 */
export function fcTimeGridDrag(eventEl: Element, from: { colIdx: number; hour: number }, to: { colIdx: number; hour: number }, cell = 100): void {
  const src = fcSlotPoint(from.colIdx, from.hour, cell);
  const dst = fcSlotPoint(to.colIdx, to.hour, cell);
  fireEvent.mouseDown(eventEl, { button: 0, clientX: src.x, clientY: src.y });
  for (let i = 1; i <= 10; i++) {
    const x = src.x + (dst.x - src.x) * (i / 10);
    const y = src.y + (dst.y - src.y) * (i / 10);
    fireEvent.mouseMove(document, { clientX: x, clientY: y });
  }
  for (let i = 0; i < 4; i++) {
    fireEvent.mouseMove(document, { clientX: dst.x, clientY: dst.y });
  }
  fireEvent.mouseUp(document, { button: 0, clientX: dst.x, clientY: dst.y });
}

/** 任务夹具。本仓库里已经有六份同样的拷贝散在各个测试文件里——新测试一律用
 *  这一份，别再抄第七份。搬走那六份是另一件事，不在这一批。 */
export const task = (p: Partial<Task> = {}): Task => ({
  id: 't1', title: '写周报', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
  reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  order: null, listId: null, section: null, tags: [], priority: 0, repeat: null,
  completedAt: null, postponeCount: 0, waitingFor: null, context: null,
  attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...p,
});
