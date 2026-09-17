import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ReviewView } from './ReviewView.js';
import { task } from '../test-utils.js';
import { REVIEWED_QUIET_DAYS } from '../lib/taskView.js';
import { POSTPONE_MIN } from '../lib/suggest.js';
import { THROUGHPUT_DAYS } from '../lib/throughput.js';
import type { Insight, Task } from '../types.js';

/** 「这一周该过一遍的」要一个 now；这一族既有用例不关心具体是哪天。 */
const NOW_REVIEW = new Date('2026-08-25T12:00:00.000Z');

const ins = (id: string, over: Partial<Insight> = {}): Insight => ({
  id, kind: 'stuck', text: `${id} 的正文`, taskIds: [],
  createdAt: '2026-08-13T00:00:00.000Z', dismissedAt: null, ...over,
});

// Task 有 23 个必填字段，不能用 `{ id, title } as Task` 硬转——重叠不够，
// typecheck 会拒。用 test-utils 的夹具。
const TASKS = [task({ id: 'T1', title: '写周报' })];

describe('ReviewView', () => {
  it('没有 insight 时一行安静的字', () => {
    render(<ReviewView insights={[]} tasks={[]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(screen.getByText(/还没有回顾/)).toBeTruthy();
  });

  it('已经「知道了」的不显示，还没处理的照样显示——不是「整个列表一起消失」蒙混过去的', () => {
    // 混一条已经处理过的和一条还没处理的：只删掉 filter 的话两条都会显示，
    // 只是把渲染整个清空的话两条都不会显示——两种退化实现都得被这条测试逮到。
    render(<ReviewView
      insights={[ins('a', { dismissedAt: '2026-08-13T01:00:00.000Z' }), ins('b')]}
      tasks={[]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(screen.queryByText('a 的正文')).toBeNull();
    expect(screen.getByText('b 的正文')).toBeTruthy();
  });

  it('点「知道了」带上这条的 id，不会误触 onOpen', () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    render(<ReviewView insights={[ins('a')]} tasks={[]} onDismiss={onDismiss} onOpen={onOpen} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(onDismiss).toHaveBeenCalledWith('a');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('关联任务显示标题，点了带上 taskId，不会误触 onDismiss', () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(<ReviewView insights={[ins('a', { taskIds: ['T1'] })]}
                       tasks={TASKS} onDismiss={onDismiss} onOpen={onOpen} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    fireEvent.click(screen.getByRole('button', { name: '写周报' }));
    expect(onOpen).toHaveBeenCalledWith('T1');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('关联的任务已经被删掉了就不列它——不是显示一个裸 id', () => {
    render(<ReviewView insights={[ins('a', { taskIds: ['GONE'] })]}
                       tasks={TASKS} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(screen.getByText('a 的正文')).toBeTruthy();
    expect(screen.queryByText('GONE')).toBeNull();
  });

  it('新的排在前面——id 的字典序跟这里期望的顺序刻意反着来，排序按 id 排也不会蒙混过关', () => {
    // 'k1' 时间上更早，'z9' 时间上更晚；按 id 升序恰好是 [k1, z9]（跟不排序
    // 的原始写入顺序一样），按 id 降序是 [z9, k1]（碰巧等于正确答案）——
    // 这里两条都用得上：原始写入顺序（未排序）和 id 升序都会被这条测试逮到。
    render(<ReviewView
      insights={[ins('k1', { createdAt: '2026-08-01T00:00:00.000Z' }),
                 ins('z9', { createdAt: '2026-08-13T00:00:00.000Z' })]}
      tasks={[]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    const texts = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(texts[0]).toContain('z9 的正文');
    expect(texts[1]).toContain('k1 的正文');
  });

  it('createdAt 解析不了时按最旧处理，不会让排序整个失控（`|| 0` 兜底）', () => {
    // 不写 `|| 0` 的话 Date.parse('坏时间') 是 NaN，NaN 参与比较恒为 false，
    // 两条元素谁都不会被判定「该排到前面」，排序会保持原始写入顺序——这里
    // 特意把坏数据写在数组第一位，让「保持原样」和「按有效时间处理」给出
    // 不同的结果，才测得出兜底值到底生没生效。
    render(<ReviewView
      insights={[ins('bad', { createdAt: '不是一个合法的时间' }),
                 ins('good', { createdAt: '2026-08-10T00:00:00.000Z' })]}
      tasks={[]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    const texts = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(texts[0]).toContain('good 的正文');
    expect(texts[1]).toContain('bad 的正文');
  });

  it('kind 对应的标签会显示——这个分支删掉整行照样能通过其它断言，得单独盯着', () => {
    render(<ReviewView insights={[ins('a', { kind: 'stuck' })]}
                       tasks={[]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(screen.getByText('卡住了')).toBeTruthy();
  });

  it('kind 是 note 时没有对应的中文标签，不渲染一个空标签元素', () => {
    const { container } = render(<ReviewView insights={[ins('a', { kind: 'note' })]}
                       tasks={[]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(container.querySelector('.ink-review-kind')).toBeNull();
    // 正文必须真的挂着 .ink-review-text 这个类——群青是靠这个类名接到正文上的
    // （见 theme.css.test.ts 那条断言），组件测试这边只查过文字有没有渲染，
    // 没查过它是不是长在这个类里；类名一掉，字还在，正文静默变回石墨黑，
    // 两条测试各自绿、没有人接住这道缝。
    expect(container.querySelector('.ink-review-text')?.textContent).toBe('a 的正文');
  });
});

/**
 * 卡住的项目（GTD 每周回顾专门要查的那一条）。判据在 lib/hierarchy.ts 的
 * `stalledProjects`，这里测的是这一屏怎么把它说出来。
 */
describe('ReviewView：卡住的项目', () => {
  const parent = task({ id: 'p', title: '装修' });
  const kid = (id: string, status: Task['status']) => task({ id, parentId: 'p', status });

  it('底下一个能动的下一步都没有时，把这个项目列出来', () => {
    render(<ReviewView insights={[]} tasks={[parent, kid('a', 'later')]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(screen.getByRole('heading', { name: /卡住的项目/ }).textContent).toContain('1');
    expect(screen.getByRole('button', { name: '装修' })).toBeTruthy();
  });

  it('**说清为什么算卡住**——光列标题的话，人点进去也看不出问题在哪', () => {
    render(<ReviewView insights={[]} tasks={[parent, kid('a', 'later')]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(document.querySelector('.ink-review-stalled-why')?.textContent).toContain('一个能动的下一步都没有');
  });

  it('点标题打开那条任务', () => {
    const onOpen = vi.fn();
    render(<ReviewView insights={[]} tasks={[parent, kid('a', 'abandoned')]} onDismiss={vi.fn()} onOpen={onOpen} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    fireEvent.click(screen.getByRole('button', { name: '装修' }));
    expect(onOpen).toHaveBeenCalledWith('p');
  });

  it('还有能动的下一步就不列——那个项目没卡住', () => {
    render(<ReviewView insights={[]} tasks={[parent, kid('a', 'todo')]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(screen.queryByRole('heading', { name: /卡住的项目/ })).toBeNull();
  });

  it('**没有「知道了」**——这一条描述的是此刻的事实，人去动了它自己就没了，不该能被点掉', () => {
    render(<ReviewView insights={[]} tasks={[parent, kid('a', 'later')]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(screen.queryByRole('button', { name: '知道了' })).toBeNull();
  });

  it('只有卡住的项目、一条 AI 观察都没有时，也不该显示空状态那句话', () => {
    render(<ReviewView insights={[]} tasks={[parent, kid('a', 'later')]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(screen.queryByText(/还没有回顾/)).toBeNull();
  });

  it('两样都没有才是空状态', () => {
    render(<ReviewView insights={[]} tasks={[task({ id: 'x' })]} onDismiss={vi.fn()} onOpen={vi.fn()} inbox={[]} now={NOW_REVIEW} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    expect(screen.getByText(/还没有回顾/)).toBeTruthy();
  });
});

/**
 * 「这一周该过一遍的」——GTD 每周回顾那份清单。判据在 lib/weeklyReview.ts
 * （那边另有测试），这里测的是这一屏怎么把它摆出来。
 */
describe('ReviewView：这一周该过一遍的', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

  const show = (tasks: Task[], onGo = vi.fn()) => {
    render(
      <ReviewView
        insights={[]}
        tasks={tasks}
        inbox={[{ id: 'i1', text: '随手记的一句', createdAt: daysAgo(1), processed: false, taskIds: [] }]}
        now={NOW}
        onDismiss={vi.fn()}
        onOpen={vi.fn()}
        onGo={onGo} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false}
      />,
    );
    return onGo;
  };

  it('列出该看的那几行，点了切过去', () => {
    const onGo = show([task({ id: 'a', due: daysAgo(3) })]);
    expect(screen.getByRole('heading', { name: '这一周该过一遍的' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /收件箱还有 1 条没处理/ }));
    // 第二个参数是「跳过去之前先设成这个筛选」——收件箱那一行不带（它那个
    // 去处本来就只装那一类），所以是 undefined，不是「没传」。
    expect(onGo).toHaveBeenCalledWith('inbox', undefined);
  });

  it('**「卡住的项目」那一行不做成按钮**——下面那一段就列着它们，跳走是把人带离答案', () => {
    show([task({ id: 'p' }), task({ id: 'k', parentId: 'p', status: 'later' })]);
    const line = document.querySelector('.ink-review-todo-flat');
    expect(line?.textContent).toContain('项目卡住了');
    expect(screen.queryByRole('button', { name: /项目卡住了/ })).toBeNull();
  });

  it('全清的时候整段不出现——不列一串 0', () => {
    render(
      <ReviewView
        insights={[]} tasks={[task({ id: 'a' })]} inbox={[]} now={NOW}
        onDismiss={vi.fn()} onOpen={vi.fn()} onGo={vi.fn()} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false}
      />,
    );
    expect(screen.queryByRole('heading', { name: '这一周该过一遍的' })).toBeNull();
    expect(screen.getByText(/还没有回顾/)).toBeTruthy();
  });
});

/**
 * 带筛选跳过去——补的是「只给了个数字」那个弱点：「1 条在等别人」点过去落在
 * 「全部」的十九条里，人还得自己找那一条。判据在 lib/weeklyReview.ts。
 */
describe('ReviewView：清单那几行带着筛选跳', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

  it('「在等别人」那一行把筛选一起交出去', () => {
    const onGo = vi.fn();
    render(
      <ReviewView
        insights={[]}
        tasks={[task({ id: 'a', waitingFor: '张老师', updatedAt: daysAgo(12) })]}
        inbox={[]} now={NOW} onDismiss={vi.fn()} onOpen={vi.fn()} onGo={onGo} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /在等别人/ }));
    expect(onGo).toHaveBeenCalledWith('all', { hasWaitingFor: true });
  });

  it('「搁了很久」那一行同理', () => {
    const onGo = vi.fn();
    render(
      <ReviewView
        insights={[]}
        tasks={[task({ id: 'a', status: 'later', updatedAt: daysAgo(90) })]}
        inbox={[]} now={NOW} onDismiss={vi.fn()} onOpen={vi.fn()} onGo={onGo} onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /搁了超过/ }));
    expect(onGo).toHaveBeenCalledWith('all', { status: ['later'] });
  });
});

/**
 * 「让 AI 回顾一遍」那颗按钮。
 *
 * 它取代的是一句指路（「在这个文件夹里敲 /review」）——那句话既没说是哪个
 * 工具，也没说是哪个文件夹，使用者看不懂。换成按钮后，防误触靠的不是确认框，
 * 是【没东西可回顾时置灰】——跟「立即拆解」在待拆解为 0 时置灰是同一个做法。
 */
describe('ReviewView：让 AI 回顾一遍', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const show = (tasks: Task[], over: { onReview?: () => void; onReviewed?: (id: string) => void; reviewing?: boolean } = {}) => render(
    <ReviewView
      insights={[]} tasks={tasks} inbox={[]} now={NOW}
      onDismiss={vi.fn()} onOpen={vi.fn()} onGo={vi.fn()}
      onReviewed={over.onReviewed ?? vi.fn()} onReview={over.onReview ?? vi.fn()} onBoard={vi.fn()} reviewing={over.reviewing ?? false}
    />,
  );
  const btn = () => screen.getByRole('button', { name: /让 AI 回顾一遍/ }) as HTMLButtonElement;

  it('有还挂着的任务：能点，点了调 onReview', () => {
    const onReview = vi.fn();
    show([task({ id: 'a', status: 'todo' })], { onReview });
    expect(btn().disabled).toBe(false);
    fireEvent.click(btn());
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('一条还挂着的任务都没有：置灰，而且说清楚为什么灰', () => {
    // 全是了结了的（done/later/abandoned）——workflows/review.md 要看的四类
    // 全以「有还没了结的任务」为前提，这时候点下去就是白烧一次额度。
    show([task({ id: 'a', status: 'done' }), task({ id: 'b', status: 'abandoned' })]);
    expect(btn().disabled).toBe(true);
    // 不留一颗没有解释的死按钮：置灰时旁边那句话要说出原因。
    expect(screen.getByText(/没什么可回顾/)).toBeTruthy();
  });

  /**
   * 能点的时候那句话要说清**它只提建议、不直接改**——那是按下去之前最该知道的
   * 一件事（这一屏的整个设计就建立在「AI 不悄悄改你手填的东西」上）。
   *
   * 顺带钉住**它不列自己能改哪几样**：上一版写的是「只提改期、拆细的建议」，
   * 而 `PROPOSABLE` 有十二个字段——那句话把十个说成了不能提，跟 README 那句
   * 「只能改这五样」是同一个形状的错。短文案里不列清单，就没有会飘的东西；
   * 完整名单在 README，有 `agentsMd.guard.test.ts` 盯着。
   */
  it('能点的时候说清「只提建议、不直接改」，而且不列它能改哪几样', () => {
    show([task({ id: 'a', status: 'todo' })]);
    expect(btn().disabled).toBe(false);
    const hint = screen.getByText(/只提建议/);
    expect(hint.textContent).toContain('不会直接改任务');
    // 一列清单就会飘：加一个可提议的字段，这句话不会有任何东西提醒你跟上。
    expect(hint.textContent).not.toContain('拆细');
  });

  it('正在跑：不能再点，而且报一句要等多久', () => {
    // 服务端那把单飞锁拆解和回顾共用，正在拆解时点回顾会被 409——
    // 与其让人点完吃一个错误弹窗，不如先别让点。
    show([task({ id: 'a', status: 'todo' })], { reviewing: true });
    expect(btn().disabled).toBe(true);
    expect(screen.getByText(/一两分钟/)).toBeTruthy();
  });

  it('空状态上也摆着同一颗按钮——一个出口不能两种状态下长在两个地方', () => {
    // 一条 todo、无截止时间：回顾清单和卡住的项目都是空的，走空状态那条分支。
    show([task({ id: 'a', status: 'todo', due: null, reminders: [] })]);
    expect(screen.getByText(/还没有回顾/)).toBeTruthy();
    expect(btn().disabled).toBe(false);
  });
});

/**
 * **「看过了」**——仿 OmniFocus 的 Mark Reviewed。
 *
 * 判据在 `lib/weeklyReview.ts` 的 `stalledToReview`（那边测的是「盖了章之后
 * 算不算」），这一族测的是这一屏怎么把它接出来：按钮在不在、点了传什么、
 * 以及盖过章的那一条这一屏还显不显示。
 */
describe('ReviewView：卡住的项目上那颗「看过了」', () => {
  const parent = (over: Partial<Task> = {}) => task({ id: 'p', title: '装修', ...over });
  const kid = task({ id: 'a', parentId: 'p', status: 'later' });
  const show = (tasks: Task[], onReviewed = vi.fn()) => {
    render(<ReviewView
      insights={[]} tasks={tasks} inbox={[]} now={NOW_REVIEW}
      onDismiss={vi.fn()} onOpen={vi.fn()} onGo={vi.fn()}
      onReviewed={onReviewed} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    return onReviewed;
  };

  it('每一条卡住的项目旁边都有一颗「看过了」', () => {
    show([parent(), kid]);
    expect(screen.getByRole('button', { name: '看过了' })).toBeTruthy();
  });

  it('点了把那条的 id 交出去——不是别人的 id，也不是不带参数', () => {
    const onReviewed = show([parent(), kid]);
    fireEvent.click(screen.getByRole('button', { name: '看过了' }));
    expect(onReviewed).toHaveBeenCalledTimes(1);
    expect(onReviewed).toHaveBeenCalledWith('p');
  });

  /**
   * **这一条是这颗按钮的全部意义。** 盖了章之后这一屏不再问它——按钮点了、
   * 章盖上了、下次打开还在，那这颗按钮就是个摆设。
   */
  it('盖过章的那一条整个不显示，「卡住的项目」那一段跟着消失', () => {
    show([parent({ reviewedAt: NOW_REVIEW.toISOString() }), kid]);
    expect(screen.queryByRole('heading', { name: /卡住的项目/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '装修' })).toBeNull();
  });

  /**
   * **跟「知道了」分得清。** 那一颗是给 AI 观察用的（点了写 `dismissedAt`，
   * 意思是「这条观察我不认」）；这一颗承认事实、只是为它做了决定。两颗长得像，
   * 混在同一行里点错的代价完全不同，所以卡住的项目这一段里不该出现「知道了」。
   */
  it('卡住的项目那一段里没有「知道了」——那颗是给 AI 观察的，不是给事实的', () => {
    show([parent(), kid]);
    const section = document.querySelector('.ink-review-stalled') as HTMLElement;
    expect(within(section).queryByRole('button', { name: '知道了' })).toBeNull();
  });

  it('按钮上把「多久之后再问」说出来，天数读的是同一个常量', () => {
    show([parent(), kid]);
    const b = screen.getByRole('button', { name: '看过了' });
    expect(b.getAttribute('title')).toContain(`${REVIEWED_QUIET_DAYS} 天`);
  });
});

/**
 * **「这一周的进出」**——完成了多少、新进来多少、差多少。
 *
 * 这一屏里唯一一个回答「我是在追上，还是在落后」的东西，也是唯一一个**不是
 * 债**的数字：上面每一节说的都是「你还欠多少」，而只报债不报还债的清单久了
 * 就整份不再被当真。判据与口径全在 `lib/throughput.ts`（那边另有测试），
 * 这一族测的是这一屏怎么把它摆出来。
 */
describe('ReviewView：这一周的进出', () => {
  const NOW = new Date('2026-08-25T12:00:00.000Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

  const show = (tasks: Task[]) => render(
    <ReviewView
      insights={[]} tasks={tasks} inbox={[]} now={NOW}
      onDismiss={vi.fn()} onOpen={vi.fn()} onGo={vi.fn()}
      onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />,
  );
  const section = () => document.querySelector('.ink-review-pace') as HTMLElement | null;

  it('有进出就把三个数说出来', () => {
    show([
      task({ id: 'a', completedAt: daysAgo(1) }),
      task({ id: 'b', completedAt: daysAgo(2) }),
      task({ id: 'c', createdAt: daysAgo(3) }),
    ]);
    const text = section()?.textContent ?? '';
    expect(text).toContain('完成 2 条');
    expect(text).toContain('新进来 1 条');
    expect(text).toContain('净 +1 条');
  });

  /**
   * **两个数都是 0 时整节不渲染。** 说「完成 0 条、新进来 0 条」是对一个这周
   * 没碰过这个应用的人每天说的一句废话（跟 `workload.ts`「一条都没估过时整句
   * 不出」同一条规矩）。调用方判的就是 `throughputLabel` 返回的空串。
   */
  it('两个数都是 0 时整节不出现——不报一句每天都要看的废话', () => {
    show([task({ id: 'a' })]);
    expect(section()).toBeNull();
    expect(screen.queryByRole('heading', { name: '这一周的进出' })).toBeNull();
  });

  /**
   * **「这周一条都没做完」正是这一节最该说出来的那种情况**，不能被「0 就是
   * 没有」的判据顺手吞掉——只有两个数**都**是 0 才是空。
   */
  it('只有完成是 0 时照样报——「完成 0 条 · 新进来 5 条」正是该说的', () => {
    show([task({ id: 'a', createdAt: daysAgo(1) })]);
    expect(section()?.textContent).toContain('完成 0 条');
  });

  /**
   * **口径必须写在界面上。** 删除是软删除，任务进了 `data/trash/`、不在
   * `data/tasks/` 里，所以「新进来」不含「建了又删掉」的那些——`net` 因此
   * 偏向乐观。这一条不修（读 `trash/` 能补准，但那份数据在前端是按需拉的、
   * 可能滞后），改成把这句说出来。
   */
  it('**说清这个数不含什么**——宁可让人知道口径，也不要让它看起来比实际准', () => {
    show([task({ id: 'a', completedAt: daysAgo(1) })]);
    expect(section()?.textContent).toContain('不含已经删掉的');
  });

  /**
   * **不上群青。** 群青是配给给 AI 产出的内容的（`theme.css` 顶部），而这一节
   * 是从 `completedAt`/`createdAt` 现算出来的结构性事实。类名一改，字还在、
   * 颜色静默变成群青，别的断言都不会红——所以单独盯一条。
   */
  it('数字不上群青——它是本地算的事实，不是 AI 写的观察', () => {
    show([task({ id: 'a', completedAt: daysAgo(1) })]);
    const p = document.querySelector('.ink-review-pace-text') as HTMLElement;
    expect(p.textContent).toContain('完成 1 条');
    expect(p.classList.contains('ink-review-text')).toBe(false);
  });

  /**
   * **它排在最前面**：先给坐标（这一周过得怎么样），再看清单（有什么要我决定
   * 的）。摆在一串债后面就成了安慰，摆在前头才是前提。
   */
  it('排在最前面——先给坐标，再看清单', () => {
    show([task({ id: 'a', completedAt: daysAgo(1), due: daysAgo(3) })]);
    const heads = [...document.querySelectorAll('.ink-review-stalled-h')].map((h) => h.textContent);
    expect(heads[0]).toContain('这一周的进出');
    // 「N 条已经过期」那一行确实在（不然这条测的是个空屏）。
    expect(document.querySelector('.ink-review-todo')).not.toBeNull();
  });

  /**
   * **只有进出、别的什么都没有时，不说「还没有回顾」。** 那句话说的是「AI 还
   * 没产出过观察」，他读到的却是「这里什么都没有」——而他刚刚明明做完了八件
   * 事。有进出数据就不是空状态。
   */
  it('只有进出数据时不说「还没有回顾」——那句话会读成「你什么都没干」', () => {
    show([task({ id: 'a', status: 'done', completedAt: daysAgo(1) })]);
    expect(screen.queryByText(/还没有回顾/)).toBeNull();
    expect(section()?.textContent).toContain('完成 1 条');
  });

  /** 窗口长度写在 `title` 里现算，不写进标题——标题里没有数字，所以
   *  `THROUGHPUT_DAYS` 改成 14 也不会让那句话变成假的。 */
  it('标题里没有天数，天数在 title 上现算', () => {
    show([task({ id: 'a', completedAt: daysAgo(1) })]);
    const h = screen.getByRole('heading', { name: '这一周的进出' });
    expect(h.textContent).toBe('这一周的进出');
    expect(h.getAttribute('title')).toContain(String(THROUGHPUT_DAYS));
  });
});

/**
 * **「一拖再拖」**——改过好几次期还在原地的。
 *
 * `postponeCount` 早就在数了，推荐面板那组也早把这几条摆出来了；**缺的从来
 * 不是「没有地方看」，是「没有地方做那个决定」**——那个面板给的唯一动作是
 * 「加到今天」，而那正是他做过八次的那个动作。这一节要的是「还要不要它」。
 * 判据在 `lib/weeklyReview.ts` 的 `postponedToReview`（那边另有测试）。
 */
describe('ReviewView：一拖再拖', () => {
  const show = (tasks: Task[], onReviewed = vi.fn()) => {
    render(<ReviewView
      insights={[]} tasks={tasks} inbox={[]} now={NOW_REVIEW}
      onDismiss={vi.fn()} onOpen={vi.fn()} onGo={vi.fn()}
      onReviewed={onReviewed} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    return onReviewed;
  };
  const section = () => document.querySelector('.ink-review-postponed') as HTMLElement | null;

  it('列出那几条，标题上带条数', () => {
    show([task({ id: 'a', title: '交房租', postponeCount: POSTPONE_MIN + 6 })]);
    expect(screen.getByRole('heading', { name: /一拖再拖/ }).textContent).toContain('1');
    expect(screen.getByRole('button', { name: '交房租' })).toBeTruthy();
  });

  it('门槛以下的不进——差一次就是差一次', () => {
    show([task({ id: 'a', title: '交房租', postponeCount: POSTPONE_MIN - 1 })]);
    expect(section()).toBeNull();
  });

  /** **次数要看得见。** 这一组的信息量全在那个数字上（判据就是按它排的序），
   *  只活在 `title` 里等于没有。 */
  it('每一条旁边写着推了多少次', () => {
    show([task({ id: 'a', title: '交房租', postponeCount: POSTPONE_MIN + 6 })]);
    expect(document.querySelector('.ink-review-postponed-count')?.textContent)
      .toContain(String(POSTPONE_MIN + 6));
  });

  /** **说清「再推一次不是答案」**——不然这一节看起来就是同一份「今天该做
   *  什么」清单的第三个版本，而它会跟推荐面板那组长得一模一样。 */
  it('说清缺的不是再推一次，是决定它还要不要', () => {
    show([task({ id: 'a', postponeCount: POSTPONE_MIN })]);
    const why = document.querySelector('.ink-review-postponed .ink-review-stalled-why')?.textContent ?? '';
    expect(why).toContain('再推一次');
    expect(why).toContain('搁置');
    expect(why).toContain('放弃');
  });

  it('点标题打开那条任务', () => {
    const onOpen = vi.fn();
    render(<ReviewView
      insights={[]} tasks={[task({ id: 'a', title: '交房租', postponeCount: POSTPONE_MIN })]}
      inbox={[]} now={NOW_REVIEW} onDismiss={vi.fn()} onOpen={onOpen} onGo={vi.fn()}
      onReviewed={vi.fn()} onReview={vi.fn()} onBoard={vi.fn()} reviewing={false} />);
    fireEvent.click(screen.getByRole('button', { name: '交房租' }));
    expect(onOpen).toHaveBeenCalledWith('a');
  });

  it('每一条旁边都有一颗「看过了」，点了把那条的 id 交出去', () => {
    const onReviewed = show([task({ id: 'a', title: '交房租', postponeCount: POSTPONE_MIN })]);
    fireEvent.click(screen.getByRole('button', { name: '看过了' }));
    expect(onReviewed).toHaveBeenCalledWith('a');
  });

  it('盖过章的那一条整个不显示，这一节跟着消失', () => {
    show([task({ id: 'a', title: '交房租', postponeCount: POSTPONE_MIN, reviewedAt: NOW_REVIEW.toISOString() })]);
    expect(screen.queryByRole('heading', { name: /一拖再拖/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '交房租' })).toBeNull();
  });

  /**
   * **跟「知道了」分得清。** 那一颗是给 AI 观察用的（点了写 `dismissedAt`，
   * 意思是「这条观察我不认」）；这一颗承认事实、只是为它做了决定。跟「卡住的
   * 项目」那一段是同一条规矩。
   */
  it('这一段里没有「知道了」——那颗是给 AI 观察的，不是给事实的', () => {
    show([task({ id: 'a', postponeCount: POSTPONE_MIN })]);
    expect(within(section()!).queryByRole('button', { name: '知道了' })).toBeNull();
  });

  /** 清单上那一行**不做成按钮**，跟「卡住的项目」同一个理由：下面那一段就
   *  列着它们，而这一节要的那个决定在卡片的 ⋯ 里，跳走反而离答案更远。 */
  it('清单上那一行不做成按钮——答案就在下面那一段里', () => {
    show([task({ id: 'a', postponeCount: POSTPONE_MIN })]);
    expect(screen.queryByRole('button', { name: /条改过/ })).toBeNull();
    expect(document.querySelector('.ink-review-todo-flat')?.textContent).toContain('一直没动');
  });

  /** **只有这一节有内容时，也不该显示空状态那句话。** 空状态判据漏了这一节
   *  的话，屏上会同时出现「还没有回顾」和一条列着的任务。 */
  it('只有这一节有内容时，不说「还没有回顾」', () => {
    show([task({ id: 'a', postponeCount: POSTPONE_MIN })]);
    expect(screen.queryByText(/还没有回顾/)).toBeNull();
  });
});
