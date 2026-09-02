import { listConflicts } from './entityStore.js';
import { paths, type ConflictFile } from './store.js';
import { listBroken } from './entityStore.js';

export type { ConflictFile };

/**
 * 扫全部实体目录，把同步客户端留下的冲突副本列出来。
 *
 * `readAll` 会**静默跳过**这些文件（`entityStore.isEntityFile`）——那是对的，
 * 同一个 id 出现两次会让后来的盖掉先来的。但「跳过」不等于「没发生」：不把它
 * 显示出来的话，用户永远不知道两台设备改过同一条。规格第十节原话：「这是同步
 * 功能里最容易被做成静默丢数据的一环，不能只做『同步成功』的路径」。
 *
 * 遍历 `Object.entries(paths())` 而不是写死一个目录列表——再加一种实体时
 * 写死的那份会悄悄漏掉它，而漏掉的表现正是「没有冲突」这种最让人放心的假象。
 * （这话已经应验过一次：`countdowns` 就是后加的那一个。代码自动跟上了，而
 * 当时散文里那些「七个目录」全停在原地——所以下面一律不写数字。）
 *
 * 代价没有藏起来：`paths()` 里每个目录各一次同步 `readdirSync`，挂在每次 `GET /api/conflicts`
 * 上（前端每次 reload 都拉，见 App.tsx）。本地盘无所谓；WebDAV 挂载 + 上千任务时
 * 会是每个目录一次同步网络 listing，阻塞事件循环。`entityStore.listConflicts` 挂了一个
 * 2 秒 TTL 缓存（跟 `readAll` 同一套 `invalidate`/`bypassCache` 入口，另开一张
 * 表），这些 `readdirSync` 从「每次调用」降到「每 2 秒最多一次」，见那边的注释。
 */
export function listAllConflicts(): ConflictFile[] {
  return Object.entries(paths()).flatMap(([kind, dir]) =>
    listConflicts(dir).map((file) => ({ kind, file })),
  );
}


/**
 * 读不出来的实体文件——**跟冲突副本分开报**：两者要人做的事完全不一样。
 * 冲突副本是「有两份，挑一份」，坏文件是「这一条现在打不开，去修或者删掉」。
 * 混成一条横幅会让两种处置说不清。
 *
 * 不自己扫盘：判据在 `entityStore.readAll` 里——它本来就把每个文件读了一遍，
 * 那一趟顺手记下的。另写一个「找出所有坏文件」的接口等于把整个 `data/`
 * 再读一遍，而这条要挂在每次刷新上。
 */
export function listAllBroken(): ConflictFile[] {
  const byDir = new Map(Object.entries(paths()).map(([kind, dir]) => [dir, kind]));
  return listBroken().map(({ dir, file }) => ({ kind: byDir.get(dir) ?? dir, file }));
}
