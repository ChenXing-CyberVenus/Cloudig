# Cloudig content-time core

This directory owns the V1 content-time contracts and the single pure algorithm implementation shared by Parser, Library, Manager, Reader and rebuildable indexes.

Current T1 files:

- `limits-1.0.0.json`: versioned limits and Terran relative-unit table.
- `core.js`: DOM-free and filesystem-free normalization, validation, formatting, comparison, range flags, period selectors and bounded Sovereign graph traversal.
- `system.js`: pure built-in preset initialization, per-node anchor preservation, override normalization and default restore semantics.
- `content-time-1.0.0.schema.json`: range and endpoint shape contract.
- `content-time-system-1.0.0.schema.json`: Terran override and Sovereign graph shape contract.
- `sovereign-time-snapshot-1.0.0.schema.json`: bounded conversation-local Sovereign snapshot.
- `terran-preset-1.0.0.schema.json`: immutable built-in Terran preset shape.
- `presets/terran-cloudig-1.0.0.json`: immutable built-in Terran timeline identities and default ranges.
- `../schema/conversation-1.0.0.schema.json` and `../library/cloudig-library-1.0.0.schema.json`: the two documents that own effective snapshots and user authority.
- `../schema/canonical-v1.mjs`: shared deterministic JSON serializer for those two V1 documents.

`limits-1.0.0.json` is the machine authority. Node loads it directly; the later offline Reader build must embed the same bytes before `core.js`, not maintain a second handwritten table.

This layer never reads or writes a Library, conversation, HTML, browser DOM or local path. File ownership, CAS, transactions, migration and UI belong to later implementation slices routed by [`../product/2026-08-26_采云V1.0内容时间系统实施计划-GPT-5.6-Sol.md`](../product/2026-08-26_采云V1.0内容时间系统实施计划-GPT-5.6-Sol.md).
