import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { parseStreamingJson } from "../../../src/adapters/parser/json-object-stream.mts";

test("streamed object parsing matches JSON.parse across every chunk boundary and rejects malformed input", async () => {
  const text = '{"a":[true,null,1.25e-3,{"b":"中文😀\\n\\\"x"}],"empty":{},"arr":[],"__proto__":{"ok":true}}';
  const bytes = Buffer.from(text);
  for (let width = 1; width <= bytes.length; width++) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += width) chunks.push(bytes.subarray(offset, offset + width));
    assert.deepEqual(await parseStreamingJson(Readable.from(chunks)), JSON.parse(text));
  }
  for (const invalid of ['{"a":1,}', '[1,]', '{"a" 1}', '{"a":}', '[1 2]', '{}{}', '"unterminated', '', 'false true']) {
    await assert.rejects(parseStreamingJson(Readable.from([Buffer.from(invalid)])));
  }
  await assert.rejects(parseStreamingJson(Readable.from([Buffer.from([0x22, 0xff, 0x22])])), /encoded data|encoding/iu);
  assert.equal(await parseStreamingJson(Readable.from([Buffer.from('"�"')])), "�");
  const controller = new AbortController();
  async function* chunks() { yield Buffer.from('{"x":'); controller.abort(new Error("stop reading")); yield Buffer.from('1}'); }
  await assert.rejects(parseStreamingJson(Readable.from(chunks()), controller.signal), /stop reading/u);
});

import {
  parseJsonRange,
  streamTopLevelJsonArrayRanges
} from "../../../src/adapters/parser/json-array-stream.mts";

async function ranges(value: string, chunkSize: number): Promise<readonly Readonly<{ index: number; offset: number; length: number }>[]> {
  const chunks: Buffer[] = [];
  const bytes = Buffer.from(value, "utf8");
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) chunks.push(bytes.subarray(offset, offset + chunkSize));
  const result = [];
  for await (const range of streamTopLevelJsonArrayRanges(Readable.from(chunks))) result.push(range);
  return result;
}

test("top-level JSON ranges are byte-exact across chunk boundaries, escaped strings, and nested arrays", async () => {
  const source = " \n[ {\"text\":\"],\\\" still text\",\"nested\":[1,{\"x\":true}]}  ,\n [2,3], \"尾声\" ] \t";
  const expected = [
    "{\"text\":\"],\\\" still text\",\"nested\":[1,{\"x\":true}]}",
    "[2,3]",
    "\"尾声\""
  ];
  for (const chunkSize of [1, 2, 3, 7, 64]) {
    const found = await ranges(source, chunkSize);
    assert.deepEqual(found.map((entry) => Buffer.from(source, "utf8").subarray(entry.offset, entry.offset + entry.length).toString("utf8")), expected);
  }
});

test("string fast-skip preserves byte ranges with distant escapes and split delimiters", async () => {
  const values = [{ long: "字 ".repeat(9000), escaped: 'a\\b"c\n\t', tail: " ".repeat(300) }, ...Array.from({ length: 120 }, (_, index) => ({ title: `record-${index}`, text: "plain" }))];
  const source = JSON.stringify(values);
  const bytes = Buffer.from(source);
  for (const width of [3, 31, 1024, 65536]) {
    const found = await ranges(source, width);
    assert.deepEqual(found.map(range => JSON.parse(bytes.subarray(range.offset, range.offset + range.length).toString("utf8"))), values);
  }
});

test("range parsing reads only the selected item and returns its exact fingerprint", async () => {
  const base = await mkdtemp(path.join(process.cwd(), ".tmp-v1-json-range-"));
  try {
    const file = path.join(base, "container.json");
    const source = "[{\"uuid\":\"a\",\"chat_messages\":[]},{\"uuid\":\"b\",\"chat_messages\":[1]}]";
    await writeFile(file, source, "utf8");
    const found = await ranges(source, 5);
    const parsed = await parseJsonRange(file, found[1]!);
    assert.deepEqual(parsed.value, { uuid: "b", chat_messages: [1] });
    assert.equal(parsed.fingerprint.bytes, found[1]!.length);
    assert.match(parsed.fingerprint.sha256, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("range scanner rejects malformed envelope states and observes cancellation", async () => {
  await assert.rejects(async () => { for await (const _ of streamTopLevelJsonArrayRanges(Readable.from(["{}"]))) void _; }, /top-level JSON array/u);
  await assert.rejects(async () => { for await (const _ of streamTopLevelJsonArrayRanges(Readable.from(["[1,]"]))) void _; }, /trailing comma/u);
  await assert.rejects(async () => { for await (const _ of streamTopLevelJsonArrayRanges(Readable.from(["[1"]))) void _; }, /ended inside/u);
  const controller = new AbortController();
  const source = new Readable({
    read() {
      this.push(Buffer.alloc(128 * 1024, 0x20));
      controller.abort();
    }
  });
  await assert.rejects(async () => {
    for await (const _ of streamTopLevelJsonArrayRanges(source, { signal: controller.signal })) void _;
  }, /abort|cancel/iu);
});
