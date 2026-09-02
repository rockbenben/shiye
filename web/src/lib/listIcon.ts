/**
 * 清单名开头的 emoji 当成它的图标——仿滴答清单的「方式二」（帮助文档原话：
 * 「清单名称最前面输入 Emoji 表情，可自动设置为清单的图标」）。
 *
 * **不加字段、不做迁移、不加一个图标选择器**：清单名本来就存得下 emoji，
 * 而「名字最前面那个 emoji 就是图标」这条约定，用户不用学——他打上去就看见了。
 * 它那边另有一个 emoji 选择器（方式一），那要一份 emoji 面板；这条纯粹是
 * 一个正则，覆盖同一件事。
 */

/**
 * 认「开头恰好一个 emoji」。三种形状都要认，不然常用的一半 emoji 会漏：
 *
 * - **国旗**是两个 Regional Indicator（🇨🇳 = 🇨 + 🇳），单独一个不成字形；
 * - **ZWJ 序列**是几个字形用 U+200D 粘起来的（👨‍💻 = 👨 + ZWJ + 💻），
 *   不整串吃掉的话会把「👨」当图标、把「‍💻工作」当名字；
 * - **变体选择符 U+FE0F 和肤色修饰符**跟在字形后面，同样要一起吃掉。
 *
 * 用 `\p{Extended_Pictographic}` 不用 `\p{Emoji}`：后者把数字 `0-9`、`#`、`*`
 * 也算进去（它们是 keycap 序列的基字符），一个叫「1月计划」的清单会被切成
 * 图标「1」+ 名字「月计划」。
 */
// 两条写法上的讲究：
// ① **正则字面量，不用 `new RegExp` 拼字符串**。拼字符串的话每个 `\p` 都要在
//    字符串里再转义一层，少写一个反斜杠就得到一个语法合法、语义完全不同的
//    正则（字符串里的 `\p` 退化成 `p`，于是它开始匹配字母 p），而且只有真的
//    跑到这一行才炸。这一版第一次写就是这么错的。
// ② **变体选择符和 ZWJ 写成转义序列，不写字面字符**。它们在编辑器里是零宽的，
//    源码上看不见——一行里有几个、有没有被谁顺手删掉一个，肉眼分辨不了。
const LEADING_EMOJI = /^(\p{RI}\p{RI}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?)*)\s*/u;

export interface ListLabel {
  /** 开头那个 emoji，没有就是 null。 */
  icon: string | null;
  /** 去掉图标（和它后面那点空白）之后的名字。 */
  text: string;
}

/**
 * 拆成「图标 + 名字」。没有图标时 `text` 就是原名，`icon` 是 null——调用方
 * 据此决定画 emoji 还是画那颗分类色圆点。
 *
 * **整个名字就是一个 emoji 时不拆**（一个叫「🏠」的清单）：拆完名字是空的，
 * 导航上会出现一条没有文字的项，读屏软件念不出它是什么。那种情况下这个
 * emoji 是名字，不是图标。
 */
export function listLabel(name: string): ListLabel {
  const m = name.match(LEADING_EMOJI);
  if (!m) return { icon: null, text: name };
  const text = name.slice(m[0].length);
  if (!text.trim()) return { icon: null, text: name };
  return { icon: m[1], text };
}

/**
 * 按 `order` 排一份拷贝。**侧栏和「移动到」那几个菜单共用这一个**——
 * 两边各排各的（或者一边压根不排）就是下面 `fileableLists` 注释里说的事。
 */
const byOrder = <T extends { order: number }>(xs: T[]): T[] => [...xs].sort((a, b) => a.order - b.order);

/**
 * 「一条任务能归到哪几个清单」——**这份判据以前有三份手抄的副本**
 * （TaskFields 的下拉、BatchBar 的批量改清单、FilterBar 的清单维度），
 * 三处的注释各自都在提醒对方别改歪。第四处（卡片 ⋯ 里的「移动到」）要用同一份
 * 判据，与其再抄一遍不如收成这一个函数。
 *
 * **两类清单不能当容器**：
 * - **智能清单**（`filter` 非 null）：它是一份存下来的查询，不是容器。把任务的
 *   `listId` 指过去没有任何意义——那条任务不会因此出现在这份智能清单里（智能
 *   清单按 `applyFilter` 取任务，根本不看 `listId`，见 `scoped.ts` 顶部），
 *   反而在导航里哪儿都找不到了。
 * - **归档了的清单**：归档的意思就是「别再往里放东西」。
 *
 * `keepId` 是唯一的例外口子：一条任务本来就在某个已归档的清单里时，那个清单要
 * 留在候选里。否则打开编辑表单、什么都没动就保存，下拉框会因为选不中当前值而
 * 静默把它挪到别处——「不动它就不该变」比「归档的不给选」优先。
 */
export const fileableLists = <T extends { id: string; archived: boolean; filter: unknown; order: number }>(
  lists: T[], keepId?: string | null,
): T[] => byOrder(lists.filter((l) => l.filter === null && (!l.archived || l.id === keepId)));

// **排序不是可有可无的。** 这个函数供着四处清单选择器（任务 ⋯ 的「移动到」、
// 批量操作条、筛选栏按清单、任务详情的清单下拉），而它以前只筛不排——于是那四处
// 显示的是服务端读目录的顺序，跟侧栏那份按 `order` 排的对不上。两三份清单时没人
// 看得出来；十几份时每次「移动到」都得重新扫一遍，因为它不是你自己排的那个顺序。
// ponytail: 只按 `order` 排，没按（文件夹, order）——那要把 folders 传进四个组件。
// 清单跨文件夹交错时会跟侧栏略有出入；真碍事了再把 folders 接进来。

/**
 * 把清单按文件夹分组（仿滴答清单：文件夹是清单的容器，只有一层）。
 *
 * 补的是一个整块存在于服务端、界面上一处都没有的东西：`Folder` 那张表、
 * `List.folderId` 这个字段、四条 CRUD 路由都在，而侧栏一直把清单平铺——
 * 攒到十几份之后就没法看了，那正是文件夹要解决的事。
 *
 * **顺序**：文件夹按自己的 `order`，每个文件夹里的清单按清单自己的 `order`；
 * 不属于任何文件夹的清单单独一组、排在**最前面**。放前面不是随手定的：
 * 多数人只会把一部分清单收进文件夹，剩下那些是天天点的，不该被推到底下。
 *
 * **指向一个已经不存在的文件夹的清单，当成顶层**——服务端删文件夹时会把
 * `folderId` 置空，但手改过的文件、或者两台机器同步到一半，都可能留下一个
 * 悬空的 id。悬空就整份清单从侧栏消失，是最糟的那种表现。
 */
export interface FolderGroup<L> {
  /** `null` = 不属于任何文件夹的那一组。 */
  folder: { id: string; name: string } | null;
  lists: L[];
}

export function groupListsByFolder<
  L extends { folderId: string | null; order: number },
  F extends { id: string; name: string; order: number },
>(lists: L[], folders: F[]): Array<FolderGroup<L>> {
  const known = new Set(folders.map((f) => f.id));
  const loose = byOrder(lists.filter((l) => !l.folderId || !known.has(l.folderId)));
  const groups: Array<FolderGroup<L>> = loose.length > 0 ? [{ folder: null, lists: loose }] : [];

  for (const f of byOrder(folders)) {
    // **空文件夹也要出现**：建完文件夹还没往里放东西时，它得看得见——
    // 看不见的话，「移到文件夹」那个菜单里冒出一个侧栏上根本没有的名字。
    groups.push({ folder: { id: f.id, name: f.name }, lists: byOrder(lists.filter((l) => l.folderId === f.id)) });
  }
  return groups;
}

/**
 * 上移 / 下移一份清单或一个文件夹（仿滴答清单：侧栏能拖着重排）。
 * 返回**要写的那几条**（id + 新 order），没得动就是空数组。
 *
 * 补的是又一个「建出来就冻住」的字段：`order` 在 `POST /api/lists` 那一刻定成
 * 「当前有几份」，之后一直没有任何入口能改——清单的先后顺序等于建的先后顺序，
 * 永远。文件夹同理。
 *
 * **不做拖拽，做上移/下移。** 侧栏的拖放要接一整套 dnd 传感器、还要处理
 * 「拖进文件夹」和「在文件夹里排序」两种落点；而上移/下移是这个仓库已经有的
 * 那条路（「今天」视图卡片上的 MoveControls），键盘和鼠标共用，一行代码不用
 * 为触摸屏另写。
 *
 * **只在同一层内换位置**：清单在自己所属的文件夹里上下动，不会因为「上移到
 * 顶」就跳进上一个文件夹——那是「移到文件夹」那个菜单干的事，两个动作分开，
 * 一次点击只做一件事。
 *
 * 返回的 order **重排整段**（0..n-1）而不是只交换那两条的值：现有数据里
 * `order` 可能有重复或空洞（手改过的文件、老数据），只换两个值会把错乱留在
 * 原地；整段重编一次顺便把它捋直。
 */
export interface OrderPatch { id: string; order: number }

export function movePatches<T extends { id: string; order: number }>(
  siblings: T[], id: string, delta: -1 | 1,
): OrderPatch[] {
  const sorted = [...siblings].sort((a, b) => a.order - b.order);
  const i = sorted.findIndex((x) => x.id === id);
  const j = i + delta;
  // 不在这一段里、或者已经在头/尾——什么都不发。调用方也据此把按钮禁掉。
  if (i < 0 || j < 0 || j >= sorted.length) return [];
  [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  return sorted
    .map((x, k) => ({ id: x.id, order: k }))
    // 只发真的变了的：一次上移最多动两条，剩下的原样不动就别刷它们的记录。
    // 除非原来的 order 本来就是错乱的——那时候多发几条正是要的。
    .filter((x) => siblings.find((s) => s.id === x.id)?.order !== x.order);
}


/**
 * 清单的分类色。**新建时按清单数轮着取，也是「改颜色」那个菜单的全部选项。**
 *
 * 六个定色而不是一个自由取色器：`<input type="color">` 挑得出群青
 * （`#2E3ED4`），而服务端会拒收它——群青是配给制、只标 AI 产出，
 * `checkListPatch` 里那条拒绝是有意的。给一个能挑出「服务端不收」的控件，
 * 等于把一次 400 摆在用户面前，而他挑的时候完全看不出哪个不行。一份定好的
 * 调色盘从形状上就挑不出那个颜色。
 *
 * 名字是给菜单用的——一排只有色块、没有字的菜单项，读屏软件念不出来，
 * 键盘用户也没法凭「第三个」记住自己想要哪个。
 */
export const LIST_COLORS: Array<{ hex: string; name: string }> = [
  { hex: '#C2410C', name: '砖红' },
  { hex: '#15803D', name: '松绿' },
  { hex: '#7E22CE', name: '紫' },
  { hex: '#B45309', name: '赭石' },
  { hex: '#0E7490', name: '青' },
  { hex: '#BE123C', name: '玫红' },
];
