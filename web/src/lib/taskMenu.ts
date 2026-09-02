import type { List, Task } from '../types.js';
import { fileableLists } from './listIcon.js';
import { POSTPONE_MINUTES, postponePatch, reschedulePatch, RESCHEDULE_KEYS, RESCHEDULE_LABEL, type RescheduleTo } from './reschedule.js';
// 从 server 这一侧引「下一次落在哪」——不在 web 抄一份，两份实现会在
// `from: 'done'`、拖过好几个周期、提醒对齐 due 这几条上悄悄漂开。
import { skipPatch } from '../../../server/src/repeat.js';
import { PRI_MENU } from '../components/TaskFields.js';
import { asArray, CONTEXT_LABEL, CONTEXTS } from './taskView.js';

/**
 * 一条任务的「更多操作」菜单——**卡片和紧凑行共用这一份**。
 *
 * 抽出来是因为两边已经分叉到了极点：卡片上那颗 ⋯ 有九样（编辑/置顶/创建副本/
 * 跳过本次/改期/优先级/推迟/移动到/删除），而紧凑行那颗 ⋯ **只有「今天」视图
 * 里的上移下移**——其余五个视图里它照样渲染出来，点下去什么都不发生。这个
 * 仓库到处都在说「一个点了没反应的入口比没有更糟」，而这正是那句话的样子；
 * 换成「行」密度还会静默失去上面那九样里的每一样。
 *
 * **纯函数**：进出都是数据。哪几项能点由数据决定（能不能跳过、有没有清单可
 * 移、有没有时间可推迟），点了之后干什么由 `decodeTaskMenu` 翻译成一个动作，
 * 具体怎么做（发 patch 还是开编辑态还是弹确认框）留给各自的组件——那三件事
 * 在卡片和行里本来就不一样。
 */

export interface TaskMenuOpts {
  lists: List[];
  now: Date;
  /** 不给就不出「创建副本」——它要发请求，调用方没接就不该摆这个入口。 */
  canDuplicate?: boolean;
  /**
   * 调用方处不处理得了 `kind: "skip"`。**默认 false**——摆一项处理不了的菜单
   * 比不摆糟得多，而这里糟到了极点：`TaskRow` 的 handler 只认 edit/patch/duplicate，
   * 其余**一律掉进删除确认框**。于是在「行」密度下点「跳过本次」，弹出来的是
   * 「删除…？」，确认一下任务就进了垃圾箱。实测复现过：菜单里真有这一项，
   * `decodeTaskMenu` 真的返回 `{kind:"skip"}`。
   *
   * 默认关掉而不是「谁都摆」：漏接的后果是丢数据，而漏开的后果只是少一项——
   * 两种失败的代价差得太远。`TaskCard` 显式打开它（它有 `onSkip`）。
   */
  canSkip?: boolean;
  /**
   * 现有标签全集（`allTags(allTasks)`）。空的/不给就不出「打标签」那一组
   * ——一份标签都还没有的时候，那组是个空壳。
   *
   * **只列已有的，不新建。** 打一个从没用过的标签得进编辑表单，那儿有输入框；
   * 菜单项里问不出一段自由文字。这跟「移动到」只列已有清单是同一条。
   */
  tags?: string[];
}

/**
 * antd `MenuProps['items']` 里我们实际用到的那三种形状。**写成联合而不是
 * 一个「什么都可选」的接口**：后者跟 antd 那个可辨识联合的任何一支都对不上
 * （每一支各有自己的必填键），只能靠 `as` 强转过去，而强转会把真的写错了
 * 的那天一起放过去。写成联合就不用转，也顺带说清了这个菜单只会产出哪三种项。
 *
 * 不引 antd 的类型：这个模块是纯的，测试里不该为了断言一个菜单结构去加载
 * 整个组件库。
 */
export type MenuLeaf = { key: string; label: string; disabled?: boolean; danger?: boolean };
export type MenuItem =
  | MenuLeaf
  | { type: 'group'; label: string; children: MenuLeaf[] }
  | { type: 'divider' };

export function taskMenuItems(t: Task, opts: TaskMenuOpts): MenuItem[] {
  const skip = opts.canSkip && t.repeat ? skipPatch(t, opts.now) : null;
  const postpone = postponePatch(t, POSTPONE_MINUTES);
  const movable = fileableLists(opts.lists, t.listId);
  const tags = opts.tags;
  const mine = new Set(asArray<string>(t.tags));
  const has = (name: string) => mine.has(name);

  return [
    { key: 'edit', label: '编辑' },
    // 置顶：一个开关两种文案，不摆两个菜单项——「置顶」和「取消置顶」永远
    // 只有一个是有意义的。
    { key: 'pin', label: t.pinned ? '取消置顶' : '置顶' },
    ...(opts.canDuplicate ? [{ key: 'duplicate', label: '创建副本' }] : []),
    // 跳过本次：只有真跳得动的才摆出来——不重复的、没有 due 的、次数用完的，
    // 点了屏幕上什么都不会变。判据在 server/src/repeat.ts。
    ...(skip ? [{ key: 'skip', label: '跳过本次' }] : []),
    // `type: 'group'`（组标题 + 平铺几项）不是子菜单：子菜单要先悬停展开，
    // 键盘和触摸屏上都多一道，为了省几行高度换一层交互不划算。
    { type: 'group' as const, label: '改期', children: RESCHEDULE_KEYS.map((k) => ({ key: `due:${k}`, label: RESCHEDULE_LABEL[k] })) },
    // 当前那一档/那个清单**禁用着而不是藏起来**：一份少了一项的列表看不出
    // 「少的那项正是它现在的位置」，看起来像那一项不见了。
    { type: 'group' as const, label: '优先级', children: PRI_MENU.map((p) => ({ key: `pri:${p.v}`, label: p.label, disabled: t.priority === p.v })) },
    // 情境（GTD）。**紧跟在优先级后面**——编辑表单、筛选栏、批量操作条上都是
    // 这个先后，四处一致，人才不用在每一处重新找一遍。
    //
    // 在这之前，给一条任务分情境的唯一办法是**开菜单 → 编辑 → 展开折叠块 →
    // 选 → 保存**，五步；而批量操作条上早就有一颗「改情境」，**选一张卡反而
    // 比选五张麻烦**。那句话是「打标签」那一组下面写过的（见下），情境是同一
    // 个形状——而且更急：分情境是 GTD 里 clarify 那一步的动作，一条一条改要
    // 五步的话，这个字段实际上没人会去填。
    //
    // 当前那一档禁用着，不藏起来：`context` 是单值字段，跟「移动到」「优先级」
    // 同一条，不跟「打标签」那条（多值，点当前项等于摘掉）。
    // 「不分情境」排最后、走空后缀的 key，两样都跟「移动到」里那条
    // 「不属于任何清单」一字不差。
    {
      type: 'group' as const,
      label: '情境',
      children: [
        ...CONTEXTS.map((c) => ({ key: `ctx:${c}`, label: CONTEXT_LABEL[c], disabled: t.context === c })),
        { key: 'ctx:', label: '不分情境', disabled: t.context === null },
      ],
    },
    ...(postpone ? [{ key: 'postpone', label: `推迟 ${POSTPONE_MINUTES / 60} 小时` }] : []),
    ...(movable.length ? [{
      type: 'group' as const,
      label: '移动到',
      children: [
        // 清单名原样用，不拆图标：名字开头那个 emoji 本来就是它的图标。
        ...movable.map((l) => ({ key: `list:${l.id}`, label: l.name, disabled: l.id === t.listId })),
        { key: 'list:', label: '不属于任何清单', disabled: t.listId === null },
      ],
    }] : []),
    // 「打标签」（仿滴答清单右键菜单里的标签那一项）。在这之前，给一条任务
    // 补一个标签的唯一办法是**进编辑态 → 展开「重复/优先级/清单/标签」那个
    // 折叠块 → 打字 → 保存**，四步；而批量操作条上早就有一个「加标签」，
    // 选一张卡反而比选五张麻烦。
    //
    // **当前有的那几个不禁用，点一下就是去掉**——跟上面「移动到」的处理正好
    // 相反，因为两者的形状不同：`listId` 是单值，当前那一项点了等于没点，
    // 所以禁用；标签是多值，当前那一项点了是「摘掉它」，是这组里一半的用法。
    // 一个只加不减的入口是单向门（跟专注补记必须配一张删得掉的列表同一条）。
    // 已经打上的前面加一个 `✓`，不然「点一下是加还是减」全靠猜。
    ...(tags && tags.length > 0 ? [{
      type: 'group' as const,
      label: '打标签',
      children: tags.map((name) => ({
        key: `tag:${name}`,
        label: has(name) ? `✓ ${name}` : name,
      })),
    }] : []),
    { type: 'divider' as const },
    { key: 'delete', label: '删除', danger: true },
  ];
}

/**
 * 菜单点了什么。`patch` 那一类直接就是要发的补丁，别的三类（开编辑态、
 * 创建副本、删除）各组件自己接——卡片是就地展开编辑框，行是把请求转出去，
 * 删除两边都要先弹确认框但文案挂在各自的 modal 上。
 */
export type TaskMenuAction =
  | { kind: 'patch'; patch: Partial<Task> }
  | { kind: 'edit' }
  | { kind: 'duplicate' }
  /**
   * 跳过这一次。**不是一个 patch**——它走自己的路由（`POST /api/tasks/:id/skip`），
   * 因为发一个改 due 的 PATCH 会被服务端字段级的推迟计数记成一次拖延，
   * 理由写在那条路由上。`nextDue` 只是给回执用（「跳过了，下次 X」）。
   */
  | { kind: 'skip'; nextDue: string }
  | { kind: 'delete' };

export function decodeTaskMenu(key: string, t: Task, now: Date): TaskMenuAction | null {
  if (key === 'edit') return { kind: 'edit' };
  if (key === 'duplicate') return { kind: 'duplicate' };
  if (key === 'delete') return { kind: 'delete' };
  if (key === 'pin') return { kind: 'patch', patch: { pinned: !t.pinned } };
  if (key === 'skip') {
    const patch = t.repeat ? skipPatch(t, now) : null;
    return patch ? { kind: 'skip', nextDue: patch.due } : null;
  }
  if (key === 'postpone') {
    const patch = postponePatch(t, POSTPONE_MINUTES);
    return patch ? { kind: 'patch', patch } : null;
  }
  if (key.startsWith('due:')) {
    return { kind: 'patch', patch: reschedulePatch(t, key.slice(4) as RescheduleTo, now) };
  }
  // `list:` 后面空的就是「不属于任何清单」——`null` 跟 Task.listId 的语义
  // 一致，不是空字符串。
  if (key.startsWith('list:')) return { kind: 'patch', patch: { listId: key.slice(5) || null } };
  // 开关，不是「加」：已经打上的再点一次就摘掉，见 `taskMenuItems` 里那一组
  // 上面的注释。`slice(4)` 不用 `split(':')` —— 标签名里可以有冒号（`项目:035`）。
  if (key.startsWith('tag:')) {
    const name = key.slice(4);
    const mine = asArray<string>(t.tags);
    return { kind: 'patch', patch: { tags: mine.includes(name) ? mine.filter((x) => x !== name) : [...mine, name] } };
  }
  if (key.startsWith('pri:')) return { kind: 'patch', patch: { priority: Number(key.slice(4)) as 0 | 1 | 2 | 3 } };
  // 空后缀 = 不分情境（`null`，跟 Task.context 的语义一致），跟上面 `list:` 同一个写法。
  if (key.startsWith('ctx:')) return { kind: 'patch', patch: { context: (key.slice(4) || null) as Task['context'] } };
  return null;
}
