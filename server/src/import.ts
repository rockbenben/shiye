import { isSafeId, caseClashIn } from './entityStore.js';
import { checkTaskPatch, isIsoOrNull, STATUSES } from './task.js';
import type { Settings } from './model.js';
import {
  readInbox, writeInbox, readTasks, writeTasks, readProposals, writeProposals,
  readLists, writeLists, readFolders, writeFolders, readInsights, writeInsights,
  readCountdowns, writeCountdowns, readTrash, writeTrash,
  readSettings, writeSettings, writeImportBackup,
} from './store.js';

/**
 * 「导出数据」的九个键里，八张 data/ 表的名单（settings 不在其中——它不落
 * data/，存在设备本地，见 store.ts 的 deviceConfigPath）。
 * **Task 10 的守卫测试用正则抓这一行的字面量比对导出侧名单——别改成
 * 拼接、别拆成多个常量。**
 */
export const IMPORT_KEYS = ['inbox', 'tasks', 'proposals', 'lists', 'folders', 'countdowns', 'insights', 'trash'] as const;
export type DataTableKey = (typeof IMPORT_KEYS)[number];
export type ImportPayload = Record<DataTableKey, unknown[]> & { settings: Record<string, unknown> };

export type CheckOk = { ok: true; counts: Record<DataTableKey, number> };
export type CheckFail = { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 九键齐全 + 每表条数 + **表内 id 三道关**（非空字符串且路径安全、不重复、
 * 大小写不撞）。形状校验在 Task 5 的 `checkShapes`。
 *
 * id 判据用存储层的 `isSafeId`（entityStore.ts）——`..`/斜杠的 id 校验时
 * 必须点名拒掉，而不是走到 `syncAll` 时 `assertSafeId` 抛在写到一半：
 * 「校验不过 = data/ 一字节不碰」是整个导入的立身之本。
 * 大小写撞（Windows 上 foo/Foo 同一个文件）交给存储层同款判据 `caseClashIn`
 * 先筛，理由和 push 那边一样：抛到落盘会炸整批。
 */
export function checkKeysAndIds(payload: unknown): CheckOk | CheckFail {
  if (!isPlainObject(payload)) return { ok: false, error: '顶层要是一个对象（「导出数据」的原样文件内容）' };
  for (const k of IMPORT_KEYS) {
    if (!Array.isArray(payload[k])) return { ok: false, error: `缺一个键「${k}」，或者它不是数组` };
  }
  if (!isPlainObject(payload.settings)) return { ok: false, error: '缺一个键「settings」，或者它不是一个对象' };

  const counts = {} as Record<DataTableKey, number>;
  for (const k of IMPORT_KEYS) {
    const rows = payload[k] as Record<string, unknown>[];
    counts[k] = rows.length;
    const ids = rows.map((r) => (isPlainObject(r) ? r.id : undefined));
    const seen = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!isSafeId(id)) {
        return { ok: false, error: `${k}[${i}] 的 id 不安全——不能是空串，也不能包含路径分隔符（/ 或 \\）或 ..（可能是路径穿越），或不符合存储层的文件名安全规则（见 entityStore.ts 的 isSafeId：还挡 Windows 保留设备名、控制字符、非法字符、尾随点/空格、冲突副本后缀等）` };
      }
      if (seen.has(id)) return { ok: false, error: `${k}[${i}] 的 id「${id}」在这张表里重复出现` };
      seen.add(id);
    }
    // 走到这里每个 id 都过了 isSafeId（它把 unknown 收窄成 string），上面的
    // 循环已逐个验完，这里整体断言是安全的。
    const clash = caseClashIn(ids as string[]);
    for (let i = 0; i < ids.length; i++) {
      if (clash(ids[i] as string)) return { ok: false, error: `${k}[${i}] 的 id「${ids[i]}」与同表另一条只差大小写——Windows 上它们是同一个文件` };
    }
  }
  return { ok: true, counts };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** 任务的身份类字段先过这道。`title`/`status` 下面 `checkTaskPatch` 也会再判
 *  一遍（两句话一致，判据见 task.ts）；`createdAt`/`updatedAt`/`completedAt`/
 *  `postponeCount` 只有这里管——那是 `checkTaskPatch` 压根不认的字段。 */
function taskIdentity(r: Record<string, unknown>): string | null {
  if (!isStr(r.title) || !r.title.trim()) return 'title 要是非空字符串';
  if (!STATUSES.includes(r.status as never)) return 'status 要是 todo / doing / done / later / abandoned 五个之一';
  if (!isIsoOrNull(r.createdAt) || r.createdAt === null) return 'createdAt 要是合法的 ISO 时间字符串';
  if (!isIsoOrNull(r.updatedAt) || r.updatedAt === null) return 'updatedAt 要是合法的 ISO 时间字符串';
  if (!isIsoOrNull(r.completedAt)) return 'completedAt 要是合法 ISO 时间或 null';
  if (!(typeof r.postponeCount === 'number' && Number.isInteger(r.postponeCount) && r.postponeCount >= 0)) return 'postponeCount 要是非负整数';
  return null;
}

/**
 * 一条记录形状对不对。返回 null = 通过，字符串 = 一句「字段：为什么」。
 *
 * **任务的重活委托给 `checkTaskPatch`**——reminders/subtasks/repeat/context
 * 那一整串嵌套形状的校验它已经有了，导入抄第二份必有一份是旧的。但**方向
 * 相反**的两件事这里不发生：不 trim 重建、不归零强字段。导入是「原样恢复
 * 用户自己的数据」，`order: 3` 就得还是 `3`——`checkTaskPatch` 只借它的
 * 「判」，不借它的「洗」。所以传进去之前先把五个它不认的字段摘掉，返回值
 * 本身丢弃（校验通过 = 收原样，不做清洗）。
 */
function checkShape(key: DataTableKey, raw: unknown): string | null {
  if (!isPlainObject(raw)) return '要是一个对象';
  switch (key) {
    case 'tasks': {
      const why = taskIdentity(raw);
      if (why) return why;
      const { id: _i, createdAt: _c, updatedAt: _u, completedAt: _ca, postponeCount: _pc, ...rest } = raw;
      const r = checkTaskPatch(rest);
      return r.ok ? null : `${r.field}: ${r.reason}`;
    }
    case 'inbox':
      return isStr(raw.text) && isIsoOrNull(raw.createdAt) && raw.createdAt !== null
        && isBool(raw.processed) && Array.isArray(raw.taskIds) && raw.taskIds.every(isStr)
        ? null : '要形如 { text, createdAt, processed, taskIds }';
    case 'proposals':
      return isStr(raw.taskId) && isPlainObject(raw.patch) && Object.keys(raw.patch).length > 0
        && isStr(raw.reason) && isIsoOrNull(raw.createdAt) && raw.createdAt !== null
        && ('dismissed' in raw ? isBool(raw.dismissed) : true)
        ? null : '要形如 { taskId, patch(非空对象), reason, createdAt[, dismissed] }';
    case 'lists':
      return isStr(raw.name) && isStr(raw.color) && (raw.folderId === null || isStr(raw.folderId))
        && typeof raw.order === 'number' && isBool(raw.archived)
        && (raw.filter === null || isPlainObject(raw.filter))
        ? null : '要形如 { name, color, folderId, order, archived, filter }';
    case 'folders':
      return isStr(raw.name) && typeof raw.order === 'number' ? null : '要形如 { name, order }';
    case 'insights':
      return (['pattern', 'duplicate', 'stuck', 'note'] as const).includes(raw.kind as 'pattern')
        && isStr(raw.text) && raw.text.trim() && Array.isArray(raw.taskIds) && raw.taskIds.every(isStr)
        && isIsoOrNull(raw.createdAt) && raw.createdAt !== null && isIsoOrNull(raw.dismissedAt ?? null)
        ? null : '要形如 { kind: pattern|duplicate|stuck|note, text, taskIds, createdAt, dismissedAt }';
    case 'countdowns':
      return isStr(raw.title) && isStr(raw.date) && isBool(raw.yearly) && isBool(raw.lunar)
        && isIsoOrNull(raw.createdAt) && raw.createdAt !== null
        && isIsoOrNull(raw.updatedAt) && raw.updatedAt !== null
        ? null : '要形如 { title, date, yearly, lunar, createdAt, updatedAt }';
    case 'trash': {
      const why = taskIdentity(raw);
      if (why) return why;
      if (!isIsoOrNull(raw.deletedAt) || raw.deletedAt === null) return 'deletedAt 要是合法 ISO 时间';
      const { id: _i, createdAt: _c, updatedAt: _u, completedAt: _ca, postponeCount: _pc, deletedAt: _d, ...rest } = raw;
      const r = checkTaskPatch(rest);
      return r.ok ? null : `${r.field}: ${r.reason}`;
    }
  }
}

/** 形状校验。**前置：调用方保证已过 checkKeysAndIds**（九键、每行有合法 id）。 */
export function checkShapes(payload: unknown): { ok: true } | CheckFail {
  const p = payload as Record<DataTableKey, unknown[]>;
  for (const k of IMPORT_KEYS) {
    const rows = p[k];
    for (let i = 0; i < rows.length; i++) {
      const why = checkShape(k, rows[i]);
      if (why) return { ok: false, error: `${k}[${i}] ${why}` };
    }
  }
  return { ok: true };
}

/**
 * 导入把每张表的记录当「原样搬运的行」：applyImport 不读任何业务字段，唯一
 * 依赖是 id 存在（前置：调用方已过 checkKeysAndIds）。model.ts 的实体全是
 * interface（没有隐式索引签名），接不进 `Record<string, unknown>`——读写两头
 * 都要 `as unknown as` 双层桥。用 `{ id: string }` 做最小公共形状：读方向
 * 天然可赋值，写方向一次 `as` 就够，且这个 cast 本身有校验前置兜着。
 */
type AnyRow = { id: string };

export interface ApplyDeps {
  readTable: (k: DataTableKey) => AnyRow[];
  writeTable: (k: DataTableKey, rows: AnyRow[]) => void;
  readSettings: () => Settings;
  writeSettings: (s: Settings) => void;
  writeBackup: (json: string) => string;
}

/** 表名 → store 的读写对。**名单只在这两处出现，遍历驱动，别手抄第三份。** */
const TABLE_IO: Record<DataTableKey, { read: () => AnyRow[]; write: (v: AnyRow[]) => void }> = {
  inbox: { read: readInbox, write: writeInbox as (v: AnyRow[]) => void },
  tasks: { read: readTasks, write: writeTasks as (v: AnyRow[]) => void },
  proposals: { read: readProposals, write: writeProposals as (v: AnyRow[]) => void },
  lists: { read: readLists, write: writeLists as (v: AnyRow[]) => void },
  folders: { read: readFolders, write: writeFolders as (v: AnyRow[]) => void },
  countdowns: { read: readCountdowns, write: writeCountdowns as (v: AnyRow[]) => void },
  insights: { read: readInsights, write: writeInsights as (v: AnyRow[]) => void },
  trash: { read: readTrash, write: writeTrash as (v: AnyRow[]) => void },
};

export const defaultDeps = (): ApplyDeps => ({
  readTable: (k) => TABLE_IO[k].read(),
  writeTable: (k, rows) => TABLE_IO[k].write(rows),
  readSettings,
  writeSettings,
  writeBackup: writeImportBackup,
});

/**
 * 先拍快照 → 快照落盘 → 逐表整表替换。中途任何一张表写失败，把**已动过的**
 * 逐张按快照写回（settings 同），然后把错误抛给路由层——横幅措辞是「导入失败、
 * 已回滚到导入前状态」（跟「校验不过、未触碰任何数据」是两种话，别混）。
 *
 * 落盘的快照就是「导出数据」的同形状文件：**带错了备份来、导成功了，恢复办法
 * 是把这份再导回去**，不做撤销 UI。
 *
 * 快照本身写失败 → 直接中止（没有回滚保险就不做替换），不吞错。
 */
export function applyImport(payload: ImportPayload, deps: ApplyDeps = defaultDeps()): {
  counts: Record<DataTableKey, number>; backupFile: string;
} {
  const snapshot = {} as Record<DataTableKey, AnyRow[]> & { settings: Settings };
  for (const k of IMPORT_KEYS) snapshot[k] = deps.readTable(k);
  snapshot.settings = deps.readSettings();

  const backupJson = JSON.stringify(
    Object.fromEntries([...IMPORT_KEYS.map((k) => [k, snapshot[k]]), ['settings', snapshot.settings]]),
    null, 2,
  );
  let backupFile: string;
  try {
    backupFile = deps.writeBackup(backupJson);
  } catch (e) {
    // 备份都写不下去 = 此刻一张表都还没碰。给错误打标让路由改说「导入没有
    // 开始」——什么都没动过却报「已回滚」，是比不报更糟的假话。
    throw Object.assign(e as Error, { dataUntouched: true });
  }

  const touched: DataTableKey[] = [];
  try {
    for (const k of IMPORT_KEYS) {
      // 先记账后动手：真实的 writeTable（syncAll）可能在表内逐文件写到一半时
      // 抛（磁盘满/文件锁），这张「半换」的表必须在回滚名单里，否则 500 那句
      // 「已回滚到导入前状态」就是假话。回滚一张没动过的表是无害的 syncAll no-op。
      touched.push(k);
      deps.writeTable(k, payload[k] as AnyRow[]);
    }
    deps.writeSettings(payload.settings as unknown as Settings);
  } catch (e) {
    for (const k of touched) deps.writeTable(k, snapshot[k]);
    deps.writeSettings(snapshot.settings);
    throw e;
  }
  return {
    counts: Object.fromEntries(IMPORT_KEYS.map((k) => [k, (payload[k] as AnyRow[]).length])) as Record<DataTableKey, number>,
    backupFile,
  };
}
