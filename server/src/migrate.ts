import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isSafeId, writeOne } from './entityStore.js';
import { CONTEXTS, STATUSES } from './task.js';
import { deviceConfigPath, type InboxItem, type Proposal, type Reminder, type Status, type Subtask, type Task, type TaskContext } from './store.js';

export const SCHEMA_VERSION = 2;

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * 迁移出来的每一条实体都要有一个安全的 id。「安全」的判据是 `entityStore.isSafeId`
 * ——两边不能各写一份、迟早飘。这里跟 `entityStore.writeOne` 内部那道守卫选的
 * 处理方式不同：那边发现不安全直接拒绝（抛错），这边现造一个新的、不强行
 * 保留坏值——迁移是一次性、批量的搬家，旧数据里出现空 id 或者带 `../../x`
 * 的脏值（真实发生过：多条记录都缺 id、都落成同一个文件名互相覆盖）不该让
 * 整次迁移失败，静默换一个新 id 让这条记录继续搬过去就行。
 */
function safeId(raw: unknown): string {
  return isSafeId(raw) ? raw : randomUUID();
}

/**
 * 一条 v1 任务升到 v2。**幂等**：已经是 v2 的对象再升一次结果不变，
 * 这样迁移中途崩了重跑也安全。
 */
export function upgradeTask(raw: Record<string, unknown>): Task {
  // 已经是 v2 的（有 reminders 数组）就原样用，否则从 remindAt/remindedAt 合成。
  const reminders: Reminder[] = Array.isArray(raw.reminders)
    ? (raw.reminders as Reminder[])
    : typeof raw.remindAt === 'string'
      ? [{ at: raw.remindAt, firedAt: strOrNull(raw.remindedAt) }]
      : [];

  const status = STATUSES.includes(raw.status as Status) ? (raw.status as Status) : 'todo';
  const updatedAt = str(raw.updatedAt, str(raw.createdAt, new Date(0).toISOString()));

  return {
    id: safeId(raw.id),
    title: str(raw.title),
    notes: str(raw.notes),
    status,
    due: strOrNull(raw.due),
    // 老数据没有「开始时间」——`null` 就是「随时可以做」，也正是加这个字段
    // 之前的行为。跟下面 estimateMinutes 同一条：只认合法值，手改文件里写个
    // 「下周」不该原样传下去（`strOrNull` 只收字符串，日期合不合法由
    // task.ts 的校验器在写入那一侧把关）。
    startAt: strOrNull(raw.startAt),
    endAt: strOrNull(raw.endAt),
    persistentReminder: raw.persistentReminder === true,
    reminders,
    subtasks: Array.isArray(raw.subtasks) ? (raw.subtasks as Subtask[]) : [],
    // 老数据没有这个字段——没估过就是 null，跟新建的一样。数字才认，
    // 手改文件里写个 "两小时" 不该变成 NaN 到处传。
    estimateMinutes: typeof raw.estimateMinutes === 'number' && Number.isFinite(raw.estimateMinutes)
      ? raw.estimateMinutes
      : null,
    source: raw.source === 'ai' ? 'ai' : 'user',
    aiComment: str(raw.aiComment),
    createdAt: str(raw.createdAt, updatedAt),
    updatedAt,
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : null,

    listId: strOrNull(raw.listId),
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    priority: [0, 1, 2, 3].includes(raw.priority as number) ? (raw.priority as 0 | 1 | 2 | 3) : 0,
    repeat: (raw.repeat as Task['repeat']) ?? null,

    // v1 没有完成时间。已完成的用 updatedAt 近似——**这是能拿到的最好结果**，
    // 因为完成之后如果又编辑过备注，updatedAt 就已经不是完成那一刻了。
    // 偏差只会往一个方向走：updatedAt 只会被后续编辑推后，不会提前，所以这个
    // 近似值只会比真实完成时间**偏晚**，不会偏早——以后做完成率、周回顾这类
    // 统计时要知道这个方向。从今天起 completedAt 由服务端在 status→done 时
    // 准确盖章。
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : status === 'done' ? updatedAt : null,
    postponeCount: typeof raw.postponeCount === 'number' && Number.isFinite(raw.postponeCount) ? raw.postponeCount : 0,
    section: strOrNull(raw.section),
    waitingFor: strOrNull(raw.waitingFor),
    reviewedAt: strOrNull(raw.reviewedAt),
    // 情境：不认得的值一律归 null，不硬塞。旧文件、手改错的、别的版本写进来的
    // 都走这条——一个界面上选不出来的值留在数据里，等于一条永远筛不到的任务。
    context: CONTEXTS.includes(raw.context as TaskContext) ? (raw.context as TaskContext) : null,
    attachments: Array.isArray(raw.attachments) ? (raw.attachments as string[]) : [],
    focusSessions: Array.isArray(raw.focusSessions) ? (raw.focusSessions as Task['focusSessions']) : [],
    habit: raw.habit === true,
    pinned: raw.pinned === true,
    parentId: strOrNull(raw.parentId),
  };
}

function readArray(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch (e) {
    // **绝不吞掉。** 吞掉就意味着把用户唯一一份数据当成空的，然后写一个空目录
    // 上去。宁可整个起不来，让人去修那个文件。跟 store.ts 的 readJson 同一条规矩。
    throw new Error(`${file} 不是合法的 JSON，迁移中止（一个字节都没动）：${(e as Error).message}`);
  }
}

/**
 * settings.json 搬去设备配置。**用「拷贝完再删源」，不用 `renameSync`**——
 * `data/` 和设备配置目录完全可能不在同一个卷（真实栽过：`data/` 在 D:、
 * `%APPDATA%` 在 C:；POSIX 上 `data/` 挂在同步盘、`~/.config` 在系统盘同理），
 * `fs.renameSync` 不能跨卷，会抛 `EXDEV`。用 `renameSync` 会崩在一个特别难
 * 自愈的位置：这一步夹在「三个旧文件已经改名成 `.v1`」和「`meta.json` 还没
 * 写」之间，一旦在这里抛出，`tasks.json` 已经不在了、`.v1` 那道防重复迁移
 * 的守卫也不会拦（它只查 `existsSync(f) && existsSync(f.v1)`，`f` 已经没了），
 * 于是**下次启动会在同一行再崩一次**——服务永久起不来，除非有人手动把
 * `settings.json` 挪走。拷贝+删除不跨卷，没有这个问题；万一拷贝成功但删除
 * 那一步失败，目标文件已经写出来了，下次重跑会因为 `existsSync(dev)` 为真
 * 直接跳过，顶多两边各留一份，不会卡死。
 *
 * 目标已经存在（比如这台机器已经手动配过 device.json）就不碰，两边都不覆盖，
 * 不知道该信哪一份，宁可都不动。
 */
function moveSettings(dir: string): void {
  const old = join(dir, 'settings.json');
  const dev = deviceConfigPath();
  if (!existsSync(old) || existsSync(dev)) return;
  mkdirSync(dirname(dev), { recursive: true });
  copyFileSync(old, dev);
  unlinkSync(old);
}

/**
 * v1（三个大数组）→ v2（一实体一文件）。
 *
 * 顺序有讲究：**先把三份旧文件全部读完并解析**，再动手写。任何一份坏掉都在
 * 写任何东西之前抛出来，磁盘保持原样。这跟 `outbox.ts` 的 `mergeOneFile`
 * 「三个文件全部在第一次写之前读完」是同一条规矩。
 */
export function migrate(dir: string): { migrated: boolean; counts: Record<string, number> } {
  const metaFile = join(dir, 'meta.json');
  let alreadyCurrent = false;
  if (existsSync(metaFile)) {
    let meta: { schemaVersion?: number };
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { schemaVersion?: number };
    } catch {
      throw new Error(`${metaFile} 不是合法的 JSON，迁移中止（一个字节都没动）`);
    }
    // 数据的版本号比这份代码认识的还新——大概率是被更新版本的代码写过，现在
    // 被一份旧代码打开。跟「版本号不等就当成没迁移过重跑一遍」的默认逻辑
    // 不一样：旧逻辑重跑一遍等于拿旧格式覆盖新格式，是悄悄把数据降级，
    // 宁可拒绝启动，也不能这样。
    if (typeof meta.schemaVersion === 'number' && meta.schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `${metaFile} 的 schemaVersion(${meta.schemaVersion}) 比这份代码认识的版本（${SCHEMA_VERSION}）更新，拒绝用旧代码打开新数据（迁移中止，一个字节都没动）`,
      );
    }
    alreadyCurrent = meta.schemaVersion === SCHEMA_VERSION;
  }

  // settings 搬家独立于下面「v1 数组 -> v2 实体」这条主线：哪怕核心数据早就
  // 是 v2（下面 alreadyCurrent 为真、本该直接返回），也可能是升级到这份代码
  // 之前就迁移过一次、settings.json 还没搬走——放在提前返回**之前**调用，
  // 两种情况（全新迁移、核心数据已是 v2 只差 settings）都能补上。放在这里
  // 而不是跟三个旧文件一起处理，是因为它不参与「全部读完再写」那条不变量：
  // 跟 tasks/inbox/proposals 的内容无关，不需要等它们的读写完成。
  moveSettings(dir);

  if (alreadyCurrent) return { migrated: false, counts: {} };

  const tasksFile = join(dir, 'tasks.json');
  const inboxFile = join(dir, 'inbox.json');
  const proposalsFile = join(dir, 'proposals.json');

  // .v1 是迁移出错时唯一的退路，改名前先确认它还没被占用。已经存在说明大概率
  // 是上一次迁移留下的、真正的原始备份（比如 meta.json 因为同步冲突被改名
  // 丢失，这次又被当成没迁移过重跑了一遍）——renameSync 对已存在的目标是
  // **覆盖**，硬改会把上一次的原始备份，用这一次（可能已经被别的代码重新
  // 铺成空/半新）的内容盖掉，唯一的退路就没了。宁可迁移在这一步整体失败、
  // 让人先处理掉那个 .v1，也不能悄悄覆盖——这一步放在任何读写之前，跟坏
  // JSON 的检查一样「先把所有能让整批失败的理由查完，再动手」。
  for (const f of [tasksFile, inboxFile, proposalsFile]) {
    if (existsSync(f) && existsSync(`${f}.v1`)) {
      throw new Error(
        `${f}.v1 已经存在，是上一次迁移留下的备份，可能是 meta.json 丢失导致这次被当成没迁移过——为了不覆盖真正的原始数据，迁移中止（这一步之前没有写任何东西）：先处理掉这个 .v1 文件再重跑`,
      );
    }
  }

  // 全部读完再写，见上面的注释。
  const rawTasks = readArray(tasksFile);
  const rawInbox = readArray(inboxFile);
  const rawProposals = readArray(proposalsFile);

  const hadAnything = existsSync(tasksFile) || existsSync(inboxFile) || existsSync(proposalsFile);

  // **换掉的任务 id 要回填到引用它的地方。** `safeId` 在 id 不安全时现造一个
  // uuid（理由见它自己的注释），而 `InboxItem.taskIds` 和 `Proposal.taskId` 里
  // 存的还是旧那个——不回填的话，搬完这两处引用全指向空气：收件箱那条记录点
  // 不开它拆出来的任务，AI 建议挂在一个不存在的 id 上（界面上就是「建议列表里
  // 有一条，但哪张卡片上都找不到」）。实测复现过：`../../evil` 的任务被换成
  // uuid，而 `taskIds` 仍是 `["../../evil"]`。
  //
  // 只记「真的换了」的那几条：绝大多数迁移一条都不换，这个 Map 是空的。
  const remapped = new Map<string, string>();
  for (const r of rawTasks) {
    const up = upgradeTask(r);
    const before = typeof r.id === 'string' ? r.id : '';
    if (before && before !== up.id) remapped.set(before, up.id);
    writeOne(join(dir, 'tasks'), up);
  }
  const remap = (id: unknown): unknown => (typeof id === 'string' && remapped.has(id) ? remapped.get(id) : id);

  // inbox/proposals 不经过 upgradeTask，但一样会被 writeOne 拿 id 拼文件名，
  // 一样要过 safeId 这道关——理由见 safeId 的注释。
  for (const r of rawInbox) {
    const taskIds = Array.isArray(r.taskIds) ? r.taskIds.map(remap) : r.taskIds;
    writeOne(join(dir, 'inbox'), { ...r, id: safeId(r.id), taskIds } as unknown as InboxItem);
  }
  for (const r of rawProposals) {
    writeOne(join(dir, 'proposals'), { ...r, id: safeId(r.id), taskId: remap(r.taskId) } as unknown as Proposal);
  }

  // 旧文件改名保留，**不删**。迁移出错时这是唯一的退路。
  for (const f of [tasksFile, inboxFile, proposalsFile]) {
    if (existsSync(f)) renameSync(f, `${f}.v1`);
  }

  // meta.json 也要原子写：先写同目录 .tmp 再 rename，跟 entityStore.writeOne /
  // store.writeAtomic 同一条规矩——直接 writeFileSync 到目标文件，写到一半
  // 崩了会留下半截 JSON，下次启动读 meta.json 直接抛错，比没有 meta.json
  // 更难自愈。
  const metaTmp = `${metaFile}.tmp`;
  writeFileSync(metaTmp, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2)}\n`, 'utf8');
  renameSync(metaTmp, metaFile);

  return {
    migrated: hadAnything,
    counts: { tasks: rawTasks.length, inbox: rawInbox.length, proposals: rawProposals.length },
  };
}
