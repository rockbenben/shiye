/**
 * 二级标签——仿滴答清单的「标签层级支持创建二级标签」。
 *
 * **用命名约定 `父/子`，不加一张标签表。** 它那边标签是一条独立记录，层级
 * 存在记录上，靠侧栏拖拽建立；这个应用里标签根本没有实体——`allTags(tasks)`
 * 是从任务上现算出来的（`Sidebar.tsx` 那句注释：「省掉『标签表和任务对不上』
 * 那一整类 bug」）。为了一层嵌套引进一张表，就是把那一整类 bug 请回来。
 *
 * 用斜杠是 Obsidian / Logseq / Joplin 那一套通行写法：打 `#工作/项目A`
 * 就建好了，不用先去侧栏拖一下。代价是创建方式跟它不一样（打字 vs 拖拽），
 * 层级本身的效果一致：侧栏里缩进成两级，点父标签连子标签的任务一起看。
 *
 * **只做两级**，跟它一样。`a/b/c` 里第一个斜杠之后的整段都算子标签的名字
 * （子标签叫 `b/c`），不再往下切——三级目录在一个单人工具里是自找麻烦，
 * 跟 `Folder`「只做两层」是同一条判断。
 */

/** 分隔符。写成常量是因为下面四个函数都要用，而它以后可能要换。 */
export const TAG_SEP = '/';

export interface TagNode {
  /** 完整标签名，也是去处 key 里那一段（`tag:工作/项目A`）。 */
  name: string;
  /** 侧栏上显示的那一段——子标签只显示斜杠后面的部分，不重复父标签的名字。 */
  label: string;
  /** 这个名字本身是不是真的挂在某条任务上。`false` 表示它只是被子标签推导
   *  出来的一个分组（只有 `#工作/项目A`、没有任何任务打过 `#工作`）——照样
   *  点得进去（点父标签连子标签一起看），只是它自己名下没有任务。 */
  real: boolean;
  children: TagNode[];
}

/** 拆成 `[父, 子]`。没有斜杠就是 `[整个名字, null]`；`a/b/c` 的子是 `b/c`。 */
export function splitTag(tag: string): [string, string | null] {
  const i = tag.indexOf(TAG_SEP);
  if (i <= 0 || i === tag.length - 1) return [tag, null];   // 没有斜杠、开头是斜杠、结尾是斜杠：都当没有层级
  return [tag.slice(0, i), tag.slice(i + 1)];
}

/**
 * 把一份扁平的标签全集组织成两级。父按名字排序，子在各自父下面按名字排序。
 *
 * 输入约定是 `allTags(tasks)` 的输出（已经去重、已经排好序）。
 */
export function tagTree(tags: string[]): TagNode[] {
  const roots = new Map<string, TagNode>();
  const ensure = (name: string, real: boolean): TagNode => {
    const got = roots.get(name);
    if (got) {
      // 先被子标签推导出来、后来发现真的有任务打过它——把 real 补上。
      if (real) got.real = true;
      return got;
    }
    const node: TagNode = { name, label: name, real, children: [] };
    roots.set(name, node);
    return node;
  };

  for (const tag of tags) {
    const [parent, child] = splitTag(tag);
    if (child === null) {
      ensure(tag, true);
      continue;
    }
    const p = ensure(parent, false);
    p.children.push({ name: tag, label: child, real: true, children: [] });
  }

  const byName = (a: TagNode, b: TagNode) => a.name.localeCompare(b.name, 'zh');
  const out = [...roots.values()].sort(byName);
  for (const n of out) n.children.sort(byName);
  return out;
}

/**
 * 「这条任务算不算挂在标签 `tag` 下」——**父标签连子标签一起算**。
 *
 * 点进「工作」要看到 `#工作/项目A` 的任务，不然二级标签只是侧栏上好看一点，
 * 点进去还是空的。反过来点「工作/项目A」只看它自己那些，不会把兄弟标签
 * 的任务也捞进来。
 *
 * 前缀比较带上分隔符（`工作/`），不是裸 `startsWith('工作')`——不然
 * `#工作台` 会被算成 `#工作` 的子标签。
 */
export const taggedWith = (taskTags: string[], tag: string): boolean =>
  taskTags.some((t) => t === tag || t.startsWith(tag + TAG_SEP));

/**
 * 重命名 / 删除一个标签（仿滴答清单的标签管理）。返回**逐条不同**的补丁，
 * 一条都不用改就是空数组——调用方据此不发请求。
 *
 * 补的是一个只能一条条改的坑：标签不是一张表，它就是任务上的字符串
 * （见这个文件顶部）。打错一个字、想换个叫法，在这之前只能把带着它的每一条
 * 任务都打开改一遍——十二条任务就是十二次编辑，而这正是「标签」这种轻量
 * 东西最容易需要返工的地方。
 *
 * **子标签一起改**：`工作` 改名，`工作/紧急` 也得跟着变成 `新名/紧急`，
 * 不然层级当场断成两棵树。判据跟 `taggedWith` 完全一致（前缀比较带上分隔符），
 * 所以 `#工作台` 不会被误伤——两处共用同一条规则，不在这儿另写一遍。
 */
const renameOne = (t: string, from: string, to: string): string =>
  (t === from ? to : (t.startsWith(from + TAG_SEP) ? to + t.slice(from.length) : t));

/** 去重但保序：目标名可能跟这条任务上已有的另一个标签撞上（把 `工作` 改成
 *  `事务`，而它本来就打着 `事务`）——不去重的话那条任务会有两个一模一样的标签。 */
const uniq = (xs: string[]): string[] => [...new Set(xs)];

export interface TagPatch { id: string; patch: { tags: string[] } }

/**
 * 改名。空名字、只有空白、跟原名一样，一律返回空数组——不发一个什么都不改
 * （或者会把标签改没）的写。
 */
export function renameTagPatches(
  tasks: Array<{ id: string; tags: string[] }>, from: string, to: string,
): TagPatch[] {
  const target = to.trim();
  if (!from || !target || target === from) return [];
  const out: TagPatch[] = [];
  for (const t of tasks) {
    const tags = t.tags ?? [];
    if (!taggedWith(tags, from)) continue;
    out.push({ id: t.id, patch: { tags: uniq(tags.map((x) => renameOne(x, from, target))) } });
  }
  return out;
}

/**
 * 删除。**只把标签从任务上摘掉，不动任务本身**——一个标签是一种叫法，
 * 不是一个容器；删掉「紧急」这个叫法不该连着删掉那十二件事。子标签一起摘，
 * 理由同改名。
 */
export function deleteTagPatches(
  tasks: Array<{ id: string; tags: string[] }>, tag: string,
): TagPatch[] {
  if (!tag) return [];
  const out: TagPatch[] = [];
  for (const t of tasks) {
    const tags = t.tags ?? [];
    if (!taggedWith(tags, tag)) continue;
    out.push({ id: t.id, patch: { tags: tags.filter((x) => !(x === tag || x.startsWith(tag + TAG_SEP))) } });
  }
  return out;
}
