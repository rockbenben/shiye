// 打磨稿用的**假 AI**：真的被服务 spawn 起来，只是不 Thinking，直接按约定把
// 产物写到自己的工作目录里。
//
//   node tools/preview-agent-stub.mjs "<提示词>"
//
// 为什么要它：界面上那几条「跑完了」的回执（绿色的拆解完成、多行的 AI 总览）
// 只能由一次真的运行发出来。夹具默认那条路是「叫 AI 立刻失败」，量失败是一半，成功那一半
// 要么真叫一次 AI（为一张稿子烧一次额度，不值得），要么在稿子里编一条状态——
// 编出来的状态量的就不是这个应用的真实行为了。这里走第三条路：服务照常
// spawn、照常等退出码、照常合并产物，被换掉的只有「谁在想」。
//
// 由 `preview-fixture.mjs --agent-stub` 写进设备配置（`aiCli: 'custom'` +
// 这份脚本当命令行工具），不带这个开关跑夹具服务时它压根不会被叫起来。
//
// **只写自己 cwd 里的东西**：服务把子进程的 cwd 设成 `AGENT_CWD`，那份 `data/`
// 必须跟服务读的是同一个目录（`aiSeesSameData` 那道守卫在起进程之前就拦，
// 两边不是同一处时压根轮不到这份脚本跑）。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = join(process.cwd(), 'data');
const prompt = process.argv.slice(2).join(' ');
const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 17);
const readTasks = () => {
  try {
    return readdirSync(join(DATA, 'tasks'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(DATA, 'tasks', f), 'utf8')));
  } catch {
    return [];
  }
};
const readInbox = () => {
  try {
    return readdirSync(join(DATA, 'inbox'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(DATA, 'inbox', f), 'utf8')));
  } catch {
    return [];
  }
};

if (/workflows\/board\.md/.test(prompt)) {
  // 总览的汇报是一段给人看的纯文本：服务取走 `.board-report.md` 之后原样发进
  // agent-status，界面上按 `white-space: pre-wrap` 排。所以这段**必须是多行**
  // ——打磨稿要量的正是长汇报怎么折行。
  const tasks = readTasks();
  const byStatus = tasks.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {});
  const lines = [
    `看板上一共 ${tasks.length} 条任务：待办 ${byStatus.todo ?? 0} 条、进行中 ${byStatus.doing ?? 0} 条、搁置 ${byStatus.later ?? 0} 条、已完成 ${byStatus.done ?? 0} 条。`,
    '',
    '这一周最重的三件事：',
    '1. 给房东打个电话，问暖气什么时候试压——截止时间已经过了，还没有提醒时间。',
    '2. 整理多巴胺排毒的方式与解决方法，卡在「等一份参考资料」。',
    '3. 写文章《凡士林的养护措施》，子任务勾掉了一半。',
    '',
    '另外有两条建议还挂着等你处理，接受或者忽略都行；搁置那一组里有一条已经三个月没动过，要不要放弃也由你定。',
  ];
  writeFileSync(join(DATA, '.board-report.md'), lines.join('\n'));
  process.exit(0);
}

if (/workflows\/expand\.md/.test(prompt)) {
  const pending = readInbox().filter((i) => i.processed === false);
  const first = pending[0];
  const now = new Date().toISOString();
  const outbox = first
    ? [{
        inboxId: first.id,
        tasks: [{
          id: `stub-${stamp}`,
          title: '假 AI 拆出来的一条（打磨稿用）',
          notes: '- 这一步只是让「拆解完成」那条绿色横幅有一次真的产出\n- 合并走的是服务自己的那条路，这份 outbox 跟真 AI 写的一样要过校验',
          status: 'todo',
          due: null,
          startAt: null,
          endAt: null,
          persistentReminder: false,
          reminders: [],
          subtasks: [{ text: '看完把它勾掉', done: false }],
          source: 'ai',
          aiComment: '这是打磨稿的假 AI：量「跑完了」那一面，不该为一张稿子烧一次真额度。',
          createdAt: now,
          updatedAt: now,
          order: null,
          listId: null,
          section: null,
          tags: [],
          priority: 0,
          repeat: null,
          completedAt: null,
          postponeCount: 0,
          waitingFor: null,
          context: null,
          attachments: [],
          focusSessions: [],
          estimateMinutes: null,
          habit: false,
          pinned: false,
          reviewedAt: null,
          parentId: null,
        }],
      }]
    // 收件箱空了也要有个产物：合并那边会说「没有要拆的」（skipped 那一档）。
    : [];
  writeFileSync(join(DATA, `outbox-stub-${stamp}.json`), JSON.stringify(outbox, null, 2));
  process.exit(0);
}

// 回顾/拆细：产一条观察，够绿色横幅有一次真的合并结果。
if (/workflows\/review\.md|workflows\/breakdown\.md/.test(prompt)) {
  const tasks = readTasks().slice(0, 2);
  const entry = /breakdown/.test(prompt)
    ? {
        updates: tasks.map((t) => ({
          id: t.id,
          patch: { subtasks: [{ text: '假 AI 补的一步（打磨稿用）', done: false }] },
          reason: '打磨稿要量「拆细跑完」那一面：这一步只让合并有一次真的产物。',
        })),
      }
    : {
        insights: [{
          kind: 'pattern',
          text: '假 AI 的观察：这几条都没写提醒时间，到点不会响（打磨稿用）。',
          taskIds: tasks.map((t) => t.id),
        }],
      };
  writeFileSync(join(DATA, `outbox-stub-${stamp}.json`), JSON.stringify([entry], null, 2));
  process.exit(0);
}

// 认不出的提示词：什么都不写、退出码 0——服务那边会落「跑完了，没产出」那一档，
// 那也是一面，只是不是这几格要量的。
process.exit(0);
