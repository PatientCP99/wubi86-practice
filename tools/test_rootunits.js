// tools/test_rootunits.js —— 精确字根拆解数据的校验（node tools/test_rootunits.js）
//
// 这份数据是「可选增强层」，由 tools/fetch_rootunits.py 生成到 data/local/（不入库）。
// 所以本测试在**没有生成过数据时直接跳过并退出 0**，不阻塞干净克隆上的测试套件。
//
// 校验的都是会"教错人"的东西：
//   * units 与 kinds 必须与码长逐位对齐（差一位，后面全错）
//   * 识别码位必须真的等于「末笔 + 结构」按 5×5 区位推出来的字母
//   * 字根位字形不得跨键（一个字形只属于一个键）
//   * 识别码字形必须恰好 15 个（5 末笔 × 3 结构），且与字根字形不重叠
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FILE = path.join(__dirname, "..", "data", "local", "rootunits.js");
const FONT = path.join(__dirname, "..", "data", "local", "zigen.ttf");

if (!fs.existsSync(FILE)) {
  console.log("\n[跳过] data/local/rootunits.js 不存在 —— 精确字根拆解层还没生成。");
  console.log("       生成方式: python tools/fetch_rootunits.py\n");
  process.exit(0);
}

let failed = 0;
function ok(cond, label, detail) {
  if (cond) console.log("  PASS  " + label);
  else {
    failed++;
    console.log("  FAIL  " + label + (detail !== undefined ? "  -> " + detail : ""));
  }
}
function eq(a, b, label) {
  ok(a === b, label, "期望 " + b + "，实得 " + a);
}
function section(t) {
  console.log("\n" + t);
}

// ---------------------------------------------------------------- 加载
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox);
const RU = sandbox.window.WUBI86_ROOTUNITS;
const D = (function () {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "data", "wubi86.js"), "utf8"), sandbox);
  return sandbox.window.WUBI86;
})();

const CODE_RE = /^[a-y][a-z]{0,3}$/;
// 五笔 5×5 区位键盘（不是字母表顺序）
const ZONE = ["gfdsa", "hjklm", "trewq", "yuiop", "nbvcx"];
const STROKE_ZONE = { 横: 1, 竖: 2, 丿: 3, 撇: 3, 捺: 4, 丶: 4, 折: 5, 乛: 5 };
const SHAPE_POS = { 左右: 1, 上下: 2, 杂合: 3 };
const idcode = (s, sh) => ZONE[STROKE_ZONE[s] - 1][SHAPE_POS[sh] - 1];

section("[1] 元信息与文件");
ok(!!RU, "window.WUBI86_ROOTUNITS 存在");
ok(!!RU.meta && RU.meta.rows > 0, "meta.rows 有值", RU.meta && RU.meta.rows);
ok(fs.existsSync(FONT), "字根字体 data/local/zigen.ttf 存在（PUA 字形全靠它渲染）");
ok(/^[0-9a-f]{64}$/.test(RU.meta.tsvSha256 || ""), "meta 里记录了源 TSV 的 sha256");
ok((RU.meta.source || "").indexOf("search-wubi") >= 0, "meta 里记录了数据来源");
console.log("        rows=" + RU.meta.rows + "  charsetCovered=" + RU.meta.charsetCovered +
  "  built=" + RU.meta.built);

const rows = RU.rows;
const chars = Object.keys(rows);
eq(chars.length, RU.meta.rows, "rows 条数与 meta.rows 一致");

section("[2] 逐位对齐（差一位后面全错）");
let bad = [];
for (const ch of chars) {
  const [code, units, kinds] = rows[ch];
  const cu = Array.from(units);
  const ck = Array.from(kinds);
  if (!CODE_RE.test(code) || cu.length !== code.length || ck.length !== code.length) {
    bad.push(ch + "(" + code + "/" + cu.length + "/" + ck.length + ")");
  }
}
ok(bad.length === 0, "每个字的 units、kinds 都与码长逐位对齐", bad.slice(0, 8).join(" "));

section("[3] 位类别");
const KINDS = new Set(["r", "i", "s", "p"]);
let badKind = 0;
let idPosNotLast = 0;
for (const ch of chars) {
  const [code, , kinds] = rows[ch];
  const ck = Array.from(kinds);
  for (let i = 0; i < ck.length; i++) {
    if (!KINDS.has(ck[i])) badKind++;
    if (ck[i] === "i" && i !== ck.length - 1) idPosNotLast++;
  }
}
eq(badKind, 0, "位类别只有 r/i/s/p 四种");
eq(idPosNotLast, 0, "识别码位只出现在末位");

section("[4] 识别码位必须等于「末笔 + 结构」推出的字母");
let idOk = 0;
let idBad = [];
let glyphs = {};    // 字根位字形 -> 键
let idGlyphs = {};  // 识别码位字形 -> 次数
let cross = [];
for (const ch of chars) {
  const [code, units, kinds, note] = rows[ch];
  const cu = Array.from(units);
  const ck = Array.from(kinds);
  for (let i = 0; i < code.length; i++) {
    if (ck[i] === "i") {
      const m = /末笔(.)·(..)型/.exec(note || "");
      if (!m) {
        idBad.push(ch + " 缺识别码说明");
        continue;
      }
      const want = idcode(m[1], m[2]);
      if (want === code[i]) idOk++;
      else idBad.push(ch + " " + code[i] + "!=" + want);
      idGlyphs[cu[i]] = (idGlyphs[cu[i]] || 0) + 1;
    } else if (ck[i] === "r") {
      const prev = glyphs[cu[i]];
      if (prev !== undefined && prev !== code[i]) cross.push(ch + ":" + code[i] + " vs " + prev);
      glyphs[cu[i]] = code[i];
    }
  }
}
ok(idOk > 3000, "识别码位样本量足够", idOk);
ok(idBad.length === 0, "全部识别码位都等于「末笔+结构」推出的字母（5×5 区位）", idBad.slice(0, 6).join(" | "));
ok(cross.length === 0, "字根位字形不跨键（每个字形只属于一个键）", cross.slice(0, 6).join(" | "));
eq(Object.keys(idGlyphs).length, 15, "识别码位字形恰好 15 个 = 5 末笔 × 3 结构");
eq(Object.keys(RU.stroke).length, 5, "五种单笔画字形齐备");
const overlap = Object.keys(idGlyphs).filter((g) => glyphs[g] !== undefined);
eq(overlap.length, 0, "识别码字形与字根字形不重叠");
console.log("        字根位字形 " + Object.keys(glyphs).length + " 个，识别码位字形 " +
  Object.keys(idGlyphs).length + " 个，识别码位 " + idOk + " 个");

section("[5] 练习字集覆盖");
const charset = Array.from(D.charset);
const missing = charset.filter((c) => !rows[c]);
console.log("        覆盖 " + (charset.length - missing.length) + " / " + charset.length +
  "，缺: " + (missing.join("") || "无"));
ok(missing.length <= 5, "缺口不超过 5 个字（上游对个别扩展B 字没有拆解数据）", missing.join(""));
ok(RU.meta.charsetCovered === charset.length - missing.length, "meta.charsetCovered 与实测一致");

section("[6] 抽查几个已知字");
function kindsOf(ch) {
  return rows[ch] ? rows[ch][2] : null;
}
eq(kindsOf("想"), "rrri", "想=shnu：前三位字根，末位识别码");
eq(kindsOf("十"), "rss", "十=fgh：字根 + 两个笔画码");
eq(kindsOf("一"), "rspp", "一=ggll：字根 + 笔画码 + 两个补齐位");
eq(kindsOf("都"), "rrrr", "都=ftjb：四个都是字根");
eq(kindsOf("镕"), "rrrr", "镕=qpwk：四个字根（第一位已按勘误修正）");
ok(!rows["𬉼"], "上游无拆解数据的字（𬉼）不在表里 —— 应用层会对它退回默认层");

console.log("\n" + (failed ? "FAILED: " + failed + " 项" : "ALL PASS") + "\n");
process.exit(failed ? 1 : 0);
