import { crc32, deflateRawSync } from 'node:zlib';
/** Tiny writer for owned fixtures only. Production ZIP reading uses yauzl. */
export function fixtureZip(files: readonly { name: string; data: string | Buffer; stored?: boolean; wrongCrc?: boolean }[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = Buffer.from(file.data), body = file.stored ? data : deflateRawSync(data), method = file.stored ? 0 : 8;
    const crc = crc32(data) ^ (file.wrongCrc ? 1 : 0), local = Buffer.alloc(30), dir = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc >>> 0, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, name, body); central.push(dir, name); offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
