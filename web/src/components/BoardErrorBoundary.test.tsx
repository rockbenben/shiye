import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { BoardErrorBoundary } from './BoardErrorBoundary.js';

/** 故意崩的子组件——传入 shouldThrow=false 之后能正常渲染，配合「重试」按钮
 * 验证边界能从错误态恢复，不是只会显示错误再也回不去。 */
function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('看板坏了：test.subtasks.map is not a function');
  return <div>看板正常了</div>;
}

// React 在开发模式下会把边界捕获到的错误也打印到 console.error（这是预期行为，
// 不是测试在放任一个真的没处理的报错）——这里静音掉，不然测试输出会被这条
// 噪音淹没。
afterEach(() => vi.restoreAllMocks());

describe('BoardErrorBoundary', () => {
  it('子组件渲染抛错时，显示中文提示，说明是哪两个文件、下一步做什么，而不是白屏', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <BoardErrorBoundary>
        <Boom shouldThrow />
      </BoardErrorBoundary>,
    );

    expect(screen.getByText('任务看板加载失败')).toBeDefined();
    // **目录，不是早年那两份单文件**（`data/tasks.json`）。存储搬成「一个实体
    // 一个文件」之后那两个路径就不存在了，而这个组件存在的全部意义就是告诉人
    // 去哪儿找——指到一个不存在的路径上比不提示更糟。
    expect(screen.getByText(/data\/tasks\//)).toBeDefined();
    expect(screen.getByText(/data\/inbox\//)).toBeDefined();
    expect(screen.queryByText(/tasks\.json/)).toBeNull();
    expect(screen.getByText(/看板坏了/)).toBeDefined();
  });

  it('点「重试」之后重新渲染子组件——错误不是永久锁死的', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Toggle() {
      return <Boom shouldThrow={shouldThrow} />;
    }
    render(
      <AntApp>
        <BoardErrorBoundary>
          <Toggle />
        </BoardErrorBoundary>
      </AntApp>,
    );

    expect(screen.getByText('任务看板加载失败')).toBeDefined();

    shouldThrow = false;
    // antd 给两个汉字的按钮插空格：textContent 是「重 试」不是「重试」。
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    expect(screen.getByText('看板正常了')).toBeDefined();
  });

  it('子组件没有抛错时，正常渲染，不显示错误提示', () => {
    render(
      <BoardErrorBoundary>
        <Boom shouldThrow={false} />
      </BoardErrorBoundary>,
    );
    expect(screen.getByText('看板正常了')).toBeDefined();
    expect(screen.queryByText('任务看板加载失败')).toBeNull();
  });
});
