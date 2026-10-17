# Cloudig Library contracts

> 库存说明：下文的parse-state、旧覆盖层和兼容行为仅对应重构前root Library。当前V1的权威文件、用户覆盖与投影在[`src/core/contracts`](../src/core/contracts)和[`src/adapters/library-data`](../src/adapters/library-data)，从[产品路由](../product/README.md)查现行合同；名称相近或同为1.0.0不表示同一Schema。

`cloudig/library 1.0.0` 是当前生产写入合同；新资料库与 `parse-state 1.0.0` 一次创建。V1.0 不提供 0.1.x Library 数据迁移：只有当旧 `Inbox/` 与 `Conversations/` 递归检查均无文件时，Manager 才在同一事务内用干净的 1.0 元数据替换旧 Library / parse-state；任一文件仍存在就零写拒绝。Reader 的旧会话只读能力不构成旧 Library 写入路线。1.0.0 增加事务级 `edited_at`、长期工作流偏好、用户内容时间 set/cleared 权威态和完整内容时间系统。

V1 机器入口是 `cloudig-library-1.0.0.schema.json`、`examples/cloudig-library-1.0.0.example.json` 和 `v1.mjs`。`v1.mjs` 只负责规范化与确定性序列化；`domain-v1.mjs` 负责图、binding、preview/plan/commit 的纯领域语义；`compat.mjs` 提供旧/V1 双读边界；文件事务由 Manager 服务承担。短接口见 [`CONTENT_TIME_COMMANDS.md`](CONTENT_TIME_COMMANDS.md)。

`cloudig-library.json` is the mutable user overlay for Cloudig. Parser conversation
JSON remains a deterministic fact layer; user-set conversation names, content time,
provider/platform/model labels, user/assistant names and visual choices live here so
reparsing the same input cannot erase user edits.

## Default layout

```text
Cloudig/
├─ Inbox/
├─ Conversations/
├─ Exports/
├─ cloudig-library.json
└─ Data/
   ├─ parse-state.json
   ├─ parse-batch-settings.json # 旧开发残留；V1 忽略且不再写
   ├─ Assets/
   │  ├─ Covers/
   │  ├─ Avatars/
   │  └─ PlatformIcons/
   ├─ Indexes/
   ├─ Transactions/
   ├─ Reader/
   ├─ Backups/
   └─ Logs/
```

- `Inbox/` is one shallow user-facing drop area for downloaded HTML and future
  registered JSON formats. It has no format subfolders.
- `Conversations/` contains current `conversation/1.0.0` outputs.
  Reader preserves read-only support for all registered 0.x contracts; Parser does not rewrite new facts back into them.
  One input may produce zero, one, or many conversations.
- `Exports/` is the shallow destination for user-requested Markdown and other exports.
- `Data/parse-state.json` 1.0.0 is an automatic incremental watermark, not user
  metadata. Each output records archive identity, current/historical role, lifecycle,
  schema, Parser/adapter and optional Exporter watermarks; it never substitutes for facts in the JSON itself.
- V1 one-click and Claude settings live only in `cloudig-library.json.workflow_preferences`.
  `Data/parse-batch-settings.json` is ignored by V1, so two authorities cannot diverge.
- `Data/Indexes/` stores rebuildable indexes. `conversation-catalog.json` 1.0.0 is the
  shared metadata projection for ordinary `Conversations/` scans; it contains paths,
  file facts, stable archive identities, lifecycle/source evidence, title/platform/model/time/message counts and generation watermarks, but
  never message bodies, image bytes, attachment contents or user overlays. Sovereign content time keeps only its binding IDs, bounded labels, direct sort descriptor and snapshot digests; the snapshot payload is not duplicated. `content-time-reference-index.json` 1.0.0 按 `by_conversation / by_node / by_timeline` 投影 Library 权威 binding，并记录来源 Library SHA 与 time-system revision；它拥有零用户关系，缺失时可重建。 An absent,
  corrupt or unknown-version catalog is rebuilt from the conversation JSON files.
  Unchanged path + size + high-precision modification-time entries are reused without
  reading the JSON body; only new or changed files are parsed. Claude container byte
  ranges remain separate indexes. None of these files replaces the user-facing
  `Inbox/` or `Conversations/` folders.
- `Data/Reader/Cloudig-Reader.html` is the rebuildable desktop runtime shell. It embeds
  only the current Library, referenced user assets and fixed Reader runtime; its catalog
  comes from the shared metadata index and a selected conversation body is read through
  the path-confined desktop bridge. Deleting this shell loses no archive or user edit.
- `Data/Backups/` receives recovery snapshots; Parser failures retain the
  previous complete output set, while explicit “保留旧版解析结果” keeps the old exact artifact in `Conversations/` as `historical`. `Data/Backups/UserState/cloudig-library/` separately
  protects non-rebuildable user edits: a real Library change first snapshots the exact
  replaced bytes, unchanged saves create nothing, and valid generated history is bounded
  to 12 versions / 128 MiB. Recovery requires the current Library SHA-256, protects the
  state being replaced (including damaged raw bytes), validates the selected snapshot and
  writes the normalized Library atomically. Parser results, catalogs and Reader shells do
  not enter this user-state history.
- `Data/Transactions/recent-operations.json` 只保留最近 128 条成功写命令的 request/payload/plan 水位，用于超时幂等；它不进入会话事实。Library + Conversation 写入仍由同目录的 durable snapshot transaction 保证整笔提交或整笔回滚。
- binary assets stay outside JSON. The Library stores only safe `/`-separated paths
  below `Data/Assets/`; absolute paths, URLs and `..` traversal are rejected.
- the native cover/avatar picker currently accepts signature-verified PNG, JPEG, GIF and
  WebP images up to 12 MiB, copies them under `Data/Assets/`, and writes only the relative
  path into the overlay. Manager previews and generated Reader files use embedded `data:`
  bytes, so they remain offline and never follow a remote asset URL.
- one root is one Library. V1.0 has no `profiles/default`, `user/`, or multi-user folder
  layer.

## New file contract

```json
{
  "format": "cloudig/library",
  "version": "1.0.0",
  "conversation_schema": "ai-chat-archive/conversation/1.0.0",
  "content_time_schema": "cloudig/content-time/1.0.0",
  "edited_at": "2026-08-26T00:00:00.000Z"
}
```

This is only the identity header. A valid new file also contains the initialized
`workflow_preferences` and complete bounded `content_time_system`; use
`examples/cloudig-library-1.0.0.example.json` or `createLibraryV1()` rather than hand-writing it.

`user` and `assistant` are sparse customizations. When `display_name` is absent,
Cloudig resolves the localized defaults `采云用户 / 智能伙伴` or
`User / AI` from `preferences.language`. Explicit current-version
names are preserved even when they happen to equal one of those defaults.

During migration from 0.1.0–0.1.2, only a complete known generated pair
(`用户 / AI`, `采云用户 / 智能伙伴`, `Cloudig User / AI Partner`, or `User / AI`) becomes
the new language-aware default. A mixed pair or any other name is retained, so
one real customization is never erased merely because the other field still has
an old default.

Conversation overrides use the Parser fact's required lowercase `conversation_key`.
The 64-character key hides vendor-private IDs and stays separate from editable metadata.
During migration, an old `conversation_id` value is preserved byte-for-byte as
`conversation_key`; an ordinary old override already keyed by `source_sha256` keeps that
same key. Optional values are omitted rather than written as `null` or empty arrays.
`conversation_overrides.<key>.conversation_name` is the user-set name and has priority
over the Parser fact `title`. Legacy override `title` is read and migrated; new writes
use only `conversation_name`.
`conversation_overrides.<key>.content_time` is the user authority and has priority over
the Parser default. `state: "cleared"` is distinct from absence; `state: "set"` stores one
shared `edit_id`, edit time and normalized range:

```json
{
  "content_time": {
    "edit_id": "7c745ea4-1606-40f8-a358-f3f3417e0889",
    "edited_at": "2026-08-26T00:00:00.000Z",
    "state": "set",
    "range": {
      "start": { "kind": "terran_exact", "era": "AD", "year": 2026, "month": 8, "day": 19, "hour": 9, "minute": 30, "utc_offset": "+08:00" },
      "end": { "kind": "terran_year_month", "era": "AD", "year": 2026, "month": 11 },
      "is_collapsed": false,
      "is_reversed": false
    }
  }
}
```

Terran, Sovereign, special and relative endpoints all use the shared content-time core;
the Library stores Sovereign `binding_id`, while each conversation stores the same edit
plus a bounded snapshot. Legacy tagged and ISO values are converted only by the explicit migration.

## Identity overlay

Global identity uses:

```json
{
  "user": {
    "display_name": "老婆",
    "avatar": "Data/Assets/Avatars/user.png"
  },
  "assistant": {
    "display_name": "夫夫君",
    "avatar": "Data/Assets/Avatars/assistant.png",
    "apply_to_all": true
  }
}
```

`assistant.apply_to_all` is omitted when false. Platform identity extends the
existing `platform_overrides` object without changing the meaning of `icon`:

```json
{
  "platform_overrides": {
    "chatgpt": {
      "icon": "Data/Assets/PlatformIcons/chatgpt.png",
      "assistant_name": "ChatGPT",
      "assistant_avatar": "Data/Assets/Avatars/chatgpt.png"
    }
  }
}
```

The current UI keys these entries by stable platform family, not by a changeable
model version. A future true per-model feature can add a separate versioned layer.

Conversation identity is names only:

```json
{
  "conversation_overrides": {
    "0000000000000000000000000000000000000000000000000000000000000000": {
      "user_name": "老婆",
      "assistant_name": "夫夫君"
    }
  }
}
```

Conversation avatar fields are deliberately invalid. All image values in the
Library remain safe `Data/Assets/` relative paths; URLs, absolute paths, backslashes
and `..` traversal are rejected.

`resolveConversationIdentity()` is the single pure priority resolver:

1. user name: conversation → global custom → localized built-in;
2. user avatar: global custom → caller-supplied generic built-in;
3. assistant name with `apply_to_all`: conversation → global custom → localized
   generic built-in;
4. assistant avatar with `apply_to_all`: global custom → generic built-in;
5. assistant name otherwise: conversation → platform custom → global custom →
   source-platform built-in → localized generic built-in;
6. assistant avatar otherwise: platform custom → global custom → source-platform
   built-in → generic built-in.

The helper accepts caller-provided built-in platform avatar values because those
assets are bundled by Manager/Reader rather than stored in this JSON. It returns
resolved runtime values but never writes them into Parser facts.

Restoring defaults is sparse:

- `resetGlobalIdentityNames()` deletes global name fields;
- `resetPlatformIdentityNames()` deletes one or all platform assistant names while
  preserving icons and avatars;
- `resetConversationIdentityNames()` deletes only the two conversation name fields;
- `updateLibrarySettings(... avatar: "")` and
  `setPlatformOverride(... assistant_avatar: "")` remove only the reference.

Removing a reference never deletes an asset file, because another setting may use
the same content-addressed image.

`preferences.name_rule_ack_version` is an optional non-negative integer. Reader writes
the current rule version only after the user checks `已阅，不再提示` and closes the
name-rule notice. One integer replaces an expanding family of versioned booleans.

## Initialize

```powershell
node .\library\src\cli.mjs init
node .\library\src\cli.mjs init "D:\Cloudig"
```

The first command uses the current user's `Cloudig` directory. Initialization creates
the fixed flat folders, but never overwrites an existing Library.

Files:

- `cloudig-library-0.1.0.schema.json`: legacy Draft 2020-12 contract.
- `cloudig-library-0.1.1.schema.json`: legacy contract with `content_time` override.
- `cloudig-library-0.1.2.schema.json`: previous contract with `conversation_name` and
  `name_rule_ack_version`.
- `cloudig-library-0.1.3.schema.json`: previous sparse identity contract.
- `cloudig-library-0.1.4.schema.json`: current contract adding structured user-edited
  content time while retaining the sparse identity model.
- `core.js`: strict validator, deterministic serializer and overlay helpers usable by
  Node.js and the single-file Reader.
- `v1.mjs` / `domain-v1.mjs` / `compat.mjs`: V1 规范字节、领域命令及旧/V1 双读边界。
- `src/init.mjs`: non-destructive directory initializer.

Implementation: GPT-5.6-Sol·奥思·万卷同辉 Osis.MyriadScrollsShineTogether, 2026-07-24.
