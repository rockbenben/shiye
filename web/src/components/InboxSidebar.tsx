import { useState } from 'react';
import { App as AntApp, Button, Collapse, Dropdown, Input, List, Popconfirm, Popover, Space } from 'antd';
import { DownOutlined, EditOutlined, RedoOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { InboxItem } from '../types.js';
import { whenText } from '../lib/dueChip.js';
import { Markdown } from './Markdown.js';

interface Props {
  items: InboxItem[];
  /** 「躺了多久」要拿它比。跟别处一样由调用方注入，不在组件里读时钟。 */
  now: Date;
  onDelete: (id: string) => void;
  /**
   * 「拆得不对，再来一轮」。`note` 是他补的那句要求，空串 = 单纯原样重拆。
   *
   * **不叫 `onReopen` 了**：这颗按钮原来只是把 `processed` 翻回 false，现在还会
   * 把上一轮拆出来的任务搬进垃圾箱（见服务端 `POST /api/inbox/:id/redo`）。
   * 一个会删东西的回调不该顶着「重新打开」这种听着什么都不动的名字。
   */
  onRedo: (id: string, note: string) => void | Promise<void>;
  /**
   * **把这段原话直接变成一条任务**，不劳烦 AI（仿滴答清单：那边收件箱里
   * 躺的本来就是任务）。
   *
   * 补的是一个真实的堵点：随手记下来的东西**大多数本来就已经是一句能做的
   * 事**（「给猫买猫粮」），却只能等 AI 拆一轮才能变成任务——要等、要花配额、
   * 还可能失败，而离线时干脆没有这条路。GTD 的「理清」这一步说的正是：多数
   * 收集来的条目只需要归位，不需要再想。
   *
   * 标题里的日期/标签/重复照样认（跟列表顶上那条「添加任务」同一份
   * `smartDraft`），所以「明天下午三点给猫买猫粮」进来就是带截止时间的一条。
   *
   * `later`：**直接建成搁置**（GTD 的「将来也许」）。不给这条路的话，它得走
   * 「变成任务 → 开卡片 → 搁置」三步，而中间那一下它是真的以「待办」落了盘：
   * 它会先出现在「全部」里、进得了徒教徒法——而他刚刚表达的意思恰恰是「现在不做」。
   */
  onMakeTask: (id: string, opts?: { later?: boolean }) => void;
  /** 编辑态保存专用，不走 guard()——失败时 InboxRow 要自己 await 到，
   * 把编辑框和草稿留着，不能被 guard 悄悄吞掉只弹一条提示。 */
  onEditText: (id: string, text: string) => Promise<unknown>;
  onExpand: () => void;
  expanding: boolean;
}

interface RowProps {
  x: InboxItem;
  now: Date;
  onDelete: (id: string) => void;
  /**
   * 「拆得不对，再来一轮」。`note` 是他补的那句要求，空串 = 单纯原样重拆。
   *
   * **不叫 `onReopen` 了**：这颗按钮原来只是把 `processed` 翻回 false，现在还会
   * 把上一轮拆出来的任务搬进垃圾箱（见服务端 `POST /api/inbox/:id/redo`）。
   * 一个会删东西的回调不该顶着「重新打开」这种听着什么都不动的名字。
   */
  onRedo: (id: string, note: string) => void | Promise<void>;
  /**
   * **把这段原话直接变成一条任务**，不劳烦 AI（仿滴答清单：那边收件箱里
   * 躺的本来就是任务）。
   *
   * 补的是一个真实的堵点：随手记下来的东西**大多数本来就已经是一句能做的
   * 事**（「给猫买猫粮」），却只能等 AI 拆一轮才能变成任务——要等、要花配额、
   * 还可能失败，而离线时干脆没有这条路。GTD 的「理清」这一步说的正是：多数
   * 收集来的条目只需要归位，不需要再想。
   *
   * 标题里的日期/标签/重复照样认（跟列表顶上那条「添加任务」同一份
   * `smartDraft`），所以「明天下午三点给猫买猫粮」进来就是带截止时间的一条。
   *
   * `later`：**直接建成搁置**（GTD 的「将来也许」）。不给这条路的话，它得走
   * 「变成任务 → 开卡片 → 搁置」三步，而中间那一下它是真的以「待办」落了盘：
   * 它会先出现在「全部」里、进得了徒教徒法——而他刚刚表达的意思恰恰是「现在不做」。
   */
  onMakeTask: (id: string, opts?: { later?: boolean }) => void;
  onEditText: (id: string, text: string) => Promise<unknown>;
  /** 编辑器开着的时候通知父组件——AI 拆解跑完把这条的 processed 翻成 true 时，
   * 父组件靠这份状态决定还要不要把它留在「未处理」列表里，见下面 InboxSidebar
   * 里 pending 的过滤条件。 */
  onEditingChange: (id: string, editing: boolean) => void;
}

/**
 * 「重新拆解」那颗，点开是一个能写要求的小气泡。
 *
 * ## 为什么要能写一句话
 *
 * AI 拆一遍不一定就对——拆得太粗、日期理解错了、归错清单，都很常见。原来这颗
 * 按钮只能**原样再拆一遍**，而同一段原话喂给同一个模型，多半还是同一个结果，
 * 于是「不满意」这件事在这个应用里没有出口，只能自己回去改原文。写一句
 * 「拆得太粗，按周分开」再拆，才是真的能收敛到想要的结果——不满意就再来一轮。
 *
 * 那句话由服务端追加到收件箱原文后面（`appendExpandNote`），所以**他自己也
 * 看得见提过什么要求**，这一行下面就列着。
 *
 * ## 为什么用 `Popover` 而不是 `Popconfirm`
 *
 * `Popconfirm` 的内容区是给一句说明用的，塞一个多行输入框进去要连它的按钮一起
 * 重写，等于自己拿 `Popover` 搭一遍。这里直接用后者。
 *
 * 输入框留空照样能点——「原样再拆一遍」是原来就有的行为，不能因为加了这个框
 * 就变成必填。
 */
function RedoButton({ id, onRedo }: { id: string; onRedo: (id: string, note: string) => void | Promise<void> }) {
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async (): Promise<void> => {
    setBusy(true);
    try {
      await onRedo(id, note.trim());
      // 成功了才清空、才收起来。失败的话草稿留着、气泡不关——他刚打的那句要求
      // 没有第二个来源，跟这个文件里编辑原文那处是同一条教训。
      setNote('');
      setOpen(false);
    } catch (e) {
      void message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      trigger={['click']}
      open={open}
      onOpenChange={(v) => { if (!busy) setOpen(v); }}
      title="哪儿拆得不对？"
      content={(
        <div style={{ width: 288 }}>
          <Input.TextArea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder="比如「拆得太粗，按周分开」。留空就是原样再拆一遍。"
            onKeyDown={(e) => {
              // 跟这个应用别处的多行框同一套键位：回车换行，Ctrl+回车提交。
              if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
              e.preventDefault();
              void go();
            }}
          />
          {/* 会动到已有数据，得在点之前说清楚——垃圾箱里捞得回来这半句同样重要，
              不然这颗按钮读起来像是会把上一轮的成果毁掉。 */}
          <div className="ink-hint" style={{ margin: '8px 0' }}>上一轮拆出来的任务会移进垃圾箱，捞得回来。</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="small" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
            {/* color="default"：全站约定，你自己按的按钮一律不用 `type="primary"`
                ——primary 拿的是 colorPrimary，也就是群青，那是留给 AI 产出的颜色
                （见 theme.ts）。这颗虽然是「去叫 AI」，但按下去的人是他，不是 AI
                写出来的东西。variant 才表示分量：这是这个气泡里唯一的确认动作，用 solid。 */}
            <Button size="small" color="default" variant="solid" loading={busy} onClick={() => void go()}>重新拆解</Button>
          </div>
        </div>
      )}
    >
      <Button size="small" type="text" icon={<RedoOutlined />}>重新拆解</Button>
    </Popover>
  );
}

/** 每一条收件箱记录。编辑态独立成一个组件（而不是渲染函数里塞 useState）——
 * List 的 renderItem 每条记录都会调一次，state 必须挂在真正的组件实例上，
 * 不然会撞上「同一个 state 被所有行共用」的 hooks 规则问题。 */
function InboxRow({ x, now, onDelete, onRedo, onMakeTask, onEditText, onEditingChange }: RowProps) {
  const { message } = AntApp.useApp();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(x.text);
    onEditingChange(x.id, true);
  };
  const cancelEdit = () => {
    setDraft(null);
    onEditingChange(x.id, false);
  };
  const save = async () => {
    const text = draft?.trim();
    if (!draft || !text || saving) return;
    setSaving(true);
    try {
      await onEditText(x.id, text);
      setDraft(null);
      onEditingChange(x.id, false);
    } catch (e) {
      // 保存失败就把编辑框留着、草稿原样在——同一条教训，见 TaskBoard 的 save()。
      // 这里最常见的失败原因就是服务端那句「已处理的条目不能改文字」——AI 在
      // 编辑器开着的时候把这条拆解掉了，条目还留在未处理列表里没被挪进已拆解
      // 折叠面板（下面的 onEditingChange 把它按住了），用户点「取消」退出编辑
      // 态之后就能看到这一行变成「重新拆解」，跟提示文字说的下一步对得上。
      void message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <List.Item
      className={x.processed ? 'ink-note-done' : 'ink-note-pending'}
      actions={
        draft !== null
          ? [
              <Button key="s" size="small" type="text" loading={saving} disabled={!draft.trim() || saving} onClick={() => void save()}>保存</Button>,
              <Button key="c" size="small" type="text" disabled={saving} onClick={cancelEdit}>取消</Button>,
            ]
          : [
              // 只有未处理的条目能改文字——已拆解的条目改原文不会重拆，编辑了也没有
              // 意义，服务端那边也这么挡（PATCH /api/inbox/:id）。已处理的条目原来
              // 就有的「重新拆解」按钮还在，翻回未处理之后就能编辑了。
              ...(x.processed
                ? [<RedoButton key="r" id={x.id} onRedo={onRedo} />]
                : [
                  // **排在「编辑」前面**：这一行最常要做的事是「把它归位」，
                  // 不是「改改措辞」。没处理的才有这颗——已经拆过的再变一条
                  // 任务就是凭空多一条重复的。
                  // 主按钮照旧一点就建，快路径一步都没多；▾ 里只挂一条「以后再说」。
                  // **菜单里不再重复一条「现在就做」**：那就是主按钮自己，同一件事摆两个
                  // 入口只会让人怀疑它俩是不是有区别。
                  // **不用 `Dropdown.Button`**：antd 6 已经把它标成弃用（控制台里直接写着
                  // 「下个大版本移除，请用 Space.Compact + Dropdown + Button」）。这里就是它推荐的那个写法。
                  //
                  // `trigger={['click']}` 得显式写：antd 的 Dropdown 默认 hover 触发，而这个应用有
                  // 安卓版（Capacitor）——触屏上根本没有 hover，那颗 ▾ 会变成一颗怎么点都
                  // 没反应的按钮。这个仓库别处的 Dropdown 一律这么写。
                  //
                  // ▾ 那颗是纯图标按钮，必须给 `aria-label`：不给的话它在无障碍树里是一颗
                  // 没名字的按钮，读屏念不出来。
                  <Space.Compact key="t">
                    <Button size="small" type="text" onClick={() => onMakeTask(x.id)}>变成任务</Button>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [{ key: 'later', label: '以后再说（直接搁置）' }],
                        onClick: () => onMakeTask(x.id, { later: true }),
                      }}
                    >
                      <Button size="small" type="text" icon={<DownOutlined />} aria-label="变成任务的其它方式" />
                    </Dropdown>
                  </Space.Compact>,
                  <Button key="e" size="small" type="text" icon={<EditOutlined />} onClick={startEdit}>编辑</Button>,
                ]),
              // 跟任务卡上的删除同一条道理，而且更重：任务删了还能重建、AI 还能
              // 重拆，收件箱里这段**你手打的原话**没有第二个来源，`.bak` 只留最近
              // 一次写入、下一次任何改动就冲掉。之前只给任务卡加了确认，这半边漏了。
              <Popconfirm
                key="d"
                title="删了就找不回来了"
                description={x.processed ? '拆出来的任务不受影响，只是这段原话没了。' : '这段原话没有别的地方存着。'}
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => onDelete(x.id)}
              >
                <Button size="small" type="text" danger>删除</Button>
              </Popconfirm>,
            ]
      }
    >
      {draft !== null ? (
        <Input.TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoSize={{ minRows: 1, maxRows: 6 }}
          autoFocus
          onKeyDown={(e) => {
            // 跟收件箱输入框同一套键位：回车换行，Ctrl+回车保存。
            if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            void save();
          }}
        />
      ) : (
        <div>
          {/* **按 markdown 渲染，不是纯文本。** 随手记是「想到什么写什么」的
              入口，粘一段带 `-` 的清单、一个链接、一段引用进来是常事——渲染
              之前它们原样躺在那儿，一条清单读起来是一坨。跟备注那边同一个
              组件、同一套样式（`.ink-notes-md`），不另开一份。
              **原话没有被改写**：`x.text` 一个字都没动，改的只是怎么画它；
              AI 拆解读的也仍然是这个原始字符串。 */}
          <div className="ink-note-text"><Markdown source={x.text} inherit /></div>
          <div className="ink-note-meta">
            {/* 已拆解的报「拆出了几条」——那是这条记录的产出，有信息量。
                还没拆的什么都不用报：它就在「待拆解」那一节里，小标题连计数
                都写着了，每条再挂一个「待拆解」是同屏第三遍。原来那个标记还
                用的是过期橙——「还没拆」是新笔记的正常状态，不是警报，
                把警报色花在这上面，看板上真过期的时候橙色就不说明问题了。 */}
            {x.processed && (
              // taskIds 缺失时兜底成空数组：跟 App.tsx reload() 里同一条教训，
              // GET /api/inbox 不校验文件写入的数据。
              <span>已拆 {(x.taskIds ?? []).length} 条</span>
            )}
            {/* 相对说法（「今天 08:12」「8月21日 09:00」），不是绝对时刻。
                这个数字回答的是**「它在这儿躺多久了」**——你正要决定先拆哪条，
                而「2026-08-24 08:12」得先在脑子里跟今天减一次才回答得了。
                跟卡片上的「截止/提醒」同一份文案（`lib/dueChip.ts` 的
                `whenText`）。专注记录那边继续用绝对时刻：那是一条条日志，
                问的正是「具体哪一刻」。 */}
            <span>{whenText(x.createdAt, now)}</span>
          </div>
        </div>
      )}
    </List.Item>
  );
}

export function InboxSidebar({ items, now, onDelete, onRedo, onMakeTask, onEditText, onExpand, expanding }: Props) {
  // 编辑器开着的条目 id——哪怕 AI 把它拆解掉（processed 变 true），也要继续
  // 摆在「未处理」列表里，不能被挪进已拆解折叠面板。折叠面板是另一个 List
  // 实例，挪过去等于组件被卸载重建，正在编辑的草稿会跟着无声消失（自动展开
  // 60 秒倒计时一响就能撞上：开着编辑器改错别字，倒计时先跑完了）。
  const [editingIds, setEditingIds] = useState<Set<string>>(new Set());
  const setEditing = (id: string, editing: boolean) =>
    setEditingIds((prev) => {
      const next = new Set(prev);
      if (editing) next.add(id);
      else next.delete(id);
      return next;
    });

  /**
   * **按写下的先后排，先写的在上面。**
   *
   * 在这之前两份列表都不排序，而 `GET /api/inbox` 给的是服务端读目录的顺序
   * （`readdirSync().sort()`，文件名是 uuid）——也就是**随机**。连着记三条，
   * 它们出现的先后跟你写的先后没有关系。
   *
   * 用升序不用降序：这是一条**要从头处理的队列**（「拆收件箱」就是把还没处理
   * 的从头过一遍），等得最久的该排最前，而且跟「按来源」那个视图的组顺序一致
   * （`taskView.ts` 的 `groupBySource` 同样按 `createdAt` 升序）。垃圾箱和回顾
   * 那两处是倒序的，但它们回答的是「刚刚发生了什么」，不是同一类。
   *
   * 解析不了的时间落 0（排最前）——`data/inbox/` 是手改得到的文件，跟这个
   * 仓库到处那条兜底同一个理由，不因为一条坏数据把整份列表的顺序打乱。
   */
  const byWritten = (a: InboxItem, b: InboxItem) =>
    (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);

  const unprocessedCount = items.filter((x) => !x.processed).length;
  const pending = items.filter((x) => !x.processed || editingIds.has(x.id)).sort(byWritten);
  const done = items.filter((x) => x.processed && !editingIds.has(x.id)).sort(byWritten);

  const row = (x: InboxItem) => (
    <InboxRow x={x} now={now} onDelete={onDelete} onRedo={onRedo} onMakeTask={onMakeTask} onEditText={onEditText} onEditingChange={setEditing} />
  );

  return (
    <div className="ink-sidebar">
      <div className="ink-pending-head">
        <span className="ink-section-label">
          待拆解
          {/* 数的是真正未处理的条目——编辑器开着而临时留在这份列表里的那条
              不算，不然数字会比实际待处理的多一个，误导用户。这个数字是你自己
              笔记的计数，不是 AI 产出，所以不用群青，走跟标签一样的灰。 */}
          {unprocessedCount > 0 && ` · ${unprocessedCount}`}
        </span>
        {/* unprocessedCount === 0 时禁用——待拆解是 0 条，点这个按钮什么也不会
            发生（服务端会走 'skipped' 那条路径，安全但没意义），按钮却还是
            醒目可点的黑字，看着像能做点什么。见 2026-08-12-ux-audit.md
            「待拆解为 0 时立即拆解仍然醒目」。 */}
        <Button size="small" icon={<ThunderboltOutlined />} loading={expanding} disabled={expanding || unprocessedCount === 0} onClick={onExpand}>
          立即拆解
        </Button>
      </div>
      {/* 92 秒不算短，没这行提示用户会以为卡死了——只在跑的时候显示，不常驻占地方。 */}
      {expanding && <span className="ink-hint">AI 正在拆解，一般要一两分钟……</span>}

      {pending.length === 0 ? (
        // 一行安静的字，不是 antd 自带的 Empty 插画——见 theme.css 里
        // .ink-empty-note 的注释。跟上面「待拆解」小标题、头部「收件箱 N 条
        // 待拆解」用同一个词，不再说成「没有等着拆的」，见规格「同一个概念
        // 三种说法」。
        <p className="ink-empty-note">没有待拆解的</p>
      ) : (
        <List className="ink-note-list" size="small" dataSource={pending} renderItem={row} rowKey="id" />
      )}

      {done.length > 0 && (
        // 已拆过的收起但**能翻**——拆完的原文是核对 AI 有没有拆歪的唯一线索，
        // 只给一行计数等于把它藏死了。
        <Collapse
          ghost
          size="small"
          className="ink-done-collapse"
          items={[{
            key: 'done',
            label: `已拆解 ${done.length} 条`,
            children: <List className="ink-note-list" size="small" dataSource={done} renderItem={row} rowKey="id" />,
          }]}
        />
      )}
    </div>
  );
}
