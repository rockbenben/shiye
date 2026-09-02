import { Fragment, useState, type ReactNode } from 'react';
import { Dropdown } from 'antd';
import type { Folder, InboxItem, Insight, List, Task } from '../types.js';
import { SIDEBAR_GROUPS, NAV_GROUP_LABEL, type ViewDef } from '../lib/views.js';
import { groupListsByFolder, LIST_COLORS, listLabel, movePatches, type OrderPatch } from '../lib/listIcon.js';
import { tagTree, type TagNode } from '../lib/tagTree.js';
import { describeFilter, type FilterLabels } from '../lib/describeFilter.js';
import { contextCount, folderCount, listCounts, tagCount } from '../lib/navCounts.js';
import { allTags, CONTEXT_LABEL, CONTEXTS, isSettled, STATUS_LABEL, STATUSES } from '../lib/taskView.js';
import { PRI_LABEL_ALL } from './TaskFields.js';
import { NavIcon } from './NavIcon.js';

/** 就地改名表单里那句「X 的新名字」用哪个词。键是 `renaming` 的前缀。 */
const RENAME_KIND: Record<string, string> = { tag: '标签', list: '清单', folder: '文件夹' };

interface Props {
  viewDefs: ViewDef[];
  current: string;
  onSelect: (key: string) => void;
  tasks: Task[];
  /** 只用来算「回顾」那个待确认的数（`ViewCountSource`）。 */
  insights: Insight[];
  inbox: InboxItem[];
  now: Date;
  lists: List[];
  /** 建一个新清单，名字已经去过首尾空白、确认非空。颜色由调用方（App）分配。 */
  onAddList: (name: string) => void;
  /**
   * 标签改名（仿滴答清单的标签管理）。**不给就不显示那两颗按钮**——标签管理
   * 要发一批写，由 App 那边接，跟 onAddList 同一个分工。
   */
  onRenameTag?: (from: string, to: string) => void;
  /** 标签删除。只把这个叫法从任务上摘掉，不删任务。 */
  onDeleteTag?: (tag: string) => void;
  /** 清单改名。**不给就不显示那颗 ⋯**，跟标签那两个同一个分工。 */
  onRenameList?: (id: string, name: string) => void;
  /**
   * 「让 AI 只回顾这份清单」。**智能清单没有这一项**：它是一条存下来的查询，
   * 不是容器，`listId` 指不到它身上（`scoped.ts` 顶上讲了这个区别）。
   * 跟别的回调一样，不给就不出现这一项。
   */
  onReviewList?: (l: List) => void;
  /** 归档 / 取消归档一份清单。归档的意思是「别再往里放东西」，不是删。 */
  onArchiveList?: (id: string, archived: boolean) => void;
  /** 删一份清单。里面的任务不会跟着删（服务端把 listId 置空）。 */
  onDeleteList?: (id: string) => void;
  /** 换一个分类色。候选只有 `LIST_COLORS` 那六个，见那份调色盘的注释。 */
  onRecolorList?: (id: string, hex: string) => void;
  /** 文件夹（把清单分组，仿滴答清单）。不给就当没有文件夹，侧栏跟原来一样平铺。 */
  folders?: Folder[];
  /** 建一个文件夹，名字已经去过首尾空白、确认非空。 */
  onAddFolder?: (name: string) => void;
  onRenameFolder?: (id: string, name: string) => void;
  /** 删文件夹。里面的清单不会跟着删（服务端把 folderId 置空，回到顶层）。 */
  onDeleteFolder?: (id: string) => void;
  /** 把一份清单挪进某个文件夹；`null` = 挪回顶层。 */
  onMoveListToFolder?: (id: string, folderId: string | null) => void;
  /**
   * 重排：把算好的 `order` 写回去（清单和文件夹共用一个回调，写的是哪张表由
   * `what` 说）。判据在 `lib/listIcon.ts` 的 `movePatches`——**只在同一层内
   * 换位置**，上移到顶不会跳进上一个文件夹，那是「移到文件夹」干的事。
   */
  onReorder?: (what: 'list' | 'folder', patches: OrderPatch[]) => void;
  /**
   * 改一份智能清单的筛选条件（仿滴答清单：智能清单建完还能编辑）。
   * **只对智能清单出现**——普通清单没有筛选条件可编辑。
   */
  onEditListFilter?: (l: List) => void;
  /** 底部那一行随手记。由 App 注入——它要发请求，绑在 App 的 state 上。 */
  composer: ReactNode;
  // 搜索的那两个 prop（query/onQuery）删了——搜索框搬去了竖栏上的弹层，
  // 见下面 return 里那段注释。
}

// 'search' 注册在表里（要有 label、要能被 App 渲染），但它不是一个点得到的
// 去处——搜索框里打字才会切过去。列在导航上等于一个永远显示「搜索结果」
// 的空入口。
// 导出：App.tsx 的 `1..9` 快捷键要从 VIEW_SPECS 推导出跟这里完全一致的顺序，
// 不能另写一份手写清单——两份顺序迟早分叉，见 keyboard 计划文档第 ③ 条。
export const SKIP_IN_NAV = new Set(['search']);

/**
 * 左栏。
 *
 * 换掉原来那个「整条 280px 放收件箱输入框」的布局：这个应用最显眼的常驻位置
 * 本该是一张「我手上有什么活」的地图，而不是一个往里塞东西的口子。
 *
 * **随手记没有消失，降级成底部一行。** 那是这个产品的命根子，成本不能变高——
 * 回车即存，不用先导航到收件箱；而「收件箱」作为一个去处出现在导航里，点进去
 * 才是待拆解列表。
 *
 * **用 nav 不用 tablist。** 原来两个视图是 role="tab"，那个模式对「两三个平级
 * 面板」是对的；十几个去处还带清单/标签分组之后就不成立了——tablist 要求容器里
 * 只有 role="tab" 的孩子，分组标题塞不进去，而且左右键切换在竖排导航里是错的
 * 手势。换成 nav + aria-current="page"，Tab 键逐个走过是导航该有的行为。
 *
 * **随手记（composer）不放进 `<nav aria-label="视图">` 里。** 一个输入框不是
 * 导航项，`nav` 这个 landmark 该只包导航项——屏幕阅读器用户按 landmark 跳转到
 * 「视图」导航时不该跳出来一个文本框。两者是兄弟节点，`.ink-rail-col` 那个
 * flex 列（见 theme.css）负责把随手记摆到视觉上的底部，跟 DOM 结构无关。
 */
/** 跟 `FilterBar` 那两张同一个出处。不把它们提到 `describeFilter.ts` 里去：
 *  那个模块故意不认识组件层的文案表（然而 `STATUS_LABEL` 在 `TaskCard`、
 *  `PRI_LABEL` 在 `TaskFields`），反向依赖不划算。 */
const FILTER_LABELS: FilterLabels = {
  status: Object.fromEntries(STATUSES.map((s) => [s, STATUS_LABEL[s]])),
  priority: PRI_LABEL_ALL,
  context: CONTEXT_LABEL,
};

export function Sidebar({
  viewDefs, current, onSelect, tasks, insights, inbox, now, lists, onAddList, onRenameTag, onDeleteTag,
  onRenameList, onArchiveList, onDeleteList, onRecolorList, onReviewList,
  folders = [], onAddFolder, onRenameFolder, onDeleteFolder, onMoveListToFolder, onReorder,
  onEditListFilter,
  composer,
}: Props) {
  // 「新建清单」那个小表单展不展开、草稿打了几个字——纯本地状态，不用提到
  // App 里：这个表单没有跨视图切换要保的内容，收起来（提交/取消/失焦）就
  // 清空，跟 TaskComposer「新任务」展开态是同一个量级的状态。
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  // 谁正在就地改名（一次只开一个），和输入框里的草稿。存的是**带前缀的键**
  // （`tag:<全名>` / `list:<id>`），跟 `current`/hashView 用的是同一套写法——
  // 标签和清单共用这一份状态，前缀保证两边的键撞不上。纯本地的一次性交互
  // 状态，不用提到 App。
  const [addingFolder, setAddingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  /**
   * 就地改名的小表单。标签和清单共用——两者要的完全一样：预填当前名字、
   * 回车提交、Esc 收起、没改或者改成空白就什么都不发。
   * 不用 Modal：这个侧栏「新建清单」已经是这套就地展开的模式了。
   * 原生 `prompt()` 更不行——它会挂住整个渲染进程。
   */
  const renameForm = (key: string, currentName: string, submit: (to: string) => void) => (
    <form
      className="ink-nav-tag-rename"
      onSubmit={(e) => {
        e.preventDefault();
        const to = renameDraft.trim();
        if (to && to !== currentName) submit(to);
        setRenaming(null);
      }}
    >
      <input
        autoFocus
        aria-label={`${RENAME_KIND[key.split(':')[0]] ?? '清单'} ${currentName} 的新名字`}
        value={renameDraft}
        onChange={(e) => setRenameDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }}
      />
      {/* 跟菜单里那一项同一个词。原来菜单说「重命名」、这颗确认按钮说
          「改名」——同一次动作走两个名字；而且这个菜单里挨着它的是「改颜色」
          「移到文件夹」「归档」，全是两三个字的白话动词，「重命名」是唯一一个
          软件翻译腔。 */}
      <button type="submit">改名</button>
    </form>
  );

  const startRename = (key: string, currentName: string) => {
    setRenaming(key);
    setRenameDraft(currentName);
  };

  const item = (key: string, label: string, count?: number) => (
    <li key={key}>
      <button
        type="button"
        className="ink-nav-item"
        // aria-current="page" 是「你正在看的就是这个」的标准说法。不用
        // aria-selected——那是 tab 模式的词，换了模式就不该继续借用。
        {...(current === key ? { 'aria-current': 'page' as const } : {})}
        onClick={() => onSelect(key)}
      >
        {/* 那个去处的记号。**这一列在这之前是十几行一模一样的纯文字**——
            「已完成」和「垃圾箱」在余光里分不开，找一个去处得逐行读过去。
            记号画在 NavIcon.tsx，一支笔、不上色，见那儿的说明。 */}
        <NavIcon name={key} />
        <span className="ink-nav-label">{label}</span>
        {/* 计数为 0 或者没有 count 都不渲染数字：一个常驻的「0」是噪音，
            而且会让人以为「按来源」里是空的。 */}
        {count ? <span className="ink-nav-count">{count}</span> : null}
      </button>
    </li>
  );

  // 收起来的文件夹。初值从 localStorage 读一次——**惰性初值，不是每次渲染都读**：
  // 每次读一遍会在每一帧造一个新 Set，而它进了下面的依赖比较。
  const [folded, setFoldedState] = useState<Set<string>>(() => getFolded());
  const flipFolder = (id: string) => {
    const next = toggleFolded(folded, id);
    setFoldedState(next);
    setFolded(next);
  };

  const visibleLists = lists.filter((l) => !l.archived);
  const archivedLists = lists.filter((l) => l.archived);
  const tags = allTags(tasks);
  // 导航那三段共用这一份。`SKIP_IN_NAV` 挡的是「搜索结果」那种打字之后才
  // 出现的去处。
  const shownViews = viewDefs.filter((v) => !SKIP_IN_NAV.has(v.key));

  /**
   * 每份清单、每个标签后面那个数字——**还没了结的有几条**（仿滴答清单）。
   * 十份清单摆在那儿，哪一份真堆着活、哪一份早就空了，在这之前只能一个个
   * 点进去看。口径和导航上「全部」那个数一致，详见 lib/navCounts.ts。
   */
  const listNums = listCounts(tasks, lists, now);
  /**
   * 每份清单**还挂着几条**——只给「让 AI 回顾这份清单」那一项判「能不能点」用。
   *
   * **不复用上面的 `listNums`**，虽然它就在手边：那个数走 `inAllView`，**搁置的
   * 算还在**（侧栏那个角标要回答「这摊还有多少事」，搁置的确实还在）；而回顾要
   * 的是 `isSettled` 那条线——`workflows/review.md` 明写「`later`（他自己搁置的）
   * 和 `done` 的不要动」，一份只剩搁置任务的清单，回顾进去一条都不许碰。
   *
   * 判据跟「回顾」那一屏那颗「让 AI 回顾一遍」逐字一致（`ReviewView.tsx` 的
   * `hasLive`）：**同一件事的两个入口不能有两个口径**——一个能点一个不能点，
   * 而界面上没有任何地方解释得了这个差别。
   */
  const liveByList = new Map<string, number>();
  for (const t of tasks) {
    if (t.listId && !isSettled(t)) liveByList.set(t.listId, (liveByList.get(t.listId) ?? 0) + 1);
  }


  /**
   * 侧栏那一段情境：**真有没了结的任务的那几档**，顺序跟 `CONTEXTS` 那份。
   * 数字口径跟标签/清单一致（`inAllView`），见 lib/navCounts.ts。
   */
  const liveContexts = CONTEXTS
    .map((key) => ({ key, count: contextCount(tasks, key) }))
    .filter((x) => x.count > 0);

  /** 一个标签导航项。父子共用——两者的区别只在外层 `<ul>` 的缩进，
   *  和「父节点自己有没有任务」这个记号，不是两种不同的按钮。 */
  /**
   * 智能清单那颗 ✦ 上的提示：「智能清单：待办 · #工作 · 3 天内」。
   * 条件读不出来（空查询、或者手改文件写坏了）就只留前四个字——跟以前一样。
   */
  const smartHint = (l: List): string => {
    const said = l.filter ? describeFilter(l.filter, lists, FILTER_LABELS) : null;
    return said ? `智能清单：${said}` : '智能清单';
  };

  const tagItem = (node: TagNode) => (
    <span className="ink-nav-tag-row">
      <button
        type="button"
        className={`ink-nav-item ink-nav-tag${node.real ? '' : ' ink-nav-tag-group'}`}
        {...(current === `tag:${node.name}` ? { 'aria-current': 'page' as const } : {})}
        onClick={() => onSelect(`tag:${node.name}`)}
      >
        {/* 井号——跟随手记/新任务标题里打 `#工作` 是同一个字，不另造一个
            标签图标。分组节点（不是真标签、只是某一段前缀）不给：它不是一个
            打得出来的标签。槽照样占着，名字才对得齐。 */}
        <span className="ink-nav-slot ink-nav-hash" aria-hidden="true">{node.real ? '#' : ''}</span>
        {node.label}
        {tagCount(tasks, node.name) ? (
          <span className="ink-nav-count">{tagCount(tasks, node.name)}</span>
        ) : null}
      </button>
      {/* 改名 / 删除（仿滴答清单的标签管理）**收在一颗 ⋯ 里**，跟任务卡上那颗
          同一个形状。两颗常驻的小按钮试过，两个问题：侧栏的标签是 12px 的
          胶囊、横着 wrap 排，每个后面挂两个字形等于把这一片的宽度和按钮数
          都翻倍；而一个一等位置的「×」，误点一下就是从 N 条任务上摘掉这个
          标签、且没有垃圾箱能捞——任务卡把「删除」从一等位置挪走正是这条
          理由（见 TaskCard.tsx 那颗 ⋯ 上面的注释）。
          改名走就地展开的小输入框（不是 Modal）：这个侧栏「新建清单」已经是
          这套模式了。原生 prompt 不能用，它会挂住整个渲染进程。
          子标签行上照样给：改 `工作/紧急` 只该动它自己，不该被迫从父标签下手。 */}
      {(onRenameTag || onDeleteTag) && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              ...(onRenameTag ? [{ key: 'rename', label: '改名' }] : []),
              ...(onDeleteTag ? [{ key: 'delete', label: '删除', danger: true }] : []),
            ],
            onClick: ({ key }) => {
              if (key === 'rename') startRename(`tag:${node.name}`, node.name);
              if (key === 'delete') onDeleteTag?.(node.name);
            },
          }}
        >
          <button type="button" className="ink-nav-tag-act" aria-label={`标签 ${node.name} 的更多操作`}>⋯</button>
        </Dropdown>
      )}
    </span>
  );

  const tagRow = (node: TagNode) => (renaming === `tag:${node.name}`
    ? renameForm(`tag:${node.name}`, node.name, (to) => onRenameTag?.(node.name, to))
    : tagItem(node));

  /** 一个文件夹那颗 ⋯ 里有哪几项。抽出来的理由同 `listMenu`：渲染和
   *  「摆不摆这颗按钮」用同一份，不是两处各列一遍。 */
  const folderMenu = (id: string) => [
    ...(onRenameFolder ? [{ key: 'rename', label: '改名' }] : []),
    ...(onReorder ? [
      { key: 'up', label: '上移', disabled: movePatches(folders, id, -1).length === 0 },
      { key: 'down', label: '下移', disabled: movePatches(folders, id, 1).length === 0 },
    ] : []),
    ...(onDeleteFolder ? [{ key: 'delete', label: '删除', danger: true }] : []),
  ];

  /**
   * 一个文件夹的标题行：收/放三角 + 名字 + 计数 + 那颗 ⋯（重命名 / 删除 / 上下移）。
   *
   * 这里原来写着「**不做展开折叠**：折叠状态又是一份要存的每台机器偏好，而文件夹
   * 本身已经把长列表切成了几段——真正解决「侧栏太长」的是分组，不是折叠」。
   * **那条理由建立在「清单分散在几个文件夹里」上**，而实际形状是一个文件夹装
   * 十一份清单（一个项目一份，全归在一个文件夹下）：这时候它没把列表切成几段，
   * 只是在十一行前面加了一行标题，侧栏反而更长。归档也不解决——归档的清单照样
   * 一行一行渲染在下面「已归档」那一节里，行数一条不少。实测 1440×1000 上，
   * 收起来让侧栏从要滚 91px 变成不用滚。
   *
   * 折叠状态存哪、为什么存「收起的那几个」而不是「展开的那几个」，在
   * `lib/folderFold.ts`。
   */
  const folderRow = (id: string, name: string, count: number) => (renaming === `folder:${id}`
    ? renameForm(`folder:${id}`, name, (to) => onRenameFolder?.(id, to))
    : (
      <p className="ink-nav-group ink-nav-group-sub ink-nav-folder">
        {/* 收/放。**整个标题不做成按钮**：它里面还坐着那颗 ⋯（一个 button），
            按钮套按钮是无效 HTML，读屏也念不清。单独一颗小三角，`aria-expanded`
            让读屏念得出「已折叠/已展开」，名字带上文件夹名——侧栏上会有好几颗。 */}
        <button
          type="button"
          className="ink-nav-fold"
          aria-expanded={!folded.has(id)}
          aria-label={`${folded.has(id) ? '展开' : '收起'}文件夹 ${name}`}
          onClick={() => flipFolder(id)}
        >{folded.has(id) ? '▸' : '▾'}</button>
        {/* 名字套 `.ink-nav-label`——**侧栏里别的每一行都套着它**（清单、标签、
            视图），只有文件夹标题是裸文字节点。差别在窄侧栏上就现形了：别的行
            省略号收尾，文件夹标题折成两行，而 `align-items: center` 把计数和
            那颗 ⋯ 停在两行的中间高度，看着像没对齐。实测 267px 宽的侧栏上，
            一个长文件夹名占 35px 高（两行 × 17.29）。
            不新写 CSS：那个类已经带着 flex:1 / min-width:0 / ellipsis 三件套。 */}
        <span className="ink-nav-label">{name}</span>
        {/* 跟它底下那几行同一个 class、同一条口径：标题上那个数就是底下几行
            加起来，一条不多一条不少。0 不画。 */}
        {count ? <span className="ink-nav-count">{count}</span> : null}
        {/* 跟清单那颗 ⋯ 同一条：**按算出来的菜单项决定摆不摆**，不是按
            「给了哪几个回调」——漏一个回调就是一颗看不见的菜单，全给了但
            菜单是空的就是一颗点开什么都没有的按钮。 */}
        {folderMenu(id).length > 0 && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: folderMenu(id),
              onClick: ({ key }) => {
                if (key === 'rename') startRename(`folder:${id}`, name);
                if (key === 'up') onReorder?.('folder', movePatches(folders, id, -1));
                if (key === 'down') onReorder?.('folder', movePatches(folders, id, 1));
                if (key === 'delete') onDeleteFolder?.(id);
              },
            }}
          >
            <button type="button" className="ink-nav-tag-act" aria-label={`文件夹 ${name} 的更多操作`}>⋯</button>
          </Dropdown>
        )}
      </p>
    ));

  /** 跟这份清单同一层的那几份——同一个文件夹里的，或者同为顶层的。
   *  上移/下移只在这一段里换位置。已归档的不参与：它们在侧栏里是单独一节。 */
  const siblingsOf = (l: List) => visibleLists.filter((x) => (x.folderId ?? null) === (l.folderId ?? null));

  /** 一份清单那颗 ⋯ 里有哪几项。抽出来是因为「摆不摆这颗按钮」要看它是不是
   *  空的——渲染和判断用同一份，不是两处各列一遍。 */
  const listMenu = (l: List) => [
    ...(onRenameList ? [{ key: 'rename', label: '改名' }] : []),
    // 编辑筛选条件（仿滴答清单）。**只有智能清单有这一项**：一份智能清单
    // 就是它那条筛选，而 `filter` 以前建出来就冻住——想改一个档位只能删了
    // 重建，名字、颜色、在侧栏里的位置全部重来。
    ...(onEditListFilter && l.filter ? [{ key: 'editfilter', label: '编辑筛选条件' }] : []),
    // 让 AI 只回顾这一份（`POST /api/review` 带上 listId）。**条件跟上一项正好
    // 相反**：智能清单是一条查询，没有任何任务的 `listId` 等于它的 id，发过去
    // 只会让 AI 对着一份空任务列表跑一趟、烧掉一次额度。
    //
    // **一条还挂着的任务都没有时置灰**，判据跟「回顾」那一屏那颗按钮逐字一致
    // （`ReviewView.tsx` 的 `hasLive`）。少了这条，一份空清单上点下去照样会真的
    // 叫一次 AI——CLI 那条烧一两分钟订阅额度，接口那条按 token 真花钱——然后回
    // 一句「没提出任何建议」。**置灰不藏起来**：藏起来菜单会忽长忽短，同一个动作
    // 每次落在不同的高度上（跟上移/下移到头时同一条）。灰的时候把理由写进名字里
    // ——菜单项没地方挂解释，而这个仓库不留没有解释的死按钮。
    ...(onReviewList && !l.filter ? [{
      key: 'review',
      label: (liveByList.get(l.id) ?? 0) > 0 ? '让 AI 回顾这份清单' : '让 AI 回顾这份清单（没有还挂着的任务）',
      disabled: (liveByList.get(l.id) ?? 0) === 0,
    }] : []),
    // 上移 / 下移（仿滴答清单侧栏能拖着重排）。**到头就禁用，不是藏起来**：
    // 藏起来的话菜单会随着位置忽长忽短，同一个动作每次在不同的高度上。
    // 只在**同一层内**换位置——`siblingsOf` 给的是「跟它同一个文件夹的那几份」。
    ...(onReorder ? [
      { key: 'up', label: '上移', disabled: movePatches(siblingsOf(l), l.id, -1).length === 0 },
      { key: 'down', label: '下移', disabled: movePatches(siblingsOf(l), l.id, 1).length === 0 },
    ] : []),
    ...(onArchiveList ? [{ key: 'archive', label: l.archived ? '取消归档' : '归档' }] : []),
    // 移到文件夹（仿滴答清单）。**一个文件夹都没有时整组不出现**：只剩
    // 「不放进文件夹」一项的「移到文件夹」什么都没说。当前所在的那个禁用着，
    // 理由同任务卡上的「移动到」——藏起来看不出它现在在哪。
    // 改颜色。**分类色一直是建清单那一刻按清单数轮着取的，之后没有任何入口
    // 能改**——攒到第七份清单时颜色开始重复，而那颗圆点正是侧栏里认清单用的
    // 记号。候选就是新建时用的那六个（`LIST_COLORS`），不给自由取色器：
    // 那个挑得出群青，而服务端会拒收它，等于把一次 400 摆在挑的人面前。
    // 每一项左边一颗那个颜色的圆点，右边写名字——只有色块的菜单读屏念不出来，
    // 键盘用户也没法凭「第三个」记住自己要哪个。当前那个禁用着，理由同「移动到」。
    ...(onRecolorList ? [{
      type: 'group' as const,
      label: '改颜色',
      children: LIST_COLORS.map((c) => ({
        key: `color:${c.hex}`,
        label: c.name,
        icon: <span className="ink-nav-dot" style={{ backgroundColor: c.hex }} aria-hidden="true" />,
        disabled: l.color.toUpperCase() === c.hex.toUpperCase(),
      })),
    }] : []),
    ...(onMoveListToFolder && folders.length > 0 ? [{
      type: 'group' as const,
      label: '移到文件夹',
      children: [
        ...folders.map((f) => ({
          key: `folder:${f.id}`, label: f.name, disabled: l.folderId === f.id,
        })),
        { key: 'folder:', label: '不放进文件夹', disabled: l.folderId === null },
      ],
    }] : []),
    ...(onDeleteList ? [{ key: 'delete', label: '删除', danger: true }] : []),
  ];

  /** 一份清单的导航项 + 那颗 ⋯。正常的和已归档的共用——两者的区别只在外层
   *  `<ul>` 的样式和菜单里那一项写「归档」还是「取消归档」。 */
  const listRow = (l: List) => (renaming === `list:${l.id}`
    ? renameForm(`list:${l.id}`, l.name, (to) => onRenameList?.(l.id, to))
    : (
      <span className="ink-nav-tag-row">
        <button
          type="button"
          className="ink-nav-item"
          {...(current === `list:${l.id}` ? { 'aria-current': 'page' as const } : {})}
          onClick={() => onSelect(`list:${l.id}`)}
        >
          {/* 名字最前面打了 emoji 就用它当图标，**替掉那颗分类色圆点**
              （仿滴答清单的「方式二」，判据在 lib/listIcon.ts）——两个
              都画的话一行里挤着两个记号，而它们说的是同一件事「这是
              哪份清单」。emoji 本身就携带信息，不 aria-hidden：读屏
              软件会念出它的名字（「房子」），那正是用户挑它的理由。
              没打 emoji 的照旧画圆点：分类色只上 background，永不上
              color——清单名本身是石墨黑，群青是「这是 AI 写的」的记号，
              分类色跟它共存靠的就是这条。见 theme.css 里 .ink-nav-dot。 */}
          {/* 记号一律收在同一个固定宽度的槽里（`.ink-nav-slot`，15px）——
              智能清单那几行的记号是 15px 的线描图标，清单是 6px 的圆点，
              emoji 又是另一个尺寸。不统一槽宽的话，同一列里的名字左边缘是
              锯齿状的，而「一列名字对不齐」正是这一栏看着乱的一半原因。 */}
          <span className="ink-nav-slot">
            {listLabel(l.name).icon
              ? <span className="ink-nav-emoji">{listLabel(l.name).icon}</span>
              : <span className="ink-nav-dot" style={{ backgroundColor: l.color }} aria-hidden="true" />}
          </span>
          <span className="ink-nav-label">{listLabel(l.name).text}</span>
          {/* 智能清单（filter 非 null）跟普通清单看得出区别——它是一份
              存下来的查询，不是容器，见 scoped.ts 顶部的注释。不上
              群青：这不是 AI 产出的内容，是「这条导航项是哪种清单」
              的界面记号，群青是配给制，只标 AI 写的/推断的东西，见
              task-3-brief 要点③。纯文字符号 + CSS，不套 antd 组件，
              不用管 colorPrimary 那层。
              跟 .ink-nav-dot 不是同一个道理——.ink-nav-dot 是纯装饰
              （颜色本身不携带别处没有的信息），✦ 携带的是「这是哪
              一种清单」，这个区别在别处没有任何表示，整颗
              aria-hidden 会让普通清单和智能清单的可访问名一模一样，
              见 final-review.md m3。只把 ✦ 这个字形对无障碍树隐藏，
              用 .ink-sr-only（跟 TodayView 手动排序播报同一个类）
              把「智能清单」这句话留给屏幕阅读器。 */}
          {/* 悬停能读到它到底筛的是什么。**一个智能清单在这儿只有一个名字**——
              一份存下来的查询叫「紧急」，那是「高优先级」还是「三天内到期」还是两者
              都要？不打开编辑器就不知道，而打开编辑器要点两下、还得记住原样退出。
              判据跟筛选栏下面那句预览共用（lib/describeFilter.ts）。 */}
          {l.filter && (
            <span className="ink-nav-smart" title={smartHint(l)}>
              <span className="ink-sr-only">{smartHint(l)}</span>
              <span aria-hidden="true">✦</span>
            </span>
          )}
          {/* 数字跟导航上那几个共用同一个 class（`.ink-nav-count`）和同一条规矩：
              **0 不画**——一个常驻的「0」是噪音。 */}
          {listNums.get(l.id) ? <span className="ink-nav-count">{listNums.get(l.id)}</span> : null}
        </button>
        {/* 改名 / 归档 / 删除收在一颗 ⋯ 里，跟标签那颗同一个形状和同一条
            理由（见 tagItem 里那段）。**服务端这两条路由早就通了，前端一直
            只接了「新建」** ——清单建出来改不动也删不掉，`archived` 更是
            没有任何入口能置成 true。 */}
        {/* **按算出来的菜单项决定摆不摆这颗 ⋯，不是按「给了哪几个回调」**：
            只接了「移到文件夹」、而一个文件夹都还没建的时候，菜单项是空的
            ——一颗点开什么都没有的 ⋯ 比没有更糟。 */}
        {listMenu(l).length > 0 && (
          <Dropdown
            trigger={['click']}
            menu={{
              items: listMenu(l),
              onClick: ({ key }) => {
                if (key === 'rename') startRename(`list:${l.id}`, l.name);
                if (key === 'editfilter') onEditListFilter?.(l);
                if (key === 'up') onReorder?.('list', movePatches(siblingsOf(l), l.id, -1));
                if (key === 'down') onReorder?.('list', movePatches(siblingsOf(l), l.id, 1));
                if (key === 'review') onReviewList?.(l);
                if (key === 'archive') onArchiveList?.(l.id, !l.archived);
                // `folder:` 后面空的就是「挪回顶层」——`null` 跟 List.folderId
                // 的语义一致，不是空字符串。
                if (key.startsWith('folder:')) onMoveListToFolder?.(l.id, key.slice(7) || null);
                if (key.startsWith('color:')) onRecolorList?.(l.id, key.slice('color:'.length));
                if (key === 'delete') onDeleteList?.(l.id);
              },
            }}
          >
            <button type="button" className="ink-nav-tag-act" aria-label={`清单 ${l.name} 的更多操作`}>⋯</button>
          </Dropdown>
        )}
      </span>
    ));

  return (
    <>
      {/* **搜索框搬走了**，搬到最左那条竖栏上的「搜索」那一颗（`SearchModal`）。
          它长在这儿有个绕不过去的毛病：这条侧栏只有任务模块才渲染，站在习惯/
          日历上按 `/` 是一个完全没反应的键——曾经靠「先切回任务模块再聚焦」打过
          补丁，那是在给一个放错位置的东西加绷带。滴答那边侧栏上也没有搜索框。 */}
      <nav className="ink-nav" aria-label="视图">
        {/* 这一份在下面分三段各渲染一次，先算好——`SKIP_IN_NAV` 挡的是
            「搜索结果」那种打字之后才出现的去处。 */}
        {/* `ink-nav-views` 是给样式表点名用的修饰类，跟下面标签那份的
            `ink-nav-tags` 一个道理：手机宽度下只有**视图**这一份摊成三列
            （theme.css 的 `@media (max-width: 767px)`），清单和标签两份继续竖排
            ——它们的名字是人起的，长度不可控。不靠 `:first-of-type` 认位置：那个
            伪类认的是标签名（`<ul>`），谁在前面插一份新列表，三列就悄悄套到错的
            那一份上，而且只在窄屏、只在视觉上塌，没有测试拦得住。 */}
        {/* **分三段，各带一个小标题。** 原来这十四项是一个平的 <ul>——而它们
            本来就是三类东西（换一批任务看 / 同一批任务的另一种摆法 / 另一个
            模块），摆成一排长得一样的行，看着又多又平。分段是仿滴答清单：
            它那边侧栏本来就分「智能清单 / 清单 / 标签 / 过滤器」几个区，
            而「模块」那一段（习惯/专注统计/纪念日/回顾）干脆不在这条侧栏上
            ——它画在最左那条模块栏上（窄屏时躺平到最上面），理由见 lib/views.tsx 的
            `RAIL_GROUPS`。
            判据（哪一项归哪一段）也在那儿。

            标题用的是「清单」「标签」那两段同一个 `.ink-nav-group`——它们是
            同一类东西（侧栏上的一段），不该长两个样。

            **空段整段不渲染**：导航项可以被逐项关掉（navVisibility），一段
            里的全关掉之后剩一个光秃秃的标题，比不显示更糟。 */}
        {SIDEBAR_GROUPS.map((g) => {
          const inGroup = shownViews.filter((v) => v.group === g);
          if (inGroup.length === 0) return null;
          return (
            <Fragment key={g}>
              <p className="ink-nav-group">{NAV_GROUP_LABEL[g]}</p>
              <ul className="ink-nav-list ink-nav-views">
                {inGroup.map((v) => item(v.key, v.label, v.count?.({ tasks, inbox, now, insights })))}
              </ul>
            </Fragment>
          );
        })}

        {/* 「清单」标题连同新建入口**不**锁在「已经有清单」的条件里——锁在
            里面的话，一条清单都没有的时候（这正是这个应用当前的状态：
            POST /api/lists 早就通了，前端一直没有任何 UI 调它）永远建不出
            第一条。下面那份具体的清单列表才继续按「有没有内容」条件渲染，
            一个空的 <ul> 不比不渲染更有用。 */}
        <p className="ink-nav-group">
          清单
          <button
            type="button"
            className="ink-nav-add"
            aria-label="新建清单"
            onClick={() => setAdding(true)}
          >＋</button>
          {/* 建文件夹（仿滴答清单）。挨着「新建清单」摆，不另起一节——
              文件夹是清单的容器，它的入口就该在清单这一段的标题上。 */}
          {onAddFolder && (
            <button
              type="button"
              className="ink-nav-add"
              aria-label="新建文件夹"
              onClick={() => setAddingFolder(true)}
            >🗀</button>
          )}
        </p>
        {addingFolder && (
          <form
            className="ink-nav-addform"
            onSubmit={(e) => {
              e.preventDefault();
              const name = folderDraft.trim();
              // 空名字直接收起来，不发请求——跟上面「新建清单」同一条。
              if (name) onAddFolder?.(name);
              setFolderDraft('');
              setAddingFolder(false);
            }}
          >
            <input
              className="ink-nav-addinput"
              aria-label="文件夹名字"
              autoFocus
              value={folderDraft}
              onChange={(e) => setFolderDraft(e.target.value)}
              onBlur={() => { setFolderDraft(''); setAddingFolder(false); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setFolderDraft(''); setAddingFolder(false); } }}
            />
          </form>
        )}
        {adding && (
          <form
            className="ink-nav-addform"
            onSubmit={(e) => {
              e.preventDefault();
              const name = draft.trim();
              // 空名字直接收起来，不发请求——服务端会 400，弹一条红横幅说
              // 「名字不能为空」，而用户很可能只是按了个回车想取消。
              if (name) onAddList(name);
              setDraft('');
              setAdding(false);
            }}
          >
            <input
              className="ink-nav-addinput"
              aria-label="清单名字"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => { setDraft(''); setAdding(false); }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(''); setAdding(false); } }}
            />
          </form>
        )}
        {/* 清单按文件夹分组（仿滴答清单）。判据在 lib/listIcon.ts 的
            `groupListsByFolder`——顶层那组排最前、空文件夹也出现、指向已删
            文件夹的清单当顶层，三条都在那边测过。 */}
        {groupListsByFolder(visibleLists, folders).map((g) => (
          <div key={g.folder?.id ?? '顶层'}>
            {g.folder && folderRow(g.folder.id, g.folder.name, folderCount(listNums, g.lists))}
            {/* 收起来了就不渲染那一组——**这才是「侧栏变短」的那一下**。
                顶层那组（`g.folder` 为 null）永远展开：它没有标题行，也就没有
                任何地方能把它放回来。 */}
            {g.lists.length > 0 && !(g.folder && folded.has(g.folder.id)) && (
              <ul className={`ink-nav-list${g.folder ? ' ink-nav-infolder' : ''}`}>
                {g.lists.map((l) => (
                  <li key={l.id}>{listRow(l)}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {/* 已归档的清单（仿滴答清单的「归档」）。**不能藏干净**——藏干净就
            没有任何入口能取消归档，归档就成了一扇单向门。摆在正常清单下面、
            字轻一档，跟 `.ink-nav-tag-group`（自己没有任务的父标签）同一个
            处理：还在，只是别跟真在用的那几份争注意力。 */}
        {archivedLists.length > 0 && (
          <>
            <p className="ink-nav-group ink-nav-group-sub">已归档</p>
            <ul className="ink-nav-list ink-nav-archived">
              {archivedLists.map((l) => (
                <li key={l.id}>{listRow(l)}</li>
              ))}
            </ul>
          </>
        )}

        {tags.length > 0 && (
          <>
            <p className="ink-nav-group">标签</p>
            {/* 二级标签（仿滴答清单）：`#工作/项目A` 在侧栏里缩进挂在「工作」
                下面。层级用命名约定表达、不加标签表，理由见 lib/tagTree.ts。
                父节点自己没有任务时（只有 `#工作/项目A`、没人打过 `#工作`）
                照样点得进去——点父标签连子标签一起看，判据在同一个文件。 */}
            <ul className="ink-nav-list ink-nav-tags">
              {tagTree(tags).map((node) => (
                <li key={node.name}>
                  {tagRow(node)}
                  {node.children.length > 0 && (
                    <ul className="ink-nav-list ink-nav-subtags">
                      {node.children.map((c) => <li key={c.name}>{tagRow(c)}</li>)}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* 情境（GTD）。摆在标签后面——两者都是「横切清单的另一种分法」，但情境
            回答的是一个更窄、更当下的问题（「我现在能干什么」），排在后面不抢清单。

            **只列真有任务的那几档**，跟上面标签那一段同一个规矩（`tags.length > 0`）：
            五行常驻、其中三行永远是 0，只会把侧栏拉长、把真在用的那几行挤下去。一档都
            没人用时整段不渲染——这个字段是可选的，不用它的人不该在侧栏里看到它。

            没有改名/删除那颗 ⋯（标签有）：情境是固定枚举，不是他造出来的东西，改不得也
            删不得。一颗点下去没反应的 ⋯ 比没有那颗更糟。 */}
        {liveContexts.length > 0 && (
          <>
            <p className="ink-nav-group">情境</p>
            {/* **竖排，不是标签那种 wrap 的胶囊**（`.ink-nav-tags`）。两个理由：
                情境是**固定的五档**，不是他随手打出来的一堆自由文本——胶囊那个形状
                说的是「这里可能有很多个、数量不定」；而且点一个情境跟点一份清单是同一件事
                （切到一个去处），它就该跟清单长得一样：满宽一行、计数右对齐。 */}
            <ul className="ink-nav-list">
              {liveContexts.map(({ key, count }) => (
                <li key={key}>
                  <button
                    type="button"
                    className="ink-nav-item"
                    {...(current === `context:${key}` ? { 'aria-current': 'page' as const } : {})}
                    onClick={() => onSelect(`context:${key}`)}
                  >
                    {/* @ 占的是标签那个 # 同一个槽，名字才对得齐。用 @ 不用另造图标：
                        GTD 里情境就写作 @电脑，而卡片上那个记号也是 @——两处同一个字。 */}
                    <span className="ink-nav-slot ink-nav-hash" aria-hidden="true">@</span>
                    {/* 包一层 `.ink-nav-label`（`flex: 1`）——把计数推到最右边的就是它。
                        裸文本节点不是 flex 项，不会撑开，数字就紧跟在名字后面——而旁边
                        视图/清单那几行的数字都贴在右边，一排数字对不齐才是看得出来的那种丑。
                        （这一下是拍图看出来的，单测看不到对齐。） */}
                    <span className="ink-nav-label">{CONTEXT_LABEL[key]}</span>
                    <span className="ink-nav-count">{count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </nav>

      <div className="ink-nav-composer">{composer}</div>
    </>
  );
}

import { getFolded, setFolded, toggleFolded } from '../lib/folderFold.js';