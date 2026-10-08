// 打磨稿夹具生成器：写一份**覆盖全部显示状态**的假数据，给 design-preview 用。
//
//   node tools/preview-fixture.mjs [目标目录，默认 ../.preview-data/data] [device.json] [--errors] [--agent-stub] [--fast-focus] [--no-focus] [--scheduled] [--no-trash]
//
// `--errors` 多写一份同步冲突副本和一个坏 JSON，叫出界面顶上那两条横幅
// （判据和收回去的办法写在下面 `ERRORS` 那一段）。
// 「叫 AI」这条路**默认就是堵着的**（设置里的「命令行工具路径」指到一个不存在
// 的二进制）：任何一次调用都立刻真的失败，失败横幅因此是能量的一面，而这台服务
// 碰不到真额度。想要绿色那一面（拆解完成、AI 总览），带 `--agent-stub` 把「谁在
// 想」换成一份假 AI——理由写在下面 `AGENT_STUB` 那一段。
//
// 为什么要它：打磨稿要一眼看见「过期 N 天」「被父亲挡着」「等谁等了两周」
// 「艾宾浩斯背到第几步」这些记号，而任何一份真实数据都只碰得到其中几样。
// 日期全部按「现在」算，所以过期/今天/还有 N 天这些记号永远在场——写死日期
// 的夹具过一周就全变成「未来」，那一屏的红色记号集体消失，稿子看着像没问题。
//
// **有一面是响一次就收回去的**：dp-19 / dp-20 各挂一条「五分钟前」的提醒，
// 服务一起来就把它们发出去（界面顶上那两条横幅：两条以上走聚合那一档、带逐条
// 那两颗，只剩一条走「该做了：××」那一档）。发完 `firedAt` 就盖上章了，第二次
// 跑同一份数据看不到那一面——但稿子那两格（`drive.js` 的 `dueStack` / `dueOne`）
// 自己会经 `PATCH /api/tasks/:id` 重新挂一条，所以**不用重跑这份生成器**。
//
// **配套的第二件事必须一起做**：`--device` 写一份 device.json，把 `autoExpand`
// 关掉。夹具里有两条未拆的收件箱条目，而自动拆解默认是开的——不关掉的话，
// 这份服务起来几分钟就会真的去 spawn 一个命令行 AI，对着假数据烧一次额度。
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// 位置参数在前、开关在后：`node tools/preview-fixture.mjs <data目录> <device.json> --errors`
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
/**
 * **报错族那一面**：`--errors` 往 `tasks/` 里多写两个文件——一份同步冲突副本
 * （认名字的判据在 `server/src/entityStore.ts` 的 `CONFLICT_RE`）和一份读不出
 * 来的坏 JSON。界面顶上那两条横幅（「同步冲突：N 个文件」「有 N 个文件打不开」）
 * 只有这两样能叫出来，而它们不是「点了才出现」的状态：夹具不写，这一面就永远
 * 进不了表。
 *
 * 收回去不用改代码：**删掉这两个文件再重启那个夹具服务**。坏文件那份记在服务
 * 自己的内存里（`entityStore.readAll` 顺手记下的），不重启不会自己消失。
 */
const ERRORS = process.argv.includes('--errors');
/** 垃圾箱空着那一面：不铺那两条待删任务。见下面 `const trash` 那一段。 */
const NO_TRASH = process.argv.includes('--no-trash');
/**
 * 见下面写 device.json 那一段：**默认就把「命令行工具路径」指到一个不存在的
 * 二进制**，任何一次「叫 AI」都立刻真的失败——那既是失败横幅那一面可量的原因，
 * 也是这份夹具不该有的另一件事（拿真额度去拆假数据）不该发生的保险。
 */
/**
 * `--agent-stub` 把「叫 AI」这件事接在一份**假 AI**上（`tools/preview-agent-stub.mjs`）：
 * 服务照常 spawn、照常等退出码、照常合并产物，被换掉的只有「谁在想」。
 * 界面上那几条「跑完了」的回执（绿色的拆解完成、多行的 AI 总览）只能由一次
 * 真的运行发出来，而为一篇稿子烧一次真额度不值得、在稿子里编一条状态量的又不是
 * 这个应用自己的行为的——所以换进程，不换判据。
 *
 * 这一条要求夹具服务带着 `AGENT_CWD=<.preview-data 那一级>` 起来：`aiSeesSameData`
 * 那道守卫在服务读盘和 AI 读盘不是同一处时**在起进程之前**就拒绝（「拆解完成」
 * 那格第一次跑就是被它 409 下来的）。
 */
const AGENT_STUB = process.argv.includes('--agent-stub');
/** 「下次自动拆解」那条倒计时横幅那一面：见下面写 device.json 那一段的 `--scheduled`。 */
const SCHEDULED = process.argv.includes('--scheduled');
/**
 * 把一轮番茄缩短到一分钟（`focusMinutes` 的下限就是 1，服务端夹着，写不进 0）。
 * 「休息」那半段只有专注走完才会出现——那是一段真时间，稿子只能等，不能演。
 * 走这份文件而不是 `PUT /api/settings`：同一个理由（见下面写 device.json 那段，
 * 那条路会拿读回来的打码串原样写回去）。
 */
const FAST_FOCUS = process.argv.includes('--fast-focus');
/**
 * 抹掉每一条任务上的 `focusSessions`——只为一个面：专注统计在「一次都没专注过」
 * 时不画那三张图，改说一句话（判据在 FocusStats.tsx，那句里还留着补记入口）。
 * 夹具里 dp-04 挂着两条记录，那一面原来一次都没上过屏。
 */
const NO_FOCUS = process.argv.includes('--no-focus');
const DATA = ARGS[0] || join(process.cwd(), '..', '.preview-data', 'data');
const DEVICE = ARGS[1] || join(process.cwd(), '..', '.preview-data', 'device.json');
const NOW = new Date();
/** 相对「现在」的第 d 天、h 时 m 分，存成 ISO。 */
const at = (d, h = 9, m = 0) => {
  const x = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + d, h, m);
  return x.toISOString();
};
const iso = (d, h = 9, m = 0) => at(d, h, m);
/** 「现在往前 N 分钟」——给「到点横幅」那两条用，见下面 dp-19 的注释。 */
const minutesAgo = (min) => new Date(Date.now() - min * 60_000).toISOString();

const base = {
  notes: '', status: 'todo', due: null, startAt: null, endAt: null, persistentReminder: false,
  reminders: [], subtasks: [], source: 'user', aiComment: '', order: null, listId: null,
  section: null, tags: [], priority: 0, repeat: null, completedAt: null, postponeCount: 0,
  waitingFor: null, context: null, attachments: [], focusSessions: [], estimateMinutes: null,
  habit: false, pinned: false, reviewedAt: null, parentId: null,
};
const task = (id, title, over = {}) => ({
  ...base, id, title,
  createdAt: iso(-30), updatedAt: iso(-1),
  ...(over.overdue ? { due: over.overdue.due ?? iso(-3, 18), status: over.overdue.status ?? 'todo' } : {}),
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'overdue')),
});

const tasks = [
  task('dp-01', '给房东打个电话，问暖气什么时候试压', {
    context: 'contact', listId: 'L-home', tags: ['家里'], due: iso(1, 9),
    reminders: [{ at: iso(1, 8, 30), firedAt: null }],
  }),
  task('dp-02', '整理多巴胺排毒的方式与解决方法', {
    listId: 'L-work', tags: ['整理', '健康'], due: iso(0, 21), postponeCount: 5,
    notes: '## 方向\n\n把散在三个笔记里的东西收成一篇，能讲清**为什么**而不只是清单。\n\n- 触发点：刷短视频 40 分钟后\n- 替代：出门走 10 分钟\n\n> 原话：「不是要戒，是要把阈值调回去。」',
    reminders: [{ at: iso(0, 20), firedAt: null }, { at: iso(0, 18), firedAt: iso(0, 18, 2) }],
  }),
  task('dp-03', '写文章《凡士林的养护措施》', {
    overdue: {}, listId: 'L-home', tags: ['写作'], source: 'ai',
    aiComment: '原话里「记得写一下凡士林怎么用」既是一篇文章又是一个待办，按「能单独做完」切成一条；标了 #写作 是因为原文说了「发博客」。',
    notes: '大纲三段：\n\n1. 什么时候该用\n2. 和乳膏的区别\n3. 夏天要不要换',
  }),
  task('dp-04', '注册 Steam 账号并完成基础设置', {
    status: 'doing', listId: 'L-work', tags: ['账号'], due: iso(0, 21), estimateMinutes: 40,
    focusSessions: [
      { startedAt: iso(-2, 20), endedAt: iso(-2, 21), minutes: 60 },
      { startedAt: iso(-1, 9), endedAt: iso(-1, 9, 30), minutes: 30 },
    ],
    subtasks: [
      { text: '注册账号，完成邮箱验证', done: true },
      { text: '装手机版 Steam App，开启令牌两步验证', done: false },
      { text: '设置个人资料与隐私（好友、游戏库、库存可见性）', done: false },
      { text: '确认区域和支付方式', done: false },
    ],
  }),
  task('dp-05', 'Translation Occasionally Fails: LLM Does Not Receive SRT Content or Misinterprets Instructions', {
    status: 'doing', due: iso(0, 22), priority: 3, tags: ['bug'], listId: 'L-work',
    waitingFor: '上游维护者回 issue',
  }),
  task('dp-06', '把详情页的键盘走位补完', { parentId: 'dp-07', listId: 'L-work', status: 'todo' }),
  task('dp-07', '装修新房', {
    startAt: iso(8, 9), endAt: iso(8, 18), listId: 'L-home', tags: ['家里'],
    // 有附件的那一行（打开 / 删除两颗）在别的面上都不出现，而 `Attachments`
    // 那块只在「草稿态 或 附件非空」时渲染——磁盘上那份得一起铺好，点开
    // 「打开」才不会 404（文件名里别放 `:`，NTFS 会把它当交替数据流）。
    attachments: ['三家报价对比.txt'],
    subtasks: [{ text: '量尺寸', done: true }, { text: '找三家报价', done: false }, { text: '定风格', done: false }],
  }),
  task('dp-08', '每周复盘一次这季度的目标', {
    listId: 'L-work', due: iso(3, 20),
    repeat: { every: 'week', interval: 1, weekdays: [3], until: null, from: 'due', count: null, monthDay: null },
  }),
  task('dp-09', '背 30 个面试高频词', {
    tags: ['求职'], due: iso(1, 8),
    repeat: { every: 'ebbinghaus', interval: 1, count: 4, until: null, from: 'due' },
  }),
  task('dp-10', '每天喝八杯水', { habit: true, tags: ['健康'], repeat: { every: 'day', interval: 1 } }),
  task('dp-11', '一周健身三次', {
    habit: true, tags: ['健康'], due: iso(2, 19),
    repeat: { every: 'week', interval: 1, weekdays: [1, 3, 5] },
  }),
  task('dp-12', '把仓库的 README 过一遍', { status: 'done', completedAt: iso(0, 11), listId: 'L-work' }),
  task('dp-13', '研究一下 onepage 能不能替掉现在的笔记', { status: 'later', pinned: true, tags: ['工具'] }),
  task('dp-14', '把旧手机刷机卖掉', { status: 'abandoned', postponeCount: 9 }),
  task('dp-15', '给妈妈买生日礼物', { priority: 2, due: iso(3, 18), tags: ['家里'] }),
  task('dp-16', '清理 Downloads 里那批安装包', { context: 'computer', tags: ['整理'], listId: 'L-side' }),
  task('dp-17', '把 Discord 那个群的规则帖置顶', {
    context: 'easy', waitingFor: '群主通过申请',
  }),
  task('dp-18', '把这条特别特别长的中文任务标题用来验证窄卡上正文怎么折行以及右边那串元数据会不会被挤下去', {
    listId: 'L-side', tags: ['打磨'],
  }),
  // ── 「到点」那两条横幅。聚合版（一次两条以上）的标记完成那颗和点开那颗是
  //    另一套 DOM，一条都不摆出来；原来这份夹具只有 dp-02 一条挂着没发的提醒，
  //    于是那一面永远量不到。时刻按「现在减五分钟」算而不是钉钟点：跑的人
  //    什么时候跑都在服务端那 60 分钟的补发窗里。
  //    **这是一次性的面**：服务一发就把 `firedAt` 盖上，第二次跑同一份数据就没有
  //    横幅了。稿子里那两格（`drive.js` 的 `dueStack` / `dueOne`）自己会经
  //    `PATCH /api/tasks/:id` 重新挂一条，所以**不用重跑生成器**；手动想再看一遍
  //    的话，重跑生成器或者在网页上把那条提醒改到过去，都行。
  task('dp-19', '交季度总结，附上上季度对比', {
    due: iso(0, 18), listId: 'L-work', reminders: [{ at: minutesAgo(5), firedAt: null }],
  }),
  task('dp-20', '把暖气费交了，去年是微信付的', {
    due: iso(0, 19), listId: 'L-home', tags: ['家里'], reminders: [{ at: minutesAgo(6), firedAt: null }],
  }),
  // ── 月历上「+N 更多」那颗：一天要**四件**事（月档每格最多画三件）。
  //    +3 那天本来只有 dp-08、dp-15 两件，补两件凑过线——顺带让「接下来」
  //    那一屏有一天是明显比别的天挤的，那正是那一屏该有的样子。
  task('dp-21', '约物业看地下室漏水', { due: iso(3, 10), listId: 'L-home', tags: ['家里'] }),
  task('dp-22', '把车送去保养，顺便问轮胎', { due: iso(3, 15), listId: 'L-side' }),
  // ── 跨天的那两条：`startAt` 在过去、`due` 在未来，区间正走到中间。加之前这份
  //    夹具里没有一条是这样的——dp-07 那条 `startAt` 在 8 天后（还没开始），
  //    于是「第 N 天 · 共 M 天」那枚记号和头上那句「另 N 条在做着」从来没有
  //    真数据上过屏。第二条故意配一个长标题，量窄屏（390）上那一行会不会把
  //    右边的截止时间挤没。
  task('dp-23', '给新房客厅铺地板', {
    status: 'doing', startAt: iso(-3, 9), due: iso(5, 18), listId: 'L-home', tags: ['家里'],
    subtasks: [
      { text: '把三种地板的报价对比做完', done: true },
      { text: '约师傅下周开工', done: false },
    ],
  }),
  task('dp-24', '把 onepage 迁到这套任务系统的方案写完，分三步：数据对齐、导入脚本、旧笔记归档', {
    startAt: iso(-1, 9), due: iso(2, 20), listId: 'L-side', tags: ['打磨'], estimateMinutes: 180,
  }),
];

const inbox = [
  { id: 'in-01', text: '周五之前把季度总结交了，记得附上上季度对比', createdAt: iso(0, 8, 20), processed: false, taskIds: [] },
  { id: 'in-02', text: '妈妈生日下周三\n想买那个按摩仪，京东看看有没有券', createdAt: iso(-1, 22, 5), processed: false, taskIds: [] },
  { id: 'in-03', text: 'steam 游戏注册', createdAt: iso(-4, 10), processed: true, taskIds: ['dp-04'] },
  { id: 'in-04', text: '写文章 凡士林', createdAt: iso(-5, 12), processed: true, taskIds: ['dp-03'] },
];

const lists = [
  { id: 'L-work', name: '师爷', color: '#C2410C', folderId: 'F-365', order: 0, archived: false, filter: null },
  { id: 'L-home', name: '书斋', color: '#15803D', folderId: 'F-365', order: 1, archived: false, filter: null },
  { id: 'L-side', name: '副业', color: '#7E22CE', folderId: null, order: 2, archived: false, filter: null },
  // 一份**一条任务都没挂**的清单。加它只为一个面：那份清单的 ⋯ 里
  // 「让 AI 回顾这份清单」要带着括号里那半句理由（判据在 Sidebar.tsx），那是
  // 这一族最长的一行，而原来这份夹具里每一份清单都有活着的任务——那句最长的
  // 写法一次都没上过屏。**量下来它没被截**（antd 的下拉按内容自己变宽到
  // 260px），所以界面一个字没动；这份清单留着，是为了那一支随时可以再量。
  { id: 'L-empty', name: '读书', color: '#0F766E', folderId: null, order: 4, archived: false, filter: null },
  {
    id: 'L-smart', name: '本周到期', color: '#0E7490', folderId: null, order: 3, archived: false,
    filter: {
      status: [], listIds: [], tags: [], priority: [], contexts: [], dueWithinDays: 7,
      hasWaitingFor: false, text: '', tagsAll: false, noList: false, noTag: false,
      noDue: false, isRepeating: false, notStarted: false, estimateWithinMinutes: null, not: [],
    },
  },
];

const folders = [{ id: 'F-365', name: '365', order: 0 }];

const proposals = [
  {
    id: 'pr-01', taskId: 'dp-03', createdAt: iso(-1, 15),
    patch: { due: iso(4, 18), reminders: [{ at: iso(4, 9), firedAt: null }] },
    reason: '已经过期三天，而它排在「今天」这一组里；建议推到下周三，钟点照留。',
  },
  { id: 'pr-02', taskId: 'dp-02', createdAt: iso(-8, 9), dismissed: true, patch: { title: '多巴胺排毒（整理成一篇）' }, reason: '标题太长。' },
];

const insights = [
  {
    id: 'ins-01', kind: 'pattern', createdAt: iso(-2, 9), dismissedAt: null,
    text: '你的写作类任务清一色排在晚上十点以后，白天那些等于骗自己。', taskIds: ['dp-03', 'dp-02'],
  },
];

const countdowns = [
  { id: 'cd-01', title: '妈妈生日', date: dateStr(12), yearly: true, lunar: false, notes: '', createdAt: iso(-40), updatedAt: iso(-40) },
  { id: 'cd-02', title: '季度总结截止', date: dateStr(5), yearly: false, lunar: false, notes: '', createdAt: iso(-20), updatedAt: iso(-20) },
];
function dateStr(d) {
  const x = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

const dirs = ['tasks', 'inbox', 'lists', 'folders', 'proposals', 'insights', 'countdowns', 'trash'];
rmSync(DATA, { recursive: true, force: true });
for (const d of dirs) mkdirSync(join(DATA, d), { recursive: true });
mkdirSync(join(homedir(), '.config'), { recursive: true });
const write = (dir, rows) => { for (const r of rows) writeFileSync(join(DATA, dir, `${r.id}.json`), JSON.stringify(r, null, 2)); };
write('tasks', NO_FOCUS ? tasks.map((t) => ({ ...t, focusSessions: [] })) : tasks);
write('inbox', inbox);
write('lists', lists);
write('folders', folders);
write('proposals', proposals);
write('insights', insights);
write('countdowns', countdowns);

// ── 垃圾箱里放两条。软删除落盘的是 `data/trash/<id>.json`，形状 = 整条任务
//    再加一个 `deletedAt`（`server/src/store.ts` 的 `readTrash` 逐文件读，
//    `GET /api/trash` 发给界面）。原来这里一个文件都不铺，于是「垃圾箱」那一屏
//    永远只有空态，那两颗按钮（还原 / 彻底删除）和「清空垃圾箱（N）」那颗
//    一次都没进过表。
//    **反过来那一面（空的垃圾箱）要 `--no-trash`**：这两条一铺，「垃圾箱 · 空态」
//    那格量的就是有东西的一屏，标签成一句假话——所以那格现在带一条前置断言
//    （`drive.js` 的 `trashEmpty`），不带这个开关跑它报实话。**这一条也要重启那个
//    夹具服务**：服务把垃圾箱那份记在自己内存里，盘上删干净了 `GET /api/trash`
//    还照吐那两条（实测）。
const trash = NO_TRASH ? [] : [
  { ...base, id: 'dp-del-1', title: '订图书馆的讲座名额', listId: 'L-home', deletedAt: iso(-1, 16) },
  { ...base, id: 'dp-del-2', title: '把旧显示器挂上去卖', tags: ['整理'], deletedAt: iso(-4, 11) },
];
write('trash', trash);

// 附件在磁盘上的那一份（`data/attachments/<taskId>/<name>`，见
// `server/src/attachments.ts` 的 `attachmentsDir`）。只往 `Task.attachments`
// 里写名字不铺文件的话，那一行照样画出来，但「打开」是 404。
mkdirSync(join(DATA, 'attachments', 'dp-07'), { recursive: true });
writeFileSync(join(DATA, 'attachments', 'dp-07', '三家报价对比.txt'),
  '华宁 4.2 万 / 栖木 4.8 万 / 本地那家 3.9 万（不含水电）\n');
writeFileSync(join(DATA, 'meta.json'), JSON.stringify({ schemaVersion: 2 }, null, 2));

if (ERRORS) {
  const first = tasks[0];
  writeFileSync(join(DATA, 'tasks', `${first.id} (冲突副本).json`),
    JSON.stringify({ ...first, title: `${first.title}（这是冲突副本那份的标题）` }, null, 2));
  writeFileSync(join(DATA, 'tasks', 'broken-0001.json'), '{ 这一份不是合法 JSON');
}

// 设备配置：`autoExpand: false` 是这批夹具的**安全阀**，理由见文件顶部。
// `webhookUrl` 留空，免得桌面通知往外部打。
//
// **`aiCliPath` 默认指到一个不存在的二进制**：任何一次「叫 AI」（稿子里那几格
// 自己会打 `POST /api/expand`、`POST /api/board`）都立刻真的失败，界面上那条
// 失败横幅于是是能量的一面，而这台服务**没有任何一条路能碰到真额度**。以前不是
// 这样：以前 `aiCliPath` 留空的默认档，被「AI 拆解失败」那两格一驱动就真的
// spawn 了一个命令行 AI 去拆假数据（日志里留下的是一条 `unrecognized_model`，
// 那次没成，可它本可以成）。故意**不**用「打桩」那条路改设置——
// `PUT /api/settings` 回写会把读回来的**打码后**的密钥原样写回去（服务端认得那串打码，
// 不会把它当真密钥存下来，可它拿到的也只是打码串，**填进去的还是一把废钥匙**）；
// 夹具这台设备压根没配过接口，那扇门不该被稿子推开一次。
// 想要绿色那条「拆解完成」那一面，带 `--agent-stub` 重跑生成器（见上面那段）。
const SAFE_AI = !AGENT_STUB;
//
// `--scheduled` 打开 `autoExpand`，延迟拉到上限 3600 秒——收件箱里有没拆的条目，
// 服务一启动就排上一次「约 3599 秒后」，那条倒计时横幅（`ScheduledBanner`）于是
// 一直挂着，SSE 的重放缓冲让后开的页面也看得见它。**这一条跟上面几条不一样，
// 必须重启那个夹具服务**：排期是 `createAutoExpand` 起来时评估一次的，而
// `device.json` 在 `data/` 外面，不在文件监听器的名单里，改它不会惊动调度器。
// 一小时后那次真的触发烧的是那份假的 `aiCliPath`——上面那条默认已经把这条路堵了。
writeFileSync(join(DEVICE), JSON.stringify({
  webhookUrl: '', toastEnabled: false, autoExpand: SCHEDULED, autoExpandDelaySec: SCHEDULED ? 3600 : 60,
  focusMinutes: FAST_FOCUS ? 1 : 25, breakMinutes: FAST_FOCUS ? 1 : 5, dailySummaryAt: null, dailySummaryOn: null,
  defaultListId: null, defaultPriority: 0, defaultDue: 'none', defaultRemindMinutes: null,
  defaultTags: [], weekStart: 1, smartDate: true, smartStripDate: true, smartTag: true,
  smartStripTag: true, showLunar: true, showHolidays: true,
  aiMode: 'cli',
  aiCli: AGENT_STUB ? 'custom' : 'claude',
  aiCliPath: AGENT_STUB
    ? process.execPath
    : (SAFE_AI ? 'design-preview-没有这个二进制' : ''),
  aiCliCustomArgs: AGENT_STUB
    ? `"${join(dirname(fileURLToPath(import.meta.url)), 'preview-agent-stub.mjs')}" {prompt}`
    : '',
  // 接口配置现在是**一家一条记录**（`aiEndpoints` + `aiEndpointId`），
  // 旧版那三格平铺的 `aiBaseUrl`/`aiKey`/`aiModel` 已经不用了——服务端读到旧形状会
  // 派生成一条记录（`server/src/aiEndpoints.ts` 的 `withLegacyAi`），但写文件时
  // 直接写新形状，省得夹具里留一份没人认领的旧键。
  aiEndpointId: '', aiEndpoints: {},
}, null, 2));

const counts = { tasks: tasks.length, inbox: inbox.length, lists: lists.length, proposals: proposals.length, insights: insights.length, countdowns: countdowns.length, trash: trash.length };
console.log('fixture written to', DATA);
console.log(JSON.stringify(counts));
console.log('device.json →', DEVICE, SCHEDULED ? '(autoExpand 开，排期 3600 秒)' : '(autoExpand off)');
if (SCHEDULED) console.log('--scheduled：排上一次自动拆解（约 3600 秒后），那条倒计时横幅挂着——**要重启那个夹具服务才生效**（device.json 不在文件监听器的名单里）');
if (NO_FOCUS) console.log('--no-focus：抹掉所有专注记录（量「一次都没专注过」那一面；不带这个开关重跑即收回）')
if (FAST_FOCUS) console.log('--fast-focus：一轮番茄 1 分钟 + 休息 1 分钟（量「休息」那半段用；不带这个开关重跑即收回）')
if (ERRORS) console.log('--errors：多写了一份冲突副本 + 一个坏 JSON（收回请重跑不带这个开关的生成器）');
if (NO_TRASH) console.log('--no-trash：不铺那两条待删任务（量「垃圾箱是空的」那一面）——**要重启那个夹具服务**：服务把垃圾箱那份记在自己内存里，盘上删了 API 还照吐');
if (AGENT_STUB) console.log('--agent-stub：命令行工具换成一份假 AI（要服务带 AGENT_CWD=<上一级目录> 起，守卫才放行）');
