import { useRef, useState, type ComponentProps, type ComponentRef, type ReactNode } from 'react';
import { AutoComplete, Button, Form, Input, InputNumber, Radio, Space, Switch, Tag, Typography, Alert, type InputRef } from 'antd';
import { api } from '../api.js';
import type { AiCliKind, AiEndpoint, Settings } from '../types.js';
import {
  activeEndpoint, commonAiPresets, customEndpointId, findEndpointByBase, modelSuggestionsFor, visibleAiPresets,
  type AiPreset,
} from '../lib/aiPresets.js';
import { setShowCodingPlans } from '../lib/showCodingPlans.js';
import { diagnoseApiError } from '../lib/aiApiDiagnostics.js';

export interface AiSettingsSectionProps {
  draft: Settings;
  setDraft: (next: Settings) => void;
  /**
   * 存着的那一份（GET 读回来的原样，密钥是打码形状）。只用来判一件事：
   * 这一条记录的地址是不是被挪到了**另一台机器**上——服务端对这种改动会把密钥清掉
   * （`server/src/settings.ts` 的 `mergeEndpoint`，理由写在它顶上），界面必须在他
   * 保存之前就说清楚，不能让他保存完对着一句 `Invalid API key` 猜是哪格错了。
   */
  stored: Settings;
  urlHistory: string[];
  showCodingPlans: boolean;
  setShowCodingPlansState: (show: boolean) => void;
}

/** CLI 每家工具的默认命令与说明 */
export const CLI_META: Record<AiCliKind, { defaultCmd: string; help: string }> = {
  claude: {
    defaultCmd: 'claude',
    help: '留空就用这台电脑上的 claude 命令。',
  },
  agy: {
    defaultCmd: 'agy',
    help: '留空就用这台电脑上的 agy 命令。',
  },
  codex: {
    defaultCmd: 'codex',
    help: '留空就用这台电脑上的 codex 命令。不写参数时它自己会补上非交互那一档。',
  },
  gemini: {
    defaultCmd: 'gemini',
    help: '留空就用这台电脑上的 gemini 命令。',
  },
  aider: {
    defaultCmd: 'aider',
    help: '留空就用这台电脑上的 aider 命令。',
  },
  custom: {
    defaultCmd: '命令名或完整路径，如 my-agent',
    help: '命令名或完整路径，留空退回 claude。',
  },
};

/** 开关辅助组件：自动补齐 aria-label，保证无障碍读屏可用 */
export function SwitchItem({ label, help, ...rest }: { label: string; help?: ReactNode } & ComponentProps<typeof Switch>) {
  return (
    <Form.Item label={label} help={help}>
      <Switch aria-label={label} {...rest} />
    </Form.Item>
  );
}

/** 数字输入辅助组件：关闭易误触的小箭头，统一打字输入 */
export function NumberItem({ label, help, ...rest }: { label: string; help?: ReactNode } & ComponentProps<typeof InputNumber>) {
  return (
    <Form.Item label={label} help={help}>
      <InputNumber controls={false} aria-label={label} {...rest} />
    </Form.Item>
  );
}

const LOCAL_MODEL_RECOMMENDATIONS = ['qwen2.5:7b', 'deepseek-r1:8b', 'llama3.1:8b', 'gemma2:9b'];

export function AiSettingsSection({
  draft,
  setDraft,
  stored,
  urlHistory,
  showCodingPlans,
  setShowCodingPlansState,
}: AiSettingsSectionProps) {
  const [aiTest, setAiTest] = useState<{ testing: boolean; error?: string | null; latencyMs?: number }>({ testing: false });
  const [moreVendors, setMoreVendors] = useState(false);

  const keyRef = useRef<InputRef>(null);
  const modelRef = useRef<ComponentRef<typeof AutoComplete>>(null);
  const urlRef = useRef<ComponentRef<typeof AutoComplete>>(null);

  /**
   * 当前选中那一条记录。没选（或者 id 悬空）就当一条空的来看——界面上三格全空，
   * 跟他刚装上第一次打开看到的样子一致。
   *
   * 下面所有「地址 / 模型 / 密钥」的读写都走这一条，**不再有 `draft.aiBaseUrl`
   * 那种全局的一格**：切服务商就是切记录，密钥跟着记录走。
   */
  const rec: AiEndpoint = activeEndpoint(draft) ?? { baseUrl: '', key: '', model: '' };
  const url = rec.baseUrl;
  const countConfigured = Object.keys(draft.aiEndpoints).length;

  const allPresets = visibleAiPresets(showCodingPlans, url);
  const shownPresets = commonAiPresets(showCodingPlans, url, urlHistory);
  const morePresets = allPresets.filter((p) => !shownPresets.includes(p));

  const isCustomUrl = !!url && !visibleAiPresets(true, url).some((p) => p.url === url || p.base === url);
  const noListModelVendor = !!url
    && visibleAiPresets(true, url).some((p) => (p.url === url || p.base === url) && p.model === '');

  const suggestions = modelSuggestionsFor(url);
  const isLocalOrNoList = noListModelVendor || /^(https?:\/\/)?(127\.0\.0\.1|localhost)([:/]|$)/i.test(url);

  /** 改当前这条记录的一个字段。没选中就先不建记录（`setBaseUrl` 那条负责建）。 */
  const patchRec = (patch: Partial<AiEndpoint>) => {
    if (!draft.aiEndpointId) return;
    setDraft({
      ...draft,
      aiEndpoints: { ...draft.aiEndpoints, [draft.aiEndpointId]: { ...rec, ...patch } },
    });
    setAiTest({ testing: false });
  };

  /** 这一枚芯片代表的那条记录（按地址找，理由见 `findEndpointByBase`）。 */
  const recordFor = (p: AiPreset) => findEndpointByBase(draft.aiEndpoints, p);

  /**
   * 芯片亮不亮 = **当前选中的那条记录是不是它**。
   * 用户把某家的地址改成别的主机之后，那一枚就不再亮——因为亮的应该是「这条记录
   * 现在指的是哪儿」，不是「目录里有没有一家长得像」。宁可不亮，也不要两枚同时亮
   * 却各自指着一条记录。
   */
  const picked = (p: AiPreset) => {
    const hit = recordFor(p);
    return !!hit && hit.id === draft.aiEndpointId;
  };

  const pickPreset = (p: AiPreset) => {
    (document.activeElement as HTMLElement | null)?.blur();
    // 已经配过这一家 → 整条换过去，连它自己的密钥和模型名（这才是「一家一把钥匙」）。
    // 没见过 → 新建一条：地址填预置的、模型名能带就带、**密钥一律空着**——
    // 从别家搬一把过来就是那个假 401 的产地。
    const hit = recordFor(p);
    const id = hit?.id ?? p.providerKey;
    const next: AiEndpoint = hit?.rec ?? { baseUrl: p.url, key: '', model: p.model };
    setDraft({ ...draft, aiEndpointId: id, aiEndpoints: { ...draft.aiEndpoints, [id]: next } });
    setAiTest({ testing: false });
    if (!next.key) keyRef.current?.focus();
    else if (!next.model) modelRef.current?.focus();
  };

  /**
   * 「自定义」那颗建出来的空白记录用的哨兵 id。**它带 `custom:` 前缀但后缀是空的**
   * ——跟 `aiPresets.ts` 的 `customEndpointId(地址)` 是同一族名字，用户敲完地址
   * 之后 `setBaseUrl` 会把它就地填成真正那一条（id 也就跟着地址走了）。
   *
   * **空地址 = 存不下来**：`mergeEndpoint` 见到空 `baseUrl` 直接返回 null，
   * 服务端保存时这一条被丢弃。原来选中哪一条由服务端的兜底接回去。
   */
  const CUSTOM_DRAFT_ID = 'custom:';

  /**
   * 「自定义」= 起一条**空白**记录，光标进地址框。
   *
   * **不带过来别家的模型名/密钥**——带着就等于承认「这条新记录该用别家的模型名」，
   * 那正是这次重构要消灭的串味（`SettingsModal.test.tsx` 那条用例守的就是它）。
   *
   * ⚠️ **它原来是用「把 `aiEndpointId` 清成 `''`」来达成「空白」的，那是个真 bug**
   * （2026-10-16 修的）：那个空串**会被服务端当成合法状态存进 `device.json`**，
   * 下次打开 `activeEndpoint(draft)` 返回 undefined，接口地址 / 模型 / 密钥
   * **三格同时全空**，三颗 AI 按钮一起变灰——而记录和密钥一条都没少，
   * 丢的只是「选中哪一条」这个指针。
   *
   * 改成建一条**真的空记录**（哨兵 id `CUSTOM_DRAFT_ID`，地址为空）之后：
   * ① 三格立刻是空的，达到了原来那个目的；
   * ② id 指着一张表里真有的记录，不会有空指针落盘（服务端 `settings.ts` 的
   *    `picked` 也给空串兜了底，双保险）；
   * ③ 什么都不填直接保存 → 地址为空被 `mergeEndpoint` 判掉丢弃，
   *    **原来那条选中自动接回去**——原来那颗按钮是一个没有撤销的破坏性动作；
   * ④ 接着敲地址会走 `setBaseUrl` 的第二种情况，把这条空记录填成他要的那条。
   */
  const pickCustom = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    setDraft({
      ...draft,
      aiEndpointId: CUSTOM_DRAFT_ID,
      aiEndpoints: { ...draft.aiEndpoints, [CUSTOM_DRAFT_ID]: { baseUrl: '', key: '', model: '' } },
    });
    setAiTest({ testing: false });
    urlRef.current?.focus();
  };

  /**
   * 地址那格的改动。四种情况：
   *   1. 敲完正好等于**已有某条记录**的地址 → 切到那条，用它自己的密钥。
   *      （重敲同一个地址不该逼人重填一次钥匙。）
   *   2. 选中的是**自己填出来的那条**（`custom:` 族）→ 它的 id 跟着地址走。
   *   3. 已经选中目录里的一家 → 就改这条的地址（id 是目录给的，不动）。
   *   4. 什么都没选、又敲了东西 → 建一条 `custom:` 记录并选中它。
   *
   * ## 第 2 条为什么要有（2026-10-21 修的）
   *
   * 原来自己填出来的那条，id **永远是 `custom:`**——敲完地址也只是把地址填进去，
   * id 不动。而「自定义」那颗每次都往**同一个 id** 上写一条空白记录。于是：
   *
   * 自定义 → 敲地址 → 填密钥 →（手滑点回「自定义」）→ **刚填的地址和密钥被抹掉**。
   *
   * 抹掉的是「他自己刚配好的一家」，界面上零提示。而 `customEndpointId` 那段注释
   * 写的「id 也就跟着地址走了」跟代码对不上——**代码没做到**。
   *
   * 现在这类记录的 id 始终是 `custom:<地址>`（跟手填的那条同一族名字）：
   * ① 「自定义」那颗再来一次会建一条**新的**空记录，刚才那家原样留着；
   * ② 同一个地址永远是同一个 id，回头再敲一次认的是同一条记录，不至于多出一条。
   *
   * 目录里那几家的 id 是目录给的（`deepseek` 那种），**不动**——改名等于让用户
   * 存着的密钥失主。
   */
  const setBaseUrl = (v: string) => {
    const hit = findEndpointByBase(draft.aiEndpoints, { url: v, base: v });
    if (hit && hit.id !== draft.aiEndpointId) {
      setDraft({ ...draft, aiEndpointId: hit.id });
      setAiTest({ testing: false });
      return;
    }
    // 自己填出来的那条：id 跟着地址走。旧的键从表里退掉，免得留下两条同一个地址。
    if (draft.aiEndpointId?.startsWith('custom:')) {
      const id = customEndpointId(v);
      const rest = { ...draft.aiEndpoints };
      delete rest[draft.aiEndpointId];
      setDraft({
        ...draft,
        aiEndpointId: id,
        aiEndpoints: { ...rest, [id]: { ...rec, baseUrl: v } },
      });
      setAiTest({ testing: false });
      return;
    }
    if (draft.aiEndpointId) { patchRec({ baseUrl: v }); return; }
    if (!v.trim()) { setDraft({ ...draft, aiEndpointId: '' }); return; }
    const id = customEndpointId(v);
    setDraft({
      ...draft,
      aiEndpointId: id,
      aiEndpoints: { ...draft.aiEndpoints, [id]: { baseUrl: v, key: '', model: '' } },
    });
    setAiTest({ testing: false });
  };

  /**
   * 这条记录被挪到另一台机器上了（协议、主机或端口变了）。服务端存的时候会把它
   * 的密钥清掉——这里提前说出来，而不是让他保存完再猜。
   */
  const movedHost = (() => {
    const prev = stored.aiEndpoints[draft.aiEndpointId]?.baseUrl;
    if (!prev || !url) return false;
    const origin = (u: string) => { try { return new URL(u).origin.toLowerCase(); } catch { return ''; } };
    const a = origin(prev); const b = origin(url);
    return a !== '' && b !== '' && a !== b;
  })();

  /** 删掉当前这一条记录（连带它的密钥）。整份 PUT 是「请求体就是全部」，少一条就是删一条。 */
  const forgetThis = () => {
    const id = draft.aiEndpointId;
    const rest: Record<string, AiEndpoint> = {};
    for (const [k, v] of Object.entries(draft.aiEndpoints)) if (k !== id) rest[k] = v;
    setDraft({ ...draft, aiEndpointId: '', aiEndpoints: rest });
    setAiTest({ testing: false });
  };

  const handleTestConnection = async () => {
    setAiTest({ testing: true });
    const start = performance.now();
    try {
      const r = await api.testAi({
        endpointId: draft.aiEndpointId || undefined,
        baseUrl: rec.baseUrl,
        model: rec.model,
        apiKey: rec.key,
      });
      const latency = Math.round(performance.now() - start);
      setAiTest({ testing: false, error: r.ok ? null : r.error, latencyMs: latency });
    } catch (e) {
      setAiTest({ testing: false, error: (e as Error).message });
    }
  };

  const diag = aiTest.error ? diagnoseApiError(aiTest.error) : null;

  return (
    <>
      <h3 className="ink-set-group">谁来拆</h3>
      <Form.Item label="怎么叫 AI" help="本机命令行本事最大（能自己反复读文件、自己纠错），代价是这台机器上要装对应 CLI。调接口只要一个地址加密钥，任何 OpenAI 兼容的服务都行。">
        <Radio.Group
          value={draft.aiMode}
          optionType="button"
          buttonStyle="solid"
          onChange={(e) => setDraft({ ...draft, aiMode: e.target.value as Settings['aiMode'] })}
          options={[
            { value: 'cli', label: '本机命令行' },
            { value: 'api', label: '调接口' },
          ]}
        />
      </Form.Item>

      {draft.aiMode === 'cli' && (
        <>
          <Form.Item label="命令行工具" help="下面这几家挑一个：Claude Code、Antigravity（agy）、Codex、Gemini CLI、Aider；自己的命令选「自定义」。">
            <Radio.Group
              value={draft.aiCli ?? 'claude'}
              optionType="button"
              buttonStyle="solid"
              onChange={(e) => setDraft({ ...draft, aiCli: e.target.value as Settings['aiCli'] })}
              options={[
                { value: 'claude', label: 'Claude Code' },
                { value: 'agy', label: 'Antigravity CLI (agy)' },
                { value: 'codex', label: 'OpenAI Codex' },
                { value: 'gemini', label: 'Gemini CLI' },
                { value: 'aider', label: 'Aider' },
                { value: 'custom', label: '自定义' },
              ]}
            />
          </Form.Item>

          <Form.Item
            label={draft.aiCli === 'custom' ? '命令或路径' : '命令路径（可选）'}
            help={CLI_META[draft.aiCli ?? 'claude']?.help ?? CLI_META.claude.help}
          >
            <Input
              value={draft.aiCliPath ?? ''}
              placeholder={CLI_META[draft.aiCli ?? 'claude']?.defaultCmd ?? 'claude'}
              aria-label="命令行工具路径"
              onChange={(e) => setDraft({ ...draft, aiCliPath: e.target.value })}
            />
          </Form.Item>

          {draft.aiCli === 'custom' && (
            <Form.Item
              label="参数模板"
              help='用空格分开。要放提示词的地方写 {prompt}；不写就自动加在最后面。'
            >
              <Input
                value={draft.aiCliCustomArgs ?? ''}
                placeholder='-p "{prompt}" --mode accept-edits --dangerously-skip-permissions'
                aria-label="自定义命令行参数"
                onChange={(e) => setDraft({ ...draft, aiCliCustomArgs: e.target.value })}
              />
            </Form.Item>
          )}
        </>
      )}

      {draft.aiMode === 'api' && (
        <>
          <Form.Item label="接口地址" help="点名字就切到那一家的配置：地址、密钥、模型名各归各，切走再切回来不会丢，也不会拿别家的钥匙去撞这一家。也可以自己写地址——完整地址、或者只写到 /v1 都认。下拉里是这台机器上存过的地址。">
            <Space size={[4, 4]} wrap style={{ marginBottom: 8 }}>
              {shownPresets.map((p) => (
                <Tag.CheckableTag
                  key={p.label}
                  checked={picked(p)}
                  onChange={() => pickPreset(p)}
                >
                  {p.label}
                </Tag.CheckableTag>
              ))}
              {morePresets.length > 0 && (
                <Button size="small" type="dashed" onClick={() => setMoreVendors((v) => !v)}>
                  {moreVendors ? '收起厂商' : `更多厂商（${morePresets.length}）`}
                </Button>
              )}
              <Button size="small" type="dashed" onClick={pickCustom}>
                自定义
              </Button>
            </Space>

            {moreVendors && (
              <>
                {/* **这 N 颗限高自己滚——给「展开」这件事封一个上界。**
                    实测（桌面版真包，窗口 1200×800 → 内容区 1186×763，弹层正文可视
                    478px）：收着时 10 颗 = 2 行、「接口地址」那一项 220px；展开成
                    32 颗 = 6 行，那一项涨到 374px，而**整段差值全落在这一项上**
                    （逐项高度对拍过，没有别的东西在长）。

                    ⚠️ **限高并没有把模型/密钥留在折线以上，这条别当成已解决。**
                    限到 100px 之后实测：展开的代价从 +155px 降到 **+139px**，
                    而「模型」起始位置从折线上方 96px 变成**折线以下 43px**、
                    「密钥」在折线以下 149px。也就是**这一屏的折线本来就在那儿**：
                    收着的时候密钥已经差 10px 在折线以下了，浏览一份 22 家的长列表
                    必然要占地方，这不是限高能解决的。

                    那为什么还要限：它是**上界**。不封的话这一块按内容长——22 颗在
                    更窄的窗口上能绕到十几行，能把整页顶到任意远；封了之后代价是可
                    预测的（这一屏 139px），跟窗口多高无关。做法跟 `.ant-dropdown-menu`
                    那条（`max-height` + `overflow-y: auto`）是同一条理由：那份的
                    菜单一格在屏幕外面时**是真的点不到**，这份不是，但代价一样是
                    用户在原地打转。

                    代价也记下来：想在框里翻最后几颗得滚一下，两层滚动（这一框 + 正文）
                    比一层啰嗦。**真正能让模型/密钥不被埋的做法是把剩下这 22 颗收进一个
                    可搜索的选择器**（展开零高度）——那是一次更大的交互改动，单独决定。 */}

                <Space
                  size={[4, 4]}
                  wrap
                  style={{ maxHeight: 100, overflowY: 'auto', marginBottom: 8 }}
                >
                  {morePresets.map((p) => (
                    <Tag.CheckableTag key={p.label} checked={picked(p)} onChange={() => pickPreset(p)}>
                      {p.label}
                    </Tag.CheckableTag>
                  ))}
                </Space>
                <div style={{ marginTop: 4 }}>
                  <Typography.Link
                    type={showCodingPlans ? undefined : 'secondary'}
                    style={{ fontSize: 12, display: 'inline-block', padding: '4px 0' }}
                    role="switch"
                    aria-checked={showCodingPlans}
                    aria-label="显示订阅套餐节点（Coding Plan / Token Plan）"
                    onClick={() => { const next = !showCodingPlans; setShowCodingPlansState(next); setShowCodingPlans(next); }}
                  >
                    {showCodingPlans ? '已显示订阅套餐节点' : '订阅套餐节点'}
                  </Typography.Link>
                  {showCodingPlans && (
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                      官方文档指明：套餐仅限在 AI 编程工具中交互式使用，在允许范围之外使用套餐的 Base URL 和 API Key 可能被识别为滥用，导致订阅停用或账号 / API Key 封禁。请确认了解风险后再开启。
                    </Typography.Paragraph>
                  )}
                </div>
              </>
            )}

            <AutoComplete
              ref={urlRef}
              aria-label="接口地址"
              value={url}
              placeholder="https://…/v1/chat/completions"
              options={urlHistory.map((u) => ({ value: u }))}
              onChange={setBaseUrl}
            />
            {isCustomUrl && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                这个地址不在厂商目录里——按你自己那台服务的规矩填：完整地址、或者只写到 <code>/v1</code> 都认。
              </Typography.Paragraph>
            )}
            {countConfigured > 1 && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                这台机器上存过 {countConfigured} 家，各家一把钥匙。切回别家点上面那排名字就行。
              </Typography.Paragraph>
            )}
            {draft.aiEndpointId && (
              <Typography.Link
                type="danger"
                style={{ fontSize: 12, display: 'inline-block', marginTop: 4 }}
                onClick={forgetThis}
              >
                忘掉这一家（连它的密钥一起从这台机器上删掉）
              </Typography.Link>
            )}
          </Form.Item>

          <Form.Item
            label="模型"
            help={
              // **「还没选中任何一家」时说清楚，而不是让输入框装着能敲的字。**
              // 原来这里无论有没有选中都开着框，而 `patchRec` 在
              // `!draft.aiEndpointId` 时直接 `return`——敲进去的字当场就没了，
              // 界面零反馈，看着像输入框坏了（用户报的就是「模型、key 消失了」）。
              // 要么能改，要么看得见改不了；**不能让一个静默的 no-op 顶着能敲的样子。**
              draft.aiEndpointId
                ? '原样发给接口，跟着这一家走。地址落在目录里某一家的端点上，就出它家那份模型清单；地址是自己填的，这里照样能自己写。'
                : '先在上面点一家（或在「接口地址」里敲一个地址），模型名才有地方放——这一格是跟着那一条记录走的。'
            }
          >
            <AutoComplete
              ref={modelRef}
              aria-label="模型"
              disabled={!draft.aiEndpointId}
              value={rec.model}
              placeholder="gemini-3.8-flash"
              options={[...suggestions]}
              onChange={(v: string) => patchRec({ model: v })}
            />

            {/* 快捷推荐模型芯片 */}
            {suggestions.length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--dim)', marginRight: 4 }}>快速选型:</span>
                {suggestions.slice(0, 6).map((m) => (
                  <Tag
                    key={m.value}
                    color={rec.model === m.value ? 'blue' : undefined}
                    style={{ cursor: 'pointer', margin: 0, fontSize: 11 }}
                    onClick={() => patchRec({ model: m.value })}
                  >
                    {m.label}
                  </Tag>
                ))}
              </div>
            )}

            {suggestions.length === 0 && isLocalOrNoList && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--dim)', marginRight: 4 }}>常见本地模型推荐:</span>
                {LOCAL_MODEL_RECOMMENDATIONS.map((name) => (
                  <Tag
                    key={name}
                    color={rec.model === name ? 'blue' : undefined}
                    style={{ cursor: 'pointer', margin: 0, fontSize: 11 }}
                    onClick={() => patchRec({ model: name })}
                  >
                    {name}
                  </Tag>
                ))}
              </div>
            )}

            {noListModelVendor && rec.model && (
              <Typography.Paragraph type="warning" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                这家目录里没有模型清单（本机跑的服务装了什么模型只有它自己知道），所以上面这个 <code>{rec.model}</code> 是之前填的——不对就改成那台机器上的名字。
              </Typography.Paragraph>
            )}
          </Form.Item>

          <Form.Item
            label="密钥"
            help={
              // 同上：没选中时看得见地禁用，别让它装着能敲的字却敲不进去。
              draft.aiEndpointId
                ? '只存这一家的，切到别家不会拿它去撞；读回来的是打码后的形状（改了才会覆盖）。本机跑的 Ollama / LM Studio 不要密钥，留空就行。'
                : '先在上面点一家（或在「接口地址」里敲一个地址），密钥才有地方放——它跟着那一条记录走，不是一把全局的钥匙。'
            }
          >
            <Input.Password
              ref={keyRef}
              aria-label="密钥"
              disabled={!draft.aiEndpointId}
              value={rec.key}
              autoComplete="off"
              placeholder="留空 = 不带密钥"
              onChange={(e) => patchRec({ key: e.target.value })}
            />
            {/*
              两种「这条记录还没配好」的样子，分开说不然只能盲猜：
              · 没密钥又没个不要密钥的本地地址 → 一测就是 401，先给他说清；
              · 地址被挪到另一台机器 → 服务端存的时候会把这把清掉（`mergeEndpoint`），
                不提前说，他就会以为是自己打错字。
            */}
            {movedHost && (
              <Typography.Paragraph type="warning" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                这一条的地址换到了另一台机器上，密钥要重填一次——保存之后不会沿用原来那把（拿旧钥匙去敲新机器，只会回一句跟真实原因无关的 401）。
              </Typography.Paragraph>
            )}
            {!movedHost && !rec.key && !isLocalOrNoList && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                这家还没配密钥。别家是配过的，切过去不会把这把带过来。
              </Typography.Paragraph>
            )}
          </Form.Item>

          <Form.Item label=" " colon={false}>
            <Button
              loading={aiTest.testing}
              onClick={handleTestConnection}
            >
              测试连接
            </Button>
            {aiTest.error !== undefined && !aiTest.testing && (
              <Alert
                style={{ marginTop: 8 }}
                type={aiTest.error === null ? 'success' : 'error'}
                showIcon
                message={
                  aiTest.error === null
                    ? (aiTest.latencyMs ? `连接成功，这一家配好了。（响应耗时 ${aiTest.latencyMs}ms）` : '连接成功，这一家配好了。')
                    : aiTest.error
                }
                description={
                  aiTest.error && diag ? (
                    <div style={{ marginTop: 4 }}>
                      <strong style={{ color: 'inherit' }}>{diag.category}</strong>：{diag.suggestion}
                    </div>
                  ) : undefined
                }
              />
            )}
          </Form.Item>
        </>
      )}

      <h3 className="ink-set-group">什么时候拆</h3>
      <SwitchItem
        label="自动拆解"
        help="收件箱出现还没处理的条目，等一段时间没有新动静就自动拆一次；拆不动的条目不会无限重试，「重新拆解」或点「立即拆解」能让它重新排上。"
        checked={draft.autoExpand}
        onChange={(v) => setDraft({ ...draft, autoExpand: v })}
      />
      <NumberItem
        label="自动拆解延迟"
        help="连着记好几条只算一批，每来一条重新计时。10～3600 秒，默认 60。"
        min={10}
        max={3600}
        value={draft.autoExpandDelaySec}
        disabled={!draft.autoExpand}
        addonAfter="秒"
        onChange={(v) => setDraft({ ...draft, autoExpandDelaySec: typeof v === 'number' ? v : draft.autoExpandDelaySec })}
      />
    </>
  );
}
