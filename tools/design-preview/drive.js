/*
 * 两张稿子共用的那套机器：`batch1.html`（现状审计）和 `batch2.html`（版式对比）
 * 都要「开一格真 app → 驱动到某一屏 → 等它画定 → 量一遍」，一个字都不能各写一份。
 *
 * 为什么抽出来：batch2 的每一条对比要把**同一格开两遍**（左边把这一条改动退回去，
 * 右边是现状），启动与驱动那一段跟 batch1 逐字相同。两处各抄一份的话，改一处漏
 * 一处——而漏掉的那处会安静地量到没画完的帧（`settle` 和墙钟截止那两段就是这么
 * 栽出来的），报出来的数看着像界面的问题。
 *
 * 这个文件按普通脚本加载（`<script src="./drive.js">`），两头都用全局名，
 * 跟 `probe.js` 同一个形状——稿子没有构建步骤，不该为它引入模块。
 */

/** 「连不上」用的那个地址：本机没人听的端口。不是 `http://localhost` 那种
 *  会解析到别的东西的写法——要的是**网络层立刻失败**，跟真的服务没起来同一效果。 */
const DEAD_API = 'http://127.0.0.1:39999';
/**
 * `@capacitor/preferences` 在 web 上不是裸键：它给每个键加前缀
 * `CapacitorStorage.`（实测：本地快照落在 `CapacitorStorage.local:tasks`）。
 * 所以这里两个都写——只写 `apiBase` 的话应用读不到，那一格跑出来是**在线**的
 * 看板而稿子以为在量离线那一面（第一版就这么绿了过去：离线横幅根本没出现，
 * 节点数跟在线那一格一模一样）。
 */
const PREF_PREFIX = 'CapacitorStorage.';

/**
 * 先操作一下才出现的那些屏。**每一步都走真控件**（点那颗按钮、按那个键），
 * 不去调内部函数——否则量到的是「我以为它会变成那样」，不是它真的会变成那样。
 * 键事件打在 iframe 的 window 上：应用的全局监听就挂在那儿，跟真键盘同一条路。
 */
const DRIVE = {
  settings: async (f, c) => {
    f.contentDocument.querySelector('[aria-label="设置"]').click();
    await inFrame(f, '.ant-modal');
    // 量的是**哪一节**由格子自己说（`section`），默认还是 AI 那一节。设置一共十页、
    // 每页一套控件，原来这一条 drive 写死一节，其余九页一次都没进过表——
    // 「设置屏干净」这个读数当时其实是「AI 那一页干净」。
    const want = c?.section || 'AI 拆解';
    const tab = [...f.contentDocument.querySelectorAll('[role=tab]')].find((e) => e.textContent.trim() === want);
    if (!tab) throw new Error(`设置里没有「${want}」这一节`);
    tab.click();
    /**
     * 「怎么叫 AI」那一颗决定这一节**剩下的是什么**：`api` 才是厂商那一排 chip 加
     * 地址/模型/密钥三格，`cli` 是命令行工具那几个单选。夹具默认写的是 `cli`，
     * 于是「设置 · AI 那一节」这一格一直量的是 cli 那一面——改过的 API 那一面
     * 从来没进过表。格子用 `{ mode: 'api' }` 点名要哪一面。
     *
     * 点里面那颗 `input`（不是外面那层 label）：antd 的按钮式单选把 input 藏成了
     * 0 透明，程序化点 label 要靠浏览器的转发行为，点 input 没有这一层不确定性。
     */
    if (c?.mode) {
      const wantLabel = c.mode === 'api' ? '调接口' : '本机命令行';
      const findMode = () => {
        const w = [...f.contentDocument.querySelectorAll('.ant-modal .ant-radio-button-wrapper')]
          .find((e) => e.textContent.trim() === wantLabel);
        return w && w.querySelector('input');
      };
      await waitFor(f, () => findMode(), `「${wantLabel}」那颗`);
      findMode().click();
    }
    /**
     * 格子可以要求再点一下「更多厂商」（`{ more: true }`），把收起来的那一层也量到
     * ——那三十多枚 chip 和那颗高级开关都在那一层里，不展开就永远进不了表。
     *
     * 按文字找、不按 class：那颗是 `<button>`，文字里带一个跟着目录变的数。
     * 等它出现再点：上面那些 click 之后 React 还没重画，立刻查会撞到旧的那一屏。
     */
    if (c?.more) {
      const findBtn = () => [...f.contentDocument.querySelectorAll('.ant-modal button')]
        .find((b) => /更多厂商/.test(b.textContent));
      await waitFor(f, () => findBtn(), '「更多厂商」那颗');
      findBtn().click();
    }
  },
  palette: async (f) => {
    f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    await inFrame(f, '.ant-modal');
  },
  help: async (f) => {
    f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
    await inFrame(f, '.ink-shortcut-table');
  },
  searchEmpty: async (f) => {
    f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    const box = await inFrame(f, 'input[placeholder*="搜索"], .ant-modal input');
    const set = f.contentWindow.Object.getOwnPropertyDescriptor(f.contentWindow.HTMLInputElement.prototype, 'value').set;
    set.call(box, 'zzz这条压根不存在zzz');
    box.dispatchEvent(new f.contentWindow.Event('input', { bubbles: true }));
    /**
     * **等到「搜不到」那句话真的在屏上才算这一格到位。** 那个 `<p>` 在两种
     * 情况下都是同一个节点（还没打字时是「打字就开始找」），节点数一模一样，
     * `settle` 分不出来——不等到这一句，量的是「还没搜」那一面，而格子上写着
     * 「搜索空态」。文案这一族本来就靠读文字判，这里先把它读回来。
     */
    await waitFor(f, (x) => (x.contentDocument.querySelector('.ink-searchmodal-empty')?.textContent || '').includes('没有匹配'),
      '「没有匹配的任务」', 8000);
  },
  editForm: async (f) => {
    const card = f.contentDocument.querySelector('.ink-task-card .ant-typography');
    card.dispatchEvent(new f.contentWindow.MouseEvent('dblclick', { bubbles: true }));
    await inFrame(f, 'input[placeholder="标题"]');
  },
  compose: async (f) => {
    f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    await inFrame(f, 'input[placeholder*="标题"], .ant-modal input');
  },
  drawer: async (f) => {
    // 那颗按钮自己写着「打开清单侧栏」（App.tsx），不是「导航」也不是「菜单」——
    // 原来那三个候选一个都没命中，这一格报「量不到：没找到开抽屉那颗」。
    // 按名字找，不按 class：class 是样式的事，名字才是这个动作在屏幕上的名字。
    const b = f.contentDocument.querySelector('[aria-label="打开清单侧栏"]');
    if (!b) throw new Error('没找到开抽屉那颗');
    b.click();
    await inFrame(f, '.ant-drawer-open');
  },
  /**
   * 「AI 拆解失败」那条横幅。
   *
   * 这一面**就是夹具的默认档**（见 tools/preview-fixture.mjs：设置里的
   * 「命令行工具路径」默认指向一个不存在的二进制）。这一格只做两件真事：
   * 打一次「立即拆解」那条路由，然后等屏幕上那条红色横幅出现——失败是服务
   * 自己 spawn 失败发出来的，不是稿子编出来的状态。
   *
   * 不在这儿改设置：`GET /api/settings` 回的是**打码后**的 `aiKey`，拿它再 PUT
   * 回去等于把那台设备的密钥换成一行星号。夹具这份本来就是空的，但那扇门
   * 不该被稿子推开一次。
   */
  agentFail: async (f) => {
    const r = await f.contentWindow.fetch('/api/expand', { method: 'POST' });
    if (!r.ok) throw new Error(`POST /api/expand：${r.status} ${(await r.text()).slice(0, 60)}`);
    // 30 秒：失败本身是立刻的（认不出那个二进制），但要等 SSE 那一跳把状态推回这一格。
    await inFrame(f, '.ant-alert-error', 30000);
  },
  /**
   * 总览那条**多行**汇报（要夹具服务带 `--agent-stub` 起来，见 tools/preview-agent-stub.mjs）。
   * 服务照常 spawn、照常取走 `.board-report.md`、照常发 agent-status——这一格
   * 量的是一次真运行的产物，不是稿子编的状态。
   */
  boardOk: async (f) => {
    const r = await f.contentWindow.fetch('/api/board', { method: 'POST' });
    if (!r.ok) throw new Error(`POST /api/board：${r.status} ${(await r.text()).slice(0, 60)}`);
    await inFrame(f, '.ant-alert-success', 30000);
  },
  /**
   * 导入被服务端拒掉的那句回执。全程真实通路：喂一份**客户端放得过、服务端会拒**
   * 的 JSON（状态写成「进行中」——看板只认那五个英文值），确认框点「替换」，
   * 等那条红色的原话上屏。
   *
   * 文件是**在页面里造出来的**（`new File` + `DataTransfer` 挂到 `input.files`），
   * 不用 MCP 的上传工具：那条只能作用在被选中的页面上，而这十幾格都在同一张稿子里。
   */
  importReject: async (f) => {
    await DRIVE.settings(f, { section: '数据与服务' });
    const w = f.contentWindow;
    const d = f.contentDocument;
    const task = (id, over) => ({
      id, title: `导入探针 ${id}`, notes: '', status: 'todo', due: null, startAt: null, endAt: null,
      persistentReminder: false, reminders: [], subtasks: [], source: 'user', aiComment: '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), order: null,
      listId: null, section: null, tags: [], priority: 0, repeat: null, completedAt: null,
      postponeCount: 0, waitingFor: null, context: null, attachments: [], focusSessions: [],
      estimateMinutes: null, habit: false, pinned: false, reviewedAt: null, parentId: null, ...over,
    });
    const body = {
      inbox: [], proposals: [], lists: [], folders: [], countdowns: [], insights: [], trash: [],
      settings: { webhookUrl: '', toastEnabled: false, autoExpand: false, autoExpandDelaySec: 60, focusMinutes: 25, breakMinutes: 5, dailySummaryAt: null, dailySummaryOn: null, defaultListId: null, defaultPriority: 0, defaultDue: 'none', defaultRemindMinutes: null, defaultTags: [], weekStart: 1, smartDate: true, smartStripDate: true, smartTag: true, smartStripTag: true, showLunar: true, showHolidays: true, aiMode: 'cli', aiCli: 'claude', aiCliPath: '', aiCliCustomArgs: '', aiBaseUrl: '', aiKey: '', aiModel: '' },
      // 这一条就是会被拒的那一条：`进行中` 不是那五个合法值之一。
      tasks: [task('dp-probe-1', { status: '进行中' })],
    };
    const file = new w.File([JSON.stringify(body)], '坏数据.json', { type: 'application/json' });
    const dt = new w.DataTransfer();
    dt.items.add(file);
    const input = d.querySelector('input[type="file"]');
    if (!input) throw new Error('没有那个隐藏的导入 input');
    input.files = dt.files;
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    // 确认框出来之后点「替换」——不点这一下，那句 400 永远不会发生。
    // **别等 `.ant-modal-confirm`**：antd v6 这条确认框的根节点上根本没有那个
    // class（实测：它是第二份 `.ant-modal`，标题「导入这份备份」，里面三句警告
    // 加「取消 / 替换」两颗按钮）。按**那颗按钮**等，比按容器名猜稳。
    const findReplace = () => [...d.querySelectorAll('.ant-modal button')]
      .find((b) => b.textContent.replace(/\s+/g, '') === '替换');
    await waitFor(f, findReplace, '导入确认框');
    findReplace().click();
    await inFrame(f, '.ant-message-error', 25000);
  },
  /**
   * 进批量态：带 Ctrl 点一行标题（这跟按 Ctrl/⌘+点是同一条码路，见 TaskRow 的
   * `onTitleClick`），勾选框那一批才会现身，再点第二行的勾选框。
   * 底部那条 `批量操作` 工具栏就是这么出现的——它不在「导航过去就有」那一类里。
   */
  select2: async (f) => {
    const d = f.contentDocument;
    const row = d.querySelector('.ink-trow-open');
    if (!row) throw new Error('这一屏没有行档的标题按钮');
    row.dispatchEvent(new f.contentWindow.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await inFrame(f, '.ink-trow-select');
    const boxes = d.querySelectorAll('.ink-trow-select');
    if (boxes.length < 2) throw new Error(`只现出 ${boxes.length} 颗勾选框`);
    boxes[1].click();
    await inFrame(f, '.ink-batch-bar');
  },
  /**
   * 搜索弹层里**有结果**那一态（跟 `searchEmpty` 是两面）。
   *
   * 搜什么**从屏幕上现取**，而且要挑命中面最广的那个词。第一版钉了一个夹具里
   * 的词（换一批数据就「弹层里什么都没有」，报出来像搜索坏了）；第二版拿第一行
   * 标题的前两字——不坏了，但**只命中一条**。只命中一条的话这一格量的是「一条
   * 结果长什么样」，而这一面真正会挤的是一**列**结果：状态角标、清单名、截止
   * chip 各占一段，超过八条还有那句「还有 N 条，看全部结果」。这三样一条结果
   * 都摆不出来，报「干净」是量错了面。
   *
   * 候选词的来路：屏幕上可见标题里**装着最多行标题的单字汉字**（搜的是标题/
   * 备注/标签/子任务四样，一个常见汉字能一下命中一撮；这一屏量出来「的」命中
   * 八条，正好把列表摊满）。两种试过不行的：钉死一个词（换一批数据就「弹层里
   * 什么都没有」，报出来像搜索坏了）、汉字二字组（屏幕上每个二字组只属于一行
   * 标题，试到第五组还是一条命中）。最后拿第一行标题的前两字兜底。命中够摊满
   * 一列（八条）就停，不把所有候选试完。
   *
   * **超过八条时那句「还有 N 条」这一格摆不出来**，不是漏了：夹具里最宽的那个
   * 汉字（「的」）命中正好八条，比它宽的候选没有（挨个数过：第二名「把」六条）。
   * 那一行由 `SearchModal.test.tsx` 里「最多列八条，截断了要说出来」那条盯着。
   *
   * 搜索结果集是同步算的（`searchTasks` 没有防抖），要等的只是 React 把这一帧
   * 画出来——用 `settle`。（上一版注释把这件事写成「等防抖 25 秒」，那是没读
   * 代码就写的。）
   */
  search: async (f) => {
    f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    const box = await inFrame(f, '.ink-searchmodal-input');
    const d = f.contentDocument;
    const titles = [...d.querySelectorAll('.ink-trow-title')]
      .map((e) => (e.textContent || '').trim()).filter(Boolean);
    if (titles.length === 0) throw new Error('屏幕上一条任务都没有，搜不出「有结果」那一态');
    const span = new Map(); // 候选 → 装着它的可见标题有几行（同一行里出现几次不算几行）
    for (const t of new Set(titles)) {
      for (const ch of new Set([...t].filter((c) => /[\u4e00-\u9fff]/.test(c)))) {
        span.set(ch, (span.get(ch) || 0) + 1);
      }
    }
    const cands = [
      ...[...span.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([ch]) => ch),
      titles[0].slice(0, 2),
    ];
    const win = f.contentWindow;
    const set = win.Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
    const type = (q) => {
      set.call(box, q);
      box.dispatchEvent(new win.Event('input', { bubbles: true }));
    };
    const hitsNow = () => d.querySelectorAll('.ink-searchmodal-hit').length;
    let best = { q: '', n: 0 };
    for (const q of cands) {
      type(q);
      await settle(f, { need: 2, step: 120, budget: 3000 });
      const n = hitsNow();
      if (n > best.n) best = { q, n };
      if (n >= 8) break; // 够摊满一列了，再试下去只是多花时间
    }
    if (best.n === 0) throw new Error(`试了 ${cands.join('、')}，一条都没搜到——这一格量的不是「有结果」那一面`);
    if (best.q !== box.value) {
      type(best.q);
      await inFrame(f, '.ink-searchmodal-hit');
    }
  },
  /**
   * 日期面板摊开那一屏。先走 `compose` 叫出新任务表单，点开「日期」那一行
   * （`.ink-frow` 是行首那颗按钮），再点面板里那个输入框把 antd 的日历弹出来。
   * 手机上这一态最挤：面板宽度是 antd 自己算的，而这个应用里最能挑日期的
   * 控件就是它。
   */
  datePanel: async (f) => {
    await DRIVE.compose(f);
    const d = f.contentDocument;
    const row = [...d.querySelectorAll('.ink-frow')].find((e) => (e.querySelector('.ink-frow-nm')?.textContent || '').trim() === '日期');
    if (!row) throw new Error('没找到「日期」那一行');
    row.click();
    const picker = await inFrame(f, '.ant-picker input');
    picker.click();
    await inFrame(f, '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)');
  },
  /**
   * ── 下面这一批是把「从来没进过表的那几十面」开出来。
   *
   * 每条都走真控件（点那颗、按那个键、往那个框里打字），理由跟上面一样：
   * 调内部函数量到的是「我以为它会变成那样」。找不到就说找不到——报「量不到」
   * 比量一面不相干的屏幕有用。
   */
  /** 日历右边那栏「安排任务」（分组头、排序下拉、上下挪那颗都只在那儿）。 */
  schedPanel: async (f) => {
    const b = await inFrame(f, '.ink-cal-schedbtn');
    if (b.getAttribute('aria-pressed') !== 'true') b.click();
    await inFrame(f, '.ink-sched-tab');
  },
  /** 日历那一屏切到某一档（`{ drive:'calMode', mode:'agenda' }`）。 */
  calMode: async (f, c) => {
    const sel = await inFrame(f, 'select.ink-cal-modesel');
    const want = c?.mode;
    if (!want) throw new Error('这一格没写切到哪一档');
    setNativeValue(f, sel, want);
    // 日程那一档是我们自己的 DOM，其余几档是 FullCalendar 的——各等各的第一件东西
    await inFrame(f, want === 'agenda' ? '.ink-agenda-title' : want === 'year' ? '.ink-year-day' : '.fc-view-harness', 20000);
  },
  /**
   * 日历上点一天，让「在这天新建」那颗出现——它只在 `selectedKey` 被设上之后
   * 画出来，所以这一格必须真点一下。
   *
   * **走「日程」那一档，不走月历格子**：格子那一下 FullCalendar 不认合成事件
   * （`click()` 和整串按下—抬起都试过），而 `.ink-agenda-date` 是我们自己的
   * `<button onClick=onSelectDay>`。
   *
   * **每次点之前重新查一遍那颗按钮。** 上一版在这里栽过一次，而且栽得很难看：
   * 它先 `inFrame` 等到列表、把节点存进变量、再点——可切档那一下 React 会把
   * 这一列重画一遍，存下来的那个节点已经从树上摘掉了，点在它身上什么都不发生
   * （不报错、也不选中）。表现就是这一格永远报「那颗按钮没出现」，而我据此在
   * 这里写过一句「三条路都是死路」——**那句是错的**：真在浏览器里点（节点现查
   * 现点）它就会出现。所以现在每轮都重新查、点完等一下，最多八次。
   */
  calCompose: async (f) => {
    const sel = await inFrame(f, 'select.ink-cal-modesel');
    setNativeValue(f, sel, 'agenda');
    await inFrame(f, '.ink-agenda-date', 15000);
    for (let i = 0; i < 8; i++) {
      const all = [...f.contentDocument.querySelectorAll('.ink-agenda-date')];
      if (!all.length) break;
      all[Math.min(1, all.length - 1)].click();
      const hit = await inFrame(f, '.ink-cal-compose', 2000).then(() => true, () => false);
      if (hit) return;
    }
    const n = f.contentDocument.querySelectorAll('.ink-agenda-date').length;
    throw new Error(`点了 8 次日程里的日期（这一屏有 ${n} 天可点），那颗「在这天新建」还是没出现`);
  },
  /**
   * 表单里「＋ 加一项」点出某一行并展开它。行已经在表单上（改一条本来就带这个
   * 属性的任务）就直接点那一行——两条路都走真控件，区别只是点哪个。
   */
  async addAttr(f, name, after) {
    const d = f.contentDocument;
    const row = [...d.querySelectorAll('.ink-frow')].find((e) => (e.querySelector('.ink-frow-nm')?.textContent || '').trim() === name);
    if (row) row.click();
    else {
      const add = await inFrame(f, '.ink-frow-add');
      add.click();
      const item = await inFrame(f, `[aria-label="加一项：${name}"]`, 8000);
      item.click();
    }
    if (after) await after(f);
  },
  /** 重复那一行摊开：频率下拉、每几个、工作日/周末、七个星期格子、「当成习惯」。 */
  repeatEditor: async (f) => {
    await DRIVE.compose(f);
    await DRIVE.addAttr(f, '重复');
    const sel = await inFrame(f, 'select.ink-repeat-select[aria-label="重复"]', 8000);
    // 选「每周」而不是「每天」：只有周档画那七颗星期格子和两颗快捷（工作日/周末），
    // 而「当成习惯」那颗要 `every` 是 day 或 week 才出现——周档两个条件都满足。
    setNativeValue(f, sel, 'week');
    await inFrame(f, '.ink-repeat-day');
    await inFrame(f, '.ink-habit-toggle');
  },
  /** 标签那一行：已有的标签各带一颗 ×，下面那个加标签的框永远在。 */
  tagEditor: async (f) => {
    await DRIVE.compose(f);
    await DRIVE.addAttr(f, '标签');
    const input = await inFrame(f, '.ink-tag-input', 8000);
    setNativeValue(f, input, '夹具');
    input.dispatchEvent(new f.contentWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await inFrame(f, '.ink-tag-x');
  },
  /** 优先级那一行：高/中/低三颗。 */
  priRow: async (f) => {
    await DRIVE.compose(f);
    await DRIVE.addAttr(f, '优先级');
    await inFrame(f, '.ink-pri-btn', 8000);
  },
  /** 备注框里打一个 `/`——斜杠插入菜单整排 13 项。 */
  slashMenu: async (f) => {
    await DRIVE.compose(f);
    const notes = await inFrame(f, 'textarea[aria-label="备注"]');
    setNativeValue(f, notes, '/');
    await inFrame(f, '.ink-slash-item', 8000);
  },
  /**
   * 搜索弹层里回车 = 去「搜索结果」那个去处，那儿顶上挂着「匹配到的清单和标签」
   * 那一排胶囊（弹层里没有）。搜什么从屏幕上现取：拿侧栏第一份清单名的第一个字。
   */
  searchJump: async (f) => {
    f.contentWindow.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    const box = await inFrame(f, '.ink-searchmodal-input');
    // 拿侧栏第一个标签名里的一个汉字：搜到标签才会挂出那排胶囊（搜任务标题
    // 是另一面，上面 `search` 那一格量的就是它）。
    const tag = (f.contentDocument.querySelector('.ink-nav-tag')?.textContent || '').trim();
    const q = (tag.match(/[\u4e00-\u9fff]/) || [''])[0];
    if (!q) throw new Error('侧栏里没有标签那一节，搜不出「跳转到」那排胶囊');
    setNativeValue(f, box, q);
    box.dispatchEvent(new f.contentWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await inFrame(f, '.ink-search-jump', 12000);
  },
  /** 筛选栏：不收起来的时候它自己是一个按钮「筛选」，点开拓成一排勾选。 */
  filterPanel: async (f) => {
    const d = f.contentDocument;
    const open = [...d.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '筛选');
    if (open) open.click();
    await inFrame(f, '.ink-filter-waiting', 8000);
  },
  /** 侧栏标签那颗 ⋯ →「改名」：整行换成一个内联表单。 */
  renameTag: async (f) => {
    const d = f.contentDocument;
    const act = d.querySelector('[aria-label^="标签 "][aria-label$=" 的更多操作"]');
    if (!act) throw new Error('侧栏里没有标签那一节（这一屏的侧栏可能在抽屉里）');
    act.click();
    const item = await inFrame(f, '.ant-dropdown:not(.ant-dropdown-hidden) [role="menuitem"], .ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', 8000);
    const want = [...(item.closest('.ant-dropdown')?.querySelectorAll('.ant-dropdown-menu-item') || [item])]
      .find((x) => (x.textContent || '').trim() === '改名');
    if (!want) throw new Error('那个菜单里没有「改名」');
    want.click();
    await inFrame(f, '.ink-nav-tag-rename input', 8000);
  },
  /**
   * 垃圾箱里**刚按下「还原」那一下**：回执浮层 + 焦点落在哪儿。
   *
   * **这是一次性的面**：点下去服务端就把那条挪回任务里，第二次跑同一份数据
   * 垃圾箱就空了——要再看这一面，重跑一遍生成器（跟「到点横幅」那两条同一条
   * 道理）。焦点这一族 jsdom 测得动，但它测的是「我们以为的 focus」，浮层压住
   * 页面之后真实焦点落在哪个节点，只有浏览器说了算。
   */
  trashRestore: async (f) => {
    await inFrame(f, '.ink-trash-item', 12000);
    const d = f.contentDocument;
    const li = d.querySelector('.ink-trash-item');
    const b = [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === '还原');
    if (!b) throw new Error('那一行里没有「还原」那颗');
    b.focus();
    b.click();
    await inFrame(f, '.ant-message-notice', 8000);
  },
  /**
   * 专注统计的两条**前置断言**。这两格量的面取决于夹具带不带 `--no-focus`，
   * 而「量错了面」是看不出来的：空态那一屏和满的那一屏都规规矩矩没有溢出、没有
   * 小目标，读数一样漂亮。所以每格都先验一句只有它那一面才有的话，验不过就
   * 报错——宁可这一格红，也不要它绿着量另一面。
   */
  focusEmpty: async (f) => {
    const note = await inFrame(f, '.ink-empty-note', 12000).catch(() => null);
    if (!note || !note.textContent.includes('还没有专注记录')) {
      throw new Error('这一面不是「一次都没专注过」——重跑夹具时带上 --no-focus');
    }
  },
  focusFull: async (f) => {
    // 那四格只有「有记录」那一面才渲染，所以它不在就等于这一屏是空的。
    // 报错要说人话：报「`.ink-fstat-cells` 没出现」会让人去查一个不存在的渲染 bug。
    const cells = await inFrame(f, '.ink-fstat-cells', 12000).catch(() => null);
    if (!cells) throw new Error('这一屏是空的——390 那一格要量的是有记录的那一面，重跑夹具别带 --no-focus');
  },
  /**
   * 侧栏里**一份清单的那颗 ⋯**。这一层从没上过屏：表里只有「标签改名」那一格，
   * 而清单这个菜单比标签那个长得多——改名 / 编辑筛选条件 / 让 AI 回顾这份清单 /
   * 上移 / 下移 / 归档 / 改颜色（一组带圆点）/ 移到文件夹（一组）/ 删除。
   *
   * `which` 挑哪一份清单：普通的那份和智能的那份菜单**正好相反**（智能清单没有
   * 「让 AI 回顾」，普通清单没有「编辑筛选条件」），两格各量一支。
   */
  listMenu: async (f, c) => {
    // **先等那一节画出来。** 清单是 `/api/lists` 回来才有的，而「首帧」那道判据
    // 认的是任何一种内容节点（任务列表先到也算）——不等就直接查，报出来是
    // 「侧栏里没有清单那一节」，一句把矛头指向界面的假话。同一个坑这一轮刚在
    // 纪念日那一格上栽过。
    try {
      await inFrame(f, '[aria-label^="清单 "]', 12000);
    } catch {
      throw new Error('侧栏里一直没有清单那一颗 ⋯——要么这一屏的侧栏在抽屉里没摊开，要么一份清单都没有');
    }
    const d = f.contentDocument;
    const btns = [...d.querySelectorAll('[aria-label^="清单 "][aria-label$=" 的更多操作"]')];
    if (!btns.length) throw new Error('侧栏里没有清单那一节（这一屏的侧栏可能在抽屉里）');
    const hit = c.which ? btns.find((b) => (b.getAttribute('aria-label') || '').includes(c.which)) : btns[0];
    if (!hit) {
      throw new Error(`侧栏里没有名字含「${c.which}」的清单——现有：${
        btns.map((b) => (b.getAttribute('aria-label') || '').replace(/^清单 | 的更多操作$/g, '')).join('、')}`);
    }
    hit.click();
    /**
     * **点了要看到菜单真的开出来，没开就再点一次。** 跟上面 `openFirst` 那一段
     * 同一条判据。实测第一格会偶发开不出来：刚 boot 完那一下常有一次 SSE/同步
     * 刷新，侧栏重渲染把刚展开的下拉收回去——于是这一格报「菜单没出现」，
     * 而同一份稿子第二格第三格都过。那种红是稿子的，不是界面的。
     */
    const open = () => !!d.querySelector('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item');
    try {
      await inFrame(f, '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', 2500);
    } catch {
      if (!open()) {
        hit.click();
        await inFrame(f, '.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item', 8000);
      }
    }
  },
  /**
   * 卡片进编辑态，且**这条任务有检查事项**——子任务那两颗（改 / 删）只在编辑态
   * 的 DOM 里，不编辑时整个不在树上。哪张卡有子任务不写死：挨张点开看，
   * 出现 `.ink-subtask-edit` 就是它。
   */
  subtaskEdit: async (f) => {
    const d = f.contentDocument;
    /**
     * **先等列表画出来再翻卡片。** 原来这儿直接读 `.ink-task-card`——数据是异步
     * 拉的，抢跑的那一轮报「这一屏没有卡片档的任务卡」。同一类坑在 `cdEdit`
     * 和 `listMenu` 上各修过一次（那次报的是「夹具里是不是没有纪念日」，把矛头
     * 指到了没问题的地方）。
     */
    const painted = await waitFor(f, (x) => x.contentDocument.querySelectorAll('.ink-task-card').length > 0,
      '「全部」那一屏的卡片档列表', 12000).then(() => true, () => false);
    if (!painted) throw new Error('「全部」那一屏到点没画出卡片——这一格量不到编辑态（不是没有检查事项，是列表没落地）');
    const cards = [...d.querySelectorAll('.ink-task-card')];
    if (!cards.length) throw new Error('列表画出来了却没有卡片档的任务卡——那一屏被前面哪格切成行档了？');
    /**
     * 三处都得判对，上一版错了两处：
     * - **落点**用标题那段字，跟 `editForm` 那一格同一个落点。
     * - **判「到了没有」按看得见**，不按「DOM 里有」：草稿没开时那些输入框也
     *   在树里（实测 11 个全是 0×0、`offsetParent` 为 null）。只查存在的话第一
     *   张卡就算命中，于是这一格报「没问题」，量的却是一面收起来的表单。
     * - **认「删掉」那颗**，不认那一行的输入框：草稿永远有一条「加一条检查
     *   事项」的空行也叫 `.ink-subtask-edit`，认它就等于随便一张卡都算命中。
     */
    const shown = () => [...d.querySelectorAll('.ink-subtask-del')]
      .some((e) => e.offsetWidth > 0 && e.offsetParent !== null);
    // 先试**屏幕上挂着那枚「子任务 n/m」记号的几张**：#全部 有五十来张卡，而带检查
    // 事项的那几条排在「进行中」那一堆里——按 DOM 顺序试前 12 张会全试在没子任务
    // 的卡上，报一句「夹具该有一条带子任务的」，而夹具其实有。
    // **认 `.ink-kids-mark` 那个节点，不认一句字面文字**：上一版认的是「N 个子任务」，
    // 而卡片上那句话现在长成「子任务 1/4」（`TaskCard.tsx` 的 `ink-kids-mark`）——
    // 字面一漂移，这一格就变成「永远量不到」，报的还是指错方向的那句。
    const withSubs = cards.filter((c) => c.querySelector('.ink-kids-mark'));
    const queue = (withSubs.length ? withSubs : cards).slice(0, 12);
    for (const card of queue) {
      const title = card.querySelector('.ant-typography') || card;
      title.dispatchEvent(new f.contentWindow.MouseEvent('dblclick', { bubbles: true }));
      const t0 = Date.now();
      while (!shown() && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 100));
      if (shown()) return;
      f.contentWindow.document.body.dispatchEvent(new f.contentWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle(f, { need: 1, step: 120, budget: 1200 });
    }
    throw new Error(`前 ${queue.length} 张卡都没有看得见的检查事项（挂着「子任务 n/m」那枚记号的有 ${withSubs.length} 张）`);
  },
  /**
   * 顶上那行「添加任务」里打一句带日期的话：日期/清单两颗胶囊、以及「认出来的」
   * 那档虚线样式都在这一面。（胶囊只在「聚焦 或 有字」时画，光导航过去看不到。）
   */
  quickAdd: async (f) => {
    const input = await inFrame(f, '.ink-quickadd-input');
    input.focus();
    setNativeValue(f, input, '明天写周报 #整理');
    await inFrame(f, '.ink-quickadd-chip', 8000);
  },
  /**
   * 行档那颗 ⋯：不悬停/聚焦时**根本不在 DOM 里**（React 状态，不是 CSS 藏起来），
   * 所以先要派发一次 mouseover。「今天」那一屏的 ⋯ 是「挪上挪下」那块小面板，
   * 别的去处是完整菜单——这一条量的是前者（`.ink-trow-menu .ink-move-btn`）。
   */
  rowMenu: async (f) => {
    const d = f.contentDocument;
    const row = await inFrame(f, '.ink-trow');
    row.dispatchEvent(new f.contentWindow.MouseEvent('mouseover', { bubbles: true }));
    const more = await inFrame(f, '.ink-trow-more', 8000);
    more.click();
    await inFrame(f, '.ink-trow-menu .ink-move-btn', 8000);
  },
  /** 卡片档勾一条之后，每张卡左上角那颗勾选框才现身（批量态的第一颗）。 */
  selCheck: async (f) => {
    const title = await inFrame(f, '.ink-task-card .ant-typography');
    title.dispatchEvent(new f.contentWindow.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    await inFrame(f, '.ink-sel-check', 8000);
  },
  /** 习惯统计里展开一条的月历——上/下一个月那两颗只在展开的行里。 */
  habitMonth: async (f) => {
    const exp = await inFrame(f, '.ink-hstat-exp', 12000);
    exp.click();
    await inFrame(f, '.ink-hstat-moonav', 8000);
  },
  /**
   * 习惯屏在 390 上的**月历常驻**：`HabitStats.tsx` 写着「窄屏不受展开那套管，
   * 手机上本来是一行一张卡、月历常驻」——那是 CSS 一条媒体查询的承诺，所以这一格
   * 什么都不点，只验它。
   *
   * 按**看得见**判，不按「节点在树里」判：收起那一档节点也还在树里（同 `subtaskEdit`
   * 那处补过的教训）。量错面是看不出来的——收着的那一屏照样没有溢出、没有小目标。
   */
  habitMonthMobile: async (f) => {
    /**
     * `waitFor` 成功时**不带值**（`done()`），所以这里不能拿它的返回值当真假判据——
     * 第一版写成 `.catch(() => null)` 再 `if (!seen)`，于是「等到了」和「没等到」
     * 走同一句话：月历明明摊着（诊断读数 grid=2 宽=319），格子还是报「没摊开」。
     * 要一个布尔就自己 `.then(() => true, () => false)` 造一个。
     */
    const seen = await waitFor(f, (x) => [...x.contentDocument.querySelectorAll('.ink-hstat-grid')]
      .some((e) => e.offsetWidth > 0 && e.offsetParent !== null), '390 上摊着的月历', 12000)
      .then(() => true, () => false);
    if (!seen) {
      const d = f.contentDocument;
      const gs = [...d.querySelectorAll('.ink-hstat-grid')];
      throw new Error('这一屏的月历没摊开——「窄屏常驻」那条承诺不成立了：'
        + `innerWidth=${f.contentWindow.innerWidth} 卡=${d.querySelectorAll('.ink-hstat-card').length}`
        + ` grid=${gs.length} 宽=[${gs.map((e) => e.offsetWidth).join(',')}]`
        + ` detail=[${[...d.querySelectorAll('.ink-hstat-detail')].map((e) => getComputedStyle(e).display).join(',')}]`
        + ` max767=${f.contentWindow.matchMedia('(max-width: 767px)').matches}`);
    }
  },
  /**
   * 到点提醒那两条横幅。夹具给 dp-19 / dp-20 各挂一条「五分钟前、还没响」的提醒，
   * 服务一起来就把它们发出去——但那是**一次性的面**：发完 `firedAt` 就盖上章了，
   * 第二次跑同一份数据什么都看不见。所以这两条驱动自己重新挂一次（`armDue`），
   * 这一族才进得了表。
   *
   * 走的是应用自己那条写路由（`PATCH /api/tasks/:id`，跟表单保存同一个请求），
   * 不是往界面里塞状态：横幅只能由服务端那一路 SSE 发出来（`onReminderBatch`），
   * 编一个「看起来像响过」的 DOM 量到的不是它。等的上限给 75 秒：服务端那轮扫描
   * 是 30 秒一次，最坏要等满一整个间隔再加投递。
   */
  dueStack: async (f) => {
    await armDue(f, ['dp-19', 'dp-20']);
    await waitFor(f, (x) => /件事到点了/.test(x.contentDocument.body.innerText),
      '那一摞「有 N 件事到点了」（两条以上才画）', 75000);
    /**
     * 逐条那两颗（勾圈和标题）是**只有聚合这一档才有**的 DOM，光看标题那句
     * 分不出来——单条横幅上写的是「该做了：××」。所以这里再数一遍列表。
     */
    const n = f.contentDocument.querySelectorAll('.ink-due-item').length;
    if (n < 2) throw new Error(`横幅标题说「有 N 件事到点了」，列表里却只有 ${n} 条——聚合那一摞的逐条那颗没画出来`);
  },
  /** 只剩一条那一面：动作多得多（完成 / 去做 / 稍后 10 分钟 / ⌄ / ×）。 */
  dueOne: async (f) => {
    // **先把另一条摘出去**：只挂一条不够——dp-20 那条要是还欠着，服务端那一轮会把
    // 两条一起发出来，画的就是聚合那一档，这一格量的「单条」当场变成另一面。
    await armDue(f, ['dp-20'], 'clear');
    await armDue(f, ['dp-19']);
    await waitFor(f, (x) => /该做了：/.test(x.contentDocument.body.innerText),
      '单条那条「该做了：××」（有两条以上就不画）', 75000);
    if (f.contentDocument.querySelector('.ink-due-list')) {
      throw new Error('横幅是单条那句，可它下面挂着聚合那一档才有的列表——两条都在 `due` 里');
    }
    // 量完恢复。挂回「六小时后」而不是刚才那个时刻，理由在 `armDue` 的 `later` 那段。
    await armDue(f, ['dp-20'], 'later');
  },
  /**
   * 「下次自动拆解：14:32（约 45 秒后）」那条横幅。它是**唯一还没进过表**的、
   * 带「动作那一排」的 Alert，也是上一根「挤成一列一个字」的轴最可能再抓到东西
   * 的地方。状态由服务端排期经 SSE 发出来，夹具要带 `--scheduled` 才有（并且
   * 要重启那个服务——`device.json` 不在文件监听器的名单里）。等不到就报实话，
   * 指到该去开的那个开关上，不在稿子里编一条倒计时。
   *
   * 这儿验的是**那句话拼出来了**：一个数 + 一个单位（秒/分钟/小时）。上一版这里
   * 还验「数字在两秒半里变小了」——那个想法对，但它只在「秒」那一档成立，而
   * 夹具这一面摆的是 3600 秒的排期，落在「分钟」档，数字一分钟才动一次，于是
   * 那条检查把一次**正确的**文案改动读成了失败。每秒真的在走那件事有组件自己
   * 的测试钉着（`ScheduledBanner.test.tsx`，假时钟把 45 秒推到 40 秒），那才是
   * 能精确判「定时器没跑」的地方。
   */
  scheduled: async (f) => {
    const banner = () => [...f.contentDocument.querySelectorAll('.ant-alert')]
      .find((a) => a.innerText.includes('下次自动拆解'));
    await waitFor(f, () => !!banner(),
      '「下次自动拆解」那条倒计时横幅（重跑夹具时带上 --scheduled，并重启那个夹具服务）', 12000);
    const m = banner().innerText.match(/约 (\d+) (秒|分钟|小时)后/);
    if (!m) throw new Error('横幅在，可那句倒计时没拼出「约 N 秒/分钟/小时后」：'
      + JSON.stringify(banner().innerText.split('\n')[0]));
    if (Number(m[1]) === 0) throw new Error(`倒计时说的是「约 0 ${m[2]}后」——排期时刻已经过去了，横幅该收`);
  },
  /**
   * **几条页面级横幅同框那一面。** 每一条横幅都是各自量过、各自说清楚的，
   * 而它们**叠在一起**从来没同框量过：`--errors`（打不开的文件 + 同步冲突）、
   * `--scheduled`（下次自动拆解）、再加一次真的到点（两条聚合那一摞），
   * 四条一起挂上去的时候，手机上还剩多少屏给任务？
   *
   * 这条驱动先验「这一摞真的叠起来了」（少了任何一个开关都别把结论当真），
   * 再验一句判据：**第一条任务不许被推到第一屏之外**。
   *
   * 这一格进表那天是红的：390 上四条一起 463px（那块 844 屏幕的 55%），第一条
   * 任务在 882px。修法落在 `theme.css` 的 `.ink-main-stack`——给这一摞一个 45vh
   * 的上限、超出自己滚、下缘一道「下面还有」的渐隐。合并两条「数据出事」横幅
   * 那条路被 `App.tsx` 里那段注释明确挡着（「混成一条会让两种处置说不清」），
   * 没走。上一版这里量的还是「摞不超过半屏」，那是同一件事的一个代理数：上限
   * 落地之后代理数照样过，而真正要守的是屏幕上有没有任务。
   */
  bannerPile: async (f) => {
    const w = f.contentWindow;
    const d = f.contentDocument;
    const pile = () => {
      const stack = d.querySelector('.ink-main-stack');
      if (!stack) return null;
      const banners = [...stack.children].filter((k) => /banner|ant-alert/.test(String(k.className)));
      const first = d.querySelector('.ink-trow-open, .ink-task-card, .ink-inbox-item');
      return {
        n: banners.length,
        h: Math.round(banners.reduce((a, b) => a + b.getBoundingClientRect().height, 0)),
        vh: w.innerHeight,
        top: first ? Math.round(first.getBoundingClientRect().top) : null,
      };
    };
    /**
     * 四条里的那条「到点」得自己挂（`armDue`，理由见 `dueStack` 上面那段），
     * 不然这一摞只有三条，量的就不是同一面了。等它的预算跟 `dueStack` 一样给
     * 75 秒：服务端那轮扫描 30 秒一次。
     */
    await armDue(f, ['dp-19', 'dp-20']);
    await waitFor(f, () => { const p = pile(); return !!p && p.n >= 4; },
      '四条页面级横幅同框（这一格要夹具带 `--errors --scheduled` 两个开关，并且重启那个夹具服务）', 75000);
    const p = pile();
    /**
     * 判据是**这一屏真正要对人说的话**：屏幕上得有任务。上一版量的是「报警那一摞
     * 不超过半屏」，那是同一件事的一个代理数——改法（`theme.css` 的
     * `.ink-main-stack` 那条 45vh 上限）落地之后，代理数照样过，而真正要守的
     * 那句是「第一条任务不许被推到第一屏之外」。
     */
    if (p.top !== null && p.top > p.vh) {
      throw new Error(`报警这一摞 ${p.h}px（${p.n} 条同框），第一条任务在 ${p.top}px 处`
        + `——屏幕只有 ${p.vh}px，第一屏上没有任务。上限那条规则见 theme.css 的 .ink-main-stack`);
    }
  },
  /**
   * 垃圾箱**里面有东西**那一面。这一格和「刚还原那一下」那格共用同一份夹具，
   * 而还原那颗点下去那条就真回任务里了——跑几次之后垃圾箱会被抽干，那时候
   * 这一格量的其实是空态，而空态那一格（「垃圾箱 · 1280（空态）」）早就在表里，
   * 两格变成同一格而读数看不出来。所以这里验一句「行还在」。
   */
  trashItems: async (f) => {
    const rows = () => [...f.contentDocument.querySelectorAll('.ink-trash-item')]
      .filter((e) => e.offsetWidth > 0 && e.offsetParent !== null);
    const has = await waitFor(f, (x) => [...x.contentDocument.querySelectorAll('.ink-trash-item')]
      .some((e) => e.offsetWidth > 0 && e.offsetParent !== null), '垃圾箱里至少一条', 12000)
      .then(() => true, () => false);
    if (!has) throw new Error('垃圾箱是空的——这一格量的是空态，不是「里面有东西」。'
      + '（前面哪一格点过「刚还原那一下」就会这样：重跑一遍夹具生成器补回来）');
    if (rows().length > 8) throw new Error(`垃圾箱里有 ${rows().length} 条，夹具只该留两条——哪一格在往里塞东西？`);
  },
  /**
   * 垃圾箱**空着**那一面。这一格原来标签写着「空态」却一直没有断言——夹具铺了
   * 两条待删任务之后，它量的其实是有东西的那一屏，而两格（这格和「里面有东西」）
   * 报出来的读数一样漂亮，谁也看不出来。所以这里验两句：行没了，**而且那句空态
   * 的话在**。要这一面得带 `--no-trash` 重跑生成器。
   */
  trashEmpty: async (f) => {
    const d = f.contentDocument;
    await waitFor(f, (x) => !!x.contentDocument.querySelector('.ink-trash-note'),
      '垃圾箱那一屏画出来（那句说明空和满都在）', 12000);
    /**
     * **「空」是一个要等出来的结论，不是看一眼就下的。** 数据是异步拉的，空态那句
     * 话会先出现、行后到——第一版就是在这儿当场判了「没有行」，于是这一格带着断言
     * 还是绿了一次，而屏幕上随后就冒出两行。跟 `cdEdit` / `listMenu` / `subtaskEdit`
     * 那几处补的是同一个教训：**抢跑的读数不是读数**。这里等满 4 秒，期间只要冒出
     * 一行就当场红。
     */
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const rows = [...d.querySelectorAll('.ink-trash-item')].filter((e) => e.offsetWidth > 0);
      if (rows.length > 0) {
        throw new Error(`这一格要的是空垃圾箱，可屏幕上冒出 ${rows.length} 行——重跑夹具时带上 --no-trash`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const note = (d.querySelector('.ink-empty-note')?.textContent || '').trim();
    if (!note) throw new Error('四秒里一行都没有，可那句「垃圾箱是空的」也不在——这一屏两头都不靠');
  },
  /**
   * 「已完成」那一屏**得有已完成的任务**。跟 `trashItems` 同一个道理：这一屏
   * 空着的时候它量的是空态，而空态那一格是另一格，两格读数一样漂亮，标签就成了
   * 一句假话。
   */
  doneItems: async (f) => {
    const has = await waitFor(f, (x) => [...x.contentDocument.querySelectorAll('.ink-trow-open, .ink-task-card')]
      .some((e) => e.offsetWidth > 0 && e.offsetParent !== null), '「已完成」里至少一条', 12000)
      .then(() => true, () => false);
    if (!has) throw new Error('「已完成」是空的——这一格量的是空态，不是那一摞做完的事');
  },
  /** 「今天」顶上那条「▸ 推荐任务 N」，点开是那撮被推迟/搁太久的。 */
  suggestPanel: async (f) => {
    const d = f.contentDocument;
    const btn = [...d.querySelectorAll('button')].find((b) => (b.textContent || '').includes('推荐任务'));
    if (!btn) throw new Error('这一屏没有「推荐任务」那一行');
    btn.click();
    await inFrame(f, '.ink-suggest-name', 8000);
  },
  /**
   * 带附件那条任务的详情。哪一条有附件不写死：挨行点开，出现「打开」那颗就是它
   * （那一块只在「草稿态 或 附件非空」时渲染）。
   */
  attachRow: async (f) => {
    const d = f.contentDocument;
    const rows = [...d.querySelectorAll('.ink-trow-open')];
    if (!rows.length) throw new Error('这一屏没有行可点');
    for (const r of rows.slice(0, 14)) {
      // 点下一行只是把详情换一条，不用先关——所以这里不按 Esc。
      r.click();
      try {
        await inFrame(f, '.ink-attach-open', 1500);
        return;
      } catch { /* 这一条没有附件，试下一行 */ }
    }
    throw new Error('前 14 行都没有附件——夹具该有一条带附件的');
  },
  /**
   * 卡片上那句「AI 的拆解理由」被 antd 收成两行时，那个「展开」链接才存在。
   * 它要**看板档**（`showNote` 只有 TaskBoard 传）+ 一列窄到装不下那句话。
   */
  marginExpand: async (f) => {
    await inFrame(f, '.ink-margin-note', 12000);
    await inFrame(f, '.ink-margin-note .ant-typography-expand', 4000);
  },
  /**
   * 标完成之后那条 toast 里的「撤销」。它只活六秒，所以这一格要排在最后跑，
   * 而量它的那张表（floors）在 drive 之后紧接着就量。
   */
  undoToast: async (f) => {
    const check = await inFrame(f, '.ink-trow-check', 12000);
    check.click();
    await inFrame(f, '.ink-undo button', 6000);
  },
  /**
   * 番茄钟**跑着**的那三面。表里原来只有「专注统计」和「设置·专注」两格，
   * 而人真正常看见的是跑起来那一段：一个跳秒的等宽数字 + 一颗「取消计时」，
   * 休息时多一个字，正计时多一颗会禁用的「结束」，被别的卡占着时那两颗
   * disabled 加一句只在 `title` 里活着的解释。
   *
   * **全部走真按钮**：`FocusTimer` 那把锁是模块级的、状态只活在实例里，
   * 程序化塞 state 量到的是「我以为它会变成那样」。
   */
  focusRun: async (f) => {
    await inFrame(f, '.ink-task-card', 12000);
    const d = f.contentDocument;
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent.replace(/\s+/g, '') === '番茄钟');
    if (!b) throw new Error('这一屏没有「番茄钟」那颗——计时那一族只在卡档和详情里');
    b.click();
    // **等「取消计时」那颗，不等 `.ink-mono`**——那个类名是全站等宽小字的
    // 通用类（「今天」头上那行元数据就是它），不点番茄钟也在，拿它当
    // 「跑起来了」的证据等于永远第一时间通过。
    await waitFor(f, (x) => [...x.contentDocument.querySelectorAll('button')]
      .some((e) => e.textContent.replace(/\s+/g, '') === '取消计时'), '「取消计时」那颗（番茄钟真跑起来了）');
  },
  focusUp: async (f) => {
    await inFrame(f, '.ink-task-card', 12000);
    const d = f.contentDocument;
    const b = [...d.querySelectorAll('button')].find((x) => x.textContent.replace(/\s+/g, '') === '正计时');
    if (!b) throw new Error('这一屏没有「正计时」那颗');
    b.click();
    // 等「结束」那颗——正计时跑着才有它。`.ink-focus-tag` 不能用：
    // 它也是「休息」那半段共用的类，等于没证明是哪一支。
    await waitFor(f, (x) => [...x.contentDocument.querySelectorAll('button')]
      .some((e) => e.textContent.replace(/\s+/g, '') === '结束'), '「结束」那颗（正计时真跑起来了）');
  },
  /** 第二颗「番茄钟」被锁住那一面：disabled 的样子 + 那句解释挂在哪。 */
  focusBlocked: async (f) => {
    await inFrame(f, '.ink-task-card', 12000);
    const d = f.contentDocument;
    const bs = [...d.querySelectorAll('button')].filter((x) => x.textContent.replace(/\s+/g, '') === '番茄钟');
    if (bs.length < 2) throw new Error(`只有 ${bs.length} 张卡带「番茄钟」，占不出第二颗`);
    bs[0].click();
    await inFrame(f, '.ink-focus-blocked');
  },
  /**
   * 番茄钟的**休息那半段**。它只有专注真走完才出现（`focusMinutes` 的下限是 1
   * 分钟，服务端夹着，写不进 0），所以这一格要**等一分钟**——不能演：演出来的
   * 休息是稿子编的一个 div，跟「到点横幅是磁盘上的数据、不是点了才出现」那条
   * 道理是同一个。
   *
   * **要跑这一格，夹具得带 `--fast-focus` 重跑一遍**（一轮 1 分钟 + 休息 1 分钟）；
   * 不带的话这一格会等 25 分钟然后报超时，那是对的，不是稿子坏了。
   */
  focusBreak: async (f) => {
    await inFrame(f, '.ink-task-card', 12000);
    const d = f.contentDocument;
    const txt = (e) => (e?.textContent || '').replace(/\s+/g, '');
    const mono = () => d.querySelector('.ink-task-card .ink-mono');
    /**
     * **起错时长就取消重来。** App 里 `settings` 初值是 `null`，那一段时间还没到，
     * `TaskCard` 落回默认 25 分钟——那是它自己测过的一条裁决（「设置页从没打开过
     * 也有番茄钟能用」，`TaskCard.test.tsx`），不是 bug，稿子不能拿它当证据。
     * 夹具带 `--fast-focus` 时设的是 1 分钟，所以「起的是 01:00」就是设置已经落地
     * 的信号；不是就点掉「取消计时」再试一次。
     */
    for (let i = 0; i < 12; i++) {
      const b = [...d.querySelectorAll('button')].find((x) => txt(x) === '番茄钟');
      if (!b) throw new Error('这一屏没有「番茄钟」那颗（卡档才有）');
      b.click();
      await new Promise((r) => setTimeout(r, 350));
      if (txt(mono()) === '01:00') break;
      const cancel = [...d.querySelectorAll('button')].find((x) => txt(x) === '取消计时');
      cancel?.click();
      await new Promise((r) => setTimeout(r, 900));
      if (i === 11) throw new Error('设置一直没落地（每次起的是 25:00）——这一格量不到休息');
    }
    await waitFor(f, (x) => [...x.contentDocument.querySelectorAll('.ink-focus-tag')]
      .some((e) => e.textContent.trim() === '休息'),
    // 180 秒。**实测 90 秒不够**：窗口被别的东西挡住时 Chrome 把标签页的定时器
    // 夹成一分钟一次（上面「三个等待函数都按墙钟截止」那段就是为它写的），一分钟
    // 的专注于是会在 60~120 秒之间任意一点翻进休息。留一倍余量，宁可这一格慢，
    // 也不要它偶发报「量不到」——那种红会让人去查一个没问题的应用。
    '「休息」那半段——夹具没带 --fast-focus 的话这要等 25 分钟', 180_000);
  },
  /**
   * 倒数纪念日**正在改那一行**。那一屏原来只量过列表档：改名字/改日期是另一套
   * DOM（输入框、原生日期控件、一颗「保存」），而且它有几个只有点开才存在的
   * 问题——没有退路那颗、勾选框跟草稿混在同一行、窄屏上三个控件挤一格。
   */
  cdEdit: async (f) => {
    // **先等列表画出来再找那颗 ✎。** 数据是异步拉的，drive 一上来就翻按钮表
    // 会翻到空的——而报出去的那句「夹具里是不是没有纪念日」把矛头指错了地方
    // （夹具里真有两条）。等一个只有画出来才存在的节点，再谈找不到。
    await inFrame(f, '.ink-cd-row', 12000);
    const d = f.contentDocument;
    const pen = [...d.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('改「'));
    if (!pen) throw new Error('列表画出来了却没有那颗 ✎——`onEdit` 没接上？');
    pen.click();
    await inFrame(f, '.ink-cd-title');
  },
};

/** 往 React 受控的原生控件里写值：走原型上那个 setter，不然 React 收不到。 */
function setNativeValue(f, el, v) {
  const win = f.contentWindow;
  const proto = el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
}

/** 这一格开之前要设的设备态：密度、在不在离线那一面、要不要当新设备。 */
function prepareCell(c) {
  // 同源共享 localStorage：密度这一档是设备偏好，必须在导航之前设好。
  localStorage.setItem('density', c.density);
  /**
   * **每一屏的「显示方式」也要按格重置。** `navModes` 存的是「哪个去处用看板/
   * 用列表」，它跟密度同一类（设备偏好，不是这一格要量的东西），但比密度阴：
   * 只要有任何一格点过那排「列表/看板」开关，后面所有跑到那个去处的格子就跟着
   * 换了一面。上一轮就是这么坏的——「详情 · 带附件那条」报「这一屏没有行可点」，
   * 因为「全部」已经被前面那格切成看板了，而看板里没有 `.ink-trow-open`。
   * `listMode` / `kanbanAxis` / `groupSort` 同理：都是那一屏的摆法，不是被测物。
   */
  for (const key of ['navModes', 'listMode', 'kanbanAxis', 'groupSort']) localStorage.removeItem(key);
  // **离线那一面也在这儿切**：`apiBase`（`lib/apiBase.ts`，Capacitor
  // Preferences 在 web 上就是 localStorage 原键）指到一个没人听的端口，
  // `/api/health` 探测失败 ⇒ 整条 `route()` 走本地层，离线横幅出现。
  // 每一格都重设：不留下来的话后面所有格子都跟着离线，那一屏的读数全是
  // 离线那面的账。「新设备」那一格再清掉 `local:*`——那几个键是前面那些
  // **在线**格子回填出来的本地快照，不清就是「离线但有一份旧数据」，
  // 清了才是「拿到新设备、服务又没起来」那一面。
  if (c.offline) {
    localStorage.setItem(PREF_PREFIX + 'apiBase', DEAD_API);
    localStorage.setItem('apiBase', DEAD_API);
  } else {
    localStorage.removeItem(PREF_PREFIX + 'apiBase');
    localStorage.removeItem('apiBase');
  }
  if (c.fresh) {
    for (const key of Object.keys(localStorage)) if (key.includes('local:')) localStorage.removeItem(key);
  }
}

/** 把一格真 app 开到「已经画完、驱动到位」那一步为止。量数的那一半在各张稿子里。 */
async function bootCell(f, c) {
  // **导航那一步要有上限。** 实测栽过一次：这一轮刚开始那格 iframe 加载完
  // 是个空文档、`onload` 再也没回来，整条链就挂在第一个 await 上——两分钟
  // 里稿子上只有「booting…」，一行读数都没出，看不出是第几格卡住、卡在哪。
  // 超时就往下走：下面的「等首帧」自己会等不到而记一行「量不到」，那一行
  // 说的是「这一格没量到」，比整轮冻在第一格好查得多。
  await new Promise((done) => {
    const timer = setTimeout(done, 15000);
    f.onload = () => { clearTimeout(timer); done(); };
    f.src = `/${c.hash}`;
  });
  // 等首帧：判据必须是**内容节点**。原来这里等的是 `.ink-view-panel`，
  // 那个壳在拿到 /api/tasks 之前就挂着——于是「详情面板」那一格点了个空，
  // 报出来是「首帧没等到」，看着像 app 的 bug，其实是稿子抢跑。
  // `.ink-empty-note` 也算首帧：**「什么都没有」是一面要量的屏**（新设备 +
  // 服务没起来那一格，屏幕上就没有任何一行任务），只认列表节点的话它永远
  // 等不到，报出来像坏了，其实量的正是它该有的样子。
  await waitFor(f, () => f.contentDocument.querySelector('.ink-trow-open, .ink-task-card, .ink-inbox-item, .ink-countdown-card, .ink-empty-note, .ink-offline-banner'), c.label);
  calm(f);
  if (c.openFirst) {
    // 分开报两种「开不出详情」：这一屏没有可点开的行（夹具的日期是相对「现在」
    // 算的，凌晨与深夜「今天」可能一条都不剩），和**点了没开**（那才值得查）。
    // 合成一条「首帧没等到」会让人去查一个不存在的渲染 bug。
    // **先等到有行可点，再点。** 「首帧」那一道判据认的是*任何一种*内容节点
    // （空态那行也算），所以列表比空态晚半拍落地时，这里立刻找行会找不着——
    // 同一张表上连跑三格，中间那一格就这么空手了（它是随机的，不是坏了）。
    const row = () => f.contentDocument.querySelector('.ink-trow-open')
      || f.contentDocument.querySelector('.ink-task-card');
    await waitFor(f, () => !!row(), `${c.label}：这一屏到点没有可点开的行`, 15000);
    /**
     * **点了要看到详情真的开出来，没开就再点一次。** boot 那一拍点下去常常
     * 什么都不发生（同一格过几秒再点就开）——那会儿 App 的状态还在追第一批
     * 数据，`setDetail` 落了但渲染被随后的 reload 重排掉。稿子不该把这件事
     * 记成「界面的详情打不开」：人手点两下是同一件事。所以每 300ms 复核一次，
     * 没开就再点，最多十二次（约 7 秒）；十二次都没开才报「点了没开」。
     */
    for (let n = 0; n < 12; n++) {
      if (f.contentDocument.querySelector('.ink-dt-notes')) break;
      if (n % 2 === 0) row().click();
      await new Promise((done) => setTimeout(done, 300));
    }
    await waitFor(f, () => f.contentDocument.querySelector('.ink-dt-notes'),
      `${c.label}/详情点了十二次还没开`, 8000);
  }
  // 要先操作一下才出现的屏：点完/按完再量，等 400ms 让 antd 的进场动画走完，
  // 不然量到的是半透明的中间帧。
  if (c.drive) { await DRIVE[c.drive](f, c); await new Promise((r) => setTimeout(r, 400)); }
}

/** 轮询等某一格出现目标节点；到墙钟上限还没等到就抛，交回上层记一行。 */
/**
 * 把夹具那两条任务的提醒重新挂上（或者按下去）。见上面 `dueStack` 那一段为什么
 * 非得由驱动来挂：那一面本来就是**响一次就没了**的状态。
 *
 * `live`：时刻落在 20 秒前、`firedAt` 空着——服务端下一轮扫描（30 秒一次）把它
 * 发出来。20 秒不是随手写的：得在「过去」（不然这一轮不响）又得在 `CATCH_UP_MS`
 * 那一小时补发窗内（不然只盖章不响）。
 * `clear`：把这条任务名下的提醒**摘干净**（`reminders: []`）。用来把「另一条」弄出
 * 这一轮——想靠写一个 `firedAt` 来静音它是不行的，`applyTaskPatch` 按时刻重算章，
 * 传上来的 `firedAt` 根本不被采纳（`server/src/task.ts` 那段注释写明了），
 * 于是那条「静音」补丁实际做的事是**把它重新挂上**。第一版就是这么把单条那一面
 * 量成聚合那一档的。
 * `later`：挂到六小时之后。量完恢复用——不能恢复成「刚才那个时刻」，那会在下一次
 * 扫描（30 秒内）把这一屏变回聚合，而探针是在驱动返回**之后**才扫的。
 *
 * 同一个 id 反复挂都响得起来：`applyTaskPatch` 是按时刻逐条比对来沿用旧章的，
 * `at` 每轮都变，配不上任何一条旧的，于是从「还没提醒过」重新算起。
 */
async function armDue(f, ids, mode = 'live') {
  const w = f.contentWindow;
  const at = mode === 'later'
    ? new Date(Date.now() + 6 * 3600_000).toISOString()
    : new Date(Date.now() - 20_000).toISOString();
  const reminders = mode === 'clear' ? [] : [{ at, firedAt: null }];
  for (const id of ids) {
    let res;
    try {
      res = await w.fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reminders }),
      });
    } catch (e) {
      throw new Error(`挂不上提醒（PATCH /api/tasks/${id}）：${e.message}——这一格要的是夹具服务在跑`);
    }
    if (!res.ok) {
      throw new Error(`挂不上提醒：PATCH /api/tasks/${id} → ${res.status}。`
        + '这两格锚的是夹具里 dp-19 / dp-20 那两条（生成器改过号？）。');
    }
  }
}

function waitFor(f, pred, label, budget = 21000) {
  return new Promise((done, fail) => {
    const t0 = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = !!pred(f); } catch { ok = false; }
      if (ok) return done();
      // 21 秒的**墙钟**上限，不是「轮询 70 次」（为什么按钟不按次数，见下面
      // 「三个等待函数都按墙钟截止」那段）。两格报「首帧没等到」不是 app 慢，
      // 是几个真 app 同时 boot 时这一格排到了队尾——稿子自己抢跑，不该记成页面的账。
      if (Date.now() - t0 > budget) return fail(new Error(`${label} 首帧没等到`));
      setTimeout(tick, 300);
    };
    tick();
  });
}

/**
 * **三个等待函数都按墙钟截止，不按「轮询了几次」。** 出自一次整轮冻住：稿子那
 * 个标签页被切到后台（`document.visibilityState === 'hidden'`），Chrome 把定时器
 * 夹到约一分钟一次，于是「40 次 × 250ms」这个原本 10 秒的预算变成了 40 分钟——
 * 一轮跑到第七格就再也不出读数，而屏幕上只有「booting…」（没有一条报错、没有
 * 一行超时，看着像探针挂了）。按次数写等待，预算的含义跟着节流变，是这套稿子
 * 唯一会「不报错地停住」的地方。按墙钟写，最坏就是一个夹之后的粒度（约一分钟）
 * 之内报出「量不到：××没出现」——那条读数说的是这一格没量到，剩下的格子照跑。
 *
 * 顺带一条前提：**这一轮要在前台标签页跑**。后台里不只是等待变慢，`requestAnimationFrame`
 * 根本不跑（见 `calm` 那条注释里 opacity 卡在 0 那个现象）。
 */

/**
 * **等这一格「长定了」再量**：节点数连着三次（每 200ms）不再变，才算画完。
 *
 * 出处是一次假读数，不是保险：「设置 · AI 那一节」五格连跑时报「节点 24 ·
 * 无名字控件 0」，单跑同一格报「节点 126」。差的不是判据，是**时机**——五格
 * 排队 boot 时这一格排到队尾，固定那 400ms 到点时弹层的表单还没画出来，探针
 * 扫到的只有弹层壳。壳里没有小目标、也没有没名字的控件，于是两个 0 都是真的，
 * 只是它们量的不是这一屏。修完开关的名字之后，这一格要是还按老路跑，「0」就
 * 又一次不是证据。
 *
 * 只等稳定、不等具体内容：**每格该等到什么**得为每一屏单独写一条判据，而那正
 * 是这套稿子最容易写歪的地方（见上面「首帧」那条注释里栽过的第二次）。节点数
 * 稳了不等于对，但不稳一定还没画完。
 */
function settle(f, { need = 3, step = 200, budget = 6000 } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    let last = -1; let same = 0;
    const tick = () => {
      let total = -1;
      try { total = f.contentDocument.querySelectorAll('body *').length; } catch { total = last; }
      same = total === last ? same + 1 : 0;
      last = total;
      // 到上限就放行：一直变动的屏（在跑的动画）不该把整轮卡死，那种情况
      // 少等一会儿、量到略早的帧，比整轮停在第七格好查。
      if (same >= need || Date.now() - t0 > budget) return done();
      setTimeout(tick, step);
    };
    tick();
  });
}

/**
 * **把进场动画钉成「已经走完」**：往那一格塞一条把弹层根节点的透明度写死的样式。
 *
 * 为什么要有这一条：浏览器把这个稿子页当后台标签，动画的时间轴不往前走，antd 的
 * 弹层类名永远停在 `ant-zoom-appear-prepare`，算出来 `.ant-modal` 是
 * `opacity: 0`——淡入的第一步就是它的全部。两个后果：拿眼睛对版式时那几格是空白，
 * 而探针把「自己 `opacity: 0` 的元素」当 sr-only 跳过，弹层根节点这一层从来没被
 * 量过（子孙各自是 1，所以里面的控件照量，读数不是全假，但少一层）。
 *
 * 只写 `opacity: 1`，**不用 `animation: none`**：那样等于把动画掐掉而起点那句
 * `opacity: 0` 还留在类上，弹层反而更确定地看不见。
 */
function calm(f) {
  const s = f.contentDocument.createElement('style');
  s.textContent = '.ant-zoom-appear,.ant-zoom-enter,.ant-slide-up-appear,.ant-slide-up-enter,'
    + '.ant-slide-down-appear,.ant-drawer .ant-drawer-panel-content{opacity:1 !important}';
  f.contentDocument.head.appendChild(s);
}

/** 在某一格里等某个选择器出现，回那个元素。等不到就抛，上层记成「量不到」。 */
function inFrame(f, sel, budget = 10000) {
  return new Promise((done, fail) => {
    const t0 = Date.now();
    const tick = () => {
      const el = f.contentDocument.querySelector(sel);
      if (el) return done(el);
      // 原来是「40 次 × 250ms」——标签页在后台时被夹成一分钟一次，这一句就是
      // 那 40 分钟的来源（见上面「三个等待函数都按墙钟截止」那段）。
      if (Date.now() - t0 > budget) return fail(new Error(`${sel} 没出现`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** 探针必须跑在被测 iframe 自己的 realm 里，所以注入到那一格的 <head>。
 *  路径写**绝对**的：iframe 的地址是 `/#/today`，相对路径会解析成 `/probe.js`，
 *  服务端 SPA fallback 会回一份 index.html，于是得到一句
 *  `Unexpected token '<'`——报错看不出是路径错了。
 *  `/design-preview/*` 那一层现在只有带 `DESIGN_PREVIEW=1` 的夹具服务才挂（见
 *  `server/src/index.ts`），没挂上时那条路径回的是 404、不是外壳——这一格报
 *  「探针没加载」而页面根本打不开，两种情况一眼分得开。 */
function injectProbe(f) {
  return new Promise((done, fail) => {
    const s = f.contentDocument.createElement('script');
    s.src = '/design-preview/probe.js';
    s.onload = done;
    s.onerror = () => fail(new Error('探针没加载'));
    f.contentDocument.head.appendChild(s);
  });
}

/** 一行读数。两张稿子共用：batch1 的表、batch2 的左右两栏都用这一份口径。 */
function renderRow(r) {
  const bad = (n) => (n ? `<b>${n}</b>` : '0');
  return `[${r.cell}] 节点 ${r.nodes} · 横向溢出 ${bad(r.overflow)} · 截断无兜底 ${bad(r.clipped)} · 有兜底 ${r.guarded}`
    + ` · 点击目标<24 ${bad(r.smallTargets)}${r.unmeasured ? `（另有 ${r.unmeasured} 个在屏外量不到）` : ''}${r.covered ? `（另有 ${r.covered} 个被浮层压着量不到）` : ''}${r.scrolledOut ? `（另有 ${r.scrolledOut} 个被滚动裁掉量不到）` : ''} · 无名字控件 ${bad(r.noName)} · 空 alt 图 ${bad(r.imgNoAlt)} · 挤成一列一个字 ${bad(r.squeezed)}`;
}
