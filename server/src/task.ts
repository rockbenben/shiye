import type { FocusSession, Reminder, Repeat, Status, Subtask, Task, TaskContext } from './store.js';
// **从 `model.js` 引，不从 `store.js`**：这个文件被网页够得到
// （`dataSource.ts` → `mutate.js` → 这里），而 `store.js` 碰 node 内置，
// 进了网页包就是一次白屏。理由整段在 model.ts 顶上，`webBundle.guard.test.ts` 盯着。
import { HABIT_EVERY, REPEAT_KINDS } from './model.js';

/**
 * 合法的 status 取值。**服务端内部只此一份**——`app.ts` 的 HTTP 路由和
 * `outbox.ts` 的合并逻辑都从这儿导入，不许各自再抄一份。
 *
 * `web/src/lib/taskView.ts` 里还有一份看起来一样的数组：那是没法消灭的重复，
 * server 和 web 是两个独立的包，web 引不到这边的代码，只能靠
 * `web/src/lib/types.sync.test.ts` 盯着两边不飘。这里说的「只此一份」指的是
 * server 这一侧。
 */
export const STATUSES: Status[] = ['todo', 'doing', 'done', 'later', 'abandoned'];

/**
 * 「人已经对这条做过判断了」——做完了 / 放弃了 / 暂时搁置。**服务端这一侧
 * 只此一份**：`reminder.ts` 判要不要发提醒、`mutate.ts` 判「从关闭态回到
 * 待办要不要清 order」都从这儿引。
 *
 * `web/src/lib/taskView.ts` 里有一份同名的——两个包传不过来，跟 `STATUSES`
 * 是同一种没法消灭的重复，靠 `types.sync.test.ts` 盯着 `Status` 本身不飘。
 */
export const isSettled = (status: Status): boolean =>
  status === 'done' || status === 'later' || status === 'abandoned';

/** 客户端能改的任务字段，白名单。id / createdAt 不在里面，传了也不采纳。
 *
 * `order` 在这份白名单里，但**这只是形状校验**——它允许 PATCH /api/tasks/:id
 * （人经网页发起的写）设置 order，也允许 outbox 里的原始任务对象带这个字段
 * 通过形状检查。真正「AI 写的 order 一律不算数」这条规矩不在这里做，在
 * `outbox.ts` 的 `toTask()` 里强制覆盖成 null——跟 `source` 字段是同一个套路：
 * 校验器只管「形状对不对」，「这个字段该不该由谁来写」是外面信任边界的事。 */
export type TaskPatch = Partial<Pick<Task,
  'title' | 'notes' | 'status' | 'due' | 'startAt' | 'endAt' | 'reminders' | 'persistentReminder'
  | 'subtasks' | 'source' | 'aiComment' | 'order'
  | 'listId' | 'section' | 'tags' | 'priority' | 'repeat'
  | 'waitingFor' | 'context' | 'attachments' | 'focusSessions' | 'habit' | 'estimateMinutes'
  | 'pinned' | 'reviewedAt' | 'parentId'>>;

/**
 * 情境的合法取值。写成 `Record<TaskContext, true>` 而不是一个数组：**加一档
 * 情境的时候，这里不跟上会编译不过**。一份手抄的数组不会——它会安静地把新那档
 * 拒在门外，而表现是「网页上选了保存不上，没有任何报错」。
 */
const CONTEXT_OK: Record<TaskContext, true> = {
  computer: true, out: true, home: true, contact: true, easy: true,
};

/** 同一份，摊成数组给别处用（`migrate.ts`）。**从 `CONTEXT_OK` 推，不另手抄**：
 *  两份名单迟早分叉，而分叉的表现是「校验器认、迁移器不认」这种最难查的不一致。 */
export const CONTEXTS = Object.keys(CONTEXT_OK) as TaskContext[];

const isIsoOrNull = (v: unknown): v is string | null =>
  v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));

/**
 * 校验失败时带上「哪个字段、为什么」——`null` 只够说「不合法」，而 AI 拿到的
 * 是一句要照着改的话（`AGENTS.md`「校验失败会怎样」：改好那个字段重写整份文件）。
 * 在 `Task` 那一长串字段里挨个猜一轮，是一分半钟加一次订阅额度。
 *
 * **这里的 `reason` 有两个受众，改措辞时两个都要照顾到。** 除了 AI，它还会
 * 原样摆到人眼前：路由把它拼成 `` `${field} ${reason}` `` 放进 400 的 `error`
 * （`app.ts`），前端 `guard()` 直接 `message.error(e.message)` 弹出来
 * （`App.tsx`）。所以既不能写成只有模型看得懂的术语，也不能为了好读而含糊到
 * 模型不知道该改哪一格——「要是 ISO 8601 带时区的时间字符串（2026-08-15T09:00:00.000Z）
 * 或 null」这种「说清形状 + 给个例子」的写法两边都成立，是这一批的样板。
 */
export type SanitizeFail = { ok: false; field: string; reason: string };
export type SanitizeOk<T> = { ok: true; value: T };
export type SanitizeResult<T> = SanitizeOk<T> | SanitizeFail;

/** 导出给 `outbox.ts` 的 `checkTask` 用——同一份 `bad`，别在别处再抄一份。 */
export const bad = (field: string, reason: string): SanitizeFail => ({ ok: false, field, reason });

/**
 * 把外部来的东西过一遍。**这是信任边界**——不止一处：`POST/PATCH /api/tasks`
 * 的请求体是一处，`data/outbox-*.json` 里 AI 写的任务对象是另一处。两处都在
 * 信任边界之外，必须走同一份校验，见 `outbox.ts` 的 `mergeOutbox`。
 *
 * `ok:false` 表示不合法，带上是哪个字段、为什么。只校验「给出的字段」，不检查
 * 必填——是否必填由调用方决定（`POST /api/tasks` 和 outbox 合并都额外要求
 * `title` 存在，`PATCH` 不要求）。
 */
export function checkTaskPatch(body: unknown): SanitizeResult<TaskPatch> {
  if (typeof body !== 'object' || body === null) return bad('body', '要是一个对象（整个请求体）');
  const b = body as Record<string, unknown>;
  const out: TaskPatch = {};

  if ('title' in b) {
    if (typeof b.title !== 'string' || !b.title.trim()) return bad('title', '要是非空字符串（去掉首尾空白之后不能是空的）');
    out.title = b.title.trim();
  }
  if ('notes' in b) {
    if (typeof b.notes !== 'string') return bad('notes', '要是字符串（没有就写空字符串，不是 null）');
    out.notes = b.notes;
  }
  if ('status' in b) {
    if (!STATUSES.includes(b.status as Status)) return bad('status', '要是 todo / doing / done / later 之一');
    out.status = b.status as Status;
  }
  if ('due' in b) {
    if (!isIsoOrNull(b.due)) return bad('due', '要是 ISO 8601 带时区的时间字符串（2026-08-15T09:00:00.000Z）或 null');
    out.due = b.due;
  }
  if ('startAt' in b) {
    if (!isIsoOrNull(b.startAt)) return bad('startAt', '要是 ISO 8601 带时区的时间字符串（2026-08-15T09:00:00.000Z）或 null');
    out.startAt = b.startAt;
  }
  // **不校验「开始在截止之前」。** 这两个字段各自合法就收下——「开始晚于截止」
  // 是一句自相矛盾的话，但它是**用户的话**：多半是他先填了开始、还没来得及
  // 改截止。当场拒掉的代价是那一次编辑整个失败（表单里两个控件，改哪个都
  // 可能短暂地不自洽）；收下的代价只是界面上那一条看起来怪。跟 `noDue` 和
  // `dueWithinDays` 同时写着时那条注释是同一个态度：手改出来的自相矛盾，
  // 就是那两句话摆在一起的字面意思。
  if ('reminders' in b) {
    if (!Array.isArray(b.reminders)) return bad('reminders', '要是数组，每条形如 { at: ISO 时间, firedAt: null }');
    const rs: Reminder[] = [];
    for (const r of b.reminders) {
      if (typeof r !== 'object' || r === null) return bad('reminders', '要是数组，每条形如 { at: ISO 时间, firedAt: null }');
      const { at, firedAt } = r as Record<string, unknown>;
      if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return bad('reminders', '每条的 at 要是合法的 ISO 8601 时间字符串');
      if (!isIsoOrNull(firedAt ?? null)) return bad('reminders', '每条的 firedAt 要是 null 或合法的 ISO 时间字符串（拆解时一律写 null）');
      rs.push({ at, firedAt: (firedAt as string | null) ?? null });
    }
    out.reminders = rs;
  }
  if ('subtasks' in b) {
    if (!Array.isArray(b.subtasks)) return bad('subtasks', '要是数组，每条形如 { text: 字符串, done: 布尔值 }');
    const subs: Subtask[] = [];
    for (const s of b.subtasks) {
      if (typeof s !== 'object' || s === null) return bad('subtasks', '要是数组，每条形如 { text: 字符串, done: 布尔值 }');
      const { text, done } = s as Record<string, unknown>;
      if (typeof text !== 'string' || typeof done !== 'boolean') return bad('subtasks', '每条的 text 要是字符串、done 要是布尔值');
      subs.push({ text, done });
    }
    out.subtasks = subs;
  }
  if ('source' in b) {
    if (b.source !== 'ai' && b.source !== 'user') return bad('source', '要是 "ai" 或 "user" 之一');
    out.source = b.source;
  }
  if ('aiComment' in b) {
    if (typeof b.aiComment !== 'string') return bad('aiComment', '要是字符串');
    out.aiComment = b.aiComment;
  }
  if ('order' in b) {
    if (b.order !== null && !(typeof b.order === 'number' && Number.isFinite(b.order))) return bad('order', '要是数字或 null（拆解时一律写 null）');
    out.order = b.order as number | null;
  }
  if ('listId' in b) {
    if (b.listId !== null && typeof b.listId !== 'string') return bad('listId', '要是某个清单的 id（字符串）或 null');
    out.listId = b.listId as string | null;
  }
  if ('tags' in b) {
    if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string')) return bad('tags', '要是字符串数组');
    // 去首尾空白、丢空串、去重——跟 web/src/components/TaskFields.tsx 编辑表单
    // 那层同一套判据。这里必须补一份：AI 写 outbox 和手搓 curl 都不经过前端，
    // 服务端不挡的话空标签会在导航里冒出一条没名字的项，点进去视图标题（`<h1>`）
    // 也是空的，可访问性异味——那条判据在 App.tsx 的 `viewTitle()` 上面。
    // 去重要保序（先出现的留下），标签在卡片上的显示顺序是用户加的顺序。
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const raw of b.tags as string[]) {
      const t = raw.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      tags.push(t);
    }
    out.tags = tags;
  }
  if ('priority' in b) {
    if (![0, 1, 2, 3].includes(b.priority as number)) return bad('priority', '要是 0/1/2/3 之一');
    out.priority = b.priority as 0 | 1 | 2 | 3;
  }
  if ('repeat' in b) {
    const r = checkRepeat(b.repeat);
    if (!r.ok) return bad('repeat', r.reason);
    out.repeat = r.value;
  }
  if ('persistentReminder' in b) {
    if (typeof b.persistentReminder !== 'boolean') return bad('persistentReminder', '要是布尔值');
    out.persistentReminder = b.persistentReminder;
  }
  if ('endAt' in b) {
    // **不校验「结束早于开始」**：那是一句自相矛盾的话，但它是用户的话——跟
    // 上面 `startAt` 那条「不校验开始晚于截止」是同一条既有约定。日历那边按
    // 「没有时长」处理，不画一个负高度的块。
    if (!isIsoOrNull(b.endAt)) return bad('endAt', '要是 ISO 8601 带时区的时间字符串（2026-08-15T09:00:00.000Z）或 null');
    out.endAt = b.endAt;
  }
  if ('section' in b) {
    // 空串归 null：界面上把输入框清空就是「不在任何分段里」，存一个空字符串
    // 会让它变成一个名字为空的分段，分组时冒出一个没有标题的组。
    if (b.section !== null && typeof b.section !== 'string') return bad('section', '要是字符串（清单里的分段名）或 null');
    out.section = typeof b.section === 'string' && b.section.trim() === '' ? null : b.section as string | null;
  }
  if ('waitingFor' in b) {
    if (b.waitingFor !== null && typeof b.waitingFor !== 'string') return bad('waitingFor', '要是字符串（在等谁/等什么）或 null');
    out.waitingFor = b.waitingFor as string | null;
  }
  if ('reviewedAt' in b) {
    if (!isIsoOrNull(b.reviewedAt)) return bad('reviewedAt', '要是 ISO 8601 带时区的时间字符串（2026-08-15T09:00:00.000Z）或 null');
    out.reviewedAt = b.reviewedAt;
  }
  if ('context' in b) {
    // `Object.hasOwn`，不是 `in`：`in` 走原型链，`'__proto__' in {}`、`'toString' in {}`
    // 都是 true，于是 `context: '__proto__'` 校验通过、原样落盘；界面上
    // `CONTEXT_LABEL[t.context]` 取回的是 `Object.prototype` 这个对象，React 一句
    // 「Objects are not valid as a React child」，这条任务所在的每张卡、每一行全白。
    if (b.context !== null && !(typeof b.context === 'string' && Object.hasOwn(CONTEXT_OK, b.context))) {
      return bad('context', `要是 ${Object.keys(CONTEXT_OK).join(' / ')} 之一，或 null`);
    }
    out.context = b.context as TaskContext | null;
  }
  if ('attachments' in b) {
    if (!Array.isArray(b.attachments) || b.attachments.some((a) => typeof a !== 'string')) return bad('attachments', '要是字符串数组');
    out.attachments = b.attachments as string[];
  }
  if ('focusSessions' in b) {
    if (!Array.isArray(b.focusSessions)) return bad('focusSessions', '要是数组，每条形如 { startedAt: ISO 时间, minutes: 正数 }');
    const fs: FocusSession[] = [];
    for (const s of b.focusSessions) {
      if (typeof s !== 'object' || s === null) return bad('focusSessions', '要是数组，每条形如 { startedAt: ISO 时间, minutes: 正数 }');
      const { startedAt, minutes } = s as Record<string, unknown>;
      if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) return bad('focusSessions', '每条的 startedAt 要是合法的 ISO 时间字符串');
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return bad('focusSessions', '每条的 minutes 要是大于 0 的数字');
      fs.push({ startedAt, minutes });
    }
    out.focusSessions = fs;
  }
  if ('habit' in b) {
    if (typeof b.habit !== 'boolean') return bad('habit', '要是布尔值');
    out.habit = b.habit;
  }
  if ('estimateMinutes' in b) {
    // `null` = 没估过。数字要是**正整数**：0 分钟不是一个估计（那是「不用做」），
    // 半分钟的精度对「打算花多久」这件事没有意义。上限 24 小时——超过一天的
    // 那不该是一条任务，是一个项目。
    if (b.estimateMinutes !== null
      && (typeof b.estimateMinutes !== 'number' || !Number.isInteger(b.estimateMinutes)
        || b.estimateMinutes <= 0 || b.estimateMinutes > 24 * 60)) {
      return bad('estimateMinutes', '要是 1～1440 之间的整数（分钟），或者 null（没估过）');
    }
    out.estimateMinutes = b.estimateMinutes as number | null;
  }
  if ('pinned' in b) {
    if (typeof b.pinned !== 'boolean') return bad('pinned', '要是布尔值');
    out.pinned = b.pinned;
  }
  if ('parentId' in b) {
    // 只校验形状。「不能挂到自己身上」「不能挂到一条本身有父的任务下面」
    // 「自己有孩子就不能再当别人的孩子」这三条要看**别的任务**长什么样，
    // 校验器只看得见这一份 patch——判在 app.ts 的路由里，那儿读得到全表。
    if (b.parentId !== null && typeof b.parentId !== 'string') return bad('parentId', '要是某条任务的 id（字符串）或 null');
    out.parentId = b.parentId as string | null;
  }

  // habit 只在「每天」或「每周」重复上成立。「每月打卡」不是习惯，是一条普通的
  // 重复任务——这一条不变。
  //
  // **原来只认「每天」**，理由写的是「『每月打卡』不是习惯」。那句话本身对，
  // 但它**盖不住滴答明确举的那个例子**：「健身，我只需要一周完成 3 次即可」
  // （《开始坚持一个习惯》）。那按常识就是习惯，而在放宽之前
  // 这个应用连表达都表达不了——标成习惯就必须每天做。
  //
  // 「一周三次」在这儿的表达方式是 `every: 'week'` + `weekdays: [1,3,5]`：
  // **次数就是选中的天数**。跟滴答不完全一样（它那边不指定哪几天），但不用
  // 为它新加一个字段——而「哪几天」这个信息本身对打卡是有用的，不是纯粹的
  // 多余约束。
  // 这里拒收而不是悄悄改正——跟 status:'later' 同一条路径：悄悄改会把 AI 的
  // 错误藏起来，让它下次接着犯。
  // 注意只在**这次 patch 同时给了两个字段**时判断；只改 habit 不改 repeat 的
  // 局部 patch 判断不了（校验器拿不到这条任务原来的 repeat 是不是每天），
  // 一律拒收——想把一条任务标成习惯，必须同时把 repeat 一起发上来。这不是
  // 「合并后再校验一次」（那是 applyTaskPatch 的事，不在这个 Task 范围内），
  // 是校验器在只看得见这一份 patch 时唯一能守住不变量的做法。
  if (out.habit === true && 'repeat' in b
    && !HABIT_EVERY.includes(out.repeat?.every as never)) {
    return bad('habit', '要是 true，必须配 repeat.every === "day" 或 "week"——习惯是「每天做」或者「每周做几次」');
  }
  if (out.habit === true && !('repeat' in b)) {
    return bad('habit', '要是 true，必须同时带上 repeat（每天做或每周做几次）——单独改 habit 判断不了原任务的重复档');
  }

  return { ok: true, value: out };
}

/** 只要「合法与否」的调用方继续用这个。带原因的走 `checkTaskPatch`。 */
export function sanitizeTaskPatch(body: unknown): TaskPatch | null {
  const r = checkTaskPatch(body);
  return r.ok ? r.value : null;
}

/**
 * `ok:true, value: null` = 合法地表示「不重复」；`ok:false` = 不合法。
 * 这两种都用同一个 `null` 表达是这个函数原来的形状陷阱——`repeat: null` 是一个
 * 合法值，不能跟校验失败共用一个返回值，所以这里不再用裸 `null`/`undefined` 分流。
 *
 * `interval`/`weekdays`/`until` 三个键缺了就落默认值（`1`/`[]`/`null`），
 * 不当成校验失败——`model.ts` 里 `Repeat` 类型定义的形状是给「落盘之后的完整
 * 对象」用的，不代表 AI 写 outbox 时这三个键必须一个不少。`weekdays` 对
 * 「每天/每月/每年」这几种重复语义上本来就是空的，AI 没有理由给它们填值；
 * 少写任何一个就让整个 outbox 文件被拒收，逼 AI 在 `Task` 的整张字段表里瞎猜，跟
 * `AGENTS.md` 从没列过 `Repeat` 字段形状这件事合在一起，等于一个 AI 实际上
 * 写不出来的「新能力」。给出的键该是什么类型还是什么类型，不放松。
 */
function checkRepeat(v: unknown): SanitizeResult<Repeat | null> {
  // 档位名单拼进错误文案，不手抄第二份——手抄的那份加档时不会跟上，
  // 而它正是 400 里唯一告诉对方「合法值有哪些」的地方。
  const fail = bad('repeat', `every 要是 ${REPEAT_KINDS.join(' / ')} 之一；interval 要是正整数；weekdays 里每个数字要在 0-6 之间；until 要是 ISO 时间或 null；from 要是 due / done 之一；count 要是非负整数或 null；step 要是非负整数；monthDay 要是 1-31 的整数或 null`);
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'object') return fail;
  const r = v as Record<string, unknown>;
  // 名单从 `model.ts` 的 `REPEAT_KINDS` 拿，不在这儿手抄一份——手抄的那份
  // 跟类型分叉时编译器一个字都不说，表现是「表单里选得出来、保存回来 400」。
  if (!(REPEAT_KINDS as readonly string[]).includes(r.every as string)) return fail;
  const interval = 'interval' in r ? r.interval : 1;
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1) return fail;
  const weekdays = 'weekdays' in r ? r.weekdays : [];
  if (!Array.isArray(weekdays) || weekdays.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) return fail;
  const until = 'until' in r ? r.until : null;
  if (!(until === null || (typeof until === 'string' && !Number.isNaN(Date.parse(until))))) return fail;
  // 跟 interval/weekdays/until 同一条：缺了落默认值 'due'（到期重复），不算
  // 校验失败——加这个字段之前写下的 outbox 和 data/tasks 里那些 repeat 都没有
  // 它，拒收会让一批本来好好的数据突然进不来。给了就得是两个值之一。
  const from = 'from' in r ? r.from : 'due';
  if (from !== 'due' && from !== 'done') return fail;
  // 「还要再重复几次」。缺了落 null（一直重复），跟上面四个同一条。0 是合法值
  // ——意思是「这是最后一条，别再生成了」，`nextInstance` 就是这么读它的；
  // 拒收 0 会让「刚好用完」的那条重复任务在最后一次完成时炸出一个校验失败。
  const count = 'count' in r ? r.count : null;
  if (!(count === null || (typeof count === 'number' && Number.isInteger(count) && count >= 0))) return fail;
  // 艾宾浩斯走到第几步。缺了落 0（还没复习过），跟上面几个同一条。别的重复
  // 档位不读它，写了也没害处，不单独拦。
  const step = 'step' in r ? r.step : 0;
  if (!(typeof step === 'number' && Number.isInteger(step) && step >= 0)) return fail;
  // 月重复锚在几号。缺了落 null（没记过），跟上面几个同一条——这个字段是后加的，
  // `data/tasks/` 里现有的 repeat 一个都没有它。别的重复档位不读它。
  const monthDay = 'monthDay' in r ? r.monthDay : null;
  if (!(monthDay === null
    || (typeof monthDay === 'number' && Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31))) return fail;
  return {
    ok: true,
    value: {
      every: r.every as Repeat['every'], interval, weekdays: weekdays as number[],
      until: until as string | null, from, count, step, monthDay: monthDay as number | null,
    },
  };
}

/**
 * AI 提议里 `patch` 允许改的字段，白名单。**比 `sanitizeTaskPatch` 窄。**
 *
 * 不在里面的一律**拒收**（返回 null，整个 outbox 文件退回），不是悄悄过滤掉——
 * 跟现在拒 `status: 'later'` 是同一条道理：悄悄改掉会把 AI 的错误藏起来，
 * 让它下次接着犯。见 outbox.ts 里 `status:'later'` 那段的说明。
 *
 * 为什么这几个不给 AI 提：
 * - `status` / `order`：是人的字段。完成与否、先做哪个，是纯粹的意志表达，
 *   不是能被论证的东西（见 2026-08-12-today-view.md）
 * - `source`：改了它就等于篡改「这条是谁写的」，双色墨水整套都靠它
 * - `aiComment`：拆解当时的记录，是历史事实，不该被后来的分析改写
 * - `completedAt` / `postponeCount` / `focusSessions`：服务端自己盖章、自己数，
 *   AI 没有第一手依据去改这几个
 * - `habit` / `attachments`：前者是人怎么看待这条任务，后者 AI 不产生文件
 *
 * `reminders` 整体在白名单里，`firedAt` 不单独挡——约定是 AI 提建议时一律写
 * `firedAt: null`（跟拆解时的约定一致），但这是文档层面的约定，不在这里
 * 重复做一层字段级校验；`applyTaskPatch` 接受后会按时刻重算，AI 写的
 * `firedAt` 值本来就不会被采纳。
 *
 * `priority` **在白名单里，但 AI 拆解时不能直接写**（outbox.ts 的 toTask 强制
 * 归 0）。这看着矛盾，其实正是建议机制存在的意义：AI 有根据地提（「这条卡了
 * 三周，四条别的任务在等它」），人点了才算数。
 */
export const PROPOSABLE = [
  'title', 'notes', 'due', 'startAt', 'reminders', 'subtasks',
  'tags', 'listId', 'repeat', 'priority', 'waitingFor', 'context',
] as const;
// `startAt`（开始时间）进白名单：**「这条现在还做不了」正是回顾该给的判断**，
// 而且比另外两条路都准——改 `due` 是替他撒谎（截止时间没变），让他搁置又把
// 「做不了」和「不想做」混在一起。有了这一档，AI 可以提「等 9 月开学再说」，
// 他点一下接受就行。跟 `due` 一样，它只是提议：落不落地由人点。

/**
 * 带原因的版本，跟 `checkListPatch`/`checkTaskPatch` 同一个套路——`outbox.ts`
 * 拼横幅要用。旧版只调 `sanitizeTaskPatch` 拿布尔值，五种完全不同的失败
 * （非对象 / 空 patch / 白名单外的键 / 字段形状不对）共用外面同一句模板，
 * 而「字段在白名单里、形状不对」这种（比如 `due` 写成「下周三」）落进那句
 * 模板会变成假话：它说的原因（不在白名单/patch 是空对象）两条都不成立，
 * AI 照着改只能把这个字段删掉，等于放弃这条建议。
 *
 * 白名单这两道判断还是自己判、自己给 `bad(...)`——**不是**直接扔给
 * `checkTaskPatch`，因为 `PROPOSABLE` 比 `TaskPatch` 的白名单窄（`status`/
 * `order`/`source` 等在 `checkTaskPatch` 里合法，在这里不合法，见上面
 * `PROPOSABLE` 的注释）。过了这两道之后，字段形状交给 `checkTaskPatch`——
 * 跟 `sanitizeTaskPatch` 用的是同一份，白拿它已经做好的 field/reason。
 */
export function checkProposalPatch(body: unknown): SanitizeResult<TaskPatch> {
  if (typeof body !== 'object' || body === null) return bad('patch', '要是一个对象（只包含要改的字段）');
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  // 空 patch 拒——一条什么都不改的建议摆在卡片上，点「接受」什么也不会发生，
  // 比没有更糟。
  if (!keys.length) return bad('patch', '不能是空对象——一条什么都不改的建议没有意义');
  // 白名单之外出现任何一个键就整条拒收，不是悄悄过滤掉。`!== undefined`，
  // 不是判真值——键名 `""` 是合法但不在白名单里的键，见 list.ts 同一处的教训。
  const badKey = keys.find((k) => !(PROPOSABLE as readonly string[]).includes(k));
  if (badKey !== undefined) return bad(badKey, `不是能建议修改的字段——白名单只有 ${PROPOSABLE.join(' / ')}，你传的是 "${badKey}"`);
  return checkTaskPatch(b);
}

/** 只要「合法与否」的调用方继续用这个。带原因的走 `checkProposalPatch`。 */
export function sanitizeProposalPatch(body: unknown): TaskPatch | null {
  const r = checkProposalPatch(body);
  return r.ok ? r.value : null;
}
