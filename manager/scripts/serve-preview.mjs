#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const managerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(managerRoot, "web");
const port = Number(process.argv[2] || 34567);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Preview port must be between 1024 and 65535");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"]
]);

const server = http.createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const relative = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath).replace(/^\/+/, "");
    const target = path.resolve(webRoot, relative);
    if (target !== webRoot && !target.startsWith(`${webRoot}${path.sep}`)) throw new Error("unsafe preview path");
    const information = await stat(target);
    if (!information.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(target).toLowerCase()) || "application/octet-stream",
      "Content-Length": information.size,
      "Cache-Control": "no-store"
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`Cloudig preview: http://127.0.0.1:${port}/\n`));
