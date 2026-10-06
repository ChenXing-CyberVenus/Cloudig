# Unified conversation JSON contracts

本目录是旧 root 实现的 Schema 库存，不是现行 V1 新写入口。V1 使用 `cloudig/conversation/1.0.0` 与 `src/core/contracts/`，从 [`product/README.md`](../product/README.md) 进入；下文 `ai-chat-archive/*` 的状态与兼容说明只对应旧实现，不代表 V1 迁移已经完成。

Parser 0.5.x 目前仍只写 `conversation/0.1.5` / `0.2.5`。`conversation/1.0.0` 是内容时间系统的一次升版合同：它统一线性与分支消息，分支只通过可选 `parent_id` 表达；同时引入稳定档案实例、三类生命周期时间、采集依据、消息时间投影及 Parser / user / cleared 内容时间三态。Reader 双读与 Library 领域事务已经完成；Parser 仍需等 0.6 写入与迁移门禁完成后才生成该格式。

1.0.0 的 `messages/resources/sources/warnings` 显式复用已冻结的 0.2.5 内容块定义：这是为了保证本次升版不趁机改写已验收的正文、图片、附件、引用和工具语义，而不是让旧根结构继续支配 V1。

新 Parser 对 Light / Full 当前阅读序列使用 `ai-chat-archive/conversation/0.1.5`；八个平台网页 AllBranches 与 Claude 官方导出恢复使用 `ai-chat-archive/conversation/0.2.5`。Reader 继续按明确支持表兼容既有 `0.1.0` 至 `0.1.4` 与 `0.2.0` 至 `0.2.4`，旧合同不被原位改写。十二个版本都服务于 Parser 与 JSON-only Reader，不是厂商 payload 的镜像，也不是私人审计 V1 的缩写版。

## 文件

- `conversation-0.1.0.schema.json`：JSON Schema Draft 2020-12 合同。
- `conversation-0.1.1.schema.json`：增加确定的根级 `content_time` 与消息 `turn_id`。
- `conversation-0.1.2.schema.json`：既有单线合同；增加必填脱敏稳定 `conversation_key`。
- `conversation-0.1.3.schema.json`：既有单线合同；增加必填 `parser_version` 与可选 `exporter_version`。
- `conversation-0.1.4.schema.json`：既有单线合同；增加必填、精确到来源实现的 `parser_adapter`。
- `conversation-0.1.5.schema.json`：当前单线合同；增加必填 `parsed_at`。
- `conversation-0.2.0.schema.json`：既有分支合同。
- `conversation-0.2.1.schema.json`：在分支合同上增加 `content_time` 与 `turn_id`。
- `conversation-0.2.2.schema.json`：既有分支合同；用必填 `conversation_key` 取代旧技术字段名。
- `conversation-0.2.3.schema.json`：既有分支合同；每条消息必有脱敏 `id`，并增加必填 `parser_version` 与可选 `exporter_version`。
- `conversation-0.2.4.schema.json`：既有分支合同；增加必填、精确到来源实现的 `parser_adapter`。
- `conversation-0.2.5.schema.json`：当前分支合同；增加必填 `parsed_at`。
- `conversation-1.0.0.schema.json`：已落盘但尚未启用新写的 V1 统一合同。
- `examples/conversation-0.1.0.example.json`：不含真实会话信息的全能力合成样例。
- `examples/conversation-0.2.0.example.json`：三条消息、两个叶分支的精简合成样例。
- `examples/conversation-0.1.1.example.json`：展示同一 AI 轮次跨正文、思考和工具记录的精简样例。
- `examples/conversation-0.2.1.example.json`：带内容时间、轮次和两个叶分支的精简样例。
- `examples/conversation-0.1.2.example.json`：既有单线身份与分组样例。
- `examples/conversation-0.2.2.example.json`：既有分支身份、内容时间和父子关系样例。
- `examples/conversation-0.1.3.example.json`：既有单线 Parser / 导出器水位样例。
- `examples/conversation-0.2.3.example.json`：既有无书签导出器来源的分支水位样例。
- `examples/conversation-0.1.4.example.json`：既有单线 Parser / 适配器 / 导出器水位样例。
- `examples/conversation-0.2.4.example.json`：既有 Claude 官方恢复的 Parser / 适配器水位样例。
- `examples/conversation-0.1.5.example.json`：当前单线 Parser / 适配器 / 解析时间样例。
- `examples/conversation-0.2.5.example.json`：当前 Claude 官方恢复的 Parser / 适配器 / 解析时间样例。
- `examples/conversation-1.0.0.example.json`：V1 生命周期、采集依据、消息时间、内容时间及可选父消息的合成样例。
- `validate.mjs`：零第三方依赖的结构、稀疏性、引用和内嵌图片完整性校验器。
- `serialize.mjs`：固定字段顺序、两空格缩进和末尾换行的确定性序列化器。
- `validate-v1.mjs`：V1 结构间语义、消息时间投影、内容时间派生和既有内容块的本地校验层。
- `canonical-v1.mjs`：Conversation / Library 1.0.0 共用的确定性 JSON 字段排序与序列化器。
- `../tests/2026-07-20_统一JSONSchema验证-GPT-5.6-Sol.mjs`：正例、反例、全内容类型与确定性回归。

## 根字段

| 字段 | 规则 |
| --- | --- |
| `schema` | 新单线会话为 `ai-chat-archive/conversation/0.1.5`；新分支会话为 `ai-chat-archive/conversation/0.2.5`。旧版只读兼容。不重复写常量 `content_mode`。 |
| `parser_version` | 0.1.3+ / 0.2.3+ 必填；当前示例为 Parser 0.5.3。它记录生成这篇 canonical JSON 的总 Parser 版本，是来源水位，不代替 `schema` 的 Reader 兼容边界。 |
| `parser_adapter` | 0.1.4+ / 0.2.4+ 必填，且严格只有 `{ id, version }`。它记录真正生成该篇 JSON 的来源适配器及其 SemVer；总 Parser 升级不等于所有适配器都升级。完整快照见 `../parser/version-history.json`。 |
| `parsed_at` | 0.1.5 / 0.2.5 必填的 UTC ISO 8601 时间；表示这份 canonical JSON 成功生成或重解析完成的时间。每次成功重解析刷新，失败、中断或只扫描不改；测试通过注入时钟保持可重复。 |
| `exporter_version` | 书签 HTML 来源按 manifest 的 `exporter_version ?? exporter.version` 原值写入；Claude 官方导出等没有书签导出器的来源省略，不伪造。 |
| `conversation_key` | 新版必填的 64 位小写十六进制脱敏稳定会话身份。普通网页与一对多容器输出都写；它不显示、不可编辑，也不是厂商原始 ID。 |
| `source_file` | 只写输入文件的 basename，不写本地绝对路径。 |
| `source_sha256` / `source_size_bytes` | 输入 HTML 的最低可复核身份。 |
| `source_url` / `exported_at` | 原导出合同存在时才写；URL 只是惰性链接数据。 |
| `created_at` / `updated_at` | 0.2 容器能可靠提供会话级时间时才写。 |
| `content_time` | 新版必填。第一条消息时间优先，否则使用复制前登记的原输入创建时间；不得改用更晚消息、导出时间或 Parser 运行时间。 |
| `title` / `provider` / `platform` / `models` | 可读会话身份；模型名必须来自页面或 payload 证据。`models` 为空时省略。 |
| `messages` | 数组顺序就是阅读顺序，不另写无用途的 sequence。 |
| `resources` / `sources` / `warnings` | 有内容时才写，并放在正文之后。 |

除根级 `parsed_at` 外，不写其他 Parser 运行时间、绝对路径、cookie、厂商原始会话私有 ID、完整厂商 payload、逐字段 locator、空数组、`null`、默认值或 branch 占位。`conversation_key` 必须来自适配器或编排层的脱敏稳定身份，不能原样暴露厂商 ID。旧事实中的 `conversation_id` 只作兼容读取；迁移时值原样成为 `conversation_key`，新文件不得同时写两者。0.1.x 消息 `id` 只在交叉引用或诊断确有用途时写；0.2.3+ 每条消息都必须有唯一脱敏 `id`。同一个厂商消息 ID 若对应多个有序可见片段，适配器可以在 Flat 中拆成多个无 ID 消息，或在 Branches 中生成唯一片段 ID，不能互相覆盖。

0.2 的 `parent_id` 只表达“这条消息直接接在哪条消息后面”，不另造 branch 数组、选中状态或重复正文。`id` 与 `parent_id` 都必须是脱敏后的稳定身份；灾后导出若缺少父消息，允许 `parent_id` 指向未包含的祖先，并由 `warnings` 明示。0.2.3+ 中，已包含父节点必须先于子节点、图不得成环、最后一条消息必须是叶节点；Parser 把来源当前叶的完整路径放在数组末尾。Reader 从父子关系计算叶分支，默认选择最终一条代表的来源当前路径；切换分支只改变显示路径，不丢弃其他消息。这些新增图门禁不倒推到 0.2.0 至 0.2.2。

## 有序内容块

| `type` | 用途 |
| --- | --- |
| `markdown` / `text` | 精确 Markdown 或不应解释为 Markdown 的纯文本。 |
| `reasoning` / `reasoning_summary` / `status` | 只保存用户可见的思考正文、摘要与状态；支持标题、正数时长、effort 及一种正文表达。没有记录时长或值为零时省略 `duration_seconds`。 |
| `code` | 独立代码组件及已有语言、文件名。Markdown 围栏内的代码不必重复拆出。 |
| `math` | 精确 `tex` 优先；确实没有 TeX 时才写已清洗 `mathml`。两者不能重复。行间公式只在 `display: true` 时写该字段。 |
| `image` / `attachment` | 指向末尾 `resources`；图片位置另写已知的 uploaded、generated、inline、search 或 diagram 语义。 |
| `search` / `citations` | 搜索事件和消息内引用位置；通过稳定 `source_ids` 指向末尾 `sources`。 |
| `tool` | 用户可见的调用、结果或活动摘要，不默认保存隐藏原始输入输出。 |
| `diagram` | Mermaid、Markmap、SVG、Canvas、writing block 等只保留一种可靠表达。 |
| `html` | Markdown、TeX、代码或图示源码无法保真时的已清洗富文本兜底。 |
| `unknown` | 当前无法归类但确实用户可见的组件；它是受控保留口，不是任意扩展包。 |

同一正文只保留一种主表达。若 payload 有精确 Markdown、TeX、代码或图示源码，就保存源码；只有语义源码不足时才保存已清洗 HTML、MathML 或 SVG。Reader 仍需再次按固定本地规则清洗，不能因为字段名叫 `html` 就直接信任。

新版每条消息都带 `turn_id`。同一轮 AI 回复里的正文、公开思考、搜索、工具调用与结果共享轮次 ID；Reader 可按轮次计数、导航并只显示一次完整 AI 头像，但不得删除、合并或重排原始记录。ChatGPT 当前 128 项有效可见时间线仍完整保留。其他平台的公开思考、来源、附件和特殊组件同样按页面阅读位置进入 `content`。

角色接口保持稀疏：`user` 与 `assistant` 表示会话的主要双方，`system`、`developer`、`tool` 表示功能角色；来源中真实出现的第三方参与者使用 `role: "other"`，并在来源能提供身份时写非空 `name`。Reader、搜索和 Markdown 导出必须保留该角色、名称和正文，不得把第三方强行改成用户或助手。不同参与者必须使用不同 `turn_id`，即使消息相邻也不能借同一轮次合并；未来若需要更丰富的参与者目录，再新增独立稀疏索引，不把猜测字段预塞进每条消息。

ChatGPT Scheduled 仍复用既有内容合同：任务定义或“已安排”列表写为 `type: "tool"`、`kind: "activity"`、`name: "schedule"` 的可见静态块；同一次自动运行的工具与最终正文共享一个 AI `turn_id`，不同运行各自成轮，不要求前方存在用户消息。这个映射本身不新增 Scheduled 专属字段；本轮 Schema 升版只来自所有新输出共有的 `parsed_at`。

## 资源与外链

- `availability: embedded` 当前只允许图片，必须同时有 `image/*` MIME、实际字节数、SHA-256 和规范 Base64 `data_url`。校验器会解码并重算长度与哈希。
- `availability: metadata_only` 可用于 TXT、DOCX、PDF、TEX 等附件，也可用于书签没有下载的外部图片。它不得带 `data_url`。
- `availability: missing` 只表示页面承认该资源但没有可用字节或 URL；相关原因写入 `warnings`。
- 已内嵌图片不重复保存可能过期或含签名的远程 URL。未内嵌而仍有普通 URL 时可原样保留；Parser 和 Reader 都不得主动请求它，只有用户主动点击才由宿主环境处理。
- V0.1 不保存非图片附件字节，不生成 sidecar，也不把 metadata-only 卡片伪装成可离线下载文件。

## 验证

在工程根运行：

```powershell
node .\schema\validate.mjs .\schema\examples\conversation-0.1.0.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.2.0.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.1.1.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.2.1.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.1.2.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.2.2.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.1.3.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.2.3.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.1.4.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.2.4.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.1.5.example.json
node .\schema\validate.mjs .\schema\examples\conversation-0.2.5.example.json
node .\tests\2026-07-20_统一JSONSchema验证-GPT-5.6-Sol.mjs
node .\tests\2026-07-24_Cloudig身份与资料库迁移回归-GPT-5.6-Sol.mjs
```

`validate.mjs` 不解析 HTML，也不联网解析 `$schema`；它是与 Draft 2020-12 文件配套的本地语义校验层，额外检查跨引用、唯一 ID、内嵌图片长度与哈希。

## 升级边界

0.1.5 / 0.2.5 在既有内容、身份、顺序与适配器水位合同上增加 `parsed_at`；不改变来源内容语义。`schema` 仍是读取兼容的硬边界：Reader 不能因为 `parser_version` 较新就拒绝一个仍受支持的 Schema，也不能因为 Parser 版本较旧就猜读未知的新 Schema。旧 Parser 不应自动覆盖由更新 Parser 生成的 JSON；重新解析必须由用户在解析管理流程中明确触发。0.1.4 / 0.2.4 与更早文件继续按支持表读取，新文件不回写旧合同。

十二份现行 HTML 与十一份锁定书签的字段依据见 [`../docs/2026-07-20_十二份HTML统一JSON字段审计-GPT-5.6-Sol.md`](../docs/2026-07-20_十二份HTML统一JSON字段审计-GPT-5.6-Sol.md)。

维护：GPT-5.6-Sol·奥思·万卷同辉 Osis.MyriadScrollsShineTogether
