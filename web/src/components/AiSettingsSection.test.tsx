import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App as AntApp, Form } from 'antd';
import { AiSettingsSection } from './AiSettingsSection.js';
import type { AiEndpoint, Settings } from '../types.js';

/** 目录里 `deepseek` 那一家的默认端点，用来让芯片和记录对得上。 */
const DEEPSEEK = 'https://api.deepseek.com/chat/completions';
const OPENAI = 'https://api.openai.com/v1/chat/completions';

/**
 * 一家一条记录，键是目录 id。以前这里是 `baseSettings` 上平铺的三格——
 * 那正是那个假 401 的形状：全应用一把密钥，换服务商时旧钥匙跟着地址走。
 */
const apiCfg = (id: string, endpoints: Record<string, AiEndpoint>): Settings => ({
  webhookUrl: '',
  toastEnabled: true,
  autoExpand: true,
  autoExpandDelaySec: 60,
  focusMinutes: 25,
  breakMinutes: 5,
  dailySummaryAt: null,
  dailySummaryOn: null,
  defaultListId: null,
  defaultPriority: 0,
  defaultDue: 'none',
  defaultRemindMinutes: null,
  defaultTags: [],
  weekStart: 1,
  smartDate: true,
  smartStripDate: true,
  smartTag: true,
  smartStripTag: true,
  showLunar: true,
  showHolidays: true,
  aiMode: 'api',
  aiCli: 'claude',
  aiCliPath: '',
  aiCliCustomArgs: '',
  aiEndpointId: id,
  aiEndpoints: endpoints,
});

const deepseek: AiEndpoint = { baseUrl: DEEPSEEK, key: 'sk-test', model: 'deepseek-flash' };
const baseSettings = apiCfg('deepseek', { deepseek });

const testAi = vi.fn(async (_cfg: { endpointId?: string; baseUrl: string; model: string; apiKey: string }) =>
  ({ ok: true }) as { ok: true } | { ok: false; error: string });

vi.mock('../api.js', () => ({
  api: {
    testAi: (cfg: { endpointId?: string; baseUrl: string; model: string; apiKey: string }) => testAi(cfg),
  },
}));

/**
 * 渲染这一屏。`stored` 默认跟草稿一样，只有要判「改了没」的测试才给它另一份
 * （那才是「刚从服务端读回来、还没编辑」的样子）。
 *
 * 外面套一层真的 `useState`：这个组件是受控的，点一下芯片只调用 `setDraft`，
 * 界面**不会**自己变。不套这层，「切到另一家之后密钥格换成那把」这类断言只能
 * 测到点击前那一帧——它会绿，而它什么都没测。
 */
function renderSection(initial: Settings, stored: Settings = initial) {
  const setDraft = vi.fn();
  function Harness() {
    const [draft, setState] = useState(initial);
    return (
      <AiSettingsSection
        draft={draft}
        setDraft={(next) => { setDraft(next); setState(next); }}
        stored={stored}
        urlHistory={[]}
        showCodingPlans={false}
        setShowCodingPlansState={() => {}}
      />
    );
  }
  render(
    <AntApp>
      <Form>
        <Harness />
      </Form>
    </AntApp>,
  );
  return { setDraft };
}

describe('AiSettingsSection 独立组件测试', () => {
  beforeEach(() => {
    testAi.mockClear();
    testAi.mockResolvedValue({ ok: true });
  });

  it('展示常用模型快速选型标签，点击把模型名写进**当前这一条记录**', () => {
    const { setDraft } = renderSection(baseSettings);

    expect(screen.getByText('快速选型:')).toBeDefined();
    // DeepSeek Flash 应该在推荐列表中
    const flashTags = screen.getAllByText('DeepSeek Flash');
    expect(flashTags.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByText('DeepSeek V4 Pro'));

    expect(setDraft).toHaveBeenCalled();
    expect(setDraft.mock.calls[0][0].aiEndpoints.deepseek.model).toBe('deepseek-v4-pro');
    // 只改模型名，不该顺手把这家的密钥或选中状态弄丢
    expect(setDraft.mock.calls[0][0].aiEndpoints.deepseek.key).toBe('sk-test');
    expect(setDraft.mock.calls[0][0].aiEndpointId).toBe('deepseek');
  });

  it('本地模型 (如 Ollama) 展示常见本地模型推荐标签', () => {
    const ollama = apiCfg('ollama', {
      ollama: { baseUrl: 'http://127.0.0.1:11434/v1/chat/completions', key: '', model: '' },
    });
    const { setDraft } = renderSection(ollama);

    expect(screen.getByText('常见本地模型推荐:')).toBeDefined();
    expect(screen.getByText('qwen2.5:7b')).toBeDefined();
    expect(screen.getByText('deepseek-r1:8b')).toBeDefined();

    fireEvent.click(screen.getByText('deepseek-r1:8b'));
    expect(setDraft).toHaveBeenCalled();
    expect(setDraft.mock.calls[0][0].aiEndpoints.ollama.model).toBe('deepseek-r1:8b');
  });

  /**
   * **这次改动的正面一条。** 旧版这里只有一格 `aiKey`：从 DeepSeek 点到 OpenAI，
   * 密钥格还留着 DeepSeek 那把（打码串），保存时被换回真值发到 OpenAI 去，
   * 回一句 `Invalid API key`，而报错让人去查模型名和地址。
   */
  it('切到另一家：密钥格换成那一家自己的，不是当前这把', () => {
    const two = apiCfg('deepseek', {
      deepseek,
      openai: { baseUrl: OPENAI, key: '••••oai4', model: 'gpt-6.1-sol' },
    });
    const { setDraft } = renderSection(two);

    fireEvent.click(screen.getByText('OpenAI'));

    expect((screen.getByLabelText('密钥') as HTMLInputElement).value).toBe('••••oai4');
    expect((screen.getByLabelText('接口地址') as HTMLInputElement).value).toBe(OPENAI);
    // 选中状态跟着换过去——保存时 PUT 的就是这一条，不是 DeepSeek 那条
    expect(setDraft.mock.calls[0][0].aiEndpointId).toBe('openai');
  });

  /**
   * **自己填的地址：id 跟着地址走。**
   *
   * 原来自己填出来的那条，id 永远是 `custom:`——而「自定义」那颗每次都往**同一个
   * id** 上写一条空白记录。于是「自定义 → 敲地址 → 填密钥 →（手滑点回「自定义」）
   * → 刚填的地址和密钥被抹掉」，界面上零提示。
   *
   * 现在这类记录的 id 始终是 `custom:<地址>`：再点一次「自定义」建的是**新的**空
   * 记录，刚才那家原样留着。
   */
  it('自己填的地址：id 跟着地址走，再点一次「自定义」不会把刚填的那家抹掉', () => {
    const { setDraft } = renderSection(baseSettings);

    fireEvent.click(screen.getByText('自定义'));
    const afterCustom = setDraft.mock.calls[0][0] as Settings;
    expect(afterCustom.aiEndpointId).toBe('custom:');

    fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://my.gateway.test/v1' } });
    const afterUrl = setDraft.mock.calls[1][0] as Settings;
    // id 跟着地址走
    expect(afterUrl.aiEndpointId).toBe('custom:https://my.gateway.test/v1');
    expect(afterUrl.aiEndpoints['custom:https://my.gateway.test/v1'].baseUrl).toBe('https://my.gateway.test/v1');
    // 旧的那个键不在表里了（不留下两条同一个地址）
    expect(Object.keys(afterUrl.aiEndpoints)).toEqual(['deepseek', 'custom:https://my.gateway.test/v1']);
  });

  /** 反过来也不能串：一家没配过密钥时，格子里是空的，不是别家那把。 */
  it('没配过密钥的一家，切过去格子是空的', () => {
    const two = apiCfg('deepseek', {
      deepseek,
      openai: { baseUrl: OPENAI, key: '', model: 'gpt-6.1-sol' },
    });
    renderSection(two);
    fireEvent.click(screen.getByText('OpenAI'));
    expect((screen.getByLabelText('密钥') as HTMLInputElement).value).toBe('');
  });

  /**
   * 服务端对「同一条记录里换主机」会把密钥清掉（`settings.ts` 的 `mergeEndpoint`）。
   * 界面必须提前说，不能等他保存完对着一句 401 猜哪格错了。
   */
  it('同一条记录里把地址挪到另一台机器 → 提前说密钥要重填', () => {
    const draft = apiCfg('deepseek', {
      deepseek: { ...deepseek, baseUrl: 'https://另一个主机.test/v1' },
    });
    renderSection(draft, baseSettings);
    expect(screen.getByText(/密钥要重填一次/)).toBeDefined();
  });

  /** 只是同一个主机改了路径，不该吓他。 */
  it('同一个主机只改路径 → 不提重填密钥', () => {
    const draft = apiCfg('deepseek', {
      deepseek: { ...deepseek, baseUrl: 'https://api.deepseek.com/v2' },
    });
    renderSection(draft, baseSettings);
    expect(screen.queryByText(/密钥要重填一次/)).toBeNull();
  });

  it('测连接带的是这一条记录，连 id 一起带过去', () => {
    renderSection(baseSettings);
    fireEvent.click(screen.getByText('测试连接'));
    expect(testAi).toHaveBeenCalledWith({
      endpointId: 'deepseek',
      baseUrl: DEEPSEEK,
      model: 'deepseek-flash',
      apiKey: 'sk-test',
    });
  });

  it('测试连接成功时包含耗时信息并显示成功 Alert', async () => {
    renderSection(baseSettings);
    fireEvent.click(screen.getByText('测试连接'));
    await waitFor(() => expect(screen.getByText(/连接成功/)).toBeDefined());
  });

  it('测试连接返回 401 错误时展示智能排查诊断建议', async () => {
    testAi.mockResolvedValue({ ok: false, error: '接口回了 401: Unauthorized invalid_api_key' });
    renderSection(baseSettings);

    fireEvent.click(screen.getByText('测试连接'));
    await waitFor(() => expect(screen.getByText(/Unauthorized/)).toBeDefined());
    expect(screen.getByText(/密钥异常/)).toBeDefined();
    expect(screen.getByText(/请在服务商控制台核对 Key/)).toBeDefined();
  });

  /**
   * 「这家还没配密钥」和「别家配过」必须分开说——不然是让他以为整个应用没配过，
   * 或者以为格子里空着是他自己漏填的。
   */
  it('切到一家没配密钥的、而地址不像本机服务 → 说「这家还没配密钥」', () => {
    const two = apiCfg('deepseek', {
      deepseek,
      openai: { baseUrl: OPENAI, key: '', model: 'gpt-6.1-sol' },
    });
    renderSection(two);
    fireEvent.click(screen.getByText('OpenAI'));
    expect(screen.getByText(/这家还没配密钥/)).toBeDefined();
  });

  it('忘掉这一家：从表里去掉这一条，并把选中清空', () => {
    const { setDraft } = renderSection(apiCfg('deepseek', { deepseek, openai: { baseUrl: OPENAI, key: 'k-openai-k', model: 'm' } }));
    fireEvent.click(screen.getByText(/忘掉这一家/));
    const next = setDraft.mock.calls[0][0] as Settings;
    expect(next.aiEndpointId).toBe('');
    expect(Object.keys(next.aiEndpoints)).toEqual(['openai']);
  });

  /**
   * 展开「更多厂商（N）」时，那 N 颗必须**限高自己滚**。
   *
   * 桌面版真包实测（窗口 1200×800 → 内容区 1186×763，弹层正文可视 478px）：
   * 收着时 10 颗 = 2 行、「接口地址」那一项 220px；展开后 32 颗 = 6 行，那一项涨到
   * 374px。**差值全部落在这一项上**（逐项高度对拍过），没有别的东西在长。
   *
   * ⚠️ **这条守的是「展开有个上界」，不是「模型/密钥不会被埋」。** 限到 100px 之后
   * 实测：展开的代价从 +155px 降到 +139px，而「模型」仍然落在折线以下 43px、
   * 「密钥」在折线以下 149px——**收着的时候密钥就已经差 10px 在折线以下了**。
   * 折线在哪儿是这一屏的固有事实，浏览一份 22 家的长列表必然要占地方；限高封的是
   * 「按内容长」这件事（窗口越窄能绕到十几行，把整页顶到任意远），封完代价可预测。
   * 真正能解决的是把剩下 22 颗收进一个可搜索的选择器，那是另一次决定。
   *
   * 所以断言只钉**限高 + 自己滚**这个形状、限高值落在 80–120 之间，不钉死 100px
   * （改高度时顺手动一下即可），也**不去断言折线**——那条断言会把一个还没做的决定
   * 变成一条会骗人的红线。
   */
  it('展开更多厂商时那批芯片限高自己滚（给展开封上界，不让它按内容长）', () => {
    renderSection(apiCfg('', {}));
    // 抓住再点：点开之后这颗按钮的文案变成「收起厂商」，点完再找就找不到了
    const toggle = screen.getByText(/^更多厂商/);
    const item = toggle.closest('.ant-form-item');
    expect(item, '更多厂商那颗按钮不在「接口地址」这一项里？').not.toBeNull();

    fireEvent.click(toggle);

    // 那一项里有好几个 .ant-space：常用芯片那排、展开后那 N 颗、后面几处。
    // 带 maxHeight 的那一个就是被限住的那批。
    const capped = Array.from(item!.querySelectorAll<HTMLElement>('.ant-space'))
      .find((el) => el.style.maxHeight);

    expect(capped, '展开后的厂商芯片没有限高——它会按内容长，窗口越窄能绕到十几行，把整页顶到任意远').toBeTruthy();
    expect(capped!.style.overflowY, '限高而不滚 = 底下的芯片直接看不着').toBe('auto');
    // 4 行 × (20px 芯片 + 4px 行缝) 略留余量；写成不限死是为了调高度时不必改这条
    expect(Number.parseInt(capped!.style.maxHeight, 10)).toBeLessThanOrEqual(120);
    expect(Number.parseInt(capped!.style.maxHeight, 10)).toBeGreaterThanOrEqual(80);
  });
});
