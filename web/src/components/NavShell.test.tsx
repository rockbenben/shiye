import { describe, it, expect, vi } from 'vitest';
import { Row } from 'antd';
import { render, screen, fireEvent } from '@testing-library/react';
import { NAV_DEFAULT, NAV_MAX, NAV_MIN, NavShell, clampNavWidth } from './NavShell.js';

/**
 * 这个外壳只回答一个问题：**清单侧栏现在待在哪儿。**
 *
 * 宽屏并排一列，窄屏收进抽屉。它存在的理由是手机上的一次实测：竖栏躺平成
 * 顶上一条之后，紧接着就是整条侧栏（导航 + 清单 + 标签 + 随手记），390×844
 * 上占掉七百多像素——打开应用第一屏一条任务都看不见。
 *
 * 下面那组「拖宽侧栏的那条界线」测的是**接线**（给不给 onResize 才画、窄屏画不画、
 * 拖了传什么回去）；界线本身是 `ColGrip`，跟任务详情那栏共用一份，它自己那条
 * 「贴左缘还是右缘决定往右拖是变宽还是变窄」在 `ColGrip.test.tsx`。
 */
const show = (narrow: boolean, open = false, onClose = vi.fn()) => {
  const r = render(
    <Row>
      <NavShell narrow={narrow} open={open} onClose={onClose}>
        <p>侧栏内容</p>
      </NavShell>
    </Row>,
  );
  return { ...r, onClose };
};

describe('NavShell', () => {
  it('宽屏：就是并排那一列，内容直接在文档流里', () => {
    const { container } = show(false);
    const col = container.querySelector('.ink-rail-col');
    expect(col, '宽屏该渲染 .ink-rail-col 那一列').not.toBeNull();
    expect(col!.textContent).toContain('侧栏内容');
    expect(container.querySelector('.ink-nav-drawer')).toBeNull();
  });

  it('窄屏、没打开：内容**不在文档流里**——这正是这个组件存在的全部意义，摆在那儿就等于第一屏没有任务', () => {
    show(true, false);
    expect(screen.queryByText('侧栏内容')).toBeNull();
  });

  it('窄屏、打开了：内容在抽屉里', () => {
    show(true, true);
    expect(screen.getByText('侧栏内容')).toBeTruthy();
    expect(document.querySelector('.ink-nav-drawer')).not.toBeNull();
  });

  it('窄屏下点遮罩会回调 onClose——抽屉的关法不用自己实现一套', () => {
    const { onClose } = show(true, true);
    const mask = document.querySelector('.ant-drawer-mask');
    expect(mask, '抽屉该有遮罩').not.toBeNull();
    fireEvent.click(mask!);
    expect(onClose).toHaveBeenCalled();
  });

  it('抽屉不摆那颗「×」——关闭走遮罩/Esc/点任意一个去处，跟 SearchModal 同一条', () => {
    show(true, true);
    expect(document.querySelector('.ant-drawer-close')).toBeNull();
  });
});

/**
 * 那条可拖的界线。**只在宽屏渲染**——窄屏是抽屉，宽度是抽屉自己的事。
 *
 * 键盘那一路不是锦上添花：一条只能拖的界线，对不用鼠标的人等于不存在。
 */
describe('NavShell：拖宽侧栏的那条界线', () => {
  const grip = () => screen.queryByRole('separator');

  const wide = (width = NAV_DEFAULT) => {
    const onResize = vi.fn();
    render(
      <Row>
        <NavShell narrow={false} open={false} onClose={vi.fn()} width={width} onResize={onResize}>
          <p>侧栏内容</p>
        </NavShell>
      </Row>,
    );
    return onResize;
  };

  it('给了 onResize 才有这条界线——不给就是钉死在 width，跟加它之前一样', () => {
    render(
      <Row>
        <NavShell narrow={false} open={false} onClose={vi.fn()}><p>侧栏内容</p></NavShell>
      </Row>,
    );
    expect(grip()).toBeNull();
  });

  it('窄屏不画——那一屏是抽屉，没有「这一列多宽」这回事', () => {
    render(
      <Row>
        <NavShell narrow open onClose={vi.fn()} width={NAV_DEFAULT} onResize={vi.fn()}><p>侧栏内容</p></NavShell>
      </Row>,
    );
    expect(grip()).toBeNull();
  });

  /** 读屏得能念出「分隔条，当前 280，范围 200 到 460」，光有个能拖的 div 念不出来。 */
  it('报得出自己现在多宽、能拖到哪儿', () => {
    wide(300);
    expect(grip()!.getAttribute('aria-valuenow')).toBe('300');
    expect(grip()!.getAttribute('aria-valuemin')).toBe(String(NAV_MIN));
    expect(grip()!.getAttribute('aria-valuemax')).toBe(String(NAV_MAX));
    expect(grip()!.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('往右拖多少，宽度就加多少', () => {
    const onResize = wide(280);
    const g = grip()!;
    fireEvent.pointerDown(g, { pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(g, { pointerId: 1, clientX: 460 });
    expect(onResize).toHaveBeenLastCalledWith(340);
  });

  /** 按下之前的移动是「鼠标路过」，不是拖——不挡的话光是划过界线就会改宽度。 */
  it('没按下就移动，什么都不做', () => {
    const onResize = wide(280);
    fireEvent.pointerMove(grip()!, { pointerId: 1, clientX: 999 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('松手之后再移动也不跟了', () => {
    const onResize = wide(280);
    const g = grip()!;
    fireEvent.pointerDown(g, { pointerId: 1, clientX: 400 });
    fireEvent.pointerUp(g, { pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(g, { pointerId: 1, clientX: 999 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('拖过头夹在上下限里——上限存在的理由是别把看板挤没', () => {
    const onResize = wide(280);
    const g = grip()!;
    fireEvent.pointerDown(g, { pointerId: 1, clientX: 400 });
    fireEvent.pointerMove(g, { pointerId: 1, clientX: 4000 });
    expect(onResize).toHaveBeenLastCalledWith(NAV_MAX);
    fireEvent.pointerMove(g, { pointerId: 1, clientX: -4000 });
    expect(onResize).toHaveBeenLastCalledWith(NAV_MIN);
  });

  it('左右方向键一步 16px，Home/End 直接到头', () => {
    const onResize = wide(280);
    const g = grip()!;
    fireEvent.keyDown(g, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(296);
    fireEvent.keyDown(g, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(264);
    fireEvent.keyDown(g, { key: 'Home' });
    expect(onResize).toHaveBeenLastCalledWith(NAV_MIN);
    fireEvent.keyDown(g, { key: 'End' });
    expect(onResize).toHaveBeenLastCalledWith(NAV_MAX);
  });

  it('能用键盘走到——tabIndex 不给的话它在焦点顺序里根本不存在', () => {
    wide();
    expect(grip()!.getAttribute('tabindex')).toBe('0');
  });

  it('别的键不管，别把上下键和翻页吞掉', () => {
    const onResize = wide(280);
    fireEvent.keyDown(grip()!, { key: 'ArrowDown' });
    fireEvent.keyDown(grip()!, { key: 'PageUp' });
    expect(onResize).not.toHaveBeenCalled();
  });
});

describe('clampNavWidth', () => {
  it('夹在上下限里，并且取整——半个像素的列宽只会让边框忽粗忽细', () => {
    expect(clampNavWidth(280.4)).toBe(280);
    expect(clampNavWidth(9999)).toBe(NAV_MAX);
    expect(clampNavWidth(-1)).toBe(NAV_MIN);
  });
});
