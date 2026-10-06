import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = await realpath(path.join(path.dirname(fileURLToPath(import.meta.url)), '../artifacts/v1-document-site'));
const base = '/Cloudig/', port = Number(process.argv.find(a => a.startsWith('--port='))?.slice(7) ?? 4178);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const server = createServer(async (req, res) => {
    try {
        if (!['GET', 'HEAD'].includes(req.method)) {
            res.writeHead(405);
            res.end();
            return;
        }
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname === '/' || pathname === '/Cloudig') {
            res.writeHead(302, { Location: base });
            res.end();
            return;
        }
        if (!pathname.startsWith(base))
            throw Error('outside');
        const file = await realpath(path.resolve(root, pathname.slice(base.length) || 'index.html'));
        if (!file.startsWith(root + path.sep))
            throw Error('outside');
        const info = await stat(file);
        if (!info.isFile())
            throw Error('not a file');
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (req.method === 'HEAD')
            res.end();
        else
            createReadStream(file).pipe(res);
    }
    catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }
});
server.listen(port, '127.0.0.1', () => console.log(`Cloudig docs preview: http://127.0.0.1:${port}${base}`));
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => server.close(() => process.exit(0)));
