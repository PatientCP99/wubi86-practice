#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建五笔86练习软件的数据文件。

输入（缓存在 tools/raw/）:
  wubi86.dict.yaml  rime/rime-wubi86 —— 码表: 单字 + 词组 + 权重 + 二级简码(stem)
  level-1/2/3.txt   通用规范汉字表 一级/二级/三级
                    （shengdoushi/common-standard-chinese-characters-table）

输出:
  data/wubi86.js    window.WUBI86 = {...}   （经典 <script> 可加载，file:// 下可用）
  tools/report.md   自检报告

口径（已与需求方确认）:
  * 练习字集 charset = 一级 3500 + 二级 3000 = 6500（国标"常用字 + 次常用字"）
  * 三级字表(1605)不纳入: 国标原文定位为姓氏人名/地名/科技术语用字, 实测按网页
    权重取 500 得到的全是生僻/人名/元素字（於噂昇晖玟珺瑀琊燊…），故不补 7000。
  * 但码表保留**全部汉字**的编码 —— 用户粘贴的文本里出现超纲字时必须照样能打。
  * 候选排序 = (是否在 charset 内, 权重降序, 字序)。实测 2.1% 的码里繁体/异体会
    靠网页权重压过简体常用字（如 alpu -> 蓮 压 莲），故用 charset 偏向纠正。

用法:
  python tools/build_data.py            # 用缓存，缺则下载
  python tools/build_data.py --refresh  # 强制重新下载
"""

import argparse
import collections
import datetime
import os
import re
import sys
import unicodedata
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "tools", "raw")
OUT_DATA = os.path.join(ROOT, "data", "wubi86.js")
OUT_REPORT = os.path.join(ROOT, "tools", "report.md")

GH_TABLE = "https://raw.githubusercontent.com/shengdoushi/common-standard-chinese-characters-table/master/"
GH_TABLE_MIRROR = "https://cdn.jsdelivr.net/gh/shengdoushi/common-standard-chinese-characters-table@master/"
SOURCES = {
    "wubi86.dict.yaml": [
        "https://raw.githubusercontent.com/rime/rime-wubi/master/wubi86.dict.yaml",
        "https://cdn.jsdelivr.net/gh/rime/rime-wubi@master/wubi86.dict.yaml",
    ],
    "level-1.txt": [GH_TABLE + "level-1.txt", GH_TABLE_MIRROR + "level-1.txt"],
    "level-2.txt": [GH_TABLE + "level-2.txt", GH_TABLE_MIRROR + "level-2.txt"],
    "level-3.txt": [GH_TABLE + "level-3.txt", GH_TABLE_MIRROR + "level-3.txt"],
}

# 码: 1-4 位小写字母, 不以 z 开头（z 是五笔万能键, 不算合法编码）
CODE_RE = re.compile(r"^[a-y][a-z]{0,3}$")
# 汉字: 基本区 URO + 扩展A + 扩展B..F
# 注意: 扩展B 及以后在 JS 里是代理对, 前端一律用 Array.from()/for...of 迭代。
HAN_RE = re.compile(r"^[\u3400-\u4dbf\u4e00-\u9fff\U00020000-\U0003ffff]+$")

# 词语模式的站点导航类停用词（网页语料权重的产物, 不是真正的常用词）。
# 保留 下载/注册/信息/内容/时间/可以/使用 这类正当现代词。
WORD_STOP = [
    "本站", "首页", "网站", "官网", "主页", "网页", "栏目", "频道", "导航",
    "最新", "查看", "搜索", "检索", "更多", "相关", "推荐", "排行", "标签",
    "版权", "版权所有", "转载", "原文", "来源", "编辑", "投稿",
    "博客", "帖子", "论坛", "评论", "发表", "跟帖", "楼主",
    "图片", "相册", "视频", "音频", "下载", "附件",
    "收藏", "分享", "点赞", "关注", "订阅", "粉丝",
    "关于我们", "联系方式", "免责声明", "服务条款", "隐私政策",
    "地址", "电话", "邮箱", "客服", "留言", "反馈",
    "追加", "近日", "就能",   # 语料噪声（网页叙述用语, 不是独立常用词）
]
WORD_MIN_LEN = 2
WORD_MAX_LEN = 4


# ---------------------------------------------------------------- 下载 / 解析

def _download(url, path):
    try:
        with urllib.request.urlopen(url, timeout=60) as r, open(path, "wb") as f:
            f.write(r.read())
        return True
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("  urllib failed (%s)\n" % e.__class__.__name__)
    import shutil
    import subprocess
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        return False
    try:
        subprocess.run([curl, "-sS", "-L", "-m", "120", "-o", path, url], check=True)
        return os.path.exists(path) and os.path.getsize(path) > 0
    except Exception:  # noqa: BLE001
        return False


def fetch(name, refresh=False):
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, name)
    if refresh or not os.path.exists(path) or os.path.getsize(path) == 0:
        for url in SOURCES[name]:
            sys.stderr.write("download %s\n" % url)
            if _download(url, path):
                break
        else:
            raise RuntimeError("无法下载 %s（所有镜像均失败）" % name)
    return path


def parse_dict(path):
    """-> (entries, stems, stats, drop_cats)"""
    entries = []
    stems = collections.defaultdict(set)
    st = collections.Counter()
    cats = collections.Counter()
    started = False
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not started:
                if line.strip() == "...":
                    started = True
                continue
            if not line or line.startswith("#"):
                continue
            st["rows_raw"] += 1
            p = line.split("\t")
            if len(p) < 2:
                st["drop_short_row"] += 1
                continue
            text, code = p[0], p[1]
            try:
                w = float(p[2]) if len(p) > 2 and p[2] else 0.0
            except ValueError:
                w = 0.0
            if not CODE_RE.match(code):
                st["drop_bad_code"] += 1
                continue
            if not HAN_RE.match(text):
                st["drop_not_hanzi"] += 1
                bad = [c for c in text if not HAN_RE.match(c)]
                c0 = bad[0]
                if "\u3040" <= c0 <= "\u30ff":
                    cats["日文假名"] += 1
                else:
                    cats["%s (%s)" % (unicodedata.category(c0), unicodedata.name(c0, "?")[:22])] += 1
                continue
            entries.append((text, code, w))
            if len(p) > 3 and len(text) == 1 and CODE_RE.match(p[3] or ""):
                stems[text].add(p[3])
    st["kept"] = len(entries)
    return entries, stems, st, cats


def load_table(path):
    """-> (汉字列表, 文件内非空白字符总数)"""
    s = open(path, encoding="utf-8").read()
    allc = [c for c in s if not c.isspace()]
    han, seen = [], set()
    for c in allc:
        if HAN_RE.match(c) and c not in seen:
            seen.add(c)
            han.append(c)
    return han, len(allc)


# ---------------------------------------------------------------- 建库

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="强制重新下载源数据")
    args = ap.parse_args()

    entries, stems, st, cats = parse_dict(fetch("wubi86.dict.yaml", args.refresh))

    l1, l1_raw = load_table(fetch("level-1.txt", args.refresh))
    l2, l2_raw = load_table(fetch("level-2.txt", args.refresh))
    l3, l3_raw = load_table(fetch("level-3.txt", args.refresh))

    seen = set()
    l1 = [c for c in l1 if not (c in seen or seen.add(c))]
    l2 = [c for c in l2 if c not in seen and not seen.add(c)]
    l3 = [c for c in l3 if c not in seen and not seen.add(c)]

    charset = l1 + l2                      # 6500
    cs = set(charset)

    weight = collections.defaultdict(float)
    for text, code, w in entries:
        if len(text) == 1 and w > weight[text]:
            weight[text] = w

    nocode_l12 = [c for c in charset if c not in weight]
    nocode_l3 = [c for c in l3 if c not in weight]

    # 码表保留全部汉字: 超纲字（不在 charset 内）也必须能打
    single = [(t, c, w) for t, c, w in entries if len(t) == 1]
    phrase = [(t, c, w) for t, c, w in entries if len(t) > 1]

    def dedupe(rows):
        best = {}
        for t, c, w in rows:
            k = (t, c)
            if k not in best or w > best[k]:
                best[k] = w
        return [(t, c, w) for (t, c), w in best.items()]

    single, phrase = dedupe(single), dedupe(phrase)

    # 补齐缺失的二级简码（stem 列给出但无独立行）
    #
    # 但要剔掉一类伪条目：源码表给**一级简码字**的 stem 写的是它的"前两码"
    # （工 a -> stem aa、一 g -> stem gg、的 r -> stem rq）。那是一级简码字的冗余前缀，
    # 不是它的二级简码 —— 五笔里每个二级码只归一个字，aa 其实是 式 的二级简码。
    # 不剔掉的话，因为一级简码字带着十亿级语料权重，敲 aa+空格 会上屏 工 而不是 式。
    # 独立证据：极点五笔码表（KyleBing/rime-wubi86-jidian，Apache-2.0）里这 18 个码
    # 全都有主，而且全都不是这些一级简码字。
    have = {(t, c) for t, c, _ in single}
    one_code = {t for t, c, _ in single if len(c) == 1}
    added = []
    dropped_stem = []
    for ch, ss in sorted(stems.items()):
        for s in sorted(ss):
            if (ch, s) in have:
                continue
            if ch in one_code:
                dropped_stem.append((ch, s))
                continue
            have.add((ch, s))
            single.append((ch, s, weight[ch]))
            added.append((ch, s))

    single.sort(key=lambda r: (r[1], -r[2], r[0]))
    phrase.sort(key=lambda r: (r[1], -r[2], r[0]))

    # ------------------------------------------------------------ 自检
    problems = []
    missing = [c for c in charset if c not in {t for t, _, _ in single}]
    if missing:
        problems.append("字集中无码的字: %d 个 %s" % (len(missing), "".join(missing[:20])))
    if len(charset) != 6500:
        problems.append("字集大小不是 6500: %d" % len(charset))
    for t, c, w in single[:2000] + phrase[:2000]:
        if "," in t or "," in c:
            problems.append("分隔符冲突: %r %r" % (t, c))
            break

    # charset 范围内的编码形态
    sc = collections.defaultdict(set)
    for t, c, w in single:
        if t in cs:
            sc[t].add(c)
    shortest = {t: min(v, key=lambda c: (len(c), c)) for t, v in sc.items()}
    len_hist = collections.Counter(len(shortest[t]) for t in charset)
    no4 = [c for c in charset if not any(len(x) == 4 for x in sc[c])]

    # 全部码（单字 + 词组）
    allcodes = set(c for _, c, _ in single) | set(c for _, c, _ in phrase)
    prefixes = set()
    for c in allcodes:
        for i in range(1, len(c)):
            prefixes.add(c[:i])
    leaf = {c for c in allcodes if c not in prefixes}
    leaf3 = sorted(c for c in leaf if len(c) == 3)
    leaf3_map = collections.defaultdict(list)
    for t, c, w in single:
        if c in set(leaf3):
            leaf3_map[c].append(t)
    auto3 = [t for t in charset if shortest.get(t) in leaf and len(shortest[t]) == 3]

    # 4 码重码（charset 范围内）
    c2t = collections.defaultdict(set)
    for t, c, w in single:
        c2t[c].add(t)
    # 全部 4 码里会出现多候选、且至少一个候选在字集内 —— 空格上屏仍可用（charset 偏向保证常用字首位）
    dup4_any = sorted([(c, sorted(v)) for c, v in c2t.items()
                       if len(c) == 4 and len(v) > 1 and any(t in cs for t in v)],
                      key=lambda x: x[0])
    # 真正需要选字的: 同一个码里有 2 个以上字集内的字
    dup4 = sorted([(c, sorted(t for t in v if t in cs)) for c, v in c2t.items()
                   if len(c) == 4 and len([t for t in v if t in cs]) > 1],
                  key=lambda x: x[0])

    # charset 偏向要纠正的码: 权重首位不是 charset 字, 但码里含 charset 字
    bias = []
    w2t = collections.defaultdict(list)
    for t, c, w in single:
        w2t[c].append((w, t))
    for c, lst in w2t.items():
        lst.sort(key=lambda x: (-x[0], x[1]))
        if len(lst) < 2:
            continue
        if lst[0][1] in cs:
            continue
        if any(t in cs for _, t in lst):
            bias.append((c, lst[0][1], [t for _, t in lst[1:4]]))
    bias.sort()

    # 词组
    pc2t = collections.defaultdict(set)
    for t, c, w in phrase:
        pc2t[c].add(t)
    pdup = sorted([(c, sorted(v)) for c, v in pc2t.items() if len(v) > 1],
                  key=lambda x: (-len(x[1]), x[0]))
    # 词组码与"字集内单字"的全码撞车（这才是练字时会碰到的）
    pclash = sorted(c for c in pc2t if any(t in cs for t in c2t.get(c, ())))
    pclash_all = sorted(c for c in pc2t if c in c2t)

    # 词语模式的词表（词长 2-4, 去掉站点词）—— 统计用
    stop = set(WORD_STOP)
    wl = [(t, w) for t, c, w in phrase
          if WORD_MIN_LEN <= len(t) <= WORD_MAX_LEN and t not in stop]
    wl.sort(key=lambda x: (-x[1], x[0]))
    wl_removed = collections.Counter()
    for t, c, w in phrase:
        if t in stop:
            wl_removed["停用词表"] += 1
        elif len(t) < WORD_MIN_LEN or len(t) > WORD_MAX_LEN:
            wl_removed["词长超界"] += 1

    if problems:
        for p in problems:
            sys.stderr.write("FATAL: %s\n" % p)
        return 1

    # ------------------------------------------------------------ 输出 JS
    os.makedirs(os.path.dirname(OUT_DATA), exist_ok=True)
    built = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    with open(OUT_DATA, "w", encoding="utf-8", newline="\n") as f:
        f.write("// data/wubi86.js —— 由 tools/build_data.py 生成, 请勿手改\n")
        f.write("// built: %s\n" % built)
        f.write("// source: rime/rime-wubi86 wubi86.dict.yaml + 通用规范汉字表 一级/二级\n")
        f.write("// rows: single=%d phrase=%d charset=%d\n" % (len(single), len(phrase), len(charset)))
        f.write("// charset = 练习字集(一级+二级); single/phrase 含全部汉字, 超纲字照样能打。\n")
        f.write("// 候选排序: (是否在 charset 内, 权重降序, 字序) —— 实测 2.1% 的码里繁体/异体\n")
        f.write("//           会靠网页权重压过简体常用字, 故 charset 内的字优先。\n")
        f.write("// 注意: charset 含扩展A/B 汉字, 扩展B及以后在 JS 里是代理对 —— 遍历一律用\n")
        f.write("//       Array.from(str)/for...of, 禁止 str.length / str.split('') / str[i]。\n")
        f.write("window.WUBI86 = {\n")
        f.write('"meta":{"built":"%s","charsetSize":%d,"single":%d,"phrase":%d,"biasFixed":%d},\n'
                % (built, len(charset), len(single), len(phrase), len(bias)))
        f.write('"levels":[%d,%d],\n' % (len(l1), len(l2)))
        f.write('"charset":"%s",\n' % "".join(charset))
        f.write('"wordStop":%s,\n' % ("[]" if not WORD_STOP else
                                      "[" + ",".join('"%s"' % w for w in WORD_STOP) + "]"))
        f.write('"wordLen":[%d,%d],\n' % (WORD_MIN_LEN, WORD_MAX_LEN))
        f.write('"single":[\n')
        f.write(",\n".join('"%s,%s,%d"' % (t, c, round(w)) for t, c, w in single))
        f.write("\n],\n")
        f.write('"phrase":[\n')
        f.write(",\n".join('"%s,%s,%d"' % (t, c, round(w)) for t, c, w in phrase))
        f.write("\n]\n};\n")

    # ------------------------------------------------------------ 报告
    md = []
    md.append("# 数据自检报告\n")
    md.append("生成时间: %s\n" % built)
    md.append("## 规模\n")
    md.append("| 项 | 值 |\n|---|---|")
    md.append("| 练习字集 charset | **%d**（一级 %d + 二级 %d） |" % (len(charset), len(l1), len(l2)))
    md.append("| 单字码行（含超纲字） | %d，覆盖 %d 个字 |"
              % (len(single), len({t for t, _, _ in single})))
    md.append("| 词组行 | %d |" % len(phrase))
    md.append("| data/wubi86.js | **%.2f MB** |" % (os.path.getsize(OUT_DATA) / 1048576.0))
    md.append("| 字表源文件字符数 | 一级 %d / 二级 %d / 三级 %d |" % (l1_raw, l2_raw, l3_raw))
    md.append("")
    md.append("## 口径说明\n")
    md.append("- 字集 = 国标一级(3500) + 二级(3000) = 6500，即「常用字 + 次常用字」。")
    md.append("- 三级字表(%d 字)不纳入：国标定位为姓氏人名/地名/科技术语用字；实测按网页权重取 500 得到的"
              "全是生僻/人名/元素字（於噂昇晖玟珺瑀琊燊…），凑 7000 无练习价值。" % len(l3))
    md.append("- 码表保留全部汉字（%d 条单字码行 / %d 个字，含扩展A/B），保证粘贴文本里的超纲字照样能打。"
              % (len(single), len({t for t, _, _ in single})))
    md.append("- 候选排序加了 charset 偏向，纠正 **%d** 个码里繁体/异体压过简体常用字的情况。" % len(bias))
    md.append("")
    md.append("## 解析过滤\n")
    md.append("| 阶段 | 行数 |\n|---|---|")
    for k in ("rows_raw", "drop_short_row", "drop_not_hanzi", "drop_bad_code", "kept"):
        md.append("| %s | %d |" % (k, st[k]))
    md.append("")
    md.append("被丢掉的非汉字符号构成（前 12 类）：\n")
    md.append("| 类别 | 行数 |\n|---|---|")
    for k, v in cats.most_common(12):
        md.append("| %s | %d |" % (k, v))
    md.append("")
    md.append("## 不变式\n")
    md.append("| 检查 | 结果 |\n|---|---|")
    md.append("| 字集 = 6500 | %s |" % ("OK" if len(charset) == 6500 else "失败: %d" % len(charset)))
    md.append("| 字集中无码的字 | %d %s |" % (len(missing), "".join(missing[:20]) or "OK"))
    md.append("| 一级+二级 里码表无码的字 | %d %s |" % (len(nocode_l12), "".join(nocode_l12[:30]) or "OK"))
    md.append("| 三级 里码表无码的字 | %d |" % len(nocode_l3))
    md.append("| 字段含分隔符 ',' | %s |" % ("有问题" if problems else "OK"))
    md.append("| 最长码长 | 4（=> 任何 4 码都是叶子码） |")
    md.append("")
    md.append("## 编码形态（charset 范围）\n")
    md.append("| 项 | 值 |\n|---|---|")
    md.append("| 最短合法码长度分布 | %s |" % ", ".join("%d码:%d" % (k, v) for k, v in sorted(len_hist.items())))
    md.append("| 无 4 码全码的字 | %d（最短码即完整码, 如 十=fgh 丁=sgh 八=wty） |" % len(no4))
    md.append("| 4 码多候选、且含字集字 | %d 个 code（空格仍可上屏: charset 偏向保证常用字首位） |" % len(dup4_any))
    md.append("| **真正要按数字选字的 4 码** | **%d 个 code**（同一码里有 ≥2 个字集内的字） |" % len(dup4))
    md.append("| 叶子码(自动上屏触发点) | 共 %d（3 码叶子 %d，2 码叶子 %d；4 码一律是叶子） |"
              % (len(leaf), len(leaf3), len([c for c in leaf if len(c) == 2])))
    md.append("| 打满 3 码即自动上屏 | %d 个 3 码叶子, 覆盖 %d 个字 |"
              % (len(leaf3), len({t for c in leaf3 for t in leaf3_map[c]})))
    md.append("| 最短码就是 3 码叶子的字 | %d 字: %s |" % (len(auto3), "".join(auto3)))
    md.append("")
    md.append("## 补齐的简码（源码表 stem 列给出但无独立行）\n")
    md.append("| 字 | 补的二级简码 |\n|---|---|")
    for ch, s in added:
        md.append("| %s | `%s` |" % (ch, s))
    md.append("")
    md.append("## 剔掉的伪简码（一级简码字的前缀，那是别人的二级码）\n")
    md.append("源码表给一级简码字的 stem 写的是它自己的前两码，而那两码其实是**别的字**")
    md.append("的二级简码（例如 `aa` 是 `式`）。这些一级简码字又带着十亿级语料权重，")
    md.append("留着会让 `aa`+空格 上屏 `工`。独立验证：极点五笔码表里这 %d 个码全都有主，"
              % len(dropped_stem))
    md.append("且全不是这些一级简码字。\n")
    md.append("| 字 | 剔掉的前缀码 | 该码真正的二级简码 |\n|---|---|---|")
    owner = {}
    for t, c, _ in single:
        owner.setdefault(c, t)
    for ch, s in dropped_stem:
        md.append("| %s | `%s` | %s |" % (ch, s, owner.get(s, "（无主，空码）")))
    md.append("")
    md.append("## charset 偏向纠正的码（前 40）\n")
    md.append("| 码 | 权重首位(非字集) | 其后 |\n|---|---|---|")
    for c, top, rest in bias[:40]:
        md.append("| `%s` | %s | %s |" % (c, top, " / ".join(rest)))
    if len(bias) > 40:
        md.append("| ... | 共 %d 个码 | |" % len(bias))
    md.append("")
    md.append("## 词组\n")
    md.append("| 项 | 值 |\n|---|---|")
    md.append("| 词条 | %d |" % len(phrase))
    md.append("| 长度分布 | %s |" % ", ".join("%d字:%d" % (k, v) for k, v in sorted(collections.Counter(len(t) for t, _, _ in phrase).items())))
    md.append("| 码长分布 | %s |" % ", ".join("%d码:%d" % (k, v) for k, v in sorted(collections.Counter(len(c) for _, c, _ in phrase).items())))
    md.append("| 词间重码 code | %d（最多候选 %d） |" % (len(pdup), pdup[0] and len(pdup[0][1]) if pdup else 0))
    md.append("| 词组码撞字集内单字全码 | %d 个, 例: %s |" % (len(pclash), ", ".join("`%s`" % c for c in pclash[:6])))
    md.append("| 词组码撞任意单字(含超纲) | %d 个 |" % len(pclash_all))
    md.append("")
    md.append("## 词语模式的词表（词长 %d–%d, 去站点词）\n" % (WORD_MIN_LEN, WORD_MAX_LEN))
    md.append("| 项 | 值 |\n|---|---|")
    md.append("| 可用词条 | %d |" % len(wl))
    md.append("| 被剔除 | %s |" % ", ".join("%s:%d" % (k, v) for k, v in wl_removed.items()))
    md.append("| 停用词表 | %s |" % "、".join(WORD_STOP))
    md.append("| 长度分布（可用） | %s |" % ", ".join("%d字:%d" % (k, v) for k, v in sorted(collections.Counter(len(t) for t, _ in wl).items())))
    md.append("")
    md.append("**权重最高的 40 个词（洗过之后）**: %s\n" % "、".join(t for t, _ in wl[:40]))
    md.append("**权重最高的 30 个字**: %s\n" % "".join(sorted(charset, key=lambda c: (-weight[c], c))[:30]))
    md.append("> 注意: 权重来自网页语料（Chrome/Google 词频），偏网页文本。已用停用词表剔除站点导航词，"
              "但 `下载/注册/信息/内容` 这类正当现代词保留。\n")
    md.append("## 4 码重码明细（同一码里有 ≥2 个字集内的字，必须按数字选；前 60）\n")
    md.append("| 码 | 字集内候选 |\n|---|---|")
    for c, v in dup4[:60]:
        md.append("| `%s` | %s |" % (c, " / ".join(v)))
    if len(dup4) > 60:
        md.append("| ... | 共 %d 个 code |" % len(dup4))
    md.append("")
    md.append("## 4 码里含字集字但首选即常用字（空格可直接上屏，仅列前 20）\n")
    md.append("| 码 | 全部候选 |\n|---|---|")
    for c, v in dup4_any[:20]:
        md.append("| `%s` | %s |" % (c, " / ".join(v)))
    md.append("")
    md.append("## 3 码叶子（打满 3 码即自动上屏的字）\n")
    md.append("| 码 | 字 |\n|---|---|")
    for c in leaf3:
        md.append("| `%s` | %s |" % (c, " / ".join(sorted(leaf3_map[c]))))
    md.append("")

    with open(OUT_REPORT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(md))

    print("OK  data/wubi86.js  %.2f MB" % (os.path.getsize(OUT_DATA) / 1048576.0))
    print("    charset=%d single=%d(%d字) phrase=%d"
          % (len(charset), len(single), len({t for t, _, _ in single}), len(phrase)))
    print("    最短码长度分布 %s" % ", ".join("%d码:%d" % (k, v) for k, v in sorted(len_hist.items())))
    print("    4码要选字 %d 个code, 4码含字集字 %d 个code, 无4码字 %d, 3码叶子自动上屏 %d 字, 补简码 %d 条"
          % (len(dup4), len(dup4_any), len(no4), len(auto3), len(added)))
    print("    剔掉一级简码字的前缀伪简码 %d 条: %s"
          % (len(dropped_stem), " ".join("%s%s" % (ch, s) for ch, s in dropped_stem)))
    print("    charset 偏向纠正的码 %d 个" % len(bias))
    print("    可用词条(词长%d-%d, 去站点词) %d" % (WORD_MIN_LEN, WORD_MAX_LEN, len(wl)))
    print("    report: tools/report.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
