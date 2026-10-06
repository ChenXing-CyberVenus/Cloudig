import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bookmarkletTargets, frozenPath } from "./bookmarklet-targets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bookmarkletRoot = join(projectRoot, "bookmarklets");
const preOptimizationBaselineBytes = 2_554_373;
const rows = bookmarkletTargets.map((target) => {
  const before = statSync(join(bookmarkletRoot, frozenPath(target, target.min, target.baselineVersion))).size;
  const after = statSync(join(bookmarkletRoot, target.min)).size;
  return {
    platform: target.label,
    baseline_version: target.baselineVersion,
    baseline_bytes: before,
    current_bytes: after,
    delta_bytes: before - after,
    percent: `${(((before - after) / before) * 100).toFixed(1)}%`
  };
});
const total = rows.reduce((sum, row) => ({
  before: sum.before + row.baseline_bytes,
  after: sum.after + row.current_bytes,
  saved: sum.saved + row.delta_bytes
}), { before: 0, after: 0, saved: 0 });
const preOptimizationSaved = preOptimizationBaselineBytes - total.after;

console.table(rows);
console.log(JSON.stringify({
  comparison: "current artifacts vs each target's frozen baselineVersion rollback pair",
  targets: rows.length,
  before_bytes: total.before,
  after_bytes: total.after,
  saved_bytes: total.saved,
  saved_percent: Number(((total.saved / total.before) * 100).toFixed(2)),
  pre_optimization_baseline_bytes: preOptimizationBaselineBytes,
  saved_from_pre_optimization_bytes: preOptimizationSaved,
  saved_from_pre_optimization_percent: Number(((preOptimizationSaved / preOptimizationBaselineBytes) * 100).toFixed(2))
}, null, 2));
