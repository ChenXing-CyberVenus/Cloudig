# Cloudig V1 内容时间领域命令

- 合同版本：1.0.0
- 当前状态：T6 机器实现完成；Parser 0.6、空旧根 V1 初始化与三个正式界面已接入
- 权威语义：`采云内容时间原型标准-2026-08-25-01.md` 与军师 V1 后端方案

本页只保存跨上下文需要直接查到的运行接口与写入纪律，不复制时间算法、视觉规格或完整 Schema。

## 1. 权威与写入边界

- `cloudig-library.json` 1.0.0 拥有用户覆盖、完整时间图和 `conversation_bindings`。
- Conversation 1.0.0 保存同一 `edit_id` 的有效内容时间及有界 Sovereign snapshot，保证单篇可独立阅读。
- Parser 默认、用户 `set`、用户 `cleared` 是三种不同状态；清空不能回退成 Parser 默认。
- V1 禁止前端拼整份 Library 后调用 `library.save`；旧命令只写 0.x，V1 返回 `CLOUDIG_V1_DOMAIN_COMMAND_REQUIRED`。
- 纯预览不写盘；写命令只接受 Desktop 已附着的资料库根。

## 2. 现行命令

| 命令 | 作用 |
| --- | --- |
| `library.prepare-empty-v1` | 已是 V1 时只读返回；旧根仅在 Inbox / Conversations 都无文件时原子建立 Library + parse-state 1.0，否则零写拒绝 |
| `time.range.preview` | 规范化草稿、标签、倒序 warning 与排序描述符；anchor 只作本次预览 |
| `time.system.get` | 返回 Library SHA、limits/preset 水位、图 revision 与当前时间系统 |
| `library.preferences.commit` | 稀疏更新长期身份、主题、workflow 与平台覆盖 |
| `conversation.metadata.commit` | 标题/平台/模型/称呼与内容时间的 Library + Conversation 双落盘 |
| `time.node.commit` | 无引用时间轴上的 timeline/time 新建或编辑 |
| `time.containment.commit` | 无引用时间轴上的包含链接增删改与局部无空洞排序 |
| `time.counterpart.commit` | 无引用时间轴上的规范无向直接对映 |
| `time.terran-mapping.commit` | 无引用时间轴上的直接 Terran mapping |
| `time.terran-preset.commit` | 内置 Terran 节点稀疏覆盖或恢复默认 |
| `time.display-order.commit` | 独立时间轴顶层陈列顺序或恢复最后编辑倒序 |
| `time.node.delete.plan/commit` | 先列精确关系和引用；仅无关系节点可直接删除 |
| `time.reference.remove.plan/commit` | 先列会话标题和字节；确认后批量取消 binding 并更新全部会话 |
| `time.timeline.plan/commit` | 有引用图修改；支持全部同步、选中分叉、仅未来分叉 |

Sovereign 新选择由 `conversation.metadata.commit` 的 `sovereign_selection + node_ref` 意图在同一事务内分配 binding；没有独立的公开“先建孤儿 binding”命令。

## 3. 水位与幂等

每个写命令至少携带：

- `request_id`；
- `expected_library_sha256`；
- 涉及会话时的 `archive_id + expected_sha256`；
- 涉及图时的 `expected_document_revision` 或明确 revision map；
- 多会话操作的已确认 `plan_id`。

同 `request_id + payload digest` 成功重试返回既有结果；同 request ID 换 payload 拒绝。最近 128 项只写入 `Data/Transactions/recent-operations.json`，不进入会话事实。plan 在 commit 前按当前 Library、图 revision、会话路径/大小/SHA 重新生成；任何漂移返回 `CLOUDIG_TIME_PLAN_STALE`。

## 4. 事务与历史

- Library、一个或多个 Conversation、短期幂等结果使用现有 file-snapshot transaction 同锁提交。
- 目标逐项保存 before fingerprint、exact-byte snapshot 和 expected fingerprint；中途失败整笔回滚，外部未知字节不删除。
- 真正用户状态变化前保存旧 Library exact bytes；只有根 `edited_at` 不同不占新历史槽。
- Catalog 与 `content-time-reference-index` 可重建，不拥有关系。引用索引固定为 `source_library_sha256 + source_time_system_revision + by_conversation/by_node/by_timeline`，不得复制 snapshot payload。

## 5. 时间轴同步

- `all_references`：原位修改当前 variant，刷新所有实际受影响 snapshot；任一会话冲突则零提交。
- `selected_references`：稳定克隆 variant，分配不可复用 `#`，只迁移明确选中的旧引用；计划必须是非空严格子集。
- `future_only`：克隆新 variant，不迁移旧引用。
- 普通图命令发现已有 binding 时返回 `CLOUDIG_TIME_TIMELINE_REFERENCED`，防止绕过同步事务。
- 是否需要更新会话由修改前后有界 snapshot payload SHA 比较决定，不靠“猜这个按钮大概影响谁”。

## 6. 实现入口与门禁

- 纯领域层：`library/domain-v1.mjs`
- 旧/V1 双读边界：`library/compat.mjs`
- 文件事务与命令服务：`manager/src/content-time-service.mjs`
- 唯一时间内核：`time/core.js`、`time/system.js`
- 命令路由：`manager/src/command.mjs`、Desktop allowlist
- 定向回归：四份 `tests/2026-08-26_CloudigLibrary1*`；均进入 fast / manager 套件

当前实现已经启用 Parser V1 新写。V1.0 不迁移旧开发数据；用户自行处理旧文件，采云只负责空根的安全初始化。它不改书签，也不把开发标识冒充公开冻结包。
