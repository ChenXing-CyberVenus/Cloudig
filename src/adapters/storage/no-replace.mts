import { link, unlink } from "node:fs/promises";
import { createConnection } from "node:net";

export const NATIVE_FILE_MOVE_LIMITS = Object.freeze({ requestBytes: 32768, responseCharacters: 65536, timeoutMs: 10000 });

/** Consume a prepared file without ever replacing a racing destination.
 * Desktop uses MoveFileExW(flags=0), including on FAT/exFAT. Standalone NTFS
 * tools retain the old link/unlink primitive; a failed link is never an overwrite.
 */
export async function moveFileNoReplace(source: string, target: string): Promise<void> {
  const endpoint = process.env["CLOUDIG_FILE_MOVES_PIPE"];
  if (!endpoint) { await link(source, target); await unlink(source); return; }
  if (!/^Cloudig-FileMoves-[0-9a-f]{32}$/u.test(endpoint)) throw new TypeError("Invalid native file-move endpoint");
  const request = Buffer.from(JSON.stringify([source, target])), header = Buffer.alloc(4); header.writeInt32LE(request.length);
  if (request.length > NATIVE_FILE_MOVE_LIMITS.requestBytes) throw new RangeError("Native file-move request exceeds its bound");
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(`\\\\.\\pipe\\${endpoint}`); let response = "", settled = false;
    const finish = (error?: unknown) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(); };
    socket.setEncoding("utf8"); socket.setTimeout(NATIVE_FILE_MOVE_LIMITS.timeoutMs, () => finish(new Error("Native file move timed out; the transaction remains recoverable")));
    socket.once("connect", () => socket.write(Buffer.concat([header, request])));
    socket.once("error", finish);
    socket.on("data", text => {
      response += text;
      if (response.length > NATIVE_FILE_MOVE_LIMITS.responseCharacters) { finish(new Error("Native move response exceeds its bound")); return; }
      if (!response.includes("\n")) return;
      try {
        const value = JSON.parse(response);
        if (value.ok === true) finish();
        else finish(Object.assign(new Error(String(value.message ?? "Native file move failed")), { code: String(value.code ?? "EIO") }));
      } catch (error) { finish(error); }
    });
    socket.once("close", () => { if (!settled) finish(new Error("Native file move connection closed; inspect the transaction before retrying")); });
  });
}
