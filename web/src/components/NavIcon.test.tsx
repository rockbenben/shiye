import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { NavIcon, NAV_ICON_NAMES, hasNavIcon } from './NavIcon.js';
import { TASKS_MODULE_KEY, VIEW_SPECS } from '../lib/views.js';

describe('NavIcon', () => {
  it('**注册表里每一个去处都得有记号**——加一个视图忘了画，这条红，不是上线之后才发现那一行前面缺一块', () => {
    const missing = VIEW_SPECS.map((v) => v.key).filter((k) => !hasNavIcon(k));
    expect(missing, `这几个 key 还没画记号：${missing.join('、')}`).toEqual([]);
  });

  it('**反过来也对账**：画了却没人用的记号要么是拼错了 key，要么是那个视图已经删了', () => {
    // `tasks` 是唯一的例外：它不是一个视图，是竖栏上「任务」那一整个模块
    // （lib/views.tsx 的 TASKS_MODULE_KEY）。写成从那个常量派生，不是手写一个
    // 'tasks' 字符串——常量改了这里跟着走。
    const keys = new Set([...VIEW_SPECS.map((v) => v.key), TASKS_MODULE_KEY]);
    const orphan = NAV_ICON_NAMES.filter((n) => !keys.has(n));
    expect(orphan, `这几个记号在注册表里找不到对应的去处：${orphan.join('、')}`).toEqual([]);
  });

  it('「任务」那个模块也得有记号——竖栏上第一颗，没记号就是一颗空按钮', () => {
    expect(hasNavIcon(TASKS_MODULE_KEY)).toBe(true);
  });

  it('认不出的 key 返回 null——清单/标签那些动态去处有自己的记号，不该走这里', () => {
    const { container } = render(<NavIcon name="list:L1" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('不进可访问树——旁边就是那个去处的名字，读屏念两遍是噪音', () => {
    const { container } = render(<NavIcon name="today" />);
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('**一个都不许上颜色**：全部走 currentColor，跟着那一行的字色。群青是配给制，导航结构不是 AI 产出', () => {
    for (const name of NAV_ICON_NAMES) {
      const { container } = render(<NavIcon name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('stroke'), name).toBe('currentColor');
      expect(svg.getAttribute('fill'), name).toBe('none');
      // 笔画里也不许出现写死的颜色（画的时候手滑写个 #xxx 进去）。
      expect(svg.innerHTML, name).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    }
  });

  it('都是同一支笔：16 的画布、1.4 的笔宽——差一档在一列里是看得出来的', () => {
    for (const name of NAV_ICON_NAMES) {
      const { container } = render(<NavIcon name={name} />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('viewBox'), name).toBe('0 0 16 16');
      expect(svg.getAttribute('stroke-width'), name).toBe('1.4');
    }
  });

  it('每个记号都真的画了点什么——空的 <svg> 在一列里就是一个洞', () => {
    for (const name of NAV_ICON_NAMES) {
      const { container } = render(<NavIcon name={name} />);
      expect(container.querySelector('svg')!.childElementCount, name).toBeGreaterThan(0);
    }
  });
});
