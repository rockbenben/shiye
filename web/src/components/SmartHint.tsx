import { Button } from 'antd';
import type { ReactNode } from 'react';
import type { SmartInput, SmartSpan } from '../lib/smartInput.js';
import { smartSpanKey } from '../lib/smartInput.js';

/**
 * 段与段合并：`spans` 是按「哪一步吃的」分开记的，两步有可能盖在同一段字上
 * （后一步在前一步留下的空洞上继续抠，落回原话就成了交叠）。画两层标记没有
 * 意义，合成一层，`gone` 取或——只要有一段真被摘走，那几个字就是没了。
 *
 * **只合并真的交叠的，紧挨着的不合**：「明天」「下午两点」是两次识别，画出来
 * 两段删除线在行里看着是一条，但 DOM 里它们是两颗——界面上「这是一次认出来的」
 * 和「这是两次」不该混。而且哪天要给每一段挂个「为什么被读走」的提示，
 * 合过的段就问不出来了。
 */
function mergeSpans(spans: SmartSpan[]): SmartSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: SmartSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      last.gone = last.gone || s.gone;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** 原话按被读走的那些段切开，读走的包一层标记。 */
function echo(raw: string, spans: SmartSpan[]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of mergeSpans(spans)) {
    if (s.start > at) out.push(raw.slice(at, s.start));
    out.push(
      <span className={s.gone ? 'ink-smart-gone' : 'ink-smart-kept'} key={s.start}>
        {raw.slice(s.start, s.end)}
      </span>,
    );
    at = Math.max(at, s.end);
  }
  if (at < raw.length) out.push(raw.slice(at));
  return out;
}

/**
 * 「识别到了什么」那一行。
 *
 * **把原话重画一遍，而不是只报结果。** 原来那句是
 * 「识别到 明天 下午两点，标题会变成「交周报」」——句子一长，人得拿屏幕上这两
 * 段文字自己对一遍，才知道少了哪半句。而真正会让人愣一下的是「我打的字去哪了」，
 * 那是一句**位置**的话：划掉哪几个字，一眼就看完了，不用对。
 *
 * 两档标记对应 `SmartSpan.gone` 的两档：
 * - 划掉：这几个字**不进标题**。
 * - 虚线下划线：这几个字被读走了（所以日期、重复规则照设），但按「认了但不摘」
 *   那一档的设置**留在标题里**。把这两档并成一档，虚线那一档就成了谎话——那几个
 *   字明明还在。
 *
 * **认出来的每一段同时是一颗可点的 chip**，点一下只撤那一段（别家那条逐词取消
 * 的路：Todoist 官方页写「只需点击或轻触这个词来将它转成普通文本」）。原来只有
 * 一颗全局的「取消识别」，而认错的常见形状是「一句里三个词认对了两个」——
 * 要撤一个就得三个全撤，剩下那两个正好是他想要的。全局那颗留着，它管的是
 * 「这一句都别认」。
 *
 * 不用群青：这是本机一条正则算出来的，不是 AI 产出，而群青在这个应用里是配给制，
 * 只标 AI 写的和 AI 推断的。
 */
export function SmartHint({ raw, smart, onOff, onIgnore }: {
  /** 他打的那句原话（`spans` 的下标就是落在它上面的）。 */
  raw: string;
  smart: SmartInput;
  onOff: () => void;
  /** 点掉某一段。不传（没有可撤的段）时 chip 退成普通文字。 */
  onIgnore?: (key: string) => void;
}) {
  const anyGone = smart.spans.some((s) => s.gone);
  return (
    <div className="ink-smart-hint" role="status">
      <span className="ink-smart-hits">
        <span>识别到 </span>
        {/* 一段都没有（只认出没落进原话的东西）时退回 `hits` 那份人话，不能让
            「识别到」后面空着。 */}
        {smart.spans.length === 0 && smart.hits.join(' · ')}
        {/* **按原话里的先后排**，不按识别步骤排。`spans` 是照步骤记的
            （情境→标签→重复→日期→时刻，理由见 smartInput 顶部「每一步从上一步
            剩下的串里认」），照它画出来是「#工作 明天 下午三点」——跟句子说的
            顺序反着，人得先把它翻译一遍。旁边那句划掉的原话本来就是文字顺序的。 */}
        {[...smart.spans].sort((a, b) => a.start - b.start).map((s) => {
          const text = raw.slice(s.start, s.end);
          const key = smartSpanKey(raw, s);
          if (!onIgnore) return <span className="ink-smart-chip ink-smart-chip-plain" key={key}>{text}</span>;
          return (
            <button
              type="button"
              key={key}
              className="ink-smart-chip"
              // 说清点下去会发生什么：撤掉的是**这一段**的识别，那几个字回到标题里。
              title={`不用「${text}」识别——这几个字留在标题里`}
              onClick={() => onIgnore(key)}
            >{text}</button>
          );
        })}
      </span>
      <span>
        {smart.spans.length > 0 && (anyGone ? '，划掉的不进标题' : '，这几个字留在标题里')}
        {smart.spans.length > 0 && <span className="ink-smart-echo">「{echo(raw, smart.spans)}」</span>}
      </span>
      <Button size="small" type="text" onClick={onOff}>取消识别</Button>
    </div>
  );
}
