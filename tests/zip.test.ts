// The zip reader against archives that lie about themselves.
//
// It reads two kinds of file: a register's bulk export, and whatever a buyer's
// procurement platform serves as a tender's documents. The second is not a
// trusted source, and every size in a zip is a number the archive wrote about
// itself.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ZipError, readZipMember, zipEntries } from "../src/zip.js";

const dir = mkdtempSync(join(tmpdir(), "ultraprospect-zip-"));

/** A one-member archive, written by hand so each field can be made to lie. */
function archive(name: string, data: Buffer, opts: { deflate?: boolean; declaredSize?: number; directorySize?: number } = {}): string {
  const body = opts.deflate ? deflateRawSync(data) : data;
  const method = opts.deflate ? 8 : 0;
  const declared = opts.declaredSize ?? data.length;
  const fileName = Buffer.from(name, "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(declared, 22);
  local.writeUInt16LE(fileName.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);

  const directory = Buffer.concat([central, fileName]);
  const directoryOffset = local.length + fileName.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(opts.directorySize ?? directory.length, 12);
  eocd.writeUInt32LE(directoryOffset, 16);

  const path = join(dir, `${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(path, Buffer.concat([local, fileName, body, directory, eocd]));
  return path;
}

describe("zipEntries", () => {
  it("lists an honest archive", async () => {
    const entries = await zipEntries(archive("cahier.txt", Buffer.from("Cahier des charges")));
    expect(entries.map((e) => e.name)).toEqual(["cahier.txt"]);
  });

  it("refuses a central directory that claims to be larger than the file, without allocating it", async () => {
    const path = archive("a.txt", Buffer.from("x"), { directorySize: 0xfffffff0 });
    await expect(zipEntries(path)).rejects.toThrow(ZipError);
    await expect(zipEntries(path)).rejects.toThrow(/outside the file/);
  });
});

describe("readZipMember", () => {
  it("returns a member that fits, stored or deflated", async () => {
    for (const deflate of [false, true]) {
      const path = archive("cahier.txt", Buffer.from("Cahier des charges ".repeat(50)), { deflate });
      const [entry] = await zipEntries(path);
      expect((await readZipMember(path, entry!, 1024 * 1024))?.toString("utf8")).toContain("Cahier des charges");
    }
  });

  it("refuses a member that declares more than the cap", async () => {
    const path = archive("big.bin", Buffer.alloc(2048), { deflate: true });
    const [entry] = await zipEntries(path);
    expect(await readZipMember(path, entry!, 1024)).toBeUndefined();
  });

  it("stops a member that declares a small size and inflates past the cap", async () => {
    // Four megabytes of zeros deflate to a few kilobytes, and the header says 10 bytes.
    const path = archive("bomb.bin", Buffer.alloc(4 * 1024 * 1024), { deflate: true, declaredSize: 10 });
    const [entry] = await zipEntries(path);
    expect(entry!.uncompressedSize).toBe(10);
    expect(await readZipMember(path, entry!, 64 * 1024)).toBeUndefined();
  });
});
