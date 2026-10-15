// src/stats.js —— localStorage 统计与进度（字级数据 / 断点 / 历史 / 导出导入）
//
// localStorage 在 file:// 下多数浏览器可用，但可能被策略禁用（隐私模式等）。
// 所以所有读写都走 try/catch，失败自动退化为内存存储并在界面上报，绝不因为存储问题崩掉练习。
"use strict";
(function (root) {
  const KEY = "wubi86.practice.v1";
  const VERSION = 1;

  function emptyData() {
    return {
      version: VERSION,
      created: Date.now(),
      updated: 0,
      stories: {}, // id -> {cursor, total, done, updated}
      // 注意 seen 与 seenBeginner 是两回事:
      //   seen          = 没看答案、自己打对的次数 -> 这才是"掌握度"，热力图按它染色
      //   seenBeginner  = 入门模式（答案就在屏幕上）照着打对的次数 -> 只算练习量
      // 不分开的后果: 入门模式跑一遍 6500 字，热力图就全绿了，掌握度变成谎话。
      chars: {}, // 字 -> {seen, seenBeginner, wrong, hint, ms}
      words: {}, // 词 -> {seen, seenBeginner, wrong}
      history: [], // 每次练习一条（带 mode）
      prefs: {}, // 界面偏好（入门开关等）
      totals: { chars: 0, charsBeginner: 0, ms: 0, sessions: 0, wrong: 0, hints: 0 },
    };
  }

  let data = emptyData();
  let available = false;
  let memoryOnly = false;

  function readStorage() {
    try {
      const raw = root.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function writeStorage() {
    try {
      root.localStorage.setItem(KEY, JSON.stringify(data));
      available = true;
      return true;
    } catch (e) {
      memoryOnly = true;
      return false;
    }
  }

  function load() {
    const saved = readStorage();
    if (saved && typeof saved === "object") {
      data = Object.assign(emptyData(), saved);
      data.stories = saved.stories || {};
      data.chars = saved.chars || {};
      data.words = saved.words || {};
      data.history = Array.isArray(saved.history) ? saved.history : [];
      data.prefs = saved.prefs || {};
      data.totals = Object.assign(emptyData().totals, saved.totals || {});
      available = true;
    } else {
      // 探测可用性
      try {
        root.localStorage.setItem(KEY + ".probe", "1");
        root.localStorage.removeItem(KEY + ".probe");
        available = true;
      } catch (e) {
        available = false;
        memoryOnly = true;
      }
    }
    return data;
  }

  function save() {
    data.updated = Date.now();
    return writeStorage();
  }

  // ------------------------------------------------------------ 写入
  function setStoryCursor(id, cursor, total) {
    if (!id) return;
    const s = data.stories[id] || { cursor: 0, total: total || 0, done: false };
    s.cursor = cursor;
    s.total = total || s.total;
    s.done = total ? cursor >= total : false;
    s.updated = Date.now();
    data.stories[id] = s;
    save();
  }
  function storyCursor(id) {
    const s = data.stories[id];
    return s ? s.cursor : 0;
  }

  // 字级: 正确上屏记 seen（入门模式记 seenBeginner）; 判错记 wrong; 用提示记 hint
  function bumpChar(ch, field, n) {
    if (!ch) return;
    const c = data.chars[ch] || { seen: 0, seenBeginner: 0, wrong: 0, hint: 0 };
    c[field] = (c[field] || 0) + (n === undefined ? 1 : n);
    data.chars[ch] = c;
  }
  function bumpWord(w, field) {
    if (!w || Array.from(w).length < 2) return;
    const o = data.words[w] || { seen: 0, seenBeginner: 0, wrong: 0 };
    o[field] = (o[field] || 0) + 1;
    data.words[w] = o;
  }

  // 上屏结果: {text, correct, expected, beginner}
  // beginner=true（入门模式，答案就显示在屏幕上）时正确上屏**不计入掌握度**，
  // 只计练习量。判错照常计 —— 错就是错，错字本要能用。
  function recordCommit(res) {
    const chars = Array.from(res.text);
    const beg = !!res.beginner;
    if (res.correct) {
      for (const ch of chars) bumpChar(ch, beg ? "seenBeginner" : "seen");
      if (chars.length > 1) bumpWord(res.text, beg ? "seenBeginner" : "seen");
      if (beg) data.totals.charsBeginner += chars.length;
      else data.totals.chars += chars.length;
    } else {
      const want = Array.from(res.expected || "");
      for (const ch of chars) bumpChar(ch, "wrong");
      if (chars.length > 1) bumpWord(res.text, "wrong");
      if (want.length === 1) bumpChar(want[0], "wrong");
      data.totals.wrong++;
    }
  }
  function recordHint(ch) {
    if (ch) bumpChar(ch, "hint");
    data.totals.hints++;
  }

  // ------------------------------------------------------------ 界面偏好
  function getPref(k, dflt) {
    return data.prefs[k] === undefined ? dflt : data.prefs[k];
  }
  function setPref(k, v) {
    data.prefs[k] = v;
    save();
    return v;
  }

  function addSession(rec) {
    data.history.unshift(rec);
    if (data.history.length > 300) data.history.length = 300;
    data.totals.sessions++;
    data.totals.ms += rec.ms || 0;
    save();
  }

  // ------------------------------------------------------------ 查询
  function charStats(ch) {
    return data.chars[ch] || null;
  }
  // 错字本: 错得多的排前面（只算"上屏判错"）
  function wrongList(limit) {
    const list = [];
    for (const ch in data.chars) {
      const c = data.chars[ch];
      if (c.wrong > 0) list.push({ ch: ch, wrong: c.wrong, seen: c.seen, hint: c.hint });
    }
    list.sort((a, b) => b.wrong - a.wrong || a.seen - b.seen);
    return limit ? list.slice(0, limit) : list;
  }
  function wrongWords(limit) {
    const list = [];
    for (const w in data.words) {
      if (data.words[w].wrong > 0) list.push({ word: w, wrong: data.words[w].wrong, seen: data.words[w].seen });
    }
    list.sort((a, b) => b.wrong - a.wrong);
    return limit ? list.slice(0, limit) : list;
  }
  // 热力图分桶:
  //   -1 没碰过  0 错过（优先显示，不管是在哪种模式错的）
  //    1 练熟（自己打对 ≥3 次）  2 练过（自己打对 1-2 次）
  //    4 只在入门模式练过（答案在屏幕上照着打的，不算掌握度）
  function charLevel(ch) {
    const c = data.chars[ch];
    if (!c) return -1;
    if (c.wrong > 0) return 0;
    if (c.seen >= 3) return 1;
    if (c.seen > 0) return 2;
    if (c.seenBeginner > 0) return 4;
    return -1;
  }
  // 掌握度覆盖（只看 seen，入门模式不计）
  function coverage(charsetList) {
    let touched = 0;
    let beginnerOnly = 0;
    for (const ch of charsetList) {
      const c = data.chars[ch];
      if (c && c.seen) touched++;
      else if (c && c.seenBeginner) beginnerOnly++;
    }
    return { touched: touched, beginnerOnly: beginnerOnly, total: charsetList.length };
  }
  function recentHistory(n) {
    return data.history.slice(0, n || 10);
  }

  // ------------------------------------------------------------ 导出 / 导入
  function exportJSON() {
    return JSON.stringify(data, null, 2);
  }
  function importJSON(text) {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== "object" || !obj.chars) throw new Error("不是本软件的备份文件（缺 chars 字段）");
    data = Object.assign(emptyData(), obj);
    data.stories = obj.stories || {};
    data.chars = obj.chars || {};
    data.words = obj.words || {};
    data.history = Array.isArray(obj.history) ? obj.history : [];
    data.totals = Object.assign(emptyData().totals, obj.totals || {});
    save();
    return data;
  }
  function reset() {
    data = emptyData();
    save();
    return data;
  }
  // 只清错字本（char/word 的 wrong 计数），保留 seen / 断点 / 历史
  function clearWrong() {
    for (const ch in data.chars) data.chars[ch].wrong = 0;
    for (const w in data.words) data.words[w].wrong = 0;
    data.totals.wrong = 0;
    save();
  }

  root.WubiStats = {
    KEY: KEY,
    load: load,
    save: save,
    data: function () {
      return data;
    },
    storageAvailable: function () {
      return available && !memoryOnly;
    },
    setStoryCursor: setStoryCursor,
    storyCursor: storyCursor,
    recordCommit: recordCommit,
    recordHint: recordHint,
    getPref: getPref,
    setPref: setPref,
    addSession: addSession,
    charStats: charStats,
    charLevel: charLevel,
    wrongList: wrongList,
    wrongWords: wrongWords,
    coverage: coverage,
    recentHistory: recentHistory,
    exportJSON: exportJSON,
    importJSON: importJSON,
    reset: reset,
    clearWrong: clearWrong,
  };
})(typeof window !== "undefined" ? window : globalThis);
