/**
 * 手机把离线期间的改动推回桌面：**判定这一半**，平台无关。
 *
 * 跟 `mutate.ts` 同一个位置、同一条理由（见那个文件顶部）：`server/tsconfig.json`
 * 设了 `rootDir: "src"`，server 引不了 web 的文件，反过来 web 引 server 的没问题。
 * 放这儿是唯一不用改任一侧 tsconfig 就能让两边共用同一份的位置——`web/src/lib/pushBack.ts`
 * 用相对路径 `../../../server/src/push.js` 引这里。
 *
 * **这个文件零 import。** 判定只认 `unknown`——不认识 `Task`/`InboxItem`，也就不用
 * 在 `web/src/types.ts` 抄第二份、不用进 `types.sync.test.ts` 那份名单。
 *
 * `stableKey` 是从 `entityStore.ts` 搬过来的（那边改成引这里）：它现在有三个用户
 * ——`syncAll` 判「这个文件要不要重写」、服务端判三方比较、手机清记号之前判「这条
 * 从发出去到现在有没有再被改过」。三份手写的 JSON 比较正是 140 那条「让第二份不存在」
 * 要防的形状。
 */

export interface PushEntry {
  id: string;
  /** 'upsert' = 手机上还有这一条（改过或新建）；'delete' = 手机上已经没有了。 */
  op: 'upsert' | 'delete';
  /** 本地第一次改它之前、服务端那份长什么样。null = 没有基准（新建的，或旧格式迁移来的）。 */
  base: unknown;
  /** op==='upsert' 时手机上现在那份；op==='delete' 时是 null。 */
  value: unknown;
}

export interface PushBody { tasks: PushEntry[]; inbox: PushEntry[] }

/** 推送体里的两类实体。**跟 `PushBody`/`PushResponse` 的键名同名**，别另起名字。 */
export type PushKind = 'tasks' | 'inbox';

/** 一类实体的处理结果。**三个桶手机都清记号**，没出现在任何桶里的保留记号。 */
export interface PushKindResult { pushed: string[]; cleared: string[]; conflicted: string[] }

export interface PushResponse { tasks: PushKindResult; inbox: PushKindResult }

export type PushVerdict = 'push' | 'clear' | 'conflict';

/**
 * 比对用的序列化：**键按名字排序之后再序列化**。直接 `JSON.stringify` 的话，两个
 * 内容一样但键顺序不同的对象会被判成「变了」——服务端那边会白写一次盘、白触发一次
 * 目录监听器；这边更糟，会把一次「其实没冲突」判成冲突、白写一份副本。
 *
 * 三件「相等」的边界，都是刻意的，因为反过来都会判错（判成相等 = 用户的改动被静默
 * 吞掉；判成不等 = 目录里堆没意义的副本）：
 *
 * 1. **数组顺序有关**（`Array.isArray` 那一支原样返回，只有对象的键被重排）。这个
 *    仓库里的数组顺序全是有意义的——`inbox.taskIds`、`order` 排出来的列表——把
 *    `[a,b]` 和 `[b,a]` 判成同一份内容就是把一次真实的重排静默丢掉。数组里**装着的
 *    对象**照样会被替换器走一遍、键照样排序。
 * 2. **`undefined` 和「没有这个键」判成一样**（`JSON.stringify` 自己的规矩，这里不去
 *    纠正它）。对 `decidePush` 来说这条不可能踩上：两边比的东西都是刚 `JSON.parse`
 *    出来的（服务端那份从磁盘，手机那份从请求体），JSON 里根本不存在 `undefined`。
 *    对第三个用户 `syncAll` 就不一样了——它的 `next` 是内存里拼出来的对象，**带得了
 *    显式 `undefined`**。现在所有构造任务对象的地方都是展开运算符（JS 不会重排已有
 *    的键、也不会凭空造出 `undefined` 值的键），碰不上这件事；但那是一份没人看得见的
 *    隐性契约，换个写法就会踩上，而踩上了也不会报错、只是悄悄多写一次盘。
 * 3. **顶层传 `undefined` 时返回的不是字符串**（`JSON.stringify(undefined)` 就是
 *    `undefined`）。签名上写 `string` 是个善意的谎；`decidePush` 走不到那里——「服务端
 *    没有这个 id」是先用 `exists` 挡掉的（`undefined` 和 `null` 都算没有），不是靠比字符串。
 */
export const stableKey = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val as object).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val);

const same = (a: unknown, b: unknown): boolean => stableKey(a) === stableKey(b);

/**
 * 三方比较。**`server` 传 `undefined` 或 `null` 都表示服务端没有这个 id。**
 *
 * 两个都收，是因为这一层的两种取法各说各话：`Map.get()`（Task 6 路由那边先
 * `readAll` 建索引再查）给的是 `undefined`，而 `entityStore.ts` 的
 * `readOne(): T | null` 给的是 `null`。只认 `undefined` 的话，哪天有人接成
 * `readOne`，**每一条离线新建都会从 `push` 翻成 `conflict`**——实体永远建不出来，
 * 目录里堆满副本，而且全程没有任何报错。这不是防御性编程，是这个仓库里「不存在」
 * 确实有两种写法。
 *

 * **判断顺序有讲究**：「服务端 == 我改的那份」必须排在「服务端 == 基准」前面。
 * 上一次推成功、回执半路丢了的情况下，服务端已经是我那份了——先判基准的话会得到
 * 「服务端 != 基准」→ 冲突，于是每次重连都再写一份副本。这正是正本写死的那条
 * 「推成功之后必须清记号」在服务端这一侧的对应物。
 */
export function decidePush(entry: PushEntry, server: unknown): PushVerdict {
  const exists = server !== undefined && server !== null;
  if (entry.op === 'delete') {
    // 服务端也已经没有了：这次删除早就生效了（或者这条根本没到过服务端）。
    if (!exists) return 'clear';
    // 没有基准就判不出服务端动没动过。**不删**——「把桌面刚编辑过的东西按手机上的
    // 旧决定删掉」是这套设计最该防的静默丢数据。也不写副本：那份副本的内容只会是
    // 一条跟服务端现有版本一模一样的 JSON，对人零信息量。
    if (entry.base === null) return 'clear';
    return same(server, entry.base) ? 'push' : 'conflict';
  }
  if (!exists) {
    // 没有基准 = 手机上新建的，服务端本来就不该有 → 创建。
    // 有基准 = 服务端曾经有、现在没了（桌面把它删进垃圾箱了）→ **不复活**，
    // 手机那份写成副本让人看见。
    return entry.base === null ? 'push' : 'conflict';
  }
  if (same(server, entry.value)) return 'clear';
  // 这里不用再判 `entry.base !== null`：走到这一行 `server` 已经既不是 `undefined`
  // 也不是 `null`（上面的 `exists`），而 `same(非空, null)` 恒为 false。那个条件原本
  // 唯一挡的就是 `server === null`，现在 `exists` 在更上游、更直接地挡掉了。
  if (same(server, entry.base)) return 'push';
  return 'conflict';
}

const entityLike = (v: unknown, id: string): boolean =>
  !!v && typeof v === 'object' && (v as { id?: unknown }).id === id;

const isStr = (v: unknown): boolean => typeof v === 'string';

/**
 * 「这份 `value` 起码像不像这一类实体」。**只挡「明显不是这个实体」，不做严格 schema。**
 *
 * 为什么非有不可：`POST /api/push` 是这个服务上**唯一一条接收另一台设备数据**的路由，
 * 而其余每一条写路由都过 `checkTaskPatch` / `checkListPatch` / `sanitizeProposalPatch`
 * 那种字段白名单。这一条写的是**整条实体**，那几个白名单一个都用不上（它们校验的是
 * 「这次要改哪几个字段」，不是「这是不是一条完整合法实体」，仓库里没有第二份能复用的）。
 * 零校验的话，一个 `{ id: 'a', 随便: [1, 2, 3] }` 会被原样落盘成 `data/tasks/<id>.json`，
 * `readAll` 照样读得回来——看板上多一张什么字段都没有的卡。
 *
 * **判太严和判太松的后果不对称**，所以只认「这几个必填字段在不在、类型对不对」：
 * - 判太松：一条畸形数据落盘，人在看板上看得见、删得掉。
 * - 判太紧：稍旧或稍新版本的手机推上来的**合法**实体被整批 400，用户离线期间的改动
 *   **推不回去**，而他只看得到一句「形状不对」。后者更糟。
 *
 * 于是这里**不认**：字段的值（`status` 是不是那四个之一——看板对认不出的 status 是挂
 * 一个红标签，不是拒收，这一层没理由比它严）、多出来的字段、名单之外的字段缺不缺。
 *
 * 字段名照 `server/src/model.ts` 的 `Task` / `InboxItem`。这个文件**零 import**，认不了
 * 那两个类型，所以这份名单是手抄的——改那两个 interface 的必填字段时要回来看一眼；
 * `push.test.ts` 里有一条拿 `newTask()` 的真实产物过这道关的测试盯着 `Task` 那一半。
 */
const looksLikeEntity: Record<PushKind, (o: Record<string, unknown>) => boolean> = {
  tasks: (o) => isStr(o.title) && isStr(o.status) && isStr(o.createdAt) && isStr(o.updatedAt),
  inbox: (o) => isStr(o.text) && isStr(o.createdAt) && typeof o.processed === 'boolean'
    && Array.isArray(o.taskIds) && o.taskIds.every(isStr),
};

/**
 * 请求体里一类实体的条目数组：形状不对返回 `null`，由路由整批 400。
 *
 * **不做「跳过这一条、其余照常」**：条目是手机自己按脏集生成的，形状不对说明的是
 * 本地存储坏了或者版本对不上，不是某一条数据有问题。跳过等于把一次真实的失败
 * 静默成一次部分成功——而手机会把「没出现在回执里」的那条记号留着，下次再推，
 * 无限循环且没有任何信号（139 那一类）。
 *
 * **这里挡的只是「形状」，不挡「id 安不安全」。** `id: '../../逃出去'`、`id: 'a\\b'`
 * 这种照样过得来——挡它们的是 `entityStore.ts` 的 `isSafeId`/`assertSafeId`（那一层
 * 才是真正拿 id 去拼文件名的地方，`writeOne`/`readOne`/`deleteOne` 三处都躲不掉）。
 * **调用方必须自己走那一层，别以为过了这个函数 id 就是干净的。**
 *
 * 为什么不在这儿挡：这个文件**零 import** 是它存在的全部理由（web 侧也 import 它）。
 * 引 `entityStore.js` 既是反向依赖、又会引进 `node:fs` 把上面那条平台无关守卫直接
 * 打红；在这儿另抄一份判据就是 140 那个形状——「什么样的 id 算安全」只能有一份定义，
 * `entityStore.ts` 顶上那段注释已经把这条写死了。
 *
 * 唯一一处**宽容**是 `e.base ?? null`：缺 `base` 键当成「没有基准」，不拒。理由是
 * `JSON.stringify` 会把值为 `undefined` 的键整个丢掉，所以「没有基准」这个合法状态
 * 在网线上有可能就是长成「没有这个键」；拒掉它等于拒掉一条正常的离线新建。而且这个
 * 宽容的方向是安全的——没有基准的条目一律不删、撞车就写副本，服务端那份动不了。
 *
 * `kind` 决定拿哪一套必填字段去量 `value`（见 `looksLikeEntity`）。**必填，没有默认值**：
 * 落成 `kind = 'tasks'` 的话，漏传的那个调用点会拿**错的尺子**去量（收件箱条目一条都过
 * 不了、整批 400），响得很，但那不是这里防的；真正要防的是 `kind?:` + 「没传就跳过这道
 * 校验」那个形状——漏传等于静默退回零校验那一版，畸形数据照样落盘而且没人会发现，
 * 正是 139 那条「用默认值把失败路径填成成功路径」。两种都不要，所以干脆必填。
 * **只量 `value`，不量 `base`**——`value` 是会被原样写进
 * `data/<类>/<id>.json` 的那份，`base` 只参与比对和冲突副本的内容（副本文件名带
 * 「冲突副本」，`readAll` 跳过它），拿同一把尺子去卡它只会多拒掉一批合法的老基准。
 */
export function checkPushEntries(v: unknown, kind: PushKind): PushEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: PushEntry[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== 'string' || e.id === '') return null;
    if (e.op !== 'upsert' && e.op !== 'delete') return null;
    const base = e.base ?? null;
    if (base !== null && !entityLike(base, e.id)) return null;
    // id 对不上就拒：不然会拿 A 的内容写到 B 的文件名上，或者写出一份 id 跟文件名
    // 对不上的冲突副本。
    if (e.op === 'upsert' && !entityLike(e.value, e.id)) return null;
    // 会被原样落盘的那份，量一遍最小形状——理由见 looksLikeEntity。
    if (e.op === 'upsert' && !looksLikeEntity[kind](e.value as Record<string, unknown>)) return null;
    out.push({ id: e.id, op: e.op, base, value: e.op === 'upsert' ? e.value : null });
  }
  return out;
}
