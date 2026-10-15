// src/app.js —— 五笔86 练习器 UI 层（经典 script，无框架无构建）
//
// 依赖顺序（见 index.html）: data/wubi86.js -> data/rootmap.js -> data/stories.js
//                            -> src/wubi-core.js -> src/stats.js -> src/app.js
"use strict";
(function () {
  const Core = window.WubiCore;
  const D = window.WUBI86;
  const ROOTMAP = window.WUBI86_ROOTS;
  const STORIES = window.WUBI86_STORIES || [];
  const St = window.WubiStats;
  const $ = (id) => document.getElementById(id);

  const idx = Core.build(D);
  const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
  const HINT_MS = 350;

  const app = {
    active: false,
    mode: "story",
    session: null,
    label: "",
    started: 0, // 本段第一次按键时间戳
    dirty: false, // 上一次上屏以来是否出过错/用过提示（首次正确率用）
    firstTry: 0,
    tries: 0,
    hintOn: false,
    hintTimer: 0,
    keysExpanded: false,
    spans: [], // displayIndex -> span
    planSpans: [], // planIndex -> span
    lastCurrent: -1,
    cursorKey: null, // 断点存哪个 id
  };

  // ---------------------------------------------------------------- 小工具
  let toastTimer = 0;
  function toast(msg, isErr) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), 2000);
  }
  function pct(a, b) {
    return b ? Math.round((a / b) * 100) + "%" : "—";
  }
  function inCharset(ch) {
    return idx.charset.has(ch);
  }

  // ---------------------------------------------------------------- 迷你键盘 / 字根表
  const rootByKey = {};
  for (const r of ROOTMAP.rows) rootByKey[r.key] = r;

  function buildKeys() {
    const mini = $("keys-mini");
    mini.innerHTML = "";
    for (const row of ROWS) {
      const div = document.createElement("div");
      div.className = "krow";
      for (const k of Array.from(row)) {
        const b = document.createElement("div");
        b.className = "key" + (k === "z" ? " z" : "");
        b.dataset.key = k;
        b.textContent = k.toUpperCase();
        b.title = k === "z" ? "z：五笔万能键，练习中不合法" : "点击输入 " + k.toUpperCase();
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!app.active) return;
          handleKey(k);
        });
        div.appendChild(b);
      }
      mini.appendChild(div);
    }

    const root = $("keys-root");
    root.innerHTML = "";
    const grid = document.createElement("div");
    grid.className = "rootgrid";
    for (const row of ROWS) {
      const div = document.createElement("div");
      div.className = "krow";
      for (const k of Array.from(row)) {
        const info = rootByKey[k];
        const cell = document.createElement("div");
        cell.className = "root";
        cell.dataset.key = k;
        if (!info) {
          cell.innerHTML = '<div class="rhead"><span class="rkey">Z</span><span class="rname">万能键</span></div><div class="rroots">—</div>';
        } else {
          cell.innerHTML =
            '<div class="rhead"><span class="rkey">' +
            k.toUpperCase() +
            '</span><span class="rname">' +
            info.name +
            "</span></div>" +
            '<div class="rroots">' +
            info.roots.map((r) => "<span>" + r + "</span>").join("") +
            "</div>";
          cell.addEventListener("click", (e) => {
            e.stopPropagation();
            showMnemonic(k);
          });
        }
        div.appendChild(cell);
      }
      grid.appendChild(div);
    }
    root.appendChild(grid);
    showMnemonic(null);
  }

  function showMnemonic(k) {
    const note = $("keys-hint");
    if (!k) {
      note.innerHTML = "点键盘 → 字根表 · 再点这里收回";
      return;
    }
    const info = rootByKey[k];
    const short = (idx.shortestCode(info.name) || "").toUpperCase();
    note.innerHTML =
      '<span class="mn">' +
      k.toUpperCase() +
      " " +
      info.name +
      "</span>（" +
      short +
      "）　" +
      info.mnemonic;
  }

  function toggleKeys() {
    app.keysExpanded = !app.keysExpanded;
    $("dock").classList.toggle("expanded", app.keysExpanded);
    document.body.classList.toggle("dock-expanded", app.keysExpanded);
    $("keys-mini").hidden = app.keysExpanded;
    $("keys-root").hidden = !app.keysExpanded;
    showMnemonic(null);
    $("keys-hint").textContent = app.keysExpanded ? "点这里收回迷你键盘" : "点键盘 → 字根表";
    const s = app.session;
    if (s && !s.isDone() && app.spans[s.plan[s.cursor].displayIndex]) scrollIntoBand(app.spans[s.plan[s.cursor].displayIndex]);
  }

  function lit(key) {
    const sel = app.keysExpanded ? ".root" : ".key";
    const nodes = document.querySelectorAll(sel + '[data-key="' + key + '"]');
    for (const n of nodes) {
      n.classList.add("lit");
      setTimeout(() => n.classList.remove("lit"), 130);
    }
  }

  // ---------------------------------------------------------------- 正文渲染
  function renderText(text, containerId) {
    const container = $(containerId || "run-text");
    container.innerHTML = "";
    app.textEl = container;
    app.spans = [];
    app.planSpans = [];
    app.lastCurrent = -1;
    const chars = Array.from(text);
    let span = null;
    const newPara = () => {
      span = document.createElement("p");
      container.appendChild(span);
    };
    newPara();
    const planOfDisplay = {};
    if (app.session) for (let i = 0; i < app.session.plan.length; i++) planOfDisplay[app.session.plan[i].displayIndex] = i;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === "\n") {
        newPara();
        app.spans.push(null);
        continue;
      }
      const s = document.createElement("span");
      s.className = "ch";
      s.textContent = ch;
      if (!Core.isHanzi(ch)) s.classList.add("punct");
      else if (!inCharset(ch)) {
        s.classList.add("outofset");
        s.title = "超纲字（不在 6500 字集内）";
      }
      span.appendChild(s);
      app.spans.push(s);
      if (planOfDisplay[i] !== undefined) app.planSpans[planOfDisplay[i]] = s;
    }
  }

  function applyStates() {
    const s = app.session;
    if (!s) return;
    const states = s.displayStates();
    for (let i = 0; i < states.length; i++) {
      const el = app.spans[i];
      if (!el) continue;
      el.classList.remove("done", "current", "pending");
      if (states[i] !== "punct") el.classList.add(states[i]);
    }
    const cur = s.plan[s.cursor];
    if (cur) {
      const el = app.spans[cur.displayIndex];
      if (el && s.cursor !== app.lastCurrent) {
        scrollIntoBand(el);
        app.lastCurrent = s.cursor;
      }
    }
  }

  // 把当前字滚到"安全带"里 —— 展开字根表时 dock 会盖住视口下半部分，
  // 所以展开时把当前字压到上方 24% 处，收起时放中间偏上。
  function scrollIntoBand(el) {
    if (!el) return;
    const band = app.keysExpanded ? 0.24 : 0.38;
    const rect = el.getBoundingClientRect();
    const y = window.scrollY + rect.top - window.innerHeight * band;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }

  function flashWrong(displayIndex) {
    const el = app.spans[displayIndex];
    if (!el) return;
    el.classList.remove("wrongflash");
    void el.offsetWidth;
    el.classList.add("wrongflash");
    setTimeout(() => el.classList.remove("wrongflash"), 460);
  }

  function glowHint(on) {
    const s = app.session;
    if (!s) return;
    const cur = s.plan[s.cursor];
    if (!cur) return;
    const el = app.spans[cur.displayIndex];
    if (el) el.classList.toggle("hintglow", !!on);
  }

  // ---------------------------------------------------------------- 输入条
  function renderIme() {
    const s = app.session;
    const buf = $("ime-buf");
    if (!s) {
      buf.textContent = "";
      $("ime-cands").innerHTML = "";
      $("ime-tip").textContent = app.mode === "story" ? "先选一篇" : "";
      return;
    }
    buf.textContent = s.buffer;
    const cands = $("ime-cands");
    const list = s.pageCandidates();
    cands.innerHTML = "";
    const base = s.page * idx.pageSize;
    list.forEach((c, i) => {
      const d = document.createElement("div");
      d.className = "cand" + (c.kind === "word" ? " word" : "");
      d.innerHTML = '<span class="n">' + (i + 1) + '</span><span class="t"></span>';
      d.querySelector(".t").textContent = c.text;
      d.title = c.code + (c.inCharset ? "" : "（超纲）");
      // 数字键选的是"本页第 N 个"，不是全局序号
      d.addEventListener("click", () => handleKey(String(i + 1)));
      cands.appendChild(d);
    });
    if (s.candidates.length > idx.pageSize) {
      const p = document.createElement("span");
      p.className = "pageinfo";
      p.textContent = "第 " + (s.page + 1) + "/" + s.pageCount() + " 页（- = 翻页）";
      cands.appendChild(p);
    }
    if (app.hintOn) return; // 提示态由 showHint 接管
    const tip = $("ime-tip");
    if (s.isDone()) tip.innerHTML = "本篇完成 ✔";
    else if (!s.buffer) {
      const cur = s.plan[s.cursor];
      tip.innerHTML = tipBase(cur ? cur.ch : "") + "　敲字母开始（长按 Tab 提示）";
    } else {
      tip.innerHTML = "已敲 " + s.buffer.length + " 码 · 候选 " + s.candidates.length + " 个";
    }
  }
  function tipBase(ch) {
    if (!ch) return "";
    return (
      "目标 <b>" +
      ch +
      "</b>" +
      (inCharset(ch) ? "" : "（超纲）") +
      (idx.shortestCode(ch) ? "　最短 " + idx.shortestCode(ch).length + " 码" : "")
    );
  }

  function showHint() {
    const s = app.session;
    if (!s || s.isDone()) return;
    const h = s.hint();
    if (!h) return;
    app.hintOn = true;
    St.recordHint(h.char);
    app.dirty = true;
    glowHint(true);
    const bits = [];
    bits.push("目标 <b>" + h.char + "</b>" + (h.inCharset ? "" : "（超纲）"));
    if (h.mismatch) bits.push('已敲的 <span class="miss">' + h.typed + "</span> 对不上，完整码 <span class=\"miss\">" + h.code + "</span>");
    else if (h.missing) bits.push('还差 <span class="miss">' + h.missing + "</span>（全码 " + h.code + "）");
    else bits.push("码已打全，按空格或数字上屏");
    if (h.word) bits.push('可整打「' + h.word.text + "」<span class=\"miss\">" + h.word.code + "</span>");
    $("ime-tip").innerHTML = bits.join("　·　");
  }
  function hideHint() {
    if (!app.hintOn) return;
    app.hintOn = false;
    glowHint(false);
    renderIme();
  }
  function startHint() {
    if (app.hintTimer) return;
    app.hintTimer = setTimeout(() => {
      app.hintTimer = 0;
      showHint();
    }, HINT_MS);
  }
  function stopHint() {
    if (app.hintTimer) {
      clearTimeout(app.hintTimer);
      app.hintTimer = 0;
    }
    hideHint();
  }

  // ---------------------------------------------------------------- 统计
  function updateStats() {
    const s = app.session;
    const st = s ? s.stats : { correct: 0, wrong: 0, commits: 0, hintUses: 0 };
    const mins = app.started ? (Date.now() - app.started) / 60000 : 0;
    $("st-cpm").textContent = mins > 0.02 ? Math.round(st.correct / mins) : "0";
    $("st-acc").textContent = st.commits ? pct(st.correct, st.correct + st.wrong) : "—";
    $("st-first").textContent = app.tries ? pct(app.firstTry, app.tries) : "—";
    $("st-wrong").textContent = String(st.wrong);
    $("st-hint").textContent = String(st.hintUses);
    $("st-prog").textContent = s ? pct(s.cursor, s.plan.length) : "0%";
  }

  // ---------------------------------------------------------------- 会话
  function startSession(text, label, cursorKey, resumeAt, textContainerId) {
    app.session = Core.createSession(idx, { text: text });
    app.label = label;
    app.cursorKey = cursorKey || null;
    app.started = 0;
    app.dirty = false;
    app.firstTry = 0;
    app.tries = 0;
    app.hintOn = false;
    if (resumeAt) {
      // 断点续打: 直接跳过已完成的字数（不计对错）
      while (app.session.cursor < resumeAt && !app.session.isDone()) app.session.skip();
      app.session.stats.skips = 0;
    }
    const el = textContainerId || "run-text";
    if (el === "run-text") {
      $("story-picker").hidden = true;
      $("story-run").hidden = false;
      $("run-title").textContent = label;
    }
    renderText(text, el);
    applyStates();
    renderIme();
    updateStats();
    $("run-done").hidden = true;
    updateRunMeta();
    syncWords();
  }

  function updateRunMeta() {
    const s = app.session;
    if (!s) return;
    const total = s.plan.length;
    const set = new Set(s.plan.map((p) => p.ch));
    let out = 0;
    for (const c of set) if (!inCharset(c)) out++;
    $("run-meta").textContent =
      total + " 字 · " + set.size + " 个字种" + (out ? " · 超纲 " + out + " 个字种（标灰，照样能打）" : " · 全在 6500 字集内");
  }

  function finishIfDone() {
    const s = app.session;
    if (!s || !s.isDone()) return;
    const mins = app.started ? (Date.now() - app.started) / 60000 : 0;
    const st = s.stats;
    St.addSession({
      label: app.label,
      ts: Date.now(),
      ms: app.started ? Date.now() - app.started : 0,
      chars: st.correct,
      cpm: mins > 0.02 ? Math.round(st.correct / mins) : 0,
      wrong: st.wrong,
      rejects: st.rejects,
      hints: st.hintUses,
      firstTry: app.tries ? Math.round((app.firstTry / app.tries) * 100) : 100,
    });
    $("run-done").hidden = false;
    $("run-done-note").textContent =
      "完成！" +
      st.correct +
      " 字 / " +
      (mins > 0.02 ? mins.toFixed(1) : "0") +
      " 分钟 · 判错 " +
      st.wrong +
      " 次 · 提示 " +
      st.hintUses +
      " 次 · 首次正确 " +
      (app.tries ? Math.round((app.firstTry / app.tries) * 100) : 100) +
      "%";
    toast($("run-done-note").textContent);
    if (app.cursorKey) St.setStoryCursor(app.cursorKey, s.plan.length, s.plan.length);
    renderStoryList();
  }

  function handleKey(k) {
    const s = app.session;
    if (!s || s.isDone()) return;
    if (k.length === 1 && /[a-y]/.test(k) && !app.started) app.started = Date.now();
    const ev = s.press(k);
    lit(k);
    afterEvent(ev);
  }

  function afterEvent(ev) {
    const s = app.session;
    switch (ev.type) {
      case "reject": {
        app.dirty = true;
        const b = $("ime-buf");
        b.classList.remove("reject");
        void b.offsetWidth;
        b.classList.add("reject");
        break;
      }
      case "commit":
      case "autocommit": {
        const cur = s.plan[ev.cursorBefore];
        St.recordCommit({ text: ev.text, correct: ev.correct, expected: ev.expected });
        if (ev.correct) {
          app.tries++;
          if (!app.dirty) app.firstTry++;
          app.dirty = false;
          St.setStoryCursor(app.cursorKey, s.cursor, s.plan.length);
          finishIfDone();
        } else {
          app.dirty = true;
          if (cur) flashWrong(cur.displayIndex);
        }
        break;
      }
      case "undo":
        app.dirty = true;
        if (app.cursorKey) St.setStoryCursor(app.cursorKey, s.cursor, s.plan.length);
        break;
      default:
        break;
    }
    applyStates();
    renderIme();
    updateStats();
    syncWords();
  }

  // ---------------------------------------------------------------- 键盘事件
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Tab") {
      e.preventDefault();
      if (!e.repeat) startHint();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (app.keysExpanded) toggleKeys();
      else if (app.session) {
        app.session.press("Escape");
        renderIme();
      }
      return;
    }
    if (!app.active) return;
    const k = e.key;
    const isLetter = k.length === 1 && k >= "a" && k <= "z";
    const isCtrl = e.ctrlKey || e.altKey || e.metaKey;
    if (isCtrl) return;
    if (isLetter || k === " " || (k >= "1" && k <= "9" && !e.shiftKey) || k === "-" || k === "=" || k === "Backspace") {
      e.preventDefault();
      handleKey(k === "Backspace" ? "Backspace" : k);
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      stopHint();
    }
  });
  window.addEventListener("blur", stopHint);

  // ---------------------------------------------------------------- 故事模式
  function renderStoryList() {
    const box = $("story-list");
    box.innerHTML = "";
    for (const s of STORIES) {
      const total = Array.from(s.paragraphs.join("")).filter((c) => Core.isHanzi(c)).length;
      const cur = Math.min(St.storyCursor(s.id), total);
      const it = document.createElement("div");
      it.className = "item";
      it.innerHTML =
        '<span class="t">' +
        s.title +
        '</span><span class="d">' +
        s.note +
        "</span>" +
        '<span class="bar"><i style="width:' +
        (total ? Math.round((cur / total) * 100) : 0) +
        '%"></i></span>' +
        '<span class="b">' +
        (cur >= total && cur > 0 ? "已完成 · 再练一遍" : cur > 0 ? "继续 " + cur + "/" + total : total + " 字") +
        "</span>";
      it.addEventListener("click", () => {
        const at = cur > 0 && cur < total ? cur : 0;
        startSession(s.paragraphs.join("\n"), s.title, s.id, at);
        activate();
      });
      box.appendChild(it);
    }
  }

  $("btn-back").addEventListener("click", () => {
    $("story-picker").hidden = false;
    $("story-run").hidden = true;
    app.session = null;
    renderStoryList();
    renderIme();
  });
  $("btn-restart").addEventListener("click", () => {
    const s = STORIES.find((x) => x.title === app.label);
    if (s) startSession(s.paragraphs.join("\n"), s.title, s.id, 0);
    else if (app.session) startSession(app.session.display.join(""), app.label, app.cursorKey, 0);
  });

  $("custom-text").addEventListener("input", () => {
    const txt = $("custom-text").value;
    const chars = Array.from(txt).filter((c) => Core.isHanzi(c));
    const set = new Set(chars);
    let out = 0;
    let nocode = 0;
    for (const c of set) {
      if (!inCharset(c)) out++;
      if (!idx.shortestCode(c)) nocode++;
    }
    $("custom-check").textContent = chars.length
      ? chars.length + " 字 / " + set.size + " 个字种 · 超纲 " + out + " 个" + (nocode ? " · 无码 " + nocode + " 个（会跳过）" : "")
      : "";
  });
  $("btn-custom-start").addEventListener("click", () => {
    const txt = $("custom-text").value.trim();
    if (!txt) return toast("先粘贴一段文本", true);
    startSession(txt, "自定义文本", null, 0);
    activate();
  });

  // ---------------------------------------------------------------- 常用词语
  const wordPool = [];
  for (const row of D.phrase) {
    const p = row.split(",");
    const n = Array.from(p[0]).length;
    if (n < idx.wordLen[0] || n > idx.wordLen[1]) continue;
    if (idx.wordStop.has(p[0])) continue;
    wordPool.push({ text: p[0], code: p[1], weight: Number(p[2]), len: n });
  }
  let wordsGroup = [];
  let wordsSort = "weight";
  const GROUP = 10;

  // 词语模式下把已打完 / 当前 / 未打的词标出来（会话光标是按字推进的，这里换算回词）
  function syncWords() {
    const s = app.session;
    const box = $("words-list");
    if (!s || app.mode !== "words" || !box.children.length) return;
    let ptr = 0;
    let curIdx = wordsGroup.length;
    for (let i = 0; i < wordsGroup.length; i++) {
      const len = Array.from(wordsGroup[i].text).length;
      if (ptr + len <= s.cursor) {
        ptr += len;
        continue;
      }
      curIdx = i;
      break;
    }
    for (let i = 0; i < box.children.length; i++) {
      const d = box.children[i];
      d.classList.toggle("ok", i < curIdx);
      d.classList.toggle("cur", i === curIdx);
    }
  }

  function pickWords() {
    let pool = wordPool;
    if (wordsSort === "len2") pool = wordPool.filter((w) => w.len === 2);
    if (wordsSort === "random") {
      const a = pool.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
      }
      wordsGroup = a.slice(0, GROUP);
    } else {
      const off = Math.floor(Math.random() * Math.max(1, Math.min(1500, pool.length - GROUP)));
      wordsGroup = pool.slice(off, off + GROUP);
    }
    const text = wordsGroup.map((w) => w.text).join("，");
    $("words-meta").textContent =
      "词表 " + wordPool.length + " 条（词长 " + idx.wordLen[0] + "–" + idx.wordLen[1] + "，已去站点词）· 本组 " + wordsGroup.length + " 个词";
    renderWords();
    startSession(text, "常用词语", null, 0, "words-text");
  }
  function renderWords() {
    const box = $("words-list");
    box.innerHTML = "";
    wordsGroup.forEach((w, i) => {
      const d = document.createElement("div");
      d.className = "w";
      d.dataset.i = String(i);
      d.innerHTML = '<span class="t"></span><span class="n" style="font-size:11px;color:var(--fg-faint)"></span>';
      d.querySelector(".t").textContent = w.text;
      d.querySelector(".n").textContent = " " + w.code;
      d.title = w.code;
      box.appendChild(d);
    });
  }
  for (const b of document.querySelectorAll("[data-sort]")) {
    b.addEventListener("click", () => {
      wordsSort = b.dataset.sort;
      pickWords();
      activate();
    });
  }
  $("btn-words-next").addEventListener("click", () => {
    pickWords();
    activate();
  });
  $("btn-words-skip").addEventListener("click", () => {
    if (!app.session) return;
    const ev = app.session.skip();
    afterEvent(ev);
  });

  // ---------------------------------------------------------------- 错字本
  function renderWrong() {
    const list = St.wrongList(200);
    const words = St.wrongWords(40);
    $("wrong-meta").textContent = list.length
      ? "错过的字 " + list.length + " 个 · 错过的词 " + words.length + " 个（按错误次数排序）"
      : "还没有错字。打错一次就会记在这里。";
    const box = $("wrong-list");
    box.innerHTML = "";
    for (const it of list) {
      const d = document.createElement("div");
      d.className = "item";
      d.innerHTML =
        '<span class="t" style="font-size:22px"></span><span class="d"></span><span class="b"></span>';
      d.children[0].textContent = it.ch;
      d.children[1].textContent = "练过 " + it.seen + " 次 · 提示 " + it.hint + " 次";
      d.children[2].textContent = "错 " + it.wrong + " 次" + (idx.shortestCode(it.ch) ? " · " + idx.shortestCode(it.ch) : "");
      box.appendChild(d);
    }
    for (const w of words) {
      const d = document.createElement("div");
      d.className = "item";
      d.innerHTML = '<span class="t" style="font-size:20px"></span><span class="d"></span><span class="b"></span>';
      d.children[0].textContent = w.word;
      d.children[1].textContent = "词 · 练过 " + w.seen + " 次";
      d.children[2].textContent = "错 " + w.wrong + " 次";
      box.appendChild(d);
    }
  }
  $("btn-wrong-start").addEventListener("click", () => {
    const list = St.wrongList(40);
    if (!list.length) return toast("错字本是空的，先去练几篇", true);
    const text = list.map((x) => x.ch).join(" ");
    startSession(text, "错字本重练（" + list.length + " 字）", null, 0, "wrong-text");
    activate();
  });
  $("btn-wrong-clear").addEventListener("click", () => {
    St.clearWrong();
    renderWrong();
    renderHeat();
    toast("错字本已清空");
  });

  // ---------------------------------------------------------------- 热力图
  const HEAT_RUN = 30;
  function renderHeat() {
    const list = idx.charsetList;
    const cov = St.coverage(list);
    $("heat-meta").textContent =
      "已练 " + cov.touched + " / " + cov.total + " 字（" + Math.round((cov.touched / cov.total) * 100) + "%）· 点任意字开始刷这一段";
    const grid = $("heat-grid");
    grid.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const ch of list) {
      const b = document.createElement("span");
      const lv = St.charLevel(ch);
      const cls = lv === 1 ? "l1" : lv === 2 ? "l2" : lv === 3 ? "l0" : "";
      if (cls) b.className = cls;
      b.textContent = ch;
      const cs = St.charStats(ch);
      b.title = ch + "：" + (cs ? "练过 " + cs.seen + " 次，错 " + cs.wrong + " 次，提示 " + cs.hint + " 次" : "还没练过");
      frag.appendChild(b);
    }
    grid.appendChild(frag);
    grid.onclick = (e) => {
      const t = e.target;
      if (t.tagName !== "SPAN") return;
      const i = list.indexOf(t.textContent);
      if (i < 0) return;
      const run = list.slice(i, i + HEAT_RUN);
      startSession(run.join(" "), "字表练习（第 " + (i + 1) + " 字起 " + run.length + " 字）", null, 0, "heat-text");
      activate();
    };
  }

  // ---------------------------------------------------------------- 模式切换
  function setMode(m) {
    app.mode = m;
    for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.mode === m));
    for (const p of ["story", "words", "wrong", "heat"]) $("panel-" + p).classList.toggle("active", p === m);
    if (m === "story") {
      renderStoryList();
      if (!app.session) {
        $("story-picker").hidden = false;
        $("story-run").hidden = true;
      }
    }
    if (m === "words" && !wordsGroup.length) pickWords();
    if (m === "wrong") renderWrong();
    if (m === "heat") renderHeat();
    renderIme();
    updateStats();
  }
  for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => setMode(t.dataset.mode));

  // ---------------------------------------------------------------- 遮罩 / 激活
  function activate() {
    if (app.active) return;
    app.active = true;
    $("mask").classList.add("hide");
  }
  $("mask").addEventListener("click", activate);

  // ---------------------------------------------------------------- 主题 / 导入导出 / 自检
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    $("btn-theme").textContent = t === "dark" ? "亮色" : "暗色";
    try {
      localStorage.setItem("wubi86.theme", t);
    } catch (e) {}
  }
  $("btn-theme").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

  $("btn-export").addEventListener("click", () => {
    const blob = new Blob([St.exportJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "wubi86-progress-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("已导出进度文件");
  });
  $("btn-import").addEventListener("click", () => $("file-import").click());
  $("file-import").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        St.importJSON(String(r.result));
        renderStoryList();
        renderWrong();
        renderHeat();
        toast("导入成功");
      } catch (err) {
        toast("导入失败：" + err.message, true);
      }
    };
    r.readAsText(f);
    e.target.value = "";
  });
  $("btn-selftest").addEventListener("click", () => window.open("index.html?selftest=1", "_blank"));

  $("keys-hint").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleKeys();
  });

  // ---------------------------------------------------------------- 启动
  function boot() {
    buildKeys();
    setTheme((function () {
      try {
        return localStorage.getItem("wubi86.theme") || "dark";
      } catch (e) {
        return "dark";
      }
    })());
    St.load();
    $("storage-status").innerHTML = St.storageAvailable()
      ? ""
      : "<b>进度无法保存</b>（浏览器禁用了本地存储，本次练习不落盘）";
    renderStoryList();
    renderWrong();
    setMode("story");
    renderIme();
    updateStats();
    setInterval(updateStats, 700);
    window.addEventListener("beforeunload", () => {
      if (app.session && app.cursorKey) St.setStoryCursor(app.cursorKey, app.session.cursor, app.session.plan.length);
    });
    applyQuery();
  }

  // URL 钩子（深链 / 截图 / 自检用）:
  //   ?mask=0          直接跳过"点击开始"遮罩
  //   ?story=lamp      直接开始某篇内置故事（用 id）
  //   ?keys=root       迷你键盘以字根表形态打开
  function applyQuery() {
    const q = new URLSearchParams(location.search);
    if (q.get("mask") === "0") activate();
    const sid = q.get("story");
    if (sid) {
      const s = STORIES.find((x) => x.id === sid);
      if (s) {
        startSession(s.paragraphs.join("\n"), s.title, s.id, 0);
        activate();
      }
    }
    if (q.get("keys") === "root") toggleKeys();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 供 selftest.html / 调试用
  window.WubiApp = { app: app, idx: idx, setMode: setMode, startSession: startSession };
})();
