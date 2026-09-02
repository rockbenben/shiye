import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * 两栏之间那条可拖的界线。
 *
 * **抽出来是因为有第二处要用了**：先是清单侧栏和看板之间（`NavShell`），后来
 * 任务详情那一栏也要能拖（`App.tsx`）。第二处再抄一遍的话，「按住不放走多少」
 * 「上下限怎么夹」「键盘那一路」会在两个文件里各活一份，改一处漏一处。
 *
 * ## 为什么不用 antd 的 `Splitter`
 *
 * antd 6 确实带 `Splitter`，按这个仓库「能不自己写就不写」的规矩，第一反应就该
 * 是它。**但它接不住这一层已经写明理由的三条约束**：窄屏要堆叠成一列
 * （`Splitter` 没有响应式，两块永远并排）、`align="stretch"` 撑着随手记的
 * `margin-top: auto`、以及看板列那个 `flex: '1 1 0%'`（不是 `auto`，见 App.tsx
 * 那段注释，它修过一次真实回归）。换成 `Splitter` 等于把这三条一起重做。
 *
 * 所以只做最小的那一块：**一条界线，只改一列的宽度**，Row/Col 那套一个字不动。
 *
 * ## 为什么是绝对定位骑在列边缘上
 *
 * Row 的 gutter 是列的内边距，两列中间那条缝不属于任何一列。界线要落在缝里，
 * 只能绝对定位骑上去——所以用它的那一列必须是 `position: relative`
 * （`.ink-rail-col` / `.ink-detail-col` 都在 theme.css 里钉了）。
 */

/** 夹进上下限并取整——半个像素的列宽只会让边框忽粗忽细。 */
export const clampWidth = (w: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(w)));

interface Props {
  /** 这一列当前多宽。也是读屏念出来的 `aria-valuenow`。 */
  width: number;
  min: number;
  max: number;
  /**
   * 界线贴在这一列的哪一边——**决定往右拖是变宽还是变窄**。
   *
   * `'right'`：界线在右缘（清单侧栏），往右拖 = 这一列变宽。
   * `'left'`：界线在左缘（任务详情在最右边），往右拖 = 这一列变**窄**。
   * 搞反的话手感是「拖着它往右走，栏却往左缩」，没人会觉得那是对的。
   */
  side: 'left' | 'right';
  /** 读屏念的那句。说清楚拖的是哪一栏，页面上有两条界线时尤其要紧。 */
  label: string;
  onResize: (w: number) => void;
}

export function ColGrip({ width, min, max, side, label, onResize }: Props) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  // 左缘那条：鼠标往右走 x 变大，而这一列该变窄，所以位移取反。
  const dir = side === 'left' ? -1 : 1;

  // 指针捕获是**锦上添花**，不是拖动能不能用的前提：有它的时候鼠标滑出界线、
  // 甚至滑出窗口，事件照样回到这条界线上；没有它，拖动照常，只是滑太快会脱手。
  // 所以这里探一下再调——jsdom 压根没这两个方法，安卓那条 WebView 老一点的也
  // 可能没有，而在 pointerdown 里抛一个异常会把整次按下弄废，连脱手的拖动都没了。
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    onResize(clampWidth(d.w + dir * (e.clientX - d.x), min, max));
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    /* **`role="separator"` 而不是一颗按钮**：ARIA 里可拖的分隔条就是这个角色，
       读屏会念出「分隔条，当前 280，范围 200 到 460」。键盘那一路是必须的
       ——只能拖的界线对不用鼠标的人等于不存在。 */
    <div
      className={`ink-col-grip ink-col-grip-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(e) => {
        // 一步 16px：跟这套设计的间距刻度一致，按住不放也不会一下窜到头。
        // **方向键按屏幕走，不按 `dir` 走**：右方向键永远是「界线往右挪」，
        // 对左缘那条来说就是这一列变窄——跟拖动的手感一致。
        const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
        if (step) { e.preventDefault(); onResize(clampWidth(width + dir * step, min, max)); return; }
        // Home/End 是「最窄 / 最宽」，不是「最左 / 最右」——两条界线上含义一致，
        // 按 `dir` 翻转的话，同一个键在两栏上做的是相反的事。
        if (e.key === 'Home') { e.preventDefault(); onResize(min); }
        if (e.key === 'End') { e.preventDefault(); onResize(max); }
      }}
    />
  );
}
