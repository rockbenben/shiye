import { describe, expect, it } from 'vitest';
import { allSections, doneSections } from './simpleViews.js';
import { task } from '../test-utils.js';
import type { Task } from '../types.js';

const NOW = new Date('2026-08-14T12:00:00.000Z');

const t = (id: string, over: Partial<Task> = {}): Task => task({ id, title: id, ...over });

describe('allSections', () => {
  it('一组，装下所有没完成的', () => {
    const s = allSections([t('a'), t('b', { status: 'doing' }), t('c', { status: 'later' })], NOW, new Set());
    expect(s).toHaveLength(1);
    expect(s[0].tasks.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('已完成的不在「全部」里——它有自己的去处', () => {
    const s = allSections([t('a'), t('b', { status: 'done' })], NOW, new Set());
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('正在编辑的已完成任务留下', () => {
    const s = allSections([t('b', { status: 'done' })], NOW, new Set(['b']));
    expect(s[0].tasks.map((x) => x.id)).toEqual(['b']);
  });

  it('按紧急度排', () => {
    // 'z' 更紧急（due 更早）——期望顺序 ['z','a'] 跟 id 字典序（'a','z'）相反，
    // 改成按 id 排、或者干脆不排，这条都会红，不会跟「巧合按 id 排」的残次
    // 实现混过去。
    const s = allSections(
      [t('a', { due: '2026-08-20T00:00:00.000Z' }), t('z', { due: '2026-08-15T00:00:00.000Z' })],
      NOW, new Set());
    expect(s[0].tasks.map((x) => x.id)).toEqual(['z', 'a']);
  });
});

describe('doneSections', () => {
  it('只装已完成的', () => {
    const s = doneSections([t('a'), t('b', { status: 'done' })], new Set());
    expect(s[0].tasks.map((x) => x.id)).toEqual(['b']);
  });

  it('最近完成的排最前', () => {
    // 'b' 完成得晚，'a' 完成得早——期望顺序 ['b','a'] 跟 id 字典序（'a','b'）
    // 相反，防的是「其实按 id 排」的残次实现。
    const s = doneSections([
      t('a', { status: 'done', completedAt: '2026-08-01T00:00:00.000Z' }),
      t('b', { status: 'done', completedAt: '2026-08-13T00:00:00.000Z' }),
    ], new Set());
    expect(s[0].tasks.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('没有 completedAt 的退到 updatedAt，不是掉到最后', () => {
    // completedAt 是第一批新加的字段，迁移过来的老任务上是 null。'z' 没有
    // completedAt 但 updatedAt 更新——该排最前；期望顺序 ['z','a'] 跟 id
    // 字典序（'a','z'）相反，同样是为了防「其实按 id 排」的残次实现。
    const s = doneSections([
      t('a', { status: 'done', completedAt: '2026-08-05T00:00:00.000Z' }),
      t('z', { status: 'done', completedAt: null, updatedAt: '2026-08-12T00:00:00.000Z' }),
    ], new Set());
    expect(s[0].tasks.map((x) => x.id)).toEqual(['z', 'a']);
  });

  it('正在编辑的未完成任务留下——点「取消完成」的时候卡不该当场消失', () => {
    const s = doneSections([t('a')], new Set(['a']));
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
  });
});

/**
 * 「已放弃」（仿滴答清单的「放弃」：不做了，但不删，以后回顾还看得见）。
 */
describe('放弃：allSections / doneSections', () => {
  it('放弃的不在「全部」里——它已经了结了', () => {
    const s = allSections([t('a'), t('b', { status: 'abandoned' })], NOW, new Set());
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('**搁置的仍然在「全部」里**——搁置是「暂时不做」，它还会回来', () => {
    const s = allSections([t('a', { status: 'later' })], NOW, new Set());
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('「已完成」视图分两组：已完成 / 已放弃', () => {
    const s = doneSections([t('a', { status: 'done' }), t('b', { status: 'abandoned' })], new Set());
    expect(s.map((g) => g.title)).toEqual(['已完成', '已放弃']);
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
    expect(s[1].tasks.map((x) => x.id)).toEqual(['b']);
  });

  it('在这个视图里点「重新开始」，卡不该当场蒸发——正在编辑的落回「已完成」那一组', () => {
    // status 已经变回 todo，但它还在 keep 里（编辑中）
    const s = doneSections([t('a', { status: 'todo' })], new Set(['a']));
    expect(s[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('正在编辑的已放弃任务留在「已放弃」组，不会跳到「已完成」', () => {
    const s = doneSections([t('a', { status: 'abandoned' })], new Set(['a']));
    expect(s[0].tasks).toEqual([]);
    expect(s[1].tasks.map((x) => x.id)).toEqual(['a']);
  });
});
