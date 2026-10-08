import type { Settings } from '../types.js';
import { activeEndpoint } from './aiPresets.js';

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
 * 三颗按钮分在三个文件里（`InboxSidebar` / `ReviewView`，后两件事在同一个文件）。
 * 各写一份 `settings?.aiMode === 'api' && !activeEndpoint(settings)?.key` 的话，第三个设置项
 * 加进来的时候前两处会安静地漏掉——这正是 `STATUS_LABEL`、`CONTEXT_LABEL`、
 * `RESCHEDULE_LABEL` 各自被提出来做成单一出处的同一个原因，见 `lib/taskView.ts`
 * 顶部那段。
 *
 * ## 判据只管「一定不行」，不管「可能不行」
 *
 * `aiMode: 'cli'` 时**没法在这里判断 CLI 在不在 PATH 上**——那是服务端起子进程
 * 才知道的事，浏览器这一侧够不着。所以 cli 模式一律放行，让服务端报它那份更准的
 * 错（「…或者去设置 → AI 拆解，改成「调接口」」，`server/src/expand.ts`）。
 * 在这里猜「可能没装」而把按钮灰掉，是拿一条不确定的判据去挡一条确定能试的路。
 */
export function aiBlockedReason(settings: Settings | null, offline: boolean): string | null {
  // **离线排在没读到前面**：离线的因果更硬（网络层已经告诉你连不上），而且这一句
  // 的下一步是「回到同一个 Wi-Fi」，跟设置没关系。两条同时成立时，先说这一条。
  if (offline) return '现在连不上桌面服务，AI 跑不了。回到同一个网络就会自动恢复。';
  if (!settings) return '设置还没读到，等一会儿就好。';

  // 命令行模式：见上面「判据只管一定不行」那段，这里一律放行。
  if (settings.aiMode !== 'api') return null;

  // 缺哪几项就说哪几项——只说「没配好」，他还得自己猜是哪一格。**三样的顺序跟设置
  // 弹层里从上到下的顺序一致**（接口地址 → 模型名 → 密钥），照着这句话往回找就行。
  //
  // 读的是**当前选中那一条记录**（`aiEndpoints[aiEndpointId]`），不再是三个平铺的
  // 全局格：一家一把钥匙，没选中就等于没填。
  const rec = activeEndpoint(settings);
  const missing: string[] = [];
  if (!rec?.baseUrl.trim()) missing.push('接口地址');
  /**
   * **密钥这一项有个坑：真值一步都不离开这台机器。** `GET /api/settings` 回的是
   * 逐条打码的串（`••••` 加后四位，`aiApi.ts` 的 `maskKey`），所以前端拿到的
   * `key` **永远是打码过的、非空的**——拿它去跟任何「真值」比都比不出来。
   *
   * 而「非空即填过」这个判据在这里恰恰是对的：打码串非空 ⟺ 服务端确实给**这一家**
   * 存着一个密钥。所以判空就够了，**不要试图在这里还原或校验那个值**。
   */
  if (!rec?.model.trim()) missing.push('模型名');
  if (!rec?.key.trim()) missing.push('密钥');

  if (missing.length === 0) return null;
  return `还没配好 AI 接口，少了：${missing.join('、')}。去设置 → AI 拆解里补上。`;
}
