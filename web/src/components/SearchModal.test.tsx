import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { SearchModal } from './SearchModal.js';
import { task } from '../test-utils.js';
import type { Task } from '../types.js';

const NOW = new Date(2026, 7, 24, 12);
const LISTS = [{ id: 'L1', name: '工作', color: '#8A6A3B', order: 0, archived: false, filter: null, folderId: null }];

const hit = (i: number) => task({ id: `t${i}`, title: `任务${i}`, listId: 'L1' });

function show(over: Partial<Parameters<typeof SearchModal>[0]> = {}) {
  const onClose = vi.fn();
  const onQuery = vi.fn();
  const onOpen = vi.fn();
  const onSeeAll = vi.fn();
  render(
    <AntApp>
      <SearchModal
        open
        onClose={onClose}
        query="报告"
        onQuery={onQuery}
        hits={[]}
        hasAnyTask
        now={NOW}
        lists={LISTS}
        onOpen={onOpen}
        onSeeAll={onSeeAll}
        {...over}
      />
    </AntApp>,
  );
  return { onClose, onQuery, onOpen, onSeeAll };
}

const box = () => screen.getByLabelText('搜索任务') as HTMLInputElement;

describe('SearchModal', () => {
  it('打字就报出去，自己不攒——查询词是 App 那一层的 state（「搜索结果」那个去处也读它）', () => {
    const { onQuery } = show();
    fireEvent.change(box(), { target: { value: '周报' } });
    expect(onQuery).toHaveBeenCalledWith('周报');
  });

  it('列出结果，点一条交给上面去打开它并关掉自己', () => {
    const { onOpen, onClose } = show({ hits: [hit(1)] });
    fireEvent.click(screen.getByRole('button', { name: /任务1/ }));
    expect(onOpen).toHaveBeenCalledWith('t1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('每条右边挂「哪个清单」——搜出五条同名的，分得开它们的正是这个', () => {
    show({ hits: [hit(1)] });
    expect(screen.getByRole('button', { name: /工作/ })).toBeTruthy();
  });

  it('**回车 = 看全部结果**，去「搜索结果」那个去处', () => {
    const { onSeeAll, onClose } = show({ hits: [hit(1)] });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSeeAll).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('**空着回车什么也不做**——跳去一个空的搜索结果页是白跑一趟', () => {
    const { onSeeAll } = show({ query: '   ', hits: [] });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSeeAll).not.toHaveBeenCalled();
  });

  it('还没打字时说一句人话，不摆一个空列表——空列表看着像「搜不到」，而这时候是「还没搜」', () => {
    show({ query: '', hits: [] });
    expect(screen.getByText(/打字就开始找/)).toBeTruthy();
    // **列的字段要跟 `searchTasks` 真搜的那四样一致**（见 lib/search.test.ts
    // 里那条同名守卫）。这句话是给用户的承诺：他据此判断「换个词」有没有用。
    // 早先这儿写的是「标题、备注、标签」，漏了子任务——少报了一样能力。
    for (const f of ['标题', '备注', '标签', '子任务']) {
      expect(screen.getByText(new RegExp(f)), `提示语里漏了「${f}」`).toBeTruthy();
    }
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('打了字、一条都没搜到：说没匹配上，并让他换个词', () => {
    show({ query: '不存在的', hits: [] });
    expect(screen.getByText(/没有匹配的任务/)).toBeTruthy();
    expect(screen.getByText(/换个词/), '只说「没匹配」是个死胡同——空态要给下一步').toBeTruthy();
  });

  /**
   * **一条任务都没有的实例上，「没有匹配的任务」是句误导。** 真实原因不是「这个
   * 词没命中」，是「压根没有东西可搜」——这两种情况该给的下一步完全不同：换个词，
   * 还是先去建一条。空实例上实测过：那时候这个弹层只说「没有匹配的任务」，把人
   * 引向反复换词。
   *
   * 「未归类」那一屏早就是这么分档的（`App.tsx` 里 `tasks.length === 0` 那一支），
   * 这里补上同一条。
   */
  it('实例里一条任务都没有：不说「没匹配」，直接指去添加任务', () => {
    show({ query: '随便打的', hits: [], hasAnyTask: false });
    expect(screen.queryByText(/没有匹配的任务/), '一条任务都没有时说「没匹配」是误导').toBeNull();
    expect(screen.getByText(/还没有任务/)).toBeTruthy();
    expect(screen.getByText(/添加任务/)).toBeTruthy();
  });

  it('**最多列八条，截断了要说出来**——看起来是全部、其实只有前八条', () => {
    const many = Array.from({ length: 12 }, (_, i) => hit(i));
    show({ hits: many });
    expect(screen.getByRole('list').querySelectorAll('li')).toHaveLength(8);
    expect(screen.getByText(/还有 4 条/)).toBeTruthy();
  });

  it('刚好八条时不出那一行', () => {
    show({ hits: Array.from({ length: 8 }, (_, i) => hit(i)) });
    expect(screen.queryByText(/还有/)).toBeNull();
  });

  it('「看全部结果」那一行点了也去那个去处并关掉自己', () => {
    const { onSeeAll, onClose } = show({ hits: Array.from({ length: 12 }, (_, i) => hit(i)) });
    fireEvent.click(screen.getByText(/还有 4 条/));
    expect(onSeeAll).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关着的时候什么都不渲染', () => {
    const utils: { container: HTMLElement } = render(
      <AntApp>
        <SearchModal
          open={false}
          onClose={vi.fn()}
          query=""
          onQuery={vi.fn()}
          hits={[] as Task[]}
          hasAnyTask={false}
          now={NOW}
          lists={LISTS}
          onOpen={vi.fn()}
          onSeeAll={vi.fn()}
        />
      </AntApp>,
    );
    expect(within(utils.container).queryByLabelText('搜索任务')).toBeNull();
  });
});

/**
 * **搜索是唯一一个把所有状态混在一起给你看的地方。**
 *
 * 「已完成」「搁置」「已放弃」平时各在各的去处，只有这一列会把它们跟待办
 * 摆在一起——而在这之前它们长得一模一样，点进去才发现那条早就做完了。
 */
describe('SearchModal：不是「待办」就说出来', () => {
  it('已完成的标出「已完成」', () => {
    show({ hits: [task({ id: 'd', title: '交上个季度的报告', status: 'done', listId: 'L1' })] });
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('搁置、已放弃、进行中同样标出来', () => {
    show({ hits: [
      task({ id: 'a', title: 'A', status: 'later', listId: 'L1' }),
      task({ id: 'b', title: 'B', status: 'abandoned', listId: 'L1' }),
      task({ id: 'c', title: 'C', status: 'doing', listId: 'L1' }),
    ] });
    for (const t of ['搁置', '已放弃', '进行中']) expect(screen.getByText(t)).toBeTruthy();
  });

  it('**「待办」不画**——那是默认状态，每条都挂一个只是噪音', () => {
    show({ hits: [hit(1)] });
    expect(screen.queryByText('待办')).toBeNull();
  });
});
