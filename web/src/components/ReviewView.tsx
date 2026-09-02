import type { ReactNode } from 'react';
import { Button } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import type { Insight, InboxItem, SmartFilter, Task } from '../types.js';
import { isSettled, REVIEWED_QUIET_DAYS } from '../lib/taskView.js';
import { stalledToReview, weeklyReview } from '../lib/weeklyReview.js';

const KIND_LABEL: Record<Insight['kind'], string> = {
  pattern: '反复出现',
  duplicate: '可能重复',
  stuck: '卡住了',
  note: '',
};

interface Props {
  insights: Insight[];
  tasks: Task[];
  /** 「这一周该过一遍的」第一行要数没处理的条目，见 lib/weeklyReview.ts。 */
  inbox: InboxItem[];
  now: Date;
  onDismiss: (id: string) => void;
  /** 点关联任务：切到那条任务所在的去处。 */
  onOpen: (taskId: string) => void;
  /**
   * 「卡住的项目」某一条点了「看过了」：给它盖一个 `reviewedAt` 的章，
   * 这一屏此后 `REVIEWED_QUIET_DAYS` 天不再拿它烦人。仿 OmniFocus 的
   * Mark Reviewed，完整理由见 `types.ts` 里 `Task.reviewedAt` 那段。
   */
  onReviewed: (taskId: string) => void;
  /**
   * 清单上某一行点了：切到那个去处（`viewFromHash` 那套 key），`filter` 非空时
   * 先把筛选栏设成它——不然「1 条在等别人」点过去落在「全部」的十九条里，
   * 人还得自己找那一条。判据在 lib/weeklyReview.ts 的 `ReviewRow.filter`。
   */
  onGo: (view: string, filter?: Partial<SmartFilter>) => void;
  /** 点「让 AI 回顾一遍」：`POST /api/review`，服务端去叫 AI（起 `claude` 子进程，
   *  或者按设置调接口，见 server/src/expand.ts）。 */
  onReview: () => void;
  /**
   * AI 这会儿正在跑。**拆解和回顾共用服务端那把单飞锁**（见 server/src/expand.ts
   * 顶部 `AgentKind` 的注释），所以这个值就是 `agent?.state === 'running'`，
   * 不分是哪一件——正在拆解时点回顾照样会被 409 掉，那就干脆先别让点。
   */
  reviewing: boolean;
}

/**
 * 「还没被点过『知道了』的观察」，新的在前。
 *
 * 服务端 GET /api/insights 已经把 dismissedAt 非空的滤掉了（第一道、也是
 * 真正生效的那道防线，见 server/src/app.ts 那条路由的注释）——这里再滤一遍
 * 是第二道保险，不是重复劳动：props 可能被 stale 的缓存/旧响应喂脏（比如
 * SSE 还没来得及触发 reload），界面这一层挡一下不会有坏处。生产环境正常
 * 链路下这一行永远不会真的滤掉任何东西。
 *
 * **导出**是因为 `App.tsx` 也要问同一个问题：底部那条 `/review` 指路要不要
 * 挂，取决于「这个视图这一刻显示的是不是空状态」。两边各写一遍
 * `filter(i => !i.dismissedAt)` 就是两份可以各自改漏的判据——空状态的口径
 * 将来一变（比如加上「只算最近 N 天的」），漏改一处的表现是那句指路要么
 * 跟空状态同屏说两遍、要么两边都不说，而两种都不会让任何测试变红。
 */
export function openInsights(insights: Insight[]): Insight[] {
  return insights
    .filter((i) => !i.dismissedAt)
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

export function ReviewView({ insights, tasks, inbox, now, onDismiss, onOpen, onReviewed, onGo, onReview, reviewing }: Props): ReactNode {
  const open = openInsights(insights);
  /**
   * **卡住的项目**——GTD 每周回顾专门要查的那一条：一个还挂着的项目，底下
   * 一个能动的下一步都没有。判据在 `lib/hierarchy.ts` 的 `stalledProjects`。
   *
   * **这一段不是 AI 产出的**，是从任务本身现算的结构性事实，所以一个群青都
   * 不上（群青是配给给 AI 产出的内容的，见 theme.css 顶部）。
   *
   * ## 「看过了」不是「知道了」
   *
   * 这里原来一颗按钮都没有，理由写着：「它描述的是此刻的事实，人去动了那个
   * 项目它自己就消失，没动就该一直在。」**那句话对了一半。** 对的是不能有
   * 「知道了」——AI 观察那颗点下去写 `dismissedAt`，意思是「这条观察我不认」，
   * 而一个事实不该能被不认。
   *
   * 漏掉的是第三条路：**「我看过了，就这样。」** 一个卡住的项目，除了「去处理
   * 它」之外，人完全可能得出「现在维持原样是对的」这个结论——而在那之后，
   * 这一屏每周都把同一条摆在他面前，问的是一个他已经答过的问题。一份劝不动
   * 你的清单，久了就整份不再被当真，而这一屏存在的全部意义就是被当真。
   *
   * 所以「看过了」跟「知道了」形状像、意思相反：后者否认一条观察，前者承认一个
   * 事实**并且为它做了决定**。它也不是永久的——`REVIEWED_QUIET_DAYS` 天之后
   * 这一条自己回来（仿 OmniFocus 的 Mark Reviewed + 复查间隔，见
   * 《Perspectives》）。
   *
   * 判据不在这儿写：`stalledToReview` 一个出口，下面那份「这一周该过一遍的」
   * 里的数字用的是同一个——不然会出现「清单上写 3 条、底下只列出 1 条」。
   */
  const stalled = stalledToReview(tasks, now);
  /**
   * 「这一周该过一遍的」——GTD 每周回顾那份清单。判据一条都不在这儿写，
   * 全在 lib/weeklyReview.ts，而那边每一行又都调既有的那个判据函数。
   */
  const todo = weeklyReview(tasks, inbox, now);

  /**
   * **「让 AI 回顾一遍」这颗按钮。**
   *
   * 原来这儿是一句指路：「在这个文件夹里敲 `/review`」。那句话漏掉了两样人根本
   * 猜不出来的东西——是哪个工具（Claude Code，界面上没有任何地方能「敲」），
   * 以及是哪个文件夹（装了桌面版的话是 `%APPDATA%\shiye\agent`）。一条谁都
   * 执行不了的说明，等于这个能力不存在。
   *
   * 原先「刻意不做成按钮」的理由是「回顾要花一两分钟和一次订阅额度，一颗按钮
   * 就是一次误触的距离」。这个理由在应用内部本来就不自洽：**「立即拆解」就是
   * 按钮**，同样叫一次 AI、同样烧一次额度。而拆解那颗防误触靠的不是
   * 确认框，是「待拆解为 0 时置灰」——这里照抄那个做法：一条还挂着的任务都
   * 没有时置灰，因为 `workflows/review.md` 要看的四类（过期没做完的、doing 里
   * 躺很久的、反复出现的同类、卡住的项目）全都以「有还没了结的任务」为前提。
   */
  const hasLive = tasks.some((t) => !isSettled(t));
  const runButton = (
    <Button
      size="small"
      icon={<EyeOutlined />}
      loading={reviewing}
      disabled={reviewing || !hasLive}
      onClick={onReview}
    >
      让 AI 回顾一遍
    </Button>
  );
  /* 按钮旁边那句话说的是「点下去会发生什么」，三种状态各说各的实话：正在跑的
     时候报时长（一两分钟不算短，没这句人会以为卡死了，跟「立即拆解」那行提示
     同一个理由）；能点的时候说清「只提建议、不直接改」——这是他点之前最该
     知道的一件事；置灰的时候说清为什么灰，不留一颗没有解释的死按钮。 */
  const runHint = reviewing
    ? 'AI 正在回顾，一般要一两分钟……'
    : hasLive
      // **不在这儿列它能改哪几样。** 上一版写的是「只提改期、拆细的建议」，
      // 而 `PROPOSABLE` 有十二个字段（标题/备注/截止/开始/提醒/子任务/标签/
      // 清单/重复/优先级/在等谁/情境）——那句话把十个说成了不能提，跟 README
      // 那句「只能改这五样」是同一个形状的错（那次少报了七个，之后才有
      // `agentsMd.guard.test.ts`）。
      //
      // 修法不是把十二个塞进一句短提示（那是烂文案，而且下一个字段加进来照样
      // 会飘），是**整个不列**：短文案里没有清单，就没有会飘的东西。完整名单在
      // README「让 AI 回头看一遍已有的任务」那节，有守卫盯着。
      //
      // 「只」的着力点因此回到它本来该在的地方：**只提建议、不直接改**——那才是
      // 他按下去之前最该知道的一件事。
      ? '它只提建议，挂在对应的那张卡片上，等你点「接受」才算数——不会直接改任务。'
      : '现在一条还挂着的任务都没有，没什么可回顾的。';
  const runBlock = (
    <p className="ink-review-nudge ink-review-run">
      {runButton}
      <span className="ink-review-run-hint">{runHint}</span>
    </p>
  );

  // 空状态直接把「怎么让它有内容」说完。原来那句「让 AI 跑一遍分析之后会
  // 出现在这里」只描述了状态、没给出口，真正的做法写在页面底部那条脚注里
  // （App.tsx 的 .ink-review-nudge），而那条脚注在这个视图上已经不再渲染
  // ——两句话说同一件事、又各说一半。
  if (open.length === 0 && stalled.length === 0 && todo.length === 0) {
    return (
      <>
        {/* 空状态只说「这一屏将来会有什么」，「怎么让它有」交给下面那颗按钮——
            以前这两件事挤在同一句话里，那句话还得靠一条没人执行得了的终端命令
            收尾。**这一屏的空状态和有内容时用的是同一颗按钮**，位置也一样在
            底部：一个出口在两种状态下长在两个地方，人会以为那是两件事。 */}
        <p className="ink-empty-note">
          还没有回顾。跨任务的观察会出现在这里，针对某一条的建议挂到那张卡片上。
        </p>
        {runBlock}
      </>
    );
  }

  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title;

  const todoBlock = todo.length === 0 ? null : (
    <section className="ink-review-todo" aria-labelledby="ink-review-todo-h">
      <h2 className="ink-review-stalled-h" id="ink-review-todo-h">这一周该过一遍的</h2>
      <ul className="ink-review-todo-list" role="list">
        {todo.map((r) => (
          <li key={r.key}>
            {/* 能跳的做成按钮，不能跳的就是一句话——**不给一个点了没反应的
                入口**（这个仓库反复写的那条）。「卡住的项目」那一行故意不跳：
                下面那一段就列着它们，跳走反而是把人带离答案。 */}
            {r.go
              ? <button type="button" className="ink-review-link" onClick={() => onGo(r.go!, r.filter)}>{r.text}</button>
              : <span className="ink-review-todo-flat">{r.text}</span>}
          </li>
        ))}
      </ul>
    </section>
  );

  const stalledBlock = stalled.length === 0 ? null : (
    <section className="ink-review-stalled" aria-labelledby="ink-review-stalled-h">
      <h2 className="ink-review-stalled-h" id="ink-review-stalled-h">卡住的项目 {stalled.length}</h2>
      {/* 把「为什么它算卡住」说出来，不只是列一串标题——这几条在列表里跟别的
          待办长得一模一样，人点进去也未必看得出问题出在哪：卡片上写着
          「子任务 0/2」，那句话说的是「还没做完」，不是「没有下一步了」。 */}
      <p className="ink-review-stalled-why">
        底下一个能动的下一步都没有——子任务不是搁置就是放弃了，而它自己还挂着。挑一条捡回来，或者把这个项目本身也搁置/放弃掉。
      </p>
      <ul className="ink-review-stalled-list" role="list">
        {stalled.map((t) => (
          <li key={t.id}>
            <button type="button" className="ink-review-link" onClick={() => onOpen(t.id)}>
              {t.title}
            </button>
            {/* 天数写进 `title` 而不是按钮文案里：按钮上一个数字会让人以为
                那是可选的档位。**读的是同一个常量**——文案写死 7、改的却是
                别的数，那句话会当场变成假的（提醒横幅那颗「稍后 N 分钟」
                为这件事留过一整段注释）。 */}
            <button
              type="button"
              className="ink-review-dismiss"
              title={`给它盖个「看过了」的章，${REVIEWED_QUIET_DAYS} 天内这一屏不再问你。它本身一个字都不会变。`}
              onClick={() => onReviewed(t.id)}
            >
              看过了
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  /**
   * **「怎么再跑一遍」这句话，这一屏自己常驻。**
   *
   * 它原来只长在空状态里，于是「回顾上摆着东西的时候，怎么再跑一次」这个出口
   * 落在了 `App.tsx` 底部那条脚注上——而那条脚注**说的是另一件事**（「有 N 条
   * 过期了」），两句隔着几十像素上下摆着，一句话说了两遍。
   *
   * 收进来之后 `App` 那边可以干脆在这一屏闭嘴（`view !== 'review'`），不用再
   * 去猜「那边这一刻是不是空的」——那个判据在加了「这一周该过一遍的」之后
   * 已经**永远为假**了：脚注只在有过期任务时出现，而有过期任务就意味着清单
   * 里有「N 条已经过期」那一行，这一屏就不是空的。
   */
  if (open.length === 0) return <>{todoBlock}{stalledBlock}{runBlock}</>;

  return (
    <>
    {todoBlock}
    {stalledBlock}
    <ul className="ink-review-list" role="list">
      {open.map((i) => (
        <li className="ink-review-item" key={i.id}>
          {KIND_LABEL[i.kind] && <span className="ink-review-kind">{KIND_LABEL[i.kind]}</span>}
          {/* 正文上群青：这是 AI 产出的新信息，正是双色墨水里群青该出现的
              地方。整个应用里群青是配额制的，见 theme.css 顶部。 */}
          <p className="ink-review-text">{i.text}</p>
          <div className="ink-review-foot">
            {i.taskIds.map((id) => {
              const title = titleOf(id);
              // 任务已经被删掉了就不列——显示一个裸 uuid 对人没有意义。
              if (!title) return null;
              return (
                <button type="button" className="ink-review-link" key={id} onClick={() => onOpen(id)}>
                  {title}
                </button>
              );
            })}
            <button type="button" className="ink-review-dismiss" onClick={() => onDismiss(i.id)}>
              知道了
            </button>
          </div>
        </li>
      ))}
    </ul>
    {runBlock}
    </>
  );
}
