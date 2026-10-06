import { createRuntimeCacheSession } from "../../../src/adapters/storage/runtime-cache.mts";
const session = await createRuntimeCacheSession(process.argv[2]!, process.argv[3]!);
process.stdout.write(`${session.root}\n`);
process.stdin.resume();
process.stdin.on("end", async () => { await session.close(); });
