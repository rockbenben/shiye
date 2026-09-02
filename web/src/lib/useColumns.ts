import { useLayoutEffect, useState, type RefObject } from 'react';

/** 卡片最窄多少。跟 theme.css 里 --card-min 是同一个数，改一处要改两处——
 * CSS 网格（「今天」）用那个 token，antd Masonry（「按来源」）只吃数字。 */
export const CARD_MIN = 340;

/**
 * 数一数这个容器能放下几列 `CARD_MIN` 宽的卡片。
 *
 * 存在的理由只有一个：antd 的 `<Masonry columns>` 要么是个死数字，要么是一张
 * **视口断点**表，而视口断点最高一档是 xxl（≥1600px）。这个应用左边常驻一条
 * 280px 的侧栏，同一个 xxl 档下 1920 的看板列能放 4 列、2560 能放 6 列——
 * 一张断点表说不出这个区别，写死 4 就等于在 2560 上把卡片撑到 550px 宽，
 * 比 `--measure`（532px）还宽，一行字长到读起来要找行首。
 *
 * 算法照抄 `repeat(auto-fill, minmax(CARD_MIN, 1fr))`：能塞下几个
 * `CARD_MIN + gap` 就是几列，至少一列。
 */
export function useColumns(ref: RefObject<HTMLElement | null>, gap: number): number {
  const [columns, setColumns] = useState(1);

  // useLayoutEffect + 立刻同步量一次，两件事缺一不可。ResizeObserver 首次回调
  // 是异步的（另一个任务里），只靠它的话首帧会用初始值 1 渲染出**整整一列**，
  // 下一帧才跳成四列——实测在慢一点的首次加载里这一下肉眼可见。先同步读一次
  // 宽度定下列数，RO 只负责之后的变化。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const count = (w: number) => Math.max(1, Math.floor((w + gap) / (CARD_MIN + gap)));
    setColumns(count(el.getBoundingClientRect().width));
    // ResizeObserver 而不是 window resize：这个容器的宽度不只跟着窗口变，
    // 侧栏在 767px 断点会从左边挪到下面、看板列跟着变宽，那一下没有 resize 事件。
    const ro = new ResizeObserver(([entry]) => setColumns(count(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, gap]);

  return columns;
}
