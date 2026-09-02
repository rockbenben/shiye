import type { Task } from './../types.js';
import { descendantIds, subtreeHeight } from '../../../server/src/mutate.js';

/**
 * 删除任务那句确认文案——**单条和批量共用这一份**。
 *
 * 原来它是三份**一字不差的字符串**，分别写在 `TaskCard.tsx`、`TaskRow.tsx` 和
 * `App.tsx` 的批量确认里（README 里那句「删除前那句确认文案两种密度共用」当时
 * 只对菜单结构成立，文案本身并没有收拢）。三份复制的代价这一轮当场兑现：下面
 * 那句「子任务会跟着一起进垃圾箱」要是只补一处，另外两处就会继续瞒着。
 *
 * ## 那句必须说出来的话
 *
 * 删掉一条**有子任务的父任务**时，它的子任务**跟着一起进垃圾箱**
 * （`server/src/mutate.ts` 的 `softDeleteTasks`，跟滴答清单一致）。一次点击
 * 带走的不止一条，那就必须在按下去之前说清楚带走几条——这正是这个文件存在的
 * 理由。
 *
 * **还原会一起捞回来**：从垃圾箱还原父任务时，同一次删进去的子任务跟着回来、
 * 层级原样接上（判据是 `deletedAt` 相同，见 `restoreFromTrash`）。所以这一下
 * 是完全可还原的，跟「删除先进垃圾箱」那条一脉相承。
 *
 * 纯函数，`all` 是发这一下之前的全部任务（要数孩子）。
 */
export interface DeleteConfirm {
  title: string;
  content: string;
}

/** 「先进垃圾箱、能还原、搁置更轻」那半句。两条路只差「搁置」怎么点。 */
const trashLine = (later: string) =>
  `会先进垃圾箱，想反悔可以在那里还原；只是暂时不想看见的话，${later}更轻。`;

/**
 * 「孩子跟着一起删」那半句。没有孩子就是空串。
 *
 * **不叫 `orphanLine`**（原来的名字）：那是上一版行为的名字——孩子被摘出来变成
 * 顶层、成了「孤儿」。现在它们跟着父亲一起进垃圾箱、还原时一起回来，没有谁被
 * 摘出来，名字里再留着 orphan 就是在说一件不成立的事。
 */
/**
 * 「会跟着一起进垃圾箱的有几条」。
 *
 * **数的是整棵子树，不是直接子任务**——多级任务放开到五层之后，删一个项目
 * 可能一次带走十几条。只数一层的后果很具体：确认框说「3 条」，实际进垃圾箱
 * 的是十四条，而这句话存在的全部意义就是「这一下会牵动什么」。
 *
 * **超过一层时把层数也说出来。** 「3 条」和「3 条（最深 4 层）」在屏幕上一样
 * 长，而后者意味着他正在删掉一整棵结构。垃圾箱能还原，但「还原时一起回来」
 * 这句话安慰的是能想起来去还原的人。
 */
const kidsLine = (n: number, depth: number, whose: string) => {
  if (n === 0) return '';
  const deep = depth > 1 ? `（最深 ${depth + 1} 层）` : '';
  return `${whose} ${n} 条子任务${deep}会跟着一起进垃圾箱，还原时一起回来。`;
};

/** 一条任务。 */
export function deleteOneConfirm(t: Task, all: Task[]): DeleteConfirm {
  // 整棵子树，判据跟服务端删除那条连带同源（`mutate.ts` 的 `descendantIds`）
  // ——确认框说的数字和实际进垃圾箱的数字必须是同一个。
  const under = descendantIds(all, t.id);
  const kids = under.size;
  const depth = subtreeHeight(all, t.id) - 1;
  return {
    title: `删掉「${t.title}」？`,
    // 意外的那句排在前面，跟删清单那个确认框同一个顺序（「里面那 12 条任务不会
    // 被删」在前、「用归档更轻」在后）：先说这一下会牵动什么，再说有没有退路。
    content: `${kidsLine(kids, depth, '它的')}${trashLine('用「搁置」')}`,
  };
}

/**
 * 选中的那几条。
 *
 * **只数「父亲被删、自己没被选中」的那些**：这句话报的是「这一下**还会额外**带走
 * 几条」。父子都在选中集合里时那个孩子已经算在「选中的 N 条」里了，再数一遍就是
 * 把同一条报两次。
 */
export function deleteManyConfirm(ids: string[], all: Task[]): DeleteConfirm {
  const gone = new Set(ids);
  // 整棵子树，跟单条那边同一个判据。**仍然只数「没被选中的」**：父子都在
  // 选中集合里时那个孩子已经算在「选中的 N 条」里了，再数一遍就是把同一条
  // 报两次——这一条跟改成整棵子树之前一字不差。
  const under = new Set<string>();
  for (const id of ids) for (const kid of descendantIds(all, id)) if (!gone.has(kid)) under.add(kid);
  const depth = Math.max(0, ...ids.map((id) => subtreeHeight(all, id) - 1));
  return {
    title: `删除选中的 ${ids.length} 条？`,
    content: `${kidsLine(under.size, depth, '它们底下还有')}${trashLine('批量改成「搁置」')}`,
  };
}
