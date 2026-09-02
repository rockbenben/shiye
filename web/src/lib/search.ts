import type { List, Task } from '../types.js';

/**
 * 全文匹配。范围刻意不含 `aiComment`——那是 AI 解释「我为什么这么拆」的旁注，
 * 搜「推断」应该搜出内容里带这两个字的任务，不是所有被 AI 推断过时间的任务。
 */
export function searchTasks(tasks: Task[], q: string): Task[] {
  const needle = q.trim().toLowerCase();
  // 空查询返回空数组，不是返回全部：「全部」是另一个去处，搜索框空着的时候
  // 冒充它，会让用户以为自己搜到了所有东西。
  if (!needle) return [];
  return tasks.filter((t) =>
    [t.title, t.notes, ...t.tags, ...t.subtasks.map((s) => s.text)]
      .some((s) => s.toLowerCase().includes(needle)),
  );
}

/**
 * 搜清单、搜标签——仿滴答清单：它的搜索页顶上有「任务 / 清单 / 标签」三个类型，
 * 而这里以前只搜任务，一个建了二十份清单的人想跳到某一份，只能在侧栏里一个个
 * 找过去。
 *
 * **不做成三个标签页**（它那边是）：那是为「结果成千上万、一页装不下」设计的，
 * 这个应用一屏就能同时摆下匹配到的几份清单、几个标签和任务列表——分成三页
 * 等于把「有没有匹配的清单」这个答案藏到一次点击后面。渲染成任务列表上面
 * 一排可点的胶囊，见 `SearchJumps`。
 *
 * 空查询返回空数组，跟 `searchTasks` 同一条约定。
 */
export function searchLists(lists: List[], q: string): List[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  // 归档的不出现。**当初的理由已经不成立了**（那时候归档的清单在侧栏里根本
  // 不渲染，搜出来点进去是一个导航上找不到回头路的去处；现在侧栏底下有一节
  // 「已归档」，回得去），但结论没变，换了个更本分的理由：归档的意思就是
  // 「这份我不再用了」，让它跟在用的那几份一起挤在搜索结果里，等于把归档
  // 这个动作的效果撤销掉一半。要找它，侧栏那一节就在那儿。
  // 智能清单**出现**——它是一份存下来的查询，照样是个能点进去的去处，
  // 跟普通清单在这件事上没有区别。
  return lists.filter((l) => !l.archived && l.name.toLowerCase().includes(needle));
}

/** 同上，标签那一半。`tags` 是全集（`allTags(tasks)` 现算出来的那份）。 */
export function searchTags(tags: string[], q: string): string[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return tags.filter((t) => t.toLowerCase().includes(needle));
}
