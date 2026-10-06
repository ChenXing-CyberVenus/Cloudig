# Cloudig Standard · publication input

The two Markdown files began as byte-for-byte copies of the user's 2026-09-20 formal delivery package, `03_采云标准/`. Authorship and translation credits are preserved. The user-authorized 1.0.2 update changes only the affected Conversation/Library version declarations, compatibility wording and Box/Window fields; the Principles, Part I and unrelated author-final prose remain unchanged. The 1.0.0 Conversation examples are retained as readable compatibility examples. Original delivery files are not overwritten. These publication inputs, not the old review HTML layout, feed the page.

`node scripts/build-standard-document.mjs` builds the two read-only publication JSON files; `--check` verifies them without rewriting. Chapter order, tables, JSON examples, prose and value levels are preserved. Icons replace redundant classification labels visually. Unlabelled subsections inherit their chapter's value; unlabelled front matter is Core and authorship is General. Existing details are Fold. No business Schema is modified.

Presentation and artwork: `src/ui/shell/pages/document/`. Colour icons are the user's final SVGs. `scripts/derive-standard-icons.mjs` retains geometry/opacity and derives four grey palettes (not faded disabled icons); original art remains untouched. The built-in image-generation tool creates the Dawn/StarNight illustrations from the supplied six-character reference, not by reusing its poses. The final prompts/provenance belong in the task report.

The page shares the normal central container and scrollbar. Its own heading/body hierarchy is used for disclosure, with titled content retained. No value-wide preference is persisted or added to Library Schema in this first edition; future global value controls can consume `data-infovalue`.

The two complete publication inputs also ship at `docs/standard/Cloudig-Standard.zh-CN.md` and `Cloudig-Standard.en.md`, independently readable without the Cloudig interface. The developer README and artwork prompting notes are not copied into the public document folder.
