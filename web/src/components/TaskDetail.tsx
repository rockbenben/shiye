import { useEffect, useRef, type ComponentProps } from 'react';
import { Button } from 'antd';
import { TaskCard } from './TaskCard.js';
import { listLabel } from '../lib/listIcon.js';

/**
 * 右边那一栏详情面板（仿滴答清单第三栏）。
 *
 * **它不是第二个编辑器，是同一张卡的另一个位置。** 里面渲染的就是
 * `TaskCard`——查看态、编辑表单、附件、AI 建议、状态按钮、番茄钟，一件都
 * 没重做。这一点是有意的：这个仓库最贵的一类缺陷是「同一件事有两份实现，
 * 其中一份没跟上」（`statusLabel.guard.test.ts` 记着两次账），而一个从零
 * 搭的详情面板注定是 `TaskCard` 的第二份、注定漏掉刚加的那个字段。
 *
 * 换来的是那件行档里做不到的事：**列表不动。** 原来在行档点一条任务，那一行
 * 当场膨胀成一张卡，它下面所有任务往下跳一大截——你正要点的下一条跑了。详情
 * 挪到固定的一栏里，列表一个像素都不动，而且点第二条、第三条时详情在同一个
 * 地方换内容，眼睛不用重新找。
 *
 * props 直接是 `TaskCard` 的那一份（`ComponentProps`）再加一个 `onClose`，
 * 不手抄一遍：`TaskCard` 以后加 prop，这里不用改一个字。
 *
 * **形状是滴答清单那一张**（`detail` 那个 prop）：顶上勾选圈 + 日期，下面
 * 大标题，再下面一整块正文，最底下一条「归在哪个清单」。上面那句话仍然成立
 * ——那张形是 `TaskCard` 的一个形态，不是这里另画的一份，判据见
 * `CardProps.detail` 的注释。这个文件自己只多画那条页脚。
 */
type Props = ComponentProps<typeof TaskCard> & {
  onClose: () => void;
};

export function TaskDetail({ onClose, ...card }: Props) {
  // 打开时把焦点收进来。**键盘走得通是这个面板成立的前提**——不收焦点的话，
  // 用键盘打开一条任务之后，焦点还留在刚才那一行上，Tab 要穿过整份列表才
  // 走到这里，而 Esc 该关掉的那个东西根本没被"进入"过。
  //
  // 依赖是 `card.t.id` 而不是 `card.t`：换看另一条任务时重新收一次焦点是对的
  // （面板换了内容），而同一条任务因为一次 patch 重新渲染时不该把焦点从他
  // 正在打字的输入框里抢走——`t` 每次 patch 都是新对象，列它就是每次抢一次。
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.focus(); }, [card.t.id]);

  // 归到哪个清单。找不到（清单被删了）就当没有——显示一个裸 uuid 对人没有
  // 意义，跟 TaskCard.tsx / TaskRow.tsx 那两份一字不差。
  const list = card.t.listId ? card.lists.find((l) => l.id === card.t.listId) : undefined;

  return (
    // tabIndex=-1：能被 .focus() 收进来，但不进 Tab 顺序——它是一块区域，
    // 不是一个控件，出现在 Tab 序列里只会多一次没有意义的停留。
    <aside className="ink-detail" aria-label="任务详情" tabIndex={-1} ref={ref}>
      <div className="ink-detail-head">
        <span className="ink-detail-title">任务详情</span>
        {/* 「关闭」不是「删除」：这一颗只把面板收起来，任务一个字都不动。
            写成文字而不是一个 × 字形——这一栏里同时还有卡片自己那颗「删除」，
            两个都只有一个字形的时候，点错的那一次是不可逆的。 */}
        <Button size="small" type="text" onClick={onClose}>关闭</Button>
      </div>
      <TaskCard {...card} detail />
      {/* 页脚：这条归在哪个清单（仿滴答清单面板最底下那一条）。**这一栏里
          「它属于什么」只说这一处**——卡片里那个清单小标签在 `detail` 下不
          再画，见 TaskCard.tsx 那处的注释。
          清单名前的圆点/emoji 跟侧栏、卡片同一条规矩（`lib/listIcon.ts`）。
          没归到任何清单的任务也照样画这条：空着的页脚会让人以为它坏了，而
          「不属于任何清单」本身是这个应用里一个正当的、到处都在用的说法
          （FilterBar/BatchBar 的下拉里都是这个词）。 */}
      <div className="ink-detail-foot">
        {list ? (
          <span className="ink-list-name">
            {listLabel(list.name).icon
              ? <span className="ink-list-emoji">{listLabel(list.name).icon}</span>
              : <span className="ink-list-dot" style={{ backgroundColor: list.color }} aria-hidden="true" />}
            {listLabel(list.name).text}
          </span>
        ) : (
          <span className="ink-list-name ink-detail-foot-none">不属于任何清单</span>
        )}
      </div>
    </aside>
  );
}
