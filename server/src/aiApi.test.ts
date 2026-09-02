import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiKeyFrom, buildMessages, chat, chatUrl, configProblem, extractJson, maskKey, runViaApi, scopeLine, testAi, type AiConfig } from './aiApi.js';
import { outboxFiles, writeInbox, writeLists, writeTasks } from './store.js';
import type { Task } from './model.js';

/** 一条任务的最小形状。只有 listId 这一格在这个文件里有意义，别的填满是为了过类型。 */
function task(over: Partial<Task> = {}): Task {
  return {
    id: 't1', title: '写周报', notes: '', status: 'todo', due: null, startAt: null, endAt: null,
    reminders: [], persistentReminder: false, subtasks: [], source: 'user', aiComment: '',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    order: null, listId: null, section: null, tags: [], priority: 0, repeat: null,
    completedAt: null, postponeCount: 0, waitingFor: null, context: null,
    attachments: [], estimateMinutes: null, focusSessions: [], habit: false, pinned: false, reviewedAt: null, parentId: null, ...over,
  };
}


let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiapi-'));
  process.env.DATA_DIR = join(dir, 'data');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const cfg: AiConfig = { baseUrl: 'https://x.test/v1/chat/completions', apiKey: 'k', model: 'm' };

/** 假 fetch：回一个「模型说了这段话」的 OpenAI 兼容响应。 */
const replying = (content: string): typeof fetch => vi.fn(async () => new Response(
  JSON.stringify({ choices: [{ message: { content } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
)) as unknown as typeof fetch;

describe('chatUrl：三种填法都得认', () => {
  it('已经是完整地址就原样用', () => {
    expect(chatUrl('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('尾部斜杠不影响判断——不去掉的话会拼出 //chat/completions', () => {
    expect(chatUrl('https://api.openai.com/v1/chat/completions/')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('填到 base（有路径）就补 /chat/completions', () => {
    expect(chatUrl('https://generativelanguage.googleapis.com/v1beta/openai'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });

  /**
   * 光一个域名是最常见的一种手滑。补 `/chat/completions` 的话会 404，而 404 的
   * 报错里看不出少的是 `/v1` 那一段——所以这条补的是 `/v1/chat/completions`。
   */
  it('光一个域名，补的是 /v1/chat/completions，不是 /chat/completions', () => {
    expect(chatUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/chat/completions');
    expect(chatUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('首尾空白不算路径', () => {
    expect(chatUrl('  https://api.deepseek.com  ')).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});

describe('extractJson：模型不会老老实实只回 JSON', () => {
  it('干净的数组直接过', () => {
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it('三反引号围栏剥掉', () => {
    expect(extractJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(extractJson('```\n[1,2]\n```')).toEqual([1, 2]);
  });

  it('JSON 前后多说的两句话截掉', () => {
    expect(extractJson('好的，我拆好了：\n[{"a":1}]\n以上。')).toEqual([{ a: 1 }]);
  });

  it('包了一层单键对象也认——模型即使没被要求也爱包一层', () => {
    expect(extractJson('{"entries":[{"a":1}]}')).toEqual([{ a: 1 }]);
    expect(extractJson('{"tasks":[]}')).toEqual([]);
  });

  /** 多个键说不清该拆哪个，宁可报错也别猜——猜错了会把一份好数据丢掉一半。 */
  it('两个键的对象不猜，直接报错', () => {
    expect(() => extractJson('{"entries":[1],"note":"..."}')).toThrow(/不是数组/);
  });

  it('压根没有 JSON 时报得明白', () => {
    expect(() => extractJson('我已经写好 outbox-20260830.json 了')).toThrow(/没有 JSON/);
  });
});

describe('maskKey / aiKeyFrom：密钥不原样回给浏览器', () => {
  it('留后四位，能认出存着的是哪一把', () => {
    expect(maskKey('sk-abcdefghijkl')).toBe('••••ijkl');
  });

  it('短到看不出后四位就全打码——8 位以下露 4 位等于露一半', () => {
    expect(maskKey('sk-12345')).toBe('••••');
    expect(maskKey('')).toBe('');
  });

  /**
   * 这一条是整件事的关键：界面读回来的是打码串，用户不碰它、只改了别的设置再
   * 保存，请求体里带回来的就是那串打码。不认它的话密钥会被 `••••abcd` 覆盖，
   * 而这次覆盖悄无声息，要等下一次拆解报 401 才现形。
   */
  const same = { incoming: 'https://x.test/v1', stored: 'https://x.test/v1' };
  const moved = { incoming: 'https://攻击者.test/v1', stored: 'https://x.test/v1' };

  it('收到的正是自己打码回去的那串 → 保持原样', () => {
    expect(aiKeyFrom('••••ijkl', 'sk-abcdefghijkl', same)).toBe('sk-abcdefghijkl');
  });

  /** 「改了地址、没动密钥」：最常见的试法，打码那一支照样认。 */
  it('打码串 + 换了地址 → 仍然沿用——这是界面的正常走法', () => {
    expect(aiKeyFrom('••••ijkl', 'sk-abcdefghijkl', moved)).toBe('sk-abcdefghijkl');
  });

  it('请求体里压根没这个字段、地址没变 → 保持原样', () => {
    expect(aiKeyFrom(undefined, 'sk-abcdefghijkl', same)).toBe('sk-abcdefghijkl');
  });

  /**
   * **没这个字段、地址却换了 → 不沿用。** 原来这一支无条件返回存着的密钥，
   * 那是一条把密钥送给任意地址的路（第三方网页发得出这种请求，理由见
   * `aiKeyFrom` 的注释）。真实客户端从不省略这个字段，收紧对界面零影响。
   */
  it('没这个字段、地址换了 → 空——密钥不跟着搬去陌生地址', () => {
    expect(aiKeyFrom(undefined, 'sk-abcdefghijkl', moved)).toBe('');
  });

  it('换了一把新的 → 照收', () => {
    expect(aiKeyFrom('sk-new', 'sk-old', same)).toBe('sk-new');
  });

  it('空串 = 真的清掉——不留这条路就没法删密钥', () => {
    expect(aiKeyFrom('', 'sk-abcdefghijkl', same)).toBe('');
  });

  /** 本来就没存 → 那串打码只是一段普通文字，照收（也就是存了个假的，他自己看得见）。 */
  it('本来没存密钥时，打码串不再有特殊含义', () => {
    expect(aiKeyFrom('••••ijkl', '', same)).toBe('••••ijkl');
  });
});

describe('buildMessages：规则读原文，数据当场读盘', () => {
  it('system 里是 AGENTS.md 和对应 workflow 的原文，不是这个文件里抄的精简版', () => {
    const [sys] = buildMessages('expand');
    const agents = readFileSync('AGENTS.md', 'utf8');
    // 抄一份的话两条路会慢慢飘——所以这里比的是「原文的一大段真的在里面」。
    expect(sys.content).toContain(agents.slice(0, 400));
    expect(sys.content).toContain(readFileSync('workflows/expand.md', 'utf8').slice(0, 200));
  });

  it('拆解带的是未处理的收件箱条目和清单，已处理的不进提示词', () => {
    writeInbox([
      { id: 'a', text: '要拆的', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [] },
      { id: 'b', text: '拆过了', createdAt: '2026-08-01T00:00:00.000Z', processed: true, taskIds: ['t1'] },
    ]);
    writeLists([{ id: 'l1', name: '工作', color: '', folderId: null, order: 0, archived: false, filter: null }]);

    const [, user] = buildMessages('expand');
    expect(user.content).toContain('要拆的');
    expect(user.content).not.toContain('拆过了');
    expect(user.content).toContain('工作');
  });

  /** CLI 那条路的 AI 从环境里知道今天几号，这条不注入就只能瞎猜 `due`。 */
  it('user 里写着现在几点', () => {
    const [, user] = buildMessages('expand');
    expect(user.content).toMatch(/^现在是 \d{4}-\d{2}-\d{2}T/);
  });

  it('回顾读的是另一份 workflow，带的是任务/建议/观察', () => {
    const [sys, user] = buildMessages('review');
    expect(sys.content).toContain(readFileSync('workflows/review.md', 'utf8').slice(0, 200));
    expect(user.content).toContain('data/tasks/');
    expect(user.content).toContain('data/proposals/');
    expect(user.content).toContain('data/insights/');
  });

  /**
   * 「只回顾这一份清单」。**筛和说是一件事的两半，缺哪半都是坏的**：只说不筛，
   * 那几百条不相干的任务照样进提示词、照样付 token（省钱那一半就没了）；只筛不
   * 说，模型拿到的是一份自称「data/tasks/」的残缺数据，会据它下「你手上统共
   * 就三件事」这种全局判断。所以两半各钉一条。
   */
  describe('回顾带范围', () => {
    const two = (): void => {
      writeLists([
        { id: 'l1', name: '035 办事师爷', color: '', folderId: null, order: 0, archived: false, filter: null },
        { id: 'l2', name: '别的项目', color: '', folderId: null, order: 1, archived: false, filter: null },
      ]);
      writeTasks([
        task({ id: 'a', title: '范围内的', listId: 'l1' }),
        task({ id: 'b', title: '别的清单的', listId: 'l2' }),
        task({ id: 'c', title: '没归属的', listId: null }),
      ]);
    };

    it('筛：别的清单和没归属的都不进提示词', () => {
      two();
      const [, user] = buildMessages('review', { listId: 'l1', listName: '035 办事师爷' });
      expect(user.content).toContain('范围内的');
      expect(user.content).not.toContain('别的清单的');
      expect(user.content).not.toContain('没归属的');
    });

    it('说：范围那句话在里面，还写明筛掉了多少', () => {
      two();
      const [, user] = buildMessages('review', { listId: 'l1', listName: '035 办事师爷' });
      expect(user.content).toContain(scopeLine({ listId: 'l1', listName: '035 办事师爷' }));
      expect(user.content).toContain('全部 3 条里的 1 条');
    });

    // 不带范围就是老行为。这条钉的是「新参数没有偷偷改掉默认」——它是可选的，
    // 而所有老调用点（回顾那一屏那颗按钮、定时任务）都不会传。
    it('不带范围时三条都在，也不提范围', () => {
      two();
      const [, user] = buildMessages('review');
      expect(user.content).toContain('范围内的');
      expect(user.content).toContain('别的清单的');
      expect(user.content).toContain('没归属的');
      expect(user.content).not.toContain('这次只回顾清单');
    });

    // 判据只认 listId：清单名会改、也可能撞，它在提示词里只是让话读得懂。
    it('筛的判据是 listId 不是名字', () => {
      writeLists([{ id: 'l1', name: '重名', color: '', folderId: null, order: 0, archived: false, filter: null }]);
      writeTasks([task({ id: 'a', title: '要的', listId: 'l1' }), task({ id: 'b', title: '不要的', listId: 'l9' })]);
      const [, user] = buildMessages('review', { listId: 'l1', listName: '重名' });
      expect(user.content).toContain('要的');
      expect(user.content).not.toContain('不要的');
    });

    /**
     * **别的清单的任务连 id 都不该出现在提示词里。** 上面几条断言的是标题，而
     * `scopeLine` 那段注释里有一句更强的话——「模型压根看不见别的清单，连它们的
     * id 都不知道，想提也提不出来」，那句话是这条路**唯一的硬约束**（CLI 那条只有
     * 提示词里的一句请求）。id 漏出去就不成立了：`updates` 只要给对 id 就能提到
     * 范围外的任务身上，而 `mergeOutbox` 不认识范围、拦不住。
     *
     * 标题可以只是没被引用，id 泄漏却是实打实的能力——所以单独钉一条。
     */
    it('范围外任务的 id 一个都不出现在提示词里', () => {
      two();
      const [, user] = buildMessages('review', { listId: 'l1', listName: '035 办事师爷' });
      // 范围内那条的 id 在（不然下面两条是废话）。
      expect(user.content).toContain('"a"');
      expect(user.content).not.toContain('"b"');
      expect(user.content).not.toContain('"c"');
    });
  });

  /**
   * 上面两份规则原文里明确写着「你自己写 data/outbox-<unique>.json」。不改口的话
   * 模型会回一句「我已经写好了」然后什么都没有——而那种失败在界面上跟
   * 「AI 判断没什么好拆的」长得一模一样。
   */
  it('最后改口说清楚文件由服务写，只要回 JSON', () => {
    const [sys] = buildMessages('expand');
    expect(sys.content).toContain('没有文件系统');
    expect(sys.content).toContain('把那个 JSON 数组作为回复正文直接发回来');
  });
});

describe('chat：请求怎么发、报错怎么说', () => {
  it('带密钥时发 Bearer 头，模型名原样进 body', async () => {
    const f = replying('[]');
    await chat(cfg, buildMessages('expand'), f, new AbortController().signal);

    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string).model).toBe('m');
  });

  /** 本机跑的 Ollama / LM Studio 不要钥匙，硬塞一个空 Bearer 头有的会 401。 */
  it('没密钥时不带 Authorization 头', async () => {
    const f = replying('[]');
    await chat({ ...cfg, apiKey: '' }, buildMessages('expand'), f, new AbortController().signal);
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  /**
   * 只报状态码的话，用户在界面上看到「AI 失败：401」，既不知道是钥匙错还是没
   * 充值，也不知道该改设置里哪一格。响应正文里那句话才是唯一有用的信息。
   */
  it('4xx 时把响应正文一起报出来，不只报状态码', async () => {
    const f = vi.fn(async () => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 })) as unknown as typeof fetch;
    await expect(chat(cfg, buildMessages('expand'), f, new AbortController().signal))
      .rejects.toThrow(/401.*Incorrect API key/);
  });

  it('200 但内容是空的也算失败——不能当成「没什么可拆的」', async () => {
    const f = replying('   ');
    await expect(chat(cfg, buildMessages('expand'), f, new AbortController().signal)).rejects.toThrow(/空的/);
  });

  it('回的不是 JSON（中转返了一页 HTML）时说清楚', async () => {
    const f = vi.fn(async () => new Response('<html>502</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(chat(cfg, buildMessages('expand'), f, new AbortController().signal)).rejects.toThrow(/不是 JSON/);
  });
});

describe('runViaApi：结果落成 outbox 文件', () => {
  it('写出来的文件名和形状跟 AI 自己写的一样——后面的合并分辨不出来源', async () => {
    const entry = { inboxId: 'a', tasks: [{ title: '买猫粮' }] };
    const wrote = await runViaApi('expand', cfg, replying(JSON.stringify([entry])), new AbortController().signal);

    expect(wrote).toBe(true);
    const files = outboxFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/outbox-.+\.json$/);
    expect(JSON.parse(readFileSync(files[0], 'utf8'))).toEqual([entry]);
  });

  /** 空数组 = 模型明确说「没什么可产出」，等价于 CLI 那条路「跑完了什么都没写」。 */
  it('模型回空数组：不写文件，回 false', async () => {
    expect(await runViaApi('expand', cfg, replying('[]'), new AbortController().signal)).toBe(false);
    expect(outboxFiles()).toEqual([]);
  });

  it('原子写：不留 .tmp 在 data/ 里', async () => {
    await runViaApi('expand', cfg, replying('[{"inboxId":"a","tasks":[]}]'), new AbortController().signal);
    expect(outboxFiles().some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

describe('configProblem：能不能跑，说人话', () => {
  const ok: AiConfig = { baseUrl: 'https://x.test/v1', apiKey: 'sk-abc', model: 'm' };

  it('三格都对就没问题', () => {
    expect(configProblem(ok)).toBeNull();
  });

  it('本机那类不要密钥，空串照样能跑', () => {
    expect(configProblem({ ...ok, apiKey: '' })).toBeNull();
  });

  it('缺哪格说哪格，不说「配置不完整」', () => {
    expect(configProblem({ ...ok, baseUrl: '  ' })).toMatch(/接口地址还没填/);
    expect(configProblem({ ...ok, model: '' })).toMatch(/模型名还没填/);
  });

  /**
   * 这一条是端到端跑出来的，不是想出来的：密钥要拼进 `Authorization` 头，而 HTTP
   * 头是 ByteString——一个中文字符就让 `fetch` 抛
   * `Cannot convert argument to a ByteString because the character at index 10 has
   * a value of 27979`。用户看到这句只能干瞪眼：它没说是哪一格，更没说「你粘贴密钥
   * 的时候带进了中文字符」。
   *
   * 五个样本各代表一种真实的粘贴事故：中文、中间夹空格、末尾换行、全角字母、
   * 全角空格（最阴的一个——它在输入框里看着就是个空格）。
   */
  it('密钥里混进中文/空格/换行/全角字符时，在发请求之前就拦下并说清楚', () => {
    const bads = ['sk-测试用的', 'sk-abc def', 'sk-abc' + String.fromCharCode(10), 'sk-ａbc', 'sk-abc' + String.fromCharCode(0x3000)];
    for (const bad of bads) {
      expect(configProblem({ ...ok, apiKey: bad }), `${JSON.stringify(bad)} 该被拦下`)
        .toMatch(/粘贴的时候多半会带进来/);
    }
  });

  it('正常密钥里的符号一个都不误伤', () => {
    for (const good of ['sk-proj_ABC123', 'sk-a.b~c', 'AIzaSy-_09azAZ', 'hf_xxx==']) {
      expect(configProblem({ ...ok, apiKey: good }), `${good} 不该被拦`).toBeNull();
    }
  });
});

describe('testAi：一次最便宜的调用，验那三格填对没有', () => {
  const ok: AiConfig = { baseUrl: 'https://x.test/v1', apiKey: 'sk-abc', model: 'm' };
  const sig = () => new AbortController().signal;

  it('通了回 null', async () => {
    expect(await testAi(ok, replying('好'), sig())).toBeNull();
  });

  /**
   * **提示词只有一句话，不走 `buildMessages`**：那份要贴进 AGENTS.md 全文加整个
   * 收件箱（实测 18KB 的 system），拿它「试一下通不通」是荒唐的。这条断言就是
   * 钉住这件事——哪天有人图省事把 `buildMessages` 接过来，这里会红。
   */
  it('发出去的提示词很小，不是那份贴了 AGENTS.md 全文的', async () => {
    const f = replying('好');
    await testAi(ok, f, sig());
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    expect(sent.messages).toHaveLength(1);
    expect((init.body as string).length).toBeLessThan(500);
  });

  it('三格没填全时压根不发请求，直接回那句人话', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    expect(await testAi({ ...ok, model: '' }, f, sig())).toMatch(/模型名还没填/);
    expect(await testAi({ ...ok, apiKey: 'sk-测试' }, f, sig())).toMatch(/粘贴的时候多半会带进来/);
    expect(f).not.toHaveBeenCalled();
  });

  /** 接口回的那段话原样往上抛——「401」三个字没告诉他是钥匙错还是没充值。 */
  it('接口报错时回的是接口自己那句话，不是一个状态码', async () => {
    const f = vi.fn(async () => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 })) as unknown as typeof fetch;
    expect(await testAi(ok, f, sig())).toMatch(/401.*Incorrect API key/);
  });

  it('回的内容是空的也算没通', async () => {
    expect(await testAi(ok, replying('  '), sig())).toMatch(/空的/);
  });
});

describe('chat：连不上的时候说人话，不是 undici 那句 fetch failed', () => {
  const sig = () => new AbortController().signal;

  /**
   * 端到端跑出来的：地址填错时这条路原来回的是 `fetch failed`——那是运行时的内部
   * 措辞，对着一个填错的地址等于什么都没说。跟密钥里混进中文那条同一类。
   */
  it('网络层失败：带上地址和该去检查什么', async () => {
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await testAi({ baseUrl: 'http://127.0.0.1:31999/v1', apiKey: '', model: 'm' }, f, sig());
    expect(err).toMatch(/连不上/);
    expect(err, '地址要原样报出来——他得能一眼看出是不是少了 /v1').toContain('http://127.0.0.1:31999/v1/chat/completions');
    expect(err).toMatch(/本机跑的模型确认它已经启动/);
  });

  it('超时单独说——那跟「地址写错了」是两回事', async () => {
    const f = vi.fn(async () => { const e = new Error('The operation was aborted'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch;
    expect(await testAi({ baseUrl: 'https://x.test/v1', apiKey: '', model: 'm' }, f, sig())).toMatch(/超时了/);
  });
});
