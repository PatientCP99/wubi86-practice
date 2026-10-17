// src/selftest.js —— 浏览器内自检（只在 index.html?selftest=1 时加载）
//
// 为什么要它: node 测不到 DOM。这里在真实浏览器里跑数据/逻辑/字根表/故事/界面五组检查，
// 结果写进页面并设成 document.title，所以 headless 浏览器也能验：
//     chrome --headless --dump-dom "file:///.../index.html?selftest=1"
"use strict";
(function () {
  const Core = window.WubiCore;
  const D = window.WUBI86;
  const ROOTMAP = window.WUBI86_ROOTS;
  const STORIES = window.WUBI86_STORIES;
  const results = [];
  let failed = 0;

  function ok(cond, label, detail) {
    results.push((cond ? "PASS  " : "FAIL  ") + label + (!cond && detail !== undefined ? "  -> " + detail : ""));
    if (!cond) failed++;
  }
  function eq(a, b, label) {
    ok(a === b, label, "期望 " + JSON.stringify(b) + ", 实得 " + JSON.stringify(a));
  }
  function group(t) {
    results.push("", "== " + t + " ==");
  }

  function run() {
    const idx = Core.build(D);
    // 精确字根拆解层是否存在，决定后面很多断言走哪条分支
    const preciseOn = !!(window.WUBI86_ROOTUNITS && window.WUBI86_ROOTUNITS.rows);

    // ---------------------------------------------------------- 数据
    group("数据不变式");
    eq(Array.from(D.charset).length, 6500, "练习字集 = 6500");
    eq(D.levels[0] + D.levels[1], 6500, "levels 3500 + 3000");
    eq(idx.pageSize, 9, "每页 9 个候选");
    let maxLen = 0;
    for (const c of idx.byCode.keys()) maxLen = Math.max(maxLen, c.length);
    eq(maxLen, 4, "最长码长 4（=> 任何 4 码都是叶子）");
    let noCode = 0;
    for (const ch of idx.charsetList) if (!idx.shortestCode(ch)) noCode++;
    eq(noCode, 0, "字集内每个字都有码");
    eq(idx.candidates("ifcy")[0].text, "法", "`ifcy` 首选 法（不是 沄）");
    eq(idx.candidates("alpu")[0].text, "莲", "`alpu` 首选 莲（不是繁体 蓮）");
    eq(idx.candidates("lhng")[0].text, "四", "`lhng` 首选 四（不是 皿）");

    // ---------------------------------------------------------- 逻辑
    group("输入状态机");
    eq(idx.candidates("fgh").map((c) => c.text).join("/"), "十", "精确匹配：`fgh` 只出 十");
    ok(!idx.isLeaf("fgh"), "`fgh` 不是叶子 -> 不自动上屏");
    eq(idx.candidates("fpgc").length, 44, "`fpgc` 有 44 个候选（翻页用例）");

    let s = Core.createSession(idx, { text: "都" });
    eq(s.press("f").type, "buffer", "敲 f 入缓冲");
    s.press("t"); s.press("j");
    const ev = s.press("b");
    eq(ev.type, "autocommit", "敲满 ftjb -> 自动上屏 都");
    eq(ev.correct, true, "判对");

    s = Core.createSession(idx, { text: "雨" });
    s.press("f"); s.press("g"); s.press("h");
    const bad = s.press(" ");
    eq(bad.correct, false, "目标是 雨 却上屏 十 -> 判错");
    eq(s.cursor, 0, "判错后光标不动");
    eq(s.buffer, "", "判错后缓冲清空（要重打）");
    s.press("f"); s.press("g"); s.press("h"); s.press("y");
    eq(s.press(" ").correct, true, "重打 fghy -> 判对");

    s = Core.createSession(idx, { text: "工" });
    eq(s.press("z").type, "reject", "z（万能键）被拒收");
    eq(s.buffer, "", "拒收后缓冲不变");

    s = Core.createSession(idx, { text: "工" });
    s.press("a");
    eq(s.press("Backspace").type, "buffer", "退格删一码");

    s = Core.createSession(idx, { text: "我们" });
    eq(s.press("t").type, "buffer", "词组码逐位入缓冲");
    s.press("r"); s.press("w");
    eq(s.press("u").text, "我们", "trwu 一次上屏两个字");
    eq(s.press("Backspace").cursorAfter, 0, "缓冲空时退格撤销词组");

    const twenty = idx.candidates("fpgc")[20].text;
    s = Core.createSession(idx, { text: twenty });
    s.press("f"); s.press("p"); s.press("g"); s.press("c");
    s.press("="); s.press("=");
    eq(s.press("3").correct, true, "翻页能选到第 21 个候选（消灭死路）");

    s = Core.createSession(idx, { text: "天,地。人" });
    eq(s.plan.length, 3, "标点自动跳过（plan 只含 3 个字）");
    eq(s.displayStates()[1], "punct", "逗号标记为 punct");

    let extb = null;
    for (const ch of idx.charsetList) if (ch.length === 2) { extb = ch; break; }
    ok(!!extb, "字集含代理对字符（扩展B）");
    if (extb) {
      s = Core.createSession(idx, { text: extb });
      eq(s.plan.length, 1, "代理对字只算 1 个字（没用 UTF-16 长度）");
      const code = idx.shortestCode(extb);
      for (const k of Array.from(code)) s.press(k);
      eq(s.press(" ").correct, true, "扩展B 字能打出来");
    }

    s = Core.createSession(idx, { text: "雨" });
    s.press("f"); s.press("g");
    const h = s.hint();
    eq(h.missing, "hy", "长按提示给出缺的字母 hy");
    eq(h.code, "fghy", "提示给最短合法码");
    s = Core.createSession(idx, { text: "我们的" });
    eq(s.hint().word.code, "trwu", "词码提示：我们 = trwu");

    // ---------------------------------------------------------- 字根表
    group("字根表");
    eq(ROOTMAP.rows.length, 25, "25 个键（不含 z 万能键）");
    const charCodes = new Map();
    for (const row of D.single) {
      const p = row.split(",");
      if (!charCodes.has(p[0])) charCodes.set(p[0], new Set());
      charCodes.get(p[0]).add(p[1]);
    }
    let nameBad = 0;
    let rootBad = 0;
    for (const r of ROOTMAP.rows) {
      if (r.roots.indexOf(r.name) < 0) nameBad++;
      const comp = new Set(r.componentRoots || []);
      for (const g of r.roots) {
        if (Array.from(g).length !== 1 || comp.has(g)) continue;
        const codes = charCodes.get(g);
        if (!codes) continue;
        let hit = false;
        for (const c of codes) if (c[0] === r.key) hit = true;
        if (!hit) rootBad++;
      }
    }
    eq(nameBad, 0, "25 个键名字都在自己键的字根里");
    eq(rootBad, 0, "可查字根的首码都等于本键（偏旁例外已声明）");

    // 私用区(PUA)字根支持：这类码位只有 data/local/zigen.ttf 里有形状，
    // 必须被渲染成 .zigen（ZiGen 字体）才不是豆腐块。断言"有几个 PUA 字根就有几个 .zigen"，
    // 两种情况都成立：内置数据 0 个 -> 0 个；本地自己放进去的 PUA -> 同样数量。
    const puaRoots = [];
    for (const r of ROOTMAP.rows) {
      for (const g of r.roots) {
        const c = g.codePointAt(0);
        if ((c >= 0xe000 && c <= 0xf8ff) || (c >= 0xf0000 && c <= 0x10fffd)) puaRoots.push(r.key + ":" + g);
      }
    }
    const ziCount = document.querySelectorAll("#keys-root .rroots .zigen").length;
    eq(ziCount, puaRoots.length, "私用区字根全部套上了字根字体（" + puaRoots.length + " 个）");
    if (puaRoots.length) results.push("  ..    字根表里有 " + puaRoots.length + " 个 PUA 字形（需要 data/local/zigen.ttf 才能显示）");

    // ---------------------------------------------------------- 故事
    group("内置故事");
    let storyOut = 0;
    let storyNoCode = 0;
    for (const st of STORIES) {
      for (const ch of Array.from(st.paragraphs.join(""))) {
        if (!Core.isHanzi(ch)) continue;
        if (!idx.charset.has(ch)) storyOut++;
        if (!idx.shortestCode(ch)) storyNoCode++;
      }
    }
    ok(STORIES.length >= 3, "内置故事 >= 3 篇", String(STORIES.length));
    eq(storyOut, 0, "全部故事 100% 落在 6500 字集内");
    eq(storyNoCode, 0, "全部故事的字都有五笔码");

    // ---------------------------------------------------------- 界面
    group("界面（DOM）");
    const app = window.WubiApp;
    ok(!!app, "app.js 已初始化");
    eq(document.querySelectorAll("#keys-mini .key").length, 26, "迷你键盘 26 个键");
    eq(document.querySelectorAll("#keys-root .root").length, 26, "字根表 26 格（25 键 + z 万能键）");
    eq(document.querySelectorAll("#run-text .ch").length, 0, "未开始时正文为空");

    document.getElementById("mask").click();
    ok(document.getElementById("mask").classList.contains("hide"), "点遮罩后进入激活态");

    app.startSession("工地。", "自检", null, 0);
    const spans = document.querySelectorAll("#run-text .ch");
    eq(spans.length, 3, "正文渲染出 3 个字符 span（含标点）");
    eq(spans[0].classList.contains("current"), true, "第一个字是 current 态");
    eq(spans[1].classList.contains("pending"), true, "第二个字是 pending 态");
    eq(spans[2].classList.contains("punct"), true, "句号（index 2）是 punct 态");

    function key(k) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    }
    key("a");
    eq(document.querySelectorAll("#ime-cands .cand").length, 1, "缓冲 a -> 候选框出现 1 个候选");
    eq(document.querySelectorAll("#ime-cands .cand .n")[0].textContent, "1", "候选编号从 1 开始（不是全局序号）");
    key(" ");
    eq(spans[0].classList.contains("done"), true, "上屏正确的 工 -> 该字变 done 态");
    eq(spans[1].classList.contains("current"), true, "光标落到第二个字（地）");
    eq(spans[2].classList.contains("punct"), true, "末尾标点仍是 punct 态（不进 plan）");

    document.getElementById("keys-hint").click();
    ok(document.getElementById("dock").classList.contains("expanded"), "点键盘 -> 原地放大");
    ok(!document.getElementById("keys-root").hidden, "字根表显示");
    ok(document.getElementById("keys-mini").hidden, "迷你键盘隐藏");
    document.querySelector('#keys-root .root[data-key="g"]').click();
    ok(/王旁青头/.test(document.getElementById("keys-hint").textContent), "点 G 键 -> 显示助记口诀");
    document.getElementById("keys-hint").click();
    ok(!document.getElementById("dock").classList.contains("expanded"), "再点 -> 收回迷你键盘");

    // ---------------------------------------------------------- 另外三种模式
    group("四种模式");
    const tab = (m) => document.querySelector('.tab[data-mode="' + m + '"]').click();

    tab("words");
    ok(document.getElementById("panel-words").classList.contains("active"), "切到常用词语模式");
    const chips = document.querySelectorAll("#words-list .w");
    eq(chips.length, 10, "一组 10 个词");
    ok(document.querySelectorAll("#words-text .ch").length > 0, "词语模式有自己的正文容器（不是隐藏的故事面板）");
    eq(chips[0].classList.contains("cur"), true, "第一个词标为当前");
    ok(/[a-y]{2,4}/.test(document.querySelector("#words-list .w .wcode").textContent), "词块显示词组码（纯字母）");
    ok(document.querySelectorAll("#words-list .w .cc").length >= 2, "词块逐字展开（每字一张小卡）");
    ok(
      /[a-y]{1,4}/.test(document.querySelector("#words-list .w .cc .cccode").textContent),
      "每个字给出自己的最短码"
    );
    const ccr = document.querySelector("#words-list .w .cc .ccroots");
    ok(
      ccr && (preciseOn ? ccr.querySelectorAll(".zigen").length > 0 : ccr.textContent.length > 5),
      "入门模式下逐字给出字根拆解",
      ccr && (preciseOn ? ccr.querySelectorAll(".zigen").length + " 个字形" : ccr.textContent.slice(0, 18))
    );
    const skipBefore = app.app.session.cursor;
    document.getElementById("btn-words-skip").click();
    ok(app.app.session.cursor > skipBefore, "「跳过当前词」推进光标", app.app.session.cursor);
    eq(chips[1].classList.contains("cur"), true, "跳过后当前词后移一位");

    tab("wrong");
    ok(document.getElementById("panel-wrong").classList.contains("active"), "切到错字本");
    ok(/错字|还没有错字/.test(document.getElementById("wrong-meta").textContent), "错字本摘要已渲染");

    tab("heat");
    ok(document.getElementById("panel-heat").classList.contains("active"), "切到热力图");
    const cells = document.querySelectorAll("#heat-grid span");
    eq(cells.length, 6500, "热力图渲染 6500 个字格");
    ok(/自己打对过 \d+ \/ 6500/.test(document.getElementById("heat-meta").textContent), "热力图覆盖率摘要");
    cells[100].click();
    ok(document.querySelectorAll("#heat-text .ch").length >= 30, "点热力图格子 -> 进入字表练习");

    tab("story");
    ok(document.getElementById("panel-story").classList.contains("active"), "切回故事模式");
    app.startSession("都天", "自检2", null, 0);
    key("f"); key("t"); key("j"); key("b");
    eq(app.app.tries, 1, "自动上屏 都 计入一次尝试");
    eq(app.app.firstTry, 1, "没错过 -> 计入首次正确");

    // ---------------------------------------------------------- 入门模式
    group("入门模式（编码行 + 当前字字根拆解）");
    const begBtn = document.getElementById("btn-beginner");
    ok(begBtn && begBtn.getAttribute("aria-pressed") === "true", "首次访问：入门模式默认开");

    app.startSession("工地在", "自检-入门", null, 0);
    const cells2 = document.querySelectorAll("#run-text .ch");
    eq(cells2.length, 3, "正文渲染 3 个字");
    eq(document.querySelectorAll("#run-text .ch .code").length, 3, "每个字上方都生成了一行编码");
    eq(cells2[0].querySelector(".code").textContent, "a", "工 的编码行 = 最短合法码 a");
    eq(cells2[1].querySelector(".code").textContent, "f", "地 的编码行 = f（一级简码）");
    eq(cells2[2].querySelector(".code").textContent, "d", "在 的编码行 = d（一级简码）");
    const rootsEl = cells2[0].querySelector(".roots");
    ok(!!rootsEl, "当前字有字根拆解浮注");
    ok(/A/.test(rootsEl.textContent), "浮注里出现键位 A", rootsEl.textContent.slice(0, 24));
    if (preciseOn) {
      ok(rootsEl.querySelectorAll(".zigen").length > 0, "精确层：浮注用字根字形", rootsEl.textContent.length);
    } else {
      ok(/工/.test(rootsEl.textContent) && /七/.test(rootsEl.textContent), "默认层：浮注列出 A 键的字根集合");
    }
    ok(/全码/.test(document.getElementById("ime-tip").textContent), "输入条额外给出全码");

    // 可整打提示
    app.startSession("我们的", "自检-词码", null, 0);
    const tag = document.querySelector("#run-text .ch .wordtag");
    ok(!!tag, "光标处的可整打词有标签");
    ok(/trwu/.test(tag ? tag.textContent : ""), "标签给出词组码 trwu", tag && tag.textContent);
    ok(document.querySelectorAll("#run-text .ch.insider").length === 2, "词的两个字被标为可整打范围");

    // 行距/总高回归：入门模式多了一行编码，但不能把正文撑得太高
    const longText = STORIES[0].paragraphs.join("\n");
    // 用 .zi（字身）量，不能用 .ch —— 标点没有编码行，顶部会差一个编码行的高度
    function pitchOf() {
      const tops = [];
      for (const c of document.querySelectorAll("#run-text .ch .zi")) {
        const t = Math.round(c.getBoundingClientRect().top);
        if (!tops.some(function (y) { return Math.abs(y - t) < 4; })) tops.push(t);
      }
      tops.sort(function (a, b) { return a - b; });
      return tops.length > 1 ? tops[1] - tops[0] : 0;
    }
    const heightOf = () => document.getElementById("run-text").getBoundingClientRect().height;
    app.startSession(longText, "自检-行距", null, 0);
    const pitchBeginner = pitchOf();
    const hBeginner = Math.round(heightOf());
    app.setBeginner(false, false);
    const pitchNormal = pitchOf();
    const hNormal = Math.round(heightOf());
    app.setBeginner(true, false);
    results.push("  ..    正文行距：入门模式 " + pitchBeginner + "px / 关闭时 " + pitchNormal + "px");
    results.push("  ..    整段总高：入门模式 " + hBeginner + "px / 关闭时 " + hNormal + "px（×" + (hBeginner / hNormal).toFixed(2) + "）");
    ok(pitchNormal > 20 && pitchBeginner > 20, "能量到行距", pitchBeginner + "/" + pitchNormal);
    ok(pitchBeginner <= pitchNormal * 1.35, "入门模式行距不超过关闭时的 1.35 倍", pitchBeginner + " vs " + pitchNormal);
    ok(hBeginner <= hNormal * 1.35, "整段总高膨胀不超过 35%", hBeginner + " vs " + hNormal);

    // 判错保留缓冲（入门模式）
    app.startSession("雨", "自检-缓冲", null, 0);
    key("f"); key("g");
    ok(app.app.session.buffer === "fg", "敲 fg 后缓冲 = fg");
    key(" "); // 太早按空格 -> 上屏 二 -> 判错
    eq(app.app.session.buffer, "fg", "入门模式判错后保留已敲的码");

    // 关掉开关
    begBtn.click();
    ok(app.app.beginner === false, "点开关 -> 关掉入门模式");
    ok(window.WubiStats.getPref("beginner") === false, "选择被写进偏好（下次打开记得住）");
    eq(document.querySelectorAll("#run-text .ch .code").length, 0, "关掉后编码行消失");
    ok(!document.querySelector("#run-text .ch .roots"), "关掉后拆解浮注消失");
    eq(app.app.session.keepBuffer, false, "关掉后会话不再保留缓冲");

    // 存储：入门模式的上屏只计练习量、不计掌握度
    const dump = window.WubiStats.exportJSON();
    let parsed = null;
    try { parsed = JSON.parse(dump); } catch (e) {}
    ok(parsed && typeof parsed.chars === "object", "导出 JSON 可被解析且含字级数据");
    ok(parsed && parsed.chars["工"] && parsed.chars["工"].seenBeginner >= 1, "入门模式的上屏记进 seenBeginner");
    ok(parsed && parsed.chars["工"] && !(parsed.chars["工"].seen > 0), "入门模式的上屏不计入 seen（掌握度）");
    ok(parsed && parsed.totals.charsBeginner >= 1, "totals.charsBeginner 有计数");

    // ---------------------------------------------------------- 精确拆解层（可选）
    group("精确字根拆解层");
    const RUx = window.WUBI86_ROOTUNITS;
    const ruState = document.getElementById("ru-state");
    app.setBeginner(true, false); // 拆解只在入门模式下渲染
    if (RUx && RUx.rows) {
      results.push("  ..    已加载 " + RUx.meta.rows + " 字，覆盖练习字集 " + RUx.meta.charsetCovered + " 字");
      ok(/精确拆解/.test(ruState.textContent), "右上角状态显示已启用", ruState.textContent);
      app.startSession("想", "自检-精确", null, 0);
      const rootEl = document.querySelector("#run-text .ch .roots");
      ok(!!rootEl, "当前字有拆解浮注");
      // 想 的最短码是 3 码 shn，识别码 u 在第 4 位 —— 浮注必须把全码余下位也讲清楚
      eq(rootEl.querySelectorAll(".zigen").length, 4, "想=shnu：四位都用真实字根字形（含全码余下位）");
      ok(!!rootEl.querySelector(".sep"), "最短码之外的部分用「全码」分隔标出");
      eq(rootEl.querySelectorAll(".rp.rest").length, 1, "全码余下位压暗（只有 1 位）");
      const idSpan = rootEl.querySelector(".rk-id");
      ok(!!idSpan, "末位标成识别码而不是字根");
      ok(/识别码/.test(idSpan ? idSpan.textContent : ""), "识别码位带「识别码」标签", idSpan && idSpan.textContent);
      ok(/末笔捺/.test(idSpan ? idSpan.getAttribute("title") : ""), "识别码位用 title 给出末笔·结构",
        idSpan && idSpan.getAttribute("title"));
      app.startSession("十", "自检-笔画码", null, 0);
      const st10 = document.querySelector("#run-text .ch .roots");
      eq(st10.querySelectorAll(".rk-stroke").length, 2, "十=fgh：后两位是笔画码");
      eq(st10.querySelectorAll(".rk-id").length, 0, "十 没有识别码位");
      app.startSession("𬉼", "自检-退回", null, 0);
      const stx = document.querySelector("#run-text .ch .roots");
      ok(stx && stx.querySelectorAll(".zigen").length === 0, "上游无拆解数据的字退回默认层（不画字形）");
      ok(stx && /[A-Y]/.test(stx.textContent), "退回后仍给出键位", stx && stx.textContent.slice(0, 24));
    } else {
      results.push("  ..    未生成 —— 只验默认层");
      ok(/未生成/.test(ruState.textContent), "右上角状态显示未生成", ruState.textContent);
      app.startSession("想", "自检-默认层", null, 0);
      const rootEl = document.querySelector("#run-text .ch .roots");
      ok(!!rootEl, "当前字有拆解浮注");
      eq(rootEl.querySelectorAll(".zigen").length, 0, "默认层没有字根字形");
      ok(/[A-Y]/.test(rootEl.textContent), "默认层给出键位", rootEl.textContent.slice(0, 24));
      ok(rootEl.textContent.length > 24, "默认层给出该键的字根集合", rootEl.textContent.length);
    }
    app.setBeginner(false, false); // 还原（后面的用例默认非入门）

    // ---------------------------------------------------------- 进度落盘
    // 这两组要等 debounce，所以放在异步尾巴里，最后再接 Tab 长按那一段
    group("进度落盘（节流写盘 + 离开页面 flush）");
    const KEY = window.WubiStats.KEY;
    const has = (s) => (localStorage.getItem(KEY) || "").indexOf(s) >= 0;
    // 用 森（本次自检没打过）观察落盘时机；会话不带 cursorKey，正是原先"中途关会丢"的那类
    app.startSession("森", "自检-落盘", null, 0);
    const senCode = Array.from(app.idx.shortestCode("森"));
    for (const k of senCode) key(k);
    key(" ");
    ok(app.app.session.stats.commits >= 1, "森 已上屏", app.app.session.stats.commits);
    ok(window.WubiStats.hasPendingSave(), "上屏后有待写的节流任务（不是每敲一下都写盘）");
    results.push("  ..    此刻 localStorage " + (has("森") ? "已含 森" : "尚未含 森（还在节流窗口内）"));
    window.dispatchEvent(new Event("pagehide")); // 等同"关掉网页 / 切到后台"
    ok(has("森"), "派发 pagehide 后立刻落盘 —— 中途关掉不丢");
    ok(!window.WubiStats.hasPendingSave(), "flush 之后没有残留的待写任务");

    setTimeout(function () {
      group("粘贴文本会存下来 + 能续打");
      const ta = document.getElementById("custom-text");
      ta.value = "天地人";
      ta.dispatchEvent(new Event("input"));
      setTimeout(function () {
        eq(window.WubiStats.getPref("customText", ""), "天地人", "输入 800ms 后粘贴内容写进偏好");
        document.getElementById("btn-custom-start").click();
        eq(app.app.session.cursor, 0, "首次开始 -> 从第 0 字起");
        const tian = Array.from(app.idx.shortestCode("天"));
        for (const k of tian) key(k);
        key(" ");
        ok(app.app.session.cursor >= 1, "打掉了第一个字", app.app.session.cursor);
        const at = window.WubiStats.storyCursor("custom");
        ok(at >= 1, "自定义文本的断点已写盘", at);
        // 再点一次「开始练」= 等同"关掉网页重新打开后再开始"
        document.getElementById("btn-custom-start").click();
        eq(app.app.session.cursor, at, "再开始时从断点续打");
        ok(/续打/.test(document.getElementById("run-title").textContent), "标题标明是续打",
          document.getElementById("run-title").textContent);
        // 换一段文本 -> 断点应当作废，从 0 起
        ta.value = "山水";
        ta.dispatchEvent(new Event("input"));
        document.getElementById("btn-custom-start").click();
        eq(app.app.session.cursor, 0, "换了文本 -> 断点作废，从头开始");

        // Tab 长按（异步）
        const tabBefore = document.getElementById("ime-tip").textContent;
        key("Tab");
        setTimeout(function () {
          key("Tab"); // 不会触发，只是确保 keyup 前不重复起计时器
          setTimeout(function () {
            const tip = document.getElementById("ime-tip").textContent || document.getElementById("ime-tip").innerHTML;
            ok(/还差|完整码|上屏/.test(tip), "长按 Tab 350ms -> 提示缺哪几个字母", tip);
            document.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
            finish();
          }, 260);
        }, 420);
      }, 950); // 等 debounce(800ms) 落地
    }, 10);
  }

  function finish() {
    const title = failed ? "SELFTEST FAIL " + failed : "SELFTEST PASS";
    document.title = title;
    const box = document.createElement("div");
    box.id = "selftest-out";
    box.style.cssText =
      "position:fixed;inset:0;z-index:999;overflow:auto;background:#0d0f12;color:#d7dde5;" +
      "font:12px/1.6 Consolas,monospace;padding:18px;white-space:pre-wrap";
    box.textContent =
      title + "\n" + results.join("\n") + "\n\n" + (failed ? "有失败项" : "全部通过");
    document.body.appendChild(box);
  }

  // 注意: run() 里有一部分是异步的（Tab 长按那段靠 setTimeout），
  // 所以必须把 run() 本身也包起来 —— 否则 load 回调里抛的异常没人接，
  // 自检会静默死掉、连 SELFTEST FAIL 都不写，这比失败本身更难查。
  function safeRun() {
    try {
      run();
    } catch (e) {
      failed++;
      results.push("EXCEPTION  " + (e && e.stack ? e.stack : String(e)));
      finish();
    }
  }

  if (document.readyState === "complete") safeRun();
  else window.addEventListener("load", safeRun);
})();
