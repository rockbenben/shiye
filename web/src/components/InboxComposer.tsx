import { useId, useState } from 'react';
import { App as AntApp, Button, Input } from 'antd';
import { formKey } from '../lib/keymap.js';

interface Props {
  onSubmit: (text: string) => Promise<void>;
}

/** 随手丢一句话进收件箱。不要求格式，格式是 AI 的活。 */
export function InboxComposer({ onSubmit }: Props) {
  const { message } = AntApp.useApp();
  const [text, setText] = useState('');
  // 同一个节点会被摆进两个位置（宽屏的侧栏 `.ink-nav-composer`、窄屏的
  // `.ink-narrow-composer`），写死 id 就有两份同名 id 的风险。
  const nameId = useId();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await onSubmit(v);
      setText('');
    } catch (e) {
      // 存失败就把输入框留着——清空等于把用户刚打的字连带没存成的这条一起弄丢。
      void message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ink-composer">
      {/* 框的名字。命令面板那条命令、快捷键表、空状态那句话都管它叫「随手记」，
          而框自己一直不说——照着那些说明去找的人在屏幕上找不到它。一个动作
          在整个流程里只用一个词，这是最后一处还没兑现的。
          **而且它原来只是一句摆在上面的话，不是这个框的名字**：读屏走到框上
          念出来的是占位符，屏幕上没有第二个框会混淆，但无障碍树里这个框是
          「无名输入框」（打磨稿第一轮量出来的其中一条）。用 `aria-labelledby`
          指回这同一句标题，不再抄第二个词。 */}
      <h2 id={nameId} className="ink-composer-name">随手记</h2>
      {/* variant="borderless"：antd 自带的「无边框、无底色」输入框变体，
          刚好是设计要的「不加修饰的 textarea」，不用另外写 CSS 去抠掉边框。 */}
      <Input.TextArea
        variant="borderless"
        aria-labelledby={nameId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 判据走 `lib/keymap.ts` 的 `formKey`，跟任务表单那两个框同一份——
          // 这里原来手写了一遍「Enter 且 Ctrl/Cmd」，行为一样，但**输入法那三道
          // 守卫是白拿的**：中文输入法按回车是上屏候选词，不是「我写完了」。
          // 普通回车照旧什么都不做，走 textarea 原生的换行（`plainEnter` 不开）。
          // 不接 `cancel`：这个框一直在侧栏上摆着，没有「关掉」这回事。
          if (formKey(e) !== 'submit') return;
          e.preventDefault();
          void submit();
        }}
        autoSize={{ minRows: 2, maxRows: 6 }}
        // 这句原本在输入框上面单独占一行（App.tsx 的 .ink-rail-sub），跟框里
        // 的占位符「写点什么……」说的是同一件事，隔十几像素说了两遍。留占位符
        // 这一份：它就在你要落笔的地方，而且一开始打字就消失——「不用整理」
        // 这种降低门槛的话，正是动笔之前才需要看到的。
        placeholder="想到什么写什么，不用整理"
      />
      <div className="ink-composer-row">
        {/* 快捷键只在这一处说——上面的占位符曾经把「回车换行、Ctrl+回车提交」
            也写了一遍，跟这行重复，还各写各的记法（「Ctrl+回车」/「Ctrl+Enter」）。
            见 2026-08-12-ux-audit.md「占位符里塞了两件事」「同一个按键两种写法」。
            「回车换行」不提了——多行输入框里回车换行是默认行为，不需要说明；
            Ctrl+Enter 提交不是默认行为，值得留一句提示，只留这一处。 */}
        {/* 多一个 `ink-kbd-hint`：**手机上没有 Ctrl 键**，这句话在那儿是一条
            做不到的指示。窄屏用 CSS 藏掉（theme.css 那批 767px 里），不走
            `useIsNarrow()`——这一处只是显示与否，不用换一种渲染方式，而 CSS
            自动跟着同一个断点走，少一份要对齐的数。
            不直接藏 `.ink-hint`：那是通用的小灰字，「AI 正在拆解……」也在用。 */}
        <span className="ink-hint ink-kbd-hint">Ctrl+Enter 存下</span>
        {/* color="default" variant="outlined"：这颗按钮是你自己按的，不是 AI
            产出的东西，不用 type="primary"（拿群青）。variant 从 "solid" 改成
            "outlined"——它曾经是整页最重的纯黑按钮，但提交收件箱只是个随手
            记一句话的次要动作，见 2026-08-12-ux-audit.md「存进收件箱是整页
            最重的纯黑按钮」。按钮文字也从「存进收件箱」改成「存下」，跟上面
            的快捷键提示同一个词——「收件箱」三个字这一小块地方已经出现了
            两次（标题「收件箱」、这行提示的上下文），按钮不用再说一遍，
            见规格「一个动作在整个流程里必须用同一个词」。
            **这颗不改叫「保存」**（batch8 那轮把别处零散的「存下」统一成了
            「保存」，这儿是有意留下的）：「存下」在这儿说的是**把一句话记进
            收件箱**，不是提交一份表单——随手记的整个流程（占位符「想到什么
            写什么，不用整理」+ 这行键位提示 + 这颗按钮）都围着「记下来」
            而不是「编辑好一个东西」写的，换成「保存」就断了那条裁定过的
            同词规矩。 */}
        <Button color="default" variant="outlined" loading={busy} disabled={!text.trim() || busy} onClick={() => void submit()}>
          存下
        </Button>
      </div>
    </div>
  );
}
