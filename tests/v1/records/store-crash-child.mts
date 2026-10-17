import { commitRecords, readStoredRecord } from "../../../src/adapters/storage/record-store.mts";
import type { JsonObject } from "../../../src/core/contracts/types.mts";
const root = process.argv[2]!;
const old = await readStoredRecord(root, "library", "CloudigLibrary.json");
(old.value["settings"] as JsonObject)["language"] = "en";
await commitRecords(root, [{ action: "write", path: "CloudigLibrary.json", kind: "library", value: old.value, expected: old.sha256 }], {
  fault(point) { if (point === "displaced_0") process.exit(19); }
});
