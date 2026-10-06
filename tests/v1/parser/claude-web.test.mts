import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseExporterHtmlToDraft } from "../../../src/app/parser/host.mts";
import { extractHtmlRecord } from "../../../src/app/parser/record-source.mts";
import { assembleConversationRecord } from "../../../src/app/parser/conversation-record.mts";
import { frontName } from "../../../src/core/records/front.mts";
import { adapterBundleSnapshot, findSourceAdapter } from "../../../src/app/parser/registry.mts";
import { finalizeConversation } from "../../../src/core/contracts/index.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
import { ClaudeResourceData } from "../../../src/adapters/parser/claude-resource-data.mts";
import { parseFragment, serialize } from "parse5";

const waterlineFile = new URL("../../../src/adapters/parser/contracts/sample-waterline.json", import.meta.url);
const svgBytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 2 2\"><path d=\"M0 0h2v2H0z\"/></svg>", "utf8");
const svgData = `data:image/svg+xml;base64,${svgBytes.toString("base64")}`;
const fileData = `data:text/plain;base64,${Buffer.from("hello", "utf8").toString("base64")}`;

test("Claude dictionary restores only own embedded values and keeps old literals immutable", () => {
  const data = new ClaudeResourceData({ resource_data: { image: svgData, file: fileData } }, true);
  const original = Object.freeze({ data_ref: "image", key: "same-bytes-not-same-identity" });
  assert.equal(data.restore(original, { data_url: "data_ref" })["data_url"], svgData);
  assert.deepEqual(original, { data_ref: "image", key: "same-bytes-not-same-identity" });
  assert.equal(data.restore({ data_url: svgData, data_ref: "image" }, { data_url: "data_ref" })["data_url"], svgData);
  for (const ref of ["absent", "toString", "__proto__", null, 4]) assert.throws(() => data.resolve(ref), /reference/u);
  assert.throws(() => data.restore({ data_url: fileData, data_ref: "image" }, { data_url: "data_ref" }), /disagree/u);
  for (const value of [[], null, "not a dictionary"]) assert.throws(() => new ClaudeResourceData({ resource_data: value }, true), /dictionary/u);
  for (const value of ["https://example.test/image.png", "javascript:bad()", "data:image/png", 7, null]) {
    assert.throws(() => new ClaudeResourceData({ resource_data: { bad: value } }, true).resolve("bad"), /data URL/u);
  }
  const light = new ClaudeResourceData({ resource_data: "irrelevant to unchanged Light" }, false);
  assert.equal(light.restore(original, { data_url: "data_ref" }), original);
});

test("Claude reading references restore img/a attributes, not code, scripts or arbitrary elements", () => {
  const data = new ClaudeResourceData({ resource_data: { image: svgData, file: fileData } }, true);
  const fragment = parseFragment('<p><img data-osis-data-src="image" alt="original"><a download="note.txt" data-osis-data-href="file">download</a><a data-osis-data-href="ordinary-link">link</a></p><pre><code><img data-osis-data-src="unresolved-code-example"></code></pre><script>throw new Error("not executable")</script><div data-osis-data-src="ignore"></div>');
  data.restoreReading(fragment);
  const rendered = serialize(fragment);
  assert.ok(rendered.includes(`src="${svgData}"`));
  assert.ok(rendered.includes(`href="${fileData}"`));
  assert.ok(rendered.includes('data-osis-data-src="unresolved-code-example"'));
  assert.ok(rendered.includes('data-osis-data-src="ignore"'));
  assert.ok(rendered.includes('data-osis-data-href="ordinary-link"'));
  assert.ok(rendered.includes('throw new Error("not executable")'));
  assert.throws(() => data.restoreReading(parseFragment('<img data-osis-data-src="missing">')), /reference/u);
  assert.throws(() => data.restoreReading(parseFragment(`<img src="${fileData}" data-osis-data-src="image">`)), /disagree/u);
});

test("Claude Full/Tree dictionary transport yields the same messages and embedded bytes as legacy HTML", async () => {
  for (const profile of ["full", "all-branches"] as const) {
    const scope = await disposable();
    try {
      const format = `osis.claude.chat-export/${profile === "full" ? "full-capture" : "all-branches"}-v1`;
      const payload = fixturePayload(format), messages = payload["messages"] as JsonObject[];
      const resources = payload["resources"] as JsonObject[];
      resources[0]!["data_url"] = svgData; resources[1]!["data_url"] = svgData;
      resources.push({ ...resources[0]!, key: "user-image", job_key: "user-image", message_id: "user-1", dom_resource_key: "user-image" });
      messages[0]!["blocks"] = [{ type: "text", rich_html: `<p>User<br>second line<img src="${svgData}" data-resource-key="user-image"></p>` }];
      messages[0]!["media"] = [{ resource_key: "user-image", job_key: "user-image", message_id: "user-1", kind: "image", inline: true }];
      messages[1]!["blocks"] = [{ type: "text", rich_html: `<p>Before</p><table><tr><td><img src="${svgData}" data-resource-key="image-1"></td></tr></table><p>After <a download="note.txt" href="${fileData}">file</a></p>` }];
      const artifact = (payload["artifacts"] as JsonObject[])[0]!;
      artifact["file_data_url"] = fileData; artifact["svg_data_url"] = svgData;
      if (profile === "all-branches") {
        messages.push({ id: "assistant-sibling", parent_id: "user-1", index: 2, role: "assistant", blocks: [{ type: "text", markdown: "Other branch" }], attachments: [], media: [] });
        payload["tree_topology"] = { root_ids: ["user-1"], orphan_root_ids: [], children_by_id: { "user-1": ["assistant-1", "assistant-sibling"] }, message_order: ["user-1", "assistant-1", "assistant-sibling"], current_path_message_ids: ["user-1", "assistant-1"] };
      }
      await writeFile(scope.file, html(manifest(profile, format), payload, '<script>throw new Error("must never execute")</script>'));
      const legacy = await parseExporterHtmlToDraft({ filePath: scope.file });
      const compact = structuredClone(payload);
      compact["resource_data"] = { d1: svgData, d2: fileData };
      for (const r of compact["resources"] as JsonObject[]) if (r["data_url"]) { delete r["data_url"]; r["data_ref"] = "d1"; }
      const a = (compact["artifacts"] as JsonObject[])[0]!;
      delete a["file_data_url"]; a["file_data_ref"] = "d2";
      delete a["svg_data_url"]; a["svg_data_ref"] = "d1";
      for (const m of compact["messages"] as JsonObject[]) for (const b of m["blocks"] as JsonObject[]) if (typeof b["rich_html"] === "string") {
        b["rich_html"] = b["rich_html"].replaceAll(`src="${svgData}"`, 'data-osis-data-src="d1"').replaceAll(`href="${fileData}"`, 'data-osis-data-href="d2"');
      }
      await writeFile(scope.file, html(manifest(profile, format), compact, '<script>throw new Error("must never execute")</script>'));
      // Force the streaming JSON path as well as the normal in-memory route.
      for (const threshold of [undefined, 64]) {
        const candidate = await parseExporterHtmlToDraft({ filePath: scope.file, temporaryRoot: scope.base, ...(threshold ? { jsonScriptMemoryThresholdBytes: threshold } : {}) });
        const actual = structuredClone(candidate.draft), expected = structuredClone(legacy.draft);
        for (const value of [actual, expected]) { delete (value["source"] as JsonObject)["sha256"]; delete (value["source"] as JsonObject)["bytes"]; }
        assert.deepEqual(actual, expected);
        assert.deepEqual(candidate.systemLogErrors, legacy.systemLogErrors);
        assert.ok((actual["resources"] as JsonObject[]).filter(r => r["data_base64"]).length >= 2, "media and file bytes must survive");
      }
      const extracted = await extractHtmlRecord({ filePath: scope.file, temporaryRoot: scope.base });
      assert.doesNotThrow(() => assembleConversationRecord({ ...extracted, parserVersion: "1.1.12", timestamp: "2026-09-24T00:00:00Z" }));
      (compact["resources"] as JsonObject[])[0]!["data_ref"] = "absent";
      await writeFile(scope.file, html(manifest(profile, format), compact, ""));
      await assert.rejects(parseExporterHtmlToDraft({ filePath: scope.file }), /embedded resource reference/u);
    } finally { await rm(scope.base, { recursive: true, force: true }); }
  }
});

function html(manifest: JsonObject, payload: JsonObject, body: string): string {
  const json = (value: JsonObject): string => JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<!doctype html><meta charset="utf-8"><script id="ai-chat-archive-manifest" type="application/json">${json(manifest)}</script><script id="claude-export-data" type="application/json">${json(payload)}</script>${body}`;
}

function manifest(profile: "light" | "full" | "all-branches", format: string): JsonObject {
  return {
    format: "ai-chat-archive/manifest-v1",
    platform: "claude",
    exporter: { name: "Fixture Claude exporter", version: `1.1.30-${profile}`, mode: profile },
    exported_at: "2026-08-31T20:00:00.000Z",
    source: {
      url: "https://claude.ai/chat/example",
      title: "Claude fixture",
      conversation_id: "example",
      model: "claude-test"
    },
    capture_diagnostics: {
      format: "ai-chat-archive/capture-diagnostics-v1",
      entries: [{ code: "fixture-error", message: "must-not-enter-conversation", severity: "warning" }]
    },
    payload: { element_id: "claude-export-data", format }
  };
}

function fixturePayload(format = "osis.claude.chat-export/light-dom-v1"): JsonObject {
  return {
    format,
    version: "1.1.30-light",
    exported_at: "2026-08-31T20:00:00.000Z",
    source_url: "https://claude.ai/chat/example",
    conversation: {
      id: "example",
      title: "Claude fixture",
      model: "claude-test",
      entry_surface: "chat",
      created_at: "2026-08-31T19:00:00.000Z",
      updated_at: "2026-08-31T19:02:00.000Z"
    },
    current_leaf_message_id: "assistant-1",
    active_message_ids: ["user-1", "assistant-1"],
    messages: [
      {
        id: "user-1",
        parent_id: "00000000-0000-4000-8000-000000000000",
        index: 0,
        role: "user",
        model: null,
        created_at: "2026-08-31T19:00:00.000Z",
        blocks: [{ type: "text", markdown: "Question", citations: [] }],
        attachments: [],
        media: []
      },
      {
        id: "assistant-1",
        parent_id: "user-1",
        index: 1,
        role: "assistant",
        model: null,
        created_at: "2026-08-31T19:01:00.000Z",
        public_activity_summary: "Plan",
        blocks: [
          { type: "thinking", summaries: ["Plan"], body: "", seconds: 2, visibility: "public_summary", truncated: false, cut_off: false },
          { type: "tool_use", id: "web-1", name: "web_search", input: { query: "Cloudig" }, message: "Searching" },
          {
            type: "tool_result",
            tool_use_id: "web-1",
            name: "web_search",
            is_error: false,
            sources: [{ title: "Cloudig source", url: "https://example.com/source" }],
            content: [{ type: "knowledge", title: "Cloudig source", url: "https://example.com/source" }]
          },
          {
            type: "text",
            markdown: "Answer\n\n```mermaid\ngraph TD\nA-->B\n```",
            citations: [{ title: "Cloudig source", url: "https://example.com/source" }]
          },
          { type: "tool_use", id: "artifact-1", name: "create_file", input: { name: "note.txt" }, message: "Creating" },
          { type: "tool_result", tool_use_id: "artifact-1", name: "create_file", is_error: false, content: [] },
          { type: "tool_use", id: "error-1", name: "broken_tool", input: null, message: "Calling" },
          { type: "tool_result", tool_use_id: "error-1", name: "broken_tool", is_error: true, message: "Source tool failed: connection refused" }
        ],
        attachments: [],
        media: [
          {
            resource_key: "image-1",
            job_key: "image-1",
            message_id: "assistant-1",
            kind: "image-search",
            name: "Search image",
            before_text_index: 0,
            inline: false
          },
          {
            resource_key: "diagram-1",
            job_key: "diagram-1",
            message_id: "assistant-1",
            kind: "diagram-svg",
            name: "Static diagram",
            before_text_index: null,
            inline: true
          },
          {
            resource_key: "icon-1",
            job_key: "icon-1",
            message_id: "assistant-1",
            kind: "source-icon",
            name: "favicon",
            before_text_index: null,
            inline: false
          }
        ]
      }
    ],
    resources: [
      {
        key: "image-1",
        job_key: "image-1",
        message_id: "assistant-1",
        kind: "image-search",
        name: "Search image",
        status: "embedded-svg",
        source_url: "https://example.com/image",
        mime_type: "image/svg+xml",
        source_bytes: svgBytes.byteLength,
        thumbnail_bytes: svgBytes.byteLength,
        width: 2,
        height: 2,
        display_eligible: true,
        dom_resource_key: "image-1"
      },
      {
        key: "diagram-1",
        job_key: "diagram-1",
        message_id: "assistant-1",
        kind: "diagram-svg",
        name: "Static diagram",
        status: "embedded-svg",
        mime_type: "image/svg+xml",
        source_bytes: svgBytes.byteLength,
        thumbnail_bytes: svgBytes.byteLength,
        display_eligible: true,
        dom_resource_key: "diagram-1"
      },
      {
        key: "icon-1",
        job_key: "icon-1",
        message_id: "assistant-1",
        kind: "source-icon",
        name: "favicon",
        status: "unavailable",
        source_url: "https://example.com/source",
        error: "must-not-enter-conversation",
        display_eligible: false
      }
    ],
    artifacts: [{
      id: "artifact-1",
      message_id: "assistant-1",
      name: "note.txt",
      extension: "txt",
      language: "text",
      source: "hello",
      mime_type: "text/plain",
      preview_kind: "static-source-card",
      size_bytes: 5
    }],
    raw_tree_count: 2
  };
}

function fullConversation(parsed: Awaited<ReturnType<typeof parseExporterHtmlToDraft>>): JsonObject {
  return finalizeConversation({
    schema: "cloudig/conversation/1.0.0",
    archive: "a1",
    generation: 1,
    content_sha256: "0".repeat(64),
    parser: { version: "1.0.0", adapter: { id: parsed.adapter.id, version: parsed.adapter.version } },
    lifecycle: {
      first_parsed_at: { basis: "parser", value: "2026-08-31T21:00:00.000Z" },
      last_parsed_at: "2026-08-31T21:00:00.000Z",
      cloudig_edited_at: "2026-08-31T21:00:00.000Z"
    },
    ...parsed.draft
  });
}

async function disposable(): Promise<{ base: string; file: string }> {
  const root = path.join(process.cwd(), "tmp");
  await mkdir(root, { recursive: true });
  const base = await mkdtemp(path.join(root, "cloudig-claude-web-"));
  return { base, file: path.join(base, "claude.html") };
}

test("map photos bind exact same-call URLs and place IDs without inventing unfetched photos", async () => {
  for (const profile of ["light", "full", "all-branches"] as const) {
    const scope = await disposable();
    try {
      const format = `osis.claude.chat-export/${profile === "light" ? "light-dom" : profile === "full" ? "full-capture" : "all-branches"}-v1`, payload = fixturePayload(format);
      payload["artifacts"] = [];
      const message = (payload["messages"] as JsonObject[])[1]!;
      const sourceResult = JSON.stringify({ enriched_places: {
        b: { photos: [{ url: "https://photos.test/b.svg", attributions: [{ display_name: "Photographer B" }] }] },
        a: { photos: [{ url: "https://photos.test/a.svg" }, { url: "https://photos.test/missing.svg" }, { url: "https://photos.test/foreign.svg" }] }
      } });
      message["blocks"] = [
        { type: "tool_use", id: "map", name: "places_map_display_v0", input: { locations: [{ place_id: "a", name: "A" }, { place_id: "b", name: "B" }] }, native_card: { kind: "places_map", tool_use_id: "map", html: "<p>No inline map images</p>" } },
        { type: "tool_result", tool_use_id: "map", content: [{ type: "text", text: sourceResult }] }
      ];
      message["media"] = [
        { resource_key: "a", kind: "image-search", tool_use_id: "map" },
        { resource_key: "b", kind: "image-search", tool_use_id: "map" },
        { resource_key: "foreign", kind: "image-search", tool_use_id: "other-map" }
      ];
      payload["resources"] = ["a", "b", "foreign"].map(key => ({ key, message_id: "assistant-1", name: key,
        source_url: `https://maps.test/${key}`, candidate: { url: `https://photos.test/${key}.svg` },
        ...(profile === "light" ? { data_url: svgData } : { data_ref: "photo" }) }));
      if (profile !== "light") payload["resource_data"] = { photo: svgData };
      await writeFile(scope.file, html(manifest(profile, format), payload, ""));
      const extracted = await extractHtmlRecord({ filePath: scope.file, temporaryRoot: scope.base });
      const record = assembleConversationRecord({ ...extracted, parserVersion: adapterBundleSnapshot().parser, timestamp: "2026-09-25T00:00:00Z" });
      const blocks = ((record["messages"] as JsonObject)["items"] as JsonObject[])[1]!["content"] as JsonObject[];
      const view = blocks.find(block => block["type"] === "interactive")!, data = view["data"] as JsonObject;
      assert.deepEqual((data["images"] as JsonObject[]).map(image => [image["source_id"], image["source_url"]]), [["b", "https://photos.test/b.svg"], ["a", "https://photos.test/a.svg"]]);
      assert.equal((data["result"] as JsonObject[])[0]!["text"], sourceResult, "ratings, attribution and uncaptured photo metadata remain intact");
      const files = view["files"] as JsonObject[]; assert.equal(files.length, 2);
      for (const file of files) {
        const resource = (record["resources"] as JsonObject[]).find(resource => resource["id"] === file["resource"])!;
        assert.equal(resource["availability"], "embedded");
        assert.equal(Buffer.from((resource["data_base64"] as string[]).join(""), "base64").toString(), svgBytes.toString());
        assert(!blocks.some(block => block["type"] === "image" && block["resource"] === resource["id"]), "no duplicate image at the message tail");
      }
    } finally { await rm(scope.base, { recursive: true, force: true }); }
  }
});

test("Light map photos use unique place-page evidence without claiming an unrecorded photo URL", async () => {
  for (const ambiguous of [false, true]) {
    const scope = await disposable();
    try {
      const payload = fixturePayload(), message = (payload["messages"] as JsonObject[])[1]!;
      payload["artifacts"] = [];
      message["blocks"] = [
        { type: "tool_use", id: "map", name: "places_map_display_v0", input: { locations: [{ place_id: "a", name: "A" }] }, native_card: { kind: "places_map", tool_use_id: "map" } },
        { type: "tool_result", tool_use_id: "map", content: [{ type: "text", text: JSON.stringify({ enriched_places: {
          a: { maps_url: "https://maps.test/a", photos: [{ url: "https://photos.test/not-recorded.svg" }] },
          ...(ambiguous ? { b: { maps_url: "https://maps.test/a" } } : {})
        } }) }] }
      ];
      message["media"] = [{ resource_key: "photo", kind: "image-search", tool_use_id: "map" }];
      payload["resources"] = [{ key: "photo", message_id: "assistant-1", name: "A", source_url: "https://maps.test/a", status: "embedded-webp", dom_resource_key: "photo" }];
      await writeFile(scope.file, html(manifest("light", String(payload["format"])), payload, `<article data-message-id="assistant-1"><img data-resource-key="photo" src="${svgData}"></article>`));
      const extracted = await extractHtmlRecord({ filePath: scope.file, temporaryRoot: scope.base });
      const record = assembleConversationRecord({ ...extracted, parserVersion: adapterBundleSnapshot().parser, timestamp: "2026-09-25T00:00:00Z" });
      const blocks = ((record["messages"] as JsonObject)["items"] as JsonObject[])[1]!["content"] as JsonObject[];
      const view = blocks.find(block => block["type"] === "interactive")!, images = (view["data"] as JsonObject)["images"] as JsonObject[] | undefined;
      if (ambiguous) { assert.equal(images, undefined); assert.equal(view["files"], undefined); }
      else {
        assert.equal(images!.length, 1); assert.equal(images![0]!["source_id"], "a"); assert.equal(images![0]!["source_url"], undefined);
        const id = (view["files"] as JsonObject[])[0]!["resource"];
        const resource = (record["resources"] as JsonObject[]).find(resource => resource["id"] === id)!;
        assert.equal(resource["availability"], "embedded"); assert.equal((resource["data_base64"] as string[]).join(""), svgBytes.toString("base64"));
      }
    } finally { await rm(scope.base, { recursive: true, force: true }); }
  }
});

test("native gallery bytes bind by the paired call and original image URL, not exporter card markup or another call", async () => {
  const scope = await disposable();
  try {
    const format = "osis.claude.chat-export/full-capture-v1", payload = fixturePayload(format);
    payload["artifacts"] = [];
    const messages = payload["messages"] as JsonObject[], message = messages[1]!;
    const imageUrl = "https://example.org/picture.svg", pageUrl = "https://example.org/product", foreignUrl = "https://example.org/foreign.svg";
    message["blocks"] = [
      { type: "tool_use", id: "card-1", name: "featured_card_display_v0", input: { products: [{ name: "Product" }] }, native_card: { kind: "featured_card", tool_use_id: "card-1", html: "<p>No images in exporter preview</p>" } },
      { type: "tool_result", tool_use_id: "card-1", content: [{ type: "image_gallery", images: [
        { id: "product_0_0", url: imageUrl, thumbnail_url: imageUrl, page_url: pageUrl, title: "Owned image" },
        { id: "product_0_1", url: foreignUrl, thumbnail_url: foreignUrl, page_url: "https://example.org/else", title: "Not this call" }
      ] }] }
    ];
    message["media"] = [{ resource_key: "own", kind: "image-search", tool_use_id: "card-1" }, { resource_key: "foreign", kind: "image-search", tool_use_id: "another-call" }];
    payload["resources"] = [
      { key: "own", message_id: "assistant-1", data_url: svgData, source_url: pageUrl, candidate: { url: imageUrl }, name: "Owned image" },
      { key: "foreign", message_id: "assistant-1", data_url: svgData, source_url: "https://example.org/else", candidate: { url: foreignUrl }, name: "Foreign" }
    ];
    await writeFile(scope.file, html(manifest("full", format), payload, ""));
    const extracted = await extractHtmlRecord({ filePath: scope.file, temporaryRoot: scope.base });
    const record = assembleConversationRecord({ ...extracted, parserVersion: "1.1.14", timestamp: "2026-09-24T00:00:00Z" });
    const blocks = (((record["messages"] as JsonObject)["items"] as JsonObject[])[1]!["content"] as JsonObject[]);
    const view = blocks.find(b => b["type"] === "interactive")!; assert(view);
    const files = view["files"] as JsonObject[], images = (view["data"] as JsonObject)["images"] as JsonObject[];
    assert.deepEqual(images.map(i => i["source_id"]), ["product_0_0", "product_0_1"]);
    const resources = record["resources"] as JsonObject[];
    assert.equal(resources.find(r => r["id"] === files[0]!["resource"])!["availability"], "embedded");
    assert.equal(resources.find(r => r["id"] === files[1]!["resource"])!["availability"], "external");
    assert(!blocks.some(b => b["type"] === "image" && b["resource"] === files[0]!["resource"]), "the card-owned image must not repeat at the message tail");
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Claude current selector never becomes historical Front or model summary; only per-message API evidence does", async () => {
  for (const profile of ["light", "full", "all-branches"] as const) {
    const scope = await disposable();
    try {
      const format = `osis.claude.chat-export/${profile === "light" ? "light-dom" : profile === "full" ? "full-capture" : "all-branches"}-v1`;
      const payload = fixturePayload(format), original = payload["messages"] as JsonObject[];
      const declarations: JsonObject[] = [
        {},
        { model: "claude-sonnet-evidence", model_scope: "message", model_provenance: "conversation_api.message.model" },
        { model: "claude-current-only", model_scope: "conversation", model_provenance: "conversation_api.model" },
        { model: "claude-unscoped" }
      ];
      const messages = [original[0]!, ...declarations.map((declaration, i) => ({ ...original[1]!, ...declaration,
        id: `reply-${i}`, parent_id: i ? `reply-${i - 1}` : "user-1", index: i + 1,
        blocks: [{ type: "text", markdown: `Answer ${i}` }], media: [] }))];
      payload["messages"] = messages;
      payload["active_message_ids"] = messages.map(m => m["id"]!);
      payload["current_leaf_message_id"] = "reply-3";
      payload["resources"] = []; payload["artifacts"] = [];
      await writeFile(scope.file, html(manifest(profile, format), payload, ""));
      const extracted = await extractHtmlRecord({ filePath: scope.file, temporaryRoot: scope.base });
      assert.equal(extracted.facts.conversationModel, undefined);
      const conversation = assembleConversationRecord({ ...extracted, parserVersion: "1.1.3", timestamp: "2026-09-15T00:00:00Z" });
      const fronts = new Map((conversation["identity"] as JsonObject[]).map(f => [f["source_id"], f]));
      const items = (conversation["messages"] as JsonObject)["items"] as JsonObject[];
      assert.deepEqual(items.slice(1).map(m => frontName(fronts.get(m["speaker"]))), ["Claude", "claude-sonnet-evidence", "Claude", "Claude"]);
      assert.deepEqual(conversation["models"], ["claude-sonnet-evidence"]);
      assert.doesNotMatch(JSON.stringify(conversation["identity"]), /claude-test|claude-current-only|claude-unscoped/u);
    } finally { await rm(scope.base, { recursive: true, force: true }); }
  }
});

test("Cowork code headers use only matching mounted-message and exact code evidence", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload("osis.claude.chat-export/full-capture-v1");
    (payload["conversation"] as JsonObject)["entry_surface"] = "cowork";
    const message = (payload["messages"] as JsonObject[])[1]!;
    message["media"] = [];
    message["blocks"] = [{ type: "text", rich_html: '<pre><code>print("hello")</code></pre><pre><code>unknown()</code></pre>' }];
    payload["resources"] = []; payload["artifacts"] = [];
    payload["mounted_dom_articles"] = [{ aria_posinset: 2, role: "assistant", created_at: message["created_at"]!, outer_html: '<pre><code class="language-python">print("hello")</code></pre><pre><code class="language-ruby">different()</code></pre>' }];
    await writeFile(scope.file, html(manifest("full", String(payload["format"])), payload, ""));
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const content = ((parsed.draft["messages"] as JsonObject[])[1]!["content"] as JsonObject[]).map(b => String(b["html"] ?? "")).join("");
    assert.match(content, /<pre data-language="python"><code>print\("hello"\)/u);
    assert.match(content, /<pre><code>unknown\(\)/u);
    ((payload["mounted_dom_articles"] as JsonObject[])[0]!)["aria_posinset"] = 1;
    await writeFile(scope.file, html(manifest("full", String(payload["format"])), payload, ""));
    const mismatch = await parseExporterHtmlToDraft({ filePath: scope.file });
    assert.doesNotMatch(JSON.stringify(mismatch.draft), /data-language=\\"python/u);
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Claude published artifacts use explicit text anchors rather than their creation tool position", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload("osis.claude.chat-export/full-capture-v1");
    const message = (payload["messages"] as JsonObject[])[1]!;
    message["public_activity_summary"] = null; message["media"] = []; payload["resources"] = [];
    message["blocks"] = [
      { type: "tool_use", id: "artifact-1", name: "create_file", input: { name: "note.txt" } },
      { type: "tool_result", tool_use_id: "artifact-1", name: "create_file", content: [] },
      { type: "text", markdown: "Before delivery" },
      { type: "text", markdown: "Final answer" }
    ];
    (payload["artifacts"] as JsonObject[])[0]!["dom_placement"] = { before_text_index: 2, dom_order: 1 };
    await writeFile(scope.file, html(manifest("full", String(payload["format"])), payload, ""));
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const content = (parsed.draft["messages"] as JsonObject[])[1]!["content"] as JsonObject[];
    assert.deepEqual(content.map(b => b["type"]), ["tool", "tool", "markdown", "markdown", "code", "attachment"]);
    assert.equal(content[3]!["text"], "Final answer");
    assert.equal(content.filter(b => b["type"] === "attachment").length, 1);
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Cowork activity and published-file placeholders preserve reading order and keep working files folded", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload("osis.claude.chat-export/full-capture-v1");
    (payload["conversation"] as JsonObject)["entry_surface"] = "cowork";
    const message = (payload["messages"] as JsonObject[])[1]!;
    message["public_activity_summary"] = "First activity"; message["media"] = []; payload["resources"] = [];
    message["blocks"] = [
      { type: "thinking", summaries: ["First activity"], visibility: "public_summary", cowork_disclosure_key: "one" },
      { type: "thinking", summaries: ["Second activity"], visibility: "public_summary", cowork_disclosure_key: "two" },
      { type: "text", rich_html: '<section><div></div><p>Before</p><span data-osis-cowork-activity-key="one"></span><span data-osis-artifact-id="artifact-1"></span><p>Between</p><span data-osis-cowork-activity-key="two"></span><p>After</p></section><div></div>' }
    ];
    message["cowork_page_tools"] = [
      { type: "tool_use", id: "work", name: "Write", input: { file_path: "/work/working.txt", content: "working source" }, _osis_cowork_page_state_tool: true },
      { type: "tool_result", tool_use_id: "work", name: "Write", content: [{ type: "text", text: "Created" }], _osis_cowork_page_state_tool: true }
    ];
    (payload["artifacts"] as JsonObject[]).push({ id: "working", message_id: "assistant-1", name: "working.txt", path: "/work/working.txt", source: "working source", extension: "txt", language: "text" });
    await writeFile(scope.file, html(manifest("full", String(payload["format"])), payload, ""));
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const content = (parsed.draft["messages"] as JsonObject[])[1]!["content"] as JsonObject[];
    assert.deepEqual(content.map(b => b["type"]), ["html", "reasoning_summary", "tool", "tool", "code", "attachment", "html", "reasoning_summary", "html", "tool"]);
    assert.equal(content[1]!["text"], "First activity"); assert.equal(content[7]!["text"], "Second activity");
    assert.match(String(content[6]!["html"]), /Between/u); assert.match(String(content[8]!["html"]), /After/u);
    assert.equal(content.at(-1)!["kind"], "activity");
    assert.equal(content.at(-1)!["output"], "working source");
    assert.equal(typeof content.at(-1)!["output_resource"], "string");
    const extracted = await extractHtmlRecord({ filePath: scope.file, temporaryRoot: scope.base });
    assert.doesNotThrow(() => assembleConversationRecord({ ...extracted, parserVersion: "1.1.3", timestamp: "2026-09-15T00:00:00Z" }));
    assert.doesNotMatch(JSON.stringify(content), /data-osis-(?:artifact-id|cowork-activity-key)/u);
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("current sample waterline counts agree and every declared route has a registered Adapter", async () => {
  const waterline = JSON.parse(await readFile(waterlineFile, "utf8")) as JsonObject;
  assert.match(String(waterline["batch"]), /^\d{4}-\d{2}-\d{2}$/u);
  const summary = waterline["summary"] as JsonObject;
  const cases = waterline["cases"] as JsonObject[];
  const routes = waterline["routes"] as JsonObject[];
  assert.equal(cases.length, summary["cases"]);
  assert.equal(new Set(cases.map((entry) => entry["platform"])).size, summary["platforms"]);
  assert.equal(routes.reduce((sum, entry) => sum + Number(entry["samples"]), 0), summary["files"]);
  assert.equal(cases.reduce((sum, entry) => sum + (entry["profiles"] as string[]).length, 0), summary["files"]);
  for (const route of routes) {
    assert.ok(findSourceAdapter({
      format: "exporter-html",
      platform: String(route["platform"]),
      payload: String(route["payload"])
    }));
  }
  assert.equal(adapterBundleSnapshot().adapters.filter((entry) => entry.family === "claude").length, 3);
});

test("Claude uploaded files keep acquired bytes while Light remains honest metadata-only", async () => {
  const bytes = Buffer.from("%PDF-1.4\nfixture upload\n%%EOF");
  for (const profile of ["light", "full", "all-branches"] as const) {
    const scope = await disposable();
    try {
      const format = `osis.claude.chat-export/${profile === "light" ? "light-dom" : profile === "full" ? "full-capture" : "all-branches"}-v1`;
      const payload = fixturePayload(format);
      (payload["messages"] as JsonObject[])[0]!["attachments"] = [{ id: "upload-1", kind: "file", name: "TEST1.pdf", mime_type: "application/pdf", embedded_resources: profile === "light" ? [] : [{ key: "upload-pdf" }] }];
      if (profile !== "light") (payload["resources"] as JsonObject[]).push({ key: "upload-pdf", message_id: "user-1", kind: "attachment-file", name: "TEST1.pdf", data_url: `data:application/pdf;base64,${bytes.toString("base64")}`, display_eligible: true });
      await writeFile(scope.file, html(manifest(profile, format), payload, "<main></main>"));
      const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
      const conversation = fullConversation(parsed);
      const resources = conversation["resources"] as JsonObject[];
      const file = resources.find(resource => resource["name"] === "TEST1.pdf")!;
      assert.ok(file);
      assert.equal(file["availability"], profile === "light" ? "metadata_only" : "embedded");
      if (profile !== "light") assert.deepEqual(Buffer.concat((file["data_base64"] as string[]).map(value => Buffer.from(value, "base64"))), bytes);
      const user = (conversation["messages"] as JsonObject[])[0]!;
      assert.ok((user["content"] as JsonObject[]).some(block => block["type"] === "attachment" && block["resource"] === file["id"]));
    } finally { await rm(scope.base, { recursive: true, force: true }); }
  }
});

test("Claude Light retains source tool failures while keeping exporter diagnostics out of the conversation", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload();
    const body = `<article data-message-id="user-1"><p>Question</p></article><article data-message-id="assistant-1"><img data-resource-key="image-1" src="${svgData}" alt="Search image"><img data-resource-key="diagram-1" src="${svgData}" alt="Static diagram"><a href="${fileData}" download="note.txt">note.txt</a></article>`;
    await writeFile(scope.file, html(manifest("light", String(payload["format"])), payload, body), "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const conversation = fullConversation(parsed);
    assert.equal(parsed.adapter.id, "claude-light-dom-v1");
    assert.equal((conversation["messages"] as JsonObject[]).length, 2);
    assert.ok((conversation["messages"] as JsonObject[]).every((message) => message["id"] === undefined && message["parent"] === undefined));
    assert.equal(conversation["current_message"], undefined);
    assert.equal(conversation["models"], undefined);
    assert.equal((conversation["resources"] as JsonObject[]).length, 3);
    assert.equal((conversation["sources"] as JsonObject[]).length, 1);
    const content = (conversation["messages"] as JsonObject[])[1]!["content"] as JsonObject[];
    assert.deepEqual(content.map((entry) => `${entry["type"]}${entry["kind"] ? `:${entry["kind"]}` : ""}`), [
      "reasoning_summary",
      "tool:call",
      "tool:result",
      "search",
      "image",
      "markdown",
      "diagram",
      "citations",
      "tool:call",
      "tool:result",
      "code",
      "attachment",
      "tool:call",
      "tool:result"
    ]);
    assert.doesNotMatch(JSON.stringify(conversation), /must-not-enter-conversation|fixture-error|favicon/u);
    assert.equal(content.at(-1)?.["success"], false);
    assert.match(String(content.at(-1)?.["output"]), /connection refused/u);
  } finally {
    await rm(scope.base, { recursive: true, force: true });
  }
});

test("Claude Light recovers exact saved reading panels instead of parsing lossy DOM text as Markdown", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "tmp", "claude-rich-reading-"));
  try {
    const payload = fixturePayload();
    payload["messages"] = [{ id: "owned", role: "assistant", index: 0, blocks: [{ type: "text", markdown: "Title\nThird\nFormula x", reading_surface_visible: true }] }];
    payload["active_message_ids"] = ["owned"];
    const file = path.join(directory, "reading.html");
    await writeFile(file, html(manifest("light", String(payload["format"])), payload, '<article data-message-id="unrelated"><div class="markdown"><h1>Do not copy me</h1></div></article><article data-message-id="owned"><div class="markdown"><h2>Title</h2><ol start="3"><li>Third</li></ol><p>Formula <math><mi>x</mi></math></p></div></article>'));
    const parsed = await parseExporterHtmlToDraft({ filePath: file });
    const content = ((parsed.draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[]);
    assert.match(String(content[0]!["html"]), /<h2>Title<\/h2><ol start="3"><li>Third<\/li><\/ol>/u);
    assert.doesNotMatch(JSON.stringify(content), /Do not copy me/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Claude Light reads user paragraphs inside their own bubble, never its timestamp or another message", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload();
    payload["messages"] = [{ id: "owned", role: "user", index: 0, blocks: [{ type: "text", markdown: "FirstSecondThird", reading_surface_visible: true }] }];
    payload["active_message_ids"] = ["owned"]; payload["resources"] = []; payload["artifacts"] = [];
    const body = '<article data-message-id="unrelated"><div class="user-bubble"><div class="markdown"><p>WRONG OWNER</p></div></div></article>'
      + '<article data-message-id="owned"><div class="user-bubble"><div class="markdown"><section class="cowork-timeline"><p>First<br>Second</p><p>Third</p></section></div></div><time>NOT BODY</time></article>';
    await writeFile(scope.file, html(manifest("light", String(payload["format"])), payload, body));
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const content = (parsed.draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[];
    assert.equal(content[0]!["type"], "html");
    assert.match(String(content[0]!["html"]), /<p>First<br>Second<\/p><p>Third<\/p>/u);
    assert.doesNotMatch(JSON.stringify(content), /WRONG OWNER|NOT BODY/u);
    (payload["messages"] as JsonObject[])[0]!["blocks"] = [{ type: "text", markdown: "One" }, { type: "text", markdown: "Two" }];
    await writeFile(scope.file, html(manifest("light", String(payload["format"])), payload, body));
    const mismatch = await parseExporterHtmlToDraft({ filePath: scope.file });
    assert.deepEqual(((mismatch.draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[]).map(block => block["text"]), ["One", "Two"], "Ambiguous panel counts must not overwrite payload blocks");
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Claude Light Mermaid cards recover original SVG bytes by exact resource and message, retaining their colors", async () => {
  const scope = await disposable();
  const colored = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#CC785C" stroke="#F0F0EB" width="20" height="10"/></svg>');
  try {
    const payload = fixturePayload();
    const message = (payload["messages"] as JsonObject[])[1]!;
    message["blocks"] = [{ type: "text", markdown: "```mermaid\ngraph TD\nA-->B\n```" }];
    message["media"] = (message["media"] as JsonObject[]).filter(item => item["resource_key"] === "diagram-1");
    payload["resources"] = (payload["resources"] as JsonObject[]).filter(item => item["key"] === "diagram-1"); payload["artifacts"] = [];
    const card = `<section class="osis-mermaid-card"><figure><img data-resource-key="diagram-1" src="data:image/svg+xml;base64,${colored.toString("base64")}"></figure><pre><code>graph TD\nA--&gt;B</code></pre></section>`;
    for (const owner of ["assistant-1", "wrong-owner"]) {
      await writeFile(scope.file, html(manifest("light", String(payload["format"])), payload, `<article data-message-id="${owner}">${card}</article>`));
      const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
      const resource = (parsed.draft["resources"] as JsonObject[]).find(item => item["kind"] === "diagram")!;
      assert.equal(resource["availability"], owner === "assistant-1" ? "embedded" : "metadata_only");
      if (owner === "assistant-1") {
        assert.deepEqual(Buffer.concat((resource["data_base64"] as string[]).map(value => Buffer.from(value, "base64"))), colored);
        const diagram = ((parsed.draft["messages"] as JsonObject[])[1]!["content"] as JsonObject[]).find(block => block["type"] === "diagram")!;
        assert.equal(diagram["rendered"], resource["id"]);
        assert.equal(diagram["source"], "graph TD\nA-->B");
      }
    }
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Claude captured process opening is not Reader default state, while authored disclosure remains open", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload();
    payload['messages'] = [{ id: 'owned', role: 'assistant', index: 0, blocks: [{ type: 'text', markdown: 'Flattened' }] }];
    payload['active_message_ids'] = ['owned']; payload['resources'] = []; payload['artifacts'] = [];
    const body = '<article data-message-id="owned"><div class="markdown"><details class="thinking activity" open><summary>Public process</summary><p>First<br>Second</p></details><details open><summary>Authored section</summary><p>Body</p></details></div></article>';
    await writeFile(scope.file, html(manifest('light', String(payload['format'])), payload, body));
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const rich = String(((parsed.draft['messages'] as JsonObject[])[0]!['content'] as JsonObject[])[0]!['html']);
    assert.match(rich, /<details class="thinking activity"><summary>Public process<\/summary><p>First<br>Second<\/p>/u);
    assert.match(rich, /<details open(?:="")?><summary>Authored section/u);
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Claude non-text tool discovery results remain readable inside their tool result", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), "tmp", "claude-tool-reference-"));
  try {
    const payload = fixturePayload();
    payload["messages"] = [{ id: "owned", role: "assistant", index: 0, blocks: [{ type: "tool_result", tool_use_id: "discovery", content: [{ type: "tool_reference", tool_name: "WebSearch" }, { type: "tool_reference", tool_name: "WebFetch" }] }] }];
    payload["active_message_ids"] = ["owned"];
    const file = path.join(directory, "tools.html");
    await writeFile(file, html(manifest("light", String(payload["format"])), payload, ""));
    const parsed = await parseExporterHtmlToDraft({ filePath: file });
    const result = ((parsed.draft["messages"] as JsonObject[])[0]!["content"] as JsonObject[])[0]!;
    assert.equal(result["type"], "tool");
    assert.deepEqual(result["output"], [{ type: "tool_reference", tool_name: "WebSearch" }, { type: "tool_reference", tool_name: "WebFetch" }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Claude pure thinking keeps the public panel heading and summaries in one fold, but real tool activity remains separate", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload();
    const message = (payload["messages"] as JsonObject[])[1]!;
    message["public_activity_summary"] = "Thought for 4s";
    message["blocks"] = [
      { type: "thinking", summaries: ["First summary", "Second summary"], seconds: 4.3, visibility: "public_summary" },
      { type: "text", markdown: "Answer" }
    ];
    message["media"] = []; payload["resources"] = []; payload["artifacts"] = [];
    const read = async () => {
      await writeFile(scope.file, html(manifest("light", String(payload["format"])), payload, ""), "utf8");
      const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
      return (fullConversation(parsed)["messages"] as JsonObject[])[1]!["content"] as JsonObject[];
    };
    const content = await read();
    assert.deepEqual(content.map(block => block["type"]), ["reasoning_summary", "markdown"]);
    assert.equal(content[0]!["title"], "Thought for 4s");
    assert.equal(content[0]!["text"], "First summary\n\nSecond summary");
    assert.equal(content[0]!["duration"], 4.3);
    (message["blocks"] as JsonObject[]).splice(1, 0, { type: "tool_use", id: "tool-1", name: "lookup", input: { query: "x" } });
    const withTool = await read();
    assert.equal(withTool[0]!["kind"], "activity");
    assert.ok(withTool.some(block => block["type"] === "tool" && block["kind"] === "call"));
    for (const adapter of adapterBundleSnapshot().adapters.filter(entry => entry.family === "claude")) {
      assert.ok(adapter.update_from.some(entry => entry.version === "2.0.1" && entry.action === "reparse_source"));
      assert.ok(adapter.update_from.some(entry => entry.version === "2.0.2" && entry.action === "reparse_source"));
    }
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Claude rich Mermaid cards keep the exact source and snapshot together in all profiles", async () => {
  const scope = await disposable();
  const source = 'graph TD\n  A["x & y"] --> B';
  try {
    for (const profile of ["light", "full", "all-branches"] as const) for (const inlineSvg of [false, true]) {
      const format = profile === "light" ? "osis.claude.chat-export/light-dom-v1" : profile === "full" ? "osis.claude.chat-export/full-capture-v1" : "osis.claude.chat-export/all-branches-v1";
      const payload = fixturePayload(format);
      const message = (payload["messages"] as JsonObject[])[1]!;
      message["media"] = [];
      payload["resources"] = []; payload["artifacts"] = [];
      message["blocks"] = [{ type: "text", rich_html: `<p>Before</p><section class="osis-mermaid-card"><div data-osis-mermaid-panel="diagram">${inlineSvg ? svgBytes.toString("utf8") : `<img src="${svgData}">`}</div><pre class="mermaid-source" data-osis-mermaid-panel="source" data-language="mermaid"><code>${source.replaceAll("&", "&amp;")}</code></pre></section><p>After</p>` }];
      await writeFile(scope.file, html(manifest(profile, format), payload, ""), "utf8");
      const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
      const conversation = fullConversation(parsed);
      const content = (conversation["messages"] as JsonObject[])[1]!["content"] as JsonObject[];
      const diagrams = content.filter(block => block["type"] === "diagram");
      assert.equal(diagrams.length, 1);
      assert.equal(diagrams[0]!["format"], "mermaid");
      assert.equal(diagrams[0]!["source"], source);
      assert.ok(diagrams[0]!["rendered"]);
      assert.ok(content.some(block => String(block["html"]).includes("Before")));
      assert.ok(content.some(block => String(block["html"]).includes("After")));
      assert.ok(content.filter(block => block["type"] === "html").every(block => !String(block["html"]).includes("osis-mermaid-card")));
      assert.equal((conversation["resources"] as JsonObject[])[0]!["kind"], "diagram");
    }
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Claude Full uses embedded payload bytes and does not scan malformed reading DOM", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload("osis.claude.chat-export/full-capture-v1");
    payload["version"] = "1.1.30-full";
    for (const raw of payload["resources"] as JsonObject[]) {
      if (raw["display_eligible"] === true) raw["data_url"] = svgData;
    }
    (payload["artifacts"] as JsonObject[])[0]!["file_data_url"] = fileData;
    await writeFile(scope.file, html(manifest("full", String(payload["format"])), payload, "<article data-message-id=\"would-fail-static-reading\">") , "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const conversation = fullConversation(parsed);
    assert.equal(parsed.adapter.id, "claude-full-capture-v1");
    assert.ok((conversation["messages"] as JsonObject[]).every((message) => message["id"] === undefined && message["parent"] === undefined));
    assert.equal(conversation["current_message"], undefined);
    assert.equal((conversation["resources"] as JsonObject[]).length, 3);
    assert.equal((conversation["limitations"] as JsonObject[] | undefined)?.length ?? 0, 0);
  } finally {
    await rm(scope.base, { recursive: true, force: true });
  }
});

test("Claude rich reading blocks preserve footnotes and exclude explicitly non-reading bridge text", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload("osis.claude.chat-export/full-capture-v1");
    const messages = payload["messages"] as JsonObject[];
    messages[1]!["blocks"] = [
      { type: "text", markdown: "Answer without footnote", rich_html: '<p>Answer<sup><a href="#note">1</a></sup></p><aside id="note">The complete footnote</aside>' },
      { type: "text", markdown: "NON_READING_BRIDGE", reading_surface_visible: false },
      { type: "api_error", message: "Source reported overload" }
    ];
    await writeFile(scope.file, html(manifest("full", String(payload["format"])), payload, ""), "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const conversation = fullConversation(parsed);
    const serialized = JSON.stringify(conversation);
    assert.match(serialized, /The complete footnote/u);
    assert.doesNotMatch(serialized, /NON_READING_BRIDGE|without footnote/u);
    assert.match(serialized, /Source reported overload/u);
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Claude Cowork page-state tools stay in their own assistant turn, with call/result identity and readable search output", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload();
    const message = (payload["messages"] as JsonObject[])[1]!;
    message["blocks"] = [{ type: "thinking", visibility: "public_body", body: "Visible reasoning" }, { type: "text", markdown: "Final answer" }];
    message["cowork_page_tools"] = [
      { type: "tool_use", id: "page-call", name: "WebSearch", input: { query: "example" }, _osis_cowork_page_state_tool: true },
      { type: "tool_result", tool_use_id: "page-call", name: "WebSearch", content: [{ type: "text", text: 'Links: [{"title":"Example","url":"https://example.com/page"}]' }], _osis_cowork_page_state_tool: true }
    ];
    await writeFile(scope.file, html(manifest("light", String(payload["format"])), payload, ""), "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const content = ((parsed.draft["messages"] as JsonObject[])[1]!["content"] as JsonObject[]);
    const calls = content.filter(block => block["type"] === "tool" && block["kind"] !== "activity");
    assert.equal(calls.length, 2); assert.equal(calls[0]!["call"], calls[1]!["call"]);
    assert.match(JSON.stringify(calls[1]), /https:\/\/example.com\/page/u);
    assert.ok(content.findIndex(block => block["type"] === "tool") < content.findIndex(block => block["text"] === "Final answer"));
    assert.equal((parsed.draft["sources"] as JsonObject[] | undefined)?.filter(source => source["kind"] === "past_chat").length ?? 0, 0);
  } finally { await rm(scope.base, { recursive: true, force: true }); }
});

test("Claude Tree preserves parent-first sibling branches and the selected source leaf", async () => {
  const scope = await disposable();
  try {
    const payload = fixturePayload("osis.claude.chat-export/all-branches-v1");
    payload["version"] = "1.1.30-all-branches";
    for (const raw of payload["resources"] as JsonObject[]) {
      if (raw["display_eligible"] === true) raw["data_url"] = svgData;
    }
    (payload["artifacts"] as JsonObject[])[0]!["file_data_url"] = fileData;
    const branch = structuredClone((payload["messages"] as JsonObject[])[1]!);
    branch["id"] = "assistant-2";
    branch["index"] = 2;
    branch["blocks"] = [{ type: "text", markdown: "Sibling", citations: [] }];
    branch["media"] = [];
    (payload["messages"] as JsonObject[]).push(branch);
    payload["current_leaf_message_id"] = "assistant-1";
    payload["tree_topology"] = {
      root_ids: ["user-1"],
      orphan_root_ids: [],
      children_by_id: { "user-1": ["assistant-1", "assistant-2"] },
      message_order: ["user-1", "assistant-1", "assistant-2"],
      current_path_message_ids: ["user-1", "assistant-1"]
    };
    await writeFile(scope.file, html(manifest("all-branches", String(payload["format"])), payload, ""), "utf8");
    const parsed = await parseExporterHtmlToDraft({ filePath: scope.file });
    const conversation = fullConversation(parsed);
    const messages = conversation["messages"] as JsonObject[];
    assert.equal(parsed.adapter.id, "claude-all-branches-v1");
    assert.deepEqual(messages.map((entry) => [entry["id"], entry["parent"]]), [["m1", undefined], ["m2", "m1"], ["m3", "m1"]]);
    assert.equal(conversation["current_message"], "m2");
  } finally {
    await rm(scope.base, { recursive: true, force: true });
  }
});
