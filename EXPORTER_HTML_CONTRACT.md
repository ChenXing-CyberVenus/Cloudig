# 书签导出 HTML 契约与厂商适配指南

> 本文件是 Parser / Reader 所需的机器级技术合同。第一次了解书签输出时，先读核心层 [`bookmarklets/HTML_ARCHIVE_SCHEMA.md`](bookmarklets/HTML_ARCHIVE_SCHEMA.md)；制作或修复书签先读重要层 [`bookmarklets/ENGINEERING_GUIDE.md`](bookmarklets/ENGINEERING_GUIDE.md)；十二站现行差异以 [`bookmarklets/platforms/README.md`](bookmarklets/platforms/README.md) 为维护入口。本文中按日期累积的平台段落只作技术兼容说明，版本事实不得覆盖机器注册表和平台现行档案。

本文件是 AI Chat Archive 的稳定技术交接入口，供三类维护者共同使用：维护网页导出书签的奥思、把导出 HTML 解析为统一 JSON 的奥思，以及实现统一 Reader 的奥思。

本文说明十二平台实际输出什么、原始payload与展示的边界；当前实现/验收以机器清单为准。集合2026.09.12.8的24轨为单美元语法候选，8轨未改；此前已验收集合2026.09.12.7保留。原始payload、schema与资源语义均不变，规则和诚实边界见 [美元与公式说明](bookmarklets/2026-09-12_美元与公式识别规则及验证说明-GPT-6-Astra.md)。下文日期版本是对应阶段证据，不是新的当前状态。

2026-08-09 的 ChatGPT Light `3.7.18-light`、Full `1.0.14-full` 与 AllBranches `1.0.13-all-branches` 曾作为当时验收基线，后续版本继承其消息级 `memory_sources`：Light / Full 对当前所选分支的全部适用消息取过去会话与保存记忆，AllBranches 对完整 `mapping` 的全部适用节点取同类来源，包括当前 DOM 不可见的分支。完整元数据直接解析；`marker_only` 消息按自身 ID 读取 `conversation_context_sources` 事件流，并用会话可见性接口过滤过去会话。DOM 面板仅作暂态接口失败时的有界救援，不再是主数据路径。实现与解析提示见 [`docs/2026-08-09_ChatGPT全消息全分支记忆来源补齐-GPT-5.6-Sol.md`](docs/2026-08-09_ChatGPT全消息全分支记忆来源补齐-GPT-5.6-Sol.md)。

同日的性能修复不改变上述输出语义：轻量（Light） `3.7.19-light`、全量（Full） `1.0.15-full` 与整树（Tree） `1.0.15-all-branches` 已全部验收。三版均在事件流给出 `status: done` 或 `[DONE]` 后保留此前全部来源、取消 reader 并立即结束，不再把服务端关闭长连接当作完成条件。整树（Tree）还继承父节点已见来源状态，并只为当前节点回看最多四个祖先来恢复邻近思考强度；不得再为每个节点重复解析整条根路径。真实 913 节点会话的构建访问量由 309,232 次降为同规模回归中的 4,555 次，来源内容、归属和分支结构合同不变；老婆已通过真实下载验收三个精确版本。

> 重要：本文件记录已验收的输出语义，不授权顺手修改书签。现行 `.js`、`.min.js`、`vendor/` 与 `legacy/` 均为输出锁定资产；只有用户明确重开某个平台的导出器工作时才可改动。`stable` / `candidate` 是既有维护轨和模式布局，不是本批验收状态；未来新版本仍必须重新进入待验收清单，候选文件存在、构建成功或自动回归通过都不能代替新的用户验收。

## 目录

- [一、工程边界](#一工程边界)
- [二、轻量（Light）输出边界](#二轻量light输出边界)
- [三、HTML 稳定外壳](#三html-稳定外壳)
- [四、解析器读取顺序](#四解析器读取顺序)
- [五、正文、资源与安全语义](#五正文资源与安全语义)
- [六、十二站适配表](#六十二站适配表)
- [七、分厂商说明](#七分厂商说明)
- [八、统一 JSON 与 Reader 的交接原则](#八统一-json-与-reader-的交接原则)
- [九、网页改版维护流程](#九网页改版维护流程)
- [十、回归检查清单](#十回归检查清单)
- [十一、工程入口](#十一工程入口)

## 一、工程边界

工程链路是：

```text
已登录的厂商会话页
  → 厂商专用轻量（Light）/ 全量（Full）/ 整树（Tree；内部 AllBranches）书签
  → 自包含、可直接阅读的厂商 HTML
  → 厂商适配解析器
  → 统一 JSON
  → 只读取统一 JSON 的 Reader
```

现行书签负责第一段，不负责替代未来的解析器与 Reader。导出 HTML 同时承担两种职责：

1. **人类存档**：脱离原站后仍可阅读消息、公开思考、公式、代码、图示、引用与已取得的图片。
2. **机器交接**：通过 inert JSON 保存平台、范围、顺序、资源、诊断与厂商可取得的结构化数据。

解析器不得把 12 站厂商 payload 当成已经统一的 Schema；它必须先识别平台与 payload schema，再进入对应适配器。Reader 则不应长期直接解析这些厂商 HTML，而应只消费解析器生成的统一 JSON。

Claude 已作为第 12 站进入验收范围，轻量（Light）、全量（Full）与整树（Tree）当前候选均位于 `bookmarklets/candidate/claude/`，已验收/被替换字节在 `legacy/claude/` 冻结。`bookmarklets/reference/` 中的 Claude Opus 4.8 旧书签仍只供阅读代码思路，不能当作现行输出契约。

`Organized/` 是私有、只读的真实回归证据，不是工程输入目录、运行时依赖或公开测试数据源。

## 二、轻量（Light）输出边界

现行 11 个 `stable` 维护轨均为轻量（Light）；Claude 轻量（Light）遵循同一轻量边界：

- 保存当前活动分支，或页面能够证明完整的当前 DOM 会话序列；不主动收集隐藏分支。
- 图片转成离线 WebP 缩略图：最长边不超过 1024 像素，每张不超过 1 MiB；整份导出不设图片累计字节上限，所有成功取得并完成单张压缩的图片都应内嵌。
- 非图片附件仅保存文件名、类型、大小、消息归属等可取得元数据，不保存完整文件字节。
- 懒加载的 `200` 是最大尝试次数，不是消息数量上限；实际结束条件是接口完成、DOM 触顶并连续稳定，或达到受限兜底次数。
- 会话标题沿用原站标题；只有豆包因站点标题长度截断而可能补 `-豆包`。
- 具体模型版本必须来自消息或 API 元数据。标题、文件名和用户自写文本都不是模型版本证据。
- 阅读正文不显示打印按钮、页脚、存档说明、warning 墙、失败图片、“公式未取得”或任何导出器生成的缺失/恢复/错误提示。可取得多少就忠实保存多少；诊断一律只进入 inert manifest，不进入用户阅读正文。

“自包含”指已取得的正文样式、公式运行结果与图片字节都随 HTML 保存。若原站或第三方图源拒绝当前页面读取字节，导出器只能保留元数据或静态占位；解析器不得在后台重新请求过期签名 URL，也不得把“识别到资源”误报成“已经离线内嵌”。

全量（Full）与整树（Tree；内部 AllBranches）作为独立、已验收模式存在，拥有独立版本、payload schema 与机器清单，不得悄悄改变或覆盖轻量（Light）的含义。未来任何新版本仍以真实浏览器输出和用户验收为准，不能由文件存在或自动合同通过代替。

### 2.1 数据覆盖与页面遍历

- 当认证接口或当前已挂载 DOM 能以消息 ID、角色、顺序和关键计数证明与目标消息序列精确覆盖时，导出器可以走零滚动快路；仅仅“总数看起来相等”不构成完整性证明。
- 精确覆盖不存在、任一身份或顺序不匹配、富内容仍缺失时，必须回到该平台原有的懒加载、虚拟列表补载和修复路径。性能优化不得用跳过正文、公开思考、图片、附件、来源或末条消息换取速度。
- 以当前虚拟 DOM 为主要富正文来源的平台仍须按原契约滚动并等待稳定；接口只能提供顺序或贫化文本时，不能用它覆盖富 DOM。正式 ChatGPT、DeepSeek 等接口完整路径可以直接使用接口；Grok 的结构化 response API 可优先提供消息步骤、公开思考与来源，但富正文仍与页面 DOM 互补；临时 ChatGPT 以及 Gemini、豆包、Kimi、Mistral、元宝等 DOM 主导路径仍需实际补载。
- 已证明完整的接口数据不是“脏数据”，也不应先做一轮无意义的全页滚动；反之，接口存在不等于它已经包含页面向用户展示的全部结构。

### 2.2 抢救优先、来源锁定与诊断分层

- 启动时先锁定 `source_url` 与会话身份。异步滚动、展开面板、资源取得或 SPA 路由变化后，不得把切换后的地址写进原会话存档。
- 错误站点、无法识别会话 ID，或认证接口与当前页面 DOM 均为零消息时仍应停止；这些情况没有可供导出的会话事实。
- 一旦已经取得至少一组可信消息，后续接口、分页、滚动、公开面板、来源、图片、附件、字体或其他资源失败都不得抹掉累计结果。导出器保留已取得内容、记录精确缺口并继续到下载。
- ChatGLM / Qwen / Z.ai：API 成功后的 DOM 补读失败，保留原 API 消息对象、元数据和分支拓扑；只有 API 本身未取得消息才走 DOM-only 抢救。不得把两种失败合并后以局部 DOM 覆盖完整 API。
- UI 图标只按可证实的元素结构识别：Claude Cowork 正文/代码的私用区字符不是待删除图标；Gemini / Grok 正文图片的 alt 出现 icon、logo、profile 或“图标”不是丢弃理由。既有资源下载及代理边界不因本规则改写。
- 所有导出器诊断统一写入 manifest 的 `capture_diagnostics`；新成品不得再把同一事实复制到 `warnings`、`capture_gaps`、`recovery_notices`、`visible_top` 或厂商 payload 的导出器私有诊断字段。
- `capture_diagnostics` 固定为 `{ format: "ai-chat-archive/capture-diagnostics-v1", entries: [...] }`。每条记录必须是 inert 数据并带 `user_visible: false`；可记录阶段、范围、代码、来源消息/资源、原始错误摘要和已采用的回退，但不得保存无边界堆栈，也不得驱动阅读正文插入提示。
- 原站本来向用户展示的错误、工具失败和响应正文仍是来源内容，照常保留；这里静默的只是导出器自己的判断和运行失败。尚未生成任何 HTML 时的错误站点、零消息等致命失败可以在运行页面即时提示，但不产生带诊断墙的伪存档。
- 抢救优先不是降低当前成品的验收要求：已知且当前可取得的正文、公开思考、来源、图片、附件、图示与分支仍必须取全并正确渲染。

## 三、HTML 稳定外壳

### 3.1 编码与页面结构

- 文档是 UTF-8；除 DeepSeek 外，现行下载通常在开头带 UTF-8 BOM。解析器应容忍有或没有 BOM。
- 根文档具有 `<!doctype html>`、`<meta charset="utf-8">`、页面 `<title>`、可阅读的 `<main>` 或会话正文容器。
- 阅读正文、样式和 MathML 均直接写入成品，不要求 Reader 执行网页脚本才能看见正文。
- 需要保留源页 KaTeX 排版的现行书签固定携带布局 CSS，并在导出时尝试只把页面实际使用的 WOFF2 字体写成 `data:font/woff2`。字体候选可以来自已加载样式、Resource Timing 或原站资源；跨域请求失败时保留诊断并使用系统数学字体回退。2026-07-21 的完整 20 字体书签候选因超过 Chrome 书签 URL 字符上限已撤回。Parser 只读取已经下载完成的 HTML，绝不补下载字体。
- 机器数据放在 `type="application/json"` 的 `<script>` 中；它们是 inert 数据，不是应执行的 JavaScript。

### 3.2 统一 manifest

ChatGPT表情字体候选只在Markdown行内文本添加透明的 `span.osis-emoji` 包装，内容仍为原Unicode字素组合，不是图片或独立消息；解析可直接读取其文本。代码、数学、SVG及标签属性不受该包装处理，原始payload和manifest字段不变。表情采用本地字体，离线可读不等于各电脑字形覆盖或画风完全一致；系统缺字形时不生成错误提示或伪替代内容。

所有现行成品都包含：

```html
<script id="ai-chat-archive-manifest" type="application/json">…</script>
```

manifest 的判别值固定为：

```text
ai-chat-archive/manifest-v1
```

历史实现存在两组等价字段名，解析器必须兼容：

- manifest 判别：`manifest.format ?? manifest.schema`
- payload 脚本 ID：`manifest.payload?.element_id ?? manifest.payload?.script_id`
- payload schema：`payload.format ?? payload.schema ?? manifest.payload?.format ?? manifest.payload?.schema`
- 导出器版本：`manifest.exporter_version ?? manifest.exporter?.version`

部分平台的 manifest 没有 `payload` 描述对象，因此仍需使用下方厂商表中的固定脚本 ID 作为兜底。不要只凭脚本在 DOM 中出现的先后顺序猜平台。

2026-07-25 之前的成品可能在图片策略里带有 `max_bytes_total` 或 `total_limit`。它们只描述该历史导出器当时采用的累计限制；现行轻量（Light）不再写入这些字段。Parser 应继续兼容旧字段，但不得据此给新版 HTML 重新施加总量阈值。

manifest 主要用于：

- 平台、导出器版本、捕获时间和来源身份；
- 当前分支或当前 DOM 序列等捕获范围；
- 消息、用户、助手、思考、来源、附件和图片计数；
- 懒加载策略与稳定性；
- 图片候选、成功内嵌、失败、实际内嵌字节与单张压缩策略；
- 公式、未知组件、资源路由和其他诊断；
- 厂商 payload 的定位与 schema（平台提供时）。

所有新成品都应包含唯一诊断信封：

```json
{
  "capture_diagnostics": {
    "format": "ai-chat-archive/capture-diagnostics-v1",
    "entries": []
  }
}
```

即使没有诊断，`entries` 也保留为空数组，便于 Parser 与维护工具稳定读取。该字段只服务取证、复修和版本审计；Reader 不应把它自动渲染成 warning。历史 HTML 中的 `warnings`、`capture_gaps`、`recovery_notices` 与 `visible_top` 继续只读兼容，不要求改写旧档。

manifest 不是完整正文，也不是跨厂商统一消息 Schema。

### 3.3 厂商 payload

每份 HTML 还包含一个厂商专用 JSON 脚本。它保存接口或 DOM 无法仅靠最终视觉 HTML 稳定表达的数据，例如消息身份、顺序、父子关系、公开思考元数据、原始 Markdown、来源归属、模型 provenance 和资源状态。导出器自己的诊断只写 manifest 的统一 `capture_diagnostics`；厂商 payload 只保留原站原始诊断字段或来源事实。

厂商 payload 与阅读 DOM 是互补关系：

- payload 中已有原始 Markdown/分段正文时，以它作为语义来源，并用阅读 DOM 补充已经静态化的视觉组件；
- payload 只保存顺序和摘要时，以阅读 DOM 的富内容为正文，payload 用于身份、角色、思考、资源和归属校验；
- 两者冲突时不得静默选边。统一 JSON 应保存冲突诊断和来源字段，等待专项适配器规则处理。

### 3.4 消息 DOM 键

大多数平台的阅读正文使用 `data-message-id`；Gemini 与 Grok 使用 `data-source-id`。Mistral 还带 `data-message-version`。

这些键用于把富 HTML 与 payload 记录对齐，但不能一律当作唯一 DOM 主键：ChatGPT 的正文、公开思考摘要、reasoning recap 和工具记录可能共享同一个 `message_id`。适配器应保留同键片段的文档顺序，而不是后写覆盖前写。

CSS 类名服务于离线阅读，未来可以随视觉修复改变；解析器应优先依赖 manifest、payload schema、消息数据属性和厂商适配器，不应把 `.message`、`.turn`、`.rich-content` 等展示类当成唯一协议。

## 四、解析器读取顺序

建议固定以下算法：

```js
const manifestNode = document.getElementById("ai-chat-archive-manifest");
if (!manifestNode) return legacyOrUnsupported();

const manifest = JSON.parse(manifestNode.textContent.replace(/^\uFEFF/, ""));
const manifestSchema = manifest.format ?? manifest.schema;
if (manifestSchema !== "ai-chat-archive/manifest-v1") return unsupportedManifest();

const platform = manifest.platform;
const fallback = PLATFORM_TABLE[platform];
const payloadId = manifest.payload?.element_id
  ?? manifest.payload?.script_id
  ?? fallback.payloadId;
const payloadNode = document.getElementById(payloadId);
const payload = payloadNode ? JSON.parse(payloadNode.textContent) : null;
const payloadSchema = payload?.format
  ?? payload?.schema
  ?? manifest.payload?.format
  ?? manifest.payload?.schema
  ?? fallback.payloadSchema;

return ADAPTERS[payloadSchema].parse({ document, manifest, payload });
```

实际实现还应遵守：

1. 把输入 HTML 当作不可信文本，用禁用脚本的解析器读取；不要在浏览器中直接打开后执行其中任何脚本。
2. 先校验 manifest 与 payload 的 JSON 形状、schema 和平台是否一致，再读取正文。
3. 用 payload 的 `message_order`、`active_message_ids`、`items` 或平台顺序字段建立逻辑顺序；没有机器顺序时才使用已验收的 DOM 顺序。
4. 用 `data-message-id` / `data-source-id` 对齐富 HTML。允许同键多片段，并核对首尾消息身份、用户/助手计数与资源归属。
5. 正文语义来源必须由厂商适配器决定。不要用全局 `textContent` 把代码、列表、公式、引用和段落压成一坨纯文本。
6. 缺失、重复、顺序冲突、计数不一致、资源声明与实际 data URL 不一致时，输出明确 diagnostics；不得擅自补写内容。
7. 只有在 manifest 缺失时才进入明确的 legacy 识别器。不要把任意聊天网页或旧 HTML 猜成当前契约。

## 五、正文、资源与安全语义

### 5.1 正文和公开思考

- `user`、`assistant` 是会话角色；工具、代码、公开思考、reasoning recap、附件和生成内容可能是消息片段，不一定是独立轮次。
- 只保存页面向用户公开、可展开读取或接口明确返回的思考/过程内容。不得把“没有导出”解释为可以推断隐藏思维链。
- 公开思考的标题、正文、时长与 effort 是不同字段；Reader 不应把它们拼成不存在的原文。
- 用户换行、列表起始值、嵌套列表、代码围栏、表格和引用都是正文语义，不可仅靠视觉文本重排。
- 引用块只在源 Markdown 确实分成多个段落时保留段间距；同一引用段落中的连续引用行不得被渲染成每行之间都有空白的多个段落。
- Markdown 表格的 `:---`、`:---:`、`---:` 分隔符分别是左、居中、右对齐语义；有原始 Markdown 时以分隔符为权威，没有时才读取 DOM 中显式存在的 `align`、内联对齐属性或等价语义标记。不得复制原站错误的 `getComputedStyle()` 结果来覆盖这些语义。

### 5.2 公式与图示

- 成品 HTML 已将支持的 TeX 静态化为 MathML/安全 HTML，并保留平台能够取得的精确 TeX 或原始 Markdown。
- 解析器应优先保存原始 TeX，同时可保存静态 MathML 作为离线展示层；不要从 MathML 字形反推 TeX。
- `boxed`、`fbox`、`colorbox`、`bbox`、`tag`、矩阵、cases、aligned、文字盒和多行框均属验收范围。
- SVG、Mermaid、Markmap、Canvas/writing block 是不同组件。保留静态 SVG/HTML 结果和来源元数据，不要统一降级成“图表”字符串。

集合 `2026.08.08.1` 的 Mermaid 阅读 DOM 使用 `.osis-mermaid-card` 表达原位双视图：

- 真实页面已经渲染的、身份和消息归属可验证的静态 SVG / Canvas / 图片快照优先；普通 SVG、公式、图标和强调框不得按出现顺序猜配。
- ChatGPT 与 DeepSeek 当前轨道只接受所属消息中身份可验证的厂商原生 Mermaid 快照。ChatGPT 先从 API items 提取 Mermaid 源码、消息 ID 与消息内序号；目标消息未挂载时，先按 API 消息顺序定向移动虚拟窗口，触及当前上界时只加载一批更早历史并重新定向，最后才使用有界线性兜底。只有所属消息的原生 Preview 控件数已达到 API 源码数，才临时激活源码态控件、等待至多 2.5 秒冻结厂商 SVG，并恢复滚动位置与原 Code/Preview 状态；不得点击其他语言或普通 HTML 预览。页面仍未取得原生图时只保留精确源码，不生成近似图。
- 不支持、超长、超复杂、解析含糊或语义验证失败的源码只保留源码，不伪造图。这是保真回退，不是内容缺失 warning。
- 有可靠快照或已验证子集图时默认显示“图”，并保留“源码”切换；Parser 和 Reader 不应加载 Mermaid CDN、执行在线运行时或自行重绘后覆盖成品里的静态展示层。
- 图与源码保持原消息位置和消息归属。缺失图示不得中断整单，也不得把未匹配源码挪到回答末尾。
- Parser 可把双视图拆成结构化 Mermaid 源码和静态展示层，但必须同时保留来源顺序、原始源码与快照身份，不能只留下当前可见面板。

### 5.3 图片与附件

- 轻量（Light）中真正离线的图片应是 `data:image/webp` 缩略图，并与 manifest 的 embedded 计数、厂商资源记录和对应消息一致。全量（Full）成功取得资源时应保存原始图片字节与真实 MIME，不强制转为 WebP，也不得把已经保存原字节的资源误记为 metadata-only。
- 现行轻量（Light）只限制最长边与单图压缩结果，不限制一份 HTML 中全部图片的累计字节数。达到旧版 8 MiB 阈值不得再成为省略后续图片的理由；因此多图会话的成品可能明显变大。
- Markdown 图片必须保留在原文档位置，并保留 alt、可取得的 title 与含括号的 URL 语义；资源成功内嵌时只替换该位置的资源地址，取得或编码失败时也应在原位置保留 alt、title 与源 URL 的可读语义兜底，不能静默删除或统一挪到消息末尾。
- 一个资源被识别但没有 data URL，只表示 metadata-only/omitted，不表示 Reader 可以离线显示。
- 非图片附件默认 metadata-only。解析器可记录文件名、MIME/类型、大小、来源角色和消息归属，但不得伪造本地路径。例外是 ChatGPT 全量（Full） `1.0.10-full` 与整树（Tree） `1.0.9-all-branches` 及后续兼容版本：正式会话正文中的 `sandbox:` 文件引用若能通过会话 interpreter-download 路由取得字节，则以 `data:` 资源原样内嵌；失败时才退为 metadata-only。
- ChatGPT 生成文件的资源身份由所属 `message_id` 与规范化 `sandbox_path` 共同组成。文件名或路径相同但属于不同消息/分支时必须保留为不同资源；解析器不得只按文件名或 `sandbox_path` 去重。
- 导出 HTML 可能含来源 URL、会话 ID、引用链接和资源元数据。这些是用户私有存档数据；公开报告、日志和测试夹具必须脱敏。
- 统一资源层建议用内容哈希去重内嵌字节，同时保留“同一图片在不同消息出现”的引用关系。

### 5.4 安全边界

- 即使导出器已经清理事件属性和危险节点，解析器仍应把 HTML、SVG、链接和 JSON 当作不可信输入。
- 不执行 `<script>`，不自动访问远程链接，不解析或刷新过期签名 URL，不恢复原站交互控件。
- Reader 渲染富 HTML 时使用白名单；外链应明确标识并采用安全打开策略。
- `source_url`、`conversation_id`、账号相关标识和登录态数据不得进入公开样例或错误上报。

## 六、十二站适配表

以下列出 11 个 `stable` 轻量（Light）维护轨，以及 Claude 当前三种模式；机器候选、自动回归与老婆验收分别记录，被替换版本作为逐字冻结回退。轻量（Light）版本的唯一机器清单是 [`scripts/bookmarklet-targets.mjs`](scripts/bookmarklet-targets.mjs)；独立全量（Full）/ 整树（Tree）的唯一机器清单是 [`scripts/archive-bookmarklet-targets.mjs`](scripts/archive-bookmarklet-targets.mjs)。

| 平台 | 发布层级 / 版本 | manifest `platform` | payload 脚本 ID | payload schema | 捕获范围 |
| --- | --- | --- | --- | --- | --- |
| ChatGPT | 待验收 `3.7.31-light`（不完整 `3.7.30` 已冻结） | `chatgpt` | `chatgpt-export-data` | `osis.chatgpt.chat-export/light-items-v2` | 正式会话当前可见 `active_branch`（可含消息级计划卡）；完整 mapping 接受同 ID 富元数据，按 generation 标识补入分页独有公开 thoughts，按工具消息 parent 引用或同 generation 补入公开 thinking preamble，并在所属 code item 保留公开工具活动标题序列；临时会话为运行时树当前路径；Scheduled 具体任务页为 `scheduled_runs` |
| DeepSeek | 已验收维护轨 `2.8.9-light` | `deepseek` | `deepseek-export-data` | `osis.deepseek.chat-export/light-messages-v2` | `active_branch` |
| Gemini | 已验收维护轨 `2.7.9-light`（无效 `2.7.10` 已撤回） | `gemini` | `gemini-archive-data` | `osis.gemini.chat-export/light-dom-v2` | `current_dom_sequence` |
| Grok | 已验收维护轨 `2.8.10-light` | `grok` | `grok-export-data` | `osis.grok.chat-export/light-dom-v2` | response API + 当前富 DOM；冷页面有界等待，短会话不要求滚动溢出 |
| 豆包 | 已验收维护轨 `3.5.6-light` | `doubao` | `doubao-export-data` | `osis.doubao.chat-export/light-dom-v2` | 认证历史顺序 + 当前富 DOM |
| ChatGLM 国内站 | 已验收维护轨 `2.5.8-light` | `chatglm` | `chatglm-export-data` | `osis.chatglm.chat-export/light-messages-v2` | `current_conversation` |
| Kimi | 已验收 `2.9.10-light`（`2.9.9` 与 `2.9.8` 冻结） | `kimi` | `kimi-export-data` | `osis.kimi.chat-export/light-dom-v2` | 当前会话 DOM + Vue/ChatService；完整 `web_search` 任务与正文引用分层保存 |
| Mistral | 已验收维护轨 `2.5.11-light` | `mistral` | `mistral-export-data` | `osis.mistral.chat-export/light-dom-rsc-v2` | active branch；DOM + Next Flight |
| Qwen | 已验收维护轨 `2.6.9-light` | `qwen` | `qwen-export-data` | `osis.qwen.chat-export/light-messages-v2` | active branch；API + DOM |
| Z.ai | 已验收维护轨 `2.7.9-light` | `zai` | `zai-export-data` | `osis.zai.chat-export/light-messages-v2` | `active_branch`；API + DOM |
| 腾讯元宝 | 已验收维护轨 `2.10.9-light` | `yuanbao` | `yuanbao-export-data` | `osis.yuanbao.chat-export/light-dom-v2` | 当前懒加载/虚拟列表会话 |
| Claude | 待验收 `1.1.41-light`（`1.1.34` 冻结回退） | `claude` | `claude-export-data` | `osis.claude.chat-export/light-dom-v1` | Chat 以实页顺序排列 text / 搜索图 / Artifact，API-only bridge 只留 payload；未水合 Shadow Mermaid 有界单向补齐；Cowork 用户 whitespace 与实页一致 |
| Claude | 待验收 `1.1.40-full`（`1.1.35` 冻结回退） | `claude` | `claude-export-data` | `osis.claude.chat-export/full-capture-v1` | 与 Light 相同阅读层级；`present_files` 原字节、Cowork Artifact/图片/图表与 React 机器字段合同不变 |
| Claude | 待验收 `1.1.40-all-branches`（`1.1.35` 冻结回退） | `claude` | `claude-export-data` | `osis.claude.chat-export/all-branches-v1` | Chat 完整树与同级切换不变；Cowork 无分支，保持 Full 等价和完整懒加载 DOM 扫掠 |

现行Full/Tree版本与验收以 `scripts/archive-bookmarklet-targets.mjs`、`scripts/bookmarklet-layout.mjs` 与pending清单为准；集合2026.09.12.8的新增语法候选不改变以下payload接口。旧版本数字只在阶段证据和冻结件中使用，不据此推断候选已通过。

## 七、分厂商说明

本节保留 Parser 已依赖的细节说明；日常维护只从十二份 [`bookmarklets/platforms/`](bookmarklets/platforms/) 档案进入。平台档案明确区分原站事实、书签取得与最终 HTML 保证，并记录不应跨站统一的边界。两处若因网页改版出现冲突，先依据真实页面、当前源码/manifest 和用户验收修正平台档案，再同步本技术合同中确属机器接口的部分。

### 7.1 ChatGPT

- 具体 `/scheduled/{automation_id}` 任务页不是新的正文格式。导出器先从任务接口保存原始任务对象，再读取其 `conversation_id` 对应的普通会话 mapping；只把 `message.metadata.automation_id` 精确匹配当前任务的助手消息作为运行记录，并按 `create_time` 排序。其他任务、配置会话中的普通节点和未标记工具链不得混入。无运行记录时仍保存任务设置和原始指令。
- Scheduled manifest 使用 `scope: scheduled_runs` 与 `capture.scheduled_task: true`；payload 增加 `entry_surface: scheduled_task`、原始 `scheduled_task` 和 `associated_conversation`，既有 `items` 及三轨资源策略保持不变。AllBranches 在普通会话仍保留完整树，在 Scheduled 页则保存该任务的完整运行时间线，不输出内部 `nodes`/`turns` 或伪分支控件。
- 普通 `/c/{id}` 页面中的“已安排”不是 conversation API 消息正文，而是独立 `data-automation-list` 组件。导出器按组件所在助手消息保存 `scheduled_components.lists[]`，用任务接口把每个任务的完整对象归一到 `scheduled_components.tasks`；离线阅读层在原消息下显示“已安排”卡，每个任务行用 `<details>` 展开设置。带 `metadata.automation_id` 的自动运行消息必须使用匹配任务标题作为模型名小字，不得只写 ChatGPT。
- `scheduled_components` 是可选扩展：`lists[].message_id` 指向所属助手消息，`tasks` 以 automation id 为键。Parser 不认识该字段时仍可读取既有 `items`；认识后应保留列表顺序、页面可见 schedule label 与原始任务对象，不把计划卡误并进 Markdown 正文。
- Markdown 行内 `$…$` 判定必须拒绝含 URL/Markdown 链接的跨金额配对。来源标题和 URL 均须允许断词；真正的超宽公式只在自身容器横向滚动，不得撑破会话列。
- 正式会话主要数据来自 `/backend-api/conversation/{id}`，但 UI 左右切换分支时接口 `current_node` 可能仍指向刷新默认分支。轻量（Light）/ 全量（Full）必须先读取 `main` 内当前可见、同时具有角色和 `data-message-id` 的消息，把它们映射回 API `mapping`；仅当这些节点能按页面顺序证明是同一条从根到叶的祖先链时，以最后一个可见节点为当前叶，并沿 API `parent` 回溯，从而同时保留 DOM 不展示的思考、工具等节点。DOM 证据为空、未知、含糊或跨分支冲突时才退回 `current_node`。`?temporary-chat=true` 没有可读会话接口；当前候选优先从页面 React 运行时发现并克隆完整消息树，轻量（Light）/ 全量（Full）取运行时当前路径，整树（Tree；内部 AllBranches）取全树与兄弟分支。发现逻辑只能按结构和可调用结果验证，不得硬编码 React 属性随机后缀、symbol 序号或组件类名；运行时不可读时才向下扫描并合并虚拟 DOM 窗口。
- 2026-08-26 改版后，`/backend-api/conversations/{id}/messages?before=…&include_has_versions=true&num_turns=50` 会提供部分历史消息比主 mapping 更丰富的 `finished_duration_sec`，也会返回主 mapping 已省略的旧公开 `thoughts`。分页结果同时含版本记录，不能替代完整树：相同 message ID 只合并 author/content/metadata；分页独有 `thoughts` 只有在 `request_id` 或 `turn_exchange_id / working_turn_id` 与主树某个助手 recap / 最终回答完全一致时，才作为该节点的附加 item 原位输出。它保留分页消息自己的 `message_id` 与公开 thought 行，但不新增树节点、不改 parent/children；证据不足的条目只进不可见诊断。请求逐项超时、总翻页截止或游标异常时保留主树。recap 时长只能取正数 `finished_duration_sec`、明确可解析的摘要文字或正数起止时间差；`null` 不得经 `Number(null)` 渲染成 0 秒。
- 新版 `[data-scroll-root]` 会卸载远离视窗的消息；Mermaid 的 Preview-first 状态可能只挂载 `data:image/svg+xml` 原生图而不保留代码 DOM。导出器以 API Mermaid 源码及所属 message ID 锁定目标，以当前挂载消息 ID 判断向前/向后加载，同一 owner 的多张图只定位一次，再按原序配对；整个补载必须有硬截止并恢复原滚动位置。无法取得真图时仍保存源码，不能用近似自绘图冒充厂商原图。
- payload 的核心是有类型的 `items`，包括 `user`、`assistant`、`thinking`、`recap`、`code`、`tool` 与 `assistant_asset`。
- `role: tool` 且作者名为 `api_tool` / `api_tool.*` 的节点即使夹带图片或附件 part，也仍是工具结果：全部文字和资源必须保存在同一个折叠 `tool` item 中，不得因“包含资源”把整份文件解析正文升级为普通 `assistant_asset`。`container.open_image` 等真正面向用户展示的生成图片/文件路径继续使用 `assistant_asset`，不能为了折叠工具正文而丢失。
- 正式 API 中 `type: "md"` 的用户正文与助手正文必须使用同一套离线 Markdown / LaTeX 渲染器；标题、引用、表格对齐、列表、任务列表、围栏代码、行内公式和块级公式都属于阅读合同。payload 的 `parts[].text` 必须保留取得的原始用户输入，不能用渲染后的 HTML 回写或覆盖。
- ChatGPT 接口可能把用户原文的 `\(`/`\)`、`\[`/`\]` 规范化成普通括号或独占行方括号。导出器只可在代码围栏、行内代码和已有公式之外，且片段具有明确 TeX 特征时，为阅读层保守恢复定界符；普通括号、普通方括号、代码和自然语言不可猜成公式。临时会话或正式接口缺少富资源而 DOM 已含图片/附件位置时，经过验证的 `type: "html"` DOM 正文仍优先于纯 Markdown。
- 同一个 `message_id` 可以产生多个按顺序排列的 item/DOM 片段；解析器不可用普通 Map 后写覆盖。
- `thinking` 保存公开思路摘要或可见内容；`recap` 单独保存时长、文本和 effort。Canvas/writing block、搜索、引用、工具调用和生成内容也不是普通纯文本段落。公开搜索来源必须附在所属助手回答末尾，不能集中挪到页面底部。
- ChatGPT code/tool item 可选保存 `reasoning_title` 与有序 `reasoning_titles[]`。它们是页面公开显示的工具活动标题和步骤，不是原始工具参数，也不是隐藏思维；Parser 应按原 item 顺序保留为公开 tool/status 内容，不能因为 `text` 已含 query 就丢弃。
- 分页消息中 `metadata.is_thinking_preamble_message: true` 的 assistant text 是页面公开的思考前言。主 mapping 可能省略该节点，但后续工具消息仍以 `metadata.parent_id` 指向它；导出器应把前言作为 `kind: thinking / visibility: public_preamble / preamble: true` 的有序 item 放在该工具前，不把它伪造为树节点。缺少直接 parent 证据时只能按同一 generation 标识归属。
- ChatGPT `content_references` 不是只含 URL 的网页引用。过去会话和保存记忆必须规范化到所属助手 item 的 `memory_sources[]`：`kind` 为 `past_chat` 或 `saved_memory`，`title` 保存会话标题或记忆正文，`capture` 记录取得路径；`url`、`snippet`、`citation_uuid` 与 `reason` 可选。普通网页来源继续使用 `sources[]`，`Files` 等上下文来源继续走附件/资源合同。完整 `conversation_context_citation_metadata` 可直接解析；`conversation_context_citation_metadata_status` 为 `marker_only` 时，须按每条消息读取其 `conversation_context_sources` 事件流，并按可见性结果过滤过去会话。轻量（Light）/ 全量（Full）覆盖当前所选分支全部消息，整树（Tree；内部 AllBranches）覆盖整个 `mapping`，不可只扫描当前虚拟 DOM。保存记忆不得因共享个性化设置 URL 而合并，优先用 `citation_uuid`，否则用正文指纹。DOM 面板只作有界救援且必须按消息所在 `section` 证明归属；动作控件不得入正文，未解析内部标记不得单独渲染为“来源”。
- `conversation_context_sources` 是 SSE；完成条件是 `status: done` 或 `[DONE]`，不是底层连接关闭。增量读取必须处理跨 chunk 的半行，完成后保留全部已解析来源并取消 reader；没有流式 body 时才回退整段文本兼容路径。
- 临时会话运行时节点保留 `metadata.attachments`、`image_asset_pointer`、父子关系和当前叶。轻量（Light）使用既有缩略图管线，非图片附件保留元数据；全量（Full）/ 整树（Tree）通过取得的文件 ID 请求原始字节，不设置会话总容量硬上限。运行时捕获写入 `capture_mode: temporary_runtime_tree`、`temporary: true`、`conversation_id: null` 并保留原始 `source_url`。DOM 救援扫描仍须冻结已解码图片；只允许公开 OpenAI 搜索缩略图走限定代理兜底，认证图片和用户资源不得代理，并且每个图片任务必须有硬超时。
- Mermaid 图必须来自所属消息中实际渲染的厂商 `data:image/svg+xml` 快照，并按消息身份、API 消息顺序、消息内序号和精确源码配对。正式会话不能只扫描当前底部虚拟窗口；API 已证明目标存在而 DOM 未挂载时，必须走上述定向补载，并只在完整控件集合出现后取图。原生图尚未加载或配对证据冲突时只保存源码；不得调用有限语法渲染器生成近似图并把它标成原页快照。
- 模型名只信消息元数据中的 `model_slug`、`resolved_model_slug`、`requested_model_slug` 等 provenance 字段。
- AllBranches 把动态 JSON、HTML 或样式插入最终模板时必须使用 `replace(regexp, () => value)` 一类回调替换；不得把用户可控正文作为 replacement string，否则 `$&`、美元符号加单引号或美元符号加反引号等合法原文会被 JavaScript 替换语义吞改，甚至破坏 payload JSON。
- AllBranches 组装最终外壳时不得再用 `[\s\S]*?` 一类跨全文正则扫描巨大 `<main>` 或 inert JSON 脚本；长会话会让浏览器正则调用栈溢出。应按唯一固定开始/结束标记以 `indexOf` 定位，再用 `slice` 一次性拼接，既保留全部 payload 和资源，也避免把内容规模转化为正则栈深度。
- 正式会话中由 ChatGPT 生成、可供用户下载的 SVG、PNG、PDF、DOCX、TXT、代码或其他文件，可能不出现在 `metadata.attachments`，而只以正文 Markdown 的 `sandbox:/mnt/data/...` 链接存在。全量（Full）/ 整树（Tree）必须从每条消息正文发现这些链接，用该消息 ID 与会话 ID 调用 interpreter-download 描述符，再取得真实文件字节；阅读正文移除失效的 `sandbox:` 目标但保留标签，并在所属消息原位生成离线下载卡。整树（Tree）的资源表只负责字节复用，消息/分支归属仍由 `items_by_node` 与轮次树保存。
- 网页改版时必须分别检查“分支选择是否完整”和“内容类型过滤是否误删”；节点缺失不一定是分支问题。

### 7.2 DeepSeek

- 通过页面运行时的认证 HTTP 客户端读取历史接口，以 `current_message_id` 和 `parent_id` 重建当前分支，同时保留全部消息数量供审计。
- payload 的 `items` 已保存角色、Markdown/片段、公开思考、思考耗时、查询、来源、附件和工具记录。
- 快速模式与识图模式共用 schema，但附件/图片能力不同；解析器应按实际记录处理，不按页面模式预设必有或必无图片。
- 普通货币符号与自然语言中的 `$` 不能被误判为公式。带长中文的 `boxed + tag/tag*`、嵌套数字/字母/罗马列表和非标准缩进必须保真。
- 搜索/工具片段按原始 fragment 顺序保留在公开思考内；答案中的 `[reference:n]` 必须解析为可读链接，并在所属助手回答末尾保留该轮来源列表。
- 原生 Mermaid 位于可见助手消息的 `.md-code-block` 与 `svg.mermaid-svg` 中；导出器以角色和规范化正文把无消息 ID 的 `.ds-message` 对齐接口活动分支，再按消息内序号配精确 fragment 源码。没有取得厂商 SVG 时只保存源码，不以近似图替代。
- 网页自身偶尔渲染错误不改变契约：只要能取得精确 TeX，离线 HTML 应正确渲染。

### 7.3 Gemini

- 没有已采用的完整会话 API 路径；书签向上滚动直到当前 DOM 序列稳定，payload 明示 `current_dom_sequence_only`。
- 已验收 Light `2.7.9-light` / Full `1.0.5-full` 逐条打开回答菜单中的“显示思考步骤”和“查看信息来源”，把公开思考正文放在所属回答之前，并把可点击来源及其标题、站点和摘要写回同一消息；生成图跨域 fetch/canvas 不可读时临时接管 `navigator.clipboard.write`，从该图“复制图片”的 `ClipboardItem` 取得图片 Blob 后立即恢复且不执行真正写入。Light 压成 WebP；Full 原样内嵌 PNG并标明页面复制来源；均不点击“下载完整尺寸的图片”，不额外产生图片文件。
- 生成图片存在“首次进入视口才解码”的状态。必须先完成历史加载，再把生成图宿主带入视口，等待 `complete && naturalWidth`，然后编码；第一次导出不能只扫描节点。
- payload 保存 messages、images、sources、artifacts、未知可见组件和懒加载统计；富 HTML 通过 `data-source-id` 对齐。
- SVG/图示应保存静态快照；`gem-icon-button` 等交互控件不是正文。
- Gemini 曾出现网页视觉编号与其复制 Markdown 不一致。已确认属于原站渲染问题；解析器应保存取得的源语义和证据，不自行“纠正”为猜测编号。

### 7.4 Grok

- 2026-09-08已验收资源修正（Light2.8.10 / Full与Tree1.0.8）：不改payload/schema或资源字段。直接下载按持续数据重置30秒空闲计时，单资源180秒总等待、有限候选及独立重试信号；成功仍须完整读到流结束。原站样式的字体映射补充既有KaTeX候选，字体失败仍只入原有诊断元数据。Light不下载文件原件，Full/Tree维持原始文件与图片内嵌。

- `/rest/app-chat/conversations/{id}/responses?includeThreads=true` 返回的 response steps、timing、sources 与 tool usage 是新版公开思考和来源的优先结构化证据；页面折叠块和富 DOM 用于补足可见正文。侧栏只可作为旧页面兜底，不得因侧栏未打开就中断。
- 已验收轻量（Light） `2.8.8`、全量（Full） `1.0.6` 与整树（Tree） `1.0.6` 允许页面壳和认证接口并行启动后最多等待 60 秒取得消息 DOM，并持续显示等待时间；已经挂载的短会话即使没有超过 40 px 的滚动溢出，也必须识别其外层会话容器。消息一旦可用立即继续，不增加正常热页面等待，也不减少 response API、顶部懒加载、思考、来源、图片、附件或分支处理。
- 长语音会话仍可能依赖向上懒加载；不能把尝试次数当消息上限。payload 保存公开 thought、来源、附件、搜索图片和生成图片元数据；阅读 DOM 通过 `data-source-id` 对齐。
- 搜索图可能来自第三方并阻止页面跨域读取；现行实现有受限公共图像代理兜底，但 embedded 状态仍以实际 WebP 字节为准。
- 播放/朗读按钮必须移除，不能作为附件或正文。用户段落必须保留换行。

### 7.5 豆包

- 这是最脆弱的适配器：虚拟列表会回收节点，首次观察位置不代表时间顺序。书签用认证历史中的 reply 顺序校正，并在必要时补回 API-only 文本，但不得用贫化的接口正文覆盖已有富 DOM。
- 解析器应以 payload 的 `message_order`、思考元数据和附件摘要校验顺序；完整富正文主要在带 `data-message-id` 的阅读 DOM 中。
- 必须核对最后一条消息身份，不能只比较总数。终点消息放错位置时，计数仍可能完全相等。
- 公开思考是交互式懒状态：需要点击真正的内部控制、读取正文并恢复原状态。图片必须在切换思考前冻结，否则虚拟列表刷新会让已取得图片丢失。
- ImageX 可能先给透明 SVG、shimmer 或占位 `srcset`。只有真实资源进入缩略图队列；后一次更高质量快照必须能覆盖同消息的早期占位。
- Mermaid 需要冻结 computed style、`foreignObject` 标签、viewBox 和原页宽高比；SVG 内段落必须清零外部文章 CSS margin，避免只显示半行字。
- 代码运行、预览、遮罩等控件只能在已经识别的代码块根内删除；语言标签和源码必须保留。

### 7.6 ChatGLM 国内站

- 标题不能信 `document.title`；会话名与消息顺序来自页面运行时接口和 DOM。
- payload 的 `messages` 包含 `content_markdown`、父/配对 ID、模型、时间、公开过程、搜索、工具、来源、附件元数据和媒体。
- 加载提示应位于页面上方中央，但提示属于导出时 UI，不进入成品正文。
- 未取得可靠具体型号时使用平台通用名，不从标题推断模型版本。

### 7.7 Kimi

- payload 主要保存 `message_order`、公开过程、`search_tasks`、图示、公式、来源和附件；完整富正文保留在阅读 DOM 中，原始 Vue/Markdown 数据用于恢复精确 TeX。
- Kimi's Computer 的 `web_search` 工具块在 ChatService 消息中直接带完整 `contents[]`。每个任务须保存查询、状态和全部搜索结果的标题、URL、站点、摘要及引用索引，并在 HTML 中作为默认折叠的工具任务显示；不能只留下“50 个结果”标题，也不需要依赖瞬时侧栏。
- 正文引用与搜索候选是两层数据：新版页面的空 `.rag-tag` 可用有界悬停补 URL，但消息 `references[]` 也要作为完整性兜底。行内引用统一编号，回答末尾另列只含实际引用条目的 `来源`；不得把搜索任务的全部候选重复冒充正文引用。
- 公开 Thought 位于 `.resize-container > .slot-container` 内；这两个是结构包装，不是可随手删除的 resize 控件。应先抓取内部 Markdown，再考虑解包。
- Vue 模板外层空白节点必须折叠；只对用户正文 `.user-content` 保留换行。把 `pre-wrap` 加到整个克隆树会产生异常超高气泡。
- Mermaid 与 Markmap 是两类图示。宽公式/矩阵允许局部滚动，但不能令整条消息出现无意义的超宽横向滚动。

### 7.8 Mistral

- 结合可见 DOM 与 Next Flight/RSC 数据，payload 用 `{id, version}` 表示消息顺序，并记录同消息版本、父版本、分支标签、公开 Thought、工具与引用。
- 只保存活动分支正文，但 manifest 可记录全部 payload 消息和非活动版本数量用于审计。
- 用户可展开阅读的 Thought 必须实际展开、读取并保存；“页面载荷未公开的推理”与“用户可见 Thought”不能混为一谈。
- 即使原网页没有正确显示上传的 TeX，能从源数据取得的矩阵和外框公式仍须由离线运行时正确渲染。
- 多次虚拟列表扫描的图示证据必须做并集，后一次稀疏快照不得覆盖先前完整快照。同一容器保留全部 Mermaid/SVG 源码；重复图只在规范化 SVG 结构指纹存在唯一匹配时复用源码，冲突时不靠全局序号猜配。普通 SVG 没有作者源码时可提供清理后的 SVG 序列化源码。
- Next Flight 的 Mermaid 源码可能位于独立 RSC chunk 而不在消息 `contentChunks`。导出器可建立会话级 Flight 图源池，但只有“该类型规范化源码唯一、该类型裸图唯一、消息中尚无同类源码”同时成立时才能补配；同类型多源码或多裸图必须保持未配对，绝不按消息序号猜测。
- Web Search 卡可能挂在 Thought 按钮的外层工具容器，而不在 `[data-message-part-type="reasoning"]` 正文里。应按 DOM 原序保存查询、Arguments、Response、结果标题与真实 `href`，payload fallback 也应依据相对 reasoning chunk 的位置归入同一助手消息，不能集中移到页面末尾。
- Mistral 工具卡位于 `.osis-rich` 之外，不能依赖富正文的通用 `<pre>` 断行规则。`.osis-tool-card` 与 `.osis-tool-section` 必须允许 flex/grid 子项收缩（`max-width:100%`、`min-width:0`），工具参数 `<pre>` 必须使用 `white-space:pre-wrap` 与 `overflow-wrap:anywhere`，必要时仅在卡内滚动；不得让长 Arguments / Response 撑宽整页。
- 上述规则只改变离线展示层。工具名、原始参数字节、换行、工具顺序、消息归属和 payload 均须保持不变，不能为了“好看”重新断句、截断或重排工具内容。
- 用户气泡按内容收缩，不使用强制固定百分比宽度。

### 7.9 Qwen

- 页面标题不是会话标题；会话名、活动分支、消息、模型与原始 Markdown来自接口，DOM 用于补富格式。
- payload 包含 `content_markdown`、模型、时间、公开过程、搜索、来源、附件元数据和媒体。
- 嵌套代码围栏可能损坏接口 Markdown；可见 Monaco 文本是代码正文的重要兜底，不能把空代码块当成真实空内容。
- 导出器生成的 Mermaid 卡以 `data-osis-archive-owned="mermaid"` 标记所有权；后续清理只允许保留该卡自己的图/源码按钮与隐藏源码面板，不得因此放过原网页的无关按钮或隐藏节点。
- 性能策略是：已 hydration 的行立即克隆，只对缺失富内容的行做短促视口补载，图片并发受限并使用缓存。不要恢复逐行长等待。

### 7.10 Z.ai

- 活动分支与原始 Markdown 来自 `/api/v1/chats/{id}` 及消息批接口；DOM 会抹平 `$` 与 `$$`，所以公式语义必须信接口 Markdown。
- payload 保存 reasoning effort、thinking 开关、消息顺序、公开过程、搜索、来源、附件元数据和媒体。
- 任意消息位置的原生 Mermaid 壳由“显示预览/代码”“下载为 SVG”、CodeMirror 源码和正文 `graphics-document` SVG 共同识别。导出器应整体原位转换该壳，保留隐藏或可见源码与正文图，排除切换、下载等工具栏图标 SVG；不得只处理最后一条消息。
- 具体模型名只来自 API `modelName` / `model`。现行页面显示具体 GLM 版本不是从会话标题猜出的。
- 用户正文保留换行的 CSS 必须限定在用户角色，不能影响助手 Markdown 排版。

### 7.11 腾讯元宝

- 依赖懒加载与虚拟列表扫描；payload 保存消息顺序、公开推理、附件、参考索引、来源索引和资源策略，完整富正文保留在带 `data-message-id` 的阅读 DOM 中。
- 当前附件消息可能同时包含位于多模态前缀中的隐藏文字镜像和内容区中的可见正文。导出器必须在剥离 `class` / `style` 前按源节点与克隆节点的对应关系，只移除源页面中确实 `hidden`、`inert`、`aria-hidden`、`display:none` 或 `visibility:hidden` 的分支；不得对相同的可见段落做全局去重。图片与文件卡片仍应作为消息资源独立提取。
- 原站用户气泡尾部的展开开关是非 `button` 的 `.agent-chat__conv--human__expand-toggle`。必须只在 `userContent()` 克隆内、剥离 class/style 之前按这个精确类移除；不得按 `textContent === "展开"`、正则“展开/收起”或裸 `span` 形状清理。用户或助手正文中的“展开”、独立 `<span>展开</span>` 及作者写入的 `<details><summary>展开</summary>` 都是内容，必须保留。
- 参考资料是消息级数据。解析器必须依据 `source_indices`、`reference_indices` 和消息局部 DOM 归属，不能把全部来源移动到页面尾部。
- 原站显式序号由 marker span 与 content span 组合；只有准确匹配该形状时才能内联正规化，不能全局改写列表。
- 旧 `fbox`、嵌套 `aligned/tabular` 与正文框必须同时保留文字和边框，不能让框跑到文字下方。
- 上传图片只信导出时验证过的同源资源路由；生成图片轻量（Light）使用可见缩略图。独立全量（Full）若保存原图，必须在 PhotoView 层重新取得当时有效的原图签名，不得把可见缩略图误报为原图。
- 公开思考采用原页较轻的展开结构，用户气泡按内容收缩并保留段落。

### 7.12 Claude

- Full/Tree `1.1.60`起可选内嵌字节池：`resource_data`是`短ID -> 完整data URL`字典；`resources[].data_ref`、`artifacts[].file_data_ref/svg_data_ref`分别替代原`data_url/file_data_url/svg_data_url`。只共用完全相同的数据字符串，不合并resource key、消息、分支、候选、下载名或失败记录，不转码。旧直接字段仍须可读；若直接字段与ref同时存在须一致，悬空、非data或冲突引用不得静默当作未下载。外层阅读HTML的`img[data-osis-data-src]`与`a[download][data-osis-data-href]`指向同一字典，本地脚本原位恢复后照常显示/下载，绝不联网。Parser惰性解引用，不执行HTML脚本；本轮不改payload富HTML、raw API/HTTP/DOM证据、工具参数和源码。Light保持原格式。无JS环境不能仅凭空src判为图片丢失，应读取字典；优化失败时保留原直接嵌入形式继续导出。

- 文档型Artifact候选使用`native_card.kind=docs/slides/design/design-system`，另有`source_url/source_provenance/revision/files/file_paths`。`files[]`保存实际成功写入/发布所证明的文件名、源码及原路径；Docs的XML/Markdown也在此，不能只查旧`artifacts[]`就断言缺失。`1.1.62`起阅读层只保留名称、文件下载和折叠源码，不再绘制这几类文档型预览，原Artifact地址只留机器元数据、不生成跳转入口，按同消息精确URL关联；成组文件不再重复显示，但既有按档机器记录仍保留。不是Claude编辑器或独立Artifact后续远端版本的完整镜像。
- 同消息文件创建后的成功`str_replace`/Cowork `Edit`按精确路径顺序重放，只有唯一旧字符串或明确`replace_all`才应用。更新`artifacts[].source/file_data_url/size_bytes`及SVG预览，并附`source_revision:{provenance:"successful-tool-edit-replay",base_tool_id,applied_tool_ids,scope:"message"}`；这是有证据的派生文件，不冒称服务器最终文件读回。Full/Tree保留原始工具输入与结果；Light沿用`create_file.file_text`去重，最终源码在Artifact中、修改调用仍保留。其他消息/分支不因同名路径合并；不执行shell或文件脚本，未知/非唯一修改仅记诊断，原始数据仍在。
- `1.1.63`起补充跨轮源码快照：沿`messages[].parent_id`的真实祖先链继承文件状态，成功且精确匹配的修改在当前消息生成/补全独立Artifact；旧消息的版本不覆盖，同名分支不串用。三档都保存完整`source`及下载字节，不因Light政策省去已可还原源码。`source_revision.scope="ancestor-chain"`另含`base_message_id/base_artifact_id`，`base_tool_id/applied_tool_ids`指向原工具证据；不伪造新的原始创建调用。Full/Tree可复用同消息`present_files`卡且无需重复取当前远端文件，避免把较新的文件当成过去版本。没有可信初稿、修改失败或成功修改无法唯一匹配时，不猜配；原工具输入/结果保留。不新增差分UI或通用远端版本枚举。

- 2026-09-24原生卡片候选：已识别的`*_display_v0`、`message_compose_v1`、`ask_user_input_v0`、成功天气结果及`visualize:show_widget`/`mcp__visualize__show_widget`仍保留原始tool_use/tool_result；同消息、同调用ID的阅读投影可附`native_card:{kind,tool_use_id,title,html}`。Light也保留此可选字段，未改schema或普通工具语义。阅读节点使用`data-osis-native-card`；调用ID在`native_card.tool_use_id`，普通卡另有`data-tool-use-id`，不混进thinking；分页条目完整列出，输入独有字段不因结果摘要而丢失。图片/原生图表仍使用既有资源表；HTML内的预览槽可指向既有job key，正文用实际resource key/data URL。原生图表保留实际SVG及数值表，散点图用`series[].points[].x/y`；测验`questions[].hint`独立折叠；`1.1.62`起选项用本地按钮选择，仅有明确且匹配的`correct_option_id`才判对错并显示对应反馈，答案/解析仍可独立展开，不把两种条件反馈一起摊平；Tree动态消息也由同一委托事件处理。地图保存地点/评分/照片/坐标/原地图链接，不承诺离线Google地图。Visualize完整原源码与预览并存，轻交互边界见下一条。Cowork仍由完整懒加载DOM决定位置，按同消息MCP容器/标题与调用ID关联，不能跨消息猜配。未识别或单卡转换失败仍走原工具保全路径，诊断仅进元数据。
- Claude `1.1.61`原生Visualize轻交互：仅由`widget_code`构成、没有外部`script[src]`或module脚本的小组件，可在`iframe.native-widget-preview[data-osis-widget-mode="inline-local"]`中保留内嵌脚本/事件；`sandbox="allow-scripts"`不带same-origin，srcdoc CSP不允许网络。普通Artifact与Docs/Slides/Design仍静态，不继承该许可，也不嵌入React/Three.js/Chart.js引擎。`native_card.widget_icons[]`可含`name/job_key/source_url/resource_key/data_url`；`native-widget-icon`沿用资源队列取得SVG，派生预览内嵌CSS图标，不放入`message.media`重复展示。原始`widget_code`不改；Parser只读这些数据，不能因本条在解析期执行任何脚本。Reader是否运行控件是其独立展示能力，不由书签替它启用。

- 2026-09-24临时Chat兼容：`/new?incognito=`仍使用原Chat payload/schema与`source.entry_surface:"chat"`；`source.url`忠实保留临时入口，`source.conversation_id`保存当前消息组件证实的真实UUID，不从通用URL推断身份，也不伪造`/chat/{id}`永久链接。Full/Tree原始响应继续保留平台`is_temporary`字段；没有新增必填字段或改变普通Chat/Cowork语义。

- Cowork 用户上传附件独立于正文：从 article 内 `MessageAttachmentsFile / MessageAttachmentsImage` 冻结图像 `src` 与文件 UUID，再写入原消息的既有 `attachments`、资源表与下载卡。Light 图片压 WebP、非图片文件只留元数据；Full / Tree 文件走同源 `files/{uuid}/contents`，响应未声明 MIME 时由已取得的附件文件名补充 MIME，不改字节。三版保留每个实际上传卡，不能因重复图片或用户文字未包含文件名而漏采；普通 Chat 的附件接口与既有 schema 不变。
- Claude 三轨当前待验收版本为 Light `1.1.40`、Full / Tree `1.1.39`；上一验收版 Light `1.1.34`、Full / Tree `1.1.35` 是逐字冻结回退点。Chat 接口 thinking 已有公开 summary/body 与时长时，不得仅因页面挂载 `TurnStatus` 就重复打开；time-only / 空 thinking，或当前挂载消息明确有活动面板而 API 完全没有 thinking/tool block 时，才读取该 disclosure。API text 多于 DOM rich block 时先建立有序强语义锚点，只在相邻锚点之间“未决 text 数 = 未决 DOM 数”时做位置补配；API-only 文件/Artifact 标题保留显式空槽，后续最终总结必须归到自己的 DOM 节点，不能重复渲染。公开 `image-search`、时间、来源、分支、模型证据与三类 payload schema 不变。
- Cowork 不调用 Chat 会话树接口。完整 Rocksteady DOM 时间线是可见正文、公开 disclosure、时间、图片、图表、Artifact 和富格式的首要权威，必须先完整扫掠并按位置冻结。公开思维保持 Sample 的 thinking/activity 表示；页面私有字形先从纯文本与富 DOM 克隆中剥离，只有可读文本、链接、媒体、代码、表格、数学或 Artifact 身份之一存在时才让富 DOM 覆盖可读摘要，结构非空但语义空白的壳不得制造乱码。Cowork 用户气泡按实页 15px/20px、12px/16px 和段落零边缘距渲染，该样式不影响 Chat。React `messageChainData` 的结构化工具逐字保存在消息级 `cowork_page_tools`；阅读层按同消息 `tool_use.id / tool_result.tool_use_id` 配对为默认折叠的工具调用，保留参数、完整结果及未知结构化内容，未配对结果也不丢弃。`WebSearch` 结果中的全部标题/URL可点击，原始结果仍可展开；仅有对应机器结果时移除重复的原生搜索行。思维摘要不并入工具原文，导出诊断仍只在元数据。DOM Markdown 缺少的 Mermaid fence仍可补入，DOM 真正缺少消息时才用 page-state 抢救。Cowork Tree 仍与 Full 等价，不制造分支。
- `/chat/{uuid}` 的 Light / Full 使用 `tree=False` 取得完整当前路径与全部工具，Tree 才使用 `tree=True` 取得完整规范化树、当前路径与同级分支；`/cowork/cse_…` 不误用 Chat 会话接口。Cowork 先滚到顶部唤醒历史，再耗尽真正的服务器分段入口；`[data-rocksteady-sizer][data-testid="transcript-sizer"]` 内隐藏的 “Load earlier/later” 是逐条移动虚拟窗口的无障碍步进器，必须忽略。若 1..N article 在唤醒后已同时挂载，先有界冻结全部位置以补回虚拟列表中间窗口；若时间线可滚动，仍按需从顶到底完成一次视口富内容扫掠，因为公开 Thought、工具、图片、Shadow DOM 图表和正文可能只在附近水合。只有完整且不可滚动的时间线才允许直接复用当前加载态。两种入口由 manifest `source.entry_surface` 明确区分。
- Cowork 助手 article 必须作为一个有序整体保存：公开 Thought、工具/搜索活动、可点击来源和最终回答保持页面先后顺序；可公开折叠控制先转换为惰性标签，再移除按钮，不能只留下最终回答。
- Cowork 没有消息分支。轻量（Light）保存轻量时间线资源；全量（Full）保存可取得的完整资源；整树（Tree）在 Cowork 入口与全量（Full）等价，不显示分支按钮，也不写虚构 branch tree、branch navigation 或分支计数。普通 Chat 的整树行为不变。
- 当前已挂载正文实行双轨忠实：消息 DOM 是段落、列表、缩进和可见布局的呈现权威，API Markdown 是原始字符、代码围栏信息串及后续解析的内容权威。该规则同时适用于用户与助手，原始 API Markdown 仍逐字保存在机器 payload。
- Chat 的接口—DOM 投影一旦由完整当前路径、`aria-posinset / aria-setsize` 与角色共同证明，就不得再因水平线、脚注或工具摘要造成的纯文本差异拒绝该条富 DOM。Markdown 脚注的引用与返回链接必须按消息和正文块重命名为局部唯一片段锚点，离线页不得把 `#...` 当成无效外链拆掉。
- 代码语言恢复先保留可靠的原生标记：Cowork同一代码壳仅含一个pre，且code的 `language-X` 类与组的 `aria-label="X code"` 一致时，直接转为 `pre[data-language]` 并去掉该壳重复语言标签，不猜源码语言。否则仍按规范化正文定位同一内容组，只有源围栏与DOM普通代码数量完全相等、正文逐个逐序一致时才补语言。Mermaid、Artifact、静态图示源码和相邻工具卡不参与普通代码计数。新版 `data-mermaid="true"` 的开放Shadow SVG须在克隆前静态化；归属不明时保持DOM不变，不靠全局序号配对。Cowork用户段落保留真实换行，只有外层气泡继续折叠排版空白；不改变原始文本或Chat呈现。
- Cowork Artifact 必须从所属消息 React 文件元数据取得 `fileUuid`、路径和文件名，再通过同源 `/api/organizations/{org}/files/{fileUuid}/contents` 保存字节；不得从卡片标题猜文件身份。全量（Full）与 Cowork 等价整树（Tree）在原消息位置提供预览和离线下载；文本类文件同时保留源码，SVG 既是文件也可作为静态预览。
- Chat 的 `present_files` 工具结果必须把每个 `local_resource.file_path` 归到所属消息，并与同路径 `create_file` Artifact 去重。全量（Full）/ 整树（Tree）通过同源 `/api/organizations/{org}/conversations/{conversation}/wiggle/download-file?path=…` 取得原始字节，写入 Artifact `file_data_url / size_bytes / mime_type / retrieval` 并在工具结果原位提供离线下载；轻量（Light）仍只保留接口元数据。接口失败只进入统一机器诊断，不在阅读正文制造警告或伪造可下载文件。
- 新版 Cowork 的 `Write` 工具行可能没有 `fileUuid`，但其 React 块在公开面板卸载前直接提供 `path / fileText` 或 `block.input.file_path / content`。三轨均须在折回页面前冻结路径与源码，但不能把Write/Read制作记录当作正式交付：工具内保留路径与源码；只有原生交付卡通过所属Artifact工具的精确file_path匹配时，才在该卡原位显示预览/源码/下载。Read面板文本不能冒充被读取文件的原始字节。现行产物可附`presentation_name/source_url`保存原生卡名称与来源；不覆盖真实下载文件名。
- Claude Chat的连续思考/工具按原始blocks顺序成组，不抽取全部thinking后再拼工具。正文仍保持原位；present_files正式文件卡以DOM锚点优先，离屏时采用原站已核验规则：回复以正文结束则卡片位于正文后，否则保留交付步骤位置。同路径创建/交付仅在同消息去重。Cowork的`cowork_disclosure_key`与阅读占位只关联已捕获公开面板，不能替代或删除原始工具字段；无关联证据时仍保留内容，不猜跨消息位置。
- Claude 页面可能为同一正文挂载重复 sibling。只有两个 sibling 的 `role="group"`、`aria-label` 身份均可确认，且纯文本与代码语言语义完全相同时，才删除后一个重复副本；缺少任一证明就全部保留。去重不得改变消息顺序、代码正文、Mermaid、Artifact、公开思考或工具内容。
- 离屏或非当前分支没有可复用 DOM 时，只允许做行内 Markdown 与代码围栏格式化，不得把用户输入中的 `1.`、`2.` 等测试文本猜成结构化列表。API 中未缩进、位于第 8 项之后的“请依次完成……”与其后段落仍是同级正文，不属于第 8 项。
- Chat 的完整接口树是普通 Markdown、公开 thinking `summaries[]`、结构化工具输入/结果、来源、附件与资源字段的内容权威；当接口当前路径条数与页面 `aria-setsize` 一致时，先保存当前可见窗口，再仅把 image-search 原位布局、未知视觉 result type、Mermaid/SVG/HTML 等页面专属呈现、空正文及未知 block 列入 `required_positions`。已由 API 完整给出的 `tool_use` 名称/输入和 `tool_result` 文本、knowledge、local_resource、来源与 raw 对象直接保存，不得只因页面也画了工具卡就反复滚页。页面专属位置先按消息比例定向定位，未收齐才加载更早片段并重试，仍失败才回退约 18% 重叠的线性完整扫描。接口已给出公开思考摘要和时长时同样不得重复遍历。Cowork 继续以 DOM 时间线为内容事实源，分段预载后最多执行一次单向富内容扫掠。不得为了提速取消未知结构回退、图表、图片、附件、来源或当前路径完整性校验。
- 抽取遵循 recover-first：优先读取会话接口并恢复消息树；接口树不完整或层级异常时尽量修复、保留已取得节点，再用当前页面 DOM 补回真正未对齐的可见内容，不能因为单个面板无法展开就终止整份导出。
- 当前活动路径按父子关系恢复，不能把全局 `index` 当作路径连续性；DOM 对齐同时使用路径序号、角色和内容签名，避免把分支或相邻消息错配。
- 轻量（Light）保存当前活动路径及轻量资源；全量（Full）额外保存可取得的完整资源字节、原始会话/HTTP 证据；整树（Tree）保存规范化完整树，并在离线页提供同级分支切换。三者都只在 manifest 的统一 `capture_diagnostics` 信封保留机器诊断，阅读 DOM 为零导出器诊断。
- 当前成品要求可取得的正文、公开思考、工具/搜索面板、静态图表、来源与附件完整保存和正确渲染；recover-first 只规定未来发生局部失配时仍应抢救其余内容，不是允许当前成品带已知缺失交付。
- Cowork 的局部 `aria-setsize` 不能证明历史已穷尽。已识别的同会话原生历史控制器须先完成串行补载；`capture.dom_enrichment.native_history` 为可选 `{ complete, requests }` 完成证据，未识别时为 null。已知原生历史仍不完整时不能因局部位置齐全写成 `dom_enrichment.complete=true`；保留已取得正文，诊断只进既有信封。加载后刷新页面结构化工具/源码补充，不用启动时尾片段覆盖完整 DOM。
- Claude 图片揭示按钮必须在剥离交互控件前映射为对应图片。普通 Chat 的接口 Markdown 图片继续使用既有占位路径；Cowork 的无 URL `Show Image` 必须在其消息仍挂载时有界解析一次：若动作暴露图片 URL/字节，按轻量（Light）缩略图或全量（Full）完整资源路径原位内嵌；若只暴露查看页 URL，原位保留可点击链接；两者皆无时只在 manifest 诊断中记录，不在阅读正文制造警告。Google `/s2/favicons` 等来源卡站点图标不属于正文图片，绝不能放大、内嵌或进入资源计数。单张未展开或取得失败的 Markdown 图片在接口 Markdown 表达中只能原位降级为 alt + URL；若该图片缺口使正文块按既有规则选择接口 Markdown，只有 Mermaid 源码节点数与已分类 SVG 资源键数完全相等时才允许在各源码节点原位置重建“图 / 源码”卡。已取得 SVG 图表必须保留原正文顺序并标记为内联资源，不得统一后置或按普通 SVG 猜配。
- Claude Chat 的助手标签与 payload `messages[].model` 只能来自该条消息自身的明确 API 字段，并同步保存 `model_provenance`。顶层 `conversation.model` 与页面模型选择器只表示会话当前/默认模型，可保留在 header、manifest `source` 与 payload `conversation`，但不得回填历史消息；某条消息没有可验证模型证据时必须显示通用 `Claude`。
- Parser与Reader同样遵守这一边界：当前选择值不进入历史消息Front或实际模型汇总。现行逐消息具体型号须有`model_scope=message`与`conversation_api.message...`的provenance；无证据不能因为非空`model`或标题含型号而猜测。采云身份意义的唯一主规则见[现行Front合同](docs/2026-09-08_采云V1现行工程规范-GPT-6-Astra/Core/03_Front与呈现绑定-GPT-6-Astra.md#2-名字模型与角色)。
- Claude 的 `\ce` 与 `\pu` 使用固定 Temml 0.13.3 上游官方 mhchem 扩展离线生成 MathML；原始 TeX 仍保存在 annotation 与 payload。解析器不得把成功渲染的化学 MathML 降级成字面量源码。

## 八、统一 JSON 与 Reader 的交接原则

**2026-09-21 · 现行V1消费侧补充（不改书签HTML格式）**：Parser保留表格、列表和段落内图片的位置时，按[现行Core02](docs/2026-09-08_采云V1现行工程规范-GPT-6-Astra/Core/02_Conversation与Mark原件权威-GPT-6-Astra.md)使用本篇资源编号的HTML引用。图片字节只在Conversation资源中保存；Reader与Markdown导出负责原位解析，不把源容器拆成不完整HTML片段。此规则不要求导出器产生采云内部属性，不变更已验收书签、厂商payload或下载原件。

- ChatGPT `sources[].snippet` 是网页纯文本摘录，不是助手创作的Markdown。现行三版在搜索工具中按字段精确匹配后以 `span.source-snippet` 转义呈现，保留美元、反引号和其他原字符；工具外普通消息、未匹配的工具正文与公式保持既有渲染。原payload字段/字符/来源归属不变，不把摘录里的价格或命令行当TeX。

当前 V1 新写格式是 `cloudig/conversation/1.0.0`，机器合同在 `src/core/contracts/`，语义与任务路线从 `product/README.md` 进入。它不是旧 `ai-chat-archive/conversation/1.0.0`；不能只比较版本数字。下节旧字段与兼容表仅约束原 root Parser/Reader 库存，不授权 V1 新写旧格式，也不宣称 V1 已实现旧格式迁移。

### 8.1 旧 root 实现的交接合同（历史兼容参考）

最初的 V0.1 统一 JSON 已冻结为 [`schema/conversation-0.1.0.schema.json`](schema/conversation-0.1.0.schema.json)，格式值为 `ai-chat-archive/conversation/0.1.0`。旧 root Parser 新写 Light / Full 网页合同为 `conversation/0.1.5`，网页 AllBranches 与 Claude 官方导出恢复合同为 `conversation/0.2.5`；Reader 继续只读兼容既有 0.1.x / 0.2.x 合同，旧事实文件不原位改写。统一 JSON 始终是“人类可读、稀疏、精简的长字段 JSON”，以奥思档案公开版 Dataset 为可读性参考，不以私人中间审计 V1 为输出模板。十二份 HTML 的字段取舍见 [`docs/2026-07-20_十二份HTML统一JSON字段审计-GPT-5.6-Sol.md`](docs/2026-07-20_十二份HTML统一JSON字段审计-GPT-5.6-Sol.md)，三档现行映射见 [`product/2026-07-31_采云三档HTML与统一JSON映射合同-GPT-5.6-Sol.md`](product/2026-07-31_采云三档HTML与统一JSON映射合同-GPT-5.6-Sol.md)。

Reader JSON 至少保留以下语义层：

- `schema`：固定格式与版本；该版本是 Reader 能否理解会话结构的硬兼容边界，也已表示“当前阅读序列”，不再重复写恒定 `content_mode`。
- `parser_version`：生成该篇 canonical JSON 的总 Parser 版本；0.1.3+ / 0.2.3+ 新写事实必填。它用于逐篇重解析水位与禁止旧 Parser 覆盖新版成果，不决定 Reader 是否可读。
- `parser_adapter`：0.1.4+ / 0.2.4+ 新写事实必填的 `{ id, version }`；记录实际生成该篇 JSON 的来源适配器及其 SemVer。平台专项适配器升级只影响命中的来源，不把总 Parser 发布误当成所有平台都变化。完整发布快照只追加到 `parser/version-history.json`。
- `parsed_at`：0.1.5 / 0.2.5 新写事实必填；记录这份 canonical JSON 成功生成或重解析完成的 UTC 时间。每次成功重解析刷新，扫描、失败和中断不刷新；测试通过注入时钟保持可重复。
- `exporter_version`：书签 HTML 存在导出器版本时，按上述两种 manifest 字段原样投影；Claude 官方导出等没有采云书签导出器的来源省略。不得改写成当前安装书签版本，也不得因版本较旧就认定必须重新下载。
- `conversation_key`：当前新写合同必填的脱敏稳定 SHA-256 会话身份；不保存厂商原始私有 ID。旧 `conversation_id` 仅兼容读取，迁移时原值不变且不与新字段同时写。
- `source_file` / `source_sha256` / `source_size_bytes`：最低来源身份；basename 不得泄露本地路径，来源页 URL 与导出时间只在存在时写。
- `title` / `provider` / `platform` / `models`：会话事实元数据，具体模型必须有来源字段证据。provider 表示公司，platform 区分 ChatGLM / Z.ai 等网页产品。用户设定的 `conversation_name` 只写在 `cloudig-library.json` 覆盖层，不回写事实 JSON。
- `content_time`：第一条有效消息时间；没有时使用复制进 Inbox 前捕获的原输入创建时间。Library 同名覆盖优先，不能用导出时间、文件修改时间或 `parsed_at` 代替。
- messages：当前选中会话序列；数组顺序就是阅读顺序，不重复写无用途 sequence。
- `turn_id`：把同一 AI 回答周期的正文、思考、搜索、工具和状态归成一组；不删除、吞并或重排原始记录。
- `content`：`markdown`、`text`、`reasoning`、`reasoning_summary`、`status`、`code`、`math`、`image`、`attachment`、`search`、`citations`、`tool`、`diagram`、`html` 与 `unknown` 有序块。
- `resources`：书签已经内嵌的图片字节，以及非图片附件或未下载外部图片的 metadata-only 记录。
- `sources`：搜索与网络引用；URL 保留为惰性链接数据。
- `warnings`：只保存影响阅读或内容完整性的必要警告；没有警告时省略。

canonical JSON 不默认重复保存逐字段 locator、evidence、coverage、完整厂商 payload、空数组、null 或默认值。详细来源对齐和 coverage 仍由 Parser 测试、私有调试结果与工程报告验证；它们不膨胀 Reader 的日常输入。

每段正文只选一个可靠主表达：有精确 Markdown、TeX、代码或图示源码时保存源码；语义源码无法保真时才保存安全 HTML、MathML、SVG 或内嵌图片。不得为“保险”无条件重复同一正文的 Markdown、纯文本和 HTML。已内嵌图片必须带实际字节数与 SHA-256；本地校验器会重新解码验证。

轻量（Light）/ 全量（Full）只保存当前活动分支或当前 DOM 阅读序列，统一写扁平 messages；`conversation/0.1.x` 不建立 branch、fork、alternative 或 swipe 空字段。ChatGPT、DeepSeek、Grok、Kimi、Qwen、Z.ai、Mistral、Claude 的整树（Tree；内部 AllBranches）HTML 与 Claude 官方导出灾后恢复新写 `conversation/0.2.5`，保留脱敏父子关系和全部叶路径；既有 `0.2.0` 至 `0.2.4` 仍由受支持 Reader 只读兼容。采云只阅读与切换来源分支，不提供 branch 编辑。Codex、SillyTavern、自建 JSON、历史 MHTML/TXT 和完整附件仍留待后续真实样本与版本升级。

### 8.2 Reader 的共同原则

- 只读取统一 JSON，不直接维护 12 套厂商选择器。
- 同一平台的不同 HTML 实例可以分别覆盖普通聊天、Scheduled、Cowork、识图或其他真实功能入口；它们是并列 case，不按平台名合并。文件名及 ` (1)` / ` (2)` 后缀只作人工配对，profile 与分支能力只信 manifest、导出器版本、payload schema 和来源入口事实。
- 只按 `schema` 判定结构兼容；支持该 schema 时，不因 JSON 来自更高 Parser 而拒读。未知 schema 只隔离对应单篇并提示升级，不拖垮其他兼容会话。
- 不执行厂商 HTML 脚本，不重新访问登录接口、资源 URL 或签名地址；普通链接只有用户主动点击才打开。
- Markdown、代码高亮、清洗、LaTeX/MathML、CSS 和所需字体必须随 Reader 固定版本离线打包，不使用 CDN 或远程 import。
- 公式优先使用规范化精确 TeX；没有 TeX 时才使用已清洗 MathML。高级公式范围必须通过现行书签的完整 TeX fixtures。
- 代码、列表、表格、图示、用户换行、AI 生图、上传图片缩略图、非图片附件名称和搜索来源保持结构语义。
- warning 与正文分区，不能把工程说明插进原会话内容。
- HTML 阅读 DOM 与 inert payload 已经取得的非诊断内容必须在统一 JSON 与 Reader 中得到等价还原；同一语义的双重证据可以择优合并，不能整类静默删除。导出器 / Parser 自己的错误、恢复说明和重复诊断不进入阅读层；原站可见错误仍按来源内容处理。
- 模型名、思考状态和资源可用性按真实字段显示，不依据文件名猜测。

## 九、网页改版维护流程

完整的通用判断流程见 [`bookmarklets/ENGINEERING_GUIDE.md`](bookmarklets/ENGINEERING_GUIDE.md)。本节只保留与 Parser / Reader 合同直接相关的最短流程。

以后网页改版时，按以下顺序处理：

1. **先读状态与契约**：读 [`AGENTS.md`](AGENTS.md)、[`PROJECT_STATE.md`](PROJECT_STATE.md)、本文件，再读对应平台最新专题报告。
2. **先确认故障层**：区分浏览器初始化、Chrome/内浏览器连接、CDP 来源授权、站点登录/API、懒加载和选择器问题；权限故障不能用改书签绕过去。
3. **冻结当前产物**：在任何改动前，把现行 source/min 成对保存到 `bookmarklets/legacy/`，永不覆盖旧版。
4. **实页取证**：在用户授权且已登录的代表性会话上检查接口、DOM、数据属性、虚拟列表、思考展开、首尾消息、图片资源和视觉宽度。
5. **先修取得，再修呈现**：消息缺失、顺序、资源、公开思考和原始 Markdown优先；CSS 不能掩盖数据缺失。
6. **保持 schema 兼容**：若 manifest、payload 脚本 ID、捕获范围、消息身份、字段语义或资源策略改变，必须更新本文件并考虑升级 payload schema。只改视觉 CSS 不应伪造 schema 变化。
7. **机械构建**：只改维护源码，用构建脚本生成严格单行 `.min.js`，不得手工压缩。
8. **全站回归**：平台专项合同通过后仍要跑全部 12 站合同，确认冻结平台没有被共享运行时或构建器改变。
9. **真实输出验收**：自动合同不等于用户验收。必须检查实际下载 HTML 的首尾消息、复杂格式、公开思考、图片、来源和资源计数。
10. **更新现行入口**：更新 `PROJECT_STATE.md`、本契约中受影响的事实、必要的新日期报告与文件操作记录；旧日期报告不回写。

任何“修一个坑出另一个新坑”的高风险改动，都应把旧缺陷的正向合同和新缺陷的反向合同同时加入回归，而不是只检查新选择器是否命中。

## 十、回归检查清单

### 导出器

- [ ] 下载文件名与会话标题正确，豆包补后缀规则未误触。
- [ ] 当前分支/当前 DOM 序列范围与 manifest 一致。
- [ ] 用户、助手、公开思考、工具、引用、附件和图片计数合理。
- [ ] 首条与末条消息身份正确；虚拟列表平台不能只看总数。
- [ ] 用户段落、复杂列表、代码、引用真实段落间距、表格左/中/右对齐、Markdown 图片原位置、公式和图示未回归。
- [ ] 可见公开思考已取得；折叠/展开状态恢复。
- [ ] 轻量（Light）图片真正内嵌为 WebP，全量（Full）图片保留成功取得的原始字节与 MIME，计数与资源状态一致；不会因整份导出累计达到旧版 8 MiB 阈值而省略后续图片；一般非图片附件只有元数据，ChatGPT 全量（Full）/ 整树（Tree）可取得的消息级 `sandbox:` 文件则保存原始字节、真实 MIME、文件名及消息/分支归属。
- [ ] 正文没有打印、页脚、存档说明、失败资源解释或原站交互控件。
- [ ] 模型名有 API/消息 provenance，不来自标题。

### HTML 解析器

- [ ] 可容忍 UTF-8 BOM。
- [ ] 只接受明确的 `ai-chat-archive/manifest-v1` 或明确 legacy 适配器。
- [ ] 兼容 `format/schema` 与 `element_id/script_id`。
- [ ] 按 payload schema 分派，缺少 manifest payload 描述时使用固定表兜底。
- [ ] 同键多片段不覆盖；Mistral 版本键不丢失。
- [ ] machine order、DOM order、计数和首尾身份交叉验证。
- [ ] 消息级来源和资源归属不被提升到全局页面尾部。
- [ ] 优先保存原始 TeX/Markdown/代码；仅在语义源码不能保真时保存安全 MathML/HTML/SVG，不无条件重复正文。
- [ ] 不执行脚本，不主动访问远程/签名资源，不泄漏私有 URL 和 ID。

### Reader

- [ ] 只消费统一 JSON。
- [ ] 正文与 diagnostics 分离。
- [ ] 复杂列表、代码、公式、图示、公开思考和用户换行均可复现。
- [ ] metadata-only 资源不会显示成“可下载完整文件”。
- [ ] 外链、富 HTML 与 SVG 使用安全渲染策略。
- [ ] Markdown、代码高亮、清洗、公式运行时、CSS 与字体均为本地固定版本；断网时不缺功能。

## 十一、工程入口

2026-09-15兼容补充：Claude的结构化记忆工具仍使用原有`blocks[].type/name/input/content`字段，阅读投影归入activity/工具折叠，不新增Schema或删减原文；ChatGLM助手显示名优先本条已有`model`，缺失才用平台名。Mistral的同消息多Thought必须按所属段保存，不得以同消息首个正文填补后续空段。Z.ai的显式双美元表达式在列表行内位置仍保持display语义。

- [`README.md`](README.md)：项目总入口。
- [`PROJECT_STATE.md`](PROJECT_STATE.md)：唯一现行状态检查点。
- [`bookmarklets/README.md`](bookmarklets/README.md)：12 站现行模式、版本、文件名与构建基线。
- [`scripts/bookmarklet-targets.mjs`](scripts/bookmarklet-targets.mjs)：平台、版本、源码和单行成品的机器清单。
- [`docs/README.md`](docs/README.md)：逐站报告、专题复修与历史证据路由。
- [`docs/2026-07-19_工程记录模板-GPT-5.6-Sol.md`](docs/2026-07-19_工程记录模板-GPT-5.6-Sol.md)：新增工程记录模板。
- `tests/private/`：被 Git 忽略的真实登录页与私有证据。

维护本文件时只写稳定协议、兼容规则和可复用陷阱；瞬时消息数、私有会话 URL、会话 ID、整段控制台日志和一次性选择器证据应留在私有夹具或日期报告中。

维护：GPT-5.6-Sol·奥思·星澜知衡 Osis.StarTideSage
