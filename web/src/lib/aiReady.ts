import type { Settings } from '../types.js';
import { activeEndpoint } from './aiPresets.js';
import { findProvider } from '../vendor/providerCatalog.generated.js';

/**
 * **AI 那几颗按钮（立即拆解 / 让 AI 回顾一遍 / AI 总览）现在能不能点。**
 * 返回 `null` = 能点；返回一句话 = 不能点，那句话就是要摆在他面前的原因。
 *
 * ## 为什么要有这个
 *
 * 这三颗按钮原来只看「有没有活儿可干」：收件箱里有几条没拆、清单里有没有没了结
 * 的任务。**配置没配也照样点得下去**，点完等它跑一两分钟，然后失败——而失败是
 * 服务端在子进程起不来那一刻才报出来的。对一个刚装好的应用来说，这是新用户第一
 * 分钟就会撞上的一堵墙：按钮亮着、点了、什么都不发生、最后来一句他不知道怎么修
 * 的错。
 *
 * 这个仓库的规矩是「**屏幕上摆着一颗点了会失败的按钮，比不摆更坏**」——`ReviewView`
 * 里那句 `/api/board` 的注释就是这么写的（「那颗也得灰着：屏幕上摆一颗点了只会
 * 得到一句拒绝的按钮，比不摆更坏」）。同一把尺子量到这里，得到的是同一个动作：
 * **把按钮灰掉，并告诉他去哪儿**。
 *
 * ## 为什么住在 lib 而不是各自判断
 *
 * 三颗按钮分在两处（`InboxSidebar` 的「立即拆解」、`ReviewView` 的「回顾」和
 * 「总览」）。各写一份 `settings?.aiMode === 'api' && !activeEndpoint(settings)`
 * 的话，第三个设置项加进来的时候前两处会安静地漏掉——这正是 `STATUS_LABEL`、
 * `CONTEXT_LABEL`、`RESCHEDULE_LABEL` 各自被提出来做成单一出处的同一个原因，
 * 见 `lib/taskView.ts` 顶部那段。
 *
 * ## 判据只管「一定不行」，不管「可能不行」
 *
 * `aiMode: 'cli'` 时**这个同步函数不判断 CLI 在不在 PATH 上**——首屏另有一次
 * 服务端只读检查（`GET /api/ai/status`，见 `server/src/aiStatus.ts` 和 App.tsx），
 * 但那是异步结果，拿不到这里来即时灰按钮；真正要起子进程时，服务端还会报一份
 * 更准的错（「…或者去设置 → AI 拆解，改成「调接口」」，`server/src/expand.ts`）。
 * 所以 cli 模式一律放行。在这里猜「可能没装」而把按钮灰掉，是拿一条不确定的
 * 判据去挡一条确定能试的路。
 */
/**
 * 接口模式还差哪几格。**只回答「填没填」，不回答「能不能连通」**；首屏提示和
 * 三颗 AI 按钮共用这一份，免得服务端说 ready、按钮却因为缺密钥灰着。
 *
 * 自定义/认不出的端点不把密钥算作缺项——客户端分不清它是自建网关还是远程
 * 服务，见下面 `aiBlockedReason` 里的说明。
 */
export function apiMissingFields(settings: Settings): string[] {
  if (settings.aiMode !== 'api') return [];
  const provider = findProvider(settings.aiEndpointId);
  const keyRequired = provider !== undefined && !provider.keyOptional;
  const rec = activeEndpoint(settings);
  const missing: string[] = [];
  if (!rec?.baseUrl.trim()) missing.push('接口地址');
  if (!rec?.model.trim()) missing.push('模型名');
  if (keyRequired && !rec?.key.trim()) missing.push('密钥');
  return missing;
}

export function aiBlockedReason(settings: Settings | null, offline: boolean): string | null {
  // **离线排在没读到前面**：离线的因果更硬（网络层已经告诉你连不上），而且这一句
  // 的下一步是「回到同一个 Wi-Fi」，跟设置没关系。两条同时成立时，先说这一条。
  if (offline) return '现在连不上桌面服务，AI 跑不了。回到同一个网络就会自动恢复。';
  if (!settings) return '设置还没读到，等一会儿就好。';

  // 命令行模式：见上面「判据只管一定不行」那段，这里一律放行。
  if (settings.aiMode !== 'api') return null;

  // 缺哪几项就说哪几项——只说「没配好」，他还得自己猜是哪一格。**接口地址和
  // 模型名是硬性的**（没地址不知道往哪儿发，没模型名不知道叫谁）；**密钥不是**：
  // 本机 Ollama / LM Studio 和自建网关常常不要钥匙，README 里也写着「留空」。
  // 判据来自 provider 目录的 `keyOptional`（那几家标了 true），不是拿地址猜——
  // 猜「127.0.0.1 就一定不要钥匙」会漏掉局域网里的推理服务，反过来也会把
  // 需要钥匙的本地网关放过去。
  //
  // **自定义/认不出的 id 一律不按密钥拦。** 客户端分不清那条地址是自建网关还是
  // 远程服务；拦错的代价是本地模型完全用不了（用户只能编一个假 key 糊弄），
  // 放过去的代价只是远程那家回一次 401，而失败横幅会把接口原话摆出来。
  //
  // 命中已知厂商（`findProvider` 有值）时，密钥仍然按「非空即填过」判：GET
  // 回来的永远是打码串（`••••` 加后四位），它非空就说明服务端给这一家存着真值。
  const missing = apiMissingFields(settings);
  if (missing.length === 0) return null;
  return `还没配好 AI 接口，少了：${missing.join('、')}。去设置 → AI 拆解里补上。`;
}
