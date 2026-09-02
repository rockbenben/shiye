import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { ColGrip, clampWidth } from './ColGrip.js';

/**
 * 这个文件只盯**两条界线共用那份逻辑**里唯一有方向的那件事：贴左缘还是贴右缘。
 *
 * 「界线在 NavShell 里画不画、窄屏画不画」那类接线级的事在 `NavShell.test.tsx`
 * （那边的 16 条现在跑的就是这个组件），这里不重复一遍。
 *
 * 查询绑在**这一次 render 的容器**上，不用 `screen`：有几条测试要在同一个用例里
 * 渲染左右两条界线做对照，`screen` 查的是整个 body，会一次找到两条然后报
 * 「found multiple elements」。
 */
const show = (side: 'left' | 'right', width = 300) => {
  const onResize = vi.fn();
  const { container } = render(<ColGrip width={width} min={200} max={500} side={side} label={`拖 ${side}`} onResize={onResize} />);
  return { onResize, grip: within(container).getByRole('separator') };
};

const drag = (grip: HTMLElement, from: number, to: number) => {
  fireEvent.pointerDown(grip, { pointerId: 1, clientX: from });
  fireEvent.pointerMove(grip, { pointerId: 1, clientX: to });
};

describe('ColGrip：贴哪一边决定往右拖是变宽还是变窄', () => {
  /**
   * 这一条是这个组件存在的全部理由。搞反的话手感是「拖着它往右走，栏却往左缩」
   * ——没人会觉得那是对的，而两处各写一份实现时，反的那一处不会有任何东西发现。
   */
  it('右缘那条（清单侧栏）：往右拖 60，宽度 +60', () => {
    const { onResize, grip } = show('right', 300);
    drag(grip, 400, 460);
    expect(onResize).toHaveBeenLastCalledWith(360);
  });

  it('左缘那条（任务详情在最右边）：往右拖 60，宽度 −60', () => {
    const { onResize, grip } = show('left', 300);
    drag(grip, 400, 460);
    expect(onResize).toHaveBeenLastCalledWith(240);
  });

  it('往左拖同理，两边反过来', () => {
    const r = show('right', 300);
    drag(r.grip, 400, 340);
    expect(r.onResize).toHaveBeenLastCalledWith(240);

    const l = show('left', 300);
    drag(l.grip, 400, 340);
    expect(l.onResize).toHaveBeenLastCalledWith(360);
  });

  /**
   * 方向键**按屏幕走，不按 side 走**：右方向键永远是「界线往右挪」，对左缘那条
   * 来说就是这一列变窄——跟拖动的手感一致。反过来做的话，同一个键在两条界线上
   * 一个变宽一个变窄，而它们在屏幕上都是「往右」。
   */
  it('右方向键 = 界线往右挪：右缘那条变宽，左缘那条变窄', () => {
    const r = show('right', 300);
    fireEvent.keyDown(r.grip, { key: 'ArrowRight' });
    expect(r.onResize).toHaveBeenLastCalledWith(316);

    const l = show('left', 300);
    fireEvent.keyDown(l.grip, { key: 'ArrowRight' });
    expect(l.onResize).toHaveBeenLastCalledWith(284);
  });

  /**
   * Home/End 反过来：它们是「最窄 / 最宽」，不是「最左 / 最右」。按 side 翻转的话，
   * 同一个键在两栏上做的是相反的事，而这两个键在所有界面里的含义都是「到头」。
   */
  it('Home/End 在两条界线上含义一致——最窄和最宽，不随贴哪边翻转', () => {
    for (const side of ['left', 'right'] as const) {
      const { onResize, grip } = show(side, 300);
      fireEvent.keyDown(grip, { key: 'Home' });
      expect(onResize, `${side} 的 Home 该是最窄`).toHaveBeenLastCalledWith(200);
      fireEvent.keyDown(grip, { key: 'End' });
      expect(onResize, `${side} 的 End 该是最宽`).toHaveBeenLastCalledWith(500);
    }
  });

  it('两个变体各自带一个类名，CSS 靠它决定贴哪边', () => {
    expect(show('right').grip.className).toContain('ink-col-grip-right');
    expect(show('left').grip.className).toContain('ink-col-grip-left');
  });

  it('上下限对两边都管用', () => {
    const l = show('left', 300);
    drag(l.grip, 400, -9999);
    expect(l.onResize).toHaveBeenLastCalledWith(500);
    drag(l.grip, 400, 9999);
    expect(l.onResize).toHaveBeenLastCalledWith(200);
  });

  it('没按下就移动，什么都不做——光是划过界线不该改宽度', () => {
    const { onResize, grip } = show('left');
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 999 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('报得出自己多宽、能拖到哪儿，读屏念得出来', () => {
    const { grip } = show('left', 360);
    expect(grip.getAttribute('aria-valuenow')).toBe('360');
    expect(grip.getAttribute('aria-valuemin')).toBe('200');
    expect(grip.getAttribute('aria-valuemax')).toBe('500');
    expect(grip.getAttribute('aria-label')).toBe('拖 left');
    expect(grip.getAttribute('tabindex')).toBe('0');
  });
});

describe('clampWidth', () => {
  it('夹进上下限并取整——半个像素的列宽只会让边框忽粗忽细', () => {
    expect(clampWidth(300.4, 200, 500)).toBe(300);
    expect(clampWidth(9999, 200, 500)).toBe(500);
    expect(clampWidth(-1, 200, 500)).toBe(200);
  });
});
