// tools/test_logic.js —— 输入状态机单测（node tools/test_logic.js）
//
// 覆盖: 精确匹配候选 / 合法前缀与拒收 / 自动上屏 / 空格与数字选字 / 翻页 /
//       严格模式判错回滚 / 退格撤销 / 词组整打 / 标点跳过 / 代理对 /
//       长按提示（缺码 + 词码 + 不匹配）/ 显示三态 / 统计计数
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { window: {} };
vm.createContext(sandbox);
for (const f of ["data/wubi86.js", "src/wubi-core.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), sandbox);
}
const Core = sandbox.window.WubiCore;
const idx = Core.build(sandbox.window.WUBI86);

let failed = 0;
function ok(cond, label, detail) {
  if (cond) console.log("  PASS  " + label);
  else {
    failed++;
    console.log("  FAIL  " + label + (detail !== undefined ? "  -> " + detail : ""));
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, "期望 " + JSON.stringify(expected) + ", 实得 " + JSON.stringify(actual));
}
function section(t) {
  console.log("\n" + t);
}
// 按顺序敲一串键, 返回最后一个事件
function type(session, keys) {
  let ev = null;
  for (const k of Array.from(keys)) ev = session.press(k);
  return ev;
}
const S = (text, opts) => Core.createSession(idx, Object.assign({ text: text }, opts || {}));

// ---------------------------------------------------------------- 1. 索引
section("[1] 索引");
ok(idx.byCode.size > 90000, "码表索引规模 > 9 万", String(idx.byCode.size));
eq(idx.pageSize, 9, "每页 9 个候选");
eq(idx.shortestCode("工"), "a", "工 的最短合法码 = a");
eq(idx.shortestCode("雨"), "fghy", "雨 的最短合法码 = fghy");
eq(idx.shortestCode("十"), "fgh", "十 的最短合法码 = fgh");

section("[2] 候选集 = 精确匹配（真五笔行为，不做前缀联想）");
eq(idx.candidates("fgh").map((c) => c.text).join("/"), "十", "`fgh` 只出 十，不出 雨/寸");
ok(idx.candidates("fghy").map((c) => c.text).indexOf("雨") >= 0, "`fghy` 出 雨");
eq(idx.candidates("a").map((c) => c.text).join("/"), "工", "`a` 只出 工");
ok(!idx.isLeaf("fgh"), "`fgh` 不是叶子（存在 fghy）-> 不自动上屏");
ok(idx.isLeaf("fghy"), "`fghy` 是叶子");
ok(idx.isLeaf("ftjb"), "`ftjb`（都）是叶子");
eq(idx.candidates("ftjb").length, 1, "`ftjb` 唯一候选 -> 会自动上屏");
eq(idx.candidates("fpgc").length, 44, "`fpgc` 有 44 个候选（翻页用）");
eq(idx.candidates("fpgc")[0].text, "彀", "`fpgc` 首选 彀（字集内优先）");

// ---------------------------------------------------------------- 3. 一级简码
section("[3] 一级简码 + 空格上屏");
{
  const s = S("工");
  eq(type(s, "a").type, "buffer", "敲 a -> 入缓冲（a 不是叶子，不自动上屏）");
  eq(s.buffer, "a", "缓冲 = a");
  const ev = s.press(" ");
  eq(ev.type, "commit", "空格 -> 上屏");
  eq(ev.correct, true, "上屏 工 判对");
  eq(s.cursor, 1, "光标前进 1");
  ok(s.isDone(), "整句打完");
}

section("[4] 自动上屏（叶子码 + 首选唯一）");
{
  const s = S("都");
  const ev = type(s, "ftjb");
  eq(ev.type, "autocommit", "敲满 ftjb -> 自动上屏");
  eq(ev.text, "都", "自动上屏的是 都");
  eq(ev.correct, true, "判对");
  eq(s.buffer, "", "自动上屏后缓冲清空");
  eq(s.stats.autoCommits, 1, "autoCommits 计数");
}
{
  const s = S("十");
  const ev = type(s, "fgh");
  eq(ev.type, "buffer", "fgh 不是叶子 -> 不自动上屏");
  eq(s.buffer, "fgh", "缓冲留在 fgh");
  eq(s.press(" ").correct, true, "再按空格才上屏 十（正确）");
}
{
  const s = S("雨");
  const ev = type(s, "fghy");
  eq(ev.type, "buffer", "fghy 是叶子但有 4 个候选 -> 不自动上屏");
  eq(s.candidates.length, 4, "候选 4 个");
  const ev2 = s.press(" ");
  eq(ev2.text, "雨", "空格上屏首选 雨");
  eq(ev2.correct, true, "判对");
}

// ---------------------------------------------------------------- 5. 拒收
section("[5] 非法前缀拒收 + 计错");
{
  const s = S("工");
  const ev = s.press("z");
  eq(ev.type, "reject", "z 单独按下 -> 拒收（没有任何码含 z）");
  eq(s.buffer, "", "拒收后缓冲不变");
  eq(s.stats.rejects, 1, "rejects 计数");
  s.press("a");
  const ev2 = s.press("z");
  eq(ev2.type, "reject", "a 之后按 z -> `az` 非法，拒收");
  eq(s.buffer, "a", "缓冲仍是 a（没被污染）");
  eq(s.stats.keystrokes, 1, "keystrokes 只算了被接受的 a");
}

// ---------------------------------------------------------------- 6. 严格模式判错
section("[6] 严格模式：上屏错了 -> 判错、光标不动、要重打");
{
  const s = S("雨");
  type(s, "fgh"); // 十 的码
  const ev = s.press(" ");
  eq(ev.text, "十", "上屏的是 十");
  eq(ev.correct, false, "目标是 雨 -> 判错");
  eq(ev.expected, "雨", "事件里带出期望值");
  eq(s.cursor, 0, "光标不动");
  eq(s.buffer, "", "缓冲被清空（要重打）");
  eq(s.stats.wrong, 1, "wrong 计数");
  eq(s.stats.correct, 0, "correct 计数没涨");
  // 重打正确
  type(s, "fghy");
  eq(s.press(" ").correct, true, "重打 fghy + 空格 -> 判对");
  eq(s.cursor, 1, "光标前进");
}
{
  const s = S("工");
  const ev = type(s, "trwu"); // 我们（词组，2 字）
  eq(ev.type, "autocommit", "trwu 是唯一候选叶子 -> 自动上屏");
  eq(ev.correct, false, "目标只有 工 一个字 -> 上屏 我们 判错");
  eq(s.stats.wrong, 1, "wrong 计数");
}

// ---------------------------------------------------------------- 7. 词组整打
section("[7] 词组码整打（混排）");
{
  const s = S("我们");
  const ev = type(s, "trwu");
  eq(ev.type, "autocommit", "trwu -> 自动上屏");
  eq(ev.text, "我们", "一次上屏两个字");
  eq(ev.correct, true, "判对");
  eq(s.cursor, 2, "光标前进 2");
  eq(s.stats.correct, 2, "correct 计 2 个字符");
}
{
  const s = S("我们的");
  s.press("t"); s.press("r"); s.press("w");
  eq(
    idx.candidates("trw").map((c) => c.text).indexOf("我们"),
    -1,
    "`trw` 不出 我们（精确匹配：词的码是 trwu，少一个字母就不算）"
  );
  const ev = s.press("u");
  eq(ev.text, "我们", "trwu 上屏我们");
  eq(ev.correct, true, "判对");
  eq(s.progress().done, 2, "进度 2");
  eq(s.progress().total, 3, "总长 3");
}

// ---------------------------------------------------------------- 8. 退格
section("[8] 退格：删码 / 撤销已上屏");
{
  const s = S("工");
  type(s, "aa");
  eq(s.buffer, "aa", "缓冲 aa");
  eq(s.press("Backspace").type, "buffer", "退格删一码");
  eq(s.buffer, "a", "缓冲回到 a");
  s.press("Backspace");
  eq(s.buffer, "", "再退格清空缓冲");
  eq(s.press("Backspace").type, "noop", "缓冲空且无历史 -> 什么都不做");
}
{
  const s = S("都天");
  type(s, "ftjb"); // 都 自动上屏
  eq(s.cursor, 1, "都 上屏（首字）");
  type(s, "gdi"); // 天
  eq(s.press(" ").correct, true, "天 上屏");
  eq(s.cursor, 2, "光标 2");
  const ev = s.press("Backspace");
  eq(ev.type, "undo", "缓冲空时退格 -> 撤销上一个上屏");
  eq(s.cursor, 1, "光标退回 1");
  eq(s.stats.undos, 1, "undos 计数");
  eq(s.stats.correct, 1, "correct 计数回落");
}
{
  const s = S("我们");
  type(s, "trwu"); // 一次上屏 2 字
  eq(s.cursor, 2, "词组上屏 2 字");
  s.press("Backspace");
  eq(s.cursor, 0, "撤销词组 -> 光标退回 2 个字");
}

// ---------------------------------------------------------------- 9. 翻页
section("[9] 翻页（每页 9，- / =）");
{
  const target = idx.candidates("fpgc")[0].text; // 彀
  const s = S(target);
  type(s, "fpgc");
  eq(s.candidates.length, 44, "候选 44 个");
  eq(s.pageCount(), 5, "共 5 页");
  eq(s.pageCandidates().length, 9, "第一页 9 个");
  const ev = s.press("=");
  eq(ev.type, "page", "= 翻下一页");
  eq(s.page, 1, "当前第 1 页（0 基）");
  s.press("-");
  eq(s.page, 0, "- 翻回上一页");
  eq(s.press("-").type, "noop", "已在首页, 再往前 -> noop");
  const ev2 = s.press(" ");
  eq(ev2.text, target, "首页空格上屏首选");
  eq(ev2.correct, true, "判对");
}
{
  // 第 20 个候选（超出 9）必须能靠翻页选到 —— 否则严格模式下是死路
  const twenty = idx.candidates("fpgc")[20].text;
  const s = S(twenty);
  type(s, "fpgc");
  s.press("=");
  s.press("=");
  eq(s.page, 2, "翻到第 2 页（0 基）");
  const ev = s.press("3"); // 第 2 页第 3 个 = 总第 20 个（0 基 20）
  eq(ev.text, twenty, "靠翻页选到第 21 个候选");
  eq(ev.correct, true, "判对 -> 翻页确实消灭了死路");
}
{
  const s = S("工");
  type(s, "a");
  eq(s.press("2").type, "noop", "只有 1 个候选时按 2 -> noop");
}
{
  const s = S("工");
  eq(s.press(" ").type, "noop", "缓冲为空时按空格 -> noop");
  eq(s.press("1").type, "noop", "缓冲为空时按数字 -> noop");
  eq(s.press("-").type, "noop", "缓冲为空时翻页 -> noop");
}

// ---------------------------------------------------------------- 10. 标点 + 三态
section("[10] 标点自动跳过 + 显示三态");
{
  const s = S("天,地。人");
  eq(s.plan.length, 3, "标点不入 plan（只要求打 天地人）");
  eq(s.plan.map((p) => p.ch).join(""), "天地人", "plan 内容");
  const st = s.displayStates();
  eq(st.length, 5, "显示态覆盖全部 5 个码点（天 , 地 。 人）");
  eq(st[0], "current", "第 1 个 天 = current");
  eq(st[1], "punct", "逗号 = punct");
  eq(st[2], "pending", "地 = pending");
  eq(st[3], "punct", "句号 = punct");
  type(s, "gdi"); // 天 = gdi
  eq(s.press(" ").correct, true, "天 打对");
  const st2 = s.displayStates();
  eq(st2[0], "done", "天 变 done");
  eq(st2[2], "current", "光标跨过逗号落在 地");
  eq(st2[1], "punct", "逗号仍是 punct");
}
{
  const s = S("天,地。");
  s.press(" "); // 冲一下, 不应崩
  eq(s.cursor, 0, "空缓冲不推动光标");
}

// ---------------------------------------------------------------- 11. 代理对（扩展B）
section("[11] 扩展B 汉字（代理对）必须能打");
{
  // 找一个扩展B 的字集内字
  let extb = null;
  for (const ch of idx.charsetList) {
    if (ch.length === 2) {
      extb = ch;
      break;
    }
  }
  ok(!!extb, "字集里存在代理对字符", extb);
  eq(Array.from(extb).length, 1, "代理对字符按码点算只有 1 个字");
  const s = S(extb);
  eq(s.plan.length, 1, "plan 有 1 项（没有按 UTF-16 长度算成 2）");
  eq(s.progress().total, 1, "总长 1");
  const code = idx.shortestCode(extb);
  ok(!!code, "该字有编码", code);
  type(s, code);
  const ev = s.press(" ");
  eq(ev.correct, true, "该字能打出来");
  eq(s.cursor, 1, "光标前进 1（不是 2）");
}

// ---------------------------------------------------------------- 12. 提示
section("[12] 长按提示：最短码缺码 + 词码 + 不匹配标记");
{
  const s = S("雨");
  type(s, "fg");
  const h = s.hint();
  eq(h.char, "雨", "提示目标是 雨");
  eq(h.code, "fghy", "给最短合法码");
  eq(h.typed, "fg", "已打 fg");
  eq(h.missing, "hy", "缺 hy");
  eq(h.mismatch, false, "已打的是目标码的前缀 -> 不算错");
  s.press("h");
  eq(s.hint().missing, "y", "再打 h -> 只缺 y");
  eq(s.stats.hintUses, 2, "hintUses 计数");
}
{
  // 打歪了: 找一个合法但不是目标码前缀的缓冲
  const s = S("雨");
  const code = "fghy";
  let off = null;
  s.press("f");
  for (const k of "abcdefghijklmnopqrstuvwxy") {
    if (idx.isLegal(s.buffer + k) && code.indexOf(s.buffer + k) !== 0) {
      off = k;
      break;
    }
  }
  ok(!!off, "能找到打歪的合法前缀", off);
  s.press(off);
  const h = s.hint();
  eq(h.mismatch, true, "已打的字母跟目标码对不上 -> mismatch");
  eq(h.missing, code, "mismatch 时给完整码");
}
{
  const s = S("我们的");
  const h = s.hint();
  ok(!!h.word, "从光标起能找到可整打的词");
  eq(h.word.text, "我们", "最长匹配到 我们");
  eq(h.word.code, "trwu", "词码 trwu");
  eq(h.word.missing, "trwu", "还没打任何字 -> 缺全部");
  s.press("t"); s.press("r");
  const h2 = s.hint();
  eq(h2.word.text, "我们", "打了 tr 之后仍是 我们");
  eq(h2.word.missing, "wu", "缺 wu");
}
{
  const s = S("十");
  eq(s.hint().word, null, "十 后面没有可整打的词 -> word 为 null");
}
{
  const s = S("工");
  type(s, "a");
  s.press(" ");
  eq(s.hint(), null, "整句打完后 hint 返回 null");
}

// ---------------------------------------------------------------- 13. 统计
section("[13] 统计计数");
{
  const s = S("都天");
  type(s, "ftjb"); // 都 自动上屏
  type(s, "gdi");
  s.press(" ");
  type(s, "g");
  s.press("z"); // 拒收（g + z 非法）
  s.press("Backspace"); // 删码
  s.press("Backspace"); // 缓冲空 -> 撤销 天
  const st = s.stats;
  eq(st.autoCommits, 1, "autoCommits = 1");
  eq(st.commits, 2, "commits = 2（都 + 天）");
  eq(st.correct, 1, "correct = 1（撤销掉了 天）");
  eq(st.rejects, 1, "rejects = 1");
  eq(st.wrong, 0, "wrong = 0");
  ok(st.keystrokes >= 6, "keystrokes 统计到的被接受字母数", st.keystrokes);
}

// ---------------------------------------------------------------- 14. Esc
section("[14] Esc 清空缓冲");
{
  const s = S("工");
  type(s, "aa");
  eq(s.press("Escape").type, "clear", "Esc 清空缓冲");
  eq(s.buffer, "", "缓冲空");
  eq(s.press("Escape").type, "noop", "缓冲已空 -> Esc 无动作");
}

// ---------------------------------------------------------------- 15. 边界
section("[15] 边界");
{
  const s = S("");
  ok(s.isDone(), "空文本 -> 直接完成");
  eq(s.press(" ").type, "noop", "空文本按键无副作用");
  eq(s.hint(), null, "空文本没有提示");
}
{
  const s = S("工作量");
  type(s, "al");
  const h = s.hint();
  eq(h.char, "工", "目标是 工");
  eq(h.mismatch, true, "al 不是 a 的前缀 -> mismatch 为真");
  eq(h.missing, "a", "mismatch 时给完整的最短码 a（让用户看到该打什么）");
}

// ---------------------------------------------------------------- 16. 入门模式
section("[16] 入门模式：判错保留缓冲（治「太早按空格」）");
{
  const s = Core.createSession(idx, { text: "雨", preserveBufferOnError: true });
  s.press("f");
  s.press("g");
  const ev = s.press(" ");
  eq(ev.correct, false, "敲 fg 就空格 -> 上屏 二 -> 判错");
  eq(s.buffer, "fg", "入门模式保留已敲的码");
  eq(ev.bufferKept, "fg", "事件里带出保留的缓冲");
  eq(s.cursor, 0, "光标仍然不动");
  s.press("h");
  s.press("y");
  eq(s.press(" ").correct, true, "接着敲 hy -> 对上 雨 -> 判对");
  eq(s.cursor, 1, "光标前进");
}
{
  const s = Core.createSession(idx, { text: "雨" });
  s.press("f");
  s.press("g");
  eq(s.press(" ").correct, false, "非入门同样判错");
  eq(s.buffer, "", "非入门仍然清空缓冲（要重打）");
}
{
  const s = Core.createSession(idx, { text: "工", preserveBufferOnError: true });
  const ev = type(s, "trwu");
  eq(ev.type, "autocommit", "trwu 自动上屏");
  eq(ev.correct, false, "目标是 工 -> 判错");
  eq(s.buffer, "", "自动上屏判错不留缓冲（码已打满，留着没意义）");
  eq(ev.bufferKept, undefined, "该事件里没有 bufferKept");
}

// ---------------------------------------------------------------- 17. 全码/键位
section("[17] 全码 / 键位辅助（入门模式显示用）");
eq(idx.shortestCode("一"), "g", "一 的最短合法码 = g");
eq(idx.fullCode("一"), "ggll", "一 的全码 = ggll（末两位 l 是补齐位）");
eq(idx.fullCode("十"), "fgh", "十 的全码 = fgh（本来就 3 码，没有 4 码）");
eq(idx.fullCode("雨"), "fghy", "雨 的全码 = fghy");
{
  const codes = idx.codesOf("𬉼");
  ok(!!codes && codes.length > 0, "代理对字（扩展B）也能取到码");
  eq(idx.fullCode("𬉼"), codes[codes.length - 1], "代理对字的全码 = 最长码");
}
eq(idx.keyAt("fghy", 0), "f", "fghy 第 0 位在 F 键");
eq(idx.keyAt("fghy", 3), "y", "fghy 第 3 位在 Y 键");
eq(idx.keyAt("fghy", 9), null, "越界返回 null");

// ---------------------------------------------------------------- 18. 续打定位
section("[18] 续打定位 seek（不能越过一个词）");
{
  // 我们 是词；seek(1) 必须精确落在第 1 个字，而不是被"最长匹配词"带到第 2 个
  const s = Core.createSession(idx, { text: "我们天" });
  s.seek(1);
  eq(s.cursor, 1, "seek(1) 精确落在第 1 个字");
  eq(s.hint().char, "们", "seek 后目标确实是第 1 个字（们）");
  eq(s.buffer, "", "seek 会清空缓冲");
  // 对照：skip 是按词前进的 —— 这正是不能用它做续打的原因
  const s2 = Core.createSession(idx, { text: "我们天" });
  s2.skip();
  eq(s2.cursor, 2, "skip() 一次会跨过整个词（所以续打不能用它）");
}
{
  const s = Core.createSession(idx, { text: "天地人" });
  s.seek(999);
  eq(s.cursor, s.plan.length, "seek 越界 -> 夹到末尾（视为已完成）");
  ok(s.isDone(), "夹到末尾后 isDone 为真");
  s.seek(-5);
  eq(s.cursor, 0, "seek 负数 -> 夹到 0");
  s.seek(2);
  eq(s.cursor, 2, "seek 到中间");
  s.press("Backspace");
  eq(s.cursor, 2, "seek 后没有撤销历史 -> 退格不会回退到上次会话的字");
}

console.log("\n" + (failed ? "FAILED: " + failed + " 项" : "ALL PASS") + "\n");
process.exit(failed ? 1 : 0);
