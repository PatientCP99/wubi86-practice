# 第三方来源与许可

本项目的代码与内置故事为原创，但**码表数据是派生的**，来源如下。

## 1. 五笔 86 编码表 —— rime/rime-wubi（LGPL-3.0）

- 仓库: https://github.com/rime/rime-wubi
- 文件: `wubi86.dict.yaml`
- 许可: **GNU Lesser General Public License v3.0**
- 用途: `data/wubi86.js` 里全部单字编码、简码、词组编码、词频权重均来自该码表，经
  `tools/build_data.py` 转换（过滤非汉字条目、剔除 z 开头的万能键码、补齐缺失的二级简码、
  按练习字集重排候选顺序）。

> 因此 `data/wubi86.js` 属于 LGPL-3.0 作品的派生数据，再分发时需保留 LGPL-3.0 与署名。

## 2. 通用规范汉字表 —— 字集来源

- 标准: 《通用规范汉字表》，中华人民共和国教育部、国家语言文字工作委员会 2013-06-05 颁布
- 转录来源: https://github.com/shengdoushi/common-standard-chinese-characters-table
  （该仓库**未附许可文件**）
- 用途: 定义练习字集 `charset` = 一级字表 3500 + 二级字表 3000 = 6500 字

> 本仓库**不分发**该转录文件（`tools/raw/` 已在 `.gitignore` 中排除），只在
> `data/wubi86.js` 内保存了由它筛选出的字集字符序列。字表本身是国家标准内容。

## 3. OpenCC —— 未用于最终产物

- 仓库: https://github.com/BYVoid/OpenCC （Apache-2.0）
- 仅在数据口径探查阶段下载过 `TSCharacters.txt`（用于验证"三级字表按网页词频取 500 会得到
  大量繁体/异体字"这一结论）。**最终 `tools/build_data.py` 不引用它**，产物中不含其任何内容。

## 4. 内置故事

`data/stories.js` 中 5 篇短文为本项目原创，并经 `tools/test_stories.js` 校验 100% 落在 6500
字集内、每个字都有五笔码。

## 5. 字根表

`data/rootmap.js` 的 25 键字根与助记口诀为五笔字型（86 版）公开的标准教学内容，
其正确性用码表做了自动反验（见 `tools/test_rootmap.js`）。
