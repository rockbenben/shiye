import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Bus } from './events.js';
import { isSafeId } from './entityStore.js';
import { emitAgentStatus } from './expand.js';
import { bad, checkProposalPatch, checkTaskPatch, type SanitizeResult } from './task.js';
import {
  deleteOutboxFile, newTask, nowIso, outboxFiles, readInbox, readInsights, readOutboxFile, readProposals, readTasks,
  strayOutboxFiles, writeInbox, writeInsights, writeProposals, writeTasks,
  type InboxItem, type Insight, type OutboxEntry, type OutboxInsightEntry, type OutboxUpdateEntry, type Proposal, type Task,
} from './store.js';

/**
 * 校验一条 outbox 里的任务对象，通过就补齐成完整 `Task`；不通过就带上是哪个
 * 字段、为什么——外面 `mergeOneFile` 拼横幅文案要用，AI 拿到「status 要是
 * todo/doing/done/later 之一」才有得改，拿到一句「没通过校验」只能在 25 个
 * 字段里猜。
 *
 * 内容字段（title/notes/status/due/reminders/subtasks/source/aiComment）
 * 走 `checkTaskPatch`——跟 `POST /api/tasks` 同一份代码，这是设计文档里
 * 唯一标成硬性要求的一条，不许抄第二份。
 *
 * **失败分两种，不能报成一句话**：`checkTaskPatch` 本身没过（字段形状不对，
 * 原因由它给）；和「形状全对但没给 `title`」——`checkTaskPatch` 只校验「给出的
 * 字段」，不检查必填，缺 `title` 不算它的失败，这里单独判、单独报，别报成
 * 某个不相干字段的形状错。
 *
 * `id`/`createdAt`/`updatedAt` 这三个字段 `checkTaskPatch` 压根不认（HTTP 那边
 * 从不接受客户端传这三个），outbox 这边不一样：AI 写的是「完整任务对象」，理应
 * 自己带 id 和时间戳。这里单独兜底——写了合法值就用，没写或者写坏了就落到
 * `newTask()` 的默认值（新 uuid、当前时间），不算校验失败。
 */
/**
 * 校验前把「AI 写什么都不算数」的那几个字段整个摘掉——不止 `order`，
 * `priority`/`completedAt`/`postponeCount`/`focusSessions`/
 * `attachments` 六个新字段跟它是同一个道理：下面 `toTask` 反正会强制覆盖成
 * 固定默认值，校验它们的类型没有意义，只有坏处。
 *
 * `checkTaskPatch` 对其中四个——`order`/`priority`/
 * `focusSessions`/`attachments`——是「类型不对就拒收」（`PATCH
 * /api/tasks/:id` 需要这条，人手滑传错类型要能看到 400），但那是给人经网页
 * 发起的请求用的规矩。outbox 是 AI 写的、信任边界之外的输入，这五个字段在
 * 这条路径上唯一合法的处理方式就是覆盖——AI 写个字符串、写个超范围的数字，
 * 都不该让 `checkTask` 判定失败、进而让 `mergeOneFile` 拒收这一整个文件。
 * 不摘掉的话会出现第三种、谁都没设计过的行为：「填对了当没填（反正会被覆盖），
 * 填错了却让整份文件退回」——即使 `checkTaskPatch` 现在会指名是这四个字段里
 * 哪一个，那也是在让 AI 白费一次改动去修一个结果完全不采信的字段，不摘掉的话
 * 等于逼它去关心一件不该关心的事。
 *
 * `completedAt`/`postponeCount` 这两个字段不是这条道理——上一个 Task 已经把
 * 它们整个从 `checkTaskPatch` 的白名单里删掉了（`TaskPatch` 类型上已经
 * 没有这两个键，人也不能再经 `PATCH` 直接改），`checkTaskPatch` 现在压根
 * 不认它们，给了也不会被拒收、只是不会被采纳。这里仍然把它们跟另外五个一起
 * 摘掉，纯粹是不让原始值混进下面 `newTask()` 的入参、图一个统一，不是在
 * 避免一次本来就不会发生的类型校验拒收。
 *
 * `AGENTS.md`「校验失败会怎样」一节原话（举的是 `order`，同一条道理套在
 * 全部七个字段上）：「order 不在这条规则里……不管你写什么都会被悄悄改成
 * null」——这里改代码去符合这条承诺，不是反过来放宽承诺去将就代码。
 */
function stripForced(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const {
    order: _order, priority: _priority,
    // `stuckNote` **字段已经删了**（谁都写不了、谁都读不到，被 `waitingFor`
    // 取代），但这里仍然要接住它再丢掉：按老约定写 outbox 的 AI（括号里那份
    // 提示词可能还缓存在别处）还会带一把 `"stuckNote": null`——不摘掉的话，
    // 它会变成一个白名单外的键，把**整个 outbox 文件**退回去。接住并丢掉正是
    // 这个函数的职责。
    stuckNote: _stuckNote, completedAt: _completedAt,
    postponeCount: _postponeCount, focusSessions: _focusSessions, attachments: _attachments,
    // 置顶是人的判断（跟 order/priority 同一类）；父子关系不给 AI 写——
    // 它拆一句话出来的那几条本来就靠「按来源」表达「同出一源」，再给它一套
    // 父子关系是同一件事的第二种说法，见 model.ts 里 Task 那段注释。
    pinned: _pinned, parentId: _parentId,
    // 「这件事要花多久」是他的判断，跟 priority/order 同一类——AI 没有依据
    // 估你的速度。写了不报错，也不采纳。
    estimateMinutes: _estimateMinutes,
    // 「人看过没看过」是人的记录，AI 替他盖这个章等于替他做了那个决定
    // ——一条 AI 标成「看过了」的项目会从回顾清单上消失，而他从没看过它。
    reviewedAt: _reviewedAt,
    // 怎么给自己的清单分段是他的组织习惯，跟 pinned/parentId 同一类——
    // AI 拆出来的那几条本来就靠「按来源」聚在一起，再塞进某个分段是替他
    // 决定这份清单该怎么摆。
    section: _section,
    // 「这件事重不重要到要一直烦我」是他的判断，跟 priority 同一类。
    persistentReminder: _persistentReminder,
    ...rest
  } = raw as Record<string, unknown>;
  return rest;
}

function checkTask(raw: unknown): SanitizeResult<Task> {
  const r = checkTaskPatch(stripForced(raw));
  if (!r.ok) {
    // status 的原因单独换一句：task.ts 里的共用文案（「要是 todo / doing /
    // done / later 之一」）对 PATCH /api/tasks/:id 是对的——人经网页发起的
    // 写，四个值都合法。但这里的读者是 AI，AGENTS.md「拆解要做的事」写得
    // 很死：AI 只能写 todo，later 是人的决定，写了会被下面 mergeOneFile 里
    // 另一条特判单独拒收（在调用这个函数之前就已经拦下，走不到这里）。
    // 照着共用文案改的 AI 有 1/3 概率把自己送进那条特判、再退回一次——这里
    // 只改 outbox 这一侧看到的话，不动 task.ts 的共用文案，PATCH 的 400
    // 不受影响。
    if (r.field === 'status') return bad('status', '要是 todo——拆解阶段只能写这一个值，later（搁置）是人的决定，写了会被单独拒收');
    // task.ts 的 'body' 分支说的是「整个请求体」——那是 HTTP 路由的词汇，
    // outbox 这条路上没有「请求体」这回事，AI 会去找一个不存在的东西，
    // `body` 这个字段名也不是它写的任何键。这里换成 outbox 语境的话（同一条
    // 道理，见 status 分支的注释）。
    if (r.field === 'body') return bad('task', '要是一个任务对象——这一项写成了别的东西（字符串/数组/null），不是 { title, status, … } 那样的对象');
    return r;
  }
  const patch = r.value;
  // 形状全对但没给 title：checkTaskPatch 只校验「给出的字段」，不检查必填，
  // 这不算它的失败——单独判、单独报「标题不能缺」，别报成某个不相干字段的
  // 形状错，那会把 AI 指去改一个没问题的字段。
  // reason 是接在 field 后面的延续小句（拼接成 `${field} ${reason}`），
  // 不能自己再带一遍「标题」当主语，不然读出来是「title 标题缺失……」，
  // 字段名跟主语重复一遍，见 code review 记录。
  if (!patch.title) return bad('title', '不能缺——每个任务都要有一句说清做什么的标题');
  const raw2 = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const id = typeof raw2.id === 'string' && raw2.id.trim() ? raw2.id : undefined;
  // id 不安全（含 `..` 或路径分隔符）：在这里拒收，走「校验不过、整份文件退回、
  // tasks/ 一个都不碰」这条已经存在且正确的路——不是悄悄换一个新 uuid 继续往下
  // 走。选「拒绝」不选「悄悄改」，是因为这条检查以前只在 entityStore.writeOne
  // 里做：那时候同一份 outbox 里排在前面的好任务已经被 `syncAll` 逐条写过盘了，
  // 排在后面的坏 id 才让 `writeTasks()` 整体抛出异常——好任务落了地，横幅却报
  // 「tasks.json 没有改动」，这句话是假的；而且这份 outbox 文件不会被删，
  // `checkTask` 之外没有别的地方会把它标记成「处理过」，下次触发原样重来一遍，
  // 同一个错永远重复，人不手动介入出不去。挪到这里、在 `mergeOneFile` 处理完
  // `entries` 数组、真正调用 `writeTasks()` 之前拦下：写盘那一步压根碰不到，
  // `tasks/` 真的一个字节都不会被碰，横幅也能跟标题为空、status 写错一样，
  // 说清楚是哪个字段、为什么、怎么改，而不是一句「落盘失败」让人去猜。
  if (id !== undefined && !isSafeId(id)) {
    return bad('id', '不安全——不能包含路径分隔符（/ 或 \\）或 ..（这类值会被服务拒绝落盘，可能是路径穿越）。换成一个新生成的 uuid，或者干脆不写这个字段让服务自动生成');
  }
  const createdAt = typeof raw2.createdAt === 'string' && !Number.isNaN(Date.parse(raw2.createdAt)) ? raw2.createdAt : undefined;
  const updatedAt = typeof raw2.updatedAt === 'string' && !Number.isNaN(Date.parse(raw2.updatedAt)) ? raw2.updatedAt : undefined;
  const value = newTask({
    ...patch,
    title: patch.title,
    ...(id ? { id } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    // reminders 整体在 checkTaskPatch 的校验范围内，但里面每一条的
    // firedAt 不是——AGENTS.md 说的是「一律写 null」，这是文档层面的约定，
    // `stripForced` 摘的是顶层键，摘不到嵌在数组里的字段。AI 写一个过去的
    // firedAt 能让这条提醒直接被判定成「已经发过」，静默失效：dueTasks()
    // 到点扫描时会把它当成已完成的提醒跳过，网页横幅、Windows 通知、
    // webhook 三路都不会响，而且不报错——所以这里强制覆盖，不是校验拒收。
    ...(patch.reminders ? { reminders: patch.reminders.map((rem) => ({ at: rem.at, firedAt: null })) } : {}),
    // outbox 只有 AI 会写。`source` 不管 AI 填没填、填的是什么，一律钉死成
    // 'ai'——`newTask()` 不给这个字段的默认值是 'user'，漏了这一条的话卡片
    // 就不会挂「AI 拆解」标签，看着跟用户自己建的没区别。
    source: 'ai',
    // order 是人的判断（手动排序），AI 写什么都不算数——不管 patch.order 里
    // 是不是有值，这里一律覆盖成 null，跟上面 source 的做法同一个套路。选择
    // 「静默覆盖」而不是「校验失败拒收整个文件」：AI 没有任何正当理由要给这
    // 个字段填值，覆盖本身就是纠正，不需要再退回去让 AI 重试。跟下面对
    // status:'later' 的处理刻意不同——那个是校验拒绝，见 mergeOneFile 里的
    // 说明。
    order: null,
    // 跟 order / source 同一个套路：这些字段 AI 写什么都不算数，静默覆盖。
    // 选择覆盖而不是拒收，是因为 AI 没有任何正当理由给它们填值，覆盖本身
    // 就是纠正；而 habit/repeat 那种「填错了要让它看见」的走校验拒收。
    priority: 0,
    completedAt: null,
    postponeCount: 0,
    // stripForced 摘掉的那几个在这里统一落成默认值，见它上面的说明。
    estimateMinutes: null,
    focusSessions: [],
    attachments: [],
  });
  return { ok: true, value };
}

function isValidEntry(entry: unknown): entry is OutboxEntry {
  return typeof entry === 'object' && entry !== null
    && typeof (entry as Record<string, unknown>).inboxId === 'string'
    && Array.isArray((entry as Record<string, unknown>).tasks);
}

/** 第二种条目：`{ updates: [...] }`，AI 对已有任务提的修改建议。 */
function isUpdateEntry(entry: unknown): entry is OutboxUpdateEntry {
  return typeof entry === 'object' && entry !== null
    && Array.isArray((entry as Record<string, unknown>).updates);
}

/** 第三种条目：`{ insights: [...] }`，AI 的跨任务观察，见 model.ts 里 Insight 的注释。 */
function isInsightEntry(entry: unknown): entry is OutboxInsightEntry {
  return typeof entry === 'object' && entry !== null
    && Array.isArray((entry as Record<string, unknown>).insights);
}

/** 合法的 insight kind 取值。标了类型（跟 task.ts 的 STATUSES 同一个写法）：
 * model.ts 那个字面量联合类型以后加值时，这里漏加会被编译器拦下来。 */
const INSIGHT_KINDS: Insight['kind'][] = ['pattern', 'duplicate', 'stuck', 'note'];

/**
 * 一条观察的身份，用来去重：kind + text + taskIds 三样全同才算同一条。
 * 跟 proposalKey 同一个理由——id 是服务端现生成的，中断重试会生成新 id、
 * 内容一样的重复。taskIds 排序之后再序列化：同一个观察，AI 两次给出的
 * taskIds 顺序可能不同，不排序就去重不掉。
 */
const insightKey = (kind: string, text: string, taskIds: string[]): string =>
  JSON.stringify([kind, text, [...taskIds].sort()]);

/** 返回 null 表示不合法，整个 outbox 文件退回——跟其它内容字段同一条路径。 */
function toInsight(raw: unknown): Omit<Insight, 'id' | 'createdAt' | 'dismissedAt'> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!INSIGHT_KINDS.includes(r.kind as Insight['kind'])) return null;
  if (typeof r.text !== 'string' || !r.text.trim()) return null;
  if (!Array.isArray(r.taskIds) || r.taskIds.some((t) => typeof t !== 'string')) return null;
  return { kind: r.kind as Insight['kind'], text: r.text.trim(), taskIds: r.taskIds as string[] };
}

/**
 * 一条提议的身份，用来去重：**taskId + patch + reason 三样全同才算同一条。**
 *
 * 需要这个是因为 `updates` 没有 `tasks` 那道防线。任务靠「id 已经在 tasks.json
 * 里就丢弃」挡住中断重试的重复入库，而提议的 id 是服务端在这里现生成的——
 * 写完 proposals.json、还没删掉 outbox 文件就崩了的话，下次重扫会生成一批
 * 新 id、内容一模一样的提议，那道防线认不出来。
 *
 * 顺带挡住另一件事：定期分析每一轮都会看到同一条过期任务，不去重的话每跑
 * 一次就多一条一字不差的建议。
 *
 * 只挡「三样全同」的精确重复。换了措辞的重复挡不住，那个靠 `workflows/review.md`
 * 让 AI 跑之前先读 `data/proposals/`、跳过已经有**待决**提议的任务（规矩的正本在
 * `AGENTS.md`「提修改建议」那节）。**「待决」这两个字是要紧的**：他按过「忽略」的
 * 那些也留在同一个目录里（只是打了 `dismissed: true`），但那条规矩说的是「别再提
 * 同一个意见」，不是「这条任务从此别管」——两者并成一条的话，一次忽略就等于把那条
 * 任务永久移出回顾（那些记录不会过期）。
 */
const proposalKey = (taskId: string, patch: unknown, reason: string): string =>
  JSON.stringify([taskId, patch, reason]);

interface FileResult {
  newTaskCount: number;
  /** 这个文件产出的 AI 修改建议条数。跟 `newTaskCount` 分开数：一个只含
   * `updates` 的文件会拆出 0 个新任务，但它显然干了活——两个数合成一个的话，
   * 汇报会说「没有新增任务」，那是假话。 */
  proposalCount: number;
  skippedCount: number;
  /** 指向已经不存在的任务、因而被丢弃的建议数。跟 duplicateCount 一样要进
   * 横幅：只记日志的话，AI 写错 id 时用户看不出少了东西。 */
  droppedCount: number;
  /** 因为 id 已经在 `tasks.json` 里而被丢弃的任务数——多半是中断后的重试，
   * 但也可能是 AI 手滑复用了旧 id，那种情况下这个任务是真的丢了（新内容没有
   * 落地）。之前只写进服务窗口的日志，横幅不提，AI 犯错时用户看不出少了东西——
   * `mergeOutbox` 把它汇总进汇报消息，见「另有 N 个 id 重复被跳过」那一句。 */
  duplicateCount: number;
  /** 这个文件里数组顶层的条目数——包括空数组文件（0）——用来在 `mergeOutbox`
   * 里区分「压根没什么要处理的」和「处理了、但没憋出新任务」两种不一样的沉默。 */
  entryCount: number;
  /** 这个文件产出的新观察条数。可选（默认当 0 算）——只在真有 insights 条目
   * 被处理的分支里才会给出，不给已有的一大堆返回点都补一个 0，跟
   * `proposalCount` 分开数是同一个理由：一个只含 `insights` 的文件不该被判
   * 定成「什么都没干」。 */
  insightCount?: number;
  failure?: string;
  /** `failure` 存在时，这个字段说明它是「校验没过」（false/未给出）还是
   * 「校验都过了、落盘或清理那一步出的意外」（true）——两种在 `mergeOutbox`
   * 汇总消息里不能用同一句话，前者说「原样留着改好重试」，后者说的是
   * 「数据可能已经部分改动，不是你能修的字段问题」，误报会把人指错方向。 */
  writeFailure?: boolean;
}

/**
 * 删 outbox 文件失败（Windows 上杀毒软件或者残留句柄占着文件的 EPERM/EBUSY
 * 不算稀奇）不能让异常原样往上冒——`mergeOutbox` 是从 `events.ts` 一个裸
 * `setTimeout` 回调里调用的，没人接得住，异常会变成 uncaughtException 把
 * 整个服务带走。降级成一条警告 + 一个用户看得见的失败状态，文件留在原地：
 * 下一次任何触发都会重新扫到它、重新试一次删除——如果 tasks/inbox 已经在
 * 这次改成功了，那条收件箱记录已经 `processed`，重试会被幂等检查直接挡掉，
 * 不会重复入库，纯粹是「这个文件还赖在 data/ 里」这一件事需要人工清理。
 */
function safeDelete(file: string, base: string): string | undefined {
  try {
    deleteOutboxFile(file);
    return undefined;
  } catch (e) {
    const message = `${base}：内容已经合并完成，但删除文件失败，会一直留在 data/ 里（不影响已经写入的数据，可以手动删掉）：${(e as Error).message}`;
    console.warn('[outbox]', message);
    return message;
  }
}

/**
 * 合并单个 outbox 文件。**每次都自己 `readInbox()` / `readTasks()`，不接受调用方
 * 传进来的快照**——这是同一批里多个文件互相看得见彼此效果的唯一原因：文件 A
 * 把某条标成 `processed: true`、把某个 id 写进 `tasks.json` 之后，紧接着处理的
 * 文件 B 读到的就是刚写完的新状态，天然被下面「已处理就跳过」「id 已存在就
 * 丢弃」两条逻辑拦下——不需要在调用方另外维护一份「这一批里处理过什么」。
 *
 * 任何一项校验不过 → 这一个文件不合并，原样留着，返回的 `failure` 里带上文件名
 * 和第几项——别的文件不受影响，调用方会接着处理下一个。
 */
function mergeOneFile(file: string): FileResult {
  const base = basename(file);

  let entries: Array<OutboxEntry | OutboxUpdateEntry | OutboxInsightEntry>;
  try {
    entries = readOutboxFile(file);
  } catch (e) {
    return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: (e as Error).message };
  }

  if (!Array.isArray(entries)) {
    return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base}：顶层必须是数组` };
  }

  if (entries.length === 0) {
    const delErr = safeDelete(file, base);
    return delErr
      ? { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: delErr, writeFailure: true }
      : { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0 };
  }

  let inbox: InboxItem[];
  try {
    inbox = readInbox();
  } catch (e) {
    return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base}：读取 inbox.json 失败：${(e as Error).message}` };
  }
  const processedIds = new Set(inbox.filter((x) => x.processed).map((x) => x.id));

  let existingTasks: Task[];
  try {
    existingTasks = readTasks();
  } catch (e) {
    return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base}：读取 tasks.json 失败：${(e as Error).message}` };
  }
  // 中断重试的关键防线：写完 tasks.json、还没来得及写 inbox.json 就崩了或者
  // 磁盘满了，outbox 文件还在，下次触发会重新读到同一份。这个任务的 id
  // 已经在 tasks.json 里了——再入库一次就是同一个 id 挂在两张卡上，
  // PATCH 只改得到第一张，DELETE 会把两张一起删掉，原任务陪葬。
  const existingIds = new Set(existingTasks.map((t) => t.id));

  let existingProposals: Proposal[];
  try {
    existingProposals = readProposals();
  } catch (e) {
    return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base}：读取 proposals.json 失败：${(e as Error).message}` };
  }
  const proposalKeys = new Set(existingProposals.map((p) => proposalKey(p.taskId, p.patch, p.reason)));

  let existingInsights: Insight[];
  try {
    existingInsights = readInsights();
  } catch (e) {
    return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base}：读取 insights.json 失败：${(e as Error).message}` };
  }
  const insightKeys = new Set(existingInsights.map((i) => insightKey(i.kind, i.text, i.taskIds)));

  const newTasks: Task[] = [];
  const newProposals: Proposal[] = [];
  const newInsights: Insight[] = [];
  const idsByInbox = new Map<string, string[]>();
  const skippedIds: string[] = [];
  const duplicateIds: string[] = [];
  const droppedProposals: string[] = [];

  for (let ei = 0; ei < entries.length; ei++) {
    const entry = entries[ei];

    // 一个条目里同时出现 tasks / updates / insights 中的不止一个：拒收整个
    // 文件，不猜他想干嘛。AGENTS.md 说的「几种可以混在同一个文件里」指的是
    // 数组里放多个条目，不是一个条目里塞多个键——但那句话确实容易读成后者。
    // 之前这里是先认 updates 就 `continue`，于是 tasks 连同 inboxId 被静默
    // 丢掉：任务永远不会生成，收件箱那条也永远标不上 processed，而文件照样
    // 被删掉、横幅只报「提了 N 条建议」。人只会看见笔记还卡在「待拆解」，
    // 下一轮自动拆解再烧一次 AI 去处理同一条。宁可整批退回让 AI 看见、改对。
    //
    // **`in` 操作符必须先确认 entry 是对象**：AI 手滑把顶层数组写成
    // `[null]` / `["一句话"]` / `[123]` 这种裸值不算稀奇，`k in entry` 对
    // 非对象直接抛 `TypeError`（不是返回 false）——这里如果不挡，异常会一路
    // 冒出 `mergeOneFile`，`mergeOutbox` 没有 try/catch，服务启动时补合并
    // 那条路径会直接把进程带崩，而且文件永远删不掉，每次重启都崩。非对象
    // 条目留给下面 `isValidEntry` 的形状检查去拒收、报清楚的错误，这里只
    // 保证不炸。
    const presentKeys = typeof entry === 'object' && entry !== null
      ? (['tasks', 'updates', 'insights'] as const).filter((k) => k in entry)
      : [];
    // 键出现即算，不看值是什么——`{ tasks: [...], updates: null }` 这种键
    // 都摆在那儿但值是 null 的半成品，也会被判定成「同时写了 tasks 和
    // updates」而整份拒收，不会因为 updates 不是数组就放过去当成单纯的
    // tasks 条目处理。比旧版（`isUpdateEntry(entry) && isValidEntry(entry)`，
    // 只在 updates 真的是数组时才拦）更严格，是有意的：既然 AGENTS.md
    // 讲的是「一个条目只能是其中一种」，键出现本身就已经是「写了另一种」的
    // 信号，不该因为值凑巧不合法就当它没出现过。
    if (presentKeys.length > 1) {
      return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base} 第 ${ei + 1} 项同时写了 ${presentKeys.join(' 和 ')}——一个条目只能是其中一种。拆解结果、修改建议、观察要分成数组里的不同条目。` };
    }

    // 第二种条目：AI 对已有任务的修改建议。不写 tasks.json，写 proposals.json——
    // AI 不直接改任务，见 model.ts 里 Proposal 的注释。
    if (isUpdateEntry(entry)) {
      for (let ui = 0; ui < entry.updates.length; ui++) {
        const raw = entry.updates[ui];
        const where = `${base} 第 ${ei + 1} 项第 ${ui + 1} 条建议`;
        if (typeof raw !== 'object' || raw === null) {
          return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${where}不是对象` };
        }
        const u = raw as Record<string, unknown>;
        if (typeof u.id !== 'string' || !u.id.trim()) {
          return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${where}缺 id（要改的那条任务的 id）` };
        }
        if (typeof u.reason !== 'string' || !u.reason.trim()) {
          return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${where}缺 reason——没有理由的建议他没法判断该不该接受` };
        }
        // 白名单之外的字段（status/order/source/aiComment……）整个
        // 文件拒收，不是悄悄过滤——跟 status:'later' 同一条道理，见 task.ts 的
        // checkProposalPatch。带原因的版本：五种完全不同的失败（非对象/空
        // patch/白名单外的键/字段形状不对）现在各自一句话，不再共用一句
        // 「只能改…，而且不能是空对象」——那句话在「字段在白名单里、形状
        // 不对」（比如 due 写成「下周三」）这种最常见的失败上是假话。
        const patchResult = checkProposalPatch(u.patch);
        if (!patchResult.ok) {
          return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${where}的 patch 不合法：${patchResult.field} ${patchResult.reason}` };
        }
        const patch = patchResult.value;
        // 任务已经被他删了。丢弃这条建议、记日志，不算校验失败——跟下面
        // 「inboxId 找不到」同一个处理：都是「他在你跑的时候删了」。
        if (!existingIds.has(u.id)) {
          droppedProposals.push(u.id);
          continue;
        }
        const key = proposalKey(u.id, patch, u.reason);
        if (proposalKeys.has(key)) continue;   // 一字不差的重复，见 proposalKey
        proposalKeys.add(key);
        newProposals.push({ id: randomUUID(), taskId: u.id, patch, reason: u.reason, createdAt: nowIso() });
      }
      continue;
    }

    // 第三种条目：AI 的跨任务观察。不挂在任何一条任务或收件箱记录上，
    // 直接写 insights.json，见 model.ts 里 Insight 的注释。
    if (isInsightEntry(entry)) {
      for (let ii = 0; ii < entry.insights.length; ii++) {
        const raw = entry.insights[ii];
        const parsed = toInsight(raw);
        if (!parsed) {
          return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base} 第 ${ei + 1} 项第 ${ii + 1} 条观察没通过校验：kind 要是 ${INSIGHT_KINDS.join(' / ')} 之一，text 不能是空白，taskIds 要是字符串数组` };
        }
        const key = insightKey(parsed.kind, parsed.text, parsed.taskIds);
        if (insightKeys.has(key)) continue;   // 一字不差的重复，见 insightKey
        insightKeys.add(key);
        newInsights.push({ id: randomUUID(), ...parsed, createdAt: nowIso(), dismissedAt: null });
      }
      continue;
    }

    if (!isValidEntry(entry)) {
      return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base} 第 ${ei + 1} 项形状不对：要么是 inboxId（字符串）+ tasks（数组），要么是 updates（数组），要么是 insights（数组）` };
    }

    // 这条收件箱记录已经处理过了——同一条被拆了两次，比如终端里的 /expand
    // 跟网页「立即拆解」前后脚都在跑。整条跳过：一个任务都不入库，inbox.json
    // 那一条也不碰，不然每重复一次看板上就多一整套重复任务。
    // 跟下面「inboxId 找不到」是两回事，别合并处理：找不到是「条目被删了，
    // 活是真的、照样入库」；这里是「条目还在，活已经干过了，不能再干一遍」。
    if (processedIds.has(entry.inboxId)) {
      skippedIds.push(entry.inboxId);
      continue;
    }

    const ids: string[] = [];
    for (let ti = 0; ti < entry.tasks.length; ti++) {
      const raw = entry.tasks[ti];
      // status:'later'（搁置）和 status:'abandoned'（放弃）都是人的决定，
      // AI 不许写——这里选「整个文件拒收」，不是像 order 那样静默覆盖：
      // 这两个都是合法值之一，AI 手滑写出来看起来完全正常，不出声改掉会把
      // 这个错误藏起来，AI 也永远不知道自己越权了；跟标题为空、status 不在
      // 五选一里之类的形状错误走同一条「校验不过」路径最一致——文件原样留着，
      // 改好这一个字段重写整份文件就行。
      const rawStatus = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).status : undefined;
      const HUMAN_ONLY: Record<string, string> = { later: '搁置', abandoned: '放弃' };
      if (typeof rawStatus === 'string' && rawStatus in HUMAN_ONLY) {
        return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base} 第 ${ei + 1} 项第 ${ti + 1} 个任务把 status 写成了 '${rawStatus}'——${HUMAN_ONLY[rawStatus]}是人的决定，AI 不能写这个值` };
      }
      const t = checkTask(raw);
      if (!t.ok) {
        return { newTaskCount: 0, proposalCount: 0, skippedCount: 0, duplicateCount: 0, droppedCount: 0, entryCount: 0, failure: `${base} 第 ${ei + 1} 项第 ${ti + 1} 个任务没通过校验：${t.field} ${t.reason}` };
      }
      const task = t.value;
      // id 撞上已经存在的任务——多半是「tasks.json 写完了、inbox.json 没写完
      // 就中断，outbox 文件还留着」的重试，也可能是 AI 手滑复用了旧 id。两种
      // 情况处理一样：不重复入库、不覆盖原任务，但这个 id 照样算这条收件箱
      // 记录的产出——对应的任务已经在 tasks.json 里，inbox 那半边该完成的事
      // 还是要完成，不然重试永远卡在「任务有了、inbox 没标」的中间态。
      if (existingIds.has(task.id)) {
        duplicateIds.push(task.id);
        ids.push(task.id);
        continue;
      }
      existingIds.add(task.id);   // 同一个文件里前后两条任务不会互相撞出「重复」
      newTasks.push(task);
      ids.push(task.id);
    }
    idsByInbox.set(entry.inboxId, [...(idsByInbox.get(entry.inboxId) ?? []), ...ids]);
  }

  if (skippedIds.length > 0) {
    console.warn(`[outbox] ${base} 跳过已处理过的收件箱条目（避免重复入库）：${skippedIds.join(', ')}`);
  }
  if (duplicateIds.length > 0) {
    console.warn(`[outbox] ${base} 跳过 id 已存在的任务（不会覆盖原任务，多半是中断后的重试）：${duplicateIds.join(', ')}`);
  }
  if (droppedProposals.length > 0) {
    console.warn(`[outbox] ${base} 丢弃了指向已删除任务的建议：${droppedProposals.join(', ')}`);
  }

  if (newTasks.length === 0 && newProposals.length === 0 && newInsights.length === 0 && idsByInbox.size === 0) {
    // 这个文件里的条目全部被跳过（或者本来就没有非跳过的条目）——文件已经被
    // 完整处理过了，删掉。不删的话它会一直躺在 data/ 里，每次目录一有风吹草动
    // 就被重新扫到、重新判一次「已处理，跳过」，纯属噪音。
    const delErr = safeDelete(file, base);
    return delErr
      ? { newTaskCount: 0, proposalCount: 0, skippedCount: skippedIds.length, duplicateCount: duplicateIds.length, droppedCount: droppedProposals.length, entryCount: entries.length, failure: delErr, writeFailure: true }
      : { newTaskCount: 0, proposalCount: 0, skippedCount: skippedIds.length, duplicateCount: duplicateIds.length, droppedCount: droppedProposals.length, entryCount: entries.length };
  }

  // 只在真有新任务时才写 tasks.json——不然是把读回来的同一份内容原样写一遍：
  // 白白触发一轮 watcher、还占掉本来就只留一份的 .bak 名额。
  //
  // `tasksAttempted` 和 `tasksWritten` 分开记：`writeTasks()` 底下是
  // `entityStore.syncAll` 逐条 `writeOne`，没有事务——`newTasks` 有好几条时，
  // 前面几条完全可能已经真的写到磁盘上了，中间那条才抛异常（比如那条的 id
  // 不安全、或者那条的临时文件路径被别的程序占着）。这种情况下 `writeTasks()`
  // 这次调用本身没有跑完，`tasksWritten = true` 这一行永远不会被执行到，但
  // 「一个字节都没改」这个结论是错的——下面 catch 里要能分清「没开始写」和
  // 「写了一半」，不能把两者都报成「没有改动」。
  let tasksAttempted = false;
  let tasksWritten = false;
  let proposalsWritten = false;
  let insightsWritten = false;
  try {
    if (newTasks.length > 0) {
      tasksAttempted = true;
      writeTasks([...existingTasks, ...newTasks]);
      tasksWritten = true;
    }

    // 建议单独一份文件，跟任务互不影响：一个只含 updates 的文件走到这里
    // newTasks 是空的，上面那次 writeTasks 压根不发生。
    if (newProposals.length > 0) {
      writeProposals([...existingProposals, ...newProposals]);
      proposalsWritten = true;
    }

    // 观察也是单独一份文件，跟任务、建议互不影响：一个只含 insights 的文件
    // 走到这里 newTasks/newProposals 都是空的，上面两次写压根不发生。
    if (newInsights.length > 0) {
      writeInsights([...existingInsights, ...newInsights]);
      insightsWritten = true;
    }

    const knownIds = new Set(inbox.map((x) => x.id));
    for (const inboxId of idsByInbox.keys()) {
      if (!knownIds.has(inboxId)) {
        // 用户在 AI 跑的时候把这条收件箱条目删了。任务已经在上面 writeTasks 里
        // 入库了——活没有丢，只是找不到来源那一条、标不了 processed 了。
        console.warn(`[outbox] ${base}：inboxId 找不到，任务已入库但没能标记来源条目：${inboxId}`);
      }
    }
    // 只在真有收件箱条目要标记时才写——`idsByInbox` 空的时候（纯 updates 的
    // 回顾产出）这一行会把内容一字不差地重写一遍，代价是：唯一那份
    // inbox.json.bak 被当前内容盖掉，用户的回滚点没了；外加给所有开着的网页
    // 推一次什么都没变的刷新。跟 DELETE /api/tasks/:id 里那个 `changed` 标志
    // 同一条道理（那里的注释原话：「只在真有东西要清的时候才写文件」）。
    if (idsByInbox.size > 0) {
      const nextInbox = inbox.map((x) => {
        const ids = idsByInbox.get(x.id);
        return ids ? { ...x, processed: true, taskIds: [...x.taskIds, ...ids] } : x;
      });
      writeInbox(nextInbox);
    }

    const delErr = safeDelete(file, base);
    if (delErr) {
      return { newTaskCount: newTasks.length, proposalCount: newProposals.length, insightCount: newInsights.length, skippedCount: skippedIds.length, duplicateCount: duplicateIds.length, droppedCount: droppedProposals.length, entryCount: entries.length, failure: delErr, writeFailure: true };
    }
  } catch (e) {
    // 校验全部通过之后、落盘这一步才炸的（ENOSPC、.bak 被备份软件锁住之类，
    // 或者 `syncAll` 逐条写到一半才失败——`checkTask` 已经把「id 不安全」这种
    // 能提前查出来的挡在校验阶段了，走到这里的都是校验时看不出来的意外）。
    // 跟上面那些「校验没过」的 failure 不是一回事：这里 tasks.json 有可能已经
    // 真的被改了，报「没通过校验」是骗人的，还会让人去修一个根本没问题的字段。
    const detail = (e as Error).message;
    const message = tasksWritten
      ? `${base}：任务已经写进 tasks.json（新增 ${newTasks.length} 个），但后续步骤失败（inbox.json 没能标记来源条目，需要人工确认后重试）：${detail}`
      : tasksAttempted
        // `writeTasks()` 这次调用本身没跑完，但里面可能已经有几条真的落盘了
        // （syncAll 没有事务，逐条写，前面写成的不会因为后面这条失败而回滚）——
        // 不能声称「没有改动」，也数不出精确数字，只能如实说「不确定，去 tasks/
        // 目录核对」，比一句听着安心、实际可能是假的断言更不会误导人。
        ? `${base}：合并落盘时失败，tasks.json 可能已经被部分改动（最多 ${newTasks.length} 个新任务，具体写进去几个需要去 tasks/ 目录核对）：${detail}`
        : `${base}：合并落盘失败，tasks.json 没有改动：${detail}`;
    console.warn('[outbox]', message);
    return {
      newTaskCount: tasksWritten ? newTasks.length : 0,
      // 只认「writeProposals 真的返回了」这一件事。原来这里推的是
      // `tasksWritten || newTasks.length === 0`，那个条件在 writeProposals
      // **自己**抛异常时两个分支都为真，于是横幅报「提了 N 条修改建议」而
      // 磁盘上一条都没有——人去卡片上找，什么也找不到。
      proposalCount: proposalsWritten ? newProposals.length : 0,
      insightCount: insightsWritten ? newInsights.length : 0,
      skippedCount: skippedIds.length,
      duplicateCount: duplicateIds.length,
      droppedCount: droppedProposals.length,
      entryCount: entries.length,
      failure: message,
      writeFailure: true,
    };
  }

  return { newTaskCount: newTasks.length, proposalCount: newProposals.length, insightCount: newInsights.length, skippedCount: skippedIds.length, duplicateCount: duplicateIds.length, droppedCount: droppedProposals.length, entryCount: entries.length };
}

/**
 * 扫一遍 `data/outbox-*.json`，按文件名排序逐个合并，然后把结果汇总成**一条**
 * `agent-status`。
 *
 * **全程同步，没有一个 await**——这正是这整个功能存在的理由：AI 那 92 秒的窗口
 * 被挪到了它自己的进程里，落到这个函数里的只是「文件已经写好，读出来、校验、
 * 落盘」这几步同步操作，跟其它任何一条路由的读-改-写窗口一样窄，不会再把用户
 * 在这几百毫秒里点的东西盖掉。
 *
 * **每次调用都重新扫目录**，不接受一份缓存的文件列表——校验不过的文件会原样
 * 留在磁盘上，下一次任何触发（新文件写入、服务重启时的补一次合并）都会重新
 * 扫到它、重新试一次。不这样做的话，一个偶然写坏的文件会永远躺在那儿，
 * 只有人工介入才能救回来。
 *
 * 一个文件的校验失败不会拖累别的文件：`mergeOneFile` 各管各的，好的照样落盘、
 * 删除，坏的原样留着。汇总状态里两件事都会说：新增了多少、哪个文件出了什么问题。
 *
 * **不管有没有 outbox 文件要处理，都不会一声不吭**——这个仓库已经因为「用户点了
 * 按钮、等了 90 秒、什么反馈都没有」栽过好几次。除了 `files.length === 0`（压根
 * 没有 outbox 文件出现，这次调用本来就跟拆解无关，比如服务正常启动时的例行补
 * 检查）之外，处理到的每一种「没有新任务」结果都会分开说清楚是哪一种：全是已经
 * 处理过的重复触发、还是收件箱里根本没内容要拆、还是 AI 真的跑了一圈但没判出
 * 任何任务。
 */
export function mergeOutbox(bus: Bus): void {
  const files = outboxFiles();

  // `data/outbox.json`（没有 `-<unique>`，硬化之前的老名字）这类文件永远匹配不上
  // `OUTBOX_RE`：`outboxFiles()` 扫不到它、events.ts 的监听器也不认它是 outbox
  // 文件——它会在 data/ 里躺到天荒地老，没有任何提示。这里顺手扫一遍，日志里
  // 喊一声，不阻塞正常合并。
  for (const stray of strayOutboxFiles()) {
    console.warn(`[outbox] 发现文件名不认识，不会被合并：${stray}（期望的格式是 outbox-<unique>.json，比如 outbox-a1b2c3.json）`);
  }

  if (files.length === 0) return;

  let newTaskCount = 0;
  let proposalCount = 0;
  let insightCount = 0;
  let skippedCount = 0;
  let duplicateCount = 0;
  let droppedCount = 0;
  let totalEntryCount = 0;
  const validationFailures: string[] = [];
  const writeFailures: string[] = [];

  for (const file of files) {
    const result = mergeOneFile(file);
    newTaskCount += result.newTaskCount;
    proposalCount += result.proposalCount;
    insightCount += result.insightCount ?? 0;
    skippedCount += result.skippedCount;
    duplicateCount += result.duplicateCount;
    droppedCount += result.droppedCount;
    totalEntryCount += result.entryCount;
    if (result.failure) {
      (result.writeFailure ? writeFailures : validationFailures).push(result.failure);
    }
  }

  // 因为 id 撞车被丢弃的任务——之前只进服务窗口的日志，横幅只报「新增 N 个」，
  // AI 犯错（复用了旧 id）时用户看不出少了东西。三个分支（失败/全无新增/成功）
  // 都可能碰到，统一补这一句。
  const duplicateNote = duplicateCount > 0 ? `，另有 ${duplicateCount} 个 id 重复被跳过` : '';
  // 定期分析产出的是建议、不是新任务。不单独数它的话，一个只含 updates 的
  // 文件会走进下面 `newTaskCount === 0` 那条分支，横幅说「没有新增任务」——
  // 明明提了几条建议，说成什么都没干是假话。
  const proposalNote = proposalCount > 0 ? `，AI 提了 ${proposalCount} 条修改建议` : '';
  // 指向已经不存在的任务而被丢弃的建议。跟 duplicateNote 同一个道理：只写进
  // 服务窗口的日志的话，AI 手滑写错 id 时用户完全看不出少了东西——他只会看到
  // 一句「没有产出新任务」，而 AI 在对话里说「我提了 3 条建议」。
  const droppedNote = droppedCount > 0 ? `，另有 ${droppedCount} 条建议指向已经不存在的任务、被丢弃` : '';
  // 观察不挂在任何一个任务卡上，跟 proposalNote 同一个理由分开数：一个只含
  // insights 的文件不该被后面「没有产出新任务」那条分支盖过去，那句话是假话。
  const insightNote = insightCount > 0 ? `，记录了 ${insightCount} 条观察` : '';

  if (validationFailures.length > 0 || writeFailures.length > 0) {
    // 两种失败分开说：「校验没过」意味着 tasks.json 没被动过，改好那个字段重来
    // 就行；「写入失败」意味着校验其实都通过了，落盘或清理那一步才出的意外，
    // 数据可能已经部分改动——这种时候告诉人家「没通过校验」是骗人的，还会把
    // 人往错的方向指（去改一个根本没问题的字段）。
    const parts: string[] = [];
    if (newTaskCount > 0 || proposalCount > 0 || insightCount > 0) parts.push(`新增 ${newTaskCount} 个任务${proposalNote}${insightNote}${duplicateNote}${droppedNote}`);
    if (validationFailures.length > 0) parts.push(`以下文件没通过校验，原样留在 data/ 里：${validationFailures.join('；')}`);
    if (writeFailures.length > 0) parts.push(`以下文件校验通过但落盘/清理时出了问题（不是校验没过，数据可能已经部分改动）：${writeFailures.join('；')}`);
    const message = parts.join('；');
    console.warn('[outbox]', message);
    emitAgentStatus(bus, { state: 'failed', message });
    return;
  }

  // 只提了建议/记录了观察、没拆出新任务：这是定期分析的正常结果，不是
  // 「什么都没发生」。两种不能共用「提了 N 条建议，在任务卡上等你确认」这句
  // 模板：insightCount > 0 而 proposalCount === 0 时，套用模板会说出「提了
  // 0 条修改建议」——数字对但语气上是在讲一件没发生的事；而观察本来就不挂在
  // 任何一张任务卡上（见 model.ts 里 Insight 的注释），说「在任务卡上等你
  // 确认」对观察是假话。分别拼句、按各自有没有内容决定说不说。
  if (newTaskCount === 0 && (proposalCount > 0 || insightCount > 0)) {
    const bits: string[] = [];
    if (proposalCount > 0) bits.push(`提了 ${proposalCount} 条修改建议，在「按来源」对应的任务卡上等你确认`);
    if (insightCount > 0) bits.push(`记录了 ${insightCount} 条观察`);
    emitAgentStatus(bus, { state: 'ok', message: `分析完成，AI ${bits.join('；')}${duplicateNote}${droppedNote}` });
    return;
  }

  if (newTaskCount === 0) {
    const message = totalEntryCount === 0
      // 处理到的文件全是顶层空数组——AI 看过一圈，收件箱里没有要拆的内容。
      ? '收件箱里没有需要拆的内容，本次没有新增任务'
      : totalEntryCount === skippedCount
        // 有内容，但全部命中了「已经处理过」的幂等检查——重复触发拆解。
        ? `${skippedCount} 条收件箱记录都已经处理过，本次没有新增任务（可能是拆解被重复触发了）`
        // 有内容、也真处理了，但没有一条落成新任务——AI 判断都不是任务，
        // 或者对应的任务因为 id 冲突被跳过（多半是中断后的重试）。
        : `AI 跑完了，但没有产出新任务（可能是内容都不算需要拆的任务，或者对应的任务已经存在）${duplicateNote}${droppedNote}`;
    emitAgentStatus(bus, { state: 'skipped', message });
    return;
  }

  const skippedNote = skippedCount > 0 ? `，跳过 ${skippedCount} 条已处理过的` : '';
  emitAgentStatus(bus, { state: 'ok', message: `拆解完成，新增 ${newTaskCount} 个任务${proposalNote}${insightNote}${skippedNote}${duplicateNote}${droppedNote}` });
}
