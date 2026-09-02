import { Preferences } from '@capacitor/preferences';

/**
 * `/api/...` 请求前面加的可选 base 前缀。
 *
 * 桌面版 WebView 加载的就是本机服务，相对路径够用——`getApiBase()` 恒为空
 * 字符串，`api.ts` 拼出来的路径跟没有这层时逐字节相同。手机上 `localhost`
 * 是手机自己，要连桌面服务得指到局域网地址（`http://192.168.x.x:30035`），
 * 由用户在「地址设置」里填、`setApiBase()` 存下来（见 `components/ServerSetup.tsx`）。
 *
 * **存储换成了 `@capacitor/preferences`**（Task 1 先用 `localStorage` 占位，
 * 见那份实现留下的注释）。换存储后端只该改这一个文件——`api.ts`、
 * `ServerSetup.tsx`、别的调用方不用碰，也不用知道底层存的是什么，两个导出
 * 函数的签名（同步、`string`/`void`）一个字没变。
 *
 * **这里面唯一的难点**：`Preferences` 的每个方法都是 `Promise`（哪怕它的
 * web 回退就是同步的 `localStorage`，接口形状也是 async 的），但
 * `getApiBase()` 的调用方（`api.ts` 的 `req()`/`subscribe()`/`attachmentUrl()`，
 * 每次请求都要用它）全是同步调用，不能都改成 `await`——那会把改动面从
 * `apiBase.ts` 一个文件炸到 `api.ts` 全文件，正是这一层存在的意义要防的事。
 *
 * 解法：模块内存里存一份镜像 `cache`，模块一加载就异步拉一次持久化的值填进去
 * （`ensureLoaded()`，只发起一次，幂等）。`getApiBase()` 永远同步读这份镜像。
 * 代价是一个真实但极短的启动竞态：原生 `Preferences` 的一次读取是一趟
 * WebView↔原生桥的往返，通常在个位数毫秒内完成，比 React 首次渲染+挂载
 * 副作用还快；`api.ts` 的每次请求接受这个理论上存在、实测够不到的窗口。
 * 赌输了的后果比「5 秒后自己翻回来」要重——5 秒只是 `isOnline()` 那份缓存的
 * TTL，不是自动重探的触发点，真正会重新探测的只有 `refreshOffline()`
 * （挂载时、SSE 的 `onOpen`、和 App.tsx 里 60 秒一次的 tick 会调它）。而
 * 赌输这一拍，`subscribe()` 已经把这个空 base 焊进了 `EventSource` 的构造
 * URL 里，此后 `onOpen` 不会再来——这个会话的 SSE 全程是死的，离线横幅要
 * 等到 60 秒那次 tick 才会翻回「在线」。**以前这个窗口的后果严重得多**
 * （App.tsx 拿它判「要不要弹整页的 ServerSetup」，赌输就是已经配过地址的
 * 人被拦在一面墙前面），那面墙已经删了，那个调用方也没了；SSE 会因此死
 * 掉一段的行为不是这次改动引进的，改动前也一样，只是以前的注释把它说轻了。
 */

const KEY = 'apiBase';

let cache = '';
let loaded: Promise<void> | null = null;

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = Preferences.get({ key: KEY })
      .then((r) => { cache = r.value ?? ''; })
      // 读取本身失败（插件在这个环境里跑不起来之类）就当没配过处理——
      // cache 保持初始的空字符串，等同于「没配过 base」，桌面默认走的
      // 正好就是这条路。
      .catch(() => {});
  }
  return loaded;
}
void ensureLoaded();

export function getApiBase(): string {
  return cache;
}

export function setApiBase(url: string): void {
  // 末尾斜杠归一化：用户填 http://192.168.1.5:30035/，不归一化会拼出
  // //api/tasks（req() 只负责拼 base + path，两边都以为对方管斜杠）。
  const normalized = url.trim().replace(/\/+$/, '');
  cache = normalized;
  // 落盘是异步的，但调用方不需要等它——`cache` 已经同步更新，`getApiBase()`
  // 立刻就能读到新值；写失败（罕见）只是这次没真正持久化，下次冷启动会
  // 回到上一次成功写入的值，不是这里要处理的事。
  void Preferences.set({ key: KEY, value: normalized }).catch(() => {});
}

/**
 * 等真正从 `Preferences` 里加载出来的值就绪。幂等：不管调用几次，都是同一个
 * `ensureLoaded()` 发起的那一趟读取。
 *
 * **现在只有测试在用**（`apiBase.test.ts` 的冷启动那组、`ServerSetup.test.tsx`）
 * ——原来那个生产调用方（App.tsx 判「要不要弹整页 ServerSetup」）连同那面墙
 * 一起删了。留着不删：`ensureLoaded()` 是这个文件唯一有异步时序的地方，
 * 冷启动那条测试需要一个口子等它落定，没有它就只能去赌 `await` 几拍微任务。
 */
export function apiBaseReady(): Promise<void> {
  return ensureLoaded();
}
