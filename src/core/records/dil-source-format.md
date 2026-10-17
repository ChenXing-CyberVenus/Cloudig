# Saved GPT UI projection · 1

This is the source-specific interpretation of existing Box/Window `data` and `files`, not a new business Schema or a standalone application.

| Location | Meaning |
|---|---|
| block.type | `box` for inline native compositions; `window` for a heavy canvas or editable program and its controlling UI |
| block.source / format | `chatgpt.com_dil` / `structured` |
| data.format | `cloudig/dil-view/1` |
| data.root | Zero-based root in the saved DIL render fragment; not a message number or fallback-text offset |
| data.text | Inert readable projection for search, Markdown and unavailable-runtime fallback; no callback source |
| data.assets (optional) | Ordered visible assets `{path, alt, kind}`; kind is `image` or `attachment`, path addresses this view's files |
| files / entry | Existing resource references. `entry` is `ui.json`; related views share that one resource and its assets, not duplicate embedded bytes |

`ui.json` has format `cloudig/dil-source/1`: source_message, code, constants, app_data, widgets, references, captured_state, resource_paths, source_links, snapshots, icons, styles, colors, media, original and captured. These are inert preserved source facts. `original` is that message's source content, not the whole platform conversation/API reply. Source links resolve only to declared files; metadata-only media does not become a playable local file.

Parser uses syntax/literal inspection only. Runtime evaluates a bounded declarative subset without eval, global objects, DOM, network or imports. Unsupported operations are not granted platform capabilities. Native AppBlock programs run only after Window opening, inside the existing isolated work runtime. Only explicitly declared binding values/callbacks cross its scoped frame/token channel; close releases listeners, iframe and animation resources.

The shared runtime key is Conversation identity plus this source resource's hash. `source_message` makes equal programs in different messages distinct. Same-source Box/Window views share state; unrelated messages and conversations do not. User actions remain session-only and do not modify Conversation, Mark or source HTML.

Captured controls override initializers only where the export supplies an owned, unambiguous value. Parser never executes source to guess saved state. Static diagrams use captured original graphics first. Dynamic diagrams follow saved expressions/data. Existing Mermaid, Python, ordinary prose and attachments keep their established types.

1.0.0/1.0.1 readers remain frozen. New containers are written as 1.0.2; reading old `interactive + display` projects the same Box/Window meaning without migration. The current total Parser version is recorded separately from source Adapter versions, so this format correction does not mark every unrelated platform for reparse.
