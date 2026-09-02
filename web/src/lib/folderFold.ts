/**
 * 侧栏文件夹的折叠状态。**存 `localStorage`，不进 `Settings`**——跟
 * `density.ts` 同一类：这是「我这台机器上侧栏收成什么样」，同步到手机去
 * 没有意义（手机上侧栏本来就是划出来的抽屉，收放的判断跟桌面不是一回事）。
 *
 * ## 为什么现在做了
 *
 * `listIcon.ts` 的 `groupListsByFolder` 上面写着「不做展开折叠：折叠状态又是
 * 一份要存的每台机器偏好，而文件夹本身已经把长列表切成了几段——真正解决
 * 「侧栏太长」的是分组，不是折叠。想要了再加。」
 *
 * 那条理由建立在「清单分散在几个文件夹里」上。实际用起来是另一个形状：
 * **一个文件夹装十一份清单**（一个项目一份，全归在「365」下）。这时候文件夹
 * 没把列表切成几段，只是在十一行前面加了一行标题——侧栏反而更长。
 *
 * 归档也不解决：归档的清单照样一行一行渲染在「已归档」那一节里（`Sidebar.tsx`），
 * 行数一条不少，还多一行标题。侧栏能真正变短的只有折叠。
 *
 * ## 存的是「哪几个收起来了」，不是「哪几个展开着」
 *
 * 默认全展开：新建的文件夹、换一台机器、清掉浏览器数据，都该看得见里面的东西。
 * 存展开集的话这三种情况都会变成「一个文件夹是空的」——而它并不空。
 */
const KEY = 'folder-fold';

/** 收起来的那几个文件夹 id。读不到、格式不对都当作「一个都没收」。 */
export function getFolded(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const v: unknown = JSON.parse(raw);
    // 存进去的是数组，回来的可能是任何东西（手改过、别的版本写的）。
    // 只收字符串项，不整份丢掉——半份坏数据不该让所有文件夹都弹开。
    return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    // 隐私模式/配额满/JSON 坏了都走这儿：当作一个都没收，不炸侧栏。
    return new Set();
  }
}

export function setFolded(ids: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // 存不进去就算了：这次收放只在这个会话里有效。跟 density.ts 同一条。
  }
}

/** 收 ↔ 放。回一份新的集合，不改传进来的那份（调用方拿它进 React state）。 */
export function toggleFolded(ids: Set<string>, id: string): Set<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}
