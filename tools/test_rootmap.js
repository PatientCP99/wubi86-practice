// tools/test_rootmap.js —— 用码表反验字根表（node tools/test_rootmap.js）
//
// 原理: 一个"独立成字的字根"（如 王 土 犬 古 上 虫 田 山 …）在五笔里必然属于它所在的那个键,
//       因为字根字的第一码就是它自己所在的键。所以:
//           若 roots 里的某个字根能在码表中查到单字编码, 该编码的首字母必须等于本行 key。
//       这条规则能自动抓出字根放错键、或字根写错字两类错误。
//
//       只能作偏旁的字根（亻 扌 氵 艹 匚 …）无法用此法验证, 会被列在"待人工核对"里。
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { window: {} };
vm.createContext(sandbox);
for (const f of ["wubi86.js", "rootmap.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "data", f), "utf8"), sandbox);
}
const D = sandbox.window.WUBI86;
const R = sandbox.window.WUBI86_ROOTS;

let failed = 0;
function ok(cond, label, detail) {
  if (cond) console.log("  PASS  " + label);
  else {
    failed++;
    console.log("  FAIL  " + label + (detail ? "  -> " + detail : ""));
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, "期望 " + JSON.stringify(expected) + "，实得 " + JSON.stringify(actual));
}

// 单字 -> 全部编码
const charCodes = new Map();
for (const row of D.single) {
  const p = row.split(",");
  if (!charCodes.has(p[0])) charCodes.set(p[0], new Set());
  charCodes.get(p[0]).add(p[1]);
}

console.log("\n[1] 结构");
ok(Array.isArray(R.rows) && R.rows.length === 25, "字根表 25 行（不含 z 万能键）", String(R.rows && R.rows.length));
const keys = R.rows.map((r) => r.key);
ok(new Set(keys).size === 25, "25 个键无重复");
ok(
  "abcdefghijklmnopqrstuvwxy".split("").every((k) => keys.indexOf(k) >= 0),
  "覆盖 a-y 全部 25 个字母"
);
const zoneKeys = R.zones.reduce((a, z) => a.concat(z.keys), []);
ok(zoneKeys.length === 25 && zoneKeys.every((k) => keys.indexOf(k) >= 0), "zones 分区覆盖 25 键");
ok(
  R.rows.every((r) => r.mnemonic && r.mnemonic.length > 0),
  "每键都有助记口诀"
);
ok(
  R.rows.every((r) => Array.isArray(r.roots) && r.roots.length > 0),
  "每键都有字根"
);

console.log("\n[2] 键名字必须在自己键的字根里（25 项硬校验）");
for (const r of R.rows) {
  const name = r.name;
  const has = r.roots.indexOf(name) >= 0;
  const codes = charCodes.get(name);
  const nameKey = codes ? Array.from(codes).map((c) => c[0]).sort()[0] : null;
  ok(has && nameKey === r.key, `键名字 ${name} 在 ${r.key.toUpperCase()} 键`, has ? `码表首字母是 ${nameKey}, 期望 ${r.key}` : "字根表里没有这个键名字");
}

console.log("\n[3] 字根字首码反验（能查到的字根，首码必须 == 本键）");
const bad = [];
const unknown = [];
const componentChecks = [];
for (const r of R.rows) {
  const comp = new Set(r.componentRoots || []);
  for (const g of r.roots) {
    const cps = Array.from(g);
    if (cps.length !== 1) continue;
    const codes = charCodes.get(g);
    if (!codes) {
      unknown.push({ key: r.key, glyph: g });
      continue;
    }
    const firsts = new Set(Array.from(codes, (c) => c[0]));
    if (firsts.has(r.key)) {
      if (comp.has(g)) componentChecks.push(`${r.key.toUpperCase()}:${g} 标为偏旁但首码其实等于本键（可从 componentRoots 移除）`);
      continue;
    }
    if (comp.has(g)) {
      // 数据里显式声明的"偏旁形态"例外: 作为偏旁归本键, 独立成字时按自己的拆分取码
      componentChecks.push(`${r.key.toUpperCase()}:${g} = 偏旁例外（独立成字编码 ${Array.from(codes).sort().join("/")}）`);
      continue;
    }
    bad.push({ key: r.key, glyph: g, codes: Array.from(codes).sort().join("/") });
  }
}
if (bad.length) {
  console.log("  不一致明细:");
  for (const b of bad) console.log(`    ${b.key.toUpperCase()} 键的字根 ${b.glyph} -> 码表编码 ${b.codes}（首字母不是 ${b.key}）`);
}
ok(bad.length === 0, "所有可查字根的首码都等于本键（偏旁例外已在数据里显式声明）", bad.length + " 项不一致");

console.log("\n[3b] 数据里显式声明的偏旁例外");
for (const l of componentChecks) console.log("  " + l);
ok(
  R.rows.every((r) => (r.componentRoots || []).every((g) => r.roots.indexOf(g) >= 0)),
  "componentRoots 里的每一项都确实在该键 roots 里"
);

console.log("\n[4] 只能作偏旁的字根（码表里查不到单字编码，无法自动验证）");
console.log("  " + unknown.map((u) => u.key.toUpperCase() + ":" + u.glyph).join("  "));
console.log("  共 " + unknown.length + " 个 —— 这些只能靠人眼对着字根表核。");

console.log("\n" + (failed ? "FAILED: " + failed + " 项" : "ALL PASS") + "\n");
process.exit(failed ? 1 : 0);
