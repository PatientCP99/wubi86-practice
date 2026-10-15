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
    ok(/[a-y]{2,4}/.test(document.querySelector("#words-list .w .n").textContent), "词块显示了词组码（纯字母）");
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
    ok(/已练 \d+ \/ 6500/.test(document.getElementById("heat-meta").textContent), "热力图覆盖率摘要");
    cells[100].click();
    ok(document.querySelectorAll("#heat-text .ch").length >= 30, "点热力图格子 -> 进入字表练习");

    tab("story");
    ok(document.getElementById("panel-story").classList.contains("active"), "切回故事模式");
    app.startSession("都天", "自检2", null, 0);
    key("f"); key("t"); key("j"); key("b");
    eq(app.app.tries, 1, "自动上屏 都 计入一次尝试");
    eq(app.app.firstTry, 1, "没错过 -> 计入首次正确");

    // 存储
    const dump = window.WubiStats.exportJSON();
    let parsed = null;
    try { parsed = JSON.parse(dump); } catch (e) {}
    ok(parsed && typeof parsed.chars === "object", "导出 JSON 可被解析且含字级数据");
    ok(parsed && parsed.chars["工"] && parsed.chars["工"].seen >= 1, "字级统计记录了 工");

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

  try {
    if (document.readyState === "complete") run();
    else window.addEventListener("load", run);
  } catch (e) {
    failed++;
    results.push("EXCEPTION " + (e && e.stack ? e.stack : e));
    finish();
  }
})();
