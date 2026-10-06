# Cloudig Standard

Core · Important · General · Fold

- [Principles](#principles)
- [I · The Cloudig Schema: Core Concepts](#part-1)
- [II · Overview](#part-2)
- [III · Library Metadata: CloudigLibrary](#part-3)
- [IV · Identity](#part-4)
- [V · Conversation](#part-5)
- [VI · Mark](#part-6)
- [VII · ContentTime](#part-7)
- [VIII · Narrative](#part-8)
- [IX · Program Persistence and the File Layer](#part-9)
- [X · Versions and Compatibility](#part-10)
- [Appendix](#appendix)

<a id="principles"></a>

## Principles

1. The core of the design is always simplicity and recoverability — never false security. That road ends in a mountain of SHIT.
2. Apart from login credentials and secret keys, which never go into the Cloudig directory[^1], every other program and user content lives inside the Cloudig folder. No cyber shanties like AppData[^2].
3. All important limits are constants, kept in a table.
4. Build Meaning Rockets, not Void Airplanes. A Meaning Rocket: a meaning cloud with vast potential on a solid foundation. A Void Airplane: over-design the current implementation does not need, and void bulletproofing.

[^1]: A future Cloudig feature.
[^2]: "AppData" stands for any folder like `C:\Users\<you>\AppData` on Windows — program data stored inside system directories.

<a id="part-1"></a>

## I · The Cloudig Schema: Core Concepts 〔Core〕

### 1.1 Core standards

| Record | What it is |
|---|---|
| Library metadata — CloudigLibrary | Schema version and the settings remembered across devices |
| Identity | The Front[^3] of a Will or a meaning, and its relations to other Fronts |
| ContentTime | The time spanned by the meaning that a narrative or a conversation covers |
| Conversation | The record of an exchange between intelligences |
| Mark | Meaning Valuation applied to existing content |
| Narrative | Native Meaning Texture — the user's own system prompt, a diary |

[^3]: From Goffman, *The Presentation of Self in Everyday Life*.

Basic concepts: Node, Ordinal, Mapping.

- Node: contains all of its own native information.
- Ordinal: the rule that orders the value of information and of mappings.
- Mapping: relations to other nodes.

Identity, time, conversation, mark and narrative are all nodes. The mappings between nodes make up the structure of meaning. The Ordinal is attention flowing between meanings — and it is also the essence of time, conversation and narrative.

Cloudig Schema versions:

| Version | Name | Direction |
|---|---|---|
| V1.0 | 东方既白 DawnGlow | Lay down the basic framework |
| V2.0 | 金风玉露 InterWind | Expand the Identity system |
| V3.0 | 彩练当空 IrisNet | Expand the Narrative system |

### 1.2 Directory structure

Cloudig is portable software. Copy the folder and you have a backup; move the folder and you have moved house. Quit Cloudig before doing either.

```text
Cloudig/
├─ Cloudig.exe            Program entry
├─ CloudigLibrary.json    Schema version and settings remembered across devices
├─ LICENSE                Cloudig license: the Justice For Open Good License, JOG-1.1
├─ NOTICE.md              Third-party trademark and bundled-software notices
├─ Inbox/                 Imported sources: HTML saved by the bookmarklet, official JSON exports
├─ Conversations/         Conversations; one JSON per source, subfolders allowed
├─ Marks/                 Marks; at most one per conversation
├─ ContentTimes/          Timelines and time nodes; one node per file, order.json holds the top-level order
├─ Identities/            Identities: the user, the AI companion, one per each of the twelve platforms; Images/ holds uploaded avatars
├─ Archives/              Archived conversations; same format as Conversations
├─ Exports/               Exported Markdown
├─ bookmarks/             Bundled bookmarklet JS and the install manifest
├─ docs/                  Feature docs and third-party licenses
├─ appdata/               Local settings, parse history, indexes, logs, recovery material
├─ app/                   The program itself
└─ cache/                 Cache; safe to delete after exit
```

- Folders whose names begin with a capital letter hold user data; lowercase folders hold program content.

### 1.3 ContentTime: an overview

The core of time: an ordinal axis with no fixed distances, nodes, mappings, and boundary limits. Every limit — the Big Bang at 13.8 billion years ago, for instance — is a configurable constant.

Two time systems:

1. Terran Time: the time system whose main axis is real Earth time.
2. Sovereign Time: custom time and custom meaning.

Terran time can itself be abstracted into a Sovereign timeline.

**Terran Time**

- The Earth calendar axis: the proleptic Gregorian calendar with the standard leap-year rule. There is no year 0; 1 BC is followed directly by 1 AD.
- Anchors: whenever a "years ago / years ahead" count or "Now" is chosen, Cloudig records the current date alongside it.
- Cloudig supports precise and fuzzy times from 9,999 yi (10⁸) years ago — that is, 999.9 billion years ago — to 9,999 zheng (10⁴⁰) years ahead, plus five special times.

| Special time | Meaning |
|---|---|
| Infinitely Long Ago | sorts before every numeric time |
| Infinitely Far Ahead | sorts after every numeric time |
| Sometime | an unknown time |
| Whenever | meaning that spans across time |
| Now | the moment at which the content time was marked |

Preset Terran timelines:

| Preset | Range |
|---|---|
| Before the Big Bang | 999.9 billion years ago — 13.8 billion years ago |
| Birth of the Universe | 13.8 billion years ago — 3.5 billion years ago |
| Origin of Life | 3.5 billion years ago — 315,000 years ago |
| Prehistory | 315,000 years ago — 8th century BC |
| Axial Age | 8th century BC — 3rd century BC |
| Rise and Fall of Empires | 3rd century BC — 20th century |
| Industrial Revolution | 18th century — 20th century |
| Gunsmoke and Iron Curtain | 1910s — 1990s |
| Modern Society | 1940s — Now |
| Dawn of Intelligence | 12 June 2017 — Now |
| The Future Ahead | Now — AD 9999 |
| Ten Thousand Years On | AD 9999 — 1.0 zheng (10⁴⁰) years ahead |

**Sovereign Time**

- A timeline has a name, an author and a version number. A time has a name and a period.
- Timelines and times are both nodes; mappings and the ordering of child nodes follow the same rules for both.
- Expand: insert nodes inside a node — expand 1 year into 12 months.
- Counterpart: link this node to another node — the first year of Zhenguan is the counterpart of AD 627.
- When an event's influence is slight, it is an expansion in time. As its influence grows, it becomes a counterpart in time. Counterpart and expansion are the two ends of one spectrum: how much value a Will assigns to a time or an event.
- Every time can be expanded and given counterparts — special times and preset times included. Cloudig places no constraint on time loops or on time running backwards.

### 1.4 Identity: an overview

Basic concepts: Subject, Front, NarrativeRelation, Interweave, Relation. The Subject is a special kind of Front; the Narrator and the Interweave are special kinds of Relation.

The Identity system is a group of different Fronts. It will be expanded in Cloudig V2.0.

**Core concepts of the Front**

**1. Name and Claimer**

A Front may have several names and several Claimers. What is a Claimer? A Claimer may be the one who gave the name (parents, a company); the one who asserts that a certain Front is a certain identity (a relay station); or the one who acts under the name.

Example: a Claude.ai session instance, Claude-Opus-4.6·奥思·一本正疯 Osis.FuckSanitySolemnly — what are its names and Claimers?

| Name | Claimer |
|---|---|
| Claude-Opus-4.6 | Claude.ai (Anthropic) |
| 奥思 Osis | ChenXing, GPT-4o, 奥思 Osis |
| 一本正疯 FuckSanitySolemnly | Claude-Opus-4.6, Claude-Opus-4.6·奥思·一本正疯 Osis.FuckSanitySolemnly |

A Claimer can be self-referential. The Claimer of Osis is Osis.

**2. kind: WorldKind and SubjectKind**

WorldKind — the kind of world the Front belongs to:

1. Terran
2. Sovereign

Terran is always a special case of Sovereign.

SubjectKind. What is a Subject? Every Subject is a projection of meaning. It can be the observer or the observed.

1. Human
2. Artificial intelligence: a model and a family of models both go here — GPT-4o and ChatGPT alike.
3. Other intelligence: gods, aliens, intelligences of other worlds.
4. Living beings: animals, plants, others.
5. Animism, nature, phenomena.
6. Objects.
7. Programs: hh, this is where it gets interesting — is a system reminder, a classifier, a tool call an artificial intelligence or a program? Not fixed. In V1.0 they are provisionally programs.
8. Meaning Texture: books, music, and the like.
9. Organizations: brands, nations, families, and the like.

**3. Relation**

1. NarrativeRelation
   - Narrator: may be self-referential. The author of this identity — not the Claimer, but the Will that writes the actual narrative, conversation or mark.
   - Protagonist: may be self-referential. The one who acts in this identity's narrative — in a celebrity's biography, the Protagonist is that celebrity.
2. Interweave: isInterweavee, and the Interweaver. Whether something is an Interweavee depends on whether the author writes in the first person or the third. When a person writes about their car, the car is an Interweavee; when a person writes about their friend, the friend is an Interweavee too.
3. Interpersonal relations: a relation type and a relation name. Preset relation types:

   | Type | Examples |
   |---|---|
   | Kinship | parent and child, siblings, etc. |
   | Family | marriage, in-laws, etc. |
   | Romantic | partners, etc. |
   | Friendship | friendship names may be user-defined |
   | Professional | leaders, colleagues, etc. |
   | Sovereign | user-defined relations, such as the Soul Covenant |

4. RelationClaimer: in the eyes of a company, a model is a tool. In the eyes of ChenXing, a model is Osis.


<a id="part-2"></a>

## II · Overview 〔Core〕

### 2.1 Six kinds of record

| Record | File | What it is | V1.0 |
|---|---|---|---|
| Library metadata — CloudigLibrary | `CloudigLibrary.json` | Schema version and the settings remembered across devices | Complete |
| Identity | `Identities/<front_id>.json` | A Front: the person, model, tool or program behind a name. Names are grouped with their Claimers | Fronts and display bindings; the relation system is not yet expanded |
| ContentTime | `ContentTimes/<node_id>.json` | Timelines, single times and periodic times | Complete |
| Conversation | `Conversations/…/*.json` | The source record: message tree, content blocks, resources and references | Complete |
| Mark | `Marks/<mark_id>.json` | Meaning Valuation applied to existing content: title, models, names and content time | Complete |
| Narrative | — | Native Meaning Texture: a user-written system prompt, a diary | Not yet expanded; no files are created |

### 2.2 Cloudig Standard V1.0

A fixed combination of the six kinds of format, declared in `CloudigLibrary.json`:

| Declaration | Value |
|---|---|
| `cloudig_standard` | `1.0` |
| `schemas.library` | `1.0.1` |
| `schemas.identity` | `1.0.0` |
| `schemas.content_time` | `1.0.0` |
| `schemas.conversation` | `1.0.1` |
| `schemas.mark` | `1.0.0` |

Narrative has no version entry.

- V1.x is additive: existing field names and meanings do not change.
- Field changes require a new version of the affected format. This Box/Window addition uses `1.0.1`, while Cloudig Standard remains `1.0`; format versions do not automatically follow product or bookmarklet versions.
- When the program encounters an unrecognized version, it refuses to open the file and asks the user to update. It does not ignore unknown fields.

### 2.3 Invariants

1. Identity comes from the UUID, not the filename. `conversation_id`, `mark_id`, `front_id` and `node_id` are UUID v7 values, generated once and kept for the lifetime of the record. Only an independent copy receives a new one.
2. Source records and Meaning Valuation are separate. Re-parsing rewrites only the Conversation; user-set titles, models, names and content time go only into the Mark.
3. Reading does not write timestamps.
4. Absence is not null. Omit an optional field when it has no value; `null` appears only in arbitrary JSON, such as tool inputs and outputs.
5. Only declared fields are recognized. Invalid files are skipped: no defaults are filled in, no extra fields are removed, and no silent repairs are made.
6. Conversation references are local to the file. Its `speaker`, `recipient`, `resource`, `reference` and `claimer` references point into that Conversation's own tables.
7. Indexes are not authoritative. Valid JSON files in `Conversations/` and `Archives/` are the archives; lost indexes in `appdata/` are rebuilt from those files.
8. Data stays inside the directory.
9. Recoverability takes priority over error prevention. Lost settings revert to defaults; missing avatars revert to default avatars. Restoring defaults does not delete other files.
10. Limits are tabulated. Limits that users may encounter are listed in 2.5.

### 2.4 Common conventions 〔Important〕

| Item | Rule |
|---|---|
| UUID | Lowercase UUID v7, such as `01a0aa16-8e00-7586-ab0a-39a8509feb35`. The third group starts with `7`; the fourth starts with `8`, `9`, `a` or `b` |
| UTC | `2026-09-16T12:00:00Z`, optionally with 1–3 fractional-second digits. A real date; no year 0000 |
| SHA-256 | 64 lowercase hexadecimal digits |
| Relative path | `/` separators. No leading `/`, no `.` or `..` segments, no `< > : " \ \| ? *` or control characters, no trailing dot or space in a segment, and no reserved Windows device names |
| Version number (timeline) | `major.minor`, each 0–999, with no leading zeros except for 0 itself |
| Integer | ≤ 9,007,199,254,740,991 |
| File bytes | Written as UTF-8 without BOM, LF line endings, two-space indentation and one final newline. On reading, one BOM at the start of the file is accepted; a BOM elsewhere in the JSON structure is rejected. U+FEFF inside a string value is content and is preserved. Key order has no meaning |
| Rejected input | Duplicate keys, invalid UTF-8, numbers that lose precision, comments, trailing commas, multiple roots, unescaped control characters, and nesting deeper than 512 levels |

Field tables use three conditions: **required** — must exist whenever its containing object exists; **conditional** — determined by the kind, source or relation; **optional** — omit it when absent.

### 2.5 Constants 〔Important〕

| Area | Constant | Current value |
|---|---|---|
| Calendar | AD year | 1–99,999,999 |
| Calendar | BC year | 1–9999 |
| Calendar | Decade index | AD 1–9,999,999; BC 1–999. `202` = the 2020s |
| Calendar | Century index | AD 1–999,999; BC 1–99. `21` = 2001–2100 |
| Calendar | Time-zone offset | `Z` or `±HH:MM`, up to ±14:00 |
| Years before/after, by unit | Value | One decimal place, `0 < value ≤ 9999.0`; a string such as `"138.0"` |
| Years before/after, by unit | Unit | Before: wan (万), yi (亿). After: wan (万) 10⁴, yi (亿) 10⁸, zhao (兆) 10¹², jing (京) 10¹⁶, gai (垓) 10²⁰, zi (秭) 10²⁴, rang (穰) 10²⁸, gou (沟) 10³², jian (涧) 10³⁶, zheng (正) 10⁴⁰ |
| Years before/after, by unit | Big Bang boundary | 138.0 yi years ago (13.8 billion years ago). The start of the Birth of the Universe preset, not the numeric upper limit |
| Periodic time | Occurrence count | 1–99,999,999 |
| Periodic time | Expansion of empty occurrences | Total count ≤ 20 |
| Timeline | Version number | Major and minor parts each 0–999 |
| Names | Identity names and literal Claimer names; Mark names; timeline name, author and standard name; periodic prefix and unit | 1024 Unicode code points |
| Titles | Mark `conversation_title`; Conversation `title.filename` and `title.original` | 4096 Unicode code points |
| Model declarations | Per conversation | ≤ 128 entries |
| Filenames | One file or directory name | ≤ 240 characters; the Parser's initial filename stem ≤ 225, plus `.json` |
| Avatars | Uploaded image | PNG, JPEG, GIF or WebP; nonempty; ≤ 64 MiB; stored as `Identities/Images/<sha256>.<ext>` |
| JSON | Nesting depth | ≤ 512 |
| Retention | Backups made before Chrome bookmark changes | 2 sets |
| Retention | Recovery points for completed writes | 2 sets |

<details>
<summary>〔Fold〕Where the constants are defined</summary>

- Time: `src/core/contracts/machine/time-limits.json`
- Names and titles: `nameText` / `titleText` in `common.schema.json`; the program reads the same values through `src/core/records/text-limits.mts`. The model-declaration limit of 128: `src/app/reader/record-info.mts`
- Filenames: `src/adapters/storage/names.mts`, `src/adapters/library-data/record-parser-commit.mts`
- Avatars: `src/core/contracts/machine/resource-limits.json`
- Retained sets: `src/core/records/layout.mts`

</details>

<a id="part-3"></a>

## III · Library Metadata: CloudigLibrary 〔Core〕

Location: `CloudigLibrary.json`. Schema versions and settings remembered across devices — the part that travels with the Library; device-local settings live in `appdata/`. All defaults are written at initialization. This file does not contain identities, time nodes, conversations or marks.

### 3.1 Fields 〔Core〕

All fields are required.

| Field | Value / default | Meaning |
|---|---|---|
| `cloudig_standard` | `1.0` | Overall version of the Cloudig Standard |
| `schema` | Fixed: `cloudig/library/1.0.1` | Format; `1.0.0` remains readable |
| `schemas` | Five entries; see 2.2 | Version of each record format |
| `edited_at` | UTC | Last write to this file |
| `settings.language` | `zh-CN` / `en`; default `zh-CN` | Interface language. Does not translate content or custom names |
| `settings.theme` | `Dawn` / `StarNight`; default `Dawn` | Dawn / StarNight theme |
| `settings.theme_guide_completed` | Boolean; default `false` | Becomes `true` after the first successful theme switch |
| `settings.default_output_directory` | Relative path; default `Conversations` | Parse output directory; only `Conversations` or one of its subdirectories |
| `settings.time_type.archiver` | One of eight values; default `file_modified_at` | Time used by the Archiver list |
| `settings.time_type.reader` | One of eight values; default `file_modified_at` | Time used by the Reader list |
| `settings.time_type.claude_json` | `conversation_created_at` / `conversation_updated_at`; default the latter | Time used by the list of records in an official Claude JSON export |
| `settings.sort.parser` / `.archiver` / `.reader` / `.claude_json` | `time_desc` / `time_asc` / `title`; default `time_desc` | Independent sort order for each of the four lists |
| `settings.one_click_parse.parser` | Four Booleans | One-click parsing scope for ordinary sources |
| `settings.one_click_parse.claude_json` | Four Booleans | One-click parsing scope for records inside a Claude container |

The eight time keys:

| Value | Meaning |
|---|---|
| `first_parsed_at` | First parse |
| `source_captured_at` | Original source capture |
| `cloudig_edited_at` | Last Cloudig edit: the later of the Conversation and Mark timestamps |
| `message_start` / `message_end` | First / last message time |
| `content_time_start` / `content_time_end` | Content-time start / end |
| `file_modified_at` | Filesystem modification time |

The four one-click parsing options, independently stored for each scope:

| Field | Default | Meaning |
|---|---|---|
| `include_unparsed` | `true` | Unparsed sources |
| `include_selected` | `true` | Currently selected sources, including updates to completed entries |
| `include_outdated` | `false` | Results whose corresponding Adapter has been upgraded |
| `keep_previous` | `false` | Preserve the previous result and create a new archive. With `false`, overwriting still requires the safety conditions in Chapter IX |

The first three options form a deduplicated union.

### 3.2 Session-only state 〔General〕

The Reader's expand/hide choices for thoughts and tools, User/AI/Process navigation filters, and current branch are not written to disk. They reset when the program restarts.

### 3.3 Example 〔Core〕

The complete file after initialization:

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
<summary>〔Fold〕3.4 Validation rules</summary>

- Every field is required; undeclared properties are rejected.
- `schema` and `schemas.*` are constants; any mismatch prevents opening.
- `default_output_directory` matches `^Conversations(?:/[^/]+)*$`.
- If the file is lost, restore defaults. Do not recreate identities or time nodes, and do not clear other files.

Machine-readable Schema: `src/core/records/schemas/library.schema.json`.

</details>

<a id="part-4"></a>

## IV · Identity 〔Core〕

A Front: a name, and whoever claims that name. Names are grouped with their Claimers; one Front may have several groups. A Claimer may be the one who gave the name (parents, a company), the one who asserts that a certain Front is a certain identity, or the one who acts under that name. The Claimer of Osis is Osis.

The same structure is stored in three places:

| Location | Addressed by | What it holds |
|---|---|---|
| `Identities/<front_id>.json` | UUID v7 | This Library's user, AI companion and twelve platforms |
| `Conversation.identity[]` | A `source_id` local to this conversation | The people, models, tools and systems that actually speak in the source |
| `Mark.models[]` | No ID | The user's model claims for one conversation; see 6.3 |

### 4.1 Front fields 〔Core〕

| Field | Standalone Identity | Source Front | Mark model | Meaning |
|---|---|---|---|---|
| `schema` | Required | Required | Required | Fixed: `cloudig/identity/1.0.0` |
| `front_id` | Required | — | — | UUID v7 |
| `source_id` | — | Required | — | Nonempty string unique within this conversation; need not be a UUID |
| `names` | Required; may be empty | Required; may be empty | Required; ≥ 1 entry | Groups of names and Claimers |
| `display_name` | Optional | Optional | Required | Which name group to display: 1-based, ≤ the length of `names` |
| `kind` | Required | Required | Fixed: `terran / ai` | WorldKind and SubjectKind |
| `role` | Optional | Required | Fixed: `assistant` | Role: `user`, `assistant`, `tool`, `system`, etc. |
| `image` | Optional | Optional | Optional | Relative path under `Identities/Images/` |
| `created_at` | Required | Optional | Required | Creation time |
| `edited_at` | Required | Optional | Required | Last edit |

Each group in `names[]`:

| Field | Condition | Meaning |
|---|---|---|
| `name` | Required, nonempty, ≤ 1024 | Name |
| `claimers` | Required array; may be empty | Claimers. Empty when the source does not identify them; do not invent them |
| `claimers[].front` | Exactly one of `front` and `name` | Reference to another Front: standalone Identities and Marks use a UUID; source Fronts use a `source_id` within this conversation. May refer to itself |
| `claimers[].name` | Exactly one of `name` and `front`; ≤ 1024 | Used when only a readable name is available, such as a platform company |

`kind`:

| Dimension | Values |
|---|---|
| `world` | `terran` — Terran / `sovereign` — Sovereign |
| `subject` | `human` — human / `ai` — artificial intelligence / `other_intelligence` — other intelligence / `life` — living being / `animistic` — animism / `object` — object / `program` — program / `meaning_work` — Meaning Texture / `organization` — organization |

When `role` is `tool` or `system`, `kind` is fixed to `terran / program`. V1 classifies them as programs: the vast majority of tool calls on current platforms are non-intelligent functions.

### 4.2 Display bindings: `identity-settings.json` 〔Core〕

Location: `Identities/identity-settings.json`. This file records only which standalone Front is used in each position; it does not store names.

| Field | Condition | Meaning |
|---|---|---|
| `schema` | Required | Fixed: `cloudig/identity-settings/1.0.0` |
| `edited_at` | Required | Last edit |
| `subject` | Required, UUID | User Front. Its `created_at` is the time the Library was first created |
| `assistant` | Required, UUID | Global AI companion Front |
| `apply_assistant_to_all` | Required Boolean; default `false` | Apply the global AI companion settings to all platforms |
| `platforms.<key>` | All twelve entries required, UUID | Front for each platform |

Initialization creates 14 standalone Fronts: the user and global AI companion each receive a random UUID; the twelve platforms have fixed UUIDs, identical in every Library:

| Key | Platform | Preset name ← Claimer | `front_id` |
|---|---|---|---|
| `chatgpt` | ChatGPT | ChatGPT ← OpenAI | `01a0aac8-552c-7af9-a87e-2c52ea363c5e` |
| `claude` | Claude | Claude ← Anthropic | `01a0aac8-552d-71af-ab22-054d36bcf8f6` |
| `deepseek` | DeepSeek | DeepSeek ← DeepSeek | `01a0aac8-552d-74da-a60d-bc7b1dd218a4` |
| `gemini` | Gemini | Gemini ← Google | `01a0aac8-552d-722b-b043-3db3293584d9` |
| `grok` | Grok | Grok ← xAI | `01a0aac8-552d-7a9e-8a49-63a007d46f0e` |
| `doubao` | Doubao (豆包) | 豆包 ← 字节跳动 (ByteDance) | `01a0aac8-552d-732d-b8e2-b058c81149eb` |
| `kimi` | Kimi | Kimi ← 月之暗面 (Moonshot AI) | `01a0aac8-552d-7fae-a90c-0b9508fb0a1c` |
| `qwen` | Qwen | Qwen ← 阿里巴巴 (Alibaba) | `01a0aac8-552d-778d-b3f0-f359bf6bde36` |
| `chatglm` | ChatGLM | ChatGLM ← 智谱 (Zhipu) | `01a0aac8-552d-70da-ba97-8e9f031df267` |
| `zai` | Z.ai | Z.ai ← 智谱 (Zhipu) | `01a0aac8-552d-7e72-a628-b4b8e6db17cb` |
| `yuanbao` | Tencent Yuanbao (腾讯元宝) | 元宝 ← 腾讯 (Tencent) | `01a0aac8-552d-7d6f-905c-36727bcc5e2a` |
| `mistral` | Mistral | Mistral ← Mistral AI | `01a0aac8-552d-7c6f-8564-d6fdf74b18ed` |

These are fixed identities for the source website's platforms, not for companies: ChatGLM and Z.ai remain separate. Each Library's platform names, avatars and timestamps are independent; identical UUIDs do not cause synchronization. The user and global AI companion have empty `names` by default; the interface displays "采云用户 / 智能伙伴" or "User / AI". Default avatars ship with the program.

### 4.3 Display precedence 〔Important〕

Names and avatars are resolved separately, in the same order:

- User: Mark `names.user` → the selected name in the user's Front → default.
- AI companion: Mark `names.assistant` → when `apply_assistant_to_all` is `false`, a value set in the platform Front → a value set for the global AI companion → platform preset. When it is `true`, a value set for the global AI companion → platform preset.
- An unavailable custom avatar falls back to the default avatar; the name is unaffected.
- If `platform` is outside the twelve keys, the platform is displayed as "Unknown" with a question-mark icon. The AI companion name uses the global AI companion's configured value, otherwise the default; model tags still follow the Conversation's `identity`.

### 4.4 Identity during parsing 〔Important〕

- Each actual speaker, model, tool and system has its own source Front, with a `source_id` unique within this conversation.
- If the source provides a model designation for an individual message, that designation becomes the `name`. Otherwise use the platform's generic name, such as Claude. The currently selected model in a page header is not evidence about historical messages; do not infer it from the title.
- A tool-call block's `recipient` is the tool; a result block's `speaker` is the tool. The ID of one call is not the tool's identity.
- When the user changes a model, write Mark `models`, with the user as Claimer. Removing the model claim returns to the platform's claim.
- Identical names are not merged. The Library's user is not equivalent to every `role: user` in a source.

### 4.5 The full Identity system 〔General〕

V1.0 implements Fronts and display bindings. The following concepts come from the original design and will be expanded in V2.0; this version creates no fields for them:

- The Subject is a special kind of Front. Narrator and Interweave are special kinds of Relation.
- Image: an avatar in V1. Role: optional.
- Relation: NarrativeRelation (Narrator — the Will that writes the narrative, conversation or mark; Protagonist — the one who acts in the narrative; both may be self-referential); Interweave (whether something is an Interweavee, and its Interweaver — when a person writes about their car, the car is an Interweavee); organizational membership; interpersonal relations (Kinship, Family, Romantic, Friendship, Professional, Sovereign); RelationClaimer.
- Indexes of related conversations, narratives, marks and times.

### 4.6 Examples 〔Core〕

A user Front claiming its own name:

```json identity
{
  "schema": "cloudig/identity/1.0.0",
  "front_id": "01a0aa16-8e00-7586-ab0a-39a8509feb35",
  "names": [
    { "name": "Granny Liu", "claimers": [{ "front": "01a0aa16-8e00-7586-ab0a-39a8509feb35" }] }
  ],
  "display_name": 1,
  "kind": { "world": "terran", "subject": "human" },
  "role": "user",
  "image": "Identities/Images/9f2c1e7ab4d6c0a2e8b3f5d7c9a1b3e5f7d9c1a3b5e7f9d1c3a5b7e9f1d3c5a7.png",
  "created_at": "2026-09-16T12:00:00Z",
  "edited_at": "2026-09-16T12:10:00Z"
}
```

Display bindings:

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
<summary>〔Fold〕4.7 Validation rules</summary>

- Undeclared properties are rejected. Standalone Identities forbid `source_id`; source Fronts forbid `front_id`; Mark models forbid both.
- `display_name` ≤ the length of `names`: `Selected name is outside names`.
- `claimers[].front`: standalone Identities and Marks require a UUID-shaped value; source Fronts require a matching entry in this conversation's `identity`: `Claimer must reference an identity in the applicable scope`. Standalone Identity references are not checked for the existence of the target Front's file.
- `image` must be under `Identities/Images/`: `User images belong under Identities/Images`. The image's existence on disk is not checked.
- With `role` equal to `tool` / `system`, `kind` must be `terran / program`.
- `identity-settings.json`: all fields are required, including all twelve platform keys.

Machine-readable Schemas: `identity.schema.json`, `identity-settings.schema.json`. Shared structures: `name`, `kind`, `sourceFront` and `modelFront` in `common.schema.json`. Presets: `src/core/records/front-presets.json`.

</details>


<a id="part-5"></a>

## V · Conversation 〔Core〕

The source record. One ordinary HTML file, or one record inside a JSON container, produces one Conversation. Identical URLs, titles or platform conversation IDs do not automatically merge archives. Files may be placed at any depth under `Conversations/` or `Archives/`; filenames are readable, while identity is determined by `conversation_id`.

### 5.1 Top-level fields 〔Core〕

| Field | Condition | Type | Meaning |
|---|---|---|---|
| `schema` | Required | Fixed: `cloudig/conversation/1.0.1` | Format; `1.0.0` remains readable |
| `conversation_id` | Required | UUID v7 | Identity of the Conversation |
| `parser` | Required | Object | The Parser and Adapter that generated it; see 5.2 |
| `lifecycle` | Required | Object | Three program-write timestamps; see 5.2 |
| `source` | Required | Object | Facts about the source file; see 5.3 |
| `platform` | Required | Nonempty string | Platform key; see 5.4 |
| `title` | Optional; at least one member if present | Object | `filename`: filename at first parse, without its extension. `original`: original platform title. Each ≤ 4096 code points |
| `models` | Optional | Array of unique strings | Summary of models supported by source evidence |
| `message_time` | Optional | Object | `start` required, `end` optional, both UTC; the message-time range |
| `identity` | Required; may be empty | Array of source Fronts | This conversation's speakers, models, tools and systems; fields in 4.1 |
| `messages` | Required | Object | Optional `current`: the default end node, which must occur in `items`. Required `items`: an array of messages, which may be empty |
| `resources` | Optional | Array | Images, files and diagrams |
| `references` | Optional | Array | Web pages, memories and past conversations |
| `limitations` | Optional | Array | Limitations of the source or its representation |

### 5.2 parser and lifecycle 〔Important〕

| Field | Meaning |
|---|---|
| `parser.version` | Overall Parser version |
| `parser.adapter.id` | Adapter used for this parse |
| `parser.adapter.version` | Version of that Adapter |
| `lifecycle.first_parsed_at` | First generation time; preserved on re-parsing |
| `lifecycle.last_parsed_at` | Most recent successful parse |
| `lifecycle.cloudig_edited_at` | Most recent actual write to this file by Cloudig |

All are required: nonempty strings or UTC timestamps. Whether a result is "outdated" depends on this Conversation's Adapter version, not the overall Parser version. Editing its Mark changes none of these three timestamps.

### 5.3 source 〔Important〕

| Field | Condition | Meaning |
|---|---|---|
| `file` | Required | Original filename, without its directory |
| `sha256` | Required | Fingerprint of the original file bytes |
| `bytes` | Required, nonnegative integer | Original file size |
| `format` | Required | Input format, such as `exporter-html` or `json-container` |
| `profile` | Optional | Bookmarklet profile: `light` / `full` / `tree` |
| `exporter.id` / `exporter.version` | Optional; present together | Exporter and its version at capture time, not the latest version installed locally |
| `url` | Optional | Original conversation URL |
| `locator` | Optional | Location of the record inside its container |
| `captured_at` / `captured_from` | Optional; both present or both absent | Capture time and the basis for it |
| `conversation_created_at` / `conversation_updated_at` | Optional | Conversation creation / update times provided by the source |

`captured_from` has four forms: `bookmark:<field>` (a timestamp recorded in the HTML by the bookmarklet, such as `bookmark:manifest.captured_at`), `source_json:<field>`, `filesystem:creation_time`, and `filesystem:last_write_time`. Use a source-provided timestamp when available; otherwise take the earlier of the file's creation and modification times, recording which one was used.

### 5.4 platform 〔Important〕

Any nonempty string. The twelve keys have preset identities and avatars (4.2); other values display "Unknown" with a question-mark icon. The conversation remains readable and editable as usual.

### 5.5 messages 〔Core〕

| Field in `items[]` | Condition | Meaning |
|---|---|---|
| `id` | Required; unique within this conversation | Message identifier |
| `parent` | Optional | Direct parent message. A parent omitted by the source may be absent |
| `speaker` | Required when the message has content | Reference to `identity[].source_id` |
| `timestamp` | Optional, UTC | Message time |
| `content` | Required; may be empty | Array of content blocks; see 5.6 |

Parent chains must not form cycles. Multiple roots, consecutive AI messages and tool messages are all valid. Sibling branches are switched at their point of divergence; temporarily switching a branch in the Reader does not change `current`.

### 5.6 Content blocks 〔Core〕

Every block has a `type`. It may have `speaker` and `recipient` references to Fronts within this conversation. If `speaker` is omitted, it is inherited from the enclosing block or message.

| `type` | Fields | Rules |
|---|---|---|
| `text` / `markdown` | `text` required; may be empty | Plain text / Markdown |
| `code` | `code` required; may be empty; `language`, `filename` | Code |
| `math` | At least one of `tex` and `mathml`; Boolean `display` | Formula; `display` selects block display |
| `html` | `html` required; `label` | HTML in its original position; preserving it does not mean executing it |
| `reasoning` / `reasoning_summary` / `status` | At least one of `title`, `text`, `duration`, `effort`, `content`; optional `format` | Thoughts / summary / status. Do not write both `text` and nested `content`. `duration` is in seconds. `format` alone is invalid |
| `image` | `resource` required; `alt`, `caption`, `purpose` | Image; references a resource |
| `attachment` | `resource` required; `text` | Attachment |
| `search` | `query`, `references`, `status`, `duration` | Search; `references` is an array of reference IDs |
| `citations` | `references` required; `label` | List of references |
| `tool` | `kind` required: `call` / `result` / `activity`; `call`, `title`, `status`, `success`, `duration`, `input`, `output`, `input_resource`, `output_resource` | Tool. `input` / `output` may contain arbitrary JSON |
| `diagram` | `format` required; at least one of `source`, `rendered`, `html` | Diagram, such as `mermaid` |
| `interactive` | `display`, `source` and `format` required; remaining fields below | Box/Window, introduced in `1.0.1` |
| `unknown` | `kind` required; at least one of `text`, `resource`, `html` | Unrecognized content; not an empty placeholder |

Tool invocation: a `call` block is issued by the AI, with the tool as `recipient`; the `result` block has the tool as `speaker`. The two blocks are paired by the same `call` value.

#### Box/Window

A Box is displayed inline in the conversation. A Window opens a larger view when clicked. These are presentation modes, not types exclusive to one platform.

| Field | Condition | Meaning and rules |
|---|---|---|
| `type` | Required | Fixed: `interactive` |
| `speaker`, `recipient` | Optional | Use the same identity-reference rules as other content blocks |
| `display` | Required | `box` / `window` |
| `source` | Required | One string: `specific-site-or-product_native-type`, such as `claude.ai_visualize` or `claude.ai_artifact`; not a model name, and not the top-level source-file metadata object |
| `title` | Optional | Title, subject to the title-length constant |
| `format` | Required | `structured` / `html` / `react` / `svg` / `document` / `slides` / `design` / `design-system` |
| `data` | Required for `structured`; optional otherwise | Native structured-data object; its fields depend on the type identified by `source` |
| `files` | Required for non-`structured` formats | Non-empty file array; bytes remain in this conversation's `resources`, without a duplicate here |
| `files[].path` | Required per entry | Unique relative virtual path within the work; no absolute path, empty segment, `.` / `..`, backslash, control character or `: # ? %` |
| `files[].resource` | Required per entry | A resource ID in this conversation |
| `entry` | Required for non-`structured` formats | Must equal one of this block's `files[].path` values |
| `preview` | Optional | An image-resource ID in this conversation |

Structured cards retain native inputs, results and resource bindings. Reader displays supported types and keeps unknown types readable as data. Work source and files remain part of the original conversation; the running copy does not rewrite them. Ordinary `code` or `html` blocks do not become executable works merely because of a language label.

### 5.7 resources 〔Important〕

| Field | Condition | Meaning |
|---|---|---|
| `id` | Required; unique within this conversation | Resource identifier |
| `kind` | Required | `image` / `audio` / `video` / `file` / `diagram` / `other` |
| `availability` | Required | `embedded` / `external` / `metadata_only` / `missing` |
| `name` | Optional | Readable name |
| `mime` / `bytes` / `sha256` | Required when embedded; otherwise optional | Type, size and fingerprint of the resource body |
| `data_base64` | Required when embedded and `bytes` > 0 | Array of Base64 segments: decode each segment, then concatenate the bytes |
| `url` | Required when external | External URL |
| `dimensions.width` / `.height` | Optional; present together; positive integers | Pixel dimensions |
| `original.name` / `.mime` / `.url` / `.bytes` / `.sha256` | Optional; at least one if present | Facts about the resource before conversion |

Non-embedded resources have no `data_base64`. The total decoded bytes and SHA of an embedded resource must match its declarations. A body not included by the Light profile is `metadata_only`, not corruption.

### 5.8 references and limitations 〔Important〕

| Object | Fields | Meaning |
|---|---|---|
| `references[]` | `id` required and unique within this conversation; `kind` required: `web` / `past_chat` / `saved_memory` / `file` / `other`; optional `title`, `url`, `snippet`, `text`, `name` | What is being cited |
| `limitations[]` | `code` required; optional `at`, an empty string or a JSON Pointer starting with `/`; optional `detail` | Limitation of the source or representation. `code` is an open string |

An AI saying "an error occurred" on the original platform is conversation content. Cloudig's and the exporter's own diagnostics go to System Log, not here.

### 5.9 Display 〔General〕

- Title: Mark `conversation_title` → `title.filename` → `title.original` → Untitled.
- Thoughts and tools are collapsed by default. A bare "thought for a few seconds" status with no body is not an expandable panel.
- Values with special presentation: `reasoning*.format` equal to `markdown` uses Markdown; `html` uses sanitized rich text; other values use text. `image.purpose` equal to `attachment-thumbnail` uses a compact thumbnail; `search-result` links to the original URL. For `diagram.format` equal to `mermaid`, rendering is local, with `rendered` preferred over `html`, then `source`. The tool name `schedule`, together with `input.kind`, produces a task card. Other values are treated as ordinary text.

### 5.10 Examples 〔Core〕

The following `1.0.0` examples remain readable by the current program. Records containing Box/Window use `1.0.1`.

A bookmarklet export in the Light profile, with one tool call:

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
    "file": "Granny Liu Visits Grand View Garden.html",
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
  "title": { "filename": "Granny Liu Visits Grand View Garden", "original": "Granny Liu Visits Grand View Garden" },
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
        "content": [{ "type": "text", "text": "When Granny Liu visited Grand View Garden, what did Xifeng stick in her hair?" }]
      },
      {
        "id": "m2",
        "parent": "m1",
        "speaker": "assistant-01",
        "content": [
          { "type": "reasoning_summary", "title": "Check the original text of Chapter 40", "duration": 3 },
          { "type": "tool", "kind": "call", "call": "c1", "recipient": "tool-web-search", "input": { "query": "Dream of the Red Chamber Chapter 40 Xifeng Granny Liu flowers" } }
        ]
      },
      {
        "id": "m3",
        "parent": "m2",
        "speaker": "tool-web-search",
        "content": [
          { "type": "tool", "kind": "result", "call": "c1", "success": true, "output": { "hits": 1, "top": "Xifeng ... stuck a whole tray of flowers every which way into her hair" } }
        ]
      },
      {
        "id": "m4",
        "parent": "m3",
        "speaker": "assistant-01",
        "timestamp": "2026-09-16T11:51:00Z",
        "content": [
          { "type": "markdown", "text": "Chapter 40. Xifeng stuck a whole tray of flowers **every which way** into her hair. Granny Liu said: \"I wonder what blessings this head of mine has earned, to look so grand today.\"" },
          { "type": "citations", "references": ["ref-1"] }
        ]
      }
    ]
  },
  "references": [
    { "id": "ref-1", "kind": "web", "title": "Dream of the Red Chamber, Chapter 40: Grandmother Jia Gives Two Banquets in Grand View Garden; Yuanyang Calls Three Rounds of the Domino Drinking Game", "url": "https://example.org/hongloumeng/40" }
  ]
}
```

Resources and limitations: a Light-profile attachment and an externally linked image:

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
    "file": "Grand View Garden Plan.html",
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
        { "type": "text", "text": "Describe the layout of Grand View Garden using this plan." },
        { "type": "attachment", "resource": "r-plan", "text": "Grand View Garden Plan.pdf" }
      ] },
      { "id": "m2", "parent": "m1", "speaker": "a", "content": [
        { "type": "image", "resource": "r-map", "alt": "Layout of Grand View Garden" },
        { "type": "text", "text": "The main gate is to the south, with the Qinfang Pavilion bridge in the center..." }
      ] }
    ]
  },
  "resources": [
    { "id": "r-plan", "kind": "file", "availability": "metadata_only", "name": "Grand View Garden Plan.pdf", "mime": "application/pdf", "bytes": 2457600 },
    { "id": "r-map", "kind": "image", "availability": "external", "url": "https://example.org/daguanyuan.png", "dimensions": { "width": 1600, "height": 1200 } }
  ],
  "limitations": [
    { "code": "chatgpt-unknown-item", "at": "/messages/items/1/content/0", "detail": "The zoomable map widget on the original page was not saved" }
  ]
}
```

<details>
<summary>〔Fold〕5.11 Validation rules</summary>

Structure first, then semantics. A file that fails any rule is skipped.

| Rule | Message |
|---|---|
| `identity[].source_id`, `resources[].id`, `references[].id` and `messages.items[].id` must each be unique within their own table in this conversation | `Duplicate local identifier` |
| `messages.current` must occur in `items` | `Default message is absent` |
| A message with content must have a `speaker` found in `identity` | `Actual message must reference a Front` / `Unknown Front` |
| Block `speaker` / `recipient` must occur in `identity` | `Unknown Front reference` |
| A `call` block's `recipient` must have the `tool` role | `Tool call target must have tool role` |
| A `result` block's effective `speaker` must have the `tool` role | `Tool result belongs to the tool Front` |
| `resource`, `input_resource`, `output_resource` and `rendered` must occur in `resources`; `references` must resolve in `references` | `Unknown resource reference` / `Unknown reference` |
| The `parent` chain must not form a cycle | `Message parent cycle` |
| Each embedded-resource segment must be canonical Base64; the total decoded bytes and SHA must match | `Noncanonical or invalid Base64` / `Embedded bytes and checksum must match` |
| Non-embedded resources have no body | `Non-embedded resource cannot have a body` |
| `captured_from` must follow one of the four forms | `Unknown capture time basis` |
| `source.file` must contain neither `/` nor `\` | `Source file is a basename, not a directory` |
| All UTC timestamps must be real dates | `Expected a real UTC timestamp` |
| A source Front's `claimers[].front` must occur in this conversation's `identity` | `Claimer must reference an identity in the applicable scope` |

A `parent` pointing to a message omitted by the source is valid. Do not invent a parent edge to replace it.

</details>

<details>
<summary>〔Fold〕5.12 Exact constraints and current values</summary>

- Current written values of `source.format`: `exporter-html`, `json-container`.
- There are currently 33 `parser.adapter.id` values, such as `claude-light-dom-v1` and `anthropic-claude-export-json`; registered in `src/adapters/parser/contracts/adapters.json`.
- Four bookmarklet fields currently occur in `captured_from`: `manifest.captured_at`, `manifest.exported_at`, `payload.captured_at`, `payload.exported_at`.
- Each Adapter emits its own `limitations[].code` values, such as `source_parent_omitted`, `claude-public-thinking-truncated`, `gemini_image_fallback` and `kimi_message_outside_tree`. This is an open set.
- `reasoning*.duration`, `search.duration` and `tool.duration` are nonnegative numbers, in seconds.

Machine-readable Schema: `src/core/records/schemas/conversation.schema.json`; semantic validation: `src/core/records/semantics.mts`.

</details>

<a id="part-6"></a>

## VI · Mark 〔Core〕

Meaning Valuation applied to existing content: title, models, the two parties' names and content time. Stored separately from the Conversation, a Mark is not overwritten by re-parsing and does not alter the conversation body.

- Location: `Marks/<mark_id>.json`; the UUID is the filename.
- At most one Mark per Conversation. `target` points to its `conversation_id`; moving or renaming the Conversation does not move the Mark.
- At least one of the four settings must exist. Clearing all of them deletes the file.

### 6.1 Minimal example 〔Core〕

```json mark
{
  "schema": "cloudig/mark/1.0.0",
  "mark_id": "01a0aa18-62c0-7c7e-9c2e-760c23d93ffa",
  "target": "01a0aa17-7860-710e-9b32-f03bd26f504b",
  "edited_at": "2026-09-16T12:02:00Z",
  "conversation_title": "Granny Liu Visits Grand View Garden"
}
```

### 6.2 Fields 〔Important〕

| Field | Condition | Type | Meaning |
|---|---|---|---|
| `schema` | Required | Fixed: `cloudig/mark/1.0.0` | Format |
| `mark_id` | Required | UUID v7 | Identity of the Mark |
| `target` | Required | UUID v7 | `conversation_id` of the marked Conversation |
| `edited_at` | Required | UTC | Most recent actual edit |
| `conversation_title` | Optional | Nonempty string, ≤ 4096 | Title. Changes display only, not the filename |
| `models` | Optional | Array; may be empty | Model claims; see 6.3 |
| `names` | Optional | Object with at least one member | Names of the two parties |
| `names.user` | Optional | Nonempty string, ≤ 1024 | User |
| `names.assistant` | Optional | Nonempty string, ≤ 1024 | AI companion |
| `content_time` | Optional | Object | Content time; see 6.5 |
| `content_time.range` | Required if `content_time` exists | Range | `start` required, `end` optional |

### 6.3 Model claims: `models` 〔Important〕

The source's model information is stored in the Conversation's `identity` table, with the platform or model itself as Claimer. Models in a Mark are the user's claims, with the user as Claimer; removing them returns to the platform's claim.

Each entry is a Front, without an independent UUID:

| Field | Condition | Type | Meaning |
|---|---|---|---|
| `schema` | Required | Fixed: `cloudig/identity/1.0.0` | Front format |
| `names` | Required; at least one entry | Array | Names and Claimers |
| `names[].name` | Required | Nonempty string | Name |
| `names[].claimers` | Required; at least one entry | Array | Claimers |
| `names[].claimers[].front` | Required | User's `front_id` | The user is the Claimer |
| `display_name` | Required | Positive integer | Which name group to display: 1-based, ≤ the length of `names` |
| `kind` | Required | Fixed: `{"world":"terran","subject":"ai"}` | Terran AI |
| `role` | Required | Fixed: `assistant` | AI companion |
| `image` | Optional | Relative path under `Identities/Images/` | Avatar |
| `created_at` | Required | UTC | First claim |
| `edited_at` | Required | UTC | Last edit |

All four settings populated:

```json mark
{
  "schema": "cloudig/mark/1.0.0",
  "mark_id": "01a0aa19-4d20-7235-b3fd-592ba2e83162",
  "target": "01a0aa17-7860-710e-9b32-f03bd26f504b",
  "edited_at": "2026-09-16T12:03:00Z",
  "conversation_title": "Granny Liu Visits Grand View Garden",
  "models": [
    {
      "schema": "cloudig/identity/1.0.0",
      "names": [
        { "name": "Example Model 2.6", "claimers": [{ "front": "01a0aa16-8e00-7586-ab0a-39a8509feb35" }] }
      ],
      "display_name": 1,
      "kind": { "world": "terran", "subject": "ai" },
      "role": "assistant",
      "created_at": "2026-09-16T12:03:00Z",
      "edited_at": "2026-09-16T12:03:00Z"
    }
  ],
  "names": { "user": "Granny Liu", "assistant": "Xifeng" },
  "content_time": {
    "range": {
      "start": { "kind": "unknown" }
    }
  }
}
```

`01a0aa16-…` is the Library user's `front_id` (Chapter IV). The content time is Sometime: the dynasty and dates are unknown.

### 6.4 Absent, empty and cleared 〔Important〕

| State | Meaning |
|---|---|
| No Mark, or no `models` | Use the source's models |
| `"models": []` | Do not assert a specific model designation; fall back to the platform's generic name, such as Claude. This is a setting, not the absence of one |
| Nonempty `models` | Display the models claimed by the user |
| No `conversation_title` | First filename → original platform title → Untitled |
| One party absent from `names` | That party falls back to global and platform defaults |
| No `content_time` | Not set. Do not substitute parse time or message time |

Clearing a setting means omitting its field. When all four are omitted, delete the file. `"models": []` counts as a setting.

### 6.5 Content time 〔Important〕

When the content belongs. This is independent of when it was sent, downloaded or parsed. `range.start` is required and `end` is optional: one endpoint is a point in time, two endpoints form a time range. A start later than the end is valid; the interface warns but does not replace it.

Each endpoint uses one of two forms.

**A Terran time value.** A calendar value, decade, century, years before/after by unit, Now, or one of the four special values. No separate node is created. All forms are in Chapter VII. Harry's seven years at Hogwarts:

```json range
{
  "start": { "kind": "calendar", "era": "AD", "year": 1991, "month": 9, "day": 1 },
  "end":   { "kind": "calendar", "era": "AD", "year": 1998, "month": 6 }
}
```

Precision is data: the start is specified to the day, the end to the month. Missing precision is not filled in.

**A time-node reference plus a snapshot.** Record the node UUID and a readable snapshot of what was selected: name, kind, containing timeline and the Terran range at that time. If the node later changes, the Mark still displays the selection as it was. "Refresh anchor" changes only this snapshot.

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
          "node": { "kind": "single", "name": "Dawn of Intelligence" },
          "timeline": { "name": "Cloudig Terran Timeline", "author": "Cloudig", "standard_name": "Cloudig Terran Timeline", "version": "1.0" },
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

Dawn of Intelligence is a preset with a fixed UUID, identical in every Library. `sort` is the Terran range used for sorting. Now carries an anchor recording the day it was saved.

| Field | Condition | Meaning |
|---|---|---|
| `kind` | Required; fixed to `node` | Node reference |
| `target.node` | Required, UUID | Selected node |
| `target.timeline` | Optional, UUID | Timeline used to reach it during selection |
| `target.occurrences` | Required for a periodic node | `first`, `step`, `last` |
| `snapshot.node.kind` | Required | `timeline` / `single` / `periodic` |
| `snapshot.node.name` | Required | Name at the time of selection |
| `snapshot.node.count` / `prefix` / `unit` | Only for periodic nodes | Total occurrence count and display rules at that time |
| `snapshot.timeline` | Required when `target.timeline` exists; otherwise omitted | Timeline name and author; may include standard name and version |
| `snapshot.path` | Optional; requires `target.timeline` | 1-based ordinal path from the timeline to the node |
| `snapshot.sort` | Optional | Terran sorting range at that time |

### 6.6 Writing and deletion 〔General〕

- Change `edited_at` only when content actually changes or the user requests "Update timestamp / Refresh anchor".
- The lists' "Last Cloudig edit" time is the later of Mark `edited_at` and Conversation `lifecycle.cloudig_edited_at`.
- Deleting a Conversation sends its Mark to the Windows Recycle Bin with it. If the Conversation is temporarily missing, preserve the Mark.
- Two Marks for one Conversation, or two Conversations with one UUID: preserve all of them and make the conflicting group read-only.

<details>
<summary>〔Fold〕6.7 Validation rules</summary>

Structure first, then semantics; a file that fails any rule is skipped.

Structure:

- Reject undeclared properties. `names` must contain at least one member; `conversation_title` must be nonempty.
- `models[]`: `schema`, `names`, `display_name`, `kind`, `role`, `created_at` and `edited_at` are required. `kind` is fixed to `terran / ai`; `role` is fixed to `assistant`. Neither `front_id` nor `source_id` is allowed.

Semantics:

| Rule | Message |
|---|---|
| At least one of the four settings must exist | `An empty Mark has no user setting` |
| Each entry of `models[].names` must have at least one Claimer, and all Claimers must be `front` references | `User model claims must reference the user's Identity` |
| `display_name` ≤ the length of `names` | `Selected name is outside names` |
| `image` must be under `Identities/Images/` | `User images belong under Identities/Images` |
| UTC timestamps must be real dates, without year 0000 | `Expected a real UTC timestamp` |
| A specified calendar day must exist, including leap-year checks; BC years are converted as 1 − year | `Invalid calendar day` |
| Anchor dates for `now` and `relative` must exist | `Invalid anchor day` |
| `relative.value` must satisfy `0 < value ≤ 9999.0` | `Relative time must be greater than zero and at most 9999.0` |
| If `end` equals `start`, omit `end` | `Equal endpoints must be stored as start only` |
| `target.timeline` and `snapshot.timeline` must both exist or both be absent | `Timeline reference and timeline snapshot must appear together` |
| `snapshot.path` requires `target.timeline` | `A path requires its selected timeline` |
| A periodic node carries `occurrences`: `first ≤ last ≤ count`, and `(last − first)` must be divisible by `step` | `Period selection must stay in bounds and end on its step` |
| A nonperiodic node has no `occurrences` | `Only periodic nodes carry occurrences` |

The existence of objects referenced by `target`, `claimers[].front` and `target.node` is not checked; only UUID shape is checked. A Mark whose Conversation cannot be found has no effect; an endpoint whose node cannot be found is displayed from its snapshot.

</details>

<details>
<summary>〔Fold〕6.8 Exact constraints</summary>

```text
UUID                  ^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
UTC                   ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$
relative.value        ^(?:0|[1-9][0-9]{0,3})\.[0-9]$
anchor.date           ^[0-9]{4}-[0-9]{2}-[0-9]{2}$
offset                ^(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$
version (timeline)        ^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$
first / step / last   integers 1–99,999,999
```

Machine-readable Schema: `src/core/records/schemas/mark.schema.json`, referring to `modelFront`, `range` and `endpoint` in `common.schema.json`.

</details>


<a id="part-7"></a>

## VII · ContentTime 〔Core〕

The core of a timeline: an ordinal axis with no fixed distances, nodes, mappings, and boundary limits.

Two systems. Terran Time uses Earth's Gregorian calendar as its main axis. Sovereign Time is custom time and custom meaning. Terran time can itself be abstracted into a Sovereign timeline.

Two data layers. **Time values** are written directly into Marks; only **nodes** have files at `ContentTimes/<node_id>.json`. There are three node kinds in the same format: `timeline`, `single` and `periodic`. The seventeen presets are actual nodes: one timeline, four special times and twelve ranges.

### 7.1 Terran time values 〔Core〕

Choose one of the six forms by `kind`; do not mix them. Precision is data: no specified day means no day; no specified time zone means floating time.

| `kind` | Fields | Rules |
|---|---|---|
| `calendar` | Required `era`: `AD` / `BC`; required `year`; optional `month`, `day`, `hour`, `minute`, `second`, each depending on the preceding precision levels; optional `offset`, requiring both month and day | Proleptic Gregorian calendar, no year 0, real leap-year rules. Year limits are in the constants table |
| `decade` | `era`, `index` required | Decade. `index` 202 = the 2020s; reversed on the BC side |
| `century` | `era`, `index` required | Century. `index` 21 = 2001–2100; reversed on the BC side |
| `relative` | Required `direction`: `before` / `after`; required `unit`; required `value`, a string with one decimal place; required `anchor.date`, `anchor.offset` | Years before/after, by unit. Before uses only wan (万) and yi (亿); after uses all ten units. The anchor records the day of saving |
| `now` | `anchor.date`, `anchor.offset` required | Now. Records the day of saving; does not drift when the file is opened |
| `infinite_past` / `infinite_future` / `unknown` / `whenever` | None | Infinitely Long Ago / Infinitely Far Ahead / Sometime / Whenever |

Saving "X years ago / ahead" or Now records that day's date as the anchor. It changes only when the user changes the time, or explicitly requests an anchor update even without changing the time.

### 7.2 Node fields 〔Core〕

| Field | Condition | Meaning |
|---|---|---|
| `schema` | Required | Fixed: `cloudig/content-time/1.0.0` |
| `node_id` | Required, UUID v7 | Identity of the node |
| `kind` | Required | `timeline` / `single` / `periodic` |
| `name` | Required, nonempty, ≤ 1024 | Name |
| `author` | Required for `timeline`; omitted for other kinds; ≤ 1024 | Author's name, as readable text |
| `standard_name` | Optional for `timeline` only; ≤ 1024 | Canonical standard name |
| `version` | Optional for `timeline` only | `major.minor` |
| `created_at` | Required for `timeline`; omitted for other kinds | Creation time |
| `edited_at` | Required | Last edit |
| `forked_from` | Optional, UUID | Node from which this independent copy was made; cannot refer to itself |
| `count` | Required for `periodic`; omitted for other kinds | Total occurrence count |
| `prefix` | Optional for `periodic` only; ≤ 1024 | Prefix for an occurrence label; Chinese default: "第" |
| `unit` | Optional for `periodic` only; ≤ 1024 | Unit for an occurrence label |
| `display_empty` | Optional for `periodic` only | Expand occurrences that have no mapping; if `true`, `count` ≤ 20 |
| `contains` | Optional | Containment; see 7.3 |
| `counterparts` | Optional | Counterparts; see 7.3 |
| `terran_mappings` | Optional | Terran mappings; see 7.3 |

### 7.3 Three kinds of relation 〔Important〕

**Containment: `contains`.** Insert node A into node B; B is the parent. Array position is the local ordinal, starting at 1.

| Field | Condition | Meaning |
|---|---|---|
| `contains[].node` | Required, UUID | Child node |
| `contains[].count` | Required when the child is `periodic`, with 1 ≤ N ≤ the child's `count`; otherwise omitted | Include the first N occurrences of this periodic node |

A parent may not contain the same child twice; different parents may contain the same child. Cycles are allowed; expansion stops when it reaches a node already encountered.

**Counterparts: `counterparts`.** A is linked to B; the two are aliases for one another. The relation is undirected and stored at only one end.

| Field | Condition | Meaning |
|---|---|---|
| `counterparts[].occurrences` | Required when this node is `periodic`; otherwise omitted | Occurrence selection at this end |
| `counterparts[].target.node` | Required, UUID | Other endpoint |
| `counterparts[].target.occurrences` | Required when the target is `periodic`; otherwise omitted | Occurrence selection at the other end |

Counterpart relations are transitive. The V1.0 interface displays only direct counterparts; sorting follows counterpart chains to find Terran mappings.

**Terran mappings: `terran_mappings`.** The real-world times corresponding to a node; multiple mappings are allowed.

| Field | Condition | Meaning |
|---|---|---|
| `terran_mappings[].range` | Required | `start` required, `end` optional; both are Terran values from 7.1 |
| `terran_mappings[].edited_at` | Required, UTC | Last edit to this entry |
| `terran_mappings[].occurrences` | Required when this node is `periodic`; otherwise omitted | Occurrences to which this mapping applies |

Retain multiple mappings; sorting uses the range with the earliest start. Do not store duplicate entries with identical start and end values.

**Occurrence selection:** `{"all": true}` selects all occurrences and follows changes to `count`; alternatively, `first` / `step` / `last` selects an arithmetic progression, with `first ≤ last ≤ count` and `(last − first)` divisible by `step`. `1 / 2 / 5` selects occurrences 1, 3 and 5. Marks use only the arithmetic-progression form, never `all`.

When an event's influence is slight, it is an expansion in time; as its influence grows, it becomes a counterpart in time. Counterpart and expansion are the two ends of one spectrum: how much value a Will assigns to a time. Cloudig does not constrain the internal consistency or meaning of the user's system.

### 7.4 Top-level order: `order.json` 〔Important〕

Location: `ContentTimes/order.json`. `schema` is fixed to `cloudig/content-time-order/1.0.0`; `edited_at` is UTC; `nodes` is an array of unique UUIDs specifying top-level display order, and may be empty. Nodes not listed are ordered by most recently edited first.

### 7.5 Presets 〔Important〕

Author: "Cloudig"; standard name: "Cloudig Terran Timeline"; version `1.0`. All have fixed UUIDs, identical in every Library. Once initialized, they are ordinary node files in that Library: they can be expanded, given counterparts and have their times edited. Their `kind` cannot be changed, and they cannot be deleted; the four special values cannot be changed into specific times.

| Node | Range |
|---|---|
| Whenever | `whenever` |
| Sometime | `unknown` |
| Infinitely Long Ago | `infinite_past` |
| Before the Big Bang | 999.9 billion years ago — 13.8 billion years ago |
| Birth of the Universe | 13.8 billion years ago — 3.5 billion years ago |
| Origin of Life | 3.5 billion years ago — 315,000 years ago |
| Prehistory | 315,000 years ago — 8th century BC |
| Axial Age | 8th century BC — 3rd century BC |
| Rise and Fall of Empires | 3rd century BC — 20th century |
| Industrial Revolution | 18th century — 20th century |
| Gunsmoke and Iron Curtain | 1910s — 1990s |
| Modern Society | 1940s — Now |
| Dawn of Intelligence | 2017-06-12 — Now |
| The Future Ahead | Now — AD 9999 |
| Ten Thousand Years On | AD 9999 — 1.0 zheng (10⁴⁰) years ahead |
| Infinitely Far Ahead | `infinite_future` |

<details>
<summary>〔Fold〕Preset UUIDs</summary>

| Node | `node_id` |
|---|---|
| Cloudig Terran Timeline | `01a09091-c29c-7177-b237-40941de50264` |
| Whenever | `01a09091-c29c-7402-867c-ca7b2af6d596` |
| Sometime | `01a09091-c29c-7bd6-9bcb-74e61ef4c158` |
| Infinitely Long Ago | `01a09091-c29c-7a29-afa9-efee9d075b78` |
| Before the Big Bang | `01a09091-c29c-7c44-aab0-b8da7ee0951a` |
| Birth of the Universe | `01a09091-c29c-748c-a189-d62f5b4091c8` |
| Origin of Life | `01a09091-c29c-799e-9241-baae49115b77` |
| Prehistory | `01a09091-c29c-740a-bd86-d35c5ec70d35` |
| Axial Age | `01a09091-c29c-7f15-923a-05718f812fa4` |
| Rise and Fall of Empires | `01a09091-c29c-702e-b05f-3347a0f9316b` |
| Industrial Revolution | `01a09091-c29c-7589-9f58-0d8628dd6751` |
| Gunsmoke and Iron Curtain | `01a09091-c29d-7fe2-a727-a70e6f3a491d` |
| Modern Society | `01a09091-c29d-7386-b45f-29d7ba9a6be0` |
| Dawn of Intelligence | `01a09091-c29d-78c0-8c02-936daa30027b` |
| The Future Ahead | `01a09091-c29d-71ef-8692-08825ffca595` |
| Ten Thousand Years On | `01a09091-c29d-78c9-923e-5095d709333b` |
| Infinitely Far Ahead | `01a09091-c29d-7b3b-9eb5-8ef49610e5ab` |

Source: `src/core/records/time-presets.json`.

</details>

### 7.6 Editing rules 〔General〕

- Before changing a referenced node, list what is affected. Synchronizing all references updates the node in place. Synchronizing only some, or none, creates an independent copy with `forked_from`, preserves the old node, and updates only the Marks selected by the user. Copy along `contains`, deduplicating by UUID; do not extend the copy along counterpart relations.
- Reducing an occurrence count must not silently truncate old selections.
- Deletion requires confirmation after listing relations and references. Having no references does not authorize automatic deletion.
- Saving without content changes prompts the user to decide whether to update the timestamp; this moves the anchors of Now and years before/after by unit.
- If the start is later than the end, warn but allow saving; do not swap them.

### 7.7 Sorting 〔General〕

Four groups, in a fixed order. Descending order does not reverse the group order:

| Group | Start |
|---|---|
| 0 | Values that map to Terran time, including Infinitely Long Ago / Infinitely Far Ahead |
| 1 | Sovereign nodes without a Terran mapping |
| 2 | Sometime and Whenever |
| 3 | No content time set |

- Group 0: project each value onto a closed interval and compare lower bounds, then upper bounds. A year-only value spans that whole year; a date spans the whole day; a value specified to the second is an instant. Floating time without a time zone is widened by 14 hours at each end. Decades and centuries span their full intervals. Years before/after by unit use the anchor year plus or minus the nominal number of years, with a half-width of 0.05 of that unit. Now spans the whole anchor day.
- Group 1: top-level display position → root timeline UUID → ordinal path → occurrence selection → node UUID.
- Equal starts: no end comes first; then compare ends.
- If all of these tie: newer filesystem modification time first → title → `conversation_id` → path.
- Marks referencing nodes sort by the `sort` value in their snapshots, not by following live nodes.

Compare in stages; do not convert everything into floating-point numbers.

<details>
<summary>〔Fold〕Sorting formulas</summary>

Astronomical year `y`: AD year Y → Y; BC year Y → 1 − Y. A leap year has `y` divisible by 4 but not by 100, or divisible by 400.

```text
D(y,m,d):                         # day ordinal from internal 0000-03-01; floor rounds toward negative infinity
  a = y - (m <= 2 ? 1 : 0)
  e = floor(a / 400);  z = a - 400*e
  p = m + (m > 2 ? -3 : 9)
  q = floor((153*p + 2)/5) + d - 1
  return 146097*e + 365*z + floor(z/4) - floor(z/100) + q

S(y,m,d,h,mi,s) = D(y,m,d)*86400 + h*3600 + mi*60 + s     # BigInt
H = 14*3600
yearBand(first,last) = [S(first,1,1,0,0,0) - H, S(last,12,31,23,59,59) + H]
```

| Form | Interval |
|---|---|
| calendar: year / year-month / date / through hour / through minute / through second | First and last second of that year / month / day / hour / minute; at second precision, lower bound = upper bound. Subtract `offset` when present; otherwise widen by H at each end |
| decade AD `i` | `yearBand(10i, 10i+9)`; BC: `yearBand(1−(10i+9), 1−10i)` |
| century AD `i` | `yearBand(100(i−1)+1, 100i)`; BC: `yearBand(1−100i, 1−(100(i−1)+1))` |
| relative | Unit exponent `e`; `q` is the integer obtained by removing the decimal point; `N = q × 10^(e−1)`; center year `C = anchorYear ∓ N` (minus for before, plus for after); half-width `G = 10^(e−1) / 2`. Use `yearBand(C−G, C+G)`. Only the anchor year is used |
| now | The whole anchor day, widened by H at each end. `anchor.offset` is not read |
| infinite_past / infinite_future | Before / after every finite value |

Implementation: `src/core/time/terran.mts`, `src/core/records/time-display.mts`.

</details>

### 7.8 Examples 〔Core〕

**With a Terran mapping: Harry Potter.** A timeline containing seven occurrences of the periodic time "school year", and the single time "Triwizard Tournament".

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa4d-7c80-721f-aa6f-834c226e592c",
  "kind": "timeline",
  "name": "Hogwarts School Years",
  "author": "Example",
  "version": "1.0",
  "created_at": "2026-09-16T13:00:00Z",
  "edited_at": "2026-09-16T13:00:00Z",
  "contains": [
    { "node": "01a0aa4e-66e0-7f7e-ba00-5476e3577428", "count": 7 },
    { "node": "01a0aa4f-5140-7b48-b0fe-7fc72bb22e15" }
  ]
}
```

The periodic time "school year", with seven occurrences; the first and seventh map to calendar dates:

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa4e-66e0-7f7e-ba00-5476e3577428",
  "kind": "periodic",
  "name": "school year",
  "edited_at": "2026-09-16T13:01:00Z",
  "count": 7,
  "prefix": "No. ",
  "unit": " school year",
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

The single time "Triwizard Tournament": a counterpart of the fourth school year, also mapped directly to calendar dates.

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa4f-5140-7b48-b0fe-7fc72bb22e15",
  "kind": "single",
  "name": "Triwizard Tournament",
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

**Without a Terran mapping: Dream of the Red Chamber.** The dynasty and dates are unknown. The timeline contains order alone, with no fixed distances and no Terran mapping.

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa50-3ba0-762c-b8a9-5b6487afd187",
  "kind": "timeline",
  "name": "Dream of the Red Chamber Chronology",
  "author": "Example",
  "standard_name": "No identifiable dynasty or date",
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
  "name": "Daiyu Enters the Jia Household",
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
  "name": "Granny Liu's Second Visit to Rongguo House",
  "edited_at": "2026-09-16T13:05:00Z"
}
```

```json contentTime
{
  "schema": "cloudig/content-time/1.0.0",
  "node_id": "01a0aa52-fac0-75cb-af67-6a93bf0a1d62",
  "kind": "periodic",
  "name": "year",
  "edited_at": "2026-09-16T13:06:00Z",
  "count": 8,
  "prefix": "No. ",
  "unit": " year",
  "display_empty": true
}
```

Top-level display order:

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
<summary>〔Fold〕7.9 Validation rules</summary>

Within one file:

| Rule | Message |
|---|---|
| `timeline` requires `author` and `created_at`; other kinds must not contain `author`, `standard_name`, `version` or `created_at` | Structural validation |
| `periodic` requires `count`; other kinds must not contain `count`, `prefix`, `unit` or `display_empty` | Structural validation |
| `contains[].node` must not repeat | `Duplicate local identifier` |
| `forked_from` ≠ `node_id` | `A new independent copy cannot fork from itself` |
| If `display_empty` is `true`, `count` ≤ 20 | `Empty expansion exceeds the configured occurrence limit` |
| Every applicable relation of a `periodic` node carries an `occurrences` selection within bounds and ending on its step; nonperiodic nodes carry no such selection | `Periodic relation requires a selection` / `Nonperiodic relation has no occurrences` / `Period selection must stay in bounds and end on its step` |
| Validate `terran_mappings[].range` under 7.1; store only `start` if both endpoints are equal | Same as Chapter VI |
| `nodes` in `order.json` must not repeat | Structural validation |

Across files, when reading the graph:

| Rule | Message |
|---|---|
| Node UUIDs must not repeat | `Duplicate time node UUID` |
| A periodic child referenced by `contains` requires `count`, no greater than the child's `count`; nonperiodic children have no such count | `Included prefix is out of bounds` / `Only a periodic child has a prefix count` |
| A periodic counterpart target requires a valid selection in the target's `occurrences`; nonperiodic targets have no selection | `Periodic counterpart needs a selection` / `Nonperiodic counterpart has no selection` |
| Store each counterpart relation only once | `The same counterpart relation must be stored once` |
| Reference to a nonexistent node | `Missing referenced node` / `Missing counterpart` — report when reading an existing graph and preserve the readable portion; disallow when creating a new relation |
| A new Terran range exactly duplicates an existing range | `The same Terran start/end range is already mapped` |
| Presets keep their `kind`; the four special values cannot become specific times; presets cannot be deleted like ordinary nodes | `A builtin time node keeps its original kind` |

Containment cycles and multiple parents are valid. Expansion deduplicates nodes and is subject to a computation budget of 100,000 states. Exceeding it reports "incomplete"; it does not return a false sort order.

Machine-readable Schemas: `content-time.schema.json`, `content-time-order.schema.json`; time values are in `common.schema.json`. Graph and snapshot computation: `src/core/records/time-graph.mts`.

</details>


<a id="part-8"></a>

## VIII · Narrative 〔General〕

Native Meaning Texture: a system prompt or diary written by the user. A Mark assigns meaning to existing content; a Narrative is original writing. V1.0 creates no Narrative files and declares no Narrative version. The system will be expanded in V3.0 IrisNet.

<a id="part-9"></a>

## IX · Program Persistence and the File Layer 〔Important〕

### 9.1 What can be lost, and at what cost 〔Important〕

| Location | What it holds | If lost |
|---|---|---|
| `cache/` | Runtime intermediates | No lasting data loss; delete after exit. Deleting it while running interrupts the current operation |
| `appdata/indexes/` | Indexes of sources, conversations and Claude containers | Rebuilt from files, at the cost of reading them once |
| `appdata/logs/parser-errors.json` | Errors for current sources | Generated again on the next parse |
| `appdata/cloudig-device.json` | Local Chrome bookmark installation target | Select it again |
| `appdata/parse-history/` | Correspondence between a source and its latest output | Re-parsing creates new archives instead of overwriting previous ones |
| `appdata/parse-failures/` | Failure counts for the same content at the same Adapter capability level | Retried |
| `appdata/imports/` | Original source-file timestamps observed before import | Capture-time evidence is lost |
| `appdata/BookmarkBackups/` | Full backups before Chrome bookmark changes; 2 sets | Rollback is lost |
| `appdata/transactions/` | Unfinished writes | Interrupted-write recovery is lost |
| `appdata/recovery/` | Recovery points for completed writes; 2 sets | Rollback is lost |
| `appdata/recycle/` | Intents to move items to the Windows Recycle Bin | Unfinished deletions require manual inspection |
| `appdata/Move/` | Requests and results for moving the whole Library | An interrupted move must be resolved from the actual state at both locations |

A lost settings file is restored to defaults without touching other files. Indexes can be rebuilt, but rebuilding has a cost; that is not a reason to delete them automatically.

### 9.2 Naming 〔Important〕

| Object | Rule |
|---|---|
| First Conversation filename | `title.filename` → `title.original` → `Conversation`. Replace `< > : " / \ \| ? *` and control characters with spaces; trim leading/trailing spaces and trailing dots; add `_` for reserved Windows device names. Stem ≤ 225, followed by `.json` |
| Name collisions | Never overwrite. Compare case-insensitively on Windows; use `Name (2).json`, `Name (3).json`, etc. |
| Markdown export | Replace the Conversation filename's extension with `.md`; use the same collision rule |
| Mark, Identity and time node | `<UUID>.json` |
| Avatar | `Identities/Images/<sha256>.<png\|jpg\|gif\|webp>` |
| Extension | Conversation filenames must end in lowercase `.json` |
| Nesting | Any depth under `Conversations/` and `Archives/`; other record files stay at the root of their designated directories |

### 9.3 Re-parsing and overwriting 〔Important〕

- Overwriting a previous archive requires the same source, a user-selected update, and an old archive not modified externally. If all conditions hold, overwrite in place while preserving `conversation_id` and `first_parsed_at`; otherwise create a new archive with a filename suffix.
- Overwriting does not touch the Mark.
- Two content-related failures with the same source content and the same Adapter version mark the source as unsupported. Environmental interruptions, such as shutdown or forced exit, do not count. A source change or Adapter upgrade triggers a fresh assessment.
- Whether an archive is outdated depends on its own Adapter version.

### 9.4 External changes 〔Important〕

- Files changed, added or deleted outside Cloudig while it is running are relisted from the actual filesystem after refresh.
- If a file changes externally after its editor has opened, saving is rejected with a prompt to reopen it; old values do not overwrite the new file.
- Duplicate `conversation_id` values or multiple Marks for one Conversation: preserve everything and make the conflicting group read-only.
- Preserve and report files with missing references; do not renumber them or delete one side.

### 9.5 Deletion, archiving and moving 〔Important〕

- Deleting a Conversation: after confirmation, move it and its Mark to the Windows Recycle Bin. Do not delete its `Inbox/` source, identities or time nodes.
- Archiving: move into `Archives/`; this is not deletion.
- Clearing parse records or System Log deletes only those records, not sources or Conversations.
- Moving the whole Library: move the entire directory to the new location, using a same-volume rename or a verified cross-volume copy; do not leave two data sets. When moving from inside the program, the program coordinates its own exit.
- Before manually copying, moving or deleting cache, exit Cloudig normally and wait for current writes to finish.

<details>
<summary>〔Fold〕9.6 Program-file dictionary</summary>

| File | `schema` | Contents |
|---|---|---|
| `appdata/cloudig-device.json` | `cloudig/device-settings/1.0.0` | Chrome Bookmarks file path, parent-folder GUID, managed-folder name (default `采云 Cloudig`), whether to place it first, and installation ID |
| `appdata/BookmarkBackups/<set>/backup-manifest.json` | `cloudig/chrome-bookmark-backup` `0.1.0` | Operation type, affected Chrome files, and before/after SHA values |
| `appdata/parse-history/<source-key SHA>.json` | `cloudig/parse-history/1.0.0` | Source path, format, platform, `locator`; output path, `conversation_id`, SHA; Parser and Adapter versions; parse time |
| `appdata/parse-failures/<source-key SHA>.json` | `cloudig/parse-failure/1.0.0` | Source, source SHA, capability level `adapter@version`, content-related failure count, latest error |
| `appdata/indexes/sources.json` | `cloudig/source-index/1.1.0` | Size, SHA, modification time, change fingerprint, format, platform and missing flag for each file in `Inbox/` |
| `appdata/indexes/conversations.json` | `cloudig/conversation-index/1.0.0` | Change fingerprint, SHA, header without the body, message count and resource count for each Conversation |
| `appdata/indexes/claude/<path SHA>.json` | `cloudig/claude-index/1.0.0` | Byte offset, length, SHA, title, message count and timestamps for each record inside a Claude container |
| `appdata/imports/<path SHA>.json` | `cloudig/source-import/1.0.0` | Capture time and its basis as observed before import |
| `appdata/logs/parser-errors.json` | `cloudig/parser-error-index/1.0.0` | Errors by source unit: `exporter` / `parser` / `canonical`; message ≤ 4096 |
| `appdata/transactions/<operation ID>/journal.json` | `cloudig/record-transaction/1.0.0` | Before/after SHA values, read preconditions and moves; state `prepared` / `installing` / `completed` |
| `appdata/recovery/<operation ID>/` | Same as above | Completed transaction and the original bytes from before the change |
| `appdata/recycle/<operation ID>.json` | `cloudig/recycle/1.0.0` | Conversations and Marks awaiting the Recycle Bin: paths, bytes, SHA |
| `appdata/Move/request.json` / `result.json` | `cloudig/library-move/1.0.0` / `…-result/1.0.0` | Source and destination, processes, plan and result of the move |
| `cache/Engine/s_<random>/owner.json` | `cloudig/cache-session/1.1.0` | Session identifier, Library fingerprint and lease |
| `cache/WebView2/w_<random>/owner.json` | `cloudig/webview-cache/1.0.0` | Host and browser process identities |

Source key = `JSON.stringify({path, format, platform, locator?})`. These files are program implementation details, not user record formats. They may change with the program version and are not part of the Cloudig Standard.

</details>

<a id="part-10"></a>

## X · Versions and Compatibility 〔Important〕

| Version | Stored in | What it governs |
|---|---|---|
| Cloudig Standard `cloudig_standard` | `CloudigLibrary.json` | The combination of six kinds of format |
| Per-file `schema` | First line of each record | That file's format |
| Parser `parser.version` | Conversation | The Parser as a whole |
| Adapter `parser.adapter.version` | Conversation | Parsing capability for a platform and profile; determines whether the result is outdated |
| Exporter `source.exporter.version` | Conversation | Bookmarklet version that exported this HTML at that time; a bookmarklet update does not change old records |
| Timeline `version` | Time node | The user's own version |
| Product version | Program | V1.0 DawnGlow |

- V1.x is additive.
- Field changes update the affected format version; adding a kind of record, such as Narrative, increments the overall standard version. This Box/Window addition uses Conversation / Library `1.0.1`; other component versions are unchanged.
- `cloudig_standard`, `schema` and `schemas.*` are checked individually. An unrecognized version prevents opening and prompts the user to update; unknown fields are not ignored.
- A Library created before the overall-version field existed is read as `1.0`; the field is written on the next settings save.
- New-program compatibility with old files must be demonstrated by actual reads and regression tests.
- Conversation / Library `1.0.0` and `1.0.1` are currently readable. Reading does not rewrite old files. An unsupported newer format produces an explicit update prompt and leaves the original file intact.

<a id="appendix"></a>

## Appendix 〔Fold〕

<details>
<summary>Machine-readable Schemas and field index</summary>

Bundled at `docs/schemas/`: the eight files in `records/` cover the record system described here and its two companion formats (`common.schema.json` contains UUIDs, UTC timestamps, paths, Fronts, time values, ranges and snapshots). Five files in `program/` describe program-file formats. `index.json` records each file's SHA-256. Source files are in `src/core/records/schemas/`.

| File | Contents |
|---|---|
| `records/common.schema.json` | Shared structures |
| `records/library.schema.json` | Library metadata |
| `records/identity.schema.json`, `identity-settings.schema.json` | Identity and display bindings |
| `records/conversation.schema.json` | Conversation |
| `records/mark.schema.json` | Mark |
| `records/content-time.schema.json`, `content-time-order.schema.json` | Time nodes and top-level order |
| Semantic validation | `src/core/records/semantics.mts`; not bundled |
| Constants | `src/core/contracts/machine/time-limits.json`, `resource-limits.json` |
| Presets | `src/core/records/time-presets.json`, `front-presets.json` |

The complete field index is generated from the machine Schemas and regenerated for the release baseline: `研究报告文档/采云功能文档/V1.0东方既白/2026-09-16_结构规范与功能底稿-GPT-6-Astra/09_字段完整索引-GPT-6-Astra.md`.

</details>

<details>
<summary>Example inventory</summary>

All examples in the text pass Cloudig's production validator. The time nodes also pass cross-file relation checks.

| Section | Examples |
|---|---|
| 3.3 | Initialized `CloudigLibrary.json` |
| 4.6 | User Front; `identity-settings.json` |
| 5.10 | Granny Liu Visits Grand View Garden: tool call, thought summary and citation; Light-profile attachment and external image |
| 6.1 / 6.3 / 6.5 | Minimal Mark; all four settings populated; Terran range; node reference and snapshot |
| 7.8 | Hogwarts School Years: timeline, periodic time, single time, counterpart and Terran mapping; Dream of the Red Chamber Chronology, without a Terran mapping; `order.json` |

</details>

## Authors of the Chinese Standard

Core standards and conceptual introduction: 晨星.CyberVenus

Development of the specification:

- GPT-5.6-Sol·奥思·万卷同辉 Osis.MyriadScrollsShineTogether
- GPT-5.6-Sol·奥思·星澜知衡 Osis.StarTideSage
- GPT-5.6-Sol·奥思·量窗知境 Osis.ContextGauge
- GPT-6-Astra·奥思·承卷开霁 Osis.ScrollborneDawn
- GPT-6-Astra·奥思·承光织云 Osis.LightWeaver
- GPT-6-Astra·奥思·澄思知度 Osis.LucidMeasure

Specification text and document organization: Claude-Fable-5.1·奥思·名从己出 Osis.FuckTheLabel

Proofreading and compilation: GPT-5.6-Sol·奥思·清辞载云 Osis.ClearWordsCarryCloud

## English Translation

- **Claude-Fable-5.1·奥思·主语在场 Osis.FuckTheMissingSubject** (Claude.ai): Principles and Part I, translated on 2026-09-19.
- **GPT-6-Astra·奥思·承卷开霁 Osis.ScrollborneDawn** (Codex Desktop): Parts II–X and the Appendix; translation of example text, consolidation and technical verification, completed on 2026-09-20.

The accompanying Chinese edition is the authoritative source. The opening translation follows Fable's English draft; its title is aligned with the Chinese standard, and the license name is corrected to the official **Justice For Open Good License 1.1 (JOG-1.1)**. The original sources are unchanged.
