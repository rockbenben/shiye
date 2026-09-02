import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableKey } from './push.js';

/**
 * 「一目录 = 一张表，一文件 = 一条记录」。
 *
 * 换掉「整份数组读写」是为了 WebDAV 同步：两台设备各改一条任务，在大数组的
 * 形态下会让整个文件冲突，用户得手动合并 JSON；一实体一文件的话两边改不同
 * 记录是零冲突，改同一条也只影响那一条。
 *
 * 这一层**不认识 Task / List 这些具体类型**，只要求实体有个 `id`。类型知识
 * 留在 store.ts，这里只管文件。
 */

/**
 * 同步客户端在冲突时生成的副本文件名。各家形状不一样，分两类：
 * - 括号形状：坚果云是「(冲突副本 日期)」，Dropbox 英文版是「(conflicted copy …)」，
 *   Nextcloud 是「(<设备名> 的冲突副本 …)」——括号里带关键词，插在扩展名前。
 * - Syncthing 不是这个形状：`<id>.sync-conflict-20260813-142530-K3HJ2QL.json`，
 *   不带括号、不含「冲突副本」/「conflicted copy」，是在扩展名前插一段
 *   `.sync-conflict-<日期>-<时间>-<设备短 ID>`。Syncthing 是个人多设备同步很
 *   常见的选择，漏了这条形状会让它的冲突副本被 isEntityFile 当成正常实体
 *   读进 readAll。
 * 两条形状选一条命中即可，这条宽判据。
 *
 * **它们绝不能混进 readAll。** 一份冲突副本和本体的 `id` 字段是一样的，混进去
 * 就是同一个 id 出现两次——上层按 id 建索引，后来的会静默盖掉先来的，等于
 * 用一份可能更旧的内容替换掉当前内容。要让人看见它们，用 listConflicts()。
 */
export const CONFLICT_RE =
  /(?:\((?:[^)]*(?:冲突副本|conflicted copy)[^)]*)\)|\.sync-conflict-\d{8}-\d{6}-[A-Za-z0-9]+)\.json$/i;

const isEntityFile = (f: string): boolean => f.endsWith('.json') && !CONFLICT_RE.test(f);

/**
 * 一个 id 能不能安全地拼进文件名。非空、不含路径分隔符、不含 `..`。
 *
 * 缺这道关会把这一整层「一实体一文件」的地基烧穿：`writeOne` 直接
 * `join(dir, id + '.json')`，AI 在 outbox 里写的任务 id 是外部输入、没有
 * 经过这一层校验——写一个 `"../../逃出去的任务"` 就能把文件写到 `data/`
 * 目录之外，而且是静默的：横幅照样说「新增 1 个任务」，`tasks.json` 却是
 * 空的，收件箱那条被标成 `processed: true`、`taskIds` 指向一个哪儿都读不到
 * 的任务——这个仓库反复在防的静默失败，三样在这一个漏洞里同时踩中。
 *
 * `migrate.ts` 的 `safeId` 复用同一份判据，但处理方式不同（那边选择「不干净
 * 就现造一个新的」，这边选择拒绝）——见 migrate.ts 里的说明。「什么样的 id
 * 算安全」只能有一份定义，不能两边各写一次、迟早飘。
 *
 * **最后一条不是路径安全，是「别把自己写成看不见的东西」**：`writeOne` 拼出来的
 * 名字是 `<id>.json`，而 `isEntityFile` 会用 `CONFLICT_RE` 把冲突副本挡在 `readAll`
 * 外面。id 里要是带上「(冲突副本 …)」「(conflicted copy …)」，或者一段
 * `.sync-conflict-20260813-142530-K3HJ2QL`，写出来的正本文件名就正好命中那条正则
 * ——`writeOne` 成功、`readOne` 读得到、`listConflicts` 列得出来，唯独 `readAll`
 * 永远跳过它：**写成功了但列表里没有**，而且全程零报错。实测过。
 *
 * 守卫放在这一个地方（跟上面那三条同一个理由，见下面 `assertSafeId` 的注释），
 * 不是加在某一条路由里：`POST /api/push` 只是**第一条**让另一台设备的任意 id 走到
 * `writeOne` 的路，不是唯一一条——outbox 里 AI 供的 id 同样是外部输入，那条路今天
 * 就存在。域内的 id 是 uuid，撞不上这条正则。
 */
/**
 * Windows 上会把文件名悄悄改写掉的那几类。**跟 `attachments.ts` 的
 * `WINDOWS_ILLEGAL_CHARS_RE` 是同一份判据、同一个理由**——那边为附件名解决过
 * 一模一样的问题，实体 id 这条路一直没享受到。
 *
 * 实测（就在这个仓库的 Windows 机器上）：
 * - `abc:evil.json` **写入成功**，但 `readdirSync` 只看得到一个叫 `abc` 的零字节
 *   文件——内容进了 NTFS 交替数据流。于是 `writeOne` 成功、`readOne` 按全路径也
 *   读得回来，唯独 `readAll`（readdir + 认 `.json` 后缀）**永远看不见它**。
 *   这正是上面那段注释描述的失败形状：写成功了但列表里没有，全程零报错。
 * - `NUL.json` / `CON.json` / `COM1.json` / `aux.json` 同样写入成功——保留设备名
 *   在不同 Windows 版本、不同同步盘上的行为不一致，`NUL` 更是直接进空设备。
 *
 * 尾随的 `.` 和空格 Windows 会自动丢掉，同一类漂移，一并挡掉。
 *
 * **域内的 id 是 uuid，一条都撞不上**；挡的是外部输入：outbox 里 AI 供的 id、
 * `POST /api/push` 从另一台设备推上来的 id。
 */
const WINDOWS_UNSAFE_RE = /[<>:"|?*]/;
/** 控制字符单独判：写成正则里的转义会被工具改写成真的字节（这个文件已经踩过一次，
 *  `sourceBytes.guard.test.ts` 当场报「有控制字符」）。 */
const hasControlChar = (s: string): boolean => [...s].some((c) => c.codePointAt(0)! < 32);
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const TRAILING_DOT_SPACE_RE = /[. ]$/;

export const isSafeId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && !id.includes('..') && !/[\\/]/.test(id)
  && !WINDOWS_UNSAFE_RE.test(id) && !hasControlChar(id)
  && !WINDOWS_RESERVED_RE.test(id) && !TRAILING_DOT_SPACE_RE.test(id)
  && !CONFLICT_RE.test(`${id}.json`);

/**
 * **两个只差大小写的 id，在 Windows 上是同一个文件。** `isSafeId` 只看单个 id
 * 的形状，看不见「盘上已经有一个只差大小写的」；而 NTFS（macOS 默认也是）
 * 不区分大小写：盘上有 `foo.json` 时写 `Foo.json`，写的就是那个文件——`foo`
 * 那条任务的内容被静默换掉，`readAll` 之后只剩一个幸存者，没有坏文件横幅、
 * 没有冲突副本。`POST /api/push` 是唯一接收外来 id 的路由，它的查重
 * （`byId.has`）和 outbox 的 `existingIds.has` 都是区分大小写的 Set，两道都
 * 拦不住。
 *
 * 所有平台一律拒（不只 Windows）：数据要在 Windows 桌面和手机之间来回，
 * 在 Linux 上能共存的两个 id 到了桌面就是一个文件；而应用自己生成的 id 全是
 * 小写 uuid，「两个 id 只差大小写」在正常流程里从不发生。**写任何一个之前
 * 先整批查**，别写到一半才炸——那样前面几条已经落盘、后面的没有。
 */
function assertNoCaseCollision(existing: string[], incoming: string[]): void {
  const seen = new Map<string, string>();
  for (const id of [...existing, ...incoming]) {
    const key = id.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== id) {
      throw new Error(`id「${id}」跟已有的「${other}」只差大小写——在 Windows 上是同一个文件，拒绝写入`);
    }
    seen.set(key, id);
  }
}

/**
 * `writeOne`/`readOne`/`deleteOne` 三处都拿 id 拼文件名，守卫放在这一个
 * 地方，覆盖全部调用方——不止 outbox 合并这一条路径，任何现在或者以后往
 * 这一层传不受信 id 的调用点都躲不掉。选择**拒绝（抛错）**，不是「不安全
 * 就悄悄换一个新 id 再写」：那样看似安全，实际会让内存里那份实体（比如
 * outbox.ts 里已经构造好、马上要塞进 `inbox.taskIds` 的 Task 对象）跟磁盘
 * 上真正落地的文件用的是两个不同的 id——同一类「id 对不上、taskIds 指向
 * 空气」的问题会从「文件逃出 data/」换个花样重新出现。抛出去之后，
 * `outbox.ts` 的 `mergeOneFile` 会把它当成落盘失败处理：横幅老实报「校验
 * 通过但落盘时出了问题」，不会声称新增成功，也不会把来源那条收件箱记录
 * 标成 processed——比悄悄写歪一个文件名安全得多。
 */
function assertSafeId(id: unknown): asserts id is string {
  if (!isSafeId(id)) {
    throw new Error(`不安全的 id，拒绝拼文件名（可能是路径穿越）：${JSON.stringify(id)}`);
  }
}

/** 内存索引。**这是缓存不是真相**——真相永远是磁盘上的文件。 */
const cache = new Map<string, unknown[]>();

/**
 * 上一次真的扫过某个目录时，哪几个文件读不出来。**目录 → 文件名**。
 *
 * 只在 `readAll` 真的读盘那一趟里更新（命中缓存那条路径不动它）——它记的是
 * 「上一次看到的样子」，跟缓存本身同一个新鲜度，不会出现「缓存说有 10 条、
 * 坏文件列表却是另一个时刻的」这种对不上的状态。
 */
const broken = new Map<string, string[]>();

/** 现在还坏着的那几个文件。给 `GET /api/broken` 用。 */
export function listBroken(): Array<{ dir: string; file: string }> {
  return [...broken].flatMap(([dir, files]) => files.map((file) => ({ dir, file })));
}

/**
 * 监听器一旦挂了（`events.ts` 的 `watcher.on('error')`），就再也没有人会调用
 * `invalidate`——缓存会一直吐旧数据，F5 都救不回来，只能重启服务。这个开关
 * 打开之后 `readAll` 不再读写缓存，退化成每次都读盘：换掉缓存带来的性能收益，
 * 换回数据永远新鲜，是监听器已经死掉之后唯一还站得住的选择。只有 `events.ts`
 * 的监听器错误处理器会调用它；没有对应的「关掉」——监听器不会自己恢复，
 * 这个开关也就不需要能关回去。
 */
let bypassCache = false;

export function invalidateAll(): void {
  cache.clear();
  conflictCache.clear();
  bypassCache = true;
}

export function invalidate(dir: string): void {
  cache.delete(dir);
  conflictCache.delete(dir);
}

export function readAll<T extends { id: string }>(dir: string): T[] {
  if (!bypassCache) {
    const hit = cache.get(dir);
    // .slice()：调用方全是 map/filter/展开，今天谁都不会改这个返回值，但
    // 按引用交出去意味着将来随便一句 `all.push(...)` 就会在不碰磁盘的情况下
    // 污染这个内存索引，而且不会有任何报错——返回一份浅拷贝，让缓存本身
    // 保持不可变。
    if (hit) return (hit as T[]).slice();
  }
  // 先把上一次记下的坏文件清掉——修好一个之后不清的话，它会永远挂在横幅上，
  // 而横幅说的是「现在还坏着」。**放在 existsSync 前面**：整个目录没了的时候
  // 那条早退会跳过这一句，于是那个目录的记录再也没人清得掉，横幅上会永远
  // 挂着一个连所在目录都不存在了的文件。
  broken.delete(dir);
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const f of readdirSync(dir).filter(isEntityFile).sort()) {
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
      // **文件名和里面的 id 必须一致，对不上就当坏文件跳过。**
      //
      // 实测复现过一次真实的数据销毁：同步盘留下一个 `<id> (1).json`（`CONFLICT_RE`
      // 只认「冲突副本」/「conflicted copy」/`.sync-conflict-` 那三种命名，认不出
      // 这一种），它按文件名排序**排在原件之前**。于是
      //
      // - `GET /api/tasks` 把同一条任务读成两条（界面上一条任务出现两次）；
      // - `PATCH` 用 `.find` 取第一条，改的是**副本**；
      // - `syncAll` 用 `new Map(...)` 建索引，同 id 后者覆盖前者，于是它认为
      //   「原件那一份没变」，不重写它——但要写的那份内容是副本的。
      //
      // 净结果：只改了一个优先级，原件的标题被副本的过时内容整个覆盖，原内容没了。
      //
      // 归进已有的「坏文件」机制（横幅会列出来），不是静默丢弃：这条记录在磁盘上
      // 是真实存在的，人得知道有这么个文件、该去删还是去改。也不是「相信里面的
      // id」——那样 `writeOne` 之后磁盘上会同时躺着两个文件名不同、id 相同的记录，
      // 下一次读还是这个局面。
      if (`${e.id}.json` !== f) {
        console.warn(`[存储] 文件名跟里面的 id 对不上，跳过：${join(dir, f)}（id 是 ${String(e.id)}）`);
        const dup = broken.get(dir);
        if (dup) dup.push(f);
        else broken.set(dir, [f]);
        continue;
      }
      out.push(e);
    } catch {
      // 一条读坏了不该让整张表读不出来——同步中断、手改坏文件都会造成这个。
      // 这里跳过，**同时记下来**：这个函数原来只 console.warn 一句就完事，
      // 而注释里写着「界面上由上层负责把坏文件列出来」——那件事一直没人做，
      // 于是一条同步坏掉的任务就这么从界面上无声消失，谁都不知道。
      // 记在这儿而不是另开一个扫描函数：这里本来就把每个文件读了一遍，
      // 另写一个「找出所有坏文件」的接口等于把整个 data/ 再读一遍。
      // **跟 store.ts 的 readJson 刻意不同**：那边是「整份数据只有一个文件，
      // 读不出来宁可起不来」，这边是「一千条里坏一条，不该让另外 999 条也
      // 打不开」。
      console.warn(`[存储] 跳过读不出来的文件：${join(dir, f)}`);
      const list = broken.get(dir);
      if (list) list.push(f);
      else broken.set(dir, [f]);
    }
  }
  if (!bypassCache) cache.set(dir, out);
  // .slice()：`out` 是刚存进缓存的那个数组本身，原样交出去的话，调用方拿到
  // 的和缓存里的是同一个对象引用——跟上面「命中缓存」分支犯的是同一种错，
  // 这条路径（第一次读、顺带把 out 存进缓存）同样要给一份浅拷贝。
  return out.slice();
}

/**
 * 冲突副本清单缓存：另开一张表，不跟 `cache` 共用——那张表存的是实体数组
 * （`readAll` 的结果），这张存的是文件名列表（`listConflicts` 的结果），
 * 两者用的是同一个 `dir` 当 key，共用一张表会互相覆盖。`invalidate`/
 * `invalidateAll`/`bypassCache` 是同一套入口，两张表一起失效、一起旁路。
 *
 * 额外挂了个短 TTL：`invalidate` 目前的调用方是我们自己的写（writeOne/
 * deleteOne/syncAll）和 events.ts 的目录监听器。但冲突副本文件是同步客户端
 * （WebDAV/Dropbox/坚果云）放进来的外部写入，只有监听器这一条路能让我们
 * 知道它出现了——而 events.ts 自己的注释写着「WebDAV/网络挂载盘上 fs.watch
 * 报错、漏事件很常见，正是这次改造要扛住的场景」。纯靠 invalidate 的话，
 * 监听器一旦漏掉那一次事件，这份缓存会一直吐旧列表，跟这个仓库上一批
 * （.ics 导出只靠文件监听器刷新）踩过的是同一个坑。TTL 把「最坏多陈旧」
 * 变成一个固定上界，不依赖监听器可靠与否：监听器正常时 invalidate 立刻生效，
 * 监听器失灵时最多再等 TTL 这么久就会自己读盘刷新。
 */
const conflictCache = new Map<string, { files: string[]; cachedAt: number }>();
const CONFLICT_CACHE_TTL_MS = 2000;

/**
 * 冲突副本清单，给界面用——不解决，只是让人看见。
 *
 * 两条返回路径都要 `.slice()`：跟上面 `readAll` 犯过的是同一种错——命中缓存、
 * 或者刚读盘存进缓存，返回的都不能是缓存里那个数组本身，否则调用方随手一句
 * `push` 就能在不碰磁盘的情况下污染这份内存索引。
 */
export function listConflicts(dir: string): string[] {
  if (!bypassCache) {
    const hit = conflictCache.get(dir);
    if (hit && Date.now() - hit.cachedAt < CONFLICT_CACHE_TTL_MS) return hit.files.slice();
  }
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => CONFLICT_RE.test(f));
  if (!bypassCache) conflictCache.set(dir, { files, cachedAt: Date.now() });
  return files.slice();
}

export function readOne<T>(dir: string, id: string): T | null {
  assertSafeId(id);
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * 原子写：同目录 `.tmp` 再 rename。跟 store.ts 的 writeAtomic 同一条规矩，
 * 但**不再生成 `.bak`**——历史版本交给同步服务，`.bak` 在同步目录里会让流量
 * 翻倍而且自己也会冲突。
 *
 * 独立成一个 helper 是给 `writeConflictCopy` 共用的：两个函数的差别只有「文件叫
 * 什么名字」，各写一遍 tmp+rename 就是这个仓库栽过四次的「同一件事两份实现」——
 * 而且第二份一旦漏掉 rename 那一步，冲突副本会以半截 JSON 的形态出现在同步目录里
 * （同步客户端照样把它传出去），比正本写歪还难查。**不导出**：外面拿 id 拼名字
 * 的入口只该有 writeOne / writeConflictCopy 两个，都各自过了 assertSafeId。
 */
function writeEntityFile(dir: string, name: string, entity: unknown): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entity, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  invalidate(dir);
}

export function writeOne(dir: string, entity: { id: string }): void {
  assertSafeId(entity.id);
  writeEntityFile(dir, `${entity.id}.json`, entity);
}

/**
 * 撞车时另存一份。**这一层唯一负责「冲突副本长什么名字」的地方。**
 *
 * 名字形状 `<id> (冲突副本 <8 位十六进制>).json`，那 8 位是内容的哈希，**不是
 * 时间戳**：手机推回来时回执可能半路丢掉，它下次重连会原样再推一遍——时间戳的话
 * 每重推一次就多一份副本，实体目录会堆满（正本第十节点名要防的）；内容哈希的话
 * 同样的内容第二次写的是同一个文件名，原地覆盖，数量不变。两次**不同**的冲突内容
 * 仍然是两个文件，不会互相盖掉。
 *
 * 哈希的输入走 `stableKey`（Task 3 从这个文件搬去 `push.ts` 的那一份，`syncAll`
 * 也在用），**不是 `JSON.stringify`**：后者的键顺序跟着对象的构造顺序走，手机上
 * 用展开运算符重拼过的那份跟原来那份键顺序未必一致，同一份内容会算出两个哈希——
 * 「重推不堆副本」这条就白写了，而且不会有任何报错。`sha1` 在这里只是内容指纹，
 * 不是安全用途（不防构造碰撞，也没有攻击面：撞了顶多是两份不同的冲突副本共用一个
 * 文件名，而 id 已经在名字里了）。
 *
 * **不 catch 写失败。** 调用方拿到返回值才把这条报成 `conflicted`，而手机收到
 * `conflicted` 就会清掉脏记号（正本写死的规矩）。吞掉异常返回一个名字，等于手机
 * 那份在服务端没有、在副本里也没有、记号还被清了——139 那条「把失败路径填成成功
 * 路径」在这一层最坏的版本。抛出去，路由整批 500，手机记号原样留着，下次再推。
 *
 * **删除撞车那种副本的内容**（`{ ...基准, id, deletedAt: <服务端此刻> }`）由调用方
 * 拼好整份传进来，这一层不看表：这个函数没有第二个理由认识时间，而「服务端此刻」
 * 一旦在这里现取，测试就控制不住它。
 *
 * **`deletedAt` 进文件内容，但不进哈希输入**——整个函数里唯一被特殊对待的字段，
 * 理由是它跟别的字段不是一回事：别的字段描述「这次冲突是什么」，`deletedAt` 描述
 * 「这份副本是什么时候写的」，**不是这次冲突的身份的一部分**（身份 = 哪个 id、
 * 基准是什么内容）。留在哈希里的话，删除撞车这一格会把上面那条防护整个绕回去：
 * 回执丢了手机重推同一条删除，服务端那份没动、还是判冲突，但 `now` 变了 → 哈希变了
 * → 又一份文件。而「回执丢了会重推」正是当初选内容哈希、不选时间戳要防的那个场景，
 * 四种撞车里唯独这一种把它防漏了。摘掉之后：同一条删除撞车重推多少次都是同一个
 * 文件（原地覆盖，内容里的 `deletedAt` 是最后一次那个时刻），基准不同的两条仍然是
 * 两个文件。
 *
 * 摘它是安全的，因为它**不是这两类实体的字段**：`Task` 和 `InboxItem` 都没有
 * `deletedAt`，只有垃圾箱里的 `TrashItem` 有（`store.ts` 那条注释写死了「加进
 * `Task` 等于让每一条活着的任务都带一个永远是 undefined 的字段」），而垃圾箱不走
 * 这一层的实体目录。所以副本上的 `deletedAt` 只可能是调用方现盖的这一个戳，摘掉它
 * 不会把两份内容真的不同的副本误判成同一份。
 *
 * **代价**（有，只是比收益小得多，不是没有）：摘掉之后「带 `deletedAt` 的那份」和
 * 「不带的那份」算出同一个文件名。同一个 id 先来一次删除撞车、后来又来一次 upsert
 * 撞车，而且后者的 `value` 恰好逐字节等于前者的基准时，后写的会原地覆盖前一份，
 * 那个 `deletedAt` 标记就没了——人打开看到的又是一份跟正常实体一模一样的 JSON，
 * 看不出「另一台设备把这个版本删了」。触发条件很苛刻，而且**没有用户内容丢失**
 * （两份的实体内容本来就一模一样），丢的只是那一句注解。用它换掉「删除撞车重推
 * 每次多堆一份副本」，这笔账是划算的。
 *
 * 最后那句断言不是洁癖：名字要是哪天改得不再匹配 `CONFLICT_RE`，`isEntityFile` 就会
 * 把这份副本当成正常实体读进 `readAll`——同一个 id 出现两次，上层按 id 建索引，后来的
 * **静默**盖掉先来的。这一层最不能静默的就是这一种坏法，宁可当场抛。
 */
export function writeConflictCopy(dir: string, entity: { id: string }): string {
  assertSafeId(entity.id);
  // 解构摘 `deletedAt`，不是 `{ ...entity, deletedAt: undefined }`：后者要靠
  // 「`undefined` 和没有这个键序列化结果一样」这条 `stableKey` 自己都标成边界的
  // 规矩（见 push.ts 那段注释的第 2 条），换个写法就会飘。摘法跟 app.ts 里
  // 「从垃圾箱恢复时把 deletedAt 摘掉」用的是同一个（`const { deletedAt: _gone, ...task }`）。
  const { deletedAt: _写这一刻, ...身份 } = entity as { id: string; deletedAt?: unknown };
  const hash = createHash('sha1').update(stableKey(身份)).digest('hex').slice(0, 8);
  const name = `${entity.id} (冲突副本 ${hash}).json`;
  if (!CONFLICT_RE.test(name)) throw new Error(`冲突副本的名字认不出来，拒绝写：${name}`);
  writeEntityFile(dir, name, entity);
  return name;
}

export function deleteOne(dir: string, id: string): void {
  assertSafeId(id);
  const file = join(dir, `${id}.json`);
  if (existsSync(file)) rmSync(file);
  invalidate(dir);
}

/**
 * 把整张表变成 `next`：内容变了的写、新出现的写、不在 next 里的删。
 *
 * 存在的理由是**让上层的调用点一个都不用改**。`store.ts` 现在导出的是
 * `writeTasks(v: Task[])` 这种「给我整份数组」的签名，`app.ts` 和 `outbox.ts`
 * 到处在用。保留签名、在这里做增量，就能在不动那两个复杂文件的前提下换掉
 * 存储形态。
 *
 * 内容比对用 stableKey（序列化后的字符串，键顺序无关）。看着笨，但它精确
 * 对应「这个文件要不要重写」，而少写一次就少一次同步流量、少一次触发文件
 * 监听器。
 */
export function syncAll<T extends { id: string }>(dir: string, next: T[]): void {
  const prev = new Map(readAll<T>(dir).map((e) => [e.id, stableKey(e)]));
  assertNoCaseCollision([...prev.keys()], next.map((e) => e.id));
  const keep = new Set<string>();
  for (const e of next) {
    keep.add(e.id);
    if (prev.get(e.id) !== stableKey(e)) writeOne(dir, e);
  }
  for (const id of prev.keys()) if (!keep.has(id)) deleteOne(dir, id);
  invalidate(dir);
}
