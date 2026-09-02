import { describe, expect, it } from 'vitest';
import { viewFromHash, hashFromView } from './hashView.js';

describe('viewFromHash', () => {
  it.each([['', 'today'], ['#', 'today'], ['#/', 'today']])('空 hash（%s）落「今天」', (h, v) => {
    expect(viewFromHash(h)).toBe(v);
  });

  it.each(['today', 'upcoming', 'all', 'source', 'done', 'review', 'trash', 'inbox', 'search'])(
    '固定去处 %s 原样读出来', (v) => {
      expect(viewFromHash(`#/${v}`)).toBe(v);
    });

  it('list: 动态 key', () => {
    expect(viewFromHash('#/list:abc-123')).toBe('list:abc-123');
  });

  it('中文标签要能解码回来——标签名是任意用户文本', () => {
    expect(viewFromHash('#/tag:%E5%B7%A5%E4%BD%9C')).toBe('tag:工作');
  });

  it('标签名里带 # 和 / 也认得出来', () => {
    expect(viewFromHash(hashFromView('tag:a/b#c'))).toBe('tag:a/b#c');
  });

  it('认不出的 hash 原样当成 view——旧书签指向已删的清单时，界面该说「没有这个去处」', () => {
    expect(viewFromHash('#/list:早就删了')).toBe('list:早就删了');
  });

  it('解不开的百分号编码不抛，退回原样', () => {
    expect(viewFromHash('#/tag:%E4%B8')).toBe('tag:%E4%B8');
  });
});

describe('hashFromView', () => {
  it('固定去处', () => {
    expect(hashFromView('today')).toBe('#/today');
  });

  it('中文标签编码出去', () => {
    expect(hashFromView('tag:工作')).toBe('#/tag:%E5%B7%A5%E4%BD%9C');
  });

  it('往返：编出去再读回来还是原来那个', () => {
    for (const v of ['today', 'list:abc', 'tag:工作', 'tag:a/b#c', 'tag:100%']) {
      expect(viewFromHash(hashFromView(v))).toBe(v);
    }
  });
});
