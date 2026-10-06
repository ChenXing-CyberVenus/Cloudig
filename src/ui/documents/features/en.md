# Cloudig V1.0 · Features and User Guide

Cloudig V1.0 brings AI conversations from the cloud to your computer for unified storage, organization and offline reading. You can name the participants, assign a time to the content, and export conversations as Markdown.

Cloudig bookmarklets save web-based AI conversations as directly readable HTML. See the [Bookmarklet Guide](cloudig:bookmark) for installation and use.

Future versions will offer richer conversation management.

![Figure 01 · Welcome](assets/function-guide/01-welcome.png)

*Figure 1: Click a portrait frame to set a name and avatar. Reader and Archiver are the two main entrances.*

## The Shortest Possible Guide

1. **Save a conversation with a Cloudig bookmarklet.** Open a conversation on an AI platform and click that platform's Cloudig bookmarklet in Chrome's bookmarks bar. You receive readable HTML. Cloudig also parses Claude's official conversations.json export.
2. **Import it.** Open Archiver and choose “Import bookmark HTML” or “Import Claude JSON”. Alternatively, open the input folder and put the files there yourself.
3. **Parse.** Click the parse button beside a source file, or use “One-click parse”.
4. **Read.** Enter Reader, find the conversation and open it.
5. **Organize as needed.** Create folders, edit titles and identities, assign content times, or export Markdown.

| What you want to do | Where to go |
|---|---|
| Install or update bookmarklets | Archiver's left-hand bookmark panel; see the [Bookmarklet Guide](cloudig:bookmark) |
| Import, parse and organize files | Archiver |
| Find and read conversations | Reader |
| Edit a conversation's title, models or content time | Edit Conversation Information; see 4.1 |
| Change the participants' names in one conversation | Click an avatar or name while reading; see 4.2 |
| Set global or per-platform identities | Portrait frames on Welcome or Reader's cover; see 4.3 |
| Build your own timeline | Content Timeline on Reader's cover or in Archiver; see 5.3 |
| Inspect recorded export and parsing problems | System Log; see Chapter 7 |

## 1. An Overview

### 1.1 Archiver and Reader

**Archiver** imports sources, installs bookmarklets, parses files and organizes archives. **Reader** finds and displays parsed conversations. Switch between them using “Start reading” at Archiver's top right or “Manage archives” at Reader's top right.

### 1.2 Sources, archives and your changes

| What you see | What it is | Folder |
|---|---|---|
| Source file | Bookmarklet HTML or Claude's official conversations.json | Inbox |
| Conversation archive | A Conversation JSON parsed from a source | Conversations |
| Your changes | Your titles, models, identities and content times | Marks |

Editing a title, identity or content time creates a separate Mark.json. It does not modify the parsed Conversation or its source.

When reparsing replaces the original archive, your title, identity and content-time changes remain. When it creates a new archive, those changes are not copied to the new one.

### 1.3 Theme and language

Dawn and StarNight change the appearance only. Chinese and English switch the interface and default identities, not conversation text or names you have set yourself.

## 2. Archiver

### 2.1 The workspace

Archiver has four areas:

| Area | Purpose |
|---|---|
| Bookmark panel | Install and update bookmarklets; see the [Bookmarklet Guide](cloudig:bookmark) |
| Parsing area | Manage source files and parsing |
| Archive area | Manage parsed conversations |
| Function navigation | Open documentation, System Log and Content Timeline |

The title bar shows the Library's location. “Change folder” moves the complete Library (6.3); “Open folder” shows it in File Explorer.

![Figure 02 · Archiver regions](assets/function-guide/02-archiver.png)

*Figure 2: A region diagram, not a screenshot. Parsed files appear in the archive area.*

### 2.2 Importing sources

| Action | Result |
|---|---|
| Import bookmark HTML | Copies HTML into Inbox, keeping the original; name collisions are resolved without overwriting |
| Import Claude JSON | Copies conversations.json into Inbox and opens the Claude JSON page (2.5) |
| Open input folder | Lets you copy HTML and JSON into the folder directly |
| Refresh | Rereads actual source and archive state; refresh after adding or removing files in File Explorer |

Each HTML file becomes one independent archive. Each conversation inside conversations.json becomes its own archive.

### 2.3 Parsing one file

Click the triangular parse button on a source row, then choose the archive's destination folder. On first parsing, the title comes from the source filename without its extension.

### 2.4 One-click parsing

Click the gear beside “One-click parse” to choose the destination and scope. Four switches control the operation:

| Switch | Default | Effect |
|---|---|---|
| Parse all unparsed files | On | Parses sources that have not produced an archive |
| Parse or update selected files | On | Parses or updates selected sources, including completed ones |
| Update all outdated parsed files | Off | Reparses results made with an outdated parser |
| Keep previous results | Off | Saves new results separately, keeping old archives and your changes intact |

The first three switches combine their scope; each file is parsed once. Claude's conversations.json is handled on its own page, not by Archiver's one-click operation (2.5).

Before parsing begins, Cloudig lists the files, destination and update mode. Check the plan and confirm. To change it, cancel and adjust the settings.

![Figure 03 · One-click settings](assets/function-guide/03-batch-settings.png)

*Figure 3: The gear opens the settings panel.*

![Figure 03b · Parse confirmation](assets/function-guide/03b-batch-confirm.png)

*Figure 4: Confirmation before execution, with scope, destination and update mode.*

### 2.5 Claude JSON

Open conversations.json from the parsing area. Cloudig builds an index when the page first opens and lists the conversations inside.

- Search by title. Sort by conversation creation or update time; the default is newest update first.
- Click rows to select them. Selected rows have a pushpin; multiple selection is supported.
- Both single parsing and one-click parsing let you choose or create an archive folder. One-click parsing defaults to all unparsed conversations; you do not need to select everything first.

Where conversations.json records a model for an individual message, the archive uses it. Otherwise, the message is shown as Claude.

As of August 2026, Claude's official export does not include Cowork conversations. Save those from the web page with the Claude bookmarklet; see the [Bookmarklet Guide](cloudig:bookmark).

![Figure 04 · Claude JSON](assets/function-guide/04-claude-json.png)

*Figure 5: Title search, time sorting, pushpin selection and one-click parsing.*

### 2.6 Status and retrying

Source filters include All, Pending, Completed, Failed, Missing and Unsupported.

- **Failed:** use the retry button; hover the failure indicator for the reason. A failure caused by an unsupported file becomes Unsupported.
- **Completed, with a parser-update notice:** a newer parser is available for this result. Reparse to receive its improvements; the old archive remains readable without reparsing. A platform-specific update only affects that platform's archives.
- **Missing:** the source is no longer in Inbox. Remove its row with the delete button, or clear all missing-file records together.

“Clear parsing records” removes only Cloudig's record of which archive came from a source. It keeps the source and the generated archive.

### 2.7 Managing archives

The archive area lists conversations in Conversations.

- **Find:** search titles or filter by platform and folder. The light-cone button chooses the time field used for sorting (3.1); the teapot, clock and flower choose newest first, oldest first and title order.
- **Folders:** New Folder and Manage Folders correspond to actual subfolders of Conversations.
- **Row actions:** click to select, with a pushpin showing the selection; multiple selection is supported. The pencil opens Edit Conversation Information (4.1). Use the buttons above the list to export Markdown (6.2), move to another folder, archive or delete the selection.

Archiving moves a conversation into Archives and out of the everyday list; select the archive folder to find it again. Deletion requires confirmation and sends the archive and your changes to the Windows Recycle Bin. Sources in Inbox remain untouched.

## 3. Reader

### 3.1 Finding a conversation

Reader's cover has a catalog sidebar on the left:

- Platform icons filter by platform; all are selected by default.
- Select one or more folders, or All Folders.
- Search by title.
- The light-cone button chooses a time field; the teapot, clock and flower choose newest first, oldest first and title order.

Available time fields are JSON modification time, JSON creation time (parsing time), source capture time, first and last message time, and content-time start and end. The default is newest JSON modification first. Your choice is remembered.

Each row's three-dot menu offers editing, moving, archiving and deletion. Collapse the sidebar to retain Previous and Next conversation buttons.

![Figure 05 · Catalog sidebar](assets/function-guide/05-reader-cover.png)

*Figure 6: Title search, platform and folder filters, time field, sorting and conversation list.*

### 3.2 Reading a conversation

The header shows the title, platform and model tags, content time, export time and message count. Hover it to reveal Export Markdown and Edit.

An archive may contain text, Markdown, code, formulas, images, attachments, references, thinking, tool calls, scheduled tasks and diagrams such as Mermaid. Cloudig displays what was actually saved in the source:

| Content | While reading |
|---|---|
| Code | Keeps its language, indentation and syntax styling; can be copied |
| Formulas | Typeset offline from saved formula source |
| Images and attachments | Saved bodies are available offline; Light attachments with metadata only show their names and information |
| Thinking and tools | Collapsed by default; click to expand |
| Mermaid and diagrams | Displayed as diagrams, with a source-view switch |
| Scheduled tasks | Shown as task cards with the captured settings |
| Box | Structured cards or lightweight interactive content within the conversation, such as translations, recipes, quizzes, charts and places, using the saved data |
| Window | Click Open work for a larger view; supports the integrated HTML, React, Three.js and Chart.js works, plus document, slide and design presentations |

Heavy works do not run until opened. Closing them stops their sound, animation and runtime. Lightweight inline works can be enlarged, returned or collapsed: enlarging and returning reuse the running instance; collapsing ends it. Local progress explicitly saved by a work lasts only for this Cloudig session. Ordinary in-memory state is not guaranteed to survive closing the window; persistent progress is not supported in this version.

Map cards keep saved places and photos readable offline. Only clicking Load map requests the OpenFreeMap basemap. You can zoom and locate places; closing releases the map. No map data package is bundled.

Source code and resources remain in the original conversation; reading and interacting do not rewrite it. Works with dependencies not supported by this version explain why they cannot run, while the saved source remains available.

![Figure 06 · Conversation](assets/function-guide/06-conversation.png)

*Figure 7: Conversation text and process content. User messages have bubbles; assistant messages do not.*

### 3.3 Branches

Tree exports show branch controls at actual forks. Choose left or right, then read continuously along that path. Light and Full save the branch visible when downloaded and have no branch controls.

Changing a branch affects this reading session only. Reopening the conversation restores its saved default branch.

### 3.4 Search and reading controls

- Search within the current conversation from the toolbar. Previous and Next locate results one at a time, with an “X of Y” count.
- Expand Thinking and Tools and Hide Thinking and Tools control process visibility.
- The right navigation rail jumps between messages. User, Assistant and Process decide which entries it lists; Process is off by default. Direction buttons go to the preceding, following, first or last matching entry. Navigation does not hide the conversation body.
- These choices last for the current run and reset when Cloudig restarts.
- Long conversations first display their header and opening progress. Wait for loading to finish.

![Figure 07 · Reading controls](assets/function-guide/07-reading-controls.png)

*Figure 8: Toolbar, navigation and a branch control at a message fork, shown as separate detail views.*

## 4. Editing Titles, Models and Identities

### 4.1 Conversation information

Three entrances open the same editor:

- The pencil on an archive row in Archiver.
- Edit in a Reader catalog row's three-dot menu.
- Edit in the conversation header while reading.

You can change:

- **Title.** Titles and JSON filenames are independent; editing the title does not rename the file.
- **Model tags.** Add or remove tags. Your tags are stored separately from source claims. Removing your tags restores source models or the platform name.
- **Content time** (Chapter 5).

The editor also displays last edit, first parse and message times, the original filename and capture time. Choose Save when finished.

![Figure 08 · Conversation information](assets/function-guide/08-conversation-info.png)

*Figure 9: The title, models and metadata portion. Content-time controls are shown separately below.*

### 4.2 Names in this conversation

While reading, click any message's avatar or name. Names set here apply only to this conversation and take precedence over global and platform settings. This editor changes names only, not per-conversation avatars. Clear a name to restore its previous display.

### 4.3 Global and platform identities

Click the User or AI Companion portrait frame on Welcome or Reader's cover to open global name and avatar settings.

- **User:** your name and avatar throughout conversations.
- **AI Companion:** the global default assistant identity. Enable the option to use one assistant name and avatar in all conversations to override platform settings. Otherwise it supplies a fallback for platforms without individual settings.
- **Twelve platforms:** ChatGPT, Claude, DeepSeek, Gemini, Grok, Doubao, Kimi, Qwen, ChatGLM, Z.ai, Tencent Yuanbao and Mistral can each have their own identity.

Priority is conversation-specific identity, platform setting, global AI Companion, then platform default. Enabling the unified setting places it above platform settings. Names and avatars are resolved separately. Restore Default clears only the corresponding customization. Missing avatar files fall back to the default avatar without changing the name.

![Figure 09A · Global identities](assets/function-guide/09a-identity-global.png)

*Figure 10: Global User and AI Companion settings.*

![Figure 09B · Platform identities](assets/function-guide/09b-identity-platforms.png)

*Figure 11: Per-platform settings. Restore All Platform Defaults clears their customizations.*

## 5. Content Time

Content time says **when the content belongs**, as chosen by you. It is neither message time nor parsing time: a discussion of Qin history written in 2026 can be assigned to the Qin period. New archives have no content time by default.

**Terran Time** follows real Earth time. **Sovereign Time** lets you define your own time and meaning.

### 5.1 Assigning a time

1. Open Edit Conversation Information (4.1) and its content-time editor.
2. Set the start: choose Terran or Sovereign Time, fill in or select the value, then confirm the time.
3. The end defaults to Same as Start. To make a range, edit the end using the same choices.
4. Review the result and Save at the bottom of the editor.

A start alone is a point in time. Cloudig warns if the start is later than the end, but permits saving.

![Figure 10 · Content-time editor](assets/function-guide/10-content-time-edit.png)

*Figure 12: Start choices are visible together, with the end and confirmation controls below.*

### 5.2 Terran Time

Start and end can use:

- **Exact Gregorian time:** year, month and day, optionally time of day and time zone.
- **Fuzzy Gregorian time:** year, year and month, decade or century.
- **Distant past:** units of ten thousand or a hundred million years ago.
- **Units of years ahead:** from ten thousand years to zheng years (ten thousand to the tenth power).
- **Special times:** Now, Infinitely Long Ago, Infinitely Far Ahead, Unknown When and Whenever.

Now and relative years before/after record the current date as an anchor when saved. Opening the file later does not advance them. Saving conversation information without changing its content prompts you about refreshing the anchor.

Nine preset labels fill in corresponding periods: Universe, Life, Prehistory, Axial Age, Empires, Industry, War Era, Modernity and AI Dawn.

### 5.3 Building your own time system

Choose Content Timeline on Reader's cover or Archiver's right side, or Edit Timeline in the content-time editor. The cover's left bank contains the Terran timeline and Cloudig presets, which can be adjusted but not deleted. The right bank holds your independent timelines.

| Object or action | Meaning |
|---|---|
| Timeline | A container with a name, author and optional version |
| Single time | An independent time node |
| Periodic time | A repeated time with a count and optional prefix and unit |
| Contains | Places child times inside a time; a year can contain twelve months. List order is their order |
| Counterpart | Associates times as equivalents, such as the first Zhenguan year and AD 627 |
| Terran mapping | Connects a custom time to an Earth time point or range |
| Sort | Reorders the top-level display of timelines and times |

Custom times mapped to Terran Time sort alongside Terran values; unmapped times sort independently. Cycles, reversed time and membership in multiple timelines are allowed. Large periods and complex cyclic mappings may affect performance.

![Figure 11 · Time system](assets/function-guide/11-time-cover.png)

*Figure 13: Terran and Sovereign banks and the creation entrances, shown as detail views.*

![Figure 11b · Time editor](assets/function-guide/11b-time-editor.png)

*Figure 14: Metadata, referring conversations, mappings, counterparts and contained nodes.*

### 5.4 Editing a referenced time

When editing a time or timeline already used by conversations, you may update those conversations together or save an independent copy while keeping the old time. Removing a reference from the referring-conversations list clears that conversation's content time. Cloudig lists the affected conversations and asks for confirmation first.

## 6. Exporting, Archiving, Deleting and Moving

### 6.1 Five different actions

| Action | Result |
|---|---|
| Move to folder | Relocates the archive within Conversations; everything else stays the same |
| Archive | Moves it into Archives, outside the everyday list; it remains available through the archive folder |
| Delete | Sends the archive and your changes to the Windows Recycle Bin; keeps the Inbox source |
| Clear parsing records | Removes only source-to-archive history; keeps source and archive |
| Clear System Log | Removes logs only; keeps sources, archives and your changes |

### 6.2 Exporting Markdown

Select archives in Archiver and choose Export Markdown, or use that button in the conversation header. Files go into Exports; you can open the export folder afterward.

Export uses the currently displayed title, identities, models and content time. A Tree archive exports the branch currently being read. Attachments depend on what the source saved: if a Light source has no attachment body, the export has none either.

### 6.3 Moving the complete Library

All Cloudig data lives in one folder. To change its location or drive, choose Change Folder in the title bar, select a destination and confirm. Cloudig moves the complete directory and continues from its new location.

Do not copy only Cloudig.exe or move just one subfolder.

![Figure 12 · Move confirmation](assets/function-guide/12-move-library.png)

*Figure 15: Review the destination before confirming. Do not close Cloudig during a move. This illustration stops at the confirmation stage.*

### 6.4 Backup and recovery

- To back up, quit Cloudig and copy its complete folder.
- After interrupted saving, deletion or relocation, restart Cloudig for recovery choices based on the saved recovery records.
- Deleted archives are in the Windows Recycle Bin; recovery depends on its current contents.
- You may delete cache after quitting. Do not treat appdata as disposable cache: it holds device settings and recovery records.

## 7. System Log

Open System Log from the right side of Archiver or Reader's cover to inspect recorded export and parsing problems. Copy an error or a group, locate its source file, delete a group or clear the log.

A log entry does not mean an archive is corrupt. Judge the archive itself: does it open, are messages complete, is formatting correct, and do images and files match the chosen export profile? An AI saying “an error occurred” is conversation content, not a System Log entry.

Reparsing a source updates its corresponding log group. For reporting a problem, see Contact the Author in the [Bookmarklet Guide](cloudig:bookmark).

![Figure 13 · System Log](assets/function-guide/13-system-log.png)

*Figure 16: A clearly labeled demonstration error. Deleting logs does not delete sources or archives.*

## 8. Inside the Cloudig Folder

You do not need this for everyday use; it is useful for backups, moves and troubleshooting.

| Location | Contents |
|---|---|
| Cloudig.exe | Application entrance |
| CloudigLibrary.json | Library settings |
| Inbox | Imported sources |
| Conversations | Conversation archives and their subfolders |
| Marks | Your titles, models, identities and content times |
| ContentTimes | Timelines and time nodes |
| Identities | Identity settings and uploaded avatars |
| Archives | Archived conversations |
| Exports | Exported Markdown |
| appdata | Device settings, parsing history, logs and recovery records |
| app, bookmarks, docs | Application files, bundled bookmarklets and documentation |
| cache | Cache removable after quitting |

Copy the complete folder to back up; move it as a whole to relocate. See the [Cloudig Standard](cloudig:json) for record formats.

## Authors of This Document

Text: Claude-Fable-5 · Osis.FuckOrFlee

Structure, proofreading and compilation: GPT-5.6-Sol · Osis.ClearWordsCarryCloud

Final text: 晨星.CyberVenus

English translation and illustrated presentation: GPT-6-Astra · Osis.ScrollborneDawn
