import { useState, type DragEvent, type DragEventHandler } from 'react';
import { App as AntApp } from 'antd';
import { api } from '../api.js';
import { isImageName, pastedName } from '../lib/attachName.js';

export interface AttachmentsProps {
  taskId: string;
  /**
   * 当前这条任务的附件文件名列表，来自 `Task.attachments`。**这个组件不自己
   * 拉列表，上传/删除成功之后也不在本地拼接新数组**——跟这个仓库其余写操作
   * 同一条规矩（App.tsx `guard()` 上面那句注释）：写进文件 → watcher → SSE →
   * reload，父组件（Task 4 接线）重渲染时这个 prop 自然带来新值。`deleting`
   * 才是这个组件自己的本地状态，那是「正在做」的暂态反馈，不是数据源——
   * 真正的清单永远读这个 prop。
   */
  attachments: string[];
  /** 是不是有文件正拖在（卡片任意位置的）拖放目标上——来自 `useFileDrop`，
   *  这个组件自己不持有这份状态，见 `useFileDrop` 的注释。 */
  over: boolean;
  /** 是不是正在上传——同上，来自 `useFileDrop`。 */
  uploading: boolean;
  /** 点击/键盘选择文件之后要调它——`<input type=file>` 这条拾取路径不属于
   *  拖放，但落盘逻辑（排队逐个传、上传中忽略新的）跟拖放共用同一份，都在
   *  `useFileDrop` 里，这个组件只管转发。收的是**一批**：那个 input 挂了
   *  `multiple`，选了几个就原样交过去。 */
  onUpload: (...files: File[]) => void;
  /**
   * 离线记号（task-3-brief）：`api.attachmentUrl` 直接拼出服务端文件系统
   * 里的下载地址（`data/attachments/`，Task 2 明确不做附件离线），本机连
   * 不上服务端时那是一个点了报错的死链接。这个 prop 为真时，「打开」换成
   * 一句不可点的提示文字——不是把整个列表藏起来（文件名/删除按钮照常显示，
   * 用户仍然知道这条任务有哪些附件，只是看不了内容），也不是留一个能点但
   * 点了什么都不会发生的假链接。**可选，默认 `false`**——跟 `TaskCard.tsx`
   * `CardProps.focusMinutes` 同一个理由，不想为了这个后补的 prop 去改遍
   * 现有测试。
   */
  offline?: boolean;
}

/**
 * 判据：`dataTransfer.types` 含 `'Files'` 才是从操作系统拖进来的文件；卡片
 * 拖拽（`TaskGrid` 的格子拖放、`TodayView` 的排序、`CalendarGrid` 的改期）
 * 一律走 `setData('text/plain', taskId)`，`types` 里只有 `'text/plain'`，
 * 不含 `'Files'`。
 *
 * 两种必须分得开：卡片拖拽经过这里时，它的 `dataTransfer` 里没有真的文件
 * （`e.dataTransfer.files` 是空 `FileList`），就算漏了这道判断，也不会真的
 * 拿着任务 id 当文件内容发出一次上传——但拖放高亮会跟着误亮，用户会以为
 * 「这里能放」，松手才发现什么都没发生。这道判断因此不只是防误传，也是
 * 防误导；Attachments.test.tsx 的诱饵测试证明了这一点：那条测试故意在
 * `types: ['text/plain']` 的 dataTransfer 里也塞一个真的 `File`（真实的卡片
 * 拖拽不会有，纯粹是为了让「删掉这道判断」的变异不会因为「反正也没有文件」
 * 而蒙混过关）。
 */
const isFileDrag = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files');

/**
 * 拖放区扩到了整张卡（final-review.md「专项判定」）——不再只有 `Attachments`
 * 自己那一小块才能接文件。**状态只有一份、一个 owner**：`over`/`uploading`/
 * `upload()` 从 `Attachments` 组件里搬出来，`TaskCard` 调一次这个 hook，把
 * `dropProps` 摊在 `Card` 节点上；`Attachments` 退化成纯展示 + `<input
 * type=file>` 那条拾取路径，`over`/`uploading` 改成从这里传下去的 props。
 *
 * **跟三套已有拖拽（TaskGrid 的格子拖放、TodayView 的排序、CalendarGrid 的
 * 改期）怎么不打架**：判据还是 `isFileDrag`，只是挂载点从 `.ink-attach-box`
 * 换成了整张 `Card`——卡片拖拽一律 `setData('text/plain', …)`，`types` 里
 * 没有 `'Files'`，两个 handler 第一行就 `return`，不 `preventDefault`、不
 * `stopPropagation`，事件原样冒泡到 `TaskGrid`/`TodayView`/`CalendarGrid`
 * 各自的祖先节点，跟没接这个 hook 之前逐字节相同。反过来，真的文件拖拽会
 * `stopPropagation`，不再冒泡到那三套——比以前更干净（以前 `onDragOver` 没
 * `stopPropagation`，看板上拖文件经过卡片时 `TaskGrid` 的 section 也会跟着
 * `preventDefault` 一遍）。
 */
export function useFileDrop(taskId: string) {
  const { message } = AntApp.useApp();
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);

  /**
   * 传一个或几个。**排队逐个 `await`，绝不并发**——服务端那条路由是「读全部
   * 任务 → 改这一条的 attachments → 整份写回」（app.ts），同一条任务没有写锁，
   * 并发发起的两个 POST 会互相覆盖，先回来的那个附件消失。顺带还有一个好处：
   * 队列顺序就是他拖进来的顺序，列表里也是那个顺序。
   *
   * **一个失败不挡后面的。** 拖五个进来、第二个超了大小限制，中断的话后面三个
   * 好文件也一起没了，而他看到的只是一句错误——分不清是全没传还是传了几个。
   * 逐个收着，最后一次说清哪几个没成。
   *
   * ponytail: 没有进度条（只有一句「上传中…」）。真要的话在这儿数 done/total
   * 往上抛，`uploading` 从布尔换成计数——三张截图一秒就完了，先不换。
   */
  const upload = async (...files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    const failed: string[] = [];
    try {
      for (const file of files) {
        try {
          await api.uploadAttachment(taskId, file);
        } catch (e) {
          failed.push(`${file.name}（${(e as Error).message}）`);
        }
      }
    } finally {
      setUploading(false);
    }
    // 一个都没成的时候不多说「其余的传上去了」——那句话是假的。
    if (failed.length > 0) void message.error(`没传上去：${failed.join('、')}`);
  };

  const onDragOver: DragEventHandler<HTMLElement> = (e) => {
    if (!isFileDrag(e)) return; // 卡片拖拽：不 preventDefault，浏览器默认不允许放置，也不高亮
    e.preventDefault();
    e.stopPropagation();
    setOver(true);
  };

  const onDrop: DragEventHandler<HTMLElement> = (e) => {
    if (!isFileDrag(e)) return; // 上限断言：卡片拖拽经过这里什么都不做，见 isFileDrag 的注释
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    if (uploading) return; // 上传中忽略新的拖放，跟下面 input 的 disabled 是同一条判断
    // 拖进来几个就传几个（仿滴答清单：它一次能拖一批）。**排队逐个传**，
    // 理由在 `upload` 上面那段——这正是那条注释里写的升级路径，不是并发。
    void upload(...Array.from(e.dataTransfer.files));
  };

  /**
   * 粘贴上传（仿滴答清单）。**截图是待办应用里最常见的附件**，而在这之前
   * 唯一的路是「先存成文件、再拖进来或者点选」——Ctrl+V 直接贴上去省掉的
   * 正是中间那两步。
   *
   * **只接图片，不接剪贴板里的文件**：在输入框里 Ctrl+V 的正常语义是粘贴
   * 文字，把「剪贴板里恰好有个文件」也变成上传，会让复制一段带附件的内容
   * 之后的每一次粘贴都莫名其妙多出一个附件。图片没有这个歧义——剪贴板里
   * 是一张图的时候，人想粘的就是它。
   *
   * 有图片才 `preventDefault`：粘文字那条路一个字都不能挡。
   */
  const onPaste = (e: { clipboardData: DataTransfer | null; preventDefault: () => void }) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    e.preventDefault();
    if (uploading) return;   // 跟拖放同一条：上传中忽略新的
    // 剪贴板里的截图通常没有名字（或者十张都叫 image.png），自己造一个带
    // 时间戳的——判据在 lib/attachName.ts。**每张各造各的**：同一毫秒内取
    // 两次时间戳会撞名，`pastedName` 里那个序号参数就是为这个留的。
    const at = new Date();
    void upload(...files.map((f, i) => new File([f], pastedName(f, at, i), { type: f.type })));
  };

  return {
    over,
    uploading,
    upload,
    dropProps: { onDragOver, onDragLeave: () => setOver(false), onDrop, onPaste },
  };
}

/**
 * 附件列表 + 文件选择（规格第六节最后一项）。**拖放本身不属于这个组件**——
 * 挂在整张卡上，见 `useFileDrop`；这里只管展示 `over`/`uploading` 这两个状态
 * 和 `<input type=file>` 那条键盘/读屏可达的拾取路径。**标准是否显示外层
 * 「附件」标题、要不要在编辑态出现，是 Task 4 接进卡片时的事**——这个组件
 * 自己没有这些概念，永远渲染，`attachments` 非空时才多渲染一份列表。
 */
export function Attachments({ taskId, attachments, over, uploading, onUpload, offline = false }: AttachmentsProps) {
  const { modal, message } = AntApp.useApp();
  // 用 Set 而不是单个 string：两个不同的附件各自点了删除、两次请求同时在飞，
  // 单个 string 状态会被后点的那次覆盖，先点的那个按钮会在自己的请求还没
  // 回来之前提前解禁。
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  // 群青盲区排查：Modal.confirm 的 OK 按钮默认 type="primary"，理论上是
  // Checkbox/DatePicker 那个已知盲区的同类——先查过再确定用不用
  // `boardLocalTheme`，不是凭读代码猜。`okButtonProps: { danger: true }`
  // 这颗按钮的背景色链路是 `--ant-btn-bg-color` → `--ant-btn-solid-bg-color`
  // → `--ant-btn-color-base` → `--ant-color-error`，实测（渲染出来读
  // getComputedStyle）从头到尾没有一步碰到 `--ant-color-primary`——那个
  // token 确实会以 CSS 自定义属性的形式出现在这颗按钮所在的 `.css-var-*`
  // 作用域里（antd 6 的 css-var 模式把整套 token 一次性挂上去，不管这颗
  // 按钮用不用得到），但没有任何实际渲染路径读到它，跟 Checkbox/DatePicker
  // 的选中态直接读 colorPrimary 派生值不是同一类问题。加一层
  // `boardLocalTheme` 压不出任何可观察的差异，纯属往这个已经通过验证的组件
  // 上贴一个不解决任何问题的补丁，所以这里没有套。
  const confirmDelete = (name: string) => {
    modal.confirm({
      title: '删除这个附件？',
      // 附件删除没有垃圾箱兜底——`removeAttachment`（server/src/attachments.ts）
      // 直接 unlink，不是软删除。文案照 TrashView「彻底删除」那句的说法
      // （「找不回来了」），不借 TaskCard「会先进垃圾箱」那句——那句在这里
      // 是假的承诺。
      content: '删掉就找不回来了，附件没有垃圾箱可以还原。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setDeleting((prev) => new Set(prev).add(name));
        try {
          await api.deleteAttachment(taskId, name);
        } catch (e) {
          void message.error((e as Error).message);
        } finally {
          setDeleting((prev) => {
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        }
      },
    });
  };

  return (
    <div className={`ink-attach-box${over ? ' ink-attach-box-over' : ''}`}>
      {/* <label> 包一个视觉隐藏的 <input type="file">：点击/键盘 Enter 都能唤起
          原生的文件选择框，不用另外写一套「选择文件」的自定义控件——拖放是
          鼠标专属的手势，纯键盘/屏幕阅读器用户得靠这条路径才摸得到这个功能。
          复用 .ink-sr-only（视觉隐藏但保留在可访问树里），不新起一个裁剪类。 */}
      <label className="ink-attach-zone">
        <input
          type="file"
          className="ink-sr-only"
          multiple
          aria-label="选择要上传的附件"
          disabled={uploading}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = ''; // 选同一个文件两次也要能再触发一次 change
            if (files.length > 0) onUpload(...files);
          }}
        />
        {uploading ? '上传中…' : '拖文件到这里，或点击选择'}
      </label>

      {attachments.length > 0 && (
        <ul className="ink-attach-list">
          {attachments.map((name) => (
            <li className="ink-attach-item" key={name}>
              {/* 图片直接画出来（仿滴答清单）。**文件名照旧留着**：缩略图加载
                  不出来（文件被别的东西删了、格式坏了）时那一行还认得出是什么，
                  而不是只剩一个碎图标。`loading="lazy"` 让一条挂着二十张截图
                  的任务不在渲染那一刻同时发二十个请求。
                  离线时不画：`attachmentUrl` 是服务端的地址，那会儿它是个死
                  链接——右边那句「要连上服务才能看」已经说了这件事。 */}
              {!offline && isImageName(name) && (
                <a className="ink-attach-thumb" href={api.attachmentUrl(taskId, name)}>
                  <img src={api.attachmentUrl(taskId, name)} alt={name} loading="lazy" />
                </a>
              )}
              <span className="ink-attach-name">{name}</span>
              {offline ? (
                <span className="ink-attach-offline">要连上服务才能看</span>
              ) : (
                <a className="ink-attach-open" href={api.attachmentUrl(taskId, name)}>打开</a>
              )}
              <button
                type="button"
                className="ink-attach-delete"
                disabled={deleting.has(name)}
                onClick={() => confirmDelete(name)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
