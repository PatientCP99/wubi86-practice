// tools/test_stories.js —— 内置故事校验（node tools/test_stories.js）
//
// 硬要求: 故事里每个汉字都必须
//   (1) 在 6500 练习字集内   —— 否则是超纲字
//   (2) 在码表里有编码        —— 否则用户打不出来（严格模式下就是死路）
// 同时报出每篇的字频分位（难度）与词组码覆盖率（能不能用词组整打）。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { window: {} };
vm.createContext(sandbox);
for (const f of ["data/wubi86.js", "data/stories.js", "src/wubi-core.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), sandbox);
}
const D = sandbox.window.WUBI86;
const STORIES = sandbox.window.WUBI86_STORIES;
const Core = sandbox.window.WubiCore;
const idx = Core.build(D);

let failed = 0;
function ok(cond, label, detail) {
  if (cond) console.log("  PASS  " + label);
  else {
    failed++;
    console.log("  FAIL  " + label + (detail !== undefined ? "  -> " + detail : ""));
  }
}

// 字频序: 按码表权重降序排名（越小越常用）
const weight = new Map();
for (const row of D.single) {
  const p = row.split(",");
  const w = Number(p[2]);
  if (Array.from(p[0]).length === 1 && (!weight.has(p[0]) || weight.get(p[0]) < w)) weight.set(p[0], w);
}
const freqRank = new Map();
Array.from(idx.charsetList)
  .sort((a, b) => (weight.get(b) || 0) - (weight.get(a) || 0) || (a < b ? -1 : 1))
  .forEach((ch, i) => freqRank.set(ch, i + 1));

const SAFE_PUNCT = new Set(Array.from("，。、；：？！“”‘’（）《》〈〉—…·【】「」 \n\r\t"));

console.log("\n[1] 结构");
ok(Array.isArray(STORIES) && STORIES.length >= 3 && STORIES.length <= 5, "内置故事 3–5 篇", STORIES && STORIES.length);
for (const s of STORIES) {
  ok(!!(s.id && s.title && Array.isArray(s.paragraphs) && s.paragraphs.length), `《${s.title}》字段完整`);
}
ok(new Set(STORIES.map((s) => s.id)).size === STORIES.length, "故事 id 不重复");

console.log("\n[2] 字集与编码（硬要求）");
let allOut = [];
let allNoCode = [];
let allBadPunct = [];
for (const s of STORIES) {
  const text = s.paragraphs.join("\n");
  const chars = Array.from(text);
  const han = chars.filter((c) => Core.isHanzi(c));
  const out = Array.from(new Set(han.filter((c) => !idx.charset.has(c))));
  const nocode = Array.from(new Set(han.filter((c) => !idx.shortestCode(c))));
  const badPunct = Array.from(new Set(chars.filter((c) => !Core.isHanzi(c) && !SAFE_PUNCT.has(c))));
  if (out.length) allOut = allOut.concat(out.map((c) => s.title + ":" + c));
  if (nocode.length) allNoCode = allNoCode.concat(nocode.map((c) => s.title + ":" + c));
  if (badPunct.length) allBadPunct = allBadPunct.concat(badPunct.map((c) => s.title + ":" + c));
  const ranks = han.map((c) => freqRank.get(c) || 99999).sort((a, b) => a - b);
  const pct = (q) => ranks[Math.min(ranks.length - 1, Math.floor(ranks.length * q))];
  console.log(
    `        《${s.title}》 汉字 ${han.length} 字种 ${new Set(han).size}` +
      ` 字频分位 p50=${pct(0.5)} p90=${pct(0.9)} 最生僻序=${ranks[ranks.length - 1]}`
  );
}
ok(allOut.length === 0, "全部故事的汉字 100% 落在 6500 字集内", allOut.slice(0, 20).join(" "));
ok(allNoCode.length === 0, "全部故事的汉字都有五笔码（严格模式下不会出现死路）", allNoCode.slice(0, 20).join(" "));
ok(allBadPunct.length === 0, "标点只用安全集", allBadPunct.join(" "));

console.log("\n[3] 词组码覆盖率（决定能不能用词组整打提速）");
for (const s of STORIES) {
  const text = s.paragraphs.join("");
  const sess = Core.createSession(idx, { text: text });
  const plan = sess.plan.map((p) => p.ch);
  let covered = 0;
  let i = 0;
  while (i < plan.length) {
    const w = idx.longestWord(
      plan.map((ch) => ({ ch: ch })),
      i,
      ""
    );
    if (w && w.len >= 2) {
      covered += w.len;
      i += w.len;
    } else i++;
  }
  const pct = ((covered / plan.length) * 100).toFixed(1);
  console.log(`        《${s.title}》 可用词组整打的字数占比 ${pct}%（${covered}/${plan.length}）`);
}
ok(true, "词组码覆盖率已报出（供人工判断故事的可提速空间）");

console.log("\n[4] 篇幅");
for (const s of STORIES) {
  const n = Array.from(s.paragraphs.join("")).filter((c) => Core.isHanzi(c)).length;
  ok(n >= 150 && n <= 700, `《${s.title}》 篇幅合理（${n} 个汉字）`, String(n));
}

console.log("\n" + (failed ? "FAILED: " + failed + " 项" : "ALL PASS") + "\n");
process.exit(failed ? 1 : 0);
