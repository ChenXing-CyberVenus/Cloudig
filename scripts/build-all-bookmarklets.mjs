import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bookmarkletTargets, validateBookmarkletTargets } from "./bookmarklet-targets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builder = resolve(projectRoot, "scripts/build-bookmarklet.mjs");
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 1 || (cliArgs.length === 1 && cliArgs[0] !== "--check")) {
  throw new Error("Usage: node scripts/build-all-bookmarklets.mjs [--check]");
}
const checkOnly = cliArgs[0] === "--check";
const forceTransactionForTest = process.env.OSIS_BOOKMARKLET_TEST_FORCE_TRANSACTION === "1";
const injectedFailureRaw = process.env.OSIS_BOOKMARKLET_TEST_FAIL_REPLACE_AT || "";
const injectedFailureAt = injectedFailureRaw ? Number(injectedFailureRaw) : 0;
if (injectedFailureRaw && (!Number.isInteger(injectedFailureAt) || injectedFailureAt < 1)) {
  throw new Error("OSIS_BOOKMARKLET_TEST_FAIL_REPLACE_AT must be a positive integer");
}

validateBookmarkletTargets(bookmarkletTargets, {
  readSourceText: (target) => readFileSync(resolve(projectRoot, "bookmarklets", target.source), "utf8")
});

const stagingRoot = mkdtempSync(join(tmpdir(), "osis-bookmarklet-set-"));
const staged = [];

function replaceArtifactSet(items) {
  if (!items.length) return;
  const transactionId = `osis-bookmarklet-transaction-${process.pid}-${Date.now()}-${randomUUID()}`;
  const prepared = items.map((item) => {
    const existed = existsSync(item.destination);
    const originalBytes = existed ? readFileSync(item.destination) : null;
    return {
      ...item,
      existed,
      temporaryPath: `${item.destination}.${transactionId}.tmp`,
      backupPath: `${item.destination}.${transactionId}.bak`,
      originalBytes
    };
  });
  const replaced = [];

  try {
    for (const item of prepared) {
      writeFileSync(item.temporaryPath, item.bytes, { flag: "wx" });
      if (item.existed) writeFileSync(item.backupPath, item.originalBytes, { flag: "wx" });
    }

    try {
      for (let index = 0; index < prepared.length; index += 1) {
        if (injectedFailureAt === index + 1) {
          throw new Error(`Injected bookmark artifact replacement failure at ${injectedFailureAt}`);
        }
        const item = prepared[index];
        renameSync(item.temporaryPath, item.destination);
        replaced.push(item);
      }
    } catch (replacementError) {
      const rollbackErrors = [];
      for (const item of [...replaced].reverse()) {
        try {
          if (item.existed) renameSync(item.backupPath, item.destination);
          else rmSync(item.destination, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(new Error(`${item.target.label} rollback failed: ${rollbackError.message}`, { cause: rollbackError }));
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError([replacementError, ...rollbackErrors], "Bookmark artifact replacement failed and rollback was incomplete");
      }
      throw replacementError;
    }
  } finally {
    for (const item of prepared) {
      rmSync(item.temporaryPath, { force: true });
      rmSync(item.backupPath, { force: true });
    }
  }
}

try {
  for (const target of bookmarkletTargets) {
    const stagedPath = join(stagingRoot, target.min);
    mkdirSync(dirname(stagedPath), { recursive: true });
    const args = [builder, `bookmarklets/${target.source}`, stagedPath, "--temml"];
    if (target.katex) args.push("--katex-runtime");
    const result = spawnSync(process.execPath, args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${target.label} 构建失败`);
    process.stdout.write(result.stdout);
    staged.push({
      target,
      bytes: readFileSync(stagedPath),
      destination: resolve(projectRoot, "bookmarklets", target.min)
    });
  }

  const changed = staged.filter((item) => forceTransactionForTest || !existsSync(item.destination) || !item.bytes.equals(readFileSync(item.destination)));
  if (checkOnly && changed.length) {
    const details = changed.map((item) => `${item.target.label}${existsSync(item.destination) ? "" : "（成品缺失）"}`);
    throw new Error(`维护源码与严格单行成品不一致：${details.join("、")}`);
  }
  if (!checkOnly) replaceArtifactSet(changed);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: checkOnly ? "check" : "write",
    targets: staged.length,
    artifacts_modified: checkOnly ? 0 : changed.length
  })}\n`);
} finally {
  rmSync(stagingRoot, { recursive: true, force: true });
}
