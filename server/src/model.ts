/**
 * **数据模型：类型、常量、默认值。这个文件不碰任何 node 内置，也不许碰。**
 *
 * 它是从 `store.ts` 里切出来的。切的理由是一次实打实的白屏：`store.ts` 同时
 * 是「数据模型」和「磁盘层」（`dataDir`/`paths`/`readTasks`/…），而网页这边
 * 按既有约定直接引 `server/src/*.js` 共用纯逻辑（`dataSource.ts` 引 `mutate.js`
 * 是最早那条）。于是这样一条链成立了：
 *
 * ```
 * web/src/lib/habit.ts  →  store.js            （为了一个 HABIT_EVERY）
 * web/src/lib/dataSource.ts → mutate.js → task.js → store.js
 * ```
 *
 * `store.ts` 顶层有一句 `const here = dirname(fileURLToPath(import.meta.url))`。
 * Vite 把 `node:url` externalize 成浏览器里的空壳，于是打包出来的网页**一加载
 * 就抛 `TypeError: fileURLToPath is not a function`，React 根本没 mount——整页
 * 白屏**。而 `npm test` 跑在 node 里（那个函数真实存在）、typecheck 和 build
 * 都不执行这一行，四千多条测试全绿。
 *
 * **所以规矩是：凡是网页也要用的东西，放这儿；碰 `node:` 的放 `store.ts`。**
 * 这条规矩由 `webBundle.guard.test.ts` 机械盯着——它从 `web/src` 出发沿值导入
 * 走一遍传递闭包，任何能被网页够到的模块只要引了 `node:` 内置就红，并把整条
 * 链路打出来。别改成「记得别引」，那正是这次没守住的东西。
 *
 * `store.ts` 仍然 `export * from './model.js'`，所以服务端那几十处
 * `from './store.js'` 一个字都不用改——它对服务端仍然是一站式的那个入口。
 */

export type Status = 'todo' | 'doing' | 'done' | 'later' | 'abandoned';

/**
 * GTD 的「情境」：这件事得在什么条件下才干得了。固定几档，不是自由文本——
 * 自由文本等于又一套标签，而标签这个应用已经有了（`tags`）。
 *
 * 值是英文 key，中文名只活在界面那一层（web 的 `CONTEXT_LABEL`）：落到
 * `data/tasks/` 的东西不该跟界面语言绑死，改一次文案不该动一遍所有任务文件。
 */
export type TaskContext = 'computer' | 'out' | 'home' | 'contact' | 'easy';

/**
 * 一周从周几开始（仿滴答清单「日期与时间 → 每周开始于」，它给的就是这三档）。
 * `1` = 周一（默认，也是加这个设置之前写死的值），`0` = 周日，`6` = 周六。
 *
 * **提成一个具名类型、而不是在用到的地方各写一遍 `0 | 1 | 6`**：这个值有五个
 * 消费方（日历格、月视图表头、周视图表头、专注统计的「本周」、习惯热力图的
 * 列对齐），字面量各写一份的话，加一档就要五处跟上，漏一处不会编译报错、
 * 只会让那一处静默停在旧的档位集合上。`TaskContext` 上面那段说的是同一件事。
 */
export type WeekStart = 0 | 1 | 6;


export interface Subtask {
  text: string;
  done: boolean;
}

/** 一次提醒。`firedAt` 是服务发完提醒之后自己盖的章，AI 和网页都不写它。 */
export interface Reminder {
  at: string;
  firedAt: string | null;
}

/** 一次番茄钟。只增不改；中途放弃的不写进来——记了会污染回顾用的数据。 */
export interface FocusSession {
  startedAt: string;
  minutes: number;
}

/**
 * 重复规则。**用结构化对象不用 RRULE 字符串**：RRULE 是为跨系统交换设计的，
 * 这里没有第二个系统。对象好校验，AI 也好写——让它输出
 * `FREQ=WEEKLY;BYDAY=MO` 迟早会拼错，而且拼错了看不出来。
 *
 * `from` 是「下一次从哪儿算起」，仿滴答清单的「到期重复 / 完成重复」：
 * - `'due'`（默认，到期重复）：从这一条的 `due` 往后推。周期不会漂——
 *   「每周一写周报」拖到周三才写完，下一条还是下周一。
 * - `'done'`（完成重复）：从**完成的那一刻**往后推。「每三天健身一次」
 *   周五耽搁了、周六才做，下一次是周二不是周一。
 *
 * 只有这两种，没有 RRULE 那套。缺这个字段的老数据一律当 `'due'`（迁移和
 * 校验都落这个默认值），行为跟加它之前一字不差。
 *
 * `every: 'ebbinghaus'` 是艾宾浩斯记忆法（背单词那种）：间隔不固定，按遗忘
 * 曲线越拉越长。这一档下 `interval`/`weekdays` 都用不上，走到第几步看
 * `step`——**只有这一档会读 `step`**，别的四档它恒为 0、也没人看。间隔表和
 * 它是怎么从帮助文档那句「1，2，4，7，15」推出来的，见 `repeat.ts` 的
 * `EBBINGHAUS_GAPS`。
 *
 * `count` 是「**还要再重复几次**」，仿滴答清单的「按次数结束重复」。`null`
 * 是一直重复（默认）。**存的是剩余次数不是总次数**：每生成一条新实例就减一，
 * 减到 0 就不再生成——总次数要在每条实例上额外记「已经第几次了」，两个字段
 * 才拼得出一个数，而剩余次数一个字段就自解释，卡片上「还剩 3 次」也是人真正
 * 想知道的那个数。`until`（重复到某天为止）和它可以同时设，谁先到算谁的。
 *
 * `monthDay` 是**月重复锚在几号**（1-31），`null` = 没记过。它跟 `weekdays`
 * 是一对：周重复靠 `weekdays` 记住「每周几」，月重复在这之前什么都不记，
 * 只能从当前那条的 `due` 现看——于是「每月 31 号」过一次二月就**永久漂成
 * 28 号**（31 号 clamp 到 2/28，下一次再从 28 算，三月就是 28 号了）。
 * 记住锚点之后，二月照旧 clamp 到 28，三月能回到 31。
 *
 * 没记过的老数据（这个字段之前写下的、或者在表单里点出来的月重复）由
 * `nextOccurrence` 在第一次推进时用当前那天补上，不用迁移、也不用在表单里
 * 多摆一个控件——那一天正是他自己定的锚。
 */
/**
 * 重复能按哪些周期走。**这份联合类型是它唯一的一份声明**——`task.ts` 的校验器
 * 原来手抄了一个 `['day', 'week', ...]` 数组，那是同一个集合的第二份定义：加一档
 * 而没跟上，表现是「表单里选得出来、保存回来 400」，编译器一个字都不会说。
 * 现在校验器读 `REPEAT_KINDS`（server 那边跟这个类型同源的运行时数组）。
 *
 * 后四档是这一轮按滴答清单补的（《设置重复任务》）：
 *
 * - `'lunar-year'` / `'lunar-month'`：农历每年 / 每月。春节、中秋、家人的农历
 *   生日、初一十五——公历重复表达不了，每年会漂十几天。
 * - `'workday'`：法定工作日。**避开周末和法定假期，但补班那几天算**
 *   （2026-10-10 就是这么一天）。跟「每周一到周五」不是一回事，后者用
 *   `every: 'week'` + `weekdays: [1,2,3,4,5]` 就够了。
 * - `'holiday'`：法定节假日，放假通知点名的那几天，**不含普通周六周日**
 *   （那是「每周末」，同样用 weekdays 表达）。
 *
 * 后两档的数据是**发布出来的、不是算出来的**（国务院办公厅每年下半年发一次
 * 下一年的通知），所以它们有一个别的档没有的性质：**存在一个「往后算不下去」
 * 的年份**。到了表的边界 `nextOccurrence` 返回 `null`，这一条重复就此结束；
 * 而校验器拒绝一开始就落在表外的规则，见 `chineseDays.ts` 顶部那段。
 */
export type RepeatKind =
  | 'day' | 'week' | 'month' | 'year' | 'ebbinghaus'
  | 'lunar-year' | 'lunar-month' | 'workday' | 'holiday';

/**
 * 上面那个联合类型的运行时那一份，**给校验器用**。
 *
 * 写成 `satisfies readonly RepeatKind[]` 再由 `RepeatKind` 反过来钉住长度是做不到的
 * （TS 没有「这个数组必须穷举这个联合」的原生断言），所以配了一条守卫测试盯着
 * 两边一样长——见 `repeat.test.ts` 里那条。**这是这个仓库里唯一一份可枚举的
 * 重复档位名单**，校验器和界面都从这儿拿。
 */
export const REPEAT_KINDS = [
  'day', 'week', 'month', 'year', 'ebbinghaus',
  'lunar-year', 'lunar-month', 'workday', 'holiday',
] as const satisfies readonly RepeatKind[];

/**
 * **哪些重复档能当习惯——这个仓库里唯一一份名单。**
 *
 * 跟 `REPEAT_KINDS` 一样放在这儿，是因为**两个包都要问这个问题**：服务端的
 * 校验器（`task.ts`：`habit: true` 配不上重复档就拒收）和网页（表单上出不出
 * 那个勾选框、习惯页收不收这条、日历画不画打卡记号）。web 一直是直接引
 * `server/src/*.js` 的（`dataSource.ts` 引 `mutate.js` 是同一条路），
 * 反过来引不动。
 *
 * 从「只有每天」放宽到「每天或每周」时这件事真的飘过：判断当时散在七个地方，
 * 只改到五个——`App.tsx`（新建）和 `TaskCard.tsx`（保存）那两句还写着
 * 「不是每天就把记号抹掉」，于是一条每周的习惯**表单里勾得上、一按保存就没了**，
 * 两边都编译得过、也没有任何一处报错。`web/src/lib/habitKind.guard.test.ts`
 * 现在盯着别处不许再写一遍。
 *
 * 「每月打卡」不算习惯——那是一条普通的重复任务。加第三档之前先想一遍月度
 * 打卡表和连续周期怎么算。
 */
export const HABIT_EVERY = ['day', 'week'] as const satisfies readonly RepeatKind[];

/**
 * **这个重复档能不能当习惯——判据在这儿，只在这儿。**
 *
 * 原来这一句写在 `web/src/lib/habit.ts` 里，只有网页那边问得到。服务端也要问
 * 同一个问题（`mutate.ts` 合并 patch 之后要看这条任务还算不算习惯），而在那边
 * 照着 `HABIT_EVERY` 再写一遍，正是 `habitKind.guard.test.ts` 拿一次真实分叉
 * 换来的那条教训——只不过它扫的是 `web/src`，服务端这一份它看不见，飘了也
 * 不会有人说一声。搬到名单旁边，两个包引的就是同一份。
 *
 * `web/src/lib/habit.ts` 继续导出这个名字（转出去的），网页那边的调用点不用改。
 */
export const canBeHabit = (repeat: Repeat | null | undefined): boolean =>
  repeat != null && HABIT_EVERY.includes(repeat.every as never);

export interface Repeat {
  every: RepeatKind;
  interval: number;
  weekdays: number[];
  until: string | null;
  from: 'due' | 'done';
  count: number | null;
  step: number;
  monthDay: number | null;
}

/**
 * 一条任务。
 *
 * `pinned`（置顶，仿滴答清单）跟 `order`/`priority` 同一类——**是人的判断，
 * AI 写了不算数**（`outbox.ts` 的 `stripForced` 会摘掉）。置顶只在「摆得下
 * 一个顺序」的地方生效：平铺列表和看板格子里排到最前，日历/四象限那种按
 * 时间/象限落位的地方没有「最前」可言，不受影响。
 *
 * `parentId`（多级任务，仿滴答清单）**最多五层**，跟它那边一样
 * （《多级任务》：「现阶段，我们只允许5级任务嵌套，超过该上限
 * 则不能继续添加」）。上限、环检测和深度判据都在 `mutate.ts` 的
 * `checkParentLink`，两条 PATCH 路由和 POST 共用那一份。
 *
 * 这个应用原来**只做一层**，理由是「十二个视图各自要处理无限层级的缩进和
 * 排序」。放开之后那个成本是真付掉了：树工具（`descendantIds` / `depthOf` /
 * `subtreeHeight`）、四条连带全部走整棵子树、`nestChildren` 深度优先展开、
 * 候选表直接问 `checkParentLink`。行/卡上那对层级记号不用改——它们是**关系式**
 * 的（「↳ 父亲的标题」+「n/m」），不是按缩进画的，天然支持任意层数。
 *
 * **超了是拒绝，不是压平**：压平会静默改掉他已经建好的结构，而那不可逆。
 *
 * **也不给 AI 写**：它拆一句话出来的那几条任务本来就靠「按来源」分组表达
 * 「同出一源」，再给它一套父子关系是同一件事的第二种说法。
 */
export interface Task {
  id: string;
  title: string;
  notes: string;
  status: Status;
  due: string | null;
  /**
   * 什么时候**开始**能做。`null` = 随时可以做，也就是加这个字段之前的行为。
   *
   * 补的是 GTD 里那个「等到那天再说」：一件事已经想清楚、也写下来了，但在
   * 某个日子之前做不了（材料没到、活动还没开始、对方那边还没轮到）。没有这个
   * 字段时只有两条路——让它一直躺在「今天」里天天看见，或者搁置；而搁置的
   * 意思是「暂时不想做」，跟「现在还做不了」不是一回事，混用会让「搁置」
   * 这一档失去含义。
   *
   * ## 出处是 OmniFocus 的 Defer Date，不是滴答清单的「时间段」
   *
   * 这两个名字在这个仓库里曾经被当成同一件事（连这段注释在内一共九处），
   * 而它们不是：
   *
   * - **Defer Date**（《Glossary》）是「the date and time that
   *   an item becomes **Available** for work」，项目管理里叫 "Start No Earlier
   *   Than"。未到期的条目状态是 `Unavailable`，**从可执行的清单里消失**，到了
   *   那天自己回来。这正是这里实现的行为：「接下来」里单独一组、推荐面板排除、
   *   四象限排除、到期那天进「今天」。
   * - **滴答的「时间段」**（《任务详情与编辑》）是**开始时刻 +
   *   结束时刻**，画成日历上一个有高度的块，还能单独设「结束时」提醒。它
   *   **不隐藏任何东西**。这个应用没有结束时刻，日历落格也只看 `due`
   *   （`web/src/lib/calendar.ts`），`.ics` 导出同样不带它（`server/src/ics.ts`）
   *   ——那个功能这里根本不存在。把两者认成一件事，等于拿一个没实现的功能
   *   给一个实现了的行为背书。
   *
   * **跟 `due` 是两件事**：`due` 决定过不过期、进不进「今天」（对应 "End No
   * Later Than"）；`startAt` 决定「在这之前别烦我」。
   */
  startAt: string | null;
  /**
   * 这件事**什么时候结束**。`null` = 没定结束时刻，也就是加这个字段之前的行为。
   *
   * 跟 `startAt` 一起，就是滴答清单的「时间段」（《任务详情与编辑》：
   * 「切换到「时间段」，然后选择「开始时间」和「结束时间」」）——**这是这个
   * 应用里唯一一个能在日历上占一段高度的东西**。在它之前日历只画点：每条任务
   * 落在 `due` 那一刻的格子上，一场九点到十二点的会和一条九点整的提醒长得
   * 一模一样。
   *
   * ## 它跟 `startAt` 的两个身份不冲突
   *
   * `startAt` 是 OmniFocus 的 Defer Date（「在这之前别烦我」，未到期就从各处
   * 清单里消失）。「时间段的起点」听起来是另一件事，但对同一条任务这两句话
   * **说的是同一个时刻**：一场九点开的会，九点之前你确实什么都做不了。所以
   * 不新加一个「日程开始」字段——那会让同一条任务有两个开始时刻，而人分不清
   * 该填哪个。
   *
   * ## 落到日历上哪一格，判据只有一个
   *
   * 见 `web/src/lib/calendar.ts` 的 `calendarAnchor`：**有时间段的按时间段的
   * 起点落格，其余的按 `due`**。这个应用原来的规矩是「落格只看 `due`」，
   * 这一条是那句话唯一的例外，也因此收在那一个函数里，不散在几处判断中。
   *
   * **不校验「结束早于开始」**：那是一句自相矛盾的话，但它是用户的话——跟
   * 「开始晚于截止」同一条既有约定（`server/src/task.ts`）。日历那边按
   * `end <= start` 当成没有时长处理，不画一个负高度的块。
   */
  endAt: string | null;
  reminders: Reminder[];
  /**
   * **响过一次还没处理，就一直响**（仿滴答清单的「持续提醒」，
   * 《持续提醒》：「会一直提醒你，直到你进行处理」）。
   * `false` = 只响一次，也就是加这个字段之前的行为。
   *
   * ## 为什么值得有
   *
   * 这个应用的第一性目的是「别漏事」，而**一条没看见的提醒和没设过提醒，
   * 结果完全一样**：网页横幅关掉那一下就结束了，你不在电脑前的那一次响就是
   * 白响。重要会议、抢票这类事情，「响过了」不等于「知道了」。
   *
   * ## 为什么默认关、而且必须是每条各自开
   *
   * `server/src/reminder.ts` 上写着一条方向相反的原则：搁置的任务不发提醒，
   * 理由是「用户刚把一张卡从『今天』挪走图个清净，下一秒就被同一条的提醒烦到，
   * 比放着不搁置还糟」。持续提醒是**反向**的压力——所以它只能是他为某一条
   * 任务主动打开的东西，不能有全局默认、更不能默认开。
   *
   * 两条规矩因此同时存在，都对，只是适用的任务不同。
   *
   * **滴答那边是全局开关 + 单条覆盖两层**（《常见问题》：
   * 「打开全局持续提醒…你可以只为某些特定任务开启持续提醒，此持续提醒不受
   * 持续提醒开关影响」），这儿**故意只做单条**：那边响的是手机上一条本地
   * 通知，这边一条提醒同时走网页横幅、Windows 系统通知和 webhook 三路，
   * 全局开等于把每一条任务都变成三路轮番轰炸。
   *
   * ## 两份参照在这件事上意见相反
   *
   * 滴答说「会一直提醒你，直到你进行处理」；**Things 明说不这么干**——
   * 「Reminders are not alarms. They won't keep "ringing" after the initial
   * notification.」（《Setting a Reminder》），它给的替代品是
   * 「suggest using reminders sparingly」。
   *
   * 这个字段选了滴答那条，但选择的落点在「默认关」上：默认行为跟 Things
   * 一致（响一次就完），想要滴答那条的人一条一条开。所以这不是在两份参照
   * 里挑一份跟着走，是把它们的分歧变成一个开关。
   *
   * ## 停下来的条件
   *
   * 完成 / 搁置 / 放弃（`dueTasks` 第一行就把了结的挡在外面）、按「稍后 N
   * 分钟」（那会改提醒时刻并清掉章，回到普通那条路）、或者干脆把提醒删了。
   * **只把横幅关掉不算处理**——那正是滴答那句「直到你进行处理」要挡的动作。
   *
   * **AI 写不了**（`stripForced` 摘掉）：「这件事重不重要到要一直烦我」是他的
   * 判断，跟 `priority` 同一类。
   */
  persistentReminder: boolean;
  subtasks: Subtask[];
  source: 'ai' | 'user';
  aiComment: string;
  createdAt: string;
  updatedAt: string;
  order: number | null;
  listId: string | null;
  /**
   * 在这份清单里属于哪一段。`null` = 不在任何分段里。
   *
   * 仿滴答清单的「分组」（《用分组和排序管理任务》：文件夹 -
   * 清单 - **分组** - 任务 - 子任务，五层里的第三层）和 Things 的 Headings
   * （《Using Headings in Projects》：「break that list up into
   * smaller parts like categories or milestones」）。两家独立地都有这一层。
   *
   * ## 存名字，不建一张分段表
   *
   * 它们两家那边分段都是独立记录，能空着、能拖着排序。这里**照标签的办法办**
   * ——`tagTree.ts` 顶部把这个决定和理由写全了：标签在这个应用里没有实体，
   * 是从任务上现算的，「省掉『标签表和任务对不上』那一整类 bug」。为一条清单
   * 里的命名分隔线引进一张表，要跟着来的是文件存储、四条 CRUD、同步与冲突、
   * 删清单时的孤儿清理、AI 契约、离线层——跟这个仓库对标签做过的判断不一致。
   *
   * **代价照直写在这儿**：改段名要动那一段里的每条任务；**空的分段不存在**
   * （最后一条任务挪走，那一段就没了）。真需要「先摆好几个空段再往里填」的
   * 那天，再把它升级成实体。
   *
   * 段名只在**它所属的那份清单**里有意义：同一个「第一阶段」在两份清单里是
   * 两段，跟 `listId` 一起才构成一个坐标。任务换清单时段名原样带着——那多半
   * 是他要的（同一件事挪个地方，「第一阶段」还是「第一阶段」），而新清单里
   * 没有同名段时它自己就成了新的一段。
   *
   * **AI 写不了**（`stripForced` 摘掉）：怎么给自己的清单分段是他的组织习惯，
   * 跟 `pinned`/`parentId` 同一类。
   */
  section: string | null;
  tags: string[];
  /**
   * 四档：`0` 无 / `1` 低 / `2` 中 / `3` 高。仿滴答清单。
   *
   * ## 这是一个有争议的选择，三份参照在这件事上正面打架
   *
   * - **滴答清单**：四档，而且整个四象限盖在它上面。
   * - **OmniFocus**：没有分级，只有一个 flag（旗标）。
   * - **Things：干脆不做这个字段。** 它的原话值得整段抄在这儿，因为它反对的
   *   正是这个字段本身：
   *
   *   > In Things, prioritizing to-dos is as easy as adding them to your Today
   *   > list… you can drag and drop to-dos in the order you want to tackle them.
   *   > When you have a really long list, assign custom priority labels…
   *   > **Tags are the perfect tool for this.** We recommend that you start off
   *   > simple by creating a single tag, for example Important… **It's a simpler
   *   > workflow, and you don't have to constantly evaluate where to-dos fall on
   *   > a subjective scale of importance.**
   *   >
   *   > —— 《How to Prioritize To-Dos in Things》
   *
   * ## 为什么仍然选了四档
   *
   * 四象限要一根**可枚举**的轴。它是这个应用里唯一一屏「就这么多事，挑一件」，
   * 而「重要 / 不重要」这个划分得能从数据里算出来——标签算不出来（标签是开放
   * 集合，`#重要` 和 `#紧急` 谁是纵轴？），拖出来的顺序也算不出来。
   *
   * **而 Things 那三条替代路子这里全都有**，选它那套的人一样过得下去：
   * 「今天」里的顺序是手拖的、标签有、按标签筛也有。`0`（无）是默认值，
   * 新任务一律从这儿开始——**不填就等于这个字段不存在**，所以它不构成
   * Things 说的那种「每条都得在一把主观尺子上定位」的负担。
   *
   * 写下来是因为**在这段注释之前，这个仓库里没有任何一处提过这个分歧存在**，
   * 而反对方那篇文档一次都没被引用过。下一个人要重新掂量这个决定时，至少能
   * 看到两边的话。
   */
  priority: 0 | 1 | 2 | 3;
  repeat: Repeat | null;
  completedAt: string | null;
  postponeCount: number;
  waitingFor: string | null;
  /**
   * 这件事得在什么条件下才干得了。`null` = 没分情境。
   *
   * 挑清单的时候人问的不是「哪条最重要」，是「我现在这个状态能干什么」——
   * 坐在电脑前的半小时、出门路上的十分钟、累到不想动的晚上，能做的完全是
   * 三批不同的事。优先级回答不了这个问题：一条「最重要」但非得出门才办得成
   * 的任务，在电脑前排第一位只是挡路。GTD 里这一维叫「情境」。
   *
   * ponytail: **精力折进了情境，没有另开一维**（`easy` 那一档）。代价是
   * 「累的时候也能干的电脑活」只能二选一。真到这个粒度成为问题的那天再拆一个
   * `energy` 字段出来——在那之前，两维里的第二维大概率永远是空的。
   */
  context: TaskContext | null;
  attachments: string[];
  /**
   * 打算花多久，分钟。`null` = 没估过。
   *
   * 有了它，卡片上那句「已专注 50 分钟」才有分母——**光有累计时长只是个
   * 事实，配上估计才是一句判断**（「说好一小时，已经两小时了」）。
   * **用分钟，不用「几个番茄」**：这个应用的一轮时长本来就可配
   * （`Settings.focusMinutes`），用番茄数就得跟着那个设置换算——换一次设置，
   * 历史上所有的估计都跟着变意思。
   *
   * （滴答那边**两种都给**：「预计番茄/预计时长」，见
   * 《常见问题》。所以这不是跟它的分歧，只是在它的两档里选了
   * 一档。这句话原来写的是「它那边的单位是番茄数」——那是句错话，而且它被
   * 摆在这儿当论据用，读的人会以为我们在跟它较劲。）
   *
   * **AI 写什么都不算数**，跟 `priority` 同一类：这件事要花你多久，它没有
   * 依据（见 outbox.ts 的 stripForced）。
   */
  estimateMinutes: number | null;
  focusSessions: FocusSession[];
  habit: boolean;
  pinned: boolean;
  /**
   * 上一次在回顾里点「看过了」的时刻。`null` = 从来没看过。
   *
   * 仿 OmniFocus 的 Mark Reviewed（《Perspectives》）：
   * 回顾清单上的每一条，除了「去处理它」之外还得有第三条路——**「我看过了，
   * 就这样」**。没有这条路，一条你已经决定维持原样的项目会每周都杵在那儿，
   * 而一份劝不动你的清单，久了就不再被当真。
   *
   * OmniFocus 那边这个章配一个 per-project 的复查间隔；这里只有一个全局的
   * `REVIEWED_QUIET_DAYS`（web/src/lib/taskView.ts），够用就先只做这一层。
   *
   * **AI 写什么都不算数**（`stripForced` 摘掉）：这是「人看过没看过」的记录，
   * 替人盖这个章等于替他做那个决定。
   */
  reviewedAt: string | null;
  parentId: string | null;
}

/**
 * 垃圾箱里的一条。`deletedAt` 只在这里有意义——加进 `Task` 等于让每一条活着的
 * 任务都背一个永远是 null 的字段，AI 的契约（AGENTS.md 里那份任务样例的字段表）也要跟着改。
 *
 * 没有内联对象字面量：`web/src/lib/types.sync.test.ts` 抠 interface 用的正则是
 * `[^}]*`，不支持嵌套花括号，踩了会让两边一起截断、一起通过。
 */
export interface TrashItem extends Task {
  deletedAt: string;
}

export interface InboxItem {
  id: string;
  text: string;
  createdAt: string;
  processed: boolean;
  taskIds: string[];
}

export interface Settings {
  webhookUrl: string;
  toastEnabled: boolean;
  autoExpand: boolean;
  autoExpandDelaySec: number;
  /** 番茄钟一轮的时长，分钟。规格原话「时长可配，默认 25 分钟」。校验（夹到
   *  一个合理范围，不是拒绝）在 app.ts 的 clampFocusMinutes，跟
   *  autoExpandDelaySec 是同一条道理。 */
  focusMinutes: number;
  /**
   * 一轮之后歇多久，分钟（仿滴答清单番茄钟的「短休息」）。**0 = 不休息**，
   * 那就是加这个字段之前的行为：倒计时走完直接回到「开始专注」。
   *
   * 番茄工作法本来就是「专注一段 + 歇一小段」两半，这个应用一直只有前一半：
   * 倒计时归零、记一条记录，然后什么都不说——真正需要被提醒的那件事
   * （该起来走走了）没有任何表示。默认 5 分钟，跟经典说法和滴答清单一致。
   * 只做短休息，**不做「每四轮一次长休息」**：那要记住「这是第几轮」，而这个
   * 番茄钟的状态刻意不持久化（关掉页面 = 放弃，见 FocusTimer.tsx），一个
   * 一刷新就归零的轮次计数比没有更让人困惑。
   */
  breakMinutes: number;
  /** 「新任务」表单打开时预填哪个清单，仿滴答清单的「任务默认值」。`null` =
   *  不预填。**只影响手工建的那条路**：AI 拆出来的任务归哪个清单是它读
   *  `data/lists/` 之后自己判断的（AGENTS.md），不该被这台机器上的一个偏好
   *  盖掉。指向一个已经删掉的清单时当成没设，见 web 那边 defaultDraft。 */
  defaultListId: string | null;
  /**
   * 每天几点推一条「今天有什么」。`'HH:MM'`，
   * 本地时刻；**`null` = 不推，这是默认**——一条每天定时出现的通知是件挺
   * 打扰的事，得他自己开。
   *
   * 补的是通知这件事上的一个空缺：这个应用只在**某一条任务**到点时说话，
   * 而多数任务根本没设提醒、只有一个截止日期，于是「今天有什么」全靠人自己
   * 想起来打开看一眼。
   */
  dailySummaryAt: string | null;
  /**
   * 今天这一条已经推过了（本地 `YYYY-MM-DD`）。**服务端盖的章，客户端写不了**
   * ——跟 `Reminder.firedAt` 同一类：它是「这件事发生过没有」的事实，不是偏好。
   * `PUT /api/settings` 会把存着的这个值原样留着，不采信请求体里的。
   */
  dailySummaryOn: string | null;

  /** 「新任务」表单打开时预填哪档优先级，同上。0 = 不预填。 */
  defaultPriority: 0 | 1 | 2 | 3;

  /**
   * 「新任务」表单打开时预填哪一天（仿滴答清单「任务默认值 → 默认日期」）。
   * `'none'` = 不预填，这是默认，也是加这个字段之前的行为。
   *
   * 落到几点跟日历上「在这天新建」一致（那天 23:59）——不是零点：零点会被
   * `isOverdue` 当成一个真实时刻，那天 00:01 就标成过期、红一整天。
   *
   * **只影响手工建的那条路**，跟 `defaultListId`/`defaultPriority` 同一条：
   * AI 拆出来的任务该排哪天是它读了那句话之后的判断，不该被这台机器上的一个
   * 偏好盖掉。
   */
  defaultDue: 'none' | 'today' | 'tomorrow';

  /**
   * 新任务默认提前多久提醒，分钟（仿滴答清单「任务默认值 → 默认提醒」）。
   * `null` = 不预设提醒，默认。`0` = 准时。
   *
   * **只在这条新任务真的有截止时间时才落**：没有截止时间就没有「提前」的
   * 参照物，硬落一个提醒等于凭空定一个跟任何事都无关的闹钟。
   */
  defaultRemindMinutes: number | null;

  /**
   * 新任务默认带上哪几个标签（仿滴答清单「默认标签」）。空数组 = 不预填。
   *
   * **不校验这几个标签「存在不存在」**：标签在这个应用里是从任务上现算出来
   * 的，没有一张表（见 `taskView.allTags`），所以「一个还没有人用过的标签」
   * 是完全正常的——第一条带上它的任务就是它的出生证明。
   */
  defaultTags: string[];

  /**
   * 一周从周几开始。取值和理由都在 `WeekStart` 上。
   *
   * **它管的不只是日历那七列**：专注统计里「本周专注了多久」那个数字、习惯
   * 热力图的列对齐，用的都是同一个周首。这三处以前各写各的（两份写死周一的
   * `mondayOf` 拷贝），于是把这个设置改成周日之后，日历跟着变、那两个数字
   * 不变——同一个应用里两个「本周」。
   *
   * **例外只有一个**：`calendar.ts` 的 `isoWeek`（月视图行首那个「35周」）
   * 恒从周一算，那是 ISO 8601 的定义，换个人看得是同一个数。那儿写着为什么。
   */
  weekStart: WeekStart;

  /**
   * 加任务时认不认标题里的日期（仿滴答清单「智能识别 → 日期识别」）。
   * 默认开——这是加这个开关之前的行为。
   *
   * 关掉之后「明天下午两点交周报」原样进标题，不再变成一条排在明天 14:00
   * 的任务。**给的是「我不要它猜」这个选择**：这个应用的识别是本机一条正则
   * （`lib/smartInput.ts`），它对「3 月 5 号那版方案」这种标题会误判，而在
   * 关掉之前，唯一的躲法是每次建完再手工改回来。
   */
  smartDate: boolean;

  /**
   * 认出来的日期要不要从标题里摘掉（仿滴答清单「移除文本中的日期」）。
   * 默认开。关掉之后标题原样留着，日期照样设上——「10 月 1 日国庆值班」
   * 这种标题，摘掉日期就只剩「国庆值班」，而那个日期本来就是标题的一部分。
   *
   * `smartDate` 关着时这一项没有意义（没认出日期就没什么可摘），界面上跟着
   * 禁用。
   */
  smartStripDate: boolean;

  /**
   * 加任务时认不认标题里的 `#标签`（仿滴答清单「智能识别 → 标签识别」）。
   * 默认开。
   */
  smartTag: boolean;

  /**
   * 认出来的标签要不要从标题里摘掉（仿滴答清单「移除任务标题中的标签」）。
   * 默认开。关掉之后 `#工作` 既进标签、也留在标题里。
   */
  smartStripTag: boolean;

  /**
   * 日历格子里写不写农历（仿滴答清单「设置 → 日期与时间 → 显示农历」）。默认开——
   * 这是个中文应用，「腊月廿三」「立秋」跟公历日期一样是这个日历要回答的东西。
   *
   * 一格只写**一样**，优先级 节气 > 农历节日 > 农历日：一天最多只有一件事
   * 值得占那半行（web/src/lib/lunar.ts 的 `lunarLabel`）。
   */
  showLunar: boolean;

  /**
   * 日历格子里标不标「休 / 班」（法定节假日和调休上班日，仿滴答清单）。
   * 默认开。数据来自 `chinese-days`（国务院办公厅每年的放假通知），
   * **只覆盖到有通知的那一年为止**——再往后一天不标，不是标成「上班」，
   * 见 web/src/lib/lunar.ts 里 `holidayMark` 的年份闸门。
   */
  showHolidays: boolean;

  /**
   * 用哪条路叫 AI。**`'cli'` 是默认，也是这个应用一直以来的行为**：起一个
   * `claude` 子进程，它自己读 `AGENTS.md`、自己读写 `data/`，本事最大——
   * 能反复读几十个文件、自己纠正自己，代价是这台机器上得装 Claude Code。
   *
   * `'api'` 是给「没装 Claude Code、但手上有个 API key」的人准备的：服务替它
   * 读盘写盘，模型只负责中间想的那一步。任何 OpenAI 兼容的对话接口都能接，
   * Google AI Studio / Gemini 也有兼容端点。见 `server/src/aiApi.ts`。
   */
  aiMode: 'cli' | 'api';

  /**
   * `aiMode: 'api'` 时打到哪儿。填完整地址（`…/v1/chat/completions`）、base
   * （`…/v1`）、或者光一个域名都认，`aiApi.ts` 的 `chatUrl` 负责补齐。
   */
  aiBaseUrl: string;

  /**
   * 接口密钥。**`GET /api/settings` 只回打码后的形状**（`••••` 加后四位），
   * 真值一步都不离开这台机器——这个服务会绑到局域网上（见 `lanBind.ts`），
   * 同一个 Wi-Fi 里的任何人都能 GET 它。`PUT` 收到打码值 = 保持原样，收到
   * 空串 = 真的清掉，见 app.ts 那段。
   *
   * 本机跑的 Ollama / LM Studio 那类不要钥匙，留空就行。
   */
  aiKey: string;

  /** 模型名，原样发给接口。`aiMode: 'api'` 时必填——各家的默认值互不相同，猜不了。 */
  aiModel: string;
}

/**
 * AI 对某条已有任务提的一条修改建议，等着人点「接受」或「忽略」。
 *
 * 单独一份文件、不挂在 `Task` 上：挂上去要动这个跨包复制、有同步测试盯着的
 * 类型，还要让 `sanitizeTaskPatch` 多出一堆「这个字段人能不能改」的分支。
 *
 * **AI 不直接改任务。** 直接改的话，改完之后卡片上那个时间是谁定的就说不清了：
 * 说石墨黑，是把 AI 的推断冒充成你的决定；说群青，是把你原本手填过这件事抹掉。
 * 提议式让这条线保持干净——群青的提议摆在那儿，你点了「接受」，那一刻它才
 * 变成你的决定。见 2026-08-12-ai-proposals.md。
 */
export interface Proposal {
  /** 服务端在合并 outbox 时生成，AI 不写这个字段。 */
  id: string;
  taskId: string;
  /** 只可能含 title/notes/due/reminders/subtasks，见 task.ts 的 sanitizeProposalPatch。 */
  patch: Partial<Task>;
  reason: string;
  createdAt: string;
  /** 他点过「忽略」。**留着不删**，否则内容去重认不出来，下一轮回顾会把
   * 一模一样的建议原样再提一遍——「忽略」等于没点。界面不渲染这种行；
   * 情况真变了（比如又拖了一个月），AI 算出的新日期会构成不同的内容、
   * 是一条新建议，照样提得出来。 */
  dismissed?: boolean;
}

/**
 * 存起来的一组筛选条件。智能清单就是它——不拥有任务，只是一次保存下来的查询。
 *
 * 七个维度之间是**且**，一个维度内部（多选那几个）是**或**——这是滴答清单
 * 「普通筛选」的语义。另外两个字段是它的「高级筛选」那一半：
 *
 * - `tagsAll`：把标签这一维内部从「或」改成「且」。**只有标签有这个开关**，
 *   跟它一样——「同时打了 #工作 和 #紧急」是个真实需求，而「状态既是待办又是
 *   已完成」不是。
 * - `or`：**多语句查询**。这一份自己是第一组，`or` 里每一份各是一组，
 *   组与组之间取并集。**只嵌套一层**：`or` 里那几份自己的 `or` 恒为空
 *   （服务端校验拦着），不然一份存下来的查询能长成一棵任意深的树，
 *   界面画不出来、人也读不懂。
 * - `noList` / `noTag`：**「还没归类的」**。这两件事在 `listIds`/`tags` 那两个
 *   数组里表达不出来——空数组的含义已经被占了（「这一维不参与」），而
 *   `listId === null` 是一个真实的、常要找的状态：没归进任何清单的任务就是
 *   还没分拣的那一堆。看板按清单/标签分列时一直有「不属于任何清单」「没有
 *   标签」两列，筛选这边一直没有，于是这个概念只能看、不能筛，也存不成一份
 *   智能清单。**跟同维度的数组是「或」**：勾了「没有清单」又选了「工作」，
 *   要的是「没归类的，加上工作里的」，不是空集。
 * - `noDue`：**「还没排期的」**。跟上面两个同一个形状、同一个理由：
 *   `dueWithinDays` 是「N 天内」，`null` 的含义已经被占了（「日期这一维不
 *   参与」），而「压根没有截止时间」是一个真实的、常要找的状态——这个应用
 *   处处按日期组织（「今天」要有日期才进得去、日历只画有日期的、`sortByUrgency`
 *   按日期排），于是**没有日期的任务是最容易被整批遗忘的那一堆**，而在这之前
 *   没有任何地方能把它们捞出来。日期那一维是个单选下拉，「N 天内」和「没有
 *   日期」只能二选一，不存在「或」的问题。`due` 是一段读不出来的字符串
 *   （手改文件写了「下周三」）也算没日期——它在「N 天内」那一档同样筛不到，
 *   在日历、在「今天」、在排序里也一律被跳过，功能上它就是没日期。
 */
export interface SmartFilter {
  status: Status[];
  listIds: string[];
  tags: string[];
  priority: number[];
  contexts: TaskContext[];
  dueWithinDays: number | null;
  hasWaitingFor: boolean;
  text: string;
  tagsAll: boolean;
  noList: boolean;
  noTag: boolean;
  noDue: boolean;
  /**
   * 只看重复任务（OmniFocus 的 `Is Repeating`）。`false` = 这一维不筛。
   *
   * 有它才答得了「我到底给自己排了多少条常规」——重复任务在别的维度上跟
   * 一次性任务长得一模一样，攒到几十条之后没有任何地方数得清。
   */
  isRepeating: boolean;
  /**
   * 只看**还没到开始时间**的（OmniFocus 的 `Availability: Unavailable`）。
   *
   * 判据复用 `taskView.ts` 的 `notStarted`，跟卡片上那个「9 月 1 日 开始」
   * 的记号、「接下来」里那一组、四象限的排除是同一个函数——这一维要是自己
   * 写一遍「什么叫还没开始」，就会出现「筛出来的那条卡片上没有那个记号」。
   */
  notStarted: boolean;
  /**
   * 预计时长**不超过**这么多分钟（OmniFocus 的
   * `Has an Estimated Duration Less Than`）。`null` = 这一维不筛。
   *
   * 「我现在只有二十分钟，能做点什么」——这是 `estimateMinutes` 这个字段
   * 最本命的问题，而在这一维之前它只能排序、不能筛。**没估过的筛不到**：
   * 「没估过」既不是二十分钟以内也不是以外，混进来这份清单就不能直接照着做，
   * 跟 `contexts` 那一维对「没分情境」的态度一字不差。
   */
  estimateWithinMinutes: number | null;
  or: SmartFilter[];
  /**
   * **排除组**（OmniFocus 的 `None of the Following`）：命中这里面任何一组的
   * 任务一律不要。
   *
   * 跟 `or` 是一对，形状也刻意一样（一层，不能再嵌）：`or` 往结果里加，
   * `not` 从结果里减。**减在最后**——先把 `or` 的并集算出来，再整体排除，
   * 而不是每组各减各的：后者会让「A 或 B，排除 C」变成「(A 排除 C) 或 B」，
   * 那是另一句话。
   *
   * 为什么不做成「每一维都能取反」：那要给十几个控件各加一个反向开关，而
   * 真实用法几乎总是「这一堆里，把某一类拿掉」——一个整组的减法就够，
   * 两家参照给的也都是这个形状。
   */
  not: SmartFilter[];
}

/** `filter` 非 null 时这是一个智能清单，不是一个真的清单。 */
export interface List {
  id: string;
  name: string;
  color: string;
  folderId: string | null;
  order: number;
  archived: boolean;
  filter: SmartFilter | null;
}

/** 清单的文件夹。只做两层，不做无限嵌套——单人工具里三层目录是自找麻烦。 */
export interface Folder {
  id: string;
  name: string;
  order: number;
}

/**
 * AI 的跨任务观察。跟 `Proposal` 的区别是它**不挂在某一条任务上**——
 * 「你的写作类任务清一色在晚上十点后完成」这种话，`Proposal` 表达不了，
 * 因为那边每一条都必须有个 `taskId`。
 */
export interface Insight {
  id: string;
  kind: 'pattern' | 'duplicate' | 'stuck' | 'note';
  text: string;
  taskIds: string[];
  createdAt: string;
  dismissedAt: string | null;
}

/**
 * 倒数纪念日——仿滴答清单的「倒数日」模块。「距离考试还有 30 天」「在一起
 * 已经 1200 天」这种事：它不是任务（没有「做完」这一步、也不该出现在
 * 「今天」里烦人），所以跟 `Task` 分开存，跟它那边同样是一个独立模块。
 *
 * **`date` 是本地日期字符串 `YYYY-MM-DD`，不是 ISO 时刻。** 这个东西回答的
 * 全部问题都是「差几天」，而「差几天」是日历日之间的差，跟时刻和时区无关。
 * 存成 ISO 时刻的话，`2026-01-01T00:00:00.000Z` 在东八区是 1 月 1 日早八点、
 * 在西五区是前一年 12 月 31 日晚七点——同一份数据同步到两台机器上会差一天，
 * 而这个仓库已经为 `toISOString().slice(0,10)` 那条栽过好几次（见
 * `calendar.ts` 的 `dayKey`）。日期字符串没有这个歧义。
 *
 * **正数还是倒数不存字段**：未来的日子就是倒数、过去的就是正数，从 `date`
 * 和「今天」一比就知道。存一个能算出来的字段，只会多一处可能跟事实对不上的
 * 地方。
 */
export interface Countdown {
  id: string;
  title: string;
  date: string;
  yearly: boolean;
  /**
   * 这个日子按**农历**算（仿滴答清单：「点击日期，可选择设置为公历或农历」，
   * 《添加倒数纪念日》）。农历生日、中秋、清明这一类。
   *
   * **`date` 仍然存公历**，这个开关只改「明年的这一天是公历哪一天」的算法：
   * 用 `lunarOf(date)` 求出它在农历里是几月几号，再用 `solarFromLunar` 换回
   * 每一年对应的公历日。**跟 `repeat.ts` 的 `lunar-year` 一模一样的做法**
   * ——那边也是拿公历锚点反查农历、再换回去，不新存一个农历字段。两处同一个
   * 套路，是因为「农历的哪一天」这件事本来就该从一个确定的公历日推出来，
   * 存一个「农历八月十五」的字符串反而要自己回答闰月怎么办。
   *
   * **只在 `yearly` 为真时才有意义**：不重复的日子是一个固定的公历点，
   * 「距离 2020-08-15 多少天」跟农历没有关系。界面上因此只在勾了「每年」
   * 之后才给这个开关，跟提醒预设的「结束时」只在有时间段时出现同一条。
   */
  lunar: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一份同步冲突副本，给界面用——不解决，只是让人看见。`conflicts.ts` 的
 * `listAllConflicts` 产出这个形状，路由 `GET /api/conflicts` 直接吐给前端。
 */
export interface ConflictFile {
  /** 哪一类：'tasks' | 'inbox' | … 就是 paths() 的键。 */
  kind: string;
  /** 文件名原样（含「冲突副本」那一段）。 */
  file: string;
}

/**
 * `data/outbox-<unique>.json` 里每一项的形状。AI 只写这一类文件——`tasks` 里是它
 * 自己拼出来的「完整任务对象」，形状是外部输入，进正式的 `Task` 之前要经
 * `task.ts` 的 `sanitizeTaskPatch` 校验，所以这里只留 `unknown[]`。
 */
export interface OutboxEntry {
  inboxId: string;
  tasks: unknown[];
}

/**
 * outbox 里的第二种条目：AI 对已有任务提的修改建议。跟 `OutboxEntry` 一样，
 * 里面的东西是外部输入，进 `Proposal` 之前要经 `task.ts` 的
 * `sanitizeProposalPatch` 白名单校验，所以这里只留 `unknown[]`。
 *
 * 一个 outbox 文件里两种条目可以混着放，靠有没有 `updates` 这个键区分。
 */
export interface OutboxUpdateEntry {
  updates: unknown[];
}

/**
 * outbox 里的第三种条目：AI 的跨任务观察。
 *
 * 前两种（`tasks` / `updates`）都绑在一个具体对象上——一条收件箱记录、一条已有
 * 任务。跨任务的话说不出来：「你的写作类任务清一色在晚上十点后完成」挂不到任何
 * 一个 id 上。这一类就是为那种话开的口子。
 */
export interface OutboxInsightEntry {
  insights: unknown[];
}

export const DEFAULT_SETTINGS: Settings = {
  webhookUrl: '', toastEnabled: true, autoExpand: true, autoExpandDelaySec: 60, focusMinutes: 25, breakMinutes: 5,
  dailySummaryAt: null, dailySummaryOn: null, defaultListId: null, defaultPriority: 0,
  // 「任务默认值」那几个新字段一律**默认不预填**，识别那四个开关一律
  // **默认开**——两批的默认值合起来就是加它们之前的行为，一个字都没变。
  defaultDue: 'none', defaultRemindMinutes: null, defaultTags: [], weekStart: 1,
  smartDate: true, smartStripDate: true, smartTag: true, smartStripTag: true,
  showLunar: true, showHolidays: true,
  // AI 默认还是走 `claude` 子进程——这是这个应用一直以来的行为，也是本事最大的
  // 那条。另外三格留空：地址和模型没有一个「多数人都对」的默认值（各家互不相同），
  // 猜一个填进去，只会让「我明明没配过，怎么会报 401」变成一次没必要的排查。
  aiMode: 'cli', aiBaseUrl: '', aiKey: '', aiModel: '',
};
