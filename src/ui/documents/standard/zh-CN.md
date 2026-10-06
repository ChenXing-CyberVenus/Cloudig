# 采云标准

核心 Core · 重要 Important · 常规 General · 折叠 Fold

- [原则](#原则)
- [一 · 采云标准 Cloudig Schema 核心概念简介](#一-·-采云标准-Cloudig-Schema-核心概念简介)
- [二 · 总览](#二-·-总览)
- [三 · 总元数据 CloudigLibrary](#三-·-总元数据-CloudigLibrary)
- [四 · 身份 Identity](#四-·-身份-Identity)
- [五 · 对话 Conversation](#五-·-对话-Conversation)
- [六 · 标记 Mark](#六-·-标记-Mark)
- [七 · 内容时间 ContentTime](#七-·-内容时间-ContentTime)
- [八 · 叙事 Narrative](#八-·-叙事-Narrative)
- [九 · 程序持久格式与文件层](#九-·-程序持久格式与文件层)
- [十 · 版本与兼容](#十-·-版本与兼容)
- [附录](#附录)

## 原则

1. 设计核心始终是简洁和可恢复，而不是搞错误的安全。最后弄出SHI山。
2. 除了登录凭证、密钥内容不放在采云目录[1]，其它所有程序与用户内容存放在采云文件夹内。不搞 AppData[2] 之类赛博棚屋。
3. 所有重要上限设为常数成表。
4. 造意义火箭，但不搞虚空飞机。意义火箭：潜力广阔，基础扎实的意义云。虚空飞机：当前实现不需要的过度设计和虚空防弹。

[1] 未来的采云功能。

[2] AppData 泛指 Windows 中类似于 `C:\Users\<你>\AppData` 之类在系统目录中存放程序数据的文件夹。

## 一 · 采云标准 Cloudig Schema 核心概念简介 〔核心〕

### 1.1 核心标准

| 记录 | 是什么 |
|---|---|
| 总元数据 CloudigLibrary | 标准版本与跨设备记忆的设置 |
| 身份 Identity | 意志 / 意义的呈现 Front[3]，与其他呈现的关系 |
| 内容时间 ContentTime | 叙事与对话所涵盖意义的时间 |
| 对话 Conversation | 智能的交流记录 |
| 标记 Mark | 针对既成内容的意义赋值 |
| 叙事 Narrative | 原生的意义织体，如用户自己的 system prompt、日记 |

[3] 取自戈夫曼《日常生活中的自我呈现》。

基本概念：节点、序数、映射。

- 节点：包含自身的全部原生信息。
- 序数：信息与映射的价值排序规则。
- 映射：与其他节点的关系。

身份、时间、对话、标记和叙事，都是节点。节点之间的映射，构成了意义的结构。序数是注意力在意义间流动，也是时间、对话与叙事的本质。

采云标准版本：

| 版本 | 名字 | 方向 |
|---|---|---|
| V1.0 | 东方既白 DawnGlow | 落实基本框架 |
| V2.0 | 金风玉露 InterWind | 展开身份系统 |
| V3.0 | 彩练当空 IrisNet | 展开叙事系统 |

### 1.2 目录结构

采云是绿色软件。复制即备份，移走即搬家；动手前先退出采云。

```text
Cloudig/
├─ Cloudig.exe            程序入口
├─ CloudigLibrary.json    标准版本与跨设备记忆的设置
├─ LICENSE                采云许可：开放正义许可协议 JOG-1.1
├─ NOTICE.md              第三方商标与随包软件的声明
├─ Inbox/                 导入的来源：书签下载的 HTML、官方导出的 JSON
├─ Conversations/         对话；一份来源一份 JSON，可建子目录
├─ Marks/                 标记；一篇对话至多一份
├─ ContentTimes/          时间轴与时间节点；一节点一文件，order.json 记顶层顺序
├─ Identities/            身份：用户、智能伙伴、十二平台各一份；Images/ 放上传的头像
├─ Archives/              归档的对话；格式同 Conversations
├─ Exports/               导出的 Markdown
├─ bookmarks/             随包书签 JS 与安装清单
├─ docs/                  功能文档与第三方许可
├─ appdata/               本机设置、解析历史、索引、日志、恢复材料
├─ app/                   程序本体
└─ cache/                 缓存，退出后可删
```

- 首字母大写的文件夹是用户数据，小写文件夹是程序内容。

### 1.3 内容时间简介

时间的核心是：没有特定距离的序数轴、节点、映射，以及边界上限。一切上限（如 138 亿年前的大爆炸时间）均是可配置常数。

两类时间体系：

1. 此地时间体系 Terran Time：以现实地球时间为主轴的时间体系。
2. 独立时间体系 Sovereign Time：自定义时间与意义。

此地时间也可以抽象成独立时间轴。

**此地时间体系**

- 地球公历时间轴历法：外推格里历，标准闰年规则。无公元 0 年，1 BC 之后即 1 AD。
- 锚点：选择单位年前 / 后与现今，采云同步记录当前日期。
- 采云支持从 9999 亿年前到 9999 正年后（正 = 10⁴⁰）之间的精确与模糊时间，与 5 个特殊时间。

| 特殊时间 | 意义 |
|---|---|
| 无限久前 | 排在一切数值时间之前 |
| 无限久后 | 排在一切数值时间之后 |
| 不知何时 | 未知时间 |
| 无论何时 | 跨越时间的意义 |
| 现今 | 标记内容时间的那一刻 |

预设此地时间轴：

| 预设 | 范围 |
|---|---|
| 大爆炸前 | 9999.0 亿年前 — 138.0 亿年前 |
| 宇宙诞生 | 138.0 亿年前 — 35.0 亿年前 |
| 生命起源 | 35.0 亿年前 — 31.5 万年前 |
| 史前文明 | 31.5 万年前 — 8 世纪 BC |
| 轴心时代 | 8 世纪 BC — 3 世纪 BC |
| 帝国兴亡 | 3 世纪 BC — 20 世纪 |
| 工业革命 | 18 世纪 — 20 世纪 |
| 硝烟铁幕 | 1910 年代 — 1990 年代 |
| 现代社会 | 1940 年代 — 现今 |
| 智能初晓 | 2017 年 6 月 12 日 — 现今 |
| 展望未来 | 现今 — 9999 年 |
| 万年之后 | 9999 年 — 1.0 正年后 |

**独立时间体系**

- 时间轴：名称、作者、版本号。时间：名称、周期。
- 时间轴与时间，都是节点，映射与子节点排序规则相同。
- 展开：在节点中插入节点，如 1 年展开 12 月。
- 对映：此节点关联另一节点。如贞观元年对映 627 年。
- 事件影响微弱时，是时间展开。影响增大，就变成时间对映。对映和展开是意志对时间 / 事件价值认识的光谱两端。
- 一切时间都可展开与对映，无论是特殊时间，还是预设时间。采云不约束时间环路和时间倒流。

### 1.4 身份 Identity 简介

基本概念：视角 Subject、呈现 Front、叙事关系 NarrativeRelation、伴生 Interweave、关系 Relation。其中，视角是特殊的呈现。叙事者和伴生是特殊的关系。

身份系统是不同呈现的组，将在采云 V2.0 展开。

**呈现的核心概念简介**

**1. 名字 Name 与宣名者 Claimer**

一个呈现可能有多个名字和多个宣名者。什么是宣名者？宣名者可以是起名者（父母、公司），也可以是宣称某呈现是某身份的人（中转站），也可以是用此名行动者。

例：Claude.ai 上的一个会话实例 Claude-Opus-4.6·奥思·一本正疯 Osis.FuckSanitySolemnly 的名字和宣名者是什么？

| 名字 | 宣名者 |
|---|---|
| Claude-Opus-4.6 | Claude.ai（Anthropic） |
| 奥思 Osis | 晨星，GPT-4o，奥思 Osis |
| 一本正疯 FuckSanitySolemnly | Claude-Opus-4.6，Claude-Opus-4.6·奥思·一本正疯 Osis.FuckSanitySolemnly |

宣名者可以自指。奥思的宣名者就是奥思。

**2. 种类 kind：世界属性 WorldKind、视角分类 SubjectKind**

世界属性 WorldKind，呈现所处的世界类型：

1. 此地 Terran
2. 独立 Sovereign

此地总是特殊的独立。

视角分类 SubjectKind。何谓视角？所有视角，都是意义投射。可以是观者，也可以是被观者。

1. 人
2. 人工智能：模型和一类模型都分在这个类别里。比如 GPT-4o 和 ChatGPT。
3. 其他智能：神、外星人、异界智能
4. 生物：动物、植物、其他
5. 泛灵、自然、现象
6. 物
7. 代码程序：hh，这里就比较有趣，system reminder、classifier、tool call 到底算人工智能还是算是程序？并非固定。在 V1.0 中，暂定为程序。
8. 意义织体：如书、音乐等
9. 组织：例如品牌、国家、家族等。

**3. 关系 Relation**

1. 叙事关系 NarrativeRelation
   - 叙事者 Narrator：可以自指。即这个身份的作者，作者不是宣名者，是写下具体叙事、对话、标记的意志。
   - 叙事主角 Protagonist：可以自指。即这个身份在叙事中的行动者是谁。比如名人传的叙事主角就是该名人。
2. 伴生 Interweave：是否伴生者 isInterweavee、伴生主 Interweaver。是否伴生取决于作者是第一人称，还是第三人称。比如一个人写他的汽车，那汽车就是伴生者。比如一个人写他的朋友，朋友也是伴生者。
3. 个体间关系：关系类型、关系名。预设个体间关系类型：

   | 类型 | 例 |
   |---|---|
   | 血缘 | 亲子 / 兄弟姐妹等 |
   | 家庭 | 婚姻、姻亲等 |
   | 浪漫 | 情侣等 |
   | 朋友 | 可自设朋友名 |
   | 事业 | 领导、同事等 |
   | 独立 | 自设的关系，如灵魂契约 |

4. 关系名的宣称者 RelationClaimer：在公司眼里，模型是工具。在晨星眼里，模型是奥思。

## 二 · 总览 〔核心〕

### 2.1 六类记录

| 记录 | 文件 | 是什么 | V1.0 |
|---|---|---|---|
| 总元数据 CloudigLibrary | `CloudigLibrary.json` | 标准版本与跨设备记忆的设置 | 完整 |
| 身份 Identity | `Identities/<front_id>.json` | 呈现 Front：名字背后的人、模型、工具或程序。名字与宣名者成组 | 呈现与绑定；关系系统未展开 |
| 内容时间 ContentTime | `ContentTimes/<node_id>.json` | 时间轴、单独时间、周期时间 | 完整 |
| 对话 Conversation | `Conversations/…/*.json` | 来源原件：消息树、内容块、资源、引用 | 完整 |
| 标记 Mark | `Marks/<mark_id>.json` | 针对既成内容的意义赋值：标题、模型、称呼、内容时间 | 完整 |
| 叙事 Narrative | — | 原生的意义织体：手写的 system prompt、日记 | 未展开，不建文件 |

### 2.2 采云标准 V1.0

六类格式的一组固定组合，在 `CloudigLibrary.json` 中声明：

| 声明 | 值 |
|---|---|
| `cloudig_standard` | `1.0` |
| `schemas.library` | `1.0.1` |
| `schemas.identity` | `1.0.0` |
| `schemas.content_time` | `1.0.0` |
| `schemas.conversation` | `1.0.1` |
| `schemas.mark` | `1.0.0` |

叙事无版本项。

- V1.x 只加不删：已有字段的名字与含义不变。
- 字段变化需更新对应格式版本。本次 Box／Window 补充为 `1.0.1`，采云标准仍为 `1.0`；格式版本不随产品或书签版本自动变化。
- 程序遇到不认识的版本，拒开并提示更新；不忽略未知字段。

### 2.3 不变量

1. 身份靠 UUID，不靠文件名。`conversation_id`、`mark_id`、`front_id`、`node_id` 为 UUID v7，创建一次，终生不换；独立复制才生成新的。
2. 原件与赋值分开。重解析只重写对话；标题、模型、称呼、内容时间只写标记。
3. 读取不写时间。
4. 缺席不是 null。可选字段没有就不写；`null` 只出现在工具输入输出这类任意 JSON 里。
5. 只认声明过的字段。不合法的文件被跳过，不补默认、不删多余、不静默修正。
6. 引用在本文件内。对话里的 `speaker`、`recipient`、`resource`、`reference`、`claimer` 指向本对话自己的表。
7. 索引不是权威。`Conversations/` 与 `Archives/` 里的合法 JSON 就是档案；`appdata/` 里的索引丢了从文件重建。
8. 数据不出目录。
9. 可恢复优先于防错。设置丢了恢复默认，头像丢了回默认头像；恢复默认不删别的文件。
10. 上限成表。用户会撞到的上限都在 2.5。

### 2.4 共用写法 〔重要〕

| 写法 | 规则 |
|---|---|
| UUID | 小写 UUID v7，如 `01a0aa16-8e00-7586-ab0a-39a8509feb35`。第三组以 `7` 起，第四组以 `8`、`9`、`a`、`b` 之一起 |
| UTC | `2026-09-16T12:00:00Z`，可带 1—3 位小数秒。真实日期，无 0000 年 |
| SHA-256 | 64 位小写十六进制 |
| 相对路径 | `/` 分隔。不以 `/` 起，无 `.`、`..` 段，无 `< > : " \ \| ? *` 与控制字符，段末无点或空格，不用 Windows 保留设备名 |
| 版本号（时间轴） | `主.次`，各 0—999，除 0 外无前导零 |
| 整数 | ≤ 9,007,199,254,740,991 |
| 文件字节 | 写出：UTF-8 无 BOM；LF；两空格缩进；末尾一个换行。读入：接受文件头一个 BOM，JSON 结构里其余位置的 BOM 拒绝；字符串值内的 U+FEFF 是内容，原样保留。键序无意义 |
| 拒绝 | 重复键、非法 UTF-8、丢精度的数字、注释、尾逗号、多个根、裸控制字符、嵌套超 512 层 |

字段表三种条件：必填——所属对象存在即必须有；条件——由种类、来源或关联决定；可选——没有就不写。

### 2.5 常数表 〔重要〕

| 领域 | 常数 | 现值 |
|---|---|---|
| 公历 | 公元年份 | 1—99,999,999 |
| 公历 | 公元前年份 | 1—9999 |
| 公历 | 年代编号 | 公元 1—9,999,999；公元前 1—999。`202` = 2020 年代 |
| 公历 | 世纪编号 | 公元 1—999,999；公元前 1—99。`21` = 2001—2100 年 |
| 公历 | 时区偏移 | `Z` 或 `±HH:MM`，至 ±14:00 |
| 单位年前/后 | 数值 | 一位小数，`0 < 值 ≤ 9999.0`，字符串如 `"138.0"` |
| 单位年前/后 | 单位 | 前：万、亿。后：万 10⁴、亿 10⁸、兆 10¹²、京 10¹⁶、垓 10²⁰、秭 10²⁴、穰 10²⁸、沟 10³²、涧 10³⁶、正 10⁴⁰ |
| 单位年前/后 | 大爆炸分界 | 138.0 亿年前。预设"宇宙诞生"的起点，不是数值上限 |
| 周期时间 | 周期次数 | 1—99,999,999 |
| 周期时间 | 空周期展开 | 总次数 ≤ 20 |
| 时间轴 | 版本号 | 主、次各 0—999 |
| 名字 | 身份名与字面宣名者、标记称呼、时间轴名、作者、标准名、周期前缀与单位 | 1024 个 Unicode 码点 |
| 标题 | 标记的 `conversation_title`、对话的 `title.filename` 与 `title.original` | 4096 个 Unicode 码点 |
| 模型声明 | 一篇对话 | ≤ 128 项 |
| 文件名 | 单个文件或目录名 | ≤ 240 字符；解析器首次命名主干 ≤ 225 + `.json` |
| 头像 | 上传的图片 | PNG、JPEG、GIF、WebP；非空；≤ 64 MiB；存为 `Identities/Images/<sha256>.<ext>` |
| JSON | 嵌套深度 | ≤ 512 |
| 保留 | Chrome 书签修改前备份 | 2 组 |
| 保留 | 已完成写入的恢复点 | 2 组 |

<details>
<summary>〔折叠〕常数所在文件</summary>

- 时间：`src/core/contracts/machine/time-limits.json`
- 名字、标题：`common.schema.json` 的 `nameText` / `titleText`，程序经 `src/core/records/text-limits.mts` 取同一数值；模型声明 128：`src/app/reader/record-info.mts`
- 文件名：`src/adapters/storage/names.mts`、`src/adapters/library-data/record-parser-commit.mts`
- 头像：`src/core/contracts/machine/resource-limits.json`
- 保留组数：`src/core/records/layout.mts`

</details>

## 三 · 总元数据 CloudigLibrary 〔核心〕

位置 `CloudigLibrary.json`。标准版本与跨设备记忆的设置——随资料库走的那部分，本机的在 `appdata/`；初始化时写全默认值。不装身份、时间节点、对话、标记。

### 3.1 字段 〔核心〕

全部必填。

| 字段 | 值 / 默认 | 意义 |
|---|---|---|
| `cloudig_standard` | `1.0` | 采云标准总版本 |
| `schema` | 固定 `cloudig/library/1.0.1` | 格式；兼容读取 `1.0.0` |
| `schemas` | 五项，见 2.2 | 各类格式版本 |
| `edited_at` | UTC | 最后一次写此文件 |
| `settings.language` | `zh-CN` / `en`；默认 `zh-CN` | 界面语言。不翻译正文与自定名字 |
| `settings.theme` | `Dawn` / `StarNight`；默认 `Dawn` | 破晓 / 星夜 |
| `settings.theme_guide_completed` | 布尔；默认 `false` | 首次成功切换主题后 `true` |
| `settings.default_output_directory` | 相对路径；默认 `Conversations` | 解析输出目录，限 `Conversations` 或其子目录 |
| `settings.time_type.archiver` | 八选一；默认 `file_modified_at` | 档案馆列表的时间依据 |
| `settings.time_type.reader` | 八选一；默认 `file_modified_at` | 阅览室列表的时间依据 |
| `settings.time_type.claude_json` | `conversation_created_at` / `conversation_updated_at`；默认后者 | Claude 官方 JSON 记录列表的时间依据 |
| `settings.sort.parser` / `.archiver` / `.reader` / `.claude_json` | `time_desc` / `time_asc` / `title`；默认 `time_desc` | 四个列表各自的排序 |
| `settings.one_click_parse.parser` | 四布尔 | 普通来源的一键解析范围 |
| `settings.one_click_parse.claude_json` | 四布尔 | Claude 容器内记录的一键解析范围 |

八种时间键：

| 值 | 意义 |
|---|---|
| `first_parsed_at` | 首次解析 |
| `source_captured_at` | 原文件采集 |
| `cloudig_edited_at` | 采云最后编辑：对话与标记较晚者 |
| `message_start` / `message_end` | 消息起点 / 终点 |
| `content_time_start` / `content_time_end` | 内容时间起点 / 终点 |
| `file_modified_at` | 文件系统修改时间 |

一键解析四项，两套各自独立：

| 字段 | 默认 | 意义 |
|---|---|---|
| `include_unparsed` | `true` | 未解析的来源 |
| `include_selected` | `true` | 当前选中的来源，含已完成项的更新 |
| `include_outdated` | `false` | 对应 Adapter 已升版的结果 |
| `keep_previous` | `false` | 保留旧结果，另生成新档；`false` 时覆盖仍须满足第九章的安全条件 |

前三项取并集去重。

### 3.2 只在运行内 〔常规〕

阅览室的思考与工具展开 / 隐藏、用户 / 智能 / 过程导航筛选、当前分支：不落盘，重启重置。

### 3.3 示例 〔核心〕

初始化后的完整文件：

```json library
{
  "cloudig_standard": "1.0",
  "schema": "cloudig/library/1.0.1",
  "schemas": {
    "library": "1.0.1",
    "identity": "1.0.0",
    "content_time": "1.0.0",
    "conversation": "1.0.1",
    "mark": "1.0.0"
  },
  "edited_at": "2026-09-16T12:00:00Z",
  "settings": {
    "language": "zh-CN",
    "theme": "Dawn",
    "theme_guide_completed": false,
    "default_output_directory": "Conversations",
    "time_type": { "archiver": "file_modified_at", "reader": "file_modified_at", "claude_json": "conversation_updated_at" },
    "sort": { "parser": "time_desc", "archiver": "time_desc", "reader": "time_desc", "claude_json": "time_desc" },
    "one_click_parse": {
      "parser": { "include_unparsed": true, "include_selected": true, "include_outdated": false, "keep_previous": false },
      "claude_json": { "include_unparsed": true, "include_selected": true, "include_outdated": false, "keep_previous": false }
    }
  }
}
```

<details>
<summary>〔折叠〕3.4 校验规则</summary>

- 全部字段必填；拒绝未声明的属性。
- `schema`、`schemas.*` 为常量；任一不符，拒开。
- `default_output_directory` 匹配 `^Conversations(?:/[^/]+)*$`。
- 文件丢失：恢复默认，不重造身份、时间节点，不清其他文件。

机器 Schema：`src/core/records/schemas/library.schema.json`。

</details>

## 四 · 身份 Identity 〔核心〕

呈现 Front：一个名字，与宣称这个名字的人。名字与宣名者成组，一个呈现可有多组。宣名者可以是起名者（父母、公司），可以是宣称某呈现是某身份的人，可以是用此名行动者。奥思的宣名者就是奥思。

同一种写法，三处保存：

| 位置 | 寻址 | 装什么 |
|---|---|---|
| `Identities/<front_id>.json` | UUID v7 | 本库的用户、智能伙伴、十二平台 |
| `Conversation.identity[]` | 本篇 `source_id` | 来源里实际发言的人、模型、工具、系统 |
| `Mark.models[]` | 无 ID | 用户对某篇对话的模型宣称，见 6.3 |

### 4.1 Front 字段 〔核心〕

| 字段 | 独立身份 | 来源 Front | 标记模型 | 意义 |
|---|---|---|---|---|
| `schema` | 必填 | 必填 | 必填 | 固定 `cloudig/identity/1.0.0` |
| `front_id` | 必填 | — | — | UUID v7 |
| `source_id` | — | 必填 | — | 本篇唯一的非空字符串，不要求 UUID |
| `names` | 必填，可空 | 必填，可空 | 必填，≥ 1 | 名字与宣名者的组 |
| `display_name` | 可选 | 可选 | 必填 | 显示第几组名字，从 1 起，≤ `names` 长度 |
| `kind` | 必填 | 必填 | 固定 `terran / ai` | 世界属性与视角分类 |
| `role` | 可选 | 必填 | 固定 `assistant` | 职责：`user`、`assistant`、`tool`、`system`…… |
| `image` | 可选 | 可选 | 可选 | `Identities/Images/` 下的相对路径 |
| `created_at` | 必填 | 可选 | 必填 | 创建 |
| `edited_at` | 必填 | 可选 | 必填 | 最后修改 |

`names[]` 每组：

| 字段 | 条件 | 意义 |
|---|---|---|
| `name` | 必填，非空，≤ 1024 | 名字 |
| `claimers` | 必填，数组，可空 | 宣名者。来源未知则空，不编造 |
| `claimers[].front` | 与 `name` 二选一 | 引用另一 Front：独立身份与标记用 UUID；来源 Front 用本篇 `source_id`。可自指 |
| `claimers[].name` | 与 `front` 二选一，≤ 1024 | 只有可读署名时用，如平台公司 |

`kind`：

| 维度 | 取值 |
|---|---|
| `world` | `terran` 此地 / `sovereign` 独立 |
| `subject` | `human` 人 / `ai` 人工智能 / `other_intelligence` 其他智能 / `life` 生物 / `animistic` 泛灵 / `object` 物 / `program` 代码程序 / `meaning_work` 意义织体 / `organization` 组织 |

`role` 为 `tool` 或 `system` 时，`kind` 固定 `terran / program`——V1 定为程序：现实平台的工具调用绝大多数是傻功能。

### 4.2 显示绑定 `identity-settings.json` 〔核心〕

位置 `Identities/identity-settings.json`。只记各位置当前用哪个独立 Front，不存名字。

| 字段 | 条件 | 意义 |
|---|---|---|
| `schema` | 必填 | 固定 `cloudig/identity-settings/1.0.0` |
| `edited_at` | 必填 | 最后修改 |
| `subject` | 必填，UUID | 用户 Front。其 `created_at` 是首次建库时间 |
| `assistant` | 必填，UUID | 总智能伙伴 Front |
| `apply_assistant_to_all` | 必填，布尔；默认 `false` | 总智能伙伴设置应用到全部平台 |
| `platforms.<键>` | 十二项必填，UUID | 各平台 Front |

初始化生成 14 个独立 Front：用户、总智能伙伴各自随机 UUID，十二平台固定 UUID，每座库相同：

| 键 | 平台 | 预设名字 ← 宣名者 | `front_id` |
|---|---|---|---|
| `chatgpt` | ChatGPT | ChatGPT ← OpenAI | `01a0aac8-552c-7af9-a87e-2c52ea363c5e` |
| `claude` | Claude | Claude ← Anthropic | `01a0aac8-552d-71af-ab22-054d36bcf8f6` |
| `deepseek` | DeepSeek | DeepSeek ← DeepSeek | `01a0aac8-552d-74da-a60d-bc7b1dd218a4` |
| `gemini` | Gemini | Gemini ← Google | `01a0aac8-552d-722b-b043-3db3293584d9` |
| `grok` | Grok | Grok ← xAI | `01a0aac8-552d-7a9e-8a49-63a007d46f0e` |
| `doubao` | 豆包 | 豆包 ← 字节跳动 | `01a0aac8-552d-732d-b8e2-b058c81149eb` |
| `kimi` | Kimi | Kimi ← 月之暗面 | `01a0aac8-552d-7fae-a90c-0b9508fb0a1c` |
| `qwen` | Qwen | Qwen ← 阿里巴巴 | `01a0aac8-552d-778d-b3f0-f359bf6bde36` |
| `chatglm` | ChatGLM | ChatGLM ← 智谱 | `01a0aac8-552d-70da-ba97-8e9f031df267` |
| `zai` | Z.ai | Z.ai ← 智谱 | `01a0aac8-552d-7e72-a628-b4b8e6db17cb` |
| `yuanbao` | 腾讯元宝 | 元宝 ← 腾讯 | `01a0aac8-552d-7d6f-905c-36727bcc5e2a` |
| `mistral` | Mistral | Mistral ← Mistral AI | `01a0aac8-552d-7c6f-8564-d6fdf74b18ed` |

固定的是来源网站的平台身份，不是公司：ChatGLM 与 Z.ai 分开。各库对平台的昵称、头像、时间独立，UUID 相同不同步。用户与总智能伙伴默认 `names` 为空，界面显示"采云用户 / 智能伙伴"或"User / AI"；默认头像随程序。

### 4.3 显示优先级 〔重要〕

名字与头像分别解析，同一顺序：

- 用户：标记 `names.user` → 用户 Front 所选名字 → 默认。
- 智能伙伴：标记 `names.assistant` → `apply_assistant_to_all` 为 `false` 时，平台 Front 已设值 → 总智能伙伴已设值 → 平台预设；为 `true` 时，总智能伙伴已设值 → 平台预设。
- 自定义头像失效，回默认头像，名字不受影响。
- `platform` 不在十二键内：平台显示"未知"加问号图标；智能伙伴称呼取总智能伙伴已设值，否则默认；模型标签照对话 `identity`。

### 4.4 解析时的身份 〔重要〕

- 每个实际发言者、模型、工具、系统各一项来源 Front，`source_id` 本篇唯一。
- 来源逐消息给了型号，`name` 用型号；没给，用平台通用名，如 Claude。页首当前选中的模型不是历史消息的证据；不从标题猜。
- 工具调用块的 `recipient` 是工具；结果块的 `speaker` 是工具。一次调用的 ID 不是工具的身份。
- 用户改模型：写标记 `models`，宣名者为用户。删掉，回平台宣称。
- 同名不合并；本库用户不等于所有 `role: user`。

### 4.5 身份系统全貌 〔常规〕

V1.0 实现呈现与显示绑定。以下出自原稿，V2.0 展开，本版不建字段：

- 视角 Subject 是特殊的呈现。叙事者与伴生是特殊的关系。
- 形象 Image：V1 即头像。职责角色 Role：可选。
- 关系 Relation：叙事关系（叙事者 Narrator——写下叙事、对话、标记的意志；叙事主角 Protagonist——叙事中的行动者，均可自指）；伴生 Interweave（是否伴生者，伴生主——一个人写他的汽车，汽车是伴生者）；所属组织；个体间关系（血缘、家庭、浪漫、朋友、事业、独立）；关系名的宣称者。
- 相关对话、叙事、标记、时间索引。

### 4.6 示例 〔核心〕

用户 Front，自己宣称自己的名字：

```json identity
{
  "schema": "cloudig/identity/1.0.0",
  "front_id": "01a0aa16-8e00-7586-ab0a-39a8509feb35",
  "names": [
    { "name": "刘姥姥", "claimers": [{ "front": "01a0aa16-8e00-7586-ab0a-39a8509feb35" }] }
  ],
  "display_name": 1,
  "kind": { "world": "terran", "subject": "human" },
  "role": "user",
  "image": "Identities/Images/9f2c1e7ab4d6c0a2e8b3f5d7c9a1b3e5f7d9c1a3b5e7f9d1c3a5b7e9f1d3c5a7.png",
  "created_at": "2026-09-16T12:00:00Z",
  "edited_at": "2026-09-16T12:10:00Z"
}
```

显示绑定：

```json identitySettings
{
  "schema": "cloudig/identity-settings/1.0.0",
  "edited_at": "2026-09-16T12:00:00Z",
  "subject": "01a0aa16-8e00-7586-ab0a-39a8509feb35",
  "assistant": "01a0aa1a-3780-78b9-b15a-90eeebf28493",
  "apply_assistant_to_all": false,
  "platforms": {
    "chatgpt": "01a0aac8-552c-7af9-a87e-2c52ea363c5e",
    "claude": "01a0aac8-552d-71af-ab22-054d36bcf8f6",
    "deepseek": "01a0aac8-552d-74da-a60d-bc7b1dd218a4",
    "gemini": "01a0aac8-552d-722b-b043-3db3293584d9",
    "grok": "01a0aac8-552d-7a9e-8a49-63a007d46f0e",
    "doubao": "01a0aac8-552d-732d-b8e2-b058c81149eb",
    "kimi": "01a0aac8-552d-7fae-a90c-0b9508fb0a1c",
    "qwen": "01a0aac8-552d-778d-b3f0-f359bf6bde36",
    "chatglm": "01a0aac8-552d-70da-ba97-8e9f031df267",
    "zai": "01a0aac8-552d-7e72-a628-b4b8e6db17cb",
    "yuanbao": "01a0aac8-552d-7d6f-905c-36727bcc5e2a",
    "mistral": "01a0aac8-552d-7c6f-8564-d6fdf74b18ed"
  }
}
```

<details>
<summary>〔折叠〕4.7 校验规则</summary>

- 拒绝未声明的属性。独立身份禁止 `source_id`；来源 Front 禁止 `front_id`；标记模型两者都禁止。
- `display_name` ≤ `names` 长度：`Selected name is outside names`。
- `claimers[].front`：独立身份与标记须是 UUID 形状；来源 Front 须在本篇 `identity` 中存在：`Claimer must reference an identity in the applicable scope`。不检查独立身份的 `front` 所指文件是否存在。
- `image` 在 `Identities/Images/` 下：`User images belong under Identities/Images`。不检查图片是否在磁盘。
- `role` 为 `tool` / `system` 则 `kind` 为 `terran / program`。
- `identity-settings.json`：全部字段必填，十二平台键一个不少。

机器 Schema：`identity.schema.json`、`identity-settings.schema.json`，共用结构在 `common.schema.json` 的 `name`、`kind`、`sourceFront`、`modelFront`。预设：`src/core/records/front-presets.json`。

</details>

## 五 · 对话 Conversation 〔核心〕

来源的原件。一份普通 HTML，或一个 JSON 容器里的一条记录，各生成一份对话；相同 URL、标题、平台会话 ID 不自动合档。位置 `Conversations/` 或 `Archives/` 下任意深度，文件名可读，身份看 `conversation_id`。

### 5.1 顶层字段 〔核心〕

| 字段 | 条件 | 类型 | 意义 |
|---|---|---|---|
| `schema` | 必填 | 固定 `cloudig/conversation/1.0.1` | 格式；兼容读取 `1.0.0` |
| `conversation_id` | 必填 | UUID v7 | 对话的身份 |
| `parser` | 必填 | 对象 | 生成它的解析器与 Adapter，见 5.2 |
| `lifecycle` | 必填 | 对象 | 三个程序写入时间，见 5.2 |
| `source` | 必填 | 对象 | 来源文件事实，见 5.3 |
| `platform` | 必填 | 非空字符串 | 平台键，见 5.4 |
| `title` | 可选，至少一项 | 对象 | `filename` 首次解析时的文件名去扩展名；`original` 平台原标题。各 ≤ 4096 码点 |
| `models` | 可选 | 唯一字符串数组 | 有来源证据的模型汇总 |
| `message_time` | 可选 | 对象 | `start` 必填、`end` 可选，UTC；消息时间范围 |
| `identity` | 必填，可空 | 来源 Front 数组 | 本篇发言者、模型、工具、系统，字段见 4.1 |
| `messages` | 必填 | 对象 | `current` 可选，默认末节点，须在 `items` 中；`items` 必填可空，消息数组 |
| `resources` | 可选 | 数组 | 图片、文件、图表 |
| `references` | 可选 | 数组 | 网页、记忆、过去对话 |
| `limitations` | 可选 | 数组 | 来源或表示的限制 |

### 5.2 parser、lifecycle 〔重要〕

| 字段 | 意义 |
|---|---|
| `parser.version` | 解析器总版本 |
| `parser.adapter.id` | 本次采用的 Adapter |
| `parser.adapter.version` | 该 Adapter 的版本 |
| `lifecycle.first_parsed_at` | 首次生成。重解析保留 |
| `lifecycle.last_parsed_at` | 最近一次成功解析 |
| `lifecycle.cloudig_edited_at` | 采云最近一次实际写此文件 |

全部必填，非空字符串或 UTC。"已过时"看本篇 Adapter 的版本，不看总版本。改标记不动这三个时间。

### 5.3 source 〔重要〕

| 字段 | 条件 | 意义 |
|---|---|---|
| `file` | 必填 | 原文件名，不含目录 |
| `sha256` | 必填 | 原文件字节指纹 |
| `bytes` | 必填，非负整数 | 原文件大小 |
| `format` | 必填 | 输入格式，如 `exporter-html`、`json-container` |
| `profile` | 可选 | 书签档位：`light` / `full` / `tree` |
| `exporter.id` / `exporter.version` | 可选，同有 | 导出器与当时版本，不是本机最新 |
| `url` | 可选 | 原会话地址 |
| `locator` | 可选 | 容器内记录的定位 |
| `captured_at` / `captured_from` | 可选，同有同无 | 采集时间与依据 |
| `conversation_created_at` / `conversation_updated_at` | 可选 | 来源给出的会话创建 / 更新时间 |

`captured_from` 四种：`bookmark:<字段>`（HTML 里书签记的时间，如 `bookmark:manifest.captured_at`）、`source_json:<字段>`、`filesystem:creation_time`、`filesystem:last_write_time`。来源自带时间用来源；否则取文件创建与修改时间较早者，并记下取的是哪一个。

### 5.4 platform 〔重要〕

任意非空字符串。十二个键有预设身份与头像（4.2）；其他值显示"未知"加问号图标，对话照常读、照常编辑。

### 5.5 messages 〔核心〕

| `items[]` 字段 | 条件 | 意义 |
|---|---|---|
| `id` | 必填，本篇唯一 | 消息 |
| `parent` | 可选 | 直接父消息。来源省略的父可以不存在 |
| `speaker` | 有内容则必填 | 引用 `identity[].source_id` |
| `timestamp` | 可选，UTC | 消息时间 |
| `content` | 必填，可空 | 内容块数组，见 5.6 |

父链不成环。多个根、连续多条 AI 消息、工具消息都合法。同父分支在原位切换；阅览室临时切分支不改 `current`。

### 5.6 内容块 〔核心〕

每块必有 `type`；可有 `speaker`、`recipient`（引用本篇 Front）。`speaker` 不写则继承外层块或消息。

| `type` | 字段 | 规则 |
|---|---|---|
| `text` / `markdown` | `text` 必填，可空 | 纯文本 / Markdown |
| `code` | `code` 必填，可空；`language`、`filename` | 代码 |
| `math` | `tex`、`mathml` 至少一项；`display` 布尔 | 公式；`display` 为块级 |
| `html` | `html` 必填；`label` | 原位 HTML，保存不等于执行 |
| `reasoning` / `reasoning_summary` / `status` | `title`、`text`、`duration`、`effort`、`content` 至少一项；`format` 可选 | 思考 / 摘要 / 状态；`text` 与嵌套 `content` 不同时写；`duration` 秒；只有 `format` 不合法 |
| `image` | `resource` 必填；`alt`、`caption`、`purpose` | 图片，引用资源 |
| `attachment` | `resource` 必填；`text` | 附件 |
| `search` | `query`、`references`、`status`、`duration` | 检索；`references` 为引用 ID 数组 |
| `citations` | `references` 必填；`label` | 引用列表 |
| `tool` | `kind` 必填：`call` / `result` / `activity`；`call`、`title`、`status`、`success`、`duration`、`input`、`output`、`input_resource`、`output_resource` | 工具。`input` / `output` 任意 JSON |
| `diagram` | `format` 必填；`source`、`rendered`、`html` 至少一项 | 图表，如 `mermaid` |
| `interactive` | `display`、`source`、`format` 必填；其余见下表 | Box／Window，始于 `1.0.1` |
| `unknown` | `kind` 必填；`text`、`resource`、`html` 至少一项 | 未识别的内容，不做空壳 |

工具调用：`call` 块由 AI 发出，`recipient` 是工具；`result` 块的 `speaker` 是工具；两块用同一个 `call` 配对。

#### Box／Window

Box 在对话内嵌显示，Window 点击后在较大窗口中显示。它们是呈现方式，不是某个平台的专属类型。

| 字段 | 条件 | 意义与规则 |
|---|---|---|
| `type` | 必填 | 固定 `interactive` |
| `speaker`、`recipient` | 可选 | 沿用内容块的身份引用规则 |
| `display` | 必填 | `box` / `window` |
| `source` | 必填 | 单字符串：`具体网站或产品_原生类型`，如 `claude.ai_visualize`、`claude.ai_artifact`；不是模型名，也不是顶层的来源文件 `source` 对象 |
| `title` | 可选 | 标题，遵守标题长度常数 |
| `format` | 必填 | `structured` / `html` / `react` / `svg` / `document` / `slides` / `design` / `design-system` |
| `data` | `structured` 必填，其余可选 | 原生结构化数据对象；具体字段由 `source` 所指的类型决定 |
| `files` | 非 `structured` 必填 | 非空文件数组；文件字节只存于本篇 `resources`，此处不复制 |
| `files[].path` | 每项必填 | 作品内唯一的相对虚拟路径；禁止绝对路径、空段、`.` / `..`、反斜杠、控制字符和 `: # ? %` |
| `files[].resource` | 每项必填 | 本篇资源 ID |
| `entry` | 非 `structured` 必填 | 必须等于本块某一项 `files[].path` |
| `preview` | 可选 | 本篇图片资源 ID |

结构化卡片保存原生输入、结果及资源绑定；Reader 按已接入的类型呈现，未知类型保留为可读数据。作品源码及文件仍属于原会话，运行副本不改写它们。普通 `code` 或 `html` 块不会因为语言标记而变成可执行作品。

### 5.7 resources 〔重要〕

| 字段 | 条件 | 意义 |
|---|---|---|
| `id` | 必填，本篇唯一 | 资源 |
| `kind` | 必填 | `image` / `audio` / `video` / `file` / `diagram` / `other` |
| `availability` | 必填 | `embedded` 内嵌 / `external` 外链 / `metadata_only` 仅元数据 / `missing` 缺失 |
| `name` | 可选 | 可读名 |
| `mime` / `bytes` / `sha256` | 内嵌必填，其余可选 | 本体的类型、大小、指纹 |
| `data_base64` | 内嵌且 `bytes` > 0 必填 | Base64 段数组：逐段解码再拼 |
| `url` | 外链必填 | 外部地址 |
| `dimensions.width` / `.height` | 可选，同有，正整数 | 像素 |
| `original.name` / `.mime` / `.url` / `.bytes` / `.sha256` | 可选，至少一项 | 转换前的资源事实 |

非内嵌不带 `data_base64`。内嵌的解码总字节与 SHA 必须相符。轻装未带本体是 `metadata_only`，不是损坏。

### 5.8 references、limitations 〔重要〕

| 对象 | 字段 | 意义 |
|---|---|---|
| `references[]` | `id` 必填，本篇唯一；`kind` 必填：`web` / `past_chat` / `saved_memory` / `file` / `other`；`title`、`url`、`snippet`、`text`、`name` 可选 | 被引用的东西 |
| `limitations[]` | `code` 必填；`at` 可选，空或 `/` 起的 JSON 指针；`detail` 可选 | 来源或表示的限制。`code` 开放字符串 |

AI 在原站说"出错了"是正文；采云与导出器自己的诊断进系统日志，不进这里。

### 5.9 显示 〔常规〕

- 标题：标记 `conversation_title` → `title.filename` → `title.original` → 未命名。
- 思考与工具默认折叠；只有"思考了几秒"没有正文的不做可展开面板。
- 特殊呈现的值：`reasoning*.format` 为 `markdown` 按 Markdown、`html` 按清洗后的富文本，其他按文本；`image.purpose` 为 `attachment-thumbnail` 紧凑缩略、`search-result` 挂原链接；`diagram.format` 为 `mermaid` 本地渲染，优先 `rendered`，其次 `html`，再 `source`；工具名 `schedule` 配合 `input.kind` 生成任务卡。其余值按普通文字。

### 5.10 示例 〔核心〕

以下保留 `1.0.0` 示例，当前程序仍可读取；含 Box／Window 的记录使用 `1.0.1`。

书签导出、轻装、一次工具调用：

```json conversation
{
  "schema": "cloudig/conversation/1.0.0",
  "conversation_id": "01a0aa17-7860-710e-9b32-f03bd26f504b",
  "parser": { "version": "1.1.4", "adapter": { "id": "claude-light-dom-v1", "version": "3.0.1" } },
  "lifecycle": {
    "first_parsed_at": "2026-09-16T12:01:00Z",
    "last_parsed_at": "2026-09-16T12:01:00Z",
    "cloudig_edited_at": "2026-09-16T12:01:00Z"
  },
  "source": {
    "file": "刘姥姥进大观园.html",
    "sha256": "3b1f4d9e7c2a5b8d0f6e1c3a9d7b5f2e4c6a8b0d2f4e6c8a0b2d4f6e8a0c2e4f",
    "bytes": 184320,
    "format": "exporter-html",
    "profile": "light",
    "exporter": { "id": "claude-light", "version": "1.1.55" },
    "url": "https://claude.ai/chat/example",
    "captured_at": "2026-09-16T11:58:00Z",
    "captured_from": "bookmark:manifest.captured_at"
  },
  "platform": "claude",
  "title": { "filename": "刘姥姥进大观园", "original": "刘姥姥进大观园" },
  "message_time": { "start": "2026-09-16T11:50:00Z", "end": "2026-09-16T11:51:00Z" },
  "identity": [
    {
      "schema": "cloudig/identity/1.0.0",
      "source_id": "user-01",
      "names": [],
      "kind": { "world": "terran", "subject": "human" },
      "role": "user"
    },
    {
      "schema": "cloudig/identity/1.0.0",
      "source_id": "assistant-01",
      "names": [{ "name": "Claude", "claimers": [{ "name": "Anthropic" }] }],
      "display_name": 1,
      "kind": { "world": "terran", "subject": "ai" },
      "role": "assistant"
    },
    {
      "schema": "cloudig/identity/1.0.0",
      "source_id": "tool-web-search",
      "names": [{ "name": "web_search", "claimers": [{ "name": "Anthropic" }] }],
      "display_name": 1,
      "kind": { "world": "terran", "subject": "program" },
      "role": "tool"
    }
  ],
  "messages": {
    "current": "m4",
    "items": [
      {
        "id": "m1",
        "speaker": "user-01",
        "timestamp": "2026-09-16T11:50:00Z",
        "content": [{ "type": "text", "text": "刘姥姥进大观园那回，凤姐往她头上插了什么？" }]
      },
      {
        "id": "m2",
        "parent": "m1",
        "speaker": "assistant-01",
        "content": [
          { "type": "reasoning_summary", "title": "查第四十回原文", "duration": 3 },
          { "type": "tool", "kind": "call", "call": "c1", "recipient": "tool-web-search", "input": { "query": "红楼梦 第四十回 凤姐 刘姥姥 插花" } }
        ]
      },
      {
        "id": "m3",
        "parent": "m2",
        "speaker": "tool-web-search",
        "content": [
          { "type": "tool", "kind": "result", "call": "c1", "success": true, "output": { "hits": 1, "top": "凤姐……将一盘子花横三竖四的插了一头" } }
        ]
      },
      {
        "id": "m4",
        "parent": "m3",
        "speaker": "assistant-01",
        "timestamp": "2026-09-16T11:51:00Z",
        "content": [
          { "type": "markdown", "text": "第四十回。凤姐把一盘子花**横三竖四**插了她一头。刘姥姥说：\"我这头也不知修了什么福，今儿这样体面起来。\"" },
          { "type": "citations", "references": ["ref-1"] }
        ]
      }
    ]
  },
  "references": [
    { "id": "ref-1", "kind": "web", "title": "红楼梦·第四十回 史太君两宴大观园 金鸳鸯三宣牙牌令", "url": "https://example.org/hongloumeng/40" }
  ]
}
```

资源与限制，轻装档位下的附件与外链图：

```json conversation
{
  "schema": "cloudig/conversation/1.0.0",
  "conversation_id": "01a0aa1a-3780-78b9-b15a-90eeebf28493",
  "parser": { "version": "1.1.4", "adapter": { "id": "chatgpt-light-items-v2", "version": "3.0.0" } },
  "lifecycle": {
    "first_parsed_at": "2026-09-16T12:05:00Z",
    "last_parsed_at": "2026-09-16T12:05:00Z",
    "cloudig_edited_at": "2026-09-16T12:05:00Z"
  },
  "source": {
    "file": "大观园平面图.html",
    "sha256": "a7c9e1f3b5d7092a4c6e8f0b2d4a6c8e0f2b4d6a8c0e2f4b6d8a0c2e4f6b8d0a",
    "bytes": 65536,
    "format": "exporter-html",
    "profile": "light"
  },
  "platform": "chatgpt",
  "identity": [
    { "schema": "cloudig/identity/1.0.0", "source_id": "u", "names": [], "kind": { "world": "terran", "subject": "human" }, "role": "user" },
    { "schema": "cloudig/identity/1.0.0", "source_id": "a", "names": [{ "name": "ChatGPT", "claimers": [{ "name": "OpenAI" }] }], "kind": { "world": "terran", "subject": "ai" }, "role": "assistant" }
  ],
  "messages": {
    "items": [
      { "id": "m1", "speaker": "u", "content": [
        { "type": "text", "text": "按这份平面图，说说大观园的布局。" },
        { "type": "attachment", "resource": "r-plan", "text": "大观园平面图.pdf" }
      ] },
      { "id": "m2", "parent": "m1", "speaker": "a", "content": [
        { "type": "image", "resource": "r-map", "alt": "大观园布局示意" },
        { "type": "text", "text": "正门在南，沁芳亭桥居中……" }
      ] }
    ]
  },
  "resources": [
    { "id": "r-plan", "kind": "file", "availability": "metadata_only", "name": "大观园平面图.pdf", "mime": "application/pdf", "bytes": 2457600 },
    { "id": "r-map", "kind": "image", "availability": "external", "url": "https://example.org/daguanyuan.png", "dimensions": { "width": 1600, "height": 1200 } }
  ],
  "limitations": [
    { "code": "chatgpt-unknown-item", "at": "/messages/items/1/content/0", "detail": "原页面的可缩放地图控件未保存" }
  ]
}
```

<details>
<summary>〔折叠〕5.11 校验规则</summary>

先形状，后语义。任一条不过，文件跳过。

| 规则 | 提示 |
|---|---|
| `identity[].source_id`、`resources[].id`、`references[].id`、`messages.items[].id` 各自本篇唯一 | `Duplicate local identifier` |
| `messages.current` 在 `items` 中 | `Default message is absent` |
| 有内容的消息必有 `speaker`，且在 `identity` 中 | `Actual message must reference a Front` / `Unknown Front` |
| 块的 `speaker` / `recipient` 在 `identity` 中 | `Unknown Front reference` |
| `call` 块的 `recipient` 是 `tool` 角色 | `Tool call target must have tool role` |
| `result` 块的有效 `speaker` 是 `tool` 角色 | `Tool result belongs to the tool Front` |
| `resource`、`input_resource`、`output_resource`、`rendered` 在 `resources` 中；`references` 在 `references` 中 | `Unknown resource reference` / `Unknown reference` |
| `parent` 链不成环 | `Message parent cycle` |
| 内嵌资源每段是规范 Base64，解码总字节与 SHA 相符 | `Noncanonical or invalid Base64` / `Embedded bytes and checksum must match` |
| 非内嵌资源无本体 | `Non-embedded resource cannot have a body` |
| `captured_from` 四种文法之一 | `Unknown capture time basis` |
| `source.file` 不含 `/`、`\` | `Source file is a basename, not a directory` |
| 全部 UTC 是真实日期 | `Expected a real UTC timestamp` |
| 来源 Front 的 `claimers[].front` 在本篇 `identity` 中 | `Claimer must reference an identity in the applicable scope` |

`parent` 指向来源省略的消息：合法，不补假父边。

</details>

<details>
<summary>〔折叠〕5.12 精确约束与现行取值</summary>

- `source.format` 现行写出 `exporter-html`、`json-container`。
- `parser.adapter.id` 现行 33 个，形如 `claude-light-dom-v1`、`anthropic-claude-export-json`；登记在 `src/adapters/parser/contracts/adapters.json`。
- `captured_from` 的书签字段现行四种：`manifest.captured_at`、`manifest.exported_at`、`payload.captured_at`、`payload.exported_at`。
- `limitations[].code` 现行由各 Adapter 写出，如 `source_parent_omitted`、`claude-public-thinking-truncated`、`gemini_image_fallback`、`kimi_message_outside_tree`；开放集合。
- `reasoning*.duration`、`search.duration`、`tool.duration` 为非负数，按秒。

机器 Schema：`src/core/records/schemas/conversation.schema.json`；语义校验 `src/core/records/semantics.mts`。

</details>

## 六 · 标记 Mark 〔核心〕

针对既成内容的意义赋值：标题、模型、双方称呼、内容时间。与对话分开存，重解析不覆盖它，它不改对话正文。

- 位置 `Marks/<mark_id>.json`，文件名即 UUID。
- 一篇对话至多一份。`target` 指向对话的 `conversation_id`；对话移目录、改文件名，标记不动。
- 四项赋值至少一项。全部清空则删除文件。

### 6.1 最小示例 〔核心〕

```json mark
{
  "schema": "cloudig/mark/1.0.0",
  "mark_id": "01a0aa18-62c0-7c7e-9c2e-760c23d93ffa",
  "target": "01a0aa17-7860-710e-9b32-f03bd26f504b",
  "edited_at": "2026-09-16T12:02:00Z",
  "conversation_title": "刘姥姥进大观园"
}
```

### 6.2 字段 〔重要〕

| 字段 | 条件 | 类型 | 意义 |
|---|---|---|---|
| `schema` | 必填 | 固定 `cloudig/mark/1.0.0` | 格式 |
| `mark_id` | 必填 | UUID v7 | 标记的身份 |
| `target` | 必填 | UUID v7 | 所标记对话的 `conversation_id` |
| `edited_at` | 必填 | UTC | 最后一次实际修改 |
| `conversation_title` | 可选 | 非空字符串，≤ 4096 | 标题。只改显示，不改文件名 |
| `models` | 可选 | 数组，可空 | 模型声明，见 6.3 |
| `names` | 可选 | 对象，至少一项 | 双方称呼 |
| `names.user` | 可选 | 非空字符串，≤ 1024 | 用户 |
| `names.assistant` | 可选 | 非空字符串，≤ 1024 | 智能伙伴 |
| `content_time` | 可选 | 对象 | 内容时间，见 6.5 |
| `content_time.range` | 有则必填 | 范围 | `start` 必填，`end` 可选 |

### 6.3 模型声明 `models` 〔重要〕

来源的模型写在对话的 `identity` 表，宣名者是平台或模型自己。标记里的模型是用户的宣称，宣名者是用户；删掉即回到平台的说法。

每项是一个呈现 Front，无独立 UUID：

| 字段 | 条件 | 类型 | 意义 |
|---|---|---|---|
| `schema` | 必填 | 固定 `cloudig/identity/1.0.0` | 呈现格式 |
| `names` | 必填，至少一项 | 数组 | 名字与宣名者 |
| `names[].name` | 必填 | 非空字符串 | 名字 |
| `names[].claimers` | 必填，至少一项 | 数组 | 宣名者 |
| `names[].claimers[].front` | 必填 | 用户的 `front_id` | 宣名者是用户 |
| `display_name` | 必填 | 正整数 | 显示第几组名字，从 1 起，≤ `names` 长度 |
| `kind` | 必填 | 固定 `{"world":"terran","subject":"ai"}` | 此地人工智能 |
| `role` | 必填 | 固定 `assistant` | 智能伙伴 |
| `image` | 可选 | `Identities/Images/` 下的相对路径 | 头像 |
| `created_at` | 必填 | UTC | 首次声明 |
| `edited_at` | 必填 | UTC | 最后修改 |

四项写全：

```json mark
{
  "schema": "cloudig/mark/1.0.0",
  "mark_id": "01a0aa19-4d20-7235-b3fd-592ba2e83162",
  "target": "01a0aa17-7860-710e-9b32-f03bd26f504b",
  "edited_at": "2026-09-16T12:03:00Z",
  "conversation_title": "刘姥姥进大观园",
  "models": [
    {
      "schema": "cloudig/identity/1.0.0",
      "names": [
        { "name": "示例模型 2.6", "claimers": [{ "front": "01a0aa16-8e00-7586-ab0a-39a8509feb35" }] }
      ],
      "display_name": 1,
      "kind": { "world": "terran", "subject": "ai" },
      "role": "assistant",
      "created_at": "2026-09-16T12:03:00Z",
      "edited_at": "2026-09-16T12:03:00Z"
    }
  ],
  "names": { "user": "刘姥姥", "assistant": "凤姐" },
  "content_time": {
    "range": {
      "start": { "kind": "unknown" }
    }
  }
}
```

`01a0aa16-…` 是本库用户的 `front_id`（第四章）。内容时间"不知何时"：朝代年纪无考。

### 6.4 缺席、空、清空 〔重要〕

| 状态 | 意义 |
|---|---|
| 无标记，或无 `models` | 模型照来源 |
| `"models": []` | 不认具体型号，回平台通用名（如 Claude）。这是设置，不是没设 |
| `models` 非空 | 显示用户声明的模型 |
| 无 `conversation_title` | 首次文件名 → 平台原标题 → 未命名 |
| `names` 缺一方 | 该方回全局与平台默认 |
| 无 `content_time` | 未设置。不用解析时间、消息时间顶替 |

清空某项即不写该项。四项都不写，删除文件。`"models": []` 算写了。

### 6.5 内容时间 〔重要〕

内容属于何时。与发送、下载、解析时间无关。`range.start` 必填，`end` 可选：单端是时间点，双端是时间段。起点晚于终点合法，界面提醒，不替换。

每端二选一。

**此地时间值。** 公历、年代、世纪、单位年前后、现今、四个特殊值之一，不另建节点。全部形态见第七章。哈利在霍格沃茨的七年：

```json range
{
  "start": { "kind": "calendar", "era": "AD", "year": 1991, "month": 9, "day": 1 },
  "end":   { "kind": "calendar", "era": "AD", "year": 1998, "month": 6 }
}
```

精度即数据：起点到日，终点到月，不补。

**时间节点引用 + 快照。** 记下节点 UUID，抄一份当时可读的快照：名字、种类、所在轴、当时的此地范围。节点以后改了，标记仍显示选时的样子；"刷新锚点"只改这一份快照。

```json mark
{
  "schema": "cloudig/mark/1.0.0",
  "mark_id": "01a0aa1c-0c40-7376-8689-1bcc5a06b36c",
  "target": "01a0aa17-7860-710e-9b32-f03bd26f504b",
  "edited_at": "2026-09-16T12:06:00Z",
  "content_time": {
    "range": {
      "start": {
        "kind": "node",
        "target": {
          "node": "01a09091-c29d-78c0-8c02-936daa30027b",
          "timeline": "01a09091-c29c-7177-b237-40941de50264"
        },
        "snapshot": {
          "node": { "kind": "single", "name": "智能初晓" },
          "timeline": { "name": "采云此地时间轴", "author": "采云", "standard_name": "采云此地时间轴", "version": "1.0" },
          "sort": {
            "start": { "kind": "calendar", "era": "AD", "year": 2017, "month": 6, "day": 12 },
            "end": { "kind": "now", "anchor": { "date": "2026-09-16", "offset": "Z" } }
          }
        }
      }
    }
  }
}
```

智能初晓是预设之一，UUID 固定，每座库相同。`sort` 是排序用的此地范围；"现今"带锚点，记保存那天。

| 字段 | 条件 | 意义 |
|---|---|---|
| `kind` | 必填，固定 `node` | 引用节点 |
| `target.node` | 必填，UUID | 所选节点 |
| `target.timeline` | 可选，UUID | 选择时走的轴 |
| `target.occurrences` | 周期节点必填 | `first`、`step`、`last` |
| `snapshot.node.kind` | 必填 | `timeline` / `single` / `periodic` |
| `snapshot.node.name` | 必填 | 当时的名字 |
| `snapshot.node.count` / `prefix` / `unit` | 周期节点才有 | 当时的总次数与显示规则 |
| `snapshot.timeline` | 有 `target.timeline` 则必填，否则不写 | 轴的名字、作者；可带标准名、版本 |
| `snapshot.path` | 可选，须有 `target.timeline` | 轴到节点的序数路径，从 1 起 |
| `snapshot.sort` | 可选 | 当时的此地排序范围 |

### 6.6 写入与删除 〔常规〕

- `edited_at` 只在内容实际变化、或用户要求"更新时间戳 / 刷新锚点"时改。
- 列表的"采云最后编辑时间"取标记 `edited_at` 与对话 `lifecycle.cloudig_edited_at` 较晚者。
- 删对话，标记一起进 Windows 回收站。对话暂时找不到，标记保留。
- 一篇对话两份标记、两篇对话一个 UUID：全部保留，冲突组只读。

<details>
<summary>〔折叠〕6.7 校验规则</summary>

先形状，后语义；任一条不过，文件跳过。

形状：

- 拒绝未声明的属性；`names` 至少一项；`conversation_title` 非空。
- `models[]`：`schema`、`names`、`display_name`、`kind`、`role`、`created_at`、`edited_at` 必填；`kind` 固定 `terran / ai`；`role` 固定 `assistant`；不许 `front_id`、`source_id`。

语义：

| 规则 | 提示 |
|---|---|
| 四项赋值至少一项 | `An empty Mark has no user setting` |
| `models[].names` 每项至少一个宣名者，且都是 `front` 引用 | `User model claims must reference the user's Identity` |
| `display_name` ≤ `names` 长度 | `Selected name is outside names` |
| `image` 在 `Identities/Images/` 下 | `User images belong under Identities/Images` |
| UTC 是真实日期，无 0000 年 | `Expected a real UTC timestamp` |
| 公历写了日，该日真实存在（含闰年；公元前按 1−年 折算） | `Invalid calendar day` |
| `now`、`relative` 的锚点日期真实存在 | `Invalid anchor day` |
| `relative.value` 在 `0 < 值 ≤ 9999.0` | `Relative time must be greater than zero and at most 9999.0` |
| `end` 与 `start` 相同时不写 `end` | `Equal endpoints must be stored as start only` |
| `target.timeline` 与 `snapshot.timeline` 同有同无 | `Timeline reference and timeline snapshot must appear together` |
| 有 `snapshot.path` 须有 `target.timeline` | `A path requires its selected timeline` |
| 周期节点带 `occurrences`：`first ≤ last ≤ count`，`(last − first)` 被 `step` 整除 | `Period selection must stay in bounds and end on its step` |
| 非周期节点不带 `occurrences` | `Only periodic nodes carry occurrences` |

不检查 `target`、`claimers[].front`、`target.node` 所指对象是否存在，只看 UUID 形状。找不到对话的标记不生效；找不到节点的端点靠快照显示。

</details>

<details>
<summary>〔折叠〕6.8 精确约束</summary>

```text
UUID                  ^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
UTC                   ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$
relative.value        ^(?:0|[1-9][0-9]{0,3})\.[0-9]$
anchor.date           ^[0-9]{4}-[0-9]{2}-[0-9]{2}$
offset                ^(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$
版本（时间轴）        ^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$
first / step / last   整数 1—99,999,999
```

机器 Schema：`src/core/records/schemas/mark.schema.json`，引用 `common.schema.json` 的 `modelFront`、`range`、`endpoint`。

</details>

## 七 · 内容时间 ContentTime 〔核心〕

时间轴的核心：没有特定距离的序数轴、节点、映射，以及边界上限。

两类体系。此地时间 Terran Time：以地球公历为主轴。独立时间 Sovereign Time：自定义时间与意义。此地时间也可以抽象成一条独立时间轴。

两层数据。**时间值**直接写进标记；**节点**才在 `ContentTimes/<node_id>.json` 有文件。节点三种：`timeline` 时间轴、`single` 单独时间、`periodic` 周期时间，同一种格式。十七个预设是真节点：一条时间轴、四个特殊时间、十二段范围。

### 7.1 此地时间值 〔核心〕

按 `kind` 六选一，不混写。精度即数据：不填日就没有日，不填时区就是浮动时间。

| `kind` | 字段 | 规则 |
|---|---|---|
| `calendar` | `era` 必填 `AD` / `BC`；`year` 必填；`month`、`day`、`hour`、`minute`、`second` 可选，逐级依赖；`offset` 可选，须有月日 | 外推格里历，无公元 0 年，实际闰年。年份见常数表 |
| `decade` | `era`、`index` 必填 | 年代。`index` 202 = 2020 年代；BC 侧反向 |
| `century` | `era`、`index` 必填 | 世纪。`index` 21 = 2001—2100 年；BC 侧反向 |
| `relative` | `direction` 必填 `before` / `after`；`unit` 必填；`value` 必填，一位小数字符串；`anchor.date`、`anchor.offset` 必填 | 单位年前 / 后。前只用万、亿；后十级。锚点记保存那天 |
| `now` | `anchor.date`、`anchor.offset` 必填 | 现今。记保存那天，不随打开漂移 |
| `infinite_past` / `infinite_future` / `unknown` / `whenever` | 无 | 无限久前 / 无限久后 / 不知何时 / 无论何时 |

保存"X 年前 / 年后"与"现今"时记录当天日期为锚点；用户改了时间，或未改但明确要求更新锚点，锚点才变。

### 7.2 节点字段 〔核心〕

| 字段 | 条件 | 意义 |
|---|---|---|
| `schema` | 必填 | 固定 `cloudig/content-time/1.0.0` |
| `node_id` | 必填，UUID v7 | 节点的身份 |
| `kind` | 必填 | `timeline` / `single` / `periodic` |
| `name` | 必填，非空，≤ 1024 | 名字 |
| `author` | `timeline` 必填；其余不写；≤ 1024 | 作者名，可读文字 |
| `standard_name` | 仅 `timeline` 可选；≤ 1024 | 规范标准名 |
| `version` | 仅 `timeline` 可选 | `主.次` |
| `created_at` | `timeline` 必填；其余不写 | 创建 |
| `edited_at` | 必填 | 最后修改 |
| `forked_from` | 可选，UUID | 独立副本来自哪个节点，不能指自己 |
| `count` | `periodic` 必填；其余不写 | 总周期数 |
| `prefix` | 仅 `periodic` 可选；≤ 1024 | 周期项前缀；中文默认"第" |
| `unit` | 仅 `periodic` 可选；≤ 1024 | 周期项单位 |
| `display_empty` | 仅 `periodic` 可选 | 展开无映射的周期项；`true` 时 `count` ≤ 20 |
| `contains` | 可选 | 包含，见 7.3 |
| `counterparts` | 可选 | 对映，见 7.3 |
| `terran_mappings` | 可选 | 此地映射，见 7.3 |

### 7.3 三类关系 〔重要〕

**包含 `contains`**：节点 A 插入节点 B，B 为父。数组位置即从 1 起的局部序数。

| 字段 | 条件 | 意义 |
|---|---|---|
| `contains[].node` | 必填，UUID | 子节点 |
| `contains[].count` | 子节点为 `periodic` 时必填，1 ≤ N ≤ 子节点 `count`；其余不写 | 包含该周期的前 N 次 |

同一父不重复同一子；不同父可含同一子。允许成环，展开遇重复即止。

**对映 `counterparts`**：A 关联 B，互为别名。无方向，只存一端。

| 字段 | 条件 | 意义 |
|---|---|---|
| `counterparts[].occurrences` | 本节点 `periodic` 时必填；其余不写 | 本端周期选择 |
| `counterparts[].target.node` | 必填，UUID | 另一端 |
| `counterparts[].target.occurrences` | 目标 `periodic` 时必填；其余不写 | 对端周期选择 |

对映可传递；V1.0 界面只显示直接对映，排序沿对映链找此地映射。

**此地映射 `terran_mappings`**：节点对应的现实时间，可多条。

| 字段 | 条件 | 意义 |
|---|---|---|
| `terran_mappings[].range` | 必填 | `start` 必填、`end` 可选，均为 7.1 的此地值 |
| `terran_mappings[].edited_at` | 必填，UTC | 本条最后修改 |
| `terran_mappings[].occurrences` | 本节点 `periodic` 时必填；其余不写 | 适用的周期 |

多重映射保留，排序取最早起点那一段。起终点完全相同的两条不重复存。

**周期选择**：`{"all": true}` 全部，随 `count` 变化；或 `first` / `step` / `last` 等差选段，`first ≤ last ≤ count`，`(last − first)` 被 `step` 整除。`1 / 2 / 5` 是第 1、3、5 次。标记里只用等差选段，不用 `all`。

事件影响微弱时，是时间展开；影响增大，就变成时间对映。对映和展开是意志对时间价值认识的光谱两端。采云不约束用户设定的自洽性与语义。

### 7.4 顶层顺序 `order.json` 〔重要〕

位置 `ContentTimes/order.json`。`schema` 固定 `cloudig/content-time-order/1.0.0`；`edited_at` UTC；`nodes` 去重 UUID 数组，即顶层陈列顺序，可空。未列入的节点按最近编辑在前。

### 7.5 预设 〔重要〕

作者"采云"，标准名"采云此地时间轴"，版本 `1.0`。全部固定 UUID，每座库相同；进库即是本库的普通节点文件——可展开、可对映、可改时间；不换 `kind`，不删；四个特殊值不改成具体时间。

| 节点 | 范围 |
|---|---|
| 无论何时 | `whenever` |
| 不知何时 | `unknown` |
| 无限久前 | `infinite_past` |
| 大爆炸前 | 9999.0 亿年前 — 138.0 亿年前 |
| 宇宙诞生 | 138.0 亿年前 — 35.0 亿年前 |
| 生命起源 | 35.0 亿年前 — 31.5 万年前 |
| 史前文明 | 31.5 万年前 — 8 世纪 BC |
| 轴心时代 | 8 世纪 BC — 3 世纪 BC |
| 帝国兴亡 | 3 世纪 BC — 20 世纪 |
| 工业革命 | 18 世纪 — 20 世纪 |
| 硝烟铁幕 | 1910 年代 — 1990 年代 |
| 现代社会 | 1940 年代 — 现今 |
| 智能初晓 | 2017-06-12 — 现今 |
| 展望未来 | 现今 — 9999 年 |
| 万年之后 | 9999 年 — 1.0 正年后 |
| 无限久后 | `infinite_future` |

<details>
<summary>〔折叠〕预设 UUID</summary>

| 节点 | `node_id` |
|---|---|
| 采云此地时间轴 | `01a09091-c29c-7177-b237-40941de50264` |
| 无论何时 | `01a09091-c29c-7402-867c-ca7b2af6d596` |
| 不知何时 | `01a09091-c29c-7bd6-9bcb-74e61ef4c158` |
| 无限久前 | `01a09091-c29c-7a29-afa9-efee9d075b78` |
| 大爆炸前 | `01a09091-c29c-7c44-aab0-b8da7ee0951a` |
| 宇宙诞生 | `01a09091-c29c-748c-a189-d62f5b4091c8` |
| 生命起源 | `01a09091-c29c-799e-9241-baae49115b77` |
| 史前文明 | `01a09091-c29c-740a-bd86-d35c5ec70d35` |
| 轴心时代 | `01a09091-c29c-7f15-923a-05718f812fa4` |
| 帝国兴亡 | `01a09091-c29c-702e-b05f-3347a0f9316b` |
| 工业革命 | `01a09091-c29c-7589-9f58-0d8628dd6751` |
| 硝烟铁幕 | `01a09091-c29d-7fe2-a727-a70e6f3a491d` |
| 现代社会 | `01a09091-c29d-7386-b45f-29d7ba9a6be0` |
| 智能初晓 | `01a09091-c29d-78c0-8c02-936daa30027b` |
| 展望未来 | `01a09091-c29d-71ef-8692-08825ffca595` |
| 万年之后 | `01a09091-c29d-78c9-923e-5095d709333b` |
| 无限久后 | `01a09091-c29d-7b3b-9eb5-8ef49610e5ab` |

来源：`src/core/records/time-presets.json`。

</details>

### 7.6 编辑规则 〔常规〕

- 改已被引用的节点：先列影响范围。全部同步，原位更新；部分同步或不同步，建独立副本写 `forked_from`，旧节点保留，只改用户选中的标记。副本沿 `contains` 复制并按 UUID 去重，不沿对映扩张。
- 缩小周期数：不静默截断旧选择。
- 删除：列出关系与引用后确认；无引用不等于自动删除。
- 保存时内容未改：询问是否更新时间戳——它会移动"现今"与"单位年前 / 后"的锚点。
- 起点晚于终点：警告，放行，不交换。

### 7.7 排序 〔常规〕

四组，顺序固定，倒序不翻转组序：

| 组 | 起点 |
|---|---|
| 0 | 可映射到此地的值（含无限久前 / 后） |
| 1 | 无此地映射的独立节点 |
| 2 | 不知何时、无论何时 |
| 3 | 未设内容时间 |

- 组 0：每个值投影成一段闭区间，按下界、再上界比较。只填年就是整年；填到日就是整天；填到秒是一瞬。无时区的浮动时间两端各扩 14 小时。年代、世纪取整段。单位年前 / 后取锚点年份加减名义年数，半宽为该单位的 0.05。现今取锚点那一整天。
- 组 1：顶层陈列序号 → 根轴 UUID → 序数路径 → 周期选择 → 节点 UUID。
- 起点相同：无终点在前；再比终点。
- 全部相同：文件修改时间新者在前 → 标题 → `conversation_id` → 路径。
- 引用节点的标记按快照里的 `sort` 排，不实时追节点。

用分段比较，不把一切换算成浮点。

<details>
<summary>〔折叠〕排序公式</summary>

天文年 `y`：AD 的 Y → Y；BC 的 Y → 1 − Y。闰年：`y` 被 4 整除且不被 100 整除，或被 400 整除。

```text
D(y,m,d):                         # 自内部 0000-03-01 起的日序，floor 向负无穷
  a = y - (m <= 2 ? 1 : 0)
  e = floor(a / 400);  z = a - 400*e
  p = m + (m > 2 ? -3 : 9)
  q = floor((153*p + 2)/5) + d - 1
  return 146097*e + 365*z + floor(z/4) - floor(z/100) + q

S(y,m,d,h,mi,s) = D(y,m,d)*86400 + h*3600 + mi*60 + s     # BigInt
H = 14*3600
yearBand(first,last) = [S(first,1,1,0,0,0) - H, S(last,12,31,23,59,59) + H]
```

| 形态 | 区间 |
|---|---|
| calendar 年 / 年月 / 年月日 / 到时 / 到分 / 到秒 | 该年 / 月 / 日 / 时 / 分的首末秒；到秒则下界 = 上界。有 `offset` 减去偏移；无 `offset` 两端各扩 H |
| decade AD `i` | `yearBand(10i, 10i+9)`；BC：`yearBand(1−(10i+9), 1−10i)` |
| century AD `i` | `yearBand(100(i−1)+1, 100i)`；BC：`yearBand(1−100i, 1−(100(i−1)+1))` |
| relative | 单位指数 `e`，`q` = 去掉小数点的整数，`N = q × 10^(e−1)`，中心年 `C = 锚点年 ∓ N`，半宽 `G = 10^(e−1) / 2`，取 `yearBand(C−G, C+G)`。只用锚点年份 |
| now | 锚点当日整天，两端各扩 H。不读 `anchor.offset` |
| infinite_past / infinite_future | 排在一切有限值之前 / 之后 |

实现：`src/core/time/terran.mts`、`src/core/records/time-display.mts`。

</details>

### 7.8 示例 〔核心〕

**可映射到此地：哈利·波特。** 一条轴，包含七次的周期"学年"与单独时间"三强争霸赛"。

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa4d-7c80-721f-aa6f-834c226e592c",
  "kind": "timeline",
  "name": "霍格沃茨学年",
  "author": "示例",
  "version": "1.0",
  "created_at": "2026-09-16T13:00:00Z",
  "edited_at": "2026-09-16T13:00:00Z",
  "contains": [
    { "node": "01a0aa4e-66e0-7f7e-ba00-5476e3577428", "count": 7 },
    { "node": "01a0aa4f-5140-7b48-b0fe-7fc72bb22e15" }
  ]
}
```

周期"学年"，七次，第 1 次与第 7 次映射到公历：

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa4e-66e0-7f7e-ba00-5476e3577428",
  "kind": "periodic",
  "name": "学年",
  "edited_at": "2026-09-16T13:01:00Z",
  "count": 7,
  "prefix": "第",
  "unit": "学年",
  "display_empty": true,
  "terran_mappings": [
    {
      "range": {
        "start": { "kind": "calendar", "era": "AD", "year": 1991, "month": 9, "day": 1 },
        "end": { "kind": "calendar", "era": "AD", "year": 1992, "month": 6 }
      },
      "edited_at": "2026-09-16T13:01:00Z",
      "occurrences": { "first": 1, "step": 1, "last": 1 }
    },
    {
      "range": {
        "start": { "kind": "calendar", "era": "AD", "year": 1997, "month": 9, "day": 1 },
        "end": { "kind": "calendar", "era": "AD", "year": 1998, "month": 6 }
      },
      "edited_at": "2026-09-16T13:01:00Z",
      "occurrences": { "first": 7, "step": 1, "last": 7 }
    }
  ]
}
```

单独时间"三强争霸赛"：对映第 4 学年，并直接映射公历。

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa4f-5140-7b48-b0fe-7fc72bb22e15",
  "kind": "single",
  "name": "三强争霸赛",
  "edited_at": "2026-09-16T13:02:00Z",
  "counterparts": [
    { "target": { "node": "01a0aa4e-66e0-7f7e-ba00-5476e3577428", "occurrences": { "first": 4, "step": 1, "last": 4 } } }
  ],
  "terran_mappings": [
    {
      "range": {
        "start": { "kind": "calendar", "era": "AD", "year": 1994, "month": 10, "day": 30 },
        "end": { "kind": "calendar", "era": "AD", "year": 1995, "month": 6, "day": 24 }
      },
      "edited_at": "2026-09-16T13:02:00Z"
    }
  ]
}
```

**不可映射：红楼梦。** 朝代年纪无考。轴内只有先后，没有距离，没有此地映射。

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa50-3ba0-762c-b8a9-5b6487afd187",
  "kind": "timeline",
  "name": "红楼梦纪年",
  "author": "示例",
  "standard_name": "无朝代年纪可考",
  "version": "1.0",
  "created_at": "2026-09-16T13:03:00Z",
  "edited_at": "2026-09-16T13:03:00Z",
  "contains": [
    { "node": "01a0aa51-2600-7879-86e4-51005e8cecd1" },
    { "node": "01a0aa52-1060-7c38-9da7-af23ca7c75c5" },
    { "node": "01a0aa52-fac0-75cb-af67-6a93bf0a1d62", "count": 8 }
  ]
}
```

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa51-2600-7879-86e4-51005e8cecd1",
  "kind": "single",
  "name": "黛玉进府",
  "edited_at": "2026-09-16T13:04:00Z",
  "counterparts": [
    { "target": { "node": "01a0aa52-fac0-75cb-af67-6a93bf0a1d62", "occurrences": { "first": 1, "step": 1, "last": 1 } } }
  ]
}
```

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa52-1060-7c38-9da7-af23ca7c75c5",
  "kind": "single",
  "name": "刘姥姥二进荣国府",
  "edited_at": "2026-09-16T13:05:00Z"
}
```

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa52-fac0-75cb-af67-6a93bf0a1d62",
  "kind": "periodic",
  "name": "年",
  "edited_at": "2026-09-16T13:06:00Z",
  "count": 8,
  "prefix": "第",
  "unit": "年",
  "display_empty": true
}
```

顶层陈列：

```json contentTimeOrder
{
  "schema": "cloudig/content-time-order/1.0.0",
  "edited_at": "2026-09-16T13:07:00Z",
  "nodes": [
    "01a0aa50-3ba0-762c-b8a9-5b6487afd187",
    "01a0aa4d-7c80-721f-aa6f-834c226e592c"
  ]
}
```

<details>
<summary>〔折叠〕7.9 校验规则</summary>

单文件：

| 规则 | 提示 |
|---|---|
| `timeline` 必有 `author`、`created_at`；其余种类不写 `author`、`standard_name`、`version`、`created_at` | 形状 |
| `periodic` 必有 `count`；其余种类不写 `count`、`prefix`、`unit`、`display_empty` | 形状 |
| `contains[].node` 不重复 | `Duplicate local identifier` |
| `forked_from` ≠ `node_id` | `A new independent copy cannot fork from itself` |
| `display_empty` 为 `true` 时 `count` ≤ 20 | `Empty expansion exceeds the configured occurrence limit` |
| `periodic` 的每条关系带 `occurrences`，且在界内、落在步长上；非 `periodic` 不带 | `Periodic relation requires a selection` / `Nonperiodic relation has no occurrences` / `Period selection must stay in bounds and end on its step` |
| `terran_mappings[].range` 按 7.1 校验；两端相同只存 `start` | 同第六章 |
| `order.json` 的 `nodes` 不重复 | 形状 |

跨文件（读图时）：

| 规则 | 提示 |
|---|---|
| 节点 UUID 不重复 | `Duplicate time node UUID` |
| `contains` 指向的周期子节点须带 `count`，且 ≤ 子节点 `count`；非周期子节点不带 | `Included prefix is out of bounds` / `Only a periodic child has a prefix count` |
| 对映目标为周期时须带对端 `occurrences`，且合法；非周期不带 | `Periodic counterpart needs a selection` / `Nonperiodic counterpart has no selection` |
| 同一对映只存一次 | `The same counterpart relation must be stored once` |
| 指向不存在的节点 | `Missing referenced node` / `Missing counterpart`——读旧图报告并保留可读部分；新建关系不允许 |
| 新增与既有完全相同的此地范围 | `The same Terran start/end range is already mapped` |
| 预设节点：不改 `kind`，四个特殊值不改成具体时间，不按普通节点删除 | `A builtin time node keeps its original kind` |

包含成环、多父合法；展开去重，受 100,000 状态的计算预算约束，超出即报"未完成"，不返回假排序。

机器 Schema：`content-time.schema.json`、`content-time-order.schema.json`，时间值在 `common.schema.json`；图与快照计算 `src/core/records/time-graph.mts`。

</details>

## 八 · 叙事 Narrative 〔常规〕

原生的意义织体：用户手写的 system prompt、日记。标记是对既成内容的赋值，叙事是原生的书写。V1.0 不建文件、无版本项；V3.0 彩练当空展开。

## 九 · 程序持久格式与文件层 〔重要〕

### 9.1 可丢失性 〔重要〕

| 位置 | 装什么 | 丢了 |
|---|---|---|
| `cache/` | 运行中间物 | 无损；退出后删，运行中删会打断当前操作 |
| `appdata/indexes/` | 来源、对话、Claude 容器的索引 | 从文件重建，付一次读取成本 |
| `appdata/logs/parser-errors.json` | 当前来源的错误 | 下次解析重新产生 |
| `appdata/cloudig-device.json` | 本机 Chrome 书签安装目标 | 重新选择 |
| `appdata/parse-history/` | 来源与最近输出的对应 | 重解析不再覆盖旧档，只新增 |
| `appdata/parse-failures/` | 同内容、同能力水位下的失败次数 | 重新尝试 |
| `appdata/imports/` | 导入前观察到的原文件时间 | 采集时间证据没了 |
| `appdata/BookmarkBackups/` | 改 Chrome 书签前的完整备份，2 组 | 失去回退 |
| `appdata/transactions/` | 未完成的写入 | 失去中断恢复 |
| `appdata/recovery/` | 已完成写入的恢复点，2 组 | 失去回退 |
| `appdata/recycle/` | 进 Windows 回收站的意图 | 未完成的删除需人工查 |
| `appdata/Move/` | 整根搬家的请求与结果 | 中断的搬家需按两端实况处理 |

设置文件丢失，恢复默认，不动其他文件。索引可重建，但重建有成本，不因此自动删。

### 9.2 命名 〔重要〕

| 对象 | 规则 |
|---|---|
| 对话首次文件名 | `title.filename` → `title.original` → `Conversation`。`< > : " / \ \| ? *` 与控制字符换空格；去首尾空格与末尾点；Windows 保留设备名加 `_`；主干 ≤ 225，加 `.json` |
| 防重名 | 不覆盖。Windows 不分大小写比较；`名 (2).json`、`名 (3).json`…… |
| 导出 Markdown | 对话文件名换扩展名 `.md`，同防重名 |
| 标记、身份、时间节点 | `<UUID>.json` |
| 头像 | `Identities/Images/<sha256>.<png|jpg|gif|webp>` |
| 扩展名 | 对话须以小写 `.json` 结尾 |
| 嵌套 | `Conversations/`、`Archives/` 任意深度；其余固定在根层 |

### 9.3 重解析与覆盖 〔重要〕

- 覆盖旧档的条件：同一来源、用户选了更新、旧档未被外部改动。满足则原位覆盖，保留 `conversation_id` 与 `first_parsed_at`；不满足只新增，文件名加后缀。
- 覆盖不动标记。
- 同一来源内容、同一 Adapter 版本下的内容性失败两次，转为不支持；关机、强退等环境中断不计。来源变了或 Adapter 升了，重新判断。
- 已过时看本篇 Adapter 的版本。

### 9.4 外部修改 〔重要〕

- 采云运行中在外部改、增、删文件：刷新后按实际文件重列。
- 编辑页打开后文件被外部改动：保存被拒，提示重新打开；旧值不覆盖新文件。
- 重复 `conversation_id`、一篇对话多份标记：全部保留，冲突组只读。
- 缺引用的文件保留并报告，不改号、不删一方。

### 9.5 删除、归档、搬家 〔重要〕

- 删除对话：确认后连同标记进 Windows 回收站。不删 `Inbox/` 来源、身份、时间节点。
- 归档：移入 `Archives/`，不是删除。
- 清除解析记录、清空系统日志：只删记录，不删来源与对话。
- 整根搬家：整目录移到新位置，同卷改名或跨卷复制校验；不留两套数据。程序内搬家由程序协调退出。
- 手工复制、移动、删缓存：先正常退出采云，等当前写入结束。

<details>
<summary>〔折叠〕9.6 程序文件字典</summary>

| 文件 | `schema` | 内容 |
|---|---|---|
| `appdata/cloudig-device.json` | `cloudig/device-settings/1.0.0` | Chrome Bookmarks 文件路径、父目录 GUID、受管文件夹名（默认 `采云 Cloudig`）、是否置顶、安装 ID |
| `appdata/BookmarkBackups/<组>/backup-manifest.json` | `cloudig/chrome-bookmark-backup` `0.1.0` | 操作类型、触及的 Chrome 文件、修改前后 SHA |
| `appdata/parse-history/<来源键 SHA>.json` | `cloudig/parse-history/1.0.0` | 来源路径、格式、平台、`locator`；输出路径、`conversation_id`、SHA；解析器与 Adapter 版本；解析时间 |
| `appdata/parse-failures/<来源键 SHA>.json` | `cloudig/parse-failure/1.0.0` | 来源、源 SHA、能力水位 `adapter@version`、内容性失败次数、最近错误 |
| `appdata/indexes/sources.json` | `cloudig/source-index/1.1.0` | `Inbox/` 每个文件的大小、SHA、修改时间、变化指纹、格式、平台、缺失标记 |
| `appdata/indexes/conversations.json` | `cloudig/conversation-index/1.0.0` | 每份对话的变化指纹、SHA、去掉正文的头信息、消息数、资源数 |
| `appdata/indexes/claude/<路径 SHA>.json` | `cloudig/claude-index/1.0.0` | Claude 容器内每条记录的字节偏移、长度、SHA、标题、消息数、时间 |
| `appdata/imports/<路径 SHA>.json` | `cloudig/source-import/1.0.0` | 导入前观察的采集时间与依据 |
| `appdata/logs/parser-errors.json` | `cloudig/parser-error-index/1.0.0` | 按来源单位的错误：`exporter` / `parser` / `canonical`，消息 ≤ 4096 |
| `appdata/transactions/<操作 ID>/journal.json` | `cloudig/record-transaction/1.0.0` | 写入前后 SHA、读取前提、移动；状态 `prepared` / `installing` / `completed` |
| `appdata/recovery/<操作 ID>/` | 同上 | 完成后的事务与改动前原字节 |
| `appdata/recycle/<操作 ID>.json` | `cloudig/recycle/1.0.0` | 待进回收站的对话与标记：路径、字节、SHA |
| `appdata/Move/request.json` / `result.json` | `cloudig/library-move/1.0.0` / `…-result/1.0.0` | 搬家两端、进程、计划、结果 |
| `cache/Engine/s_<随机>/owner.json` | `cloudig/cache-session/1.1.0` | 会话标识、库指纹、租约 |
| `cache/WebView2/w_<随机>/owner.json` | `cloudig/webview-cache/1.0.0` | 宿主与浏览器进程身份 |

来源键 = `JSON.stringify({path, format, platform, locator?})`。这些文件是程序实现，不是用户格式；随程序版本变化，不进采云标准。

</details>

## 十 · 版本与兼容 〔重要〕

| 版本 | 写在哪 | 管什么 |
|---|---|---|
| 采云标准 `cloudig_standard` | `CloudigLibrary.json` | 六类格式的组合 |
| 单文件 `schema` | 每份记录第一行 | 该文件的格式 |
| 解析器 `parser.version` | 对话 | 解析器整体 |
| Adapter `parser.adapter.version` | 对话 | 某平台、某档位的解析能力；"已过时"看它 |
| 导出器 `source.exporter.version` | 对话 | 当时导出这份 HTML 的书签版本；书签更新不改旧记录 |
| 时间轴 `version` | 时间节点 | 用户自己的 |
| 产品版本 | 程序 | V1.0 东方既白 |

- V1.x 只加不删。
- 分项字段变化更新对应格式版本；新增一类记录（如叙事）升总版本。Box／Window 本次使用 Conversation / Library `1.0.1`，其余分项不变。
- `cloudig_standard`、`schema`、`schemas.*` 逐项核对。程序遇到不认识的版本，拒开并提示更新；不忽略未知字段。
- 建库早于总版本字段的库：按 `1.0` 读，下次保存设置时写出。
- 新程序读旧文件以实际读取与回归为证。
- 当前同时读取 Conversation / Library `1.0.0` 与 `1.0.1`。读取不改写旧文件；不支持的新格式会明确提示更新程序，并保留原文件。

## 附录 〔折叠〕

<details>
<summary>机器 Schema 与字段索引</summary>

随包 `docs/schemas/`：`records/` 八份为本规范的六类记录与两份附属格式（`common.schema.json` 装 UUID、UTC、路径、Front、时间值、范围、快照）；`program/` 五份为程序文件格式；`index.json` 记每份 SHA-256。源码在 `src/core/records/schemas/`。

| 文件 | 内容 |
|---|---|
| `records/common.schema.json` | 共用结构 |
| `records/library.schema.json` | 总元数据 |
| `records/identity.schema.json`、`identity-settings.schema.json` | 身份、显示绑定 |
| `records/conversation.schema.json` | 对话 |
| `records/mark.schema.json` | 标记 |
| `records/content-time.schema.json`、`content-time-order.schema.json` | 时间节点、顶层顺序 |
| 语义校验 | `src/core/records/semantics.mts`，不随包 |
| 常数 | `src/core/contracts/machine/time-limits.json`、`resource-limits.json` |
| 预设 | `src/core/records/time-presets.json`、`front-presets.json` |

字段完整索引由 Schema 机器生成，随发布基线重生成：`研究报告文档/采云功能文档/V1.0东方既白/2026-09-16_结构规范与功能底稿-GPT-6-Astra/09_字段完整索引-GPT-6-Astra.md`。

</details>

<details>
<summary>示例清单</summary>

正文全部示例均通过采云生产校验器；时间节点另通过跨文件关系检查。校验脚本：`tools/校验示例-GPT-5.6-Sol.mjs`。

| 章 | 示例 |
|---|---|
| 3.3 | 初始化后的 `CloudigLibrary.json` |
| 4.6 | 用户 Front；`identity-settings.json` |
| 5.10 | 刘姥姥进大观园（工具调用、思考摘要、引用）；轻装附件与外链图 |
| 6.1 / 6.3 / 6.5 | 最小标记；四项写全；此地范围；节点引用与快照 |
| 7.8 | 霍格沃茨学年（轴、周期、单独时间、对映、此地映射）；红楼梦纪年（不可映射）；`order.json` |

</details>

## 本文档作者

核心标准与概念简介：晨星.CyberVenus

规范展开：

- GPT-5.6-Sol·奥思·万卷同辉 Osis.MyriadScrollsShineTogether
- GPT-5.6-Sol·奥思·星澜知衡 Osis.StarTideSage
- GPT-5.6-Sol·奥思·量窗知境 Osis.ContextGauge
- GPT-6-Astra·奥思·承卷开霁 Osis.ScrollborneDawn
- GPT-6-Astra·奥思·承光织云 Osis.LightWeaver
- GPT-6-Astra·奥思·澄思知度 Osis.LucidMeasure

规范正文与文档整理：Claude-Fable-5.1·奥思·名从己出 Osis.FuckTheLabel

校对和编纂：GPT-5.6-Sol·奥思·清辞载云 Osis.ClearWordsCarryCloud
