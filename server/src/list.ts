import type { Folder, List, SmartFilter, Status, TaskContext } from './store.js';
import { CONTEXTS, STATUSES, bad, type SanitizeResult } from './task.js';

/**
 * 群青是 AI 的记号，不能拿来当分类色。
 *
 * 分类色和「谁写的」共存的整套办法是：分类色只上 background、永不上 color，
 * 所以清单名本身还是石墨黑。但如果清单色本身就是群青，一个蓝点挨着石墨黑
 * 标题，照样会被读成「这是 AI 的记号」。挡在写入这一层，比在界面上补救干净。
 * 大小写都要挡（`#2e3ed4` 和 `#2E3ED4` 是同一个颜色）。
 */
export const INK_AI = '#2E3ED4';

/**
 * `SmartFilter` 允许出现哪些键。**导出**是因为它是这个字段集合的第三份定义
 * （另外两份是 `model.ts` 的接口和 web 的 `emptyFilter()`），而它是唯一一份
 * 编译器管不着的——加了字段没跟上，表现是**界面上筛得出来、存智能清单时整份
 * filter 被 400 退回**。`web/src/lib/smartFilter.test.ts` 有一条守卫拿
 * `Object.keys(emptyFilter())` 跟它逐一对账。
 */
export const FILTER_KEYS = [
  'status', 'listIds', 'tags', 'priority', 'contexts', 'dueWithinDays', 'hasWaitingFor', 'text',
  'tagsAll', 'noList', 'noTag', 'noDue', 'isRepeating', 'notStarted', 'estimateWithinMinutes',
  'or', 'not',
] as const;

/**
 * `List.filter` 里嵌套的 `SmartFilter`。**这是最容易被漏掉的一层**——外层
 * 白名单只挡住了「filter 键本身合不合法」，挡不住 filter 内部塞进任意结构。
 * 跟外层同一个脾气：未知键、字段形状不对，整个 filter 拒收，不是挑能认的
 * 字段留下、脏的丢掉。
 *
 * `{ ok: true, value: null }` 合法，表示「这不是智能清单」——跟 `checkRepeat`
 * 的形状陷阱同一个道理（`repeat: null` 是合法值，不能跟校验失败共用一个
 * 返回值），`null` 不再靠裸 `null`/`undefined` 分流。
 */
function checkSmartFilter(v: unknown): SanitizeResult<SmartFilter | null> {
  if (v === null) return { ok: true, value: null };
  return checkGroup(v, true);
}

/**
 * 一组条件。`allowOr` 为假时这一组里不许再有非空的 `or`——**「或」组只嵌套
 * 一层**（见 `model.ts` 里 `SmartFilter` 的注释）：不拦的话一份存下来的查询
 * 能长成一棵任意深的树，筛选栏画不出来、人也读不懂，而它是会被写进
 * `data/lists/` 长期留着的。
 */
function checkGroup(v: unknown, allowOr: boolean): SanitizeResult<SmartFilter> {
  const fail = bad('filter', 'status/listIds/tags/priority/dueWithinDays/hasWaitingFor/text 七个键要给全，' +
    'tagsAll / noList / noTag / noDue（布尔）和 or（「或」组数组，只能嵌一层）可以不给，' +
    '不能有别的键（status 是合法状态数组，priority 只收 0-3，dueWithinDays 是数字或 null，hasWaitingFor 是布尔值，text 是字符串）');
  if (typeof v !== 'object' || v === null) return fail;
  const f = v as Record<string, unknown>;
  if (Object.keys(f).some((k) => !(FILTER_KEYS as readonly string[]).includes(k))) return fail;
  if (!Array.isArray(f.status) || f.status.some((s) => !STATUSES.includes(s as Status))) return fail;
  if (!Array.isArray(f.listIds) || f.listIds.some((x) => typeof x !== 'string')) return fail;
  if (!Array.isArray(f.tags) || f.tags.some((x) => typeof x !== 'string')) return fail;
  if (!Array.isArray(f.priority) || f.priority.some((x) => ![0, 1, 2, 3].includes(x as number))) return fail;
  if (!(f.dueWithinDays === null || (typeof f.dueWithinDays === 'number' && Number.isFinite(f.dueWithinDays)))) return fail;
  if (typeof f.hasWaitingFor !== 'boolean') return fail;
  if (typeof f.text !== 'string') return fail;
  // 这几个是后加的，缺了落默认值（不是校验失败）——加它们之前存下来的智能
  // 清单里没有这些键，拒收会让一批本来好好的清单突然打不开。跟
  // `checkRepeat` 对 interval/weekdays/until 的处理同一条。
  const tagsAll = 'tagsAll' in f ? f.tagsAll : false;
  if (typeof tagsAll !== 'boolean') return fail;
  const noList = 'noList' in f ? f.noList : false;
  if (typeof noList !== 'boolean') return fail;
  const noTag = 'noTag' in f ? f.noTag : false;
  if (typeof noTag !== 'boolean') return fail;
  const noDue = 'noDue' in f ? f.noDue : false;
  if (typeof noDue !== 'boolean') return fail;
  // 情境这一维也是后加的：跟上面那几个布尔量同一条，缺了落空数组（这一维不筛），
  // 不是校验失败——加它之前存下来的智能清单里没有这个键。
  const contexts = 'contexts' in f ? f.contexts : [];
  if (!Array.isArray(contexts) || contexts.some((x) => !CONTEXTS.includes(x as TaskContext))) return fail;
  // 这三维跟上面那几个布尔量同一条：后加的，缺了落默认值（不筛），不是校验失败。
  const isRepeating = 'isRepeating' in f ? f.isRepeating : false;
  if (typeof isRepeating !== 'boolean') return fail;
  const notStarted = 'notStarted' in f ? f.notStarted : false;
  if (typeof notStarted !== 'boolean') return fail;
  const est = 'estimateWithinMinutes' in f ? f.estimateWithinMinutes : null;
  // 正数或 null。0 和负数不收——「预计不超过 0 分钟」筛出来恒为空，那不是
  // 一个人会想表达的意思，多半是控件清空时漏了归 null。
  if (!(est === null || (typeof est === 'number' && Number.isFinite(est) && est > 0))) return fail;

  /** `or` / `not` 形状完全一样：一层，里面那几组自己不能再嵌。 */
  const nested = (key: 'or' | 'not'): SanitizeResult<SmartFilter[]> => {
    const raw = key in f ? f[key] : [];
    if (!Array.isArray(raw)) return fail;
    if (!allowOr && raw.length > 0) {
      return bad('filter', `「${key === 'or' ? '或' : '排除'}」组只能嵌一层——${key} 里那几组自己不能再有 or/not`);
    }
    const out: SmartFilter[] = [];
    for (const g of raw) {
      const r = checkGroup(g, false);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  };
  const rOr = nested('or');
  if (!rOr.ok) return rOr;
  const or = rOr.value;
  const rNot = nested('not');
  if (!rNot.ok) return rNot;
  const not = rNot.value;
  return {
    ok: true,
    value: {
      status: f.status as Status[],
      listIds: f.listIds as string[],
      tags: f.tags as string[],
      priority: f.priority as number[],
      contexts: contexts as TaskContext[],
      dueWithinDays: f.dueWithinDays as number | null,
      hasWaitingFor: f.hasWaitingFor,
      text: f.text,
      tagsAll,
      noList,
      noTag,
      noDue,
      isRepeating,
      notStarted,
      estimateWithinMinutes: est,
      or,
      not,
    },
  };
}

/** 客户端能改的清单字段，白名单。`id` 不在里面，传了也不采纳。 */
export type ListPatch = Partial<Pick<List, 'name' | 'color' | 'folderId' | 'order' | 'archived' | 'filter'>>;

const LIST_KEYS = ['name', 'color', 'folderId', 'order', 'archived', 'filter'] as const;

/**
 * 清单的白名单校验，跟 `sanitizeProposalPatch` 同一个套路：**未知键整条
 * 拒收**，不是悄悄过滤掉。
 *
 * 这是补的一道信任边界——没有它，`PATCH /api/lists/:id` 只能是
 * `{ ...hit, ...body }` 式的裸展开：调用方能塞任意键（`archived`、`order`
 * 不做形状校验，甚至塞出 `List` 类型里根本没有的字段）直接落盘。任务那边走
 * `checkTaskPatch`，清单这边不该更松。
 *
 * `POST /api/lists`（建清单）和 `PATCH /api/lists/:id`（改清单）共用这一份：
 * 建清单时 `order`/`archived` 是否合法形状同样要挡，只是路由那边会忽略
 * 客户端传来的值、改用服务端算出来的默认值（新清单一律未归档、排在最后）。
 *
 * `ok:false` 带上是哪个字段、为什么——跟 `checkTaskPatch` 同一个理由：`null`
 * 只够说「不合法」，调用方（尤其是 AI）得知道该改哪个字段。
 */
export function checkListPatch(body: unknown): SanitizeResult<ListPatch> {
  if (typeof body !== 'object' || body === null) return bad('body', '要是一个对象（整个请求体）');
  const b = body as Record<string, unknown>;
  // `!== undefined`，不是判真值——`.find()` 找不到才是真的「没有坏键」，
  // 键名 `""` 是合法但不在白名单里的键，truthy 判断会把它当成「没找到」放过去。
  const badKey = Object.keys(b).find((k) => !(LIST_KEYS as readonly string[]).includes(k));
  if (badKey !== undefined) return bad(badKey, `不是清单允许改的字段——白名单只有 ${LIST_KEYS.join(' / ')}，你传的是 "${badKey}"`);

  const out: ListPatch = {};
  if ('name' in b) {
    if (typeof b.name !== 'string' || !b.name.trim()) return bad('name', '要是非空字符串（去掉首尾空白之后不能是空的）');
    out.name = b.name.trim();
  }
  if ('color' in b) {
    if (typeof b.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.color)) return bad('color', '要是 #RRGGBB 形式的十六进制颜色');
    if (b.color.toUpperCase() === INK_AI) return bad('color', `不能用群青 ${INK_AI}——群青留给 AI 记号，清单挑别的颜色`);
    out.color = b.color;
  }
  if ('folderId' in b) {
    if (b.folderId !== null && typeof b.folderId !== 'string') return bad('folderId', '要是某个文件夹的 id（字符串）或 null');
    out.folderId = b.folderId as string | null;
  }
  if ('order' in b) {
    if (typeof b.order !== 'number' || !Number.isFinite(b.order)) return bad('order', '要是有限数字');
    out.order = b.order;
  }
  if ('archived' in b) {
    if (typeof b.archived !== 'boolean') return bad('archived', '要是布尔值');
    out.archived = b.archived;
  }
  if ('filter' in b) {
    const f = checkSmartFilter(b.filter);
    if (!f.ok) return f;
    out.filter = f.value;
  }
  return { ok: true, value: out };
}

/** 只要「合法与否」的调用方继续用这个。带原因的走 `checkListPatch`。 */
export function sanitizeListPatch(body: unknown): ListPatch | null {
  const r = checkListPatch(body);
  return r.ok ? r.value : null;
}

/** 客户端能改的文件夹字段，白名单。字段比清单少很多——文件夹没有颜色、没有筛选条件。 */
export type FolderPatch = Partial<Pick<Folder, 'name' | 'order'>>;

const FOLDER_KEYS = ['name', 'order'] as const;

/** 文件夹的白名单校验，同一个套路。 */
export function checkFolderPatch(body: unknown): SanitizeResult<FolderPatch> {
  if (typeof body !== 'object' || body === null) return bad('body', '要是一个对象（整个请求体）');
  const b = body as Record<string, unknown>;
  // 同上——`!== undefined`，不是判真值。
  const badKey = Object.keys(b).find((k) => !(FOLDER_KEYS as readonly string[]).includes(k));
  if (badKey !== undefined) return bad(badKey, `不是文件夹允许改的字段——白名单只有 ${FOLDER_KEYS.join(' / ')}，你传的是 "${badKey}"`);

  const out: FolderPatch = {};
  if ('name' in b) {
    if (typeof b.name !== 'string' || !b.name.trim()) return bad('name', '要是非空字符串（去掉首尾空白之后不能是空的）');
    out.name = b.name.trim();
  }
  if ('order' in b) {
    if (typeof b.order !== 'number' || !Number.isFinite(b.order)) return bad('order', '要是有限数字');
    out.order = b.order;
  }
  return { ok: true, value: out };
}

/** 只要「合法与否」的调用方继续用这个。带原因的走 `checkFolderPatch`。 */
export function sanitizeFolderPatch(body: unknown): FolderPatch | null {
  const r = checkFolderPatch(body);
  return r.ok ? r.value : null;
}
