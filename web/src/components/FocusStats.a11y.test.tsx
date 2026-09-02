// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { App as AntApp, InputNumber } from 'antd';

/**
 * **中文界面里不许冒出英文的无障碍名。**
 *
 * antd 的数字输入框（`InputNumber`）默认带一对加减箭头，而那两颗的 `aria-label`
 * 是**写死的英文**——`Increase Value` / `Decrease Value`，在
 * `@rc-component/input-number` 的 `StepHandler` 里，`ConfigProvider` 的
 * `locale={zhCN}` **覆盖不到**（locale 文件里根本没有这两句）。读屏用户在一个
 * 全中文的界面上会突然听见两句英文。
 *
 * 它们同时还够不着：实测外层 `ant-input-number-actions` 宽 0、`opacity: 0`，
 * 要悬停才展开，展开后每颗只有 **1×15px**。鼠标难点，触屏没有 hover。
 *
 * 所以这个应用里所有 `InputNumber` 一律 `controls={false}`。这一条守的是
 * **别再有人把它加回来**，也守 antd 升级后换了实现、英文又冒出来。
 *
 * ## 为什么先钉住「不加 controls={false} 就会有英文」
 *
 * 少了下面第一条，第二条就可能因为 antd 哪天自己改成中文而变成一句永远成立的
 * 废话——那时候这条守卫还在，但它守的东西已经没了，而没有任何地方会说一声。
 * 这个仓库为「断言恒真」栽过好几次，见 `theme.css.test.ts` 顶部。
 */
describe('InputNumber：不留英文的无障碍名', () => {
  const labels = () => [...document.querySelectorAll('[aria-label]')]
    .map((e) => e.getAttribute('aria-label') ?? '')
    .filter((s) => /^[\x20-\x7E]+$/.test(s) && /[A-Za-z]/.test(s));

  it('前提：antd 默认那对箭头确实带着英文 aria-label', () => {
    render(<AntApp><InputNumber aria-label="分钟" /></AntApp>);
    expect(labels(), 'antd 改成中文了？那下面那条守卫已经没有意义，删掉它')
      .toContain('Increase Value');
  });

  it('controls={false} 之后一句英文都不剩', () => {
    render(<AntApp><InputNumber aria-label="分钟" controls={false} /></AntApp>);
    expect(labels()).toEqual([]);
  });
});
