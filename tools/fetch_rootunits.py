#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「精确字根拆解」的本地数据（可选增强层）。

默认层（data/rootmap.js）只能给到「这一码在哪个键 + 该键有哪些字根」；
本脚本拉一份第三方拆解数据后，可以精确到**每一个码位到底是哪个字根**，
并区分「字根位 / 识别码位 / 笔画码位 / 补齐位」。

## 为什么要搞成"本地生成、不入库"

数据来源 https://github.com/hantang/search-wubi **没有许可文件**（默认保留所有权利），
字根又是私用区（PUA）码点 —— 必须配它自带的 黑体字根.ttf 才显示得出来（实测该字体疑似
SimHei 子集，转分发也有字体许可问题）。所以：

  * 源数据下载到 tools/raw/（已 gitignore）
  * 产物写到 data/local/（已 gitignore）
  * 仓库里只有这个脚本，没有别人的数据与字体

## 产物

  data/local/rootunits.js   window.WUBI86_ROOTUNITS = {...}   逐字：码 + 各位字形 + 各位类别
  data/local/zigen.ttf      字根字体（渲染 PUA 字形用）
  tools/rootunits-report.md 校验报告（只有数字与自己的结论，不含上游数据）

用法:
  python tools/fetch_rootunits.py            # 用缓存，缺则下载
  python tools/fetch_rootunits.py --refresh  # 强制重新下载
  python tools/fetch_rootunits.py --force    # 源数据哈希变了也继续（默认直接报错停下）
"""

import argparse
import collections
import datetime
import hashlib
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "tools", "raw")
LOCAL = os.path.join(ROOT, "data", "local")
OUT_JS = os.path.join(LOCAL, "rootunits.js")
OUT_FONT = os.path.join(LOCAL, "zigen.ttf")
OUT_REPORT = os.path.join(ROOT, "tools", "rootunits-report.md")
HASHES = os.path.join(RAW, "rootunits-sources.json")

GH = "https://raw.githubusercontent.com/hantang/search-wubi/main/"
GH_MIRROR = "https://cdn.jsdelivr.net/gh/hantang/search-wubi@main/"
SOURCES = {
    "data-wubi-v86.tsv": [GH + "data/data-wubi-v86.tsv", GH_MIRROR + "data/data-wubi-v86.tsv"],
    "zigen.ttf": [
        GH + "docs/static/font/%E9%BB%91%E4%BD%93%E5%AD%97%E6%A0%B9.ttf",
        GH_MIRROR + "docs/static/font/%E9%BB%91%E4%BD%93%E5%AD%97%E6%A0%B9.ttf",
    ],
}

# 五笔 5×5 区位键盘（不是字母表顺序！识别码 = 末笔所在区的第 N 键，N 由字型结构定）
ZONE = ["gfdsa", "hjklm", "trewq", "yuiop", "nbvcx"]
STROKE_ZONE = {"横": 1, "竖": 2, "丿": 3, "撇": 3, "捺": 4, "丶": 4, "折": 5, "乛": 5}
SHAPE_POS = {"左右": 1, "上下": 2, "杂合": 3}
FLAG_RE = re.compile(r"([横竖撇丿捺丶折乛])·(左右|上下|杂合)")

KIND = {"r": "字根", "i": "识别码", "s": "笔画码", "p": "补齐位"}

# 上游数据勘误（不改校验强度，只修已知的错）
#
# 镕 = qpwk（钅 + 宀 + 八 + 口），但源表第一位写成 彐 的字形 U+E201。
# 证据: U+E201 在另外 143 处**全部**出现在 V 键位（伊 wvtt / 争 qvhj / 君 vtkd / 事 gkvh …），
#      而 镕 的后三位与 容(pwwk) 的拆解逐位吻合（镕 = 钅 + 容），所以错的只是第一位。
#      Q 键「钅」的字形是 U+E122（见 钅 自己的行，以及其它 Q 键字的第一位）。
# 修掉之后"字根字形跨键"应当为 0 —— 那是本脚本的硬校验，不允许有例外。
FIXES = {
    ("镕", 0): ("\ue122", "源表误作 彐(U+E201)；按码位 q 与 钅 的字形应为 U+E122"),
}


def idcode(stroke, shape):
    """由「末笔 + 字型结构」推出末笔识别码字母"""
    return ZONE[STROKE_ZONE[stroke] - 1][SHAPE_POS[shape] - 1]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(url, path):
    try:
        with urllib.request.urlopen(url, timeout=90) as r, open(path, "wb") as f:
            f.write(r.read())
        return os.path.getsize(path) > 0
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("  urllib failed (%s)\n" % e.__class__.__name__)
    import shutil
    import subprocess
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        return False
    try:
        subprocess.run([curl, "-sS", "-L", "-m", "180", "-o", path, url], check=True)
        return os.path.exists(path) and os.path.getsize(path) > 0
    except Exception:  # noqa: BLE001
        return False


def fetch(name, refresh, hashes):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, name)
    if refresh or not os.path.exists(path) or os.path.getsize(path) == 0:
        for url in SOURCES[name]:
            sys.stderr.write("download %s\n" % url)
            if _download(url, path):
                break
        else:
            raise RuntimeError("无法下载 %s（所有镜像均失败）" % name)
    digest = sha256(path)
    prev = hashes.get(name, {}).get("sha256")
    if prev and prev != digest:
        sys.stderr.write(
            "FATAL: %s 的哈希变了\n  记录 %s\n  现在 %s\n"
            "上游数据改过，本脚本的校验结论不再成立。确认无误后加 --force 继续。\n"
            % (name, prev, digest)
        )
        raise SystemExit(2)
    return path, digest


def parse_dict_singles():
    """从 data/wubi86.js 里取「单字 -> 全部码」，用于校验拆解位与码位一一对应"""
    js = open(os.path.join(ROOT, "data", "wubi86.js"), encoding="utf-8").read()
    m = re.search(r'"charset":"([^"]+)"', js)
    charset = list(m.group(1))
    single = {}
    block = re.search(r'"single":\[\n(.*?)\n\],\n"phrase"', js, re.S).group(1)
    for row in block.split(",\n"):
        p = row.strip('"').split(",")
        if len(p) >= 2:
            single.setdefault(p[0], set()).add(p[1])
    return charset, single


def parse_rootmap():
    """从 data/rootmap.js 取 键 -> 字根清单（判断一个字是不是"字根字"要用）

    别把正则写松了：这个文件除 rows 之外，humanVerified.items 也带 key 字段。
    早先的写法 `key: "x".*?roots: [...]`（re.S）会把 humanVerified 里的 key 和**下一行**的
    roots 配成一对 —— 结果是 g 键整个丢失、其余键错位，12 个码位的类别因此算错
    （首码为 g 的字根字不再被认作字根字，笔画码/补齐位被算成字根）。
    所以这里要求 key 后面紧跟 name，并把"25 个键都在""键名字必须在自己键的字根里"做成硬断言。
    """
    js = open(os.path.join(ROOT, "data", "rootmap.js"), encoding="utf-8").read()
    out = {}
    names = {}
    for m in re.finditer(r'\{\s*key:\s*"([a-y])",\s*name:\s*"([^"]*)",.*?roots:\s*\[([^\]]*)\]', js, re.S):
        key, name, roots = m.group(1), m.group(2), m.group(3)
        if key in out:
            raise SystemExit("FATAL: 解析 data/rootmap.js 时键 %s 出现两次" % key)
        out[key] = [x.strip().strip('"') for x in roots.split(",") if x.strip()]
        names[key] = name
    expect = set("abcdefghijklmnopqrstuvwxy")
    if set(out) != expect:
        raise SystemExit("FATAL: 解析 data/rootmap.js 只得到 %d 个键，缺 %s —— 正则被文件结构带偏了"
                         % (len(out), "".join(sorted(expect - set(out)))))
    for key, name in names.items():
        if name not in out[key]:
            raise SystemExit("FATAL: %s 键的键名字 %s 不在它自己的字根里（解析错位）" % (key.upper(), name))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="强制重新下载源数据")
    ap.add_argument("--force", action="store_true", help="源数据哈希变了也继续")
    args = ap.parse_args()

    hashes = {}
    if os.path.exists(HASHES):
        try:
            hashes = json.load(open(HASHES, encoding="utf-8"))
        except Exception:  # noqa: BLE001
            hashes = {}
    if args.force:
        hashes = {}

    tsv, tsv_hash = fetch("data-wubi-v86.tsv", args.refresh, hashes)
    font, font_hash = fetch("zigen.ttf", args.refresh, hashes)

    charset, single = parse_dict_singles()
    rootmap = parse_rootmap()
    roots_of_key = rootmap  # 键 -> 字根列表

    # ---------------------------------------------------------- 解析拆解表
    rows = [l.rstrip("\n").split("\t") for l in open(tsv, encoding="utf-8")]
    hdr = rows[0]
    if hdr[:2] != ["char", "code"]:
        raise SystemExit("FATAL: 拆解表列变了: %s" % hdr)
    recs = {}
    for r in rows[1:]:
        if len(r) < 10 or not r[0]:
            continue
        recs[r[0]] = r

    problems = []
    out_rows = {}
    kind_count = collections.Counter()
    glyph_key = {}  # 字形 -> 键（校验用）
    cross = []
    id_seen = collections.Counter()
    id_ok = id_bad = 0
    stroke_glyphs = {}
    applied_fixes = []

    # 先认出五种单笔画字形（一/丨/丿/丶/乙 的 units 就是它们）
    for ch, label in (("一", "横"), ("丨", "竖"), ("丿", "撇"), ("丶", "捺"), ("乙", "折")):
        u = recs.get(ch)
        if u and u[7]:
            g = [x for x in u[7] if x not in "〖〗※"]
            if g:
                stroke_glyphs[g[0]] = label

    for ch, r in recs.items():
        code, flag, units_raw = r[1], r[8], r[7]
        if not units_raw:
            continue
        units = [x for x in units_raw if x not in "〖〗※"]
        if len(units) != len(code):
            problems.append("%s 的 units 个数(%d) 与码长(%d) 不一致" % (ch, len(units), len(code)))
            continue
        # 应用有据可查的勘误
        for i in range(len(units)):
            fx = FIXES.get((ch, i))
            if fx and units[i] != fx[0]:
                units[i] = fx[0]
                applied_fixes.append("%s 第 %d 位 %s（%s）" % (ch, i, fx[0].encode("unicode_escape").decode(), fx[1]))
        # 末位是不是识别码：flag 里有「末笔·结构」标记
        m = FLAG_RE.search(flag or "")
        has_id = bool(m)
        kinds = ["r"] * len(code)
        idnote = ""
        if has_id:
            want = idcode(m.group(1), m.group(2))
            if want != code[-1]:
                id_bad += 1
                problems.append("%s 末位 %s != 由「%s·%s」推出的识别码 %s" % (ch, code[-1], m.group(1), m.group(2), want))
                continue
            id_ok += 1
            kinds[-1] = "i"
            idnote = "末笔%s·%s型" % (m.group(1), m.group(2))
            id_seen[units[-1]] += 1
        # 字根字：字本身就是它首码所在键的字根 -> 尾码按「报户口+首笔+次笔+末笔」取笔画，不足补 l
        is_root_char = ch in roots_of_key.get(code[0], [])
        if is_root_char and not has_id:
            for i in range(1, len(code)):
                kinds[i] = "s" if units[i] in stroke_glyphs else "p"
        for i, (c, g) in enumerate(zip(code, units)):
            kind_count[kinds[i]] += 1
            if kinds[i] == "i":
                continue
            # 跨键校验只看**字根位**：笔画码/补齐位用的是单笔画与 l，
            # 它们和"横/竖/撇/捺/折"这几个字根共用字形，天生跨键，不算错。
            if kinds[i] != "r":
                continue
            prev = glyph_key.get(g)
            if prev is not None and prev != c:
                cross.append((ch, g, prev, c))
            glyph_key.setdefault(g, c)
        out_rows[ch] = {"code": code, "units": "".join(units), "kinds": "".join(kinds), "id": idnote}

    # ---------------------------------------------------------- 校验
    cover = [c for c in charset if c in out_rows]
    missing = [c for c in charset if c not in out_rows]
    no_units = len(recs) - len(out_rows)  # 表里有行但没有拆解数据
    # 上游对个别字确实没有拆解数据（实测 3 个扩展B 字），允许极小缺口，报出来但不判死
    miss_ratio = len(missing) / float(len(charset))

    # 识别码字形应当恰好 15 个（5 末笔 × 3 结构），且互不重叠
    id_glyph_count = len(id_seen)
    # 字根位字形不得出现在识别码位上（两套字形应当完全分开）
    overlap = set(id_seen) & set(glyph_key)

    md = ["# 精确字根拆解 · 校验报告\n",
          "生成时间: %s\n" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
          "数据来源: `hantang/search-wubi`（**该仓库无许可文件**，故数据与字体只落本地、不入库）\n",
          "| 项 | 值 |\n|---|---|",
          "| 源文件哈希 | `data-wubi-v86.tsv` %s / `zigen.ttf` %s |" % (tsv_hash[:16], font_hash[:16]),
          "| 拆解表字数 | %d |" % len(recs),
          "| 其中**表里有行但无拆解数据** | %d |" % no_units,
          "| 产出字数 | %d |" % len(out_rows),
          "| 覆盖率（6500 练习字集） | **%d / %d** |" % (len(cover), len(charset)),
          "| 码位类别统计 | %s |" % "、".join("%s %d" % (KIND[k], v) for k, v in sorted(kind_count.items())),
          "| 识别码位推导校验 | **%d/%d = %.2f%%** |" % (id_ok, id_ok + id_bad, 100.0 * id_ok / max(1, id_ok + id_bad)),
          "| 识别码位字形数 | %d（应为 5 末笔 × 3 结构 = 15） |" % id_glyph_count,
          "| 字根字形跨键次数 | **%d**（应为 0） |" % len(cross),
          "| 字根位与识别码位字形重叠 | **%d**（应为 0） |" % len(overlap),
          "| 已应用的上游勘误 | %d 处 |" % len(applied_fixes),
          "| 五种单笔画字形 | %s |" % "、".join("%s=%s" % (v, hex(ord(k))) for k, v in stroke_glyphs.items()),
          ""]
    if applied_fixes:
        md.append("## 已应用的上游勘误\n")
        for a in applied_fixes:
            md.append("- %s" % a)
        md.append("")
    if problems:
        md.append("## 问题（前 30）\n")
        for p in problems[:30]:
            md.append("- %s" % p)
        md.append("")
    if missing:
        md.append("## 字集内没有拆解数据的字（%d 个，应用层对这些字退回默认层）\n" % len(missing))
        md.append("`%s`\n" % "".join(missing[:60]))
    md.append("> 缺口原因: 上游 `units` 列为空（实测 %d 行如此），不是本脚本丢弃。\n" % no_units)
    md.append("## 类别判定规则\n")
    md.append("- **识别码位**：该字的记录里有「末笔·结构」标记，末位即识别码；"
              "脚本用 5×5 区位键盘反推并与码表末位比对，不一致就报错（不是静默通过）")
    md.append("- **笔画码位**：该字本身是首码所在键的字根（字根字），尾码按「报户口 + 首笔 + 次笔 + 末笔」取笔画")
    md.append("- **补齐位**：字根字笔画不足时的 `l` 补齐")
    md.append("- **字根位**：其余各位")
    md.append("")
    open(OUT_REPORT, "w", encoding="utf-8", newline="\n").write("\n".join(md))

    if problems or cross or overlap:
        sys.stderr.write("FATAL: 校验未通过（见 tools/rootunits-report.md）\n")
        for p in problems[:5]:
            sys.stderr.write("  %s\n" % p)
        return 1
    if len(cover) < len(charset):
        if miss_ratio > 0.01:
            sys.stderr.write("FATAL: 练习字集覆盖不足: %d/%d（缺口超过 1%%）\n" % (len(cover), len(charset)))
            return 1
        sys.stderr.write("注意: 有 %d 个字上游没有拆解数据（%s），应用层会对它们退回默认层\n"
                         % (len(missing), "".join(missing[:10])))

    # ---------------------------------------------------------- 产出
    os.makedirs(LOCAL, exist_ok=True)
    with open(font, "rb") as fi, open(OUT_FONT, "wb") as fo:
        fo.write(fi.read())

    built = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(OUT_JS, "w", encoding="utf-8", newline="\n") as f:
        f.write("// data/local/rootunits.js —— 由 tools/fetch_rootunits.py 生成\n")
        f.write("// built: %s\n" % built)
        f.write("// 来源: hantang/search-wubi（该仓库无许可文件）\n")
        f.write("// 本文件是**本地专用**的：data/local/ 已在 .gitignore 里，请勿提交、勿随仓库分发。\n")
        f.write("// units 是私用区(PUA)码点，必须配 data/local/zigen.ttf 才显示得出来。\n")
        f.write("// kinds: r=字根 i=识别码 s=笔画码 p=补齐位\n")
        f.write("window.WUBI86_ROOTUNITS = {\n")
        f.write('"meta":{"built":"%s","source":"hantang/search-wubi","ttf":"data/local/zigen.ttf",'
                '"tsvSha256":"%s","fontSha256":"%s","rows":%d,"charsetCovered":%d},\n'
                % (built, tsv_hash, font_hash, len(out_rows), len(cover)))
        f.write('"stroke":{%s},\n' % ",".join('"%s":"%s"' % (k, v) for k, v in stroke_glyphs.items()))
        f.write('"kinds":{"r":"字根","i":"识别码","s":"笔画码","p":"补齐位"},\n')
        f.write('"rows":{\n')
        f.write(",\n".join('"%s":["%s","%s","%s","%s"]' % (ch, v["code"], v["units"], v["kinds"], v["id"])
                           for ch, v in sorted(out_rows.items())))
        f.write("\n}\n};\n")

    hashes = {
        "data-wubi-v86.tsv": {"url": SOURCES["data-wubi-v86.tsv"][0], "sha256": tsv_hash,
                              "bytes": os.path.getsize(tsv)},
        "zigen.ttf": {"url": SOURCES["zigen.ttf"][0], "sha256": font_hash, "bytes": os.path.getsize(font)},
    }
    json.dump(hashes, open(HASHES, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    print("OK  data/local/rootunits.js  %.0f KB" % (os.path.getsize(OUT_JS) / 1024.0))
    print("    data/local/zigen.ttf     %.0f KB" % (os.path.getsize(OUT_FONT) / 1024.0))
    print("    覆盖 %d/%d 字集字，共 %d 字" % (len(cover), len(charset), len(out_rows)))
    print("    码位类别: %s" % "、".join("%s %d" % (KIND[k], v) for k, v in sorted(kind_count.items())))
    print("    识别码推导 %d/%d = %.2f%%，识别码字形 %d 个，跨键 %d 次，字形重叠 %d"
          % (id_ok, id_ok + id_bad, 100.0 * id_ok / max(1, id_ok + id_bad), id_glyph_count, len(cross), len(overlap)))
    print("    report: tools/rootunits-report.md")
    print("    提醒: data/local/ 已被 .gitignore 排除 —— 请不要提交这份数据与字体。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
