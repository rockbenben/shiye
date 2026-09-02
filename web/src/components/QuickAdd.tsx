import { useMemo, useState } from 'react';
import { App as AntApp, Button } from 'antd';
import type { Task } from '../types.js';
import type { StatusFilter } from '../lib/taskView.js';
import { parseSmartInput } from '../lib/smartInput.js';
import { smartDraft, type ComposeDefaults } from '../lib/composeDefaults.js';
import { createdNote } from '../lib/createdNote.js';
import { presetToRemindAt } from '../lib/remindPreset.js';
import { emptyDraft, type TaskDraft } from './TaskFields.js';

interface Props {
  onCreate: (draft: TaskDraft) => Promise<Task>;
  /** 当前在哪个视图。决定预填什么（`defaults` 已经算好了）和建完说不说话。 */
  view: string;
  /** 「按来源」当前的状态筛选，只用来判断新卡会不会被筛选挡住。 */
  boardFilter: StatusFilter;
  now: Date;
  /** 跟「新任务」表单同一份预填，`lib/composeDefaults.ts` 算的。 */
  defaults: ComposeDefaults;
  /**
   * 左边多让 28px，跟能拖着排序的任务行对齐（`.ink-trow-draggable`）。
   *
   * 「今天」的行左边常驻一段空位给排序抓手，不让这一段的话，这一行的「+」比
   * 它下面每一个勾选圈都往左 24px——**一列东西差 24px 是看得出来的**，而这一
   * 行存在的意义就是「它是这一列的第一行」。别的去处的行不留那段空位，让了
   * 反而错开。
   */
  indent?: boolean;
  /**
   * 下面那片东西铺满整列（卡片网格 / 「按来源」的瀑布流），这一行也跟着铺满。
   *
   * 这一行封顶在 `--row-measure`，那是**行档**的宽度：行档下面的
   * `.ink-row-list` 也封在同一个 token 上，两条右边界严丝合缝。卡档不是——
   * `.ink-card-grid` 铺满整列，于是这一行会比它下面的卡片短一大截：实测 1280
   * 下短 46px，**1920 下短 686px**（这一行停在 1192，卡片一直铺到 1878）。
   *
   * 这正是 `.ink-quickadd-wrap` 那条注释里记着的老毛病换了个密度又犯一次：
   * 「右边界跟下面每一行对不齐的话，它看上去就不属于这一列了」。上一次修的
   * 是行档从 `--measure` 换到 `--row-measure` 之后没跟上，只修了行档那一半。
   */
  wide?: boolean;
  /**
   * 开那张完整的表单（备注、子任务、重复、附件……）。
   *
   * **摆在输入框右端**，照滴答清单的文档写的：「在任务列表页顶部的『任务添加栏』
   * 输入内容，按回车键即创建成功……点击**输入框右侧的下拉选项**，可以快速设置
   * 优先级、添加附件」。它那边桌面版没有另一颗「新任务」按钮——加任务只有这
   * 一个地方，要填全就从这一条展开。
   */
  onOpenForm: () => void;
}

/**
 * 列表顶上常驻的那一行「添加任务」（仿滴答清单）。
 *
 * **它跟「新任务」按钮不是一件事，两个都留着。** 那颗按钮开的是整张表单：
 * 备注、子任务、重复、附件……偶尔来一条、要填全的时候走那条。这一行只有标题，
 * 换来的是三件那张表单给不了的事：
 *
 * ① **它一直在那儿。** 不用先点一下才有地方打字——一屏任务清单上最常做的动作
 *    是再加一条，而它原来要两步。
 * ② **建完不关，光标留在原地。** 表单是「偶尔来一条」的形状，建完就收；这一行
 *    是「连着记五条」的形状，回车、接着打下一条。
 * ③ **建完不弹话**（除非那条任务不在这一屏里，见 `createdNote`）。连记五条弹
 *    五次「已添加」是噪音——**新的一行当场出现在下面，那就是最好的回执**。
 *
 * 剩下的都是复用：预填走 `composeDefaults`、自然语言走 `parseSmartInput`、
 * 时间听谁的走 `mergePicked`、去哪了走 `createdNote`，四份都跟那张表单同一套，
 * 没有第二份判据。
 */
export function QuickAdd({ onCreate, view, boardFilter, now, defaults, indent, wide, onOpenForm }: Props) {
  const { message } = AntApp.useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // 「取消识别」按过就这一趟不再识别，跟 TaskComposer 同一个开关。区别在这一行
  // 建完还留着，所以它得跟着重置——不然一次「别认」会静静地管住后面每一条。
  const [smartOff, setSmartOff] = useState(false);

  const smart = useMemo(() => parseSmartInput(text, now, defaults.smart), [text, now, defaults.smart]);
  const smartOn = !smartOff && smart.hits.length > 0;
  // 草稿怎么拼**搬去了 lib/composeDefaults.ts 的 smartDraft**——收件箱里
  // 「变成任务」要拼的是同一份，两处各写一份迟早分叉，理由写在那儿。
  // 这里还留着 `smart`：下面那颗「智能识别按掉」的开关要读 `smart.hits`
  // 决定出不出现，那是这一行独有的东西，不属于草稿本身。
  const built = smartDraft(text, defaults, now, { smartOff, presetToRemindAt });
  const title = built.title;

  const submit = async () => {
    if (!title || busy) return;
    setBusy(true);
    try {
      const task = await onCreate({ ...emptyDraft(), ...built });
      const note = createdNote(view, task, now, boardFilter);
      if (note) void message.success(note);
      setText('');
      setSmartOff(false);
    } catch (e) {
      // 失败时那句话原样留在输入框里——清空等于把他刚打的字连同这次失败一起
      // 弄丢，跟 TaskComposer / InboxComposer / TaskCard 同一条教训。
      void message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`ink-quickadd-wrap${wide ? ' ink-quickadd-wrap-wide' : ''}`}>
      {/* <form> 而不是裸 input：回车提交是浏览器自带的，不用自己听 keydown。 */}
      <form
        className={`ink-quickadd${indent ? ' ink-quickadd-indent' : ''}`}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <span className="ink-quickadd-plus" aria-hidden="true">+</span>
        <input
          className="ink-quickadd-input"
          type="text"
          aria-label="添加任务"
          placeholder="添加任务"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          // Esc 清空。**不 blur**：清掉打错的一句之后多半是接着重打，把焦点
          // 一起收走等于再点一次输入框。
          // **也不 stopPropagation**：全局那个 Esc 除了搜索框那一支，还负责
          // 「退出选中态」（App.tsx 的 case 'escape'），拦下来等于站在这一行里
          // 按 Esc 就清不掉刚才选中的那几条任务。Esc 的语义是「从当前状态里
          // 退出来」，这一行的清空是它的一部分，不是它的替代。
          onKeyDown={(e) => { if (e.key === 'Escape') { setText(''); setSmartOff(false); } }}
        />
      {/* 要填全的时候从这儿展开成整张表单。**放在输入框右端**，不是另开一颗
          「新任务」按钮摆在标题栏上——滴答清单文档里桌面版加任务只有「任务
          添加栏」这一个地方，附加选项挂在输入框右侧。

          **名字叫「新任务表单」。** 它开的那张表单在别处一直是这个名字：
          快捷键表（`C 新任务表单`）、设置里那两条「新任务默认清单/优先级」的
          说明（「只影响「新任务」表单的初值」）。这颗按钮原来自称「填完整的
          表单」——那是一句描述，不是名字，于是同一个东西在屏幕上有三种叫法，
          照着设置里那句话去找的人找不到它。 */}
      <button
        type="button"
        className="ink-quickadd-more"
        aria-label="新任务表单"
        title="新任务表单（备注、子任务、重复、附件……）"
        onClick={onOpenForm}
      >⌄</button>
      </form>
      {/* 识别到什么、标题会变成什么——认走的那几个字会从标题里消失，这是最需要
          提前说清楚的一件事。样式跟表单里那条共用 `.ink-smart-hint`，不用群青：
          这是本机一条正则算出来的，不是 AI 产出，群青是配给制。 */}
      {smartOn && (
        <div className="ink-smart-hint" role="status">
          <span>识别到 {smart.hits.join(' · ')}，标题会变成「{smart.title}」</span>
          <Button size="small" type="text" onClick={() => setSmartOff(true)}>取消识别</Button>
        </div>
      )}
    </div>
  );
}
