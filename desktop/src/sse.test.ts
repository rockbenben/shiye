import { describe, expect, it, vi } from 'vitest';
import { parseSseChunk, subscribeSse } from './sse.js';

describe('parseSseChunk：一次给一整帧', () => {
  it('解析出 event 和 data，rest 为空', () => {
    const { events, rest } = parseSseChunk('event: reminder\ndata: {"title":"交房租"}\n\n');
    expect(events).toEqual([{ event: 'reminder', data: '{"title":"交房租"}' }]);
    expect(rest).toBe('');
  });

  it('一块里有好几帧，按顺序全解析出来', () => {
    const { events, rest } = parseSseChunk(
      'event: data-changed\ndata: {"file":"tasks"}\n\nevent: reminder\ndata: {"title":"写周报"}\n\n',
    );
    expect(events).toEqual([
      { event: 'data-changed', data: '{"file":"tasks"}' },
      { event: 'reminder', data: '{"title":"写周报"}' },
    ]);
    expect(rest).toBe('');
  });

  it('ping 心跳 data 是空字符串，不是 undefined 或者被丢掉', () => {
    const { events } = parseSseChunk('event: ping\ndata: \n\n');
    expect(events).toEqual([{ event: 'ping', data: '' }]);
  });
});

describe('parseSseChunk：chunk 边界切在帧中间', () => {
  it('半帧（没有结尾的空行）原样进 rest，不当成一条事件解析出来', () => {
    const { events, rest } = parseSseChunk('event: reminder\ndata: {"title"');
    expect(events).toEqual([]);
    expect(rest).toBe('event: reminder\ndata: {"title"');
  });

  it('两次调用能拼出跨块的完整事件——上一次的 rest 接上新的 chunk 再解析', () => {
    const first = parseSseChunk('event: reminder\ndata: {"tit');
    expect(first.events).toEqual([]);
    const second = parseSseChunk(first.rest + 'le":"交房租"}\n\n');
    expect(second.events).toEqual([{ event: 'reminder', data: '{"title":"交房租"}' }]);
    expect(second.rest).toBe('');
  });
});

describe('parseSseChunk：防御', () => {
  it('没有 event 行的帧不会被硬凑成一条空事件', () => {
    const { events } = parseSseChunk('data: 没头没脑的一行\n\n');
    expect(events).toEqual([]);
  });

  it('空字符串——没有任何一帧，也不抛', () => {
    expect(() => parseSseChunk('')).not.toThrow();
    expect(parseSseChunk('').events).toEqual([]);
  });
});

// ── subscribeSse ──

/** 假的流式 Response：把若干个字符串块依次喂给 reader.read()，读完 done:true。 */
function fakeStreamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

const noSleep = vi.fn(async () => {});

describe('subscribeSse：正常收事件', () => {
  it('每一条 data 都 JSON.parse 过再交给 onEvent', async () => {
    const ctrl = new AbortController();
    const fetchFn = vi.fn(async () => fakeStreamResponse(['event: reminder\ndata: {"title":"交房租"}\n\n']));
    const seen: Array<[string, unknown]> = [];

    await subscribeSse('http://x/api/events', (event, data) => {
      seen.push([event, data]);
      ctrl.abort(); // 收到第一条就喊停，不然流结束后会一直重连
    }, { fetchFn: fetchFn as unknown as typeof fetch, sleepFn: noSleep, signal: ctrl.signal });

    expect(seen).toEqual([['reminder', { title: '交房租' }]]);
    expect(fetchFn).toHaveBeenCalledTimes(1); // 喊停之后不该再重连
  });

  it('一次 chunk 里的好几条事件都派发到——不是只处理第一条', async () => {
    const ctrl = new AbortController();
    const fetchFn = vi.fn(async () =>
      fakeStreamResponse(['event: data-changed\ndata: {"file":"tasks"}\n\nevent: reminder\ndata: {"title":"x"}\n\n']),
    );
    const seen: string[] = [];
    await subscribeSse('http://x/api/events', (event) => {
      seen.push(event);
      if (event === 'reminder') ctrl.abort();
    }, { fetchFn: fetchFn as unknown as typeof fetch, sleepFn: noSleep, signal: ctrl.signal });

    expect(seen).toEqual(['data-changed', 'reminder']);
  });
});

describe('subscribeSse：断线自动重连——EventSource 原生就是这个行为', () => {
  it('流正常结束（服务端关了连接）之后重新 fetch，不是就此收工', async () => {
    const ctrl = new AbortController();
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call += 1;
      if (call === 1) return fakeStreamResponse([]); // 立刻 done，模拟断线
      return fakeStreamResponse(['event: reminder\ndata: {"title":"重连后来的"}\n\n']);
    });
    const seen: unknown[] = [];
    await subscribeSse('http://x/api/events', (_e, data) => {
      seen.push(data);
      ctrl.abort();
    }, { fetchFn: fetchFn as unknown as typeof fetch, sleepFn: noSleep, signal: ctrl.signal });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([{ title: '重连后来的' }]);
  });

  it('fetch 直接被拒绝（服务还没起来）也会重试，不会让整个订阅崩掉', async () => {
    const ctrl = new AbortController();
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('ECONNREFUSED');
      return fakeStreamResponse(['event: reminder\ndata: {"title":"重试成功"}\n\n']);
    });
    const seen: unknown[] = [];
    await expect(
      subscribeSse('http://x/api/events', (_e, data) => {
        seen.push(data);
        ctrl.abort();
      }, { fetchFn: fetchFn as unknown as typeof fetch, sleepFn: noSleep, signal: ctrl.signal }),
    ).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([{ title: '重试成功' }]);
  });

  it('重连前真的等了 retryDelayMs——sleepFn 收到配置的延迟，不是写死的别的值', async () => {
    const ctrl = new AbortController();
    let call = 0;
    const fetchFn = vi.fn(async () => {
      call += 1;
      if (call === 1) return fakeStreamResponse([]);
      ctrl.abort();
      return fakeStreamResponse([]);
    });
    const sleepFn = vi.fn(async () => {});
    await subscribeSse('http://x/api/events', () => {}, {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn,
      retryDelayMs: 4242,
      signal: ctrl.signal,
    });
    expect(sleepFn).toHaveBeenCalledWith(4242);
  });
});

describe('subscribeSse：ping 心跳', () => {
  it('data 是空字符串，派发成 (\'ping\', null)，不会因为不是合法 JSON 被吞掉', async () => {
    const ctrl = new AbortController();
    const fetchFn = vi.fn(async () => fakeStreamResponse(['event: ping\ndata: \n\n']));
    const seen: Array<[string, unknown]> = [];
    await subscribeSse('http://x/api/events', (event, data) => {
      seen.push([event, data]);
      ctrl.abort();
    }, { fetchFn: fetchFn as unknown as typeof fetch, sleepFn: noSleep, signal: ctrl.signal });

    expect(seen).toEqual([['ping', null]]);
  });
});

describe('subscribeSse：chunk 边界切在事件中间', () => {
  it('一帧被切成两块也要收到——readOnce 的 buffer 要把半帧带到下一次', async () => {
    const ctrl = new AbortController();
    const fetchFn = vi.fn(async () =>
      fakeStreamResponse(['event: reminder\ndata: {"tit', 'le":"交房租"}\n\n']));
    const seen: unknown[] = [];
    await subscribeSse('http://x/api/events', (_e, d) => { seen.push(d); ctrl.abort(); },
      { fetchFn: fetchFn as unknown as typeof fetch, sleepFn: noSleep, signal: ctrl.signal });
    expect(seen).toEqual([{ title: '交房租' }]);
  });
});

describe('subscribeSse：坏数据不炸整条订阅', () => {
  it('一条事件 JSON 解析失败，后面那条照样派发', async () => {
    const ctrl = new AbortController();
    const fetchFn = vi.fn(async () =>
      fakeStreamResponse(['event: reminder\ndata: {坏json\n\nevent: reminder\ndata: {"title":"这条是好的"}\n\n']),
    );
    const seen: unknown[] = [];
    await subscribeSse('http://x/api/events', (_e, data) => {
      seen.push(data);
      ctrl.abort();
    }, { fetchFn: fetchFn as unknown as typeof fetch, sleepFn: noSleep, signal: ctrl.signal });

    expect(seen).toEqual([{ title: '这条是好的' }]);
  });
});

describe('subscribeSse：已经被 abort 就什么都不做', () => {
  it('signal 一开始就是 aborted 状态——一次 fetch 都不发', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchFn = vi.fn();
    await subscribeSse('http://x/api/events', () => {}, {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleepFn: noSleep,
      signal: ctrl.signal,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
