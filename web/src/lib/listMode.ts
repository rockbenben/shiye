export type ListMode = 'list' | 'board';

/**
 * 一份任务清单**怎么摆**：竖着一条一条（列表），还是分成几列（看板）。
 *
 * **看板不是一个去处，是清单的一种显示方式。** 这一条是照滴答清单改的——它
 * 那边「看板」不在最左那条功能模块栏上，而在每份清单标题右边那个 ⋯ 菜单的
 * 「视图」一栏里，跟「列表」「时间轴」并排（官方说法：「在『最近7天』里选
 * 看板视图，就能看到每一天要做的事」）。
 *
 * 在这之前这里是反的：`看板` 是注册表里一条独立的去处，摆的固定是**全部**
 * 任务。于是「工作这个清单按状态分列看看」这个最自然的用法根本没有——你只能
 * 看全部任务的看板。改成显示方式之后，每一个任务去处（全部、已完成、搜索
 * 结果、某个清单、某个标签）都能就地切成看板，分组轴照旧可换。
 *
 * 存 `localStorage`，跟 `density`/`groupSort`/`kanbanAxis` 同一类：「这台机器上
 * 我想怎么看」，不是数据、不跟着账号走。写法照抄 `density.ts`，理由见那儿。
 */
const KEY = 'listMode';

/** 读不到、读到的不是 `'board'`，一律当 `'list'`——默认档，跟改之前一样。 */
export function getListMode(): ListMode {
  try {
    return localStorage.getItem(KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

export function setListMode(m: ListMode): void {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    // 同 density.ts：存不进去就这一个会话有效。
  }
}
