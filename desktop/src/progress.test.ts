import { describe, expect, it, vi } from 'vitest';
import { fetchSummary, progressFraction } from './progress.js';

describe('progressFraction：任务栏那条进度条该画成什么样', () => {
  it('今天没安排 → 不画（null）——Electron 那边用 -1 表示「撤掉」', () => {
    expect(progressFraction({ total: 0, done: 0, remaining: 0 })).toBeNull();
  });

  it('做了一半 → 0.5', () => {
    expect(progressFraction({ total: 4, done: 2, remaining: 2 })).toBe(0.5);
  });

  it('全做完了 → 1（一条满的）', () => {
    expect(progressFraction({ total: 3, done: 3, remaining: 0 })).toBe(1);
  });

  it('**分母是「今天一共几件」，不是「还剩几件」**——不然永远画不满', () => {
    // 今天一共 4 件、做完 1 件：进度条是 1/4。拿 remaining 当分母的话，
    // 做完一件就变 1/3、再做一件又变 1/2——条越做越短，跟常理反着。
    expect(progressFraction({ total: 4, done: 1, remaining: 3 })).toBe(0.25);
  });

  it('坏数不画——**一条骗人的进度条比没有进度条更坏**', () => {
    expect(progressFraction({ total: NaN, done: 1, remaining: 1 })).toBeNull();
    expect(progressFraction({ total: -1, done: 0, remaining: 0 })).toBeNull();
    expect(progressFraction({ total: 2, done: NaN, remaining: 1 })).toBeNull();
  });

  it('done 超过 total 时夹到 1——不画一条超过 100% 的条', () => {
    expect(progressFraction({ total: 2, done: 5, remaining: 0 })).toBe(1);
  });

  it('done 是负数时夹到 0', () => {
    expect(progressFraction({ total: 2, done: -3, remaining: 5 })).toBe(0);
  });
});

describe('fetchSummary：去服务端取那三个数', () => {
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

  it('拿到就返回那三个数', async () => {
    const s = await fetchSummary('http://localhost:30035', ok({ total: 4, done: 1, remaining: 3 }));
    expect(s).toEqual({ total: 4, done: 1, remaining: 3 });
  });

  it('服务端不答应 → null（**不猜**）', async () => {
    const bad = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await fetchSummary('http://localhost:30035', bad)).toBeNull();
  });

  it('形状不对 → null——总数字段缺了就是取不到，不是 0', async () => {
    expect(await fetchSummary('http://x', ok({ done: 1 }))).toBeNull();
    expect(await fetchSummary('http://x', ok({ total: '4', done: 1 }))).toBeNull();
  });

  it('请求本身炸了（服务没起来）→ null', async () => {
    const boom = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect(await fetchSummary('http://x', boom)).toBeNull();
  });

  it('remaining 缺了也认（**剩下的那一个数画进度条用不上**）', async () => {
    expect(await fetchSummary('http://x', ok({ total: 2, done: 1 }))).toEqual({ total: 2, done: 1, remaining: 0 });
  });
});
