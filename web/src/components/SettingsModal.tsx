import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, ConfigProvider, Form, Input, InputNumber, Modal, Radio, Select, Space, Switch, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api.js';
import type { List, Settings, WeekStart } from '../types.js';
import { NAV_MODE_LABEL, type NavMode, type NavModes } from '../lib/navVisibility.js';
import { NAV_GROUPS, NAV_GROUP_LABEL, RAIL_GROUPS, type NavGroup } from '../lib/views.js';
import { REMIND_PRESETS } from '../lib/remindPreset.js';
import { boardLocalTheme } from '../theme.js';
import { ServerSetup } from './ServerSetup.js';
import { PRI_LABEL_ALL } from './TaskFields.js';

interface Props {
  open: boolean;
  /**
   * `null` = 这台服务的设置**一次都没成功读到过**（离线，或者在线时
   * `GET /api/settings` 出错）——不是「读到的是一份默认值」。见 App.tsx 里
   * `settings` state 的注释：`Settings` 这个类型本身分不出「真的读到」和
   * 「编出来的」，而 `onSave` PUT 的是整份，一份编出来的值被 PUT 回去就是
   * 桌面上真实配置的数据丢失（整分支审查 I1）。这里收 `null` 就是把那个
   * 状态摊到类型上，下面据此**那几页都不渲染表单**。
   */
  value: Settings | null;
  onClose: () => void;
  onSave: (s: Settings) => Promise<void>;
  /**
   * 导航上有哪些去处、哪些能选「有内容时显示」。**不是 `ViewDef[]`**——那个
   * 类型带着 `render`（一个闭包着 App 全部 state 的函数），这个面板只需要
   * 名字和一个布尔值，收整个 ViewDef 等于让设置面板依赖渲染层。
   */
  navOptions: Array<{ key: string; label: string; group: NavGroup; canAuto: boolean }>;
  /** 「新任务默认清单」那个下拉的候选表。跟 TaskFields 收的是同一份数据。 */
  lists: List[];
  navModes: NavModes;
  /** 存 localStorage 那半在 App 里（跟 density/groupSort 同一个形状）。 */
  onNavModes: (next: NavModes) => void;
}

/**
 * 设置分区。**照滴答清单那张设置弹层的左栏抄的**（它那边：账户与安全 / 高级
 * 会员 / 功能模块 / 智能清单 / 提醒与通知 / 日期与时间 / 外观 / AI 功能 /
 * 更多设置 / 关联与导入 / 共享协作 / 快捷键 / 关于）。
 *
 * 少掉的那几段是**这个应用里不存在的东西**，不是漏了：没有账户（本地优先、
 * 不登录）、没有会员、没有共享协作。「外观」也没有——这一套配色是这个应用的
 * 立意（暖纸 + 双色墨水，群青是配给制），做成可换的主题等于把它拆了。
 *
 * `needsDraft` = 这一页要不要「读得到服务上的设置」。分区里有两页不需要
 * （导航显示存 localStorage、服务地址存这台设备本地）——**离线时它们照样得
 * 能改**，尤其是服务地址：填错了那儿是唯一的救命通道。
 */
interface Section {
  key: string;
  label: string;
  needsDraft: boolean;
}

export const SETTING_SECTIONS: Section[] = [
  { key: 'modules', label: '功能模块', needsDraft: false },
  { key: 'lists', label: '智能清单', needsDraft: false },
  { key: 'notify', label: '提醒与通知', needsDraft: true },
  { key: 'datetime', label: '日期与时间', needsDraft: true },
  { key: 'defaults', label: '任务默认值', needsDraft: true },
  { key: 'smart', label: '智能识别', needsDraft: true },
  { key: 'ai', label: 'AI 拆解', needsDraft: true },
  { key: 'focus', label: '专注', needsDraft: true },
  { key: 'data', label: '数据与服务', needsDraft: false },
  { key: 'about', label: '关于', needsDraft: false },
];

/**
 * 三档在下拉里的顺序：**显示 → 有内容时显示 → 隐藏**，从「一直在」到「一直
 * 不在」是一条渐变，读下来是一句话。
 *
 * 写死一份顺序，不拿 `Object.keys(NAV_MODE_LABEL)`——那份表的键序是按
 * 「`NavMode` 这个联合类型怎么写的」来的（show/hide/auto），照它渲染会得到
 * 「显示 / 隐藏 / 有内容时显示」，中间那档跳过去又跳回来。一个类型定义的书写
 * 顺序不该决定下拉框的顺序。
 */
const NAV_MODE_ORDER: NavMode[] = ['show', 'auto', 'hide'];

/**
 * 「调接口」那栏的几个快捷地址。
 *
 * **这不是「支持哪几家」的白名单**——地址框本来就能自己填，填什么都行，只要它
 * 说 OpenAI 兼容的那套。这几条只是省掉去翻文档抄地址那一步，挑的是常见的、
 * 以及本机跑的那两个（那两个不要密钥，是「先试试看」成本最低的一条路）。
 *
 * 地址和模型名抄自同一个人维护的 subtitle-translator 那份 registry（那边按月
 * 对着各家文档核过），不是凭印象写的。模型名留空的两条是**本机运行时**：装了
 * 什么模型只有他自己知道，猜一个填进去只会让第一次调用报一个「模型不存在」。
 *
 * Google 那条走的是 Gemini 的 **OpenAI 兼容端点**（`/v1beta/openai/`），不是它
 * 原生的 `:generateContent`——写在这儿是因为地址长得不像别家，报 404 时得知道
 * 该去查哪一份文档。**这个地址实测过**（2026-08-30）：不带密钥 POST 一个空 body
 * 回的是 `400 model is not specified`，说明路径存在且就是那个 chat 端点；同一手法
 * 打一个故意写错的路径回 404。别凭印象改它。
 */
const AI_PRESETS: Array<{ label: string; url: string; model: string }> = [
  { label: 'Google AI Studio', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.7-flash' },
  { label: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5.6-luna' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash' },
  { label: '硅基流动', url: 'https://api.siliconflow.cn/v1/chat/completions', model: 'deepseek-ai/DeepSeek-V4-Flash' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: '' },
  { label: 'Ollama（本机）', url: 'http://127.0.0.1:11434/v1/chat/completions', model: '' },
  { label: 'LM Studio（本机）', url: 'http://127.0.0.1:1234/v1/chat/completions', model: '' },
];

/** 「默认标签」那个框：逗号分开的一行字 ←→ 字符串数组。中英文逗号都认——
 *  中文输入法下打出来的是全角逗号，为这个让人回去改一遍是没道理的。 */
const parseTags = (s: string): string[] =>
  [...new Set(s.split(/[,，]/).map((x) => x.trim()).filter(Boolean))];

export function SettingsModal({ open, value, onClose, onSave, navOptions, navModes, onNavModes, lists }: Props) {
  const { message } = AntApp.useApp();
  /**
   * 「测试连接」那颗的状态。`null` = 还没测过（不画结果条）。
   *
   * **改了任何一格就清空**：一条绿色的「连接成功」挂在已经被改过的地址旁边，
   * 比没有结论更糟——他会以为新填的这个也验过了。跟 `ServerSetup` 那颗同一条规矩。
   */
  const [aiTest, setAiTest] = useState<{ testing: boolean; error?: string | null }>({ testing: false });
  // 草稿跟着 value 可空——**没读到设置就没有草稿**，也就没有任何东西可以被
  // 保存。这不是「渲染出表单再拦住保存」（那样 `draft` 里仍然躺着一份编出来
  // 的值，下一处疏忽就能把它送出去），是这个状态下压根不存在可 PUT 的对象。
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [section, setSection] = useState('modules');

  // 每次打开都从当前设置重新起草：弹层关掉时组件不卸载，
  // 不同步的话上次改了没保存的草稿会一直留着。
  useEffect(() => {
    if (open) setDraft(value);
  }, [open, value]);

  const save = async () => {
    // draft 为空时那几页根本不渲染表单，这里走不到——但 save 是个独立的函数，
    // 类型收窄需要这一句，不是第二道防线。
    if (!draft) return;
    setBusy(true);
    try {
      await onSave(draft);
      onClose();
    } catch (e) {
      // 保存失败就别关弹层——草稿还在，用户能直接重试，不用重填一遍。
      void message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // data/ 下三个常驻文件加设备本地的设置，一起现读一遍打包下载——data/ 那
  // 三份是唯一一份，.bak 只保得住最近一次写入，过几分钟一写就没了；设置
  // 虽然不在 data/ 里，但这份导出是给人看的「现状快照」，物理上存在哪不
  // 重要，一起打包才是完整的备份。客户端直接拼，不用另开一个后端接口：
  // GET /api/inbox、/api/tasks、/api/settings、/api/proposals 已经能把这
  // 四份原样吐出来。文件名带时间戳，连着导出几次不会互相覆盖。
  const exportData = async () => {
    setExporting(true);
    try {
      // **八张表一张不落。** 这里原来只导四样（inbox/tasks/settings/proposals），
      // 而 `store.ts` 的 `paths()` 有八个目录——清单、文件夹、纪念日、观察、
      // 垃圾箱全都不在导出里，JSON 里连那几个键都没有。旁边那段文案把这份导出
      // 说成「自己给自己多买一层」保险，照它当唯一备份的人，丢了 `data/` 之后
      // 才会发现十几份清单和几十条纪念日一条都没有。
      //
      // `conflicts.ts` 遇到同一个问题时是遍历 `Object.entries(paths())` 解决的，
      // 那边的注释专门讲了「别手抄一份表名单」。这里够不着服务端的 `paths()`
      // （web 侧只有 HTTP 接口），所以是手写的八条 + 下面那条守卫盯着它别再漏。
      const [inbox, tasks, settings, proposals, lists, folders, countdowns, insights, trash] = await Promise.all([
        api.inbox(), api.tasks(), api.settings(), api.proposals(),
        api.lists(), api.folders(), api.countdowns(), api.insights(), api.trash(),
      ]);
      const payload = { inbox, tasks, settings, proposals, lists, folders, countdowns, insights, trash };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `办事师爷数据-${dayjs().format('YYYYMMDD-HHmmss')}.json`;
      // 必须先挂到文档里再点——有的浏览器对游离于 DOM 之外的 <a> 不触发下载。
      // revoke 也不能跟 click() 同一拍：click() 只是把下载排上队，浏览器真正
      // 读取 blob 内容是异步的，同一 tick 就撤销 URL 会撞上「文件是空的」或者
      // 下载直接被取消——FileSaver.js 延迟 revoke 就是为了躲开这个坑。
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      void message.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  /** 一段「导航显示」的列表。`modules` 和 `lists` 两页各渲染一半，判据是
   *  `RAIL_GROUPS`（哪几段画在竖栏上）——跟界面本身同一份判据，不手抄。 */
  const navList = (groups: NavGroup[]): ReactNode => groups.map((g) => {
    const inGroup = navOptions.filter((o) => o.group === g);
    if (inGroup.length === 0) return null;
    return (
      <Fragment key={g}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '10px 0 2px' }}>
          {NAV_GROUP_LABEL[g]}
        </Typography.Paragraph>
        <ul className="ink-navmode-list">
          {inGroup.map((o) => (
            <li className="ink-navmode-row" key={o.key}>
              <span className="ink-navmode-label">{o.label}</span>
              <select
                className="ink-navmode-select"
                aria-label={`${o.label}的显示方式`}
                value={navModes[o.key] ?? 'show'}
                onChange={(e) => onNavModes({ ...navModes, [o.key]: e.target.value as NavMode })}
              >
                {NAV_MODE_ORDER
                  .filter((m) => m !== 'auto' || o.canAuto)
                  .map((m) => <option key={m} value={m}>{NAV_MODE_LABEL[m]}</option>)}
              </select>
            </li>
          ))}
        </ul>
      </Fragment>
    );
  });

  /**
   * 这一页的正文。**每一页自己是一段 JSX，不是一张大表单被 CSS 藏起来**——
   * 藏起来的话，一次保存会把十几个没在屏幕上的控件一起提交，而且读屏会把
   * 所有页的内容一次读完。
   */
  const pane = (): ReactNode => {
    if (section === 'modules') {
      return (
        <>
          <p className="ink-set-lead">
            用不上的模块可以收起来。这几项画在最左那条模块栏上（手机上是最上面那一条）。
          </p>
          {navList(RAIL_GROUPS)}
        </>
      );
    }

    if (section === 'lists') {
      return (
        <>
          <p className="ink-set-lead">
            侧栏上那几个去处。「有内容时显示」只有导航上会挂数字的那几项才选得了——没有那个数字就答不出「有没有内容」。<b>正在看的那一项不会被藏起来</b>，切走之后才生效。
          </p>
          {navList(NAV_GROUPS.filter((g) => !RAIL_GROUPS.includes(g)))}
        </>
      );
    }

    if (section === 'data') {
      return (
        <>
          <Typography.Title level={3} style={{ marginTop: 0 }}>服务地址</Typography.Title>
          {/* 手机连桌面「办事师爷」服务用的地址——见 ServerSetup.tsx 顶部注释。
              这里是**唯一**能填这个地址的地方，而且**这一页不需要读到设置**
              （`needsDraft: false`）：离线时那几页整张表单都不渲染，把它放进
              需要草稿的页里等于「连不上的时候没法填连接地址」。 */}
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            手机连桌面上「办事师爷」服务用的地址，形如 http://192.168.1.5:30035
            （局域网 IP + 端口）。留空表示直接用当前页面本身的服务——桌面版通常应该留空。
          </Typography.Paragraph>
          <ServerSetup />

          <Typography.Title level={3} style={{ marginTop: 20 }}>备份</Typography.Title>
          <Button loading={exporting} onClick={() => void exportData()}>导出数据</Button>
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
            把 data/ 下的八样——任务、收件箱、清单、文件夹、AI 建议、跨任务观察、倒数纪念日、垃圾箱——连同这里的设置，一起打进一个 JSON 文件下载。
            data/ 下现在没有 .bak 这层保险了（历史版本交给同步服务），这份导出就是自己给自己多买一层。
          </Typography.Paragraph>
        </>
      );
    }

    if (section === 'about') {
      return (
        <>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
            数据存在这个文件夹的 data/ 下（inbox/、tasks/、proposals/ 三个目录，一条记录一个文件）。AI 不直接改这些文件，只写 outbox-*.json，服务发现后自动合并进去再删掉它——所以 data/ 下偶尔会看到一闪而过的 outbox-*.json，是正常现象。这里的设置（webhook 地址、系统通知开关……）不在 data/ 里，存在这台机器本地，不会跟着 data/ 一起同步到别的设备——手机上关掉系统通知，电脑上的不会跟着没。这个页面会跟着改动自己刷新。
          </Typography.Paragraph>

          {/* 回顾**已经有按钮了**（回顾那一屏底部那颗「让 AI 回顾一遍」）。这一块
              留着是为另一件按钮做不到的事：**排一个定期的节奏**。服务会自己排拆解
              （设置里有延迟），但不会替他排回顾——回顾每次都要把所有任务读一遍、
              想一遍，任务没变化也照样烧掉一两分钟和一次额度，多密算合适只有他知道。
              所以这里给的是那条能被定时任务调用的命令，不是又一颗按钮。 */}
          <div className="ink-cmd-hint">
            <p className="ink-cmd-title">让回顾定期自己跑一遍</p>
            <p className="ink-cmd-line"><code className="ink-mono">/review</code></p>
            <p className="ink-cmd-body">想立刻跑一次，不用记这条命令——「回顾」那一屏底部有一颗「让 AI 回顾一遍」。这条命令是给<b style={{ fontWeight: 600 }}>定期跑</b>用的：拆解的节奏服务替你排了，回顾的没有。想一周过一遍，就用系统的计划任务定时跑一次这条。
            </p>
            <p className="ink-cmd-body">
              跑的地方是 AI 的工作目录——从源码启动就是这个仓库，装的桌面版是
              <code className="ink-mono">%APPDATA%\shiye\agent</code>。在那个文件夹里开一个
              AI 编程工具的会话敲这条，或者直接说「回顾一遍现有任务」。
            </p>
            <p className="ink-cmd-body">
              别排太密：每次都要把所有任务读一遍，任务没变化也照样花一两分钟和一次 AI 额度。一天一次到一周一次是合理区间。
            </p>
          </div>
        </>
      );
    }

    // 下面这几页都要草稿。一次都没读到过设置（离线，或者在线时 /api/settings
    // 出错）：**整张表单不渲染**，不是「渲染出来再禁用保存按钮」——见上面
    // Props.value 的注释，没有草稿就没有能 PUT 回去的东西。
    if (!draft) {
      return (
        <p className="ink-empty-note">
          {/* **不说「左边的」**：分区栏只有宽屏才在左边，手机上它是顶上一条横向的带子
              （`theme.css` 里 `max-width: 767px` 那节）。写死方位的话，照着这句话去
              左边找的人在手机上找不到——而手机正是最容易连不上服务、最会看到这句话的
              那一档。改成按名字指路，跟方位无关。 */}
          还没读到这台服务上的设置。这几项存在跑「办事师爷」服务的那台机器上，连不上就读不到，也就没法在这里改——连上之后重新打开这个面板就能看到。另一节「数据与服务」不受影响，那里的服务地址随时能改。
        </p>
      );
    }

    /* Switch 的选中态直接读 token.colorPrimary，antd 6 没给它留一个组件级
       token 能单独覆盖这个颜色（见 theme.ts 顶部注释）。局部 ConfigProvider
       把这一小块子树的 colorPrimary 压回你的墨——这些开关都是纯粹的设置项，
       不是 AI 产出的东西，打开时不该显示群青。官方支持的嵌套主题机制，不是
       行内样式，也不是 CSS hack。boardLocalTheme 是跟 TaskBoard.tsx 共用的
       同一份具名导出，不是这里再 inline 一份。 */
    return (
      <ConfigProvider theme={boardLocalTheme}>
        {/* ink-settings-form：拉开每一项之间的距离。antd 默认的间距下，一项的
            说明文字跟下一项的标签挨得跟它自己的控件一样近，几项设置糊成一段。 */}
        <Form layout="vertical" className="ink-settings-form">
          {section === 'notify' && (
            <>
              <Form.Item label="系统通知" help="到提醒时间弹一条 Windows 通知。只在 Windows 上有效。">
                <Switch
                  checked={draft.toastEnabled}
                  onChange={(v) => setDraft({ ...draft, toastEnabled: v })}
                />
              </Form.Item>
              <Form.Item label="每日概览" help="每天这个时刻推一条「今天有什么」（过期的和今天到期的）。留空 = 不推。一件事都没有的那天不会打扰你。">
                <Input
                  value={draft.dailySummaryAt ?? ''}
                  placeholder="HH:MM，比如 08:30"
                  aria-label="每日概览的时刻"
                  onChange={(e) => setDraft({ ...draft, dailySummaryAt: e.target.value.trim() || null })}
                />
              </Form.Item>
              <Form.Item label="Webhook" help="到提醒时间就把任务 POST 过去（JSON）。留空就不发。">
                <Input
                  value={draft.webhookUrl}
                  placeholder="https://…"
                  // **不叫「服务地址」**——那是 ServerSetup 里那个框的名字
                  // （手机连桌面服务用的地址），两个框重名会让「按名字找」的
                  // 测试和读屏都分不出是哪一个。
                  aria-label="Webhook 地址"
                  onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })}
                />
              </Form.Item>
            </>
          )}

          {section === 'datetime' && (
            <>
              <Form.Item label="每周开始于" help="日历上月格/周格从周几起头，星期表头跟着转。">
                <Select
                  aria-label="每周开始于"
                  value={draft.weekStart}
                  onChange={(v: WeekStart) => setDraft({ ...draft, weekStart: v })}
                  /* 三档跟滴答清单一样（`常见问题.md`「如何设置一周开始于」：
                     周日 / 周一 / 周六）。顺序照它那边，周一在最前是因为它是默认。 */
                  options={[{ value: 1, label: '周一' }, { value: 0, label: '周日' }, { value: 6, label: '周六' }]}
                  style={{ width: 160 }}
                />
              </Form.Item>
              <Form.Item label="显示农历" help="日号底下那半行小字：节气、传统节日、农历日。一格只写一样，节气优先。">
                <Switch
                  aria-label="显示农历"
                  checked={draft.showLunar}
                  onChange={(v) => setDraft({ ...draft, showLunar: v })}
                />
              </Form.Item>
              <Form.Item label="显示节假日" help="法定节假日标「休」，调休要上班的周末标「班」。数据来自国务院办公厅每年的放假通知，只标到有通知的那一年为止——再往后一天不标，不会替它猜。">
                <Switch
                  aria-label="显示节假日"
                  checked={draft.showHolidays}
                  onChange={(v) => setDraft({ ...draft, showHolidays: v })}
                />
              </Form.Item>
            </>
          )}

          {section === 'defaults' && (
            <>
              <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
                这几项<b>只影响手工建的那条路</b>（列表顶上那一行「添加任务」和新任务表单）。AI 拆出来的任务归哪个清单、排哪一天，是它读了你那句话之后的判断，不该被这台机器上的一个偏好盖掉。
              </Typography.Paragraph>
              <Form.Item label="默认清单">
                <Select
                  aria-label="新任务默认清单"
                  value={draft.defaultListId ?? ''}
                  onChange={(v: string) => setDraft({ ...draft, defaultListId: v || null })}
                  options={[
                    { value: '', label: '不预填' },
                    ...lists.filter((l) => !l.archived && l.filter === null).map((l) => ({ value: l.id, label: l.name })),
                  ]}
                  style={{ width: 220 }}
                />
              </Form.Item>
              <Form.Item label="默认优先级">
                <Select
                  aria-label="新任务默认优先级"
                  value={draft.defaultPriority}
                  onChange={(v: 0 | 1 | 2 | 3) => setDraft({ ...draft, defaultPriority: v })}
                  options={([0, 1, 2, 3] as const).map((p) => ({ value: p, label: p === 0 ? '不预填' : PRI_LABEL_ALL[p] }))}
                  style={{ width: 160 }}
                />
              </Form.Item>
              <Form.Item label="默认日期" help="预填的时刻是那天 23:59，跟日历上「在这天新建」一致——零点会被当成一个真实时刻，那天 00:01 就标成过期。">
                <Select
                  aria-label="新任务默认日期"
                  value={draft.defaultDue}
                  onChange={(v: Settings['defaultDue']) => setDraft({ ...draft, defaultDue: v })}
                  options={[
                    { value: 'none', label: '不预填' },
                    { value: 'today', label: '今天' },
                    { value: 'tomorrow', label: '明天' },
                  ]}
                  style={{ width: 160 }}
                />
              </Form.Item>
              <Form.Item label="默认提醒" help="只在这条新任务真的有截止时间时才落——没有截止时间就没有「提前」的参照物。">
                <Select
                  aria-label="新任务默认提醒"
                  value={draft.defaultRemindMinutes ?? -1}
                  onChange={(v: number) => setDraft({ ...draft, defaultRemindMinutes: v < 0 ? null : v })}
                  options={[
                    { value: -1, label: '不预设' },
                    ...REMIND_PRESETS.map((p) => ({ value: p.minutes, label: p.label })),
                  ]}
                  style={{ width: 200 }}
                />
              </Form.Item>
              <Form.Item label="默认标签" help="用逗号分开。站在某个标签那一屏里新建时，那个标签说了算，不叠加。">
                <Input
                  // `?? []` 不是多余的：`Settings` 是从网线上来的，而对面那台
                  // 服务可能还是旧版本（新字段那时候还不存在）——这个应用的
                  // 桌面端和手机端本来就可以各自更新。少了这一句，连上一台旧
                  // 服务就是整张设置弹层白屏（实测：`.join` of undefined）。
                  value={(draft.defaultTags ?? []).join(', ')}
                  placeholder="比如 工作, 紧急"
                  aria-label="新任务默认标签"
                  onChange={(e) => setDraft({ ...draft, defaultTags: parseTags(e.target.value) })}
                />
              </Form.Item>
            </>
          )}

          {section === 'smart' && (
            <>
              <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
                加任务时从标题里认日期和标签：「明天下午两点交周报 #工作」直接变成一条排在明天 14:00、打了 #工作 的任务。识别是本机一条正则，不是 AI。它会误判——「3 月 5 号那版方案」里那个日期是标题的一部分——所以每一档都能单独关掉。
              </Typography.Paragraph>
              {/* 情境为什么不在下面那几个开关里：**它误判不了。** 那几个开关存在的
                  理由就是上面那句「它会误判」，而 `@` 后面必须紧跟着五个固定词之一
                  才算数。不说这一句的话，把两个开关都关掉、`@外出` 照样认，看起来
                  就是个 bug。 */}
              <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                情境（<code>@外出</code>）也认，但<strong>不在下面这几个开关里</strong>：它只匹配那五个固定的词，误判不了，所以一直开着。
              </Typography.Paragraph>
              <Form.Item label="识别日期" help="连「每周一」这种重复说法一起——认出来的重复和它的锚点日期是同一次识别的两半。">
                <Switch checked={draft.smartDate} onChange={(v) => setDraft({ ...draft, smartDate: v })} />
              </Form.Item>
              <Form.Item label="把日期从标题里摘掉" help="关掉之后日期照样设上，那几个字还留在标题里——「10 月 1 日国庆值班」摘掉就只剩「国庆值班」了。">
                <Switch
                  checked={draft.smartStripDate}
                  disabled={!draft.smartDate}
                  onChange={(v) => setDraft({ ...draft, smartStripDate: v })}
                />
              </Form.Item>
              <Form.Item label="识别标签" help="标题里的 #工作 变成标签。">
                <Switch checked={draft.smartTag} onChange={(v) => setDraft({ ...draft, smartTag: v })} />
              </Form.Item>
              <Form.Item label="把标签从标题里摘掉" help="关掉之后 #工作 既进标签、也留在标题里（会被挪到标题末尾）。">
                <Switch
                  checked={draft.smartStripTag}
                  disabled={!draft.smartTag}
                  onChange={(v) => setDraft({ ...draft, smartStripTag: v })}
                />
              </Form.Item>
            </>
          )}

          {section === 'ai' && (
            <>
              {/* **摆在这一节最上面**：下面「自动拆解」那两格描述的是「什么时候拆」，
                  而这一格决定「谁来拆」——没这一格的时候，没装 Claude Code 的人打开
                  这一屏只能看到两个开关，看不出为什么点了拆解永远报「命令行工具没找到」。 */}
              <Form.Item label="怎么叫 AI" help="本机命令行本事最大（能自己反复读文件、自己纠错），代价是这台机器上要装 Claude Code。调接口只要一个地址加密钥，任何 OpenAI 兼容的服务都行。">
                <Radio.Group
                  value={draft.aiMode}
                  optionType="button"
                  buttonStyle="solid"
                  onChange={(e) => setDraft({ ...draft, aiMode: e.target.value as Settings['aiMode'] })}
                  options={[
                    { value: 'cli', label: '本机 Claude Code' },
                    { value: 'api', label: '调接口' },
                  ]}
                />
              </Form.Item>

              {draft.aiMode === 'api' && (
                <>
                  <Form.Item label="接口地址" help="OpenAI 兼容的对话接口。点上面的名字填一个常见的，也可以自己写——完整地址、或者只写到 /v1 都认。">
                    {/* 快捷地址用 `Tag.CheckableTag` 而不是下拉：这几条是**起点**不是选项，
                        点完还能接着改地址框。下拉会让人以为只能选里头这几个。 */}
                    <Space size={[4, 4]} wrap style={{ marginBottom: 8 }}>
                      {AI_PRESETS.map((p) => (
                        <Tag.CheckableTag
                          key={p.label}
                          checked={draft.aiBaseUrl === p.url}
                          // 模型名只在这条预置**带**模型名时才跟着改：本机那两条的
                          // 模型名留空，不能拿空串把他已经填好的模型名冲掉。
                          onChange={() => { setDraft({ ...draft, aiBaseUrl: p.url, ...(p.model ? { aiModel: p.model } : {}) }); setAiTest({ testing: false }); }}
                        >
                          {p.label}
                        </Tag.CheckableTag>
                      ))}
                    </Space>
                    <Input
                      value={draft.aiBaseUrl}
                      placeholder="https://…/v1/chat/completions"
                      onChange={(e) => { setDraft({ ...draft, aiBaseUrl: e.target.value }); setAiTest({ testing: false }); }}
                    />
                  </Form.Item>
                  <Form.Item label="模型" help="原样发给接口。各家叫法不一样，照它文档里写的填。">
                    <Input
                      value={draft.aiModel}
                      placeholder="gemini-3.7-flash"
                      onChange={(e) => { setDraft({ ...draft, aiModel: e.target.value }); setAiTest({ testing: false }); }}
                    />
                  </Form.Item>
                  <Form.Item label="密钥" help="只存在这台机器上，读回来的是打码后的形状（改了才会覆盖）。本机跑的 Ollama / LM Studio 不要密钥，留空就行。">
                    <Input.Password
                      value={draft.aiKey}
                      autoComplete="off"
                      placeholder="留空 = 不带密钥"
                      onChange={(e) => { setDraft({ ...draft, aiKey: e.target.value }); setAiTest({ testing: false }); }}
                    />
                  </Form.Item>
                  {/* **一颗「测试连接」**，跟「数据与服务」那一屏的服务地址同一个做法。
                      没有它的话，填完这三格唯一的验证方式是真跑一次拆解——要等一两
                      分钟、烧一次额度，而失败是以看板顶上一条红横幅的形式出现的，
                      离刚填的这三个框十万八千里。

                      它打的是一次一句话的调用（不是把 AGENTS.md 全文贴过去的那份
                      提示词），几乎不花钱，见 server 那边 `testAi` 的注释。 */}
                  <Form.Item label=" " colon={false}>
                    <Button
                      loading={aiTest.testing}
                      onClick={() => {
                        setAiTest({ testing: true });
                        void api.testAi({ baseUrl: draft.aiBaseUrl, model: draft.aiModel, apiKey: draft.aiKey })
                          .then((r) => setAiTest({ testing: false, error: r.ok ? null : r.error }))
                          // 离线（`offlineUnsupported`）和网络本身出错都走这儿——
                          // 这两种也是「没测成」，照样要给他一句话，不能静默。
                          .catch((e: Error) => setAiTest({ testing: false, error: e.message }));
                      }}
                    >
                      测试连接
                    </Button>
                    {aiTest.error !== undefined && !aiTest.testing && (
                      <Alert
                        style={{ marginTop: 8 }}
                        type={aiTest.error === null ? 'success' : 'error'}
                        showIcon
                        message={aiTest.error === null ? '连接成功，这三格都填对了。' : aiTest.error}
                      />
                    )}
                  </Form.Item>
                </>
              )}

              <Form.Item label="自动拆解" help="收件箱出现还没处理的条目，等一段时间没有新动静就自动拆一次；拆不动的条目不会无限重试，「重新拆解」或点「立即拆解」能让它重新排上。">
                <Switch
                  checked={draft.autoExpand}
                  onChange={(v) => setDraft({ ...draft, autoExpand: v })}
                />
              </Form.Item>
              <Form.Item label="自动拆解延迟" help="连着记好几条只算一批，每来一条重新计时。10～3600 秒，默认 60。">
                {/* 关掉加减箭头，理由同 FocusStats 里那处：1×15px 够不着，
                    而且 aria-label 是写死的英文，antd 的 locale 覆盖不到。 */}
                <InputNumber
                  controls={false}
                  min={10}
                  max={3600}
                  value={draft.autoExpandDelaySec}
                  disabled={!draft.autoExpand}
                  addonAfter="秒"
                  onChange={(v) => setDraft({ ...draft, autoExpandDelaySec: typeof v === 'number' ? v : draft.autoExpandDelaySec })}
                />
              </Form.Item>
            </>
          )}

          {section === 'focus' && (
            <>
              <Form.Item label="专注时长" help="卡片上「开始专注」倒计时多久。1～180 分钟，默认 25。">
                <InputNumber
                  min={1}
                  max={180}
                  value={draft.focusMinutes}
                  addonAfter="分钟"
                  onChange={(v) => setDraft({ ...draft, focusMinutes: typeof v === 'number' ? v : draft.focusMinutes })}
                />
              </Form.Item>
              <Form.Item label="休息时长" help="一轮专注走完之后歇多久。0 = 不休息，走完直接回到「开始专注」。0～60 分钟，默认 5。">
                <InputNumber
                  min={0}
                  max={60}
                  value={draft.breakMinutes}
                  addonAfter="分钟"
                  onChange={(v) => setDraft({ ...draft, breakMinutes: typeof v === 'number' ? v : draft.breakMinutes })}
                />
              </Form.Item>
            </>
          )}
        </Form>
      </ConfigProvider>
    );
  };

  const current = SETTING_SECTIONS.find((s) => s.key === section);
  // 保存那颗只在「这一页真有服务端设置可存」的时候出现。导航显示存
  // localStorage、服务地址自己管自己的保存（而且保存后会整页刷新），
  // 摆一颗对它们没用的按钮只会让人以为没点它就没生效。
  const showSave = !!current?.needsDraft && !!draft;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
      title="设置"
      className="ink-setmodal"
      classNames={{ body: 'ink-set' }}
      destroyOnHidden
    >
      {/* 左边一列分区、右边正文——照滴答清单那张设置弹层的形状。
          `role="tablist"` 而不是一列普通按钮：读屏会报「10 个中的第 3 个」，
          方向键也能切。 */}
      <nav className="ink-set-nav" role="tablist" aria-label="设置分区">
        {SETTING_SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={section === s.key}
            className={`ink-set-navitem${section === s.key ? ' ink-set-navitem-active' : ''}`}
            onClick={() => setSection(s.key)}
          >{s.label}</button>
        ))}
      </nav>
      <div className="ink-set-pane">
        <div className="ink-set-body">
          <h2 className="ink-set-title">{current?.label}</h2>
          {pane()}
        </div>
        {showSave && (
        <div className="ink-set-foot">
          {/* color="default"：全站约定，你自己按的按钮一律不用 type="primary"
              ——primary 会拿 colorPrimary 也就是群青，那是 AI 的颜色。
              variant 才表示分量：这颗是这个面板里唯一的确认动作，用 solid。

              **一颗按钮存整份设置**，不是只存当前这一页：`draft` 里躺的本来
              就是完整的一份，PUT 的也是完整的一份。分页只是屏幕上的事。

              **这里必须用 JSX 注释，不能用双斜杠那种**：包一层 div 之后这里
              就成了 JSX 的孩子，双斜杠开头的那几行会被原样当成文字印在按钮
              上面——实测过一次，整段注释出现在了设置弹层里。 */}
          <Button color="default" variant="solid" loading={busy} onClick={() => void save()}>
            保存
          </Button>
        </div>
        )}
      </div>
    </Modal>
  );
}
