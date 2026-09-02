import { describe, it, expect } from 'vitest';
import { checkPushEntries, decidePush, stableKey, type PushEntry } from './push.js';
import { newTask } from './store.js';

const e = (p: Partial<PushEntry> = {}): PushEntry =>
  ({ id: 'a', op: 'upsert', base: null, value: { id: 'a', title: '手机改的' }, ...p });
const srv = (title: string) => ({ id: 'a', title });

/** 一条能过最小形状关的任务。字段照 `store.ts` 的 `Task`，只带必填那几个。 */
const tv = (p: Record<string, unknown> = {}) => ({
  id: 'a', title: '手机改的', status: 'todo',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-22T01:00:00.000Z', ...p,
});
/** 一条能过最小形状关的收件箱条目。 */
const iv = (p: Record<string, unknown> = {}) => ({
  id: 'a', text: '随手记', createdAt: '2026-08-01T00:00:00.000Z', processed: false, taskIds: [], ...p,
});

describe('stableKey：键顺序无关的内容比对', () => {
  it('键顺序不同、内容相同 → 同一个 key', () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
  });
  it('嵌套对象的键顺序也无关', () => {
    expect(stableKey({ x: { p: 1, q: 2 } })).toBe(stableKey({ x: { q: 2, p: 1 } }));
  });
  it('数组顺序有关——[1,2] 跟 [2,1] 不是同一份内容', () => {
    expect(stableKey([1, 2])).not.toBe(stableKey([2, 1]));
  });
  it('数组里那些对象的键顺序仍然无关', () => {
    expect(stableKey([{ a: 1, b: 2 }])).toBe(stableKey([{ b: 2, a: 1 }]));
  });
  it('数组还是序列化成数组，不会退化成「下标当键」的对象', () => {
    // 退化了的话 syncAll 会把一份被改坏成 {"0":"a"} 的 JSON 判成跟 ["a"] 一样、
    // 认为「没变」不重写，坏文件就一直留在盘上。
    expect(stableKey(['a'])).not.toBe(stableKey({ 0: 'a' }));
  });
  it('内容真的不同 → 不同的 key', () => {
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }));
  });
});

describe('decidePush：改过的（有基准）', () => {
  it('服务端 == 基准 → 推我的', () => {
    expect(decidePush(e({ base: srv('原文'), value: srv('手机改的') }), srv('原文'))).toBe('push');
  });
  it('服务端 == 我改的 → 清记号（上一次推成功了、回执没收到）', () => {
    expect(decidePush(e({ base: srv('原文'), value: srv('手机改的') }), srv('手机改的'))).toBe('clear');
  });
  it('三者都不同 → 冲突', () => {
    expect(decidePush(e({ base: srv('原文'), value: srv('手机改的') }), srv('桌面改的'))).toBe('conflict');
  });
  it('「两边已经一样」要排在「服务端==基准」前面判——不然重推会被当成又一次推', () => {
    // 基准和服务端都是「原文」、手机那份也是「原文」（改了又改回去）：clear，不是 push
    expect(decidePush(e({ base: srv('原文'), value: srv('原文') }), srv('原文'))).toBe('clear');
  });
  it('服务端已经没有这一条（桌面删掉了）→ 冲突，不复活', () => {
    expect(decidePush(e({ base: srv('原文'), value: srv('手机改的') }), undefined)).toBe('conflict');
  });
});

describe('decidePush：新建的 / 没有基准的', () => {
  it('服务端没有这个 id → 直接创建', () => {
    expect(decidePush(e({ base: null, value: srv('新记的') }), undefined)).toBe('push');
  });
  it('服务端那份是 null（readOne 说「没有」的方式）→ 照样直接创建，不是冲突', () => {
    // readOne(): T | null。只认 undefined 的话每一条离线新建都翻成 conflict——
    // 实体永远建不出来、目录堆满副本，而且不报错。
    expect(decidePush(e({ base: null, value: srv('新记的') }), null)).toBe('push');
  });
  it('服务端有、内容一样 → 清记号', () => {
    expect(decidePush(e({ base: null, value: srv('新记的') }), srv('新记的'))).toBe('clear');
  });
  it('服务端有、内容不同（旧格式迁移来的那种）→ 冲突，不覆盖桌面', () => {
    expect(decidePush(e({ base: null, value: srv('手机的') }), srv('桌面的'))).toBe('conflict');
  });
});

describe('decidePush：删掉的', () => {
  const d = (base: unknown) => e({ op: 'delete', base, value: null });
  it('服务端 == 基准 → 真删', () => {
    expect(decidePush(d(srv('原文')), srv('原文'))).toBe('push');
  });
  it('服务端改过了 → 不删，写冲突副本', () => {
    expect(decidePush(d(srv('原文')), srv('桌面改的'))).toBe('conflict');
  });
  it('服务端也已经没有了 → 清记号，什么都不做', () => {
    expect(decidePush(d(srv('原文')), undefined)).toBe('clear');
  });
  it('服务端那份是 null（readOne 说「没有」的方式）→ 清记号，不是当成「服务端改过了」写副本', () => {
    expect(decidePush(d(srv('原文')), null)).toBe('clear');
  });
  it('没有基准（旧格式迁移来的删除）→ 判不出服务端动没动过，不删也不写副本', () => {
    expect(decidePush(d(null), srv('桌面那份'))).toBe('clear');
  });
});

describe('checkPushEntries：不合形状的一律整批拒掉，不「跳过这一条」', () => {
  it('不是数组 → null', () => { expect(checkPushEntries({}, 'tasks')).toBeNull(); });
  it('空数组 → 空数组（合法）', () => { expect(checkPushEntries([], 'tasks')).toEqual([]); });
  it('条目不是对象 → null', () => { expect(checkPushEntries(['a'], 'tasks')).toBeNull(); });
  it('条目是 null → null，不是抛出去变成 500', () => { expect(checkPushEntries([null], 'tasks')).toBeNull(); });
  it('id 不是非空字符串 → null', () => {
    expect(checkPushEntries([{ id: '', op: 'upsert', base: null, value: tv({ id: '' }) }], 'tasks')).toBeNull();
  });
  it('op 不认识 → null', () => {
    expect(checkPushEntries([{ id: 'a', op: 'merge', base: null, value: tv() }], 'tasks')).toBeNull();
  });
  it('upsert 没带 value → null', () => {
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: null }], 'tasks')).toBeNull();
  });
  it('value 的 id 跟条目的 id 对不上 → null（不然会拿 A 的内容写到 B 的文件名上）', () => {
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: tv({ id: 'b' }) }], 'tasks')).toBeNull();
  });
  it('base 的 id 对不上 → null', () => {
    expect(checkPushEntries([{ id: 'a', op: 'delete', base: { id: 'b' }, value: null }], 'tasks')).toBeNull();
  });
  it('delete 不带 value 也过（value 为 null）', () => {
    expect(checkPushEntries([{ id: 'a', op: 'delete', base: { id: 'a' }, value: null }], 'tasks'))
      .toEqual([{ id: 'a', op: 'delete', base: { id: 'a' }, value: null }]);
  });
  it('delete 带了 value 也不留着——归一成 null，下游只许看 base', () => {
    // 删除撞车时写进冲突副本的内容是**基准**（正本决定③）。手机那份长什么样对
    // 「删不删」没有影响，留着只会给下游一个不该存在的第二选择。
    expect(checkPushEntries([{ id: 'a', op: 'delete', base: { id: 'a' }, value: { id: 'a', title: '手机上那份' } }], 'tasks'))
      .toEqual([{ id: 'a', op: 'delete', base: { id: 'a' }, value: null }]);
  });
  it('一整批里坏一条 → 整批 null，不是「其余照常」', () => {
    expect(checkPushEntries([
      { id: 'a', op: 'upsert', base: null, value: tv() },
      { id: 'b', op: 'upsert', base: null, value: tv({ id: 'c' }) },
    ], 'tasks')).toBeNull();
  });
  it('缺 base 键（JSON 把 undefined 整个丢掉了）→ 当成「没有基准」，不是拒掉', () => {
    expect(checkPushEntries([{ id: 'a', op: 'upsert', value: tv() }], 'tasks'))
      .toEqual([{ id: 'a', op: 'upsert', base: null, value: tv() }]);
  });
});

/**
 * `value` 的最小形状关。**这是这个服务上唯一接收另一台设备数据的入口**，而其余
 * 每一条写路由都过一份字段白名单；不量一下的话，`{ id, 随便: [1,2,3] }` 会被原样
 * 落盘成 `data/tasks/<id>.json`。两个方向各有测试：拒掉「明显不是这个实体」的，
 * **同时**放过「只是版本对不上」的——后者被拒的代价是用户的离线改动永远推不回去。
 */
describe('checkPushEntries：value 的最小形状（挡「明显不是这个实体」）', () => {
  it('完全不是任务的对象 → null（零校验的话它会被原样落盘成一条任务）', () => {
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: { id: 'a', 随便: [1, 2, 3] } }], 'tasks'))
      .toBeNull();
  });
  it('把收件箱条目推进 tasks 桶 → null（两套名单不通用）', () => {
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: iv() }], 'tasks')).toBeNull();
  });
  it('把任务推进 inbox 桶 → null', () => {
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: tv() }], 'inbox')).toBeNull();
  });
  it('少一个必填字段（updatedAt）→ null', () => {
    const { updatedAt: _缺这个, ...rest } = tv();
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: rest }], 'tasks')).toBeNull();
  });
  it('必填字段类型不对（processed 是字符串）→ null', () => {
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: iv({ processed: 'false' }) }], 'inbox'))
      .toBeNull();
  });
  it('taskIds 里混了非字符串 → null', () => {
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: iv({ taskIds: [1] }) }], 'inbox'))
      .toBeNull();
  });

  it('`newTask()` 的真实产物一定过得去——这条盯着上面那份手抄的必填名单', () => {
    const t = { ...newTask({ title: '真的任务' }), id: 'a' };
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: t }], 'tasks'))
      .toEqual([{ id: 'a', op: 'upsert', base: null, value: t }]);
  });
  it('多出一个不认识的字段（更新版本的手机）→ **照样过**，不是拒掉', () => {
    const t = tv({ 未来才有的字段: 1 });
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: t }], 'tasks'))
      .toEqual([{ id: 'a', op: 'upsert', base: null, value: t }]);
  });
  it('名单之外的字段缺着（更旧版本的手机）→ **照样过**，只量那几个必填的', () => {
    // notes/subtasks/tags…… 一个都没有，这份任务照样推得回去：判太严的代价是
    // 用户离线期间的改动永远推不上来，比一条字段不全的任务落盘严重得多。
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: tv() }], 'tasks'))
      .toEqual([{ id: 'a', op: 'upsert', base: null, value: tv() }]);
  });
  it('status 是个认不出来的值 → **照样过**（看板对它是挂红标签，不是拒收）', () => {
    const t = tv({ status: '进行中' });
    expect(checkPushEntries([{ id: 'a', op: 'upsert', base: null, value: t }], 'tasks'))
      .toEqual([{ id: 'a', op: 'upsert', base: null, value: t }]);
  });
  it('delete 的 base 不量这把尺子——只有会落盘的 value 才量', () => {
    // base 只参与比对和冲突副本的内容，副本文件名带「冲突副本」、`readAll` 跳过它。
    // 拿同一把尺子卡它只会多拒掉一批合法的老基准。
    expect(checkPushEntries([{ id: 'a', op: 'delete', base: { id: 'a', 老格式: true }, value: null }], 'tasks'))
      .toEqual([{ id: 'a', op: 'delete', base: { id: 'a', 老格式: true }, value: null }]);
  });
});
