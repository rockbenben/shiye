import { describe, expect, it } from 'vitest';
import { ACTION_SEND, shareToInboxText } from './sharePlan.js';

// 夹具刻意避开默认值和巧合值（141）：正文一律是**能读出意思的中文/真链接**，
// 不拿空字符串当「非空」的对照，也不拿 subject 跟 text 写成同一个串。
//
// 每一格自己一条测试，且**每格的夹具只许违反那一条**（150）：比如「action 不对」
// 那格的 text 必须是正常文字，否则把 action 守卫删掉它照样绿——空文字守卫先挡住了。

describe('shareToInboxText——什么都不写的那几格（155：拒掉的也要清点）', () => {
  it('普通点图标启动（action=MAIN、没有 text）⇒ null；原生那半对每次 onNewIntent 都发事件、不筛，这是最常跑的一格', () => {
    expect(shareToInboxText({ action: 'android.intent.action.MAIN' })).toBeNull();
  });

  it('action 不是 SEND 但带着正文 ⇒ null；只违反 action 这一条，删掉 action 守卫就该红', () => {
    expect(shareToInboxText({
      action: 'android.intent.action.VIEW',
      text: '这条是从别的 intent-filter 掉进来的，不该进收件箱',
    })).toBeNull();
  });

  it('action 缺席（原生那半没带上）⇒ null，不当成分享', () => {
    expect(shareToInboxText({ text: '没有 action 就不知道这是不是一次分享' })).toBeNull();
  });

  it('是 SEND 但正文全是空格换行 ⇒ null', () => {
    expect(shareToInboxText({ action: ACTION_SEND, text: '   \n  ' })).toBeNull();
  });

  it('是 SEND 但正文只有不间断空格/全角空格/制表符 ⇒ null；中文里复制出来的空白多半是这几个，trim 按 Unicode 空白算，覆盖得到', () => {
    expect(shareToInboxText({ action: ACTION_SEND, text: ' 　\t' })).toBeNull();
  });

  // ⚠️ **这一格原来是反的**：原文断言「正文空白、却带着标题 ⇒ 仍然 null」，
  // 名字写着「标题单独一句不成条目，不拿它凑数」。Task 4 收尾时把那个决定推翻了
  // ——它只算了「条目质量」，没算「静默丢数据」：下游三处叠起来是彻底沉默的
  // （`subscribeShare` 只在非 null 时回调，App.tsx 那格刻意不提示），他分享了、
  // 屏幕上什么都没发生、也没有任何解释。理由全文在 `sharePlan.ts` 那段注释里。
  // **留在这儿的是收窄之后的那一格：正文和标题「都」空才 null。**
  it('是 SEND，正文和标题**都**是空白 ⇒ null；这是「只有标题就用标题」那条的上限，两个都空才算真的没内容', () => {
    expect(shareToInboxText({ action: ACTION_SEND, subject: '  　', text: '  \n' })).toBeNull();
  });

  it('SEND 但一个字段都没有（安卓分享图片时 EXTRA_TEXT 就是缺席的）⇒ null，不炸', () => {
    expect(shareToInboxText({ action: ACTION_SEND, type: 'image/jpeg' })).toBeNull();
  });
});

describe('shareToInboxText——写进收件箱的那几格', () => {
  it('只有正文：两头的空白去掉，收件箱里就是那句话', () => {
    expect(shareToInboxText({
      action: ACTION_SEND,
      text: '  会议纪要要在周四之前发出去  ',
    })).toBe('会议纪要要在周四之前发出去');
  });

  it('分享网页（标题 + URL）：标题在前、URL 在后，中间换行——只留 URL 的话收件箱里是一串看不懂的链接', () => {
    expect(shareToInboxText({
      action: ACTION_SEND,
      subject: 'Rust 的所有权模型',
      text: 'https://example.invalid/ownership',
    })).toBe('Rust 的所有权模型\nhttps://example.invalid/ownership');
  });

  it('正文里已经含着标题（有些 App 把标题也塞进正文）⇒ 只要正文，不复读', () => {
    expect(shareToInboxText({
      action: ACTION_SEND,
      subject: '把这段读完',
      text: '先把这段读完再说',
    })).toBe('先把这段读完再说');
  });

  it('标题全是空白 ⇒ 只要正文，不留一个空行在前面', () => {
    expect(shareToInboxText({
      action: ACTION_SEND,
      subject: '   ',
      text: '周五之前把押金退了',
    })).toBe('周五之前把押金退了');
  });

  // 下面两条是同一件事的两种到达方式：安卓那半 `EXTRA_TEXT` 缺席时键根本不出现
  // （`JSObject.put(key, (String) null)` 会把键删掉，见 SharePayload 那段注释），
  // 而有些 App 会塞一个空串/几个空格进来——**两种都得落在同一格上**，
  // 只测一种的话另一种坏了没人红。
  it('只有标题、正文字段整个缺席（分享书签/纯网页标题时 EXTRA_TEXT 就是这样）⇒ 拿标题当正文，不是静默丢掉', () => {
    expect(shareToInboxText({
      action: ACTION_SEND,
      type: 'text/plain',
      subject: '年度体检预约',
    })).toBe('年度体检预约');
  });

  it('只有标题、正文是几个空白字符 ⇒ 同样拿标题当正文（标题两头的空白照样去掉）', () => {
    expect(shareToInboxText({
      action: ACTION_SEND,
      subject: '  这是个只有标题的分享  ',
      text: '  ',
    })).toBe('这是个只有标题的分享');
  });

  it('标题两头有空白 ⇒ 拼之前先去掉，不然收件箱里那行前面吊着几个空格', () => {
    expect(shareToInboxText({
      action: ACTION_SEND,
      subject: '  年度体检预约  ',
      text: 'https://example.invalid/booking',
    })).toBe('年度体检预约\nhttps://example.invalid/booking');
  });
});

describe('shareToInboxText——type 不参与判断', () => {
  // 没有这一条的话，将来有人给 type 加一道 `!== 'text/plain'` 的校验，
  // 分享一段被 App 标成 text/html 的选中文字就会静默消失，而没人会红。
  it('四个字段都在、只有 type 不同 ⇒ 结果一模一样', () => {
    const base = {
      action: ACTION_SEND,
      subject: '退租清单',
      text: '搬家那天要把水电燃气都抄表',
    };
    const expected = '退租清单\n搬家那天要把水电燃气都抄表';
    expect(shareToInboxText({ ...base, type: 'text/plain' })).toBe(expected);
    expect(shareToInboxText({ ...base, type: 'text/html' })).toBe(expected);
    expect(shareToInboxText(base)).toBe(expected);
  });
});
