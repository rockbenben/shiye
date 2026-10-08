# CONTRIBUTING.md — 改这个仓库的代码时

**这份是给改代码的人/AI 看的，任何工具都适用。**
拆解收件箱的运行约定在 `AGENTS.md`，那是另一件事（而且那份会被打包进桌面端，
由 spawn 出来的子进程读，所以开发规矩不放那里）。

`npm test` 跑全量（typecheck + 两档 vitest）。

**注释里的 `docs/superpowers/…` 是历史引用，那棵树不在仓库里了**，而且**在这个仓库的
git 历史里也翻不出来**——公开发布时历史压成了一个初始提交，那些对象连同旧提交一起
没了（`git log --all -- docs/superpowers/...` 现在返回空，别照着试）。

**照旧别把它们当断链删掉。** 那些注释里的结论就是从那几份文档来的，路径是它唯一的
出处标记：留着至少说明「这个判断有过一份写下来的依据」，删了就只剩一句无出处的断言。
真要原文，在压缩之前的那份本地备份里（不在版本库里，也不该进版本库）。
**三份参照 App 的官方帮助文档（滴答清单 / Things / OmniFocus）不在仓库里**，
它们是别人的东西，原样转载跟这个仓库的 MIT 许可是两回事。注释里引用它们一律写
**原站链接**——那种引用对任何人都成立，不需要仓库里存副本。

本地抓一份放在 `docs/`（已 gitignore）照旧有用：改「仿滴答清单」那类实现前先去
查一句原文，比点开网页快。抓的时候给每篇留一行 `url:` 的 frontmatter，写注释时
直接从那儿取链接。

**根 `package.json` 的 `"private": true` 别删。** 它跟「开不开源」没有关系——那是
npm 的字段，作用是挡住 `npm publish`。这是个应用不是库，永远不发 npm 包，删掉它
只多一次误发的可能。（也别拿「workspaces 根必须 private」当理由：实测过，有没有
它都装得上，npm 不拦。真正的理由就是上面那句。）

`server/src/model.ts` 里有一批类型是跨包复制的，`web/src/types.ts` 是它们的拷贝，
**两边必须同步改**（连注释一起，同步测试比的是折叠空白后的全文）。

**名单不写在这里。** 正本是 `web/src/lib/types.sync.test.ts` 的 `NAMES`，而那份自己
又被一条测试盯着：从 `model.ts` 扫一遍 `export interface`/`export type`，减去
`OutboxEntry`/`OutboxUpdateEntry`/`OutboxInsightEntry`（AI 输入的原始形状，故意不同步）
之后跟 `NAMES` 比对，加一个类型忘了同步会直接红。

（这段原来真把十五个名字抄在正文里，结果就飘了：`Countdown` 和 `TaskContext` 加进去
之后这里一直写着「十五个」。**同一份名单抄两份，总有一份是旧的**——
`AGENTS.md` 和 `README.md` 各飘过一次，都是这个形状。现在只指路，不抄名单。）

那个同步测试抠 interface 用的正则是 `[^}]*`，**不支持嵌套花括号**——所以这些
类型里不许出现内联对象字面量（`Array<{ ... }>` 这种）。要嵌套就先提成一个
具名 interface 再加进同步名单。踩了这条的话两边会一起截断、一起通过，变成
一个恒绿的假测试——这就是为什么 `Reminder`、`FocusSession` 被提成了具名接口，
没有直接内联写在 `Task` 里。


## 给 `Task` 加一个字段，要动哪些地方

这份清单是 `startAt`（开始时间）和 `context`（情境）两次实际加下来撞出来的。
**大半有守卫盯着，忘了会红；剩下那几处不会红**——真正需要照着走一遍的就是后者。

会红的（忘了直接失败，不用记）：

| 动哪儿 | 谁在盯 |
|---|---|
| `server/src/model.ts` + `web/src/types.ts` 两份一模一样 | `types.sync.test.ts` |
| `web/src/lib/duplicate.ts` 的 `COPIED` / `DROPPED` 二选一 | `duplicate.test.ts` 的完整性断言 |
| `server/src/repeat.ts` `nextInstance` 里「重置还是带走」 | `repeat.test.ts` 的 RESET/CARRIED 名单 |
| `TaskDraft` 加了字段、`App.tsx` 的 `createTask` 得带上 | `App.test.tsx` 扫 `Object.keys(emptyDraft())` |
| 进了 `PROPOSABLE` 就得有中文名 | `ProposalNote.test.tsx` |
| `AGENTS.md` 的样例 JSON、两处字段名单 | `agentsMd.guard.test.ts`（也盯 `README.md`） |
| 各处 `Task` 夹具（数量别记，这行原来写「约三十五处」，实测已是三位数） | typecheck |
| `store.ts` 的 `newTask`、`dataSource.ts` 的 `newLocalTask`（两个都返回完整 `Task`） | typecheck |
| `server/src/migrate.ts` 的 `upgradeTask` 漏读新字段（返回类型就是 `Task`，每个字段必填） | typecheck（少一个必填属性就是 TS2741），外加 `migrate.test.ts` 那条「幂等测试要覆盖全部非默认字段」的用例 |
| 编辑表单那一格属性（`TaskFields.tsx` 的 `DraftAttr` + `ATTR_NAME` + `ATTR_GROUPS`）得把新字段列进去 | `TaskFields.test.tsx`，拿真渲染出来的 `aria-label` 比（「＋ 加一项」菜单里那颗按钮），不是手抄名单 |

**不会红的**——这几处漏了，测试全绿、界面看着也正常：

- **`server/src/migrate.ts`**：这一条**从「不会红」挪进了「会红」**。当年不读的后果
  是「新字段在老数据上永远是 `undefined`」，而校验器只拦「写错的」、拦不住「没读的」。
  现在两道都盯着：`upgradeTask` 的返回类型就是 `Task`（每个字段都必填），少读一个
  typecheck 就报 TS2741；`migrate.test.ts` 那条幂等用例（每个字段都给了非默认值）
  再兜一层：夹具里给了、迁移里没读，那一格落回默认值，用例照样红。留在这儿是因为
  它教的那件事还在：**加字段时忘了在迁移里读它，后果是「老数据上那个字段永远是空」**
  ——只是现在有人替你盯了。
- **`TaskCard` 和 `TaskRow` 两处都要画**。只画卡片的话，**同一条任务换个密度就少
  一条信息**——`waitingFor`、`startAt` 都是这么漏过一轮的，后者是拍四象限的图才
  发现的。
- **筛选栏 / 批量操作条**：`SmartFilter` 那一维、`BatchBar` 那一项。**不是必选，但得
  做一次决定。** `context` 两样都加了（不能筛等于填了没用，不能批量改等于没人
  会去填）；`startAt` 两样都没加，因为它在「接下来」里已经自成一组了。
- **`server/src/ics.ts`**：要不要导出。多数字段答案是「不」，但那是一次决定，
  不是默认。
- **「站在哪一屏里建，预填什么」**（`lib/composeDefaults.ts`）。这一条是
  `context` 撞出来的，而且它**两头都漏了**：`composeDefaults()` 里那条分支写了、
  注释也写了，但 `smartDraft` 的返回里没有这个字段、`TaskComposer` 拼初始草稿时
  也没读——于是「站在某个情境里建就落那个情境」从加上那天起就是假的，站在
  「外出」里建一条它不出现在「外出」里，**跟建失败长得一模一样**。
  什么都不会红：`smartDraft` 的返回类型是现写的内联类型，少一个字段 typecheck
  不管；`{ ...emptyDraft(), ...built }` 这种展开少一个键照样编译；`TaskComposer`
  的 `defaults` prop 当时还手抄了一份形状，结构类型允许多传，那个字段在类型这一
  层就被吃掉了。
  现在有守卫了（`composeDefaults.guard.test.ts`：`ComposeDefaults` 的每个字段
  在两个消费点里至少被读一次），prop 也改成从 `ComposeDefaults` 派生——所以这一
  条**从「不会红」挪进了「会红」**。留在这儿是因为它教的那件事还在：预填这一维
  容易整条被忘掉，而忘了的样子是「建完那一屏没变化」。

## 给 `Settings` 加一个字段，要动哪些地方

跟上面那份是两码事，坑也不一样。这份是加 AI 那一栏（`aiMode` 和接口配置那几个字段）
撞出来的。

会红的：

| 动哪儿 | 谁在盯 |
|---|---|
| `server/src/model.ts` + `web/src/types.ts` 两份一模一样（连注释） | `types.sync.test.ts` |
| `DEFAULT_SETTINGS` 补上默认值 | typecheck（`Settings` 是完整类型） |
| `server/src/settings.ts` 的 `sanitizeSettings` 里那个 `next: Settings = { … }` 少一个键 | typecheck，同上（`PUT /api/settings` 现在只调它，那条路由里没有这份字面量了） |
| 各处 `Settings` 夹具（`App.test.tsx`、`SettingsModal.test.tsx`、`CalendarView.test.tsx`） | typecheck |

**不会红的**：

- **`sanitizeSettings` 里写了键、但没真的读请求体。** 上面那行 typecheck 只保证
  「这个键在对象里」，保证不了「它的值来自 `body`」——写成
  `aiMode: DEFAULT_SETTINGS.aiMode` 照样编译，结果是**用户在设置页改什么都存不进去，
  保存还回 200**。加字段时对着 `server/src/settings.ts` 里那份挨个看一遍值是从哪儿来的。
- **`SettingsModal.tsx` 里没画这一格。** 字段存得进、读得出，界面上就是没有——
  跟「加了但坏了」长得完全不一样，不会有任何测试提这件事。
- **是不是秘密。** 这个服务能绑局域网（`LAN=1`），`GET /api/settings` 的响应
  同一个 Wi-Fi 下谁都读得到。密钥那一类要打码回去（`aiApi.ts` 的 `maskKey`），
  而且 **`PUT` 的响应也要打**——那条路由回的是整份设置，界面拿它刷新 state，
  只挡 `GET` 等于没挡。这一条是写测试时才发现漏的。
- **打码要打在「密钥出现的每一处」，不止当前那一个形状。** 2026-10-21 实测的
  一次漏网：密钥从平铺的 `aiKey` 搬到 `aiEndpoints[*].key` 之后，打码只加在了
  新形状上，而 `readSettings()` 里那句 `{ ...DEFAULT_SETTINGS, ...raw }` 展开
  **把旧形状那三格一起带了出来**——于是「升级了但还没保存过一次设置」的老机器，
  `GET /api/settings` 回的就是**明文**（`aiKey` 那一格），同一个 Wi-Fi 上谁都读得到。
  派生成新形状是对的，**把旧形状的原文留着不是**：读完就要摘掉
  （`store.ts` 的 `readSettings`）。守卫在 `app.test.ts`「老形状的 device.json」那条。
- **加一格之前先问：这一格是「每家一份」还是「全应用一份」？** 接口配置现在是
  **一家一条记录**（`Settings.aiEndpoints` + `aiEndpointId` 指到当前选中的那条）。
  放错层的表现是「切到别家，这个值还跟着走」——**旧版那把全局密钥造成的假 401 就是
  这么来的**（点了另一家的芯片、没碰密钥格，上一家真钥匙被发到新地址上）。
  判据：这一格会不会**跟着地址走**？会 → 放进记录里；不会 → 放顶层。
- **打码串不能当成真密钥存下去。** 界面上回显的是打码（`••••` 加后四位），机器上
  没有对应真值时，那串打码**还原不出密钥**——存下去就是一把废钥匙，第一次调接口
  才以 401 现形，而报错说的是「密钥无效」，人只会反复重填。判据在 `aiKeyFrom`
  （`aiApi.ts`）：**手上没真值、收到的又是打码 → 落空串**。
- **「换主机要重填一次」这条判据，服务端和界面两边都要有。** 服务端存的时候把
  密钥清掉（`settings.ts` 的 `mergeEndpoint`：主机变了就不给），界面要在**保存之前**
  先说清（`AiSettingsSection` 的 `movedHost`）。少一边就是「保存完对着一句跟真实原因
  毫无关系的 401 猜是哪格错了」。
- **改了会不会一直漏。** `webhookUrl` 和接口地址（现在住在 `aiEndpoints` 每条记录里）
  都属于「被人改到别处之后，
  关掉局域网模式也收不回来」的那一类，加这种字段要往 `lanBind.ts` 的
  `LAN_WARNING` 里补一句（那句话被 `android/冒烟清单.md` 逐字抄了一份，
  `lanBind.test.ts` 有守卫盯着两边一致）。

## 加了界面就拍一眼

单测断言的是可访问名和文本，**看不到对齐、间距、换行、窄屏**。这几样只有真跑起来
才看得见，而这个仓库已经为它们付过账：侧栏一段用错了布局、计数没右对齐、多行的
随手记被 markdown 折成一长行、行档少一枚 chip——四条都是单测全绿、拍图才现形的。

起一个带假数据的临时实例（`DATA_DIR`、`DEVICE_CONFIG` **和** `AGENT_CWD` 都要给：
不指走就用着他真实的 `device.json` 和真实的数据目录，那份设置里「自动拆解」默认
开着，会真的 spawn 一次 AI；`AGENT_CWD` 不指的话，CLI 那条路还会被 `aiSeesSameData`
那道守卫当场拒掉，提示是「把 DATA_DIR 和 AGENT_CWD 指到同一处再试」）。假数据和
那份把「自动拆解」关掉了的 `device.json` 由 `tools/preview-fixture.mjs` 铺（跑法写在
`tools/design-preview/batch1.html` 头部那段注释里）；`tools/shot.mjs` 拍几屏，
窄屏也拍一次。

### 打磨稿（`tools/design-preview/`）

`batch1.html`（现状审计）、`batch2.html`（同一条改动的改前/改后对照）、
`floors.html`（24px 下限咬不咬人）加共用的 `drive.js` 与跑在每格自己 realm 里的
`probe.js`。**每一格是同源的真 app iframe，不是截图**，所以量到的就是屏幕上的数。
起法和各张表的判据都写在 `batch1.html` 头部那一段注释里。

**这套东西住在 `tools/`，不在 `web/public/`——这条是刻意的。** `web/public/` 是
Vite 的 publicDir，里面的东西原样进 `web/dist`，而 `web/dist` 整个进安装包
（`desktop/electron-builder.yml` 的 extraResources）。搁在那儿的结果是每个装好的应用
都带着这套内部审计稿、`/design-preview/batch1.html` 对最终用户敞开。现在只有带
`DESIGN_PREVIEW=1` 起的服务才把它挂到那条路径上（`server/src/index.ts`），不带这个
开关时 `/design-preview/*` 一律 404 并说明原因——不会落到 SPA 外壳上冒充 `probe.js`。

`web/public/` 剩下的两样（`icon.svg`、`social-card.png`）是**要**跟着站点走的，别拿
它们当先例往这儿加东西。
