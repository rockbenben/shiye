/*
  探针：跑在**被审那一格自己的 realm 里**（由 batch1.html 注入 iframe 的 <head>），
  所以 `document` / `getComputedStyle` / `getBoundingClientRect` 读的都是那一格的
  视口与画布——多格不同尺寸各量各的，不用为每格单独开页面。

  只报**数得出来的坏味道**，不报风格判断：横向溢出、被裁掉的字、点击目标小于
  24px（WCAG 2.2 的下限，这个仓库已经为它写过三条守卫）、没有可及名字的控件、
  没有 alt 的图、被挤到一行一个字（这一根是量到期横幅那一处之后补的——那一类
  既没溢出也没裁切，前几根轴全都看不见它）。改不改、怎么改，是人看着截图 +
  这张表一起定的。
*/
(function () {
  const MIN_TARGET = 24;
  const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])';

  const accName = (el) => {
    // `aria-labelledby` 要**跟到那个元素去读文本**——随手记那个框第一轮之后真的
    // 有名字了（`aria-labelledby` 指着标题），探针还在报「没名字」，因为这一版
    // 只认 `aria-label`。尺子不认的修法等于没修。
    //
    // **`placeholder` 不算名字**，这是定的不是漏的：浏览器做可及名计算时确实会
    // 兜到它，但那是「这个框在提示你写什么」，不是「这个框是谁」——一落笔它就
    // 没了，而读屏要在焦点每次都念得出来。本仓库对同一件事的判断已经落在随手记
    // 那个框上：它有占位符，还是补了一个真的名字（`aria-labelledby` 指着「随手记」
    // 那行），所以尺子按同一把量。
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
      if (t) return t;
    }
    return (el.getAttribute('aria-label') || '')
      || (el.getAttribute('alt') || '')
      || (el.title || '')
      || (el.textContent || '').trim()
      // **`value` 只在按钮那种控件上才是名字。** `<input type="button" value="保存">`
      // 靠 value 念出自己，这一支就是为它写的；但同一个兜底让**任何填了字的
      // 文本框都自称有名字**——新建任务那表单的标题框空着时报「没名字」，详情
      // 面板里同一个框装着已有标题时报「有名字」，量的是同一条缺陷的两个瞬间。
      // 收紧到按钮类型：文本框的 value 是用户刚打的内容，不是那个框是谁。
      || (el.tagName === 'INPUT' && /^(button|submit|reset|image)$/.test(el.getAttribute('type') || '') ? (el.value || '').trim() : '')
      // **包在外面的 `<label>` 就是一个名字**：antd 的 Checkbox 渲染成
      // `<label><input type=checkbox><span>勾选已完成</span></label>`，没有 id 也没有
      // `htmlFor`，靠的是「input 在 label 里面」这一条（W3C 的可及名算法里它是
      // 正经一站）。日历那一屏 12 颗勾选框全被报成「没名字」——那 12 条是尺子的
      // 读数，不是界面的读数。下面那条 `label[for]` 只管带 id 的那种，管不到这一种。
      || (el.closest && el.closest('label') ? (el.closest('label').textContent || '').trim() : '')
      || (el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`) ? 'labeled' : '');
  };

  /**
   * 「给读屏看、不给人看」的那一类元素不算 UI 缺陷。
   *
   * 第一版没挡这个：今天那一屏报出一条「横向溢出」，样例是
   * `.ink-sr-only「今天要做的」`——那是故意裁成一像素给屏幕阅读器的字，
   * 报出来是假红。**尺子报的第一条问题就得先问它自己量对了没有。**
   */
  const visuallyHidden = (cs) => (
    cs.opacity === '0'
    || cs.clipPath !== 'none'
    || (cs.clip && cs.clip !== 'auto')
    || cs.width === '1px' && cs.height === '1px'
  );

  /**
   * 目标多大，**问 `elementFromPoint`，别问 `getBoundingClientRect`**。
   *
   * 第一轮报了「收起文件夹 15×15」，去翻代码才发现它早就用
   * `.ink-nav-fold::before { inset: -4.5px }` 把命中区补到 24×24 了——伪元素
   * 不在盒子尺寸里，所以量盒子的尺子看不见修好的那部分，报了一条**已经修过
   * 的**问题。这一族（小图标 + 往外长的判定区）在这个侧栏里是好几种控件的
   * 共同做法，用矩形量会一路假阳性。
   *
   * 中心四周各探 11.5px（24 见方的**内部**四个点），四下都还落在这个元素或它的子孙上
   * 才算够。屏幕外的探不到，单独计 `unmeasured`，不混进「太小」。
   *
   * **被别的浮层压着的也单独计**（`covered`）。日期面板摊开那一格报了
   * 「截止时间 141×22 / 提醒时间 141×22」——四个探点全落在 `.ant-picker-header`、
   * `.ant-picker-body` 上：面板正盖在这两个框身上，这是 antd 打开面板时的正常
   * 位置关系，不是这两个框小（它们外面那层 `.ant-picker` 是 32 高）。压着的东西
   * 量不出大小，把它记成「太小」就是让界面去修一个不存在的缺陷。
   */
  const POPUP = '.ant-picker-dropdown,.ant-select-dropdown,.ant-cascader-dropdown,'
    + '.ant-popover,.ant-dropdown,.ant-mention-dropdown';
  const inOtherPopup = (hit, el) => {
    const layer = hit.closest?.(POPUP);
    return !!layer && !layer.contains(el);
  };
  const effective24 = (el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 12 || cy < 12 || cx > innerWidth - 12 || cy > innerHeight - 12) return null;
    // 采样点取 **±11.5，不是 ±12**：这条下限说的是「命中区不小于 24 见方」，
    // 所以要在**里面**试，不能在边上试。`±12` 正好压在那条 24 的边界像素上，
    // 命中测试结果跟着亚像素抖——「收起文件夹」那颗是 15×15 加 `::before`
    // 四各外扩 4.5px，加起来**正好 24**，于是同一份 CSS 在两格里一格报
    // 「太小 15×15」一格不报，量的其实是取整的运气。±11.5 验到的是「至少 23
    // 见方」，少的那半个像素不值得让这一整族重写外扩。
    const PROBES = [[-11.5, -11.5], [11.5, -11.5], [-11.5, 11.5], [11.5, 11.5]];
    for (const [dx, dy] of PROBES) {
      const hit = document.elementFromPoint(cx + dx, cy + dy);
      if (hit && inOtherPopup(hit, el)) return 'covered';
      /**
       * **「祖先含它」也算命中**，这是定的，不是偷懒——batch2 的第一轮拿它试过
       * 收紧（只认 `label` 和带交互属性的祖先），当场错在一处：详情那颗日期药丸
       * 里面那个 `<input>` 是 99×22，探点落到药丸本身（`.ant-picker`，一个不带
       * `role`/`tabindex` 的 div）上，收紧的尺子就报「太小 99×22」——而按药丸
       * 任何一处都开得起面板，用户瞄的是那颗 111×32 的丸，不是里面那行字。
       * 反过来说：祖先那条路放宽是有代价的（一个真正不接点击的光秃秃 div 会被
       * 误当成命中区），所以这一族的**实际**缺陷由 `min-height`/`min-width` 那几处
       * 形状钉和 batch2 的左右两栏读数管，不由这里单独管。
       */
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) return false;
    }
    return true;
  };

  /**
   * 被某个祖先的滚动区裁在外面（`.ink-nav` 那棵树是 `overflow-y: auto`）。
   *
   * 出处：总览那条汇报把侧栏那列压矮了十几个像素，最后一个文件夹行的下沿
   * 正好落到滚动区外头，于是那颗 15×15 的收/放三角报成「太小」——它的
   * `elementFromPoint` 命中的是压在它上面的随手记框，**因为它这会儿根本不在
   * 那块能滚的区域里可见**。滚进去它就和别处一样大。裁在外面和伸出屏幕是
   * 同一类「量不到」，不该记成界面的缺陷。
   */
  const scrolledOut = (el) => {
    const e = el.getBoundingClientRect();
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
      const r = p.getBoundingClientRect();
      if (e.bottom < r.top + 1 || e.top > r.bottom - 1 || e.right < r.left + 1 || e.left > r.right - 1) return true;
    }
    return false;
  };

  window.__probe = function probe(cell) {
    const doc = document;
    /**
     * **弹层开着的时候只量那一层。** 设置/命令面板/快捷键/搜索那四格一开始都
     * 报了「收起文件夹 15×15」——不是把手变小了，是模态遮罩盖住了背景，
     * `elementFromPoint` 打在遮罩上，量「点得到点不到」当然判不中。背景这时候
     * 本来就不该被点，把它算进这一屏的账上，读数就全是噪音。
     */
    const top = doc.querySelector('.ant-drawer-open .ant-drawer-content-wrapper')
      || doc.querySelector('.ant-modal-wrap .ant-modal')
      // 手机上「打开一条任务」是**整屏浮层**（`theme.css` 里 `.ink-detail-col`
      // 在 < 1000px 是 `position: fixed; inset: 0`），底下那份列表被它整个盖住，
      // 跟模态遮罩同一回事：不收到这一层，那一条任务列表会贡献一堆「太小」的噪音。
      // 按**算出来的 position** 判，不按断点判——宽屏上它是正常一列，
      // 那一格量的就是三栏同屏，把列表踢出表反而不对。
      || [...doc.querySelectorAll('.ink-detail-col')].find((e) => getComputedStyle(e).position === 'fixed');
    /**
     * **开着的那层下拉/日期面板也要算进来。** antd 的弹层挂在 body 上的 portal 里，
     * 不是模态的子节点——只量 `.ant-modal` 的话，「新建任务表单里点开日期面板」
     * 这一屏量到的是表单，那颗面板一个节点都没进表，而手机上恰恰是它最容易挤。
     * 藏起来的（`-hidden`，antd 收起来时留着节点）不算。
     */
    const popped = doc.querySelector(
      '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden),'
      + '.ant-select-dropdown:not(.ant-select-dropdown-hidden),'
      + '.ant-popover:not(.ant-popover-hidden):not([style*="display: none"])',
    );
    const scopes = [top ?? doc.body];
    // 那条**红色的回执**（antd 的 message）挂在 body 上、不在任何弹层里面：
    // 「导入被拒」那一格开着设置窗，只量窗口的话那句原话一个字都没进表——
    // 而那一句正是这一格要看的。
    const extras = [popped, ...doc.querySelectorAll('.ant-message')].filter(Boolean);
    for (const x of extras) if (!(top && top.contains(x))) scopes.push(x);
    const seen = new Set();
    const all = [];
    for (const s of scopes) {
      for (const el of s.querySelectorAll('*')) {
        if (seen.has(el)) continue;
        seen.add(el);
        all.push(el);
        if (all.length >= 4000) break;
      }
    }
    let overflow = 0; let guarded = 0; let unmeasured = 0; let covered = 0; let scrolledOutN = 0; let clipped = 0; let smallTargets = 0; let noName = 0; let imgNoAlt = 0; let squeezed = 0;
    const clippedSamples = []; const smallSamples = []; const noNameSamples = []; const squeezedSamples = [];

    for (const el of all) {
      // 不可见的不算（藏起来的浮层、hidden 的 keepMounted 视图）
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
      if (visuallyHidden(cs)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;

      if (el instanceof HTMLImageElement && !el.hasAttribute('alt')) imgNoAlt += 1;

      /**
       * **被挤成一列一个字。** 到期横幅那一处就是这一类：动作那一排不折行，装不下
       * 时缩的是正文，于是「有 2 件事到点了」七个字竖着排成一列、整条横幅 779px 高。
       * 上面那几根轴一根都不认它——它没有横向溢出（谁也没超出谁），也没有裁切（字
       * 全都画出来了），只是**每行只放得下一个字**。
       *
       * 判据是「这个元素自己排这段字，而它的行盒窄到一行一个字」：
       * - 只认**自己有非空文本节点**的元素。外层那个盒子会被切成同样的窄行，一处
       *   算两遍，报出来的数就跟着虚。
       * - 行盒拿 `Range.getClientRects()` 数，**≥3 行**才算：两行是窄栏里再正常不过
       *   的排法（长任务标题在 390 上就是两行）。**但那个函数返回的是「段」不是
       *   「行」**——同一段字拆在几个文本节点里就会给几个矩形，同一行。第一版直接
       *   数它，三格专注计时器各报一条「`24:52` 挤成 3 行」，而那是一行（三个矩形
       *   的 `top` 全等于 761）。所以先按 `top` 归并成行，再数行、再量每行的宽。
       * - 每一行宽 ≤ 1.6 倍字号才算「一个字」：中文一个字就是一个字号宽，拉丁按两
       *   个窄字母算（`i` `l` 连排两个也不到 1.6em）。
       * - `writing-mode: vertical-*` 不算——那是**故意**竖排。
       * 先拿盒子宽（≤3em）筛掉绝大多数元素，再花 `Range` 那一次遍历。
       *
       * **这一根只认最病态的那一档**（一行一个字）。「一行两个字」不报：窄栏里两字
       * 一行是正常排法（星期标签、两字动词的按钮），抬高阈值会把一屏正常的窄列全
       * 报成缺陷，而报错的数比没有数更贵。到期横幅单条那一面当时正是「两字一行」，
       * 是靠眼睛对出来的——那一句写在这儿，是为了哪天有人想放宽阈值时知道代价。
       */
      const fs = parseFloat(cs.fontSize) || 14;
      if (r.width <= fs * 3 && !/vertical/i.test(cs.writingMode)) {
        const txt = (el.textContent || '').trim();
        const own = txt.length > 3 && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (own) {
          const rg = el.ownerDocument.createRange();
          rg.selectNodeContents(el);
          const lines = new Map();
          for (const x of rg.getClientRects()) {
            if (x.width <= 0 || x.height <= 0) continue;
            const k = Math.round(x.top);
            lines.set(k, (lines.get(k) || 0) + x.width);
          }
          const widths = [...lines.values()];
          if (widths.length >= 3 && widths.every((wd) => wd <= fs * 1.6)) {
            squeezed += 1;
            const cls = (typeof el.className === 'string' && el.className.split(' ')[0]) || el.tagName.toLowerCase();
            if (squeezedSamples.length < 6) squeezedSamples.push(`${cls}「${txt.slice(0, 18)}」 ${Math.round(r.width)}px 宽·${widths.length} 行`);
          }
        }
      }

      const cutsX = cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis';
      /**
       * 「按设计截断」分两档报，不合并成一个数。
       *
       * 行档那一列标题和元数据都是省略号截断的，区别在**看不看得到全貌**：
       * 元素自己带 `title`/`aria-label` 的（标题那列，祖先 `.ink-trow-open` 上
       * 挂着 `title={t.title}`）算有兜底；只有元数据那列被切了又没有任何地方
       * 说全文，才是真丢了字。第一版把两者混成一格「溢出 2」，读的人不知道该
       * 修哪个——数字混了，判断就跟着混。
       *
       * **装不下 + 里面真的站着字**才算一条溢出。原来只判前一半，于是设置里
       * 每一页都报「溢出 = 这一页开关的颗数」：`.ant-switch-inner` 同时装着
       * 「开」和「关」两份内容，靠 `overflow: hidden` 只露一份——那是 antd 开关
       * 的实现方式，不是这个界面裁掉了谁的字。它自己 `textContent` 是空的
       * （两份都是藏起来的空 span），所以按「有没有字可丢」这一条就筛掉了，
       * 而且筛的是判据，不是给这一个 class 开后门。
       *
       * **能滚的不算裁掉。** 日期面板里那一列小时数报了「溢出」（`scrollWidth`
       * 52 > `clientWidth` 46）：它是一个 `overflow-y: auto` 的滚动列表，而 CSS
       * 规定纵向能滚时横向的 `visible` 会算成 `hidden`——那两个像素是滚动条占的
       * 位置，不是丢掉的字。滚得动的东西内容都还在，跟「省略号后面没有全文」
       * 不是同一件事。
       */
      const scrollsY = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
      // 兜底**得真的装得下被切的那段**才算。祖先上挂个 `title` 不够：行档那个
      // `title` 是任务标题，救不回被切掉的元数据（「今天 22:00 ⚑师爷 bug」）。
      const cut = cutsX && !scrollsY && el.scrollWidth > el.clientWidth + 2 && !!(el.textContent || '').trim();
      const head = (el.textContent || '').trim().slice(0, 12);
      const fb = el.getAttribute('title') || el.getAttribute('aria-label') || el.closest('[title]')?.getAttribute('title') || '';
      const guardedCut = cut && !!head && fb.includes(head);
      if (cut && guardedCut) guarded += 1;
      else if (cut) {
        overflow += 1;
        const t = (el.textContent || '').trim().slice(0, 26);
        if (t && clippedSamples.length < 6) clippedSamples.push(`${el.className || el.tagName}「${t}」`);
      }
      if (cut && !guardedCut && el.childElementCount === 0 && (el.textContent || '').trim()) clipped += 1;

      if (el.matches(INTERACTIVE)) {
        if (!accName(el)) {
          noName += 1;
          if (noNameSamples.length < 6) noNameSamples.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`);
        }
        /**
         * 分界线（`.ink-col-grip`）**不报小目标**，是判据不是漏放：WCAG 2.5.8 的
         * 例外条款写着「目标有等价的键盘命令时豁免」，而这条界线本来就有
         * `tabIndex=0` + ←/→（一步 16px）+ Home/End。第一轮它被报成「8×852 太小」，
         * 量过邻接区域之后决定不改——往左长会盖住侧栏、往右长会吃掉卡片的点击，
         * 两条界线的邻接面还不对称。留着这条豁免，是为了下一轮不再花一次同样的
         * 测量把同一个结论再得一遍。
         */
        const kbEquivalent = el.getAttribute('role') === 'separator' && el.tabIndex >= 0;
        if (!kbEquivalent && (r.height < MIN_TARGET || r.width < MIN_TARGET)) {
          if (scrolledOut(el)) { scrolledOutN += 1; }
          else {
          const eff = effective24(el);
          if (eff === false) {
            smallTargets += 1;
            if (smallSamples.length < 6) smallSamples.push(`${(accName(el) || el.className || el.tagName).slice(0, 16)} ${Math.round(r.width)}x${Math.round(r.height)}`);
          } else if (eff === null) unmeasured += 1;
          else if (eff === 'covered') covered += 1;
          // eff === true：盒子小，但命中区够 24（伪元素补出来的）——不算缺陷。
          }
        }
      }
    }
    return {
      nodes: all.length, overflow, guarded, clipped, smallTargets, unmeasured, covered, scrolledOut: scrolledOutN, noName, imgNoAlt, squeezed,
      hint: `溢出：${clippedSamples.join(' / ') || '—'} ｜ 小目标：${smallSamples.join(' / ') || '—'} ｜ 没名字：${noNameSamples.join(' / ') || '—'} ｜ 竖排：${squeezedSamples.join(' / ') || '—'}`,
    };
  };
})();
