import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { NoMotion } from '../test-utils.js';
import { ShortcutHelp, SHORTCUTS } from './ShortcutHelp.js';

/**
 * 「哪一行对应哪个 kind」由 `keymap.test.ts` 那两条同步测试盯着（两族各一条）。
 * 这里只测**画出来的那一半**：两段分开、说明那句挨着它该挨着的那一段。
 */
const show = () =>
  render(<NoMotion><AntApp><ShortcutHelp open onClose={() => {}} /></AntApp></NoMotion>);

describe('ShortcutHelp', () => {
  it('整页那几个键画在第一张表里', () => {
    show();
    const tables = document.querySelectorAll('.ink-shortcut-table');
    // 三张：整页 / 焦点在卡上 / 编辑表单里。
    expect(tables).toHaveLength(3);
    expect(within(tables[0] as HTMLElement).getByText('随手记一条进收件箱')).toBeTruthy();
  });

  it('**表单那三个单独一段**——上面那句说明的前提是「输入框里不生效」，而这三个恰恰只在输入框里生效', () => {
    show();
    expect(screen.getByText('编辑表单里')).toBeTruthy();
    const tables = document.querySelectorAll('.ink-shortcut-table');
    const form = tables[2] as HTMLElement;
    expect(within(form).getByText('标题框里：保存 / 添加')).toBeTruthy();
    expect(within(form).getByText('取消编辑 / 关掉表单')).toBeTruthy();
    // 上限：整页那几个没混进来。
    expect(within(form).queryByText('随手记一条进收件箱')).toBeNull();
  });

  it('**焦点在卡上那一族也单独一段**——它既不是「整页都管用」也不是「只在输入框里」，混进任一张表都说不清「那一条」指的是哪一条', () => {
    show();
    expect(screen.getByText('焦点在某张卡上时')).toBeTruthy();
    const card = document.querySelectorAll('.ink-shortcut-table')[1] as HTMLElement;
    expect(within(card).getByText(/选中 \/ 取消选中焦点所在的那一条/)).toBeTruthy();
    expect(within(card).queryByText('随手记一条进收件箱')).toBeNull();
  });

  it('那句「输入框里不生效」只说给整页那一段听——它排在第一张表后面、小标题前面', () => {
    show();
    // antd 的 Modal 渲染在 body 末尾的浮层里，不在 render 返回的 container 里。
    const kids = [...(document.querySelector('.ant-modal-body') as HTMLElement).querySelectorAll('.ink-shortcut-table, .ink-shortcut-note, .ink-shortcut-sub')];
    expect(kids.map((e) => e.className)).toEqual([
      'ink-shortcut-table', 'ink-shortcut-note',
      'ink-shortcut-sub', 'ink-shortcut-table',
      'ink-shortcut-sub', 'ink-shortcut-table',
    ]);
  });

  it('每一行都有 scope——漏了的话它会静默从两张表里一起消失', () => {
    for (const r of SHORTCUTS) expect(['page', 'form', 'card']).toContain(r.scope);
  });
});
