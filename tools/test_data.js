// tools/test_data.js —— 数据自检（node tools/test_data.js）
//
// 校验 data/wubi86.js 的不变式，以及输入状态机依赖的编码形态假设。
// 里面的数字都是"回归钉子": 换数据源或改口径时, 这里会先炸, 而不是等到用户打字才发现。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FILE = path.join(__dirname, "..", "data", "wubi86.js");

let failed = 0;
function ok(cond, label, detail) {
  if (cond) console.log("  PASS  " + label);
  else {
    failed++;
    console.log("  FAIL  " + label + (detail ? "  -> " + detail : ""));
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, "期望 " + expected + ", 实得 " + actual);
}
function info(label, value) {
  console.log("  ..    " + label + ": " + value);
}

// ---------------------------------------------------------------- 加载
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox);
const D = sandbox.window.WUBI86;
if (!D) {
  console.error("FATAL: window.WUBI86 未定义");
  process.exit(1);
}

const CODE_RE = /^[a-y][a-z]{0,3}$/;
const HAN_RE = /^[\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{3ffff}]+$/u;

function parseRows(rows, kind) {
  return rows.map(function (s, i) {
    const p = s.split(",");
    if (p.length !== 3) throw new Error(kind + " 第 " + i + " 行字段数 " + p.length + ": " + s);
    return { text: p[0], code: p[1], weight: Number(p[2]) };
  });
}

// ---------------------------------------------------------------- 1. 字集
console.log("\n[1] 练习字集");
const charset = Array.from(D.charset); // 必须 Array.from: 含扩展B 代理对
const csSet = new Set(charset);
info("charset 码点数", charset.length);
info("levels 一级/二级", D.levels.join(" / "));
eq(charset.length, 6500, "字集 = 6500（一级 3500 + 二级 3000）");
eq(csSet.size, charset.length, "字集无重复");
eq(D.meta.charsetSize, charset.length, "meta.charsetSize 与实际一致");
eq(D.levels.length, 2, "levels 只有两个层级（三级字表已弃用）");
eq(D.levels[0] + D.levels[1], charset.length, "levels 之和 == 字集大小");
ok(charset.some((c) => c.length === 2), "字集含代理对字符（扩展B）-> 前端必须按码点迭代");

// ---------------------------------------------------------------- 2. 行格式
console.log("\n[2] 行格式");
let single, phrase;
try {
  single = parseRows(D.single, "single");
  phrase = parseRows(D.phrase, "phrase");
} catch (e) {
  console.error("FATAL: " + e.message);
  process.exit(1);
}
info("single 码行 / 覆盖字数", single.length + " / " + new Set(single.map((r) => r.text)).size);
info("phrase 行数", phrase.length);
eq(single.length, D.meta.single, "meta.single 与实际一致");
eq(phrase.length, D.meta.phrase, "meta.phrase 与实际一致");
ok(single.every((r) => CODE_RE.test(r.code)), "single 码全部合法（a-y 开头，1-4 位，不含 z 万能键）");
ok(phrase.every((r) => CODE_RE.test(r.code)), "phrase 码全部合法");
ok(single.every((r) => HAN_RE.test(r.text) && Array.from(r.text).length === 1), "single 每条恰为 1 个汉字");
ok(phrase.every((r) => HAN_RE.test(r.text) && Array.from(r.text).length > 1), "phrase 每条 >= 2 个汉字");
ok(single.every((r) => Number.isFinite(r.weight)), "single 权重可解析");
ok(phrase.every((r) => r.code.length === 4), "词组码一律 4 位");

// ---------------------------------------------------------------- 3. 索引
console.log("\n[3] 索引与编码形态");
const byCode = new Map();
for (const r of single.concat(phrase)) {
  if (!byCode.has(r.code)) byCode.set(r.code, []);
  byCode.get(r.code).push(r);
}
const charCodes = new Map();
for (const r of single) {
  if (!charCodes.has(r.text)) charCodes.set(r.text, new Set());
  charCodes.get(r.text).add(r.code);
}
const maxCodeLen = Math.max(...Array.from(byCode.keys(), (c) => c.length));
eq(maxCodeLen, 4, "最长码长 = 4（=> 任何 4 码都是叶子码）");
const noCode = charset.filter((c) => !charCodes.has(c));
eq(noCode.length, 0, "字集内每个字都有码");

const prefixes = new Set();
for (const c of byCode.keys()) for (let i = 1; i < c.length; i++) prefixes.add(c.slice(0, i));
const isLeaf = (c) => !prefixes.has(c);

// ---------------------------------------------------------------- 4. 自动上屏规则
console.log("\n[4] 自动上屏规则（缓冲码成为叶子码且首选唯一 -> 立即上屏）");
ok(!isLeaf("fgh") && byCode.has("fghy"), "十=fgh 不是叶子（有 fghy）-> 必须按空格");
ok(!isLeaf("tyi") && byCode.has("tyiu"), "入=tyi 不是叶子（有 tyiu=汆）-> 必须按空格");
ok(isLeaf("hci") && byCode.has("hci"), "皮=hci 是叶子 -> 打满 3 码自动上屏");
ok(isLeaf("blh"), "阵=blh 是叶子");
ok(isLeaf("pxb"), "它=pxb 是叶子");
const leaf3 = Array.from(byCode.keys()).filter((c) => c.length === 3 && isLeaf(c));
eq(leaf3.length, 85, "3 码叶子 = 85（回归钉子）");
ok(byCode.has("aaaa"), "aaaa 同时是 工 与 恭恭敬敬 的码（单字/词组撞码可复现）");

// ---------------------------------------------------------------- 5. 候选排序
console.log("\n[5] 候选排序：charset 内的字优先，其次按权重降序");
// 运行时排序规则（与 src 里的实现必须一致）
const inCs = (t) => csSet.has(t);
function candidates(code) {
  const list = byCode.get(code) || [];
  return list
    .slice()
    .sort((a, b) => (inCs(b.text) ? 1 : 0) - (inCs(a.text) ? 1 : 0) || b.weight - a.weight || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}
eq(D.meta.biasFixed, 216, "charset 偏向纠正的码 = 216（回归钉子）");
eq(candidates("alpu")[0].text, "莲", "`alpu` 首选 莲 而不是繁体 蓮（网页权重把 蓮 排前面，靠偏向纠正）");
eq(candidates("ifcy")[0].text, "法", "`ifcy` 首选 法（不是 沄）");
eq(candidates("fghy")[0].text, "雨", "`fghy` 首选 雨（不是 寸）");
eq(candidates("lhng")[0].text, "四", "`lhng` 首选 四（不是 皿）");
eq(candidates("aaaa")[0].text, "工", "`aaaa` 首选 工（不是 恭恭敬敬）");

// 数据文件内每个数组按 (code, -weight) 排序（跨数组由运行时归并）
function sortViolations(rows) {
  let bad = 0,
    prevCode = null,
    prevW = null;
  for (const r of rows) {
    if (r.code === prevCode && prevW !== null && r.weight > prevW) bad++;
    prevCode = r.code;
    prevW = r.weight;
  }
  return bad;
}
eq(sortViolations(single), 0, "single 数组内按 (code, -weight) 排序");
eq(sortViolations(phrase), 0, "phrase 数组内按 (code, -weight) 排序");

// ---------------------------------------------------------------- 6. 编码形态
console.log("\n[6] 编码形态（回归钉子）");
const shortest = new Map();
for (const [ch, codes] of charCodes) {
  let best = null;
  for (const c of codes) if (best === null || c.length < best.length || (c.length === best.length && c < best)) best = c;
  shortest.set(ch, best);
}
const hist = {};
for (const c of charset) {
  const L = shortest.get(c).length;
  hist[L] = (hist[L] || 0) + 1;
}
info("最短合法码长度分布", Object.keys(hist).sort().map((k) => k + "码:" + hist[k]).join(", "));
eq(hist[1], 25, "一级简码 = 25 字");
eq(hist[2], 602, "最短码 2 位的字 = 602");
eq(hist[3], 3576, "最短码 3 位的字 = 3576");
eq(hist[4], 2297, "最短码 4 位的字 = 2297");
eq(shortest.get("工"), "a", "工 的最短码是 a");

const no4 = charset.filter((c) => !Array.from(charCodes.get(c)).some((x) => x.length === 4));
eq(no4.length, 788, "无 4 码全码的字 = 788（十=fgh 丁=sgh 八=wty）");

const c2t = new Map();
for (const r of single) {
  if (!c2t.has(r.code)) c2t.set(r.code, new Set());
  c2t.get(r.code).add(r.text);
}
let dup4Common = 0,
  dup4Any = 0;
for (const [code, set] of c2t) {
  if (code.length !== 4 || set.size < 2) continue;
  const common = Array.from(set).filter(inCs).length;
  if (common > 1) dup4Common++;
  if (common >= 1) dup4Any++;
}
eq(dup4Common, 185, "必须按数字选字的 4 码 = 185（同一码里有 ≥2 个字集内的字）");
eq(dup4Any, 2897, "4 码多候选且含字集字 = 2897（空格仍可上屏，靠 charset 偏向）");

// ---------------------------------------------------------------- 7. 词表
console.log("\n[7] 词语模式词表");
ok(Array.isArray(D.wordStop) && D.wordStop.length > 0, "wordStop 停用词表非空", String(D.wordStop.length));
ok(D.wordStop.indexOf("网站") >= 0 && D.wordStop.indexOf("首页") >= 0, "停用词表含站点导航词");
ok(D.wordStop.indexOf("我们") < 0, "停用词表不含 我们（we 是正当常用词 trwu）");
ok(Array.isArray(D.wordLen) && D.wordLen[0] === 2 && D.wordLen[1] === 4, "词长限 2-4");
const stop = new Set(D.wordStop);
const usable = phrase.filter(
  (r) => Array.from(r.text).length >= D.wordLen[0] && Array.from(r.text).length <= D.wordLen[1] && !stop.has(r.text)
);
info("可用词条（词长 2-4，去停用词）", usable.length);
ok(usable.length > 50000, "可用词条 > 50000", String(usable.length));

console.log("\n" + (failed ? "FAILED: " + failed + " 项" : "ALL PASS") + "\n");
process.exit(failed ? 1 : 0);
