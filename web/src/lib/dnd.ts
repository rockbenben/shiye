import { useEffect } from 'react';

/**
 * 被拖的那张卡/那一行在拖动中途从数据里消失了（SSE 把它标成完成/删了/被
 * /expand 合并、提醒触发……都可能）——**实测过**：`@dnd-kit` 自己的
 * `active`/`over` 不会因为底下那个 DOM 节点卸载就自动清空，而且
 * `KeyboardSensor` 在「已经有一个 active」的状态下不会响应任何新的 Space
 * 拿起（它的 `activator` 只认 `event.target === active.activatorNode.current`，
 * 消失的那个节点已经不在文档里，新按下的抓手打不中它，会话却还占着——
 * 用户看到的是「按 Space 没反应」，`.ink-row-dragging`/`.ink-grid-section-over`
 * 这类高亮也会卡死在最后所在的位置，见 task-3-report.md 修复轮 1）。
 *
 * **修法是让 `@dnd-kit` 收到一次它自己认的取消信号，不是卸载任何 DOM
 * 节点**：`Escape` 是 `KeyboardSensor` 自己监听的取消键
 * （`keyboardCodes.cancel`，监听器挂在 `document` 上，不挂在具体某个抓手
 * 节点上，节点消失不影响它继续收事件），程序化派发同一个按键事件，让
 * `@dnd-kit` 走它自己已经验证过、真实 Escape 也会走的那条取消路径
 * （`onDragCancel` 会正常触发）——调用方借着这个回调把自己那份
 * `activeDragId` state 清掉即可。
 *
 * **这条路只处理键盘拖拽卡死这一种情况**：指针（鼠标/触屏）拖拽的
 * `pointerup`/`pointercancel` 监听挂在 `document` 上，节点消失不影响这些
 * 事件继续正常触发，会话本身能自愈，不需要这里插手。
 *
 * 早前一版实现（TaskGrid.tsx 独有，只对看板/四象限生效）**发现即用
 * `key` 强制重挂整棵 `DndContext` 子树**——这个办法能让卡死的高亮消失，
 * 但代价是把 `DndContext` 底下的每一张卡（包括拖拽目标之外、没有任何
 * 问题的其它卡）连同它们各自的本地 state（比如 `TaskCard.tsx` 正在编辑
 * 但还没保存的草稿）一起卸载重挂——复审实测过：拖拽进行中 + 同一格里另一张
 * 卡正编辑到一半 + 被拖的那张卡消失 → 那张编辑中的卡的草稿被整个清空。
 * 这个函数不重挂任何东西，只发一个键盘事件，不会波及任何组件的本地 state。
 *
 * **`bubbles` 必须是 `false`。** `App.tsx` 全局也挂了一个 `keydown` 监听器，
 * 但挂在 `window` 上（不是 `document`），冒泡阶段才会摸到；它的 Escape 分支
 * 不看 `e.target`，直接 `clearSelection()`——如果这里派发的事件冒泡出去，
 * 会顺带清空用户当时选中的一批卡片，他自己并没有按过 Escape（见
 * task-3-report.md 修复轮 2，复审用真实源码 + 集成测试坐实了这条）。
 * `KeyboardSensor` 的取消监听器直接挂在 `document` 自己身上（不是委托监听），
 * `bubbles: false` 的事件在 at-target 阶段照样会命中它，只是不会再往上冒到
 * `window`——两边都是标准 DOM 事件语义，不用加任何自定义标记去区分「谁发的」。
 */
export function useCancelStuckDrag(activeDragId: string | null, stillExists: boolean): void {
  useEffect(() => {
    if (!activeDragId || stillExists) return;
    document.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: false, cancelable: true }),
    );
  }, [activeDragId, stillExists]);
}
