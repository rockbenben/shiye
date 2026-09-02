import type { TaskDraft } from '../components/TaskFields.js';

/**
 * 编辑到一半、卡片被卸载了——**把草稿存住，回来接着改**。
 *
 * ## 为什么需要
 *
 * 一张卡的编辑态整个活在 `TaskCard` 自己的 `useState` 里。而八个视图里只有
 * 「今天」「按来源」「收件箱」是 `keepMounted`，其余（全部 / 已完成 / 搜索 /
 * 清单 / 标签 / 看板 / 四象限 / 日历）**切走就卸载**：在「全部」里改一条任务
 * 的备注，中途点一下「今天」看一眼，回来时刚打的字一个不剩，而且**一声不吭**。
 *
 * 这不是一个新发现的形状——收件箱那条草稿栽过同一个坑，当时的修法是给那个
 * 视图加 `keepMounted`，注释写着「漏了这一行，切走再切回来会把正在编辑的
 * 收件箱草稿悄悄冲掉」。**任务卡这边修不了同一处**：八个视图全挂着不卸载，
 * 等于把整棵树留在内存里（日历、看板各带一套 dnd 传感器），而它们本来就是
 * 为了「切走就干净」才不 keepMounted 的。
 *
 * ## 形状
 *
 * 一个模块级的 `Map`，键是任务 id。**只活在这一次页面会话里**——刷新就空，
 * 不进 `localStorage`：一份三天前的草稿在下一次打开时自动跳出来，比丢了更吓人
 * （跟番茄钟「关掉页面 = 放弃」同一条：不进那扇门）。
 *
 * 存的时机是**卸载那一刻**，而不是每次敲键——按键存等于每敲一个字写一次全局
 * 状态，而这里要的只是「卸载别把它带走」。
 *
 * 保存成功、主动取消，都要 `clear`：那两下之后再「恢复」出一份旧草稿是凭空
 * 冒出来的东西。保存失败**不清**——那时候草稿必须留着（`TaskCard.save()` 里
 * 那条既有的教训）。
 */
const stash = new Map<string, TaskDraft>();

export function stashDraft(id: string, draft: TaskDraft): void {
  stash.set(id, draft);
}

/** 取出来并**移交所有权**（同时删掉）：恢复之后草稿的家就是那个组件实例，
 *  留一份在这儿只会在下一次挂载时把更新的内容盖回旧的。 */
export function takeDraft(id: string): TaskDraft | null {
  const d = stash.get(id);
  if (d) stash.delete(id);
  return d ?? null;
}

export function clearDraft(id: string): void {
  stash.delete(id);
}

/** 测试用：把整份清空，免得用例之间互相串。 */
export function resetDrafts(): void {
  stash.clear();
}
