// src/wubi-core.js —— 五笔86 练习器的纯逻辑层（索引 + 输入状态机）
//
// 设计约束:
//   * 无框架、无构建、file:// 双击可用  -> 经典 <script>, 挂在 window.WubiCore 上
//   * 不碰 DOM: 浏览器和 node 都能跑, 单测直接 node tools/test_logic.js
//   * 扩展B 汉字是代理对 -> 文本一律用 Array.from() 迭代, 禁止 str.length / str[i]
//
// 已锁定的输入语义（详见 tools/report.md 与设计共识）:
//   * 候选集 = 精确匹配（真五笔行为）。打 fgh 不会冒出 fghy 的候选。
//   * 排序   = (是否在练习字集内, 权重降序, 字序) —— 纠正网页语料把繁体/异体排前面的问题
//   * 合法前缀才入缓冲, 否则拒收 + 计错
//   * 自动上屏 = 缓冲码是叶子码 且 首选唯一
//   * 空格选首个, 1-9 选第 N 个, -/= 翻页（每页 9）
//   * 严格模式: 上屏内容必须等于目标切片, 否则判错、光标不动、缓冲清空（要重打）
//   * 退格: 缓冲非空则删一码; 缓冲空则撤销上一个正确上屏
"use strict";
(function (root) {
  const PAGE_SIZE = 9;
  const PUNCT = /[^\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{3ffff}]/u;

  function isHanzi(ch) {
    return !PUNCT.test(ch);
  }

  // ------------------------------------------------------------ 索引
  function build(data) {
    const D = data || (root.WUBI86 || null);
    if (!D) throw new Error("WubiCore.build: 需要 window.WUBI86（data/wubi86.js）");

    const charsetList = Array.from(D.charset);
    const charset = new Set(charsetList);

    // code -> 候选（已按 字集优先 / 权重降序 / 字序 排好）
    const byCode = new Map();
    const add = (text, code, weight, kind) => {
      let list = byCode.get(code);
      if (!list) byCode.set(code, (list = []));
      list.push({ text: text, code: code, weight: weight, kind: kind, inCharset: charset.has(text) });
    };
    for (const row of D.single) {
      const p = row.split(",");
      add(p[0], p[1], Number(p[2]), "char");
    }
    for (const row of D.phrase) {
      const p = row.split(",");
      add(p[0], p[1], Number(p[2]), "word");
    }
    for (const list of byCode.values()) {
      list.sort(
        (a, b) =>
          (b.inCharset ? 1 : 0) - (a.inCharset ? 1 : 0) ||
          b.weight - a.weight ||
          (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)
      );
    }

    // 所有码 + 所有真前缀（判"这个按键是否合法"）
    const allCodes = new Set(byCode.keys());
    const prefixes = new Set();
    for (const c of allCodes) for (let i = 1; i < c.length; i++) prefixes.add(c.slice(0, i));
    // 叶子码: 没有任何更长码以它为前缀 -> 自动上屏的触发点
    const leaf = new Set();
    for (const c of allCodes) if (!prefixes.has(c)) leaf.add(c);

    // 单字 -> 合法码（按 长度升序, 字典序）用于"最短合法码"提示
    const charCodes = new Map();
    for (const row of D.single) {
      const p = row.split(",");
      if (!charCodes.has(p[0])) charCodes.set(p[0], new Set());
      charCodes.get(p[0]).add(p[1]);
    }
    for (const [ch, set] of charCodes) {
      charCodes.set(ch, Array.from(set).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)));
    }

    // 词表按首字建索引（用于"从光标起最长匹配"的词码提示），长的排前面
    const wordIndex = new Map();
    for (const row of D.phrase) {
      const p = row.split(",");
      const first = Array.from(p[0])[0];
      if (!wordIndex.has(first)) wordIndex.set(first, []);
      wordIndex.get(first).push({ text: p[0], code: p[1], len: Array.from(p[0]).length, weight: Number(p[2]) });
    }
    for (const list of wordIndex.values()) list.sort((a, b) => b.len - a.len || b.weight - a.weight);

    return {
      raw: D,
      charset: charset,
      charsetList: charsetList,
      levels: D.levels,
      wordStop: new Set(D.wordStop || []),
      wordLen: D.wordLen || [2, 4],
      byCode: byCode,
      allCodes: allCodes,
      prefixes: prefixes,
      leaf: leaf,
      charCodes: charCodes,
      wordIndex: wordIndex,
      pageSize: PAGE_SIZE,

      candidates: function (code) {
        return byCode.get(code) || [];
      },
      isLegal: function (code) {
        return allCodes.has(code) || prefixes.has(code);
      },
      isLeaf: function (code) {
        return leaf.has(code);
      },
      isWordCode: function (code) {
        const l = byCode.get(code);
        if (!l) return false;
        for (const c of l) if (c.kind === "word") return true;
        return false;
      },
      // 目标字的最短合法码（提示用）
      shortestCode: function (ch) {
        const list = charCodes.get(ch);
        return list && list.length ? list[0] : null;
      },
      // 从 plan 的 cursor 起, 在词表里找最长匹配的词（可要求其码以 buffer 为前缀）
      longestWord: function (plan, cursor, buffer) {
        const chars = plan.map((p) => p.ch);
        if (cursor >= chars.length) return null;
        const list = wordIndex.get(chars[cursor]);
        if (!list) return null;
        outer: for (const w of list) {
          const cps = Array.from(w.text);
          if (cursor + cps.length > chars.length) continue;
          for (let i = 0; i < cps.length; i++) if (chars[cursor + i] !== cps[i]) continue outer;
          if (buffer && w.code.indexOf(buffer) !== 0) continue;
          return w;
        }
        return null;
      },
    };
  }

  // ------------------------------------------------------------ 会话（状态机）
  // opts: { text, skipPunctuation=true }
  //
  // 注意: 引擎只有"严格"一种判定 —— 上屏内容 !== 目标切片 时判错、光标不动、缓冲清空。
  //       要不要"标红放行"（流畅模式）由上层根据事件里的 correct 决定, 引擎不替它做。
  function createSession(index, opts) {
    opts = opts || {};
    const display = Array.from(opts.text || "");
    const skipPunct = opts.skipPunctuation !== false;
    // plan = 需要打出来的字符序列; 标点按 skipPunct 决定是否跳过
    const plan = [];
    for (let i = 0; i < display.length; i++) {
      if (skipPunct && !isHanzi(display[i])) continue;
      plan.push({ ch: display[i], displayIndex: i });
    }

    const stats = {
      keystrokes: 0, // 被接受的字母
      rejects: 0, // 被拒收的字母（非法前缀）
      commits: 0, // 上屏次数
      correct: 0, // 正确上屏的字符数
      wrong: 0, // 判错次数
      autoCommits: 0,
      hintUses: 0,
      undos: 0,
      pages: 0,
      skips: 0,
    };

    const s = {
      index: index,
      display: display,
      plan: plan,
      cursor: 0,
      buffer: "",
      page: 0,
      candidates: [],
      stats: stats,
      history: [], // 正确上屏记录, 供退格撤销

      // 当前页的候选（带 1-9 编号）
      pageCandidates: function () {
        const list = s.candidates;
        const start = s.page * index.pageSize;
        return list.slice(start, start + index.pageSize);
      },
      pageCount: function () {
        return Math.max(1, Math.ceil(s.candidates.length / index.pageSize));
      },
      progress: function () {
        return { done: s.cursor, total: plan.length, ratio: plan.length ? s.cursor / plan.length : 1 };
      },
      isDone: function () {
        return s.cursor >= plan.length;
      },
      // UI 用: 每个显示字符的状态 done / current / pending / skipped
      displayStates: function () {
        const states = new Array(display.length);
        let planPtr = 0;
        for (let i = 0; i < display.length; i++) {
          if (skipPunct && !isHanzi(display[i])) {
            states[i] = "punct";
            continue;
          }
          states[i] = planPtr < s.cursor ? "done" : planPtr === s.cursor ? "current" : "pending";
          planPtr++;
        }
        return states;
      },

      // -------------------------------------------------- 提示（长按 Tab）
      hint: function () {
        if (s.isDone()) return null;
        stats.hintUses++;
        const target = plan[s.cursor].ch;
        const code = index.shortestCode(target);
        const buf = s.buffer;
        const startsWith = code ? code.indexOf(buf) === 0 : false;
        const word = index.longestWord(plan, s.cursor, buf);
        return {
          char: target,
          inCharset: index.charset.has(target),
          code: code, // 最短合法码
          typed: buf,
          missing: code ? (startsWith ? code.slice(buf.length) : code) : "",
          mismatch: !!buf && !startsWith, // 已打的字母跟目标的码对不上
          word: word ? { text: word.text, code: word.code, missing: word.code.slice(buf.length) } : null,
        };
      },

      // -------------------------------------------------- 按键
      // key: 单个字符（a-y 字母 / 空格 / 1-9 / - / = / Backspace / Escape）
      press: function (key) {
        const ev = dispatch(key);
        refresh();
        return ev;
      },

      // 供 UI 直接取用
      reset: function () {
        s.buffer = "";
        s.page = 0;
        refresh();
      },

      // 跳过当前目标（当前词或当前字），不计对错、不计入 correct
      skip: function () {
        if (s.isDone()) return { type: "noop" };
        s.buffer = "";
        s.page = 0;
        const w = index.longestWord(plan, s.cursor, "");
        const n = w ? w.len : 1;
        const ev = {
          type: "skip",
          text: plan.slice(s.cursor, s.cursor + n).map((p) => p.ch).join(""),
          cursorBefore: s.cursor,
          cursorAfter: s.cursor + n,
        };
        s.cursor += n;
        stats.skips++;
        refresh();
        return ev;
      },
    };

    function refresh() {
      s.candidates = s.buffer ? index.candidates(s.buffer) : [];
      const pc = s.pageCount();
      if (s.page >= pc) s.page = pc - 1;
      if (s.page < 0) s.page = 0;
    }

    // 上屏判定 + 记录
    function commit(cand, auto) {
      const want = plan.slice(s.cursor, s.cursor + Array.from(cand.text).length).map((p) => p.ch).join("");
      const ok = want === cand.text;
      stats.commits++;
      if (auto) stats.autoCommits++;
      const ev = {
        type: auto ? "autocommit" : "commit",
        text: cand.text,
        code: cand.code,
        correct: ok,
        expected: want,
        cursorBefore: s.cursor,
      };
      s.buffer = "";
      s.page = 0;
      if (ok) {
        const n = Array.from(cand.text).length;
        s.cursor += n;
        stats.correct += n;
        s.history.push({ text: cand.text, len: n });
        ev.cursorAfter = s.cursor;
        ev.done = s.isDone();
      } else {
        // 严格模式: 不上屏、光标不动、要重打
        stats.wrong++;
        ev.cursorAfter = s.cursor;
      }
      return ev;
    }

    function dispatch(key) {
      // 退格
      if (key === "Backspace") {
        if (s.buffer) {
          s.buffer = s.buffer.slice(0, -1);
          s.page = 0;
          return { type: "buffer", buffer: s.buffer };
        }
        const last = s.history.pop();
        if (last) {
          s.cursor -= last.len;
          stats.correct -= last.len;
          stats.undos++;
          return { type: "undo", text: last.text, cursorAfter: s.cursor };
        }
        return { type: "noop" };
      }
      // Esc
      if (key === "Escape") {
        if (!s.buffer) return { type: "noop" };
        s.buffer = "";
        s.page = 0;
        return { type: "clear" };
      }
      // 翻页
      if (key === "-" || key === "=") {
        if (!s.candidates.length) return { type: "noop" };
        const pc = s.pageCount();
        const next = key === "=" ? Math.min(s.page + 1, pc - 1) : Math.max(s.page - 1, 0);
        if (next === s.page) return { type: "noop" };
        s.page = next;
        stats.pages++;
        return { type: "page", page: s.page, pageCount: pc };
      }
      // 空格 = 选第一个
      if (key === " ") {
        const list = s.pageCandidates();
        if (!s.buffer || !list.length) return { type: "noop" };
        return commit(list[0], false);
      }
      // 数字 1-9
      if (key >= "1" && key <= "9") {
        if (!s.buffer) return { type: "noop" };
        const n = Number(key) - 1;
        const list = s.pageCandidates();
        if (n >= list.length) return { type: "noop" };
        return commit(list[n], false);
      }
      // 字母 a-z（z 是五笔万能键, 码表里没有任何码含 z, 所以带 z 的缓冲必然非法 -> 拒收）
      if (key.length === 1 && key >= "a" && key <= "z") {
        const next = s.buffer + key;
        if (!index.isLegal(next)) {
          stats.rejects++;
          return { type: "reject", key: key, buffer: s.buffer };
        }
        s.buffer = next;
        s.page = 0;
        stats.keystrokes++;
        // 自动上屏: 叶子码且首选唯一
        const list = index.candidates(next);
        if (index.isLeaf(next) && list.length === 1) {
          return commit(list[0], true);
        }
        return { type: "buffer", buffer: s.buffer };
      }
      return { type: "noop" };
    }

    refresh();
    return s;
  }

  root.WubiCore = {
    build: build,
    createSession: createSession,
    isHanzi: isHanzi,
    PAGE_SIZE: PAGE_SIZE,
  };
})(typeof window !== "undefined" ? window : globalThis);
