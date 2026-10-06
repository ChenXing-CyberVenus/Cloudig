import { inspectRecordConversation } from "../../../src/adapters/reader/record-resource.mts";
const file = process.argv[2];
if (!file) throw new Error("Pass the isolated test file");
const start = performance.now(), before = process.memoryUsage().rss;
const result = await inspectRecordConversation(file);
console.log(JSON.stringify({ bytes: result.fingerprint.bytes, resources: result.resourceBodies.size,
  retainedBase64: (result.conversation["resources"] as Record<string, unknown>[]).some(r => Object.hasOwn(r, "data_base64")),
  elapsedMs: performance.now() - start, startingRss: before, peakRss: process.resourceUsage().maxRSS * 1024 }));
