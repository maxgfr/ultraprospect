// Just enough ZIP to read one member of a large archive, as a stream.
//
// Node ships the compression (`zlib.createInflateRaw`) and none of the container.
// Companies House publishes its Free Company Data Product as a 470 MB zip holding
// a single ~2.4 GB CSV, so the container is all that stands between this tool and
// a keyless UK register.
//
// Read through the CENTRAL DIRECTORY rather than the local file headers, which is
// the decision worth explaining. A local header may declare sizes of zero and
// defer them to a data descriptor AFTER the compressed bytes (general-purpose bit
// 3) — legal, common from streaming writers, and unreadable without first
// decompressing to find out where the member ends. The central directory at the
// tail always carries the real sizes and offsets. The archive is on disk by the
// time we look, so seeking to the end costs nothing.
//
// Deliberately NOT a general-purpose zip library: no encryption, no multi-disk,
// no ZIP64 beyond what it takes to notice and refuse. Every limitation throws by
// name rather than returning a plausible prefix.
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInflateRaw } from "node:zlib";
import type { Readable } from "node:stream";

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
/** The comment field is 16 bits, so the record starts within 64 KB of the end. */
const EOCD_SEARCH_WINDOW = 0x10000 + EOCD_MIN_SIZE;
const CENTRAL_SIGNATURE = 0x02014b50;
const STORED = 0;
const DEFLATED = 8;

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the member's LOCAL header, from the central directory. */
  localHeaderOffset: number;
  method: number;
}

/**
 * List an archive's members, from its central directory.
 *
 * Only the fields needed to stream one member out. A ZIP64 archive is refused
 * rather than misread: the 32-bit fields hold 0xffffffff as a sentinel, and
 * treating that as a real size would inflate 4 GB of nothing.
 */
export async function zipEntries(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    if (size < EOCD_MIN_SIZE) throw new ZipError("file is too small to be a zip archive");

    // Find the end-of-central-directory record by scanning backwards for its
    // signature — its own length is variable because of the trailing comment.
    const windowSize = Math.min(size, EOCD_SEARCH_WINDOW);
    const tail = Buffer.alloc(windowSize);
    await fh.read(tail, 0, windowSize, size - windowSize);
    let eocd = -1;
    for (let i = windowSize - EOCD_MIN_SIZE; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError("no end-of-central-directory record — not a zip archive, or truncated");

    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directoryOffset === 0xffffffff || entryCount === 0xffff) {
      throw new ZipError("ZIP64 archive — not supported, and refused rather than misread");
    }

    const dir = Buffer.alloc(directorySize);
    await fh.read(dir, 0, directorySize, directoryOffset);

    const entries: ZipEntry[] = [];
    let at = 0;
    for (let i = 0; i < entryCount; i++) {
      if (at + 46 > dir.length) throw new ZipError("central directory ended early");
      if (dir.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new ZipError("bad central directory signature");
      const method = dir.readUInt16LE(at + 10);
      const compressedSize = dir.readUInt32LE(at + 20);
      const uncompressedSize = dir.readUInt32LE(at + 24);
      const nameLen = dir.readUInt16LE(at + 28);
      const extraLen = dir.readUInt16LE(at + 30);
      const commentLen = dir.readUInt16LE(at + 32);
      const localHeaderOffset = dir.readUInt32LE(at + 42);
      const name = dir.toString("utf8", at + 46, at + 46 + nameLen);
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new ZipError(`ZIP64 member "${name}" — not supported, and refused rather than misread`);
      }
      entries.push({ name, compressedSize, uncompressedSize, localHeaderOffset, method });
      at += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/**
 * Where a member's compressed bytes actually begin.
 *
 * The central directory points at the LOCAL header, whose name and extra fields
 * have their own lengths — and those lengths can differ from the central
 * directory's copy, which is why they are read here rather than reused.
 */
async function dataStart(path: string, entry: ZipEntry): Promise<number> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, entry.localHeaderOffset);
    if (head.readUInt32LE(0) !== 0x04034b50) throw new ZipError(`no local header for "${entry.name}"`);
    return entry.localHeaderOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  } finally {
    await fh.close();
  }
}

/**
 * A readable stream of one member's decompressed bytes.
 *
 * Streamed rather than buffered because the member is the point: a 2.4 GB CSV is
 * past what a single Buffer or string can hold, so a caller has to be able to
 * consume it in pieces.
 */
export async function openZipMember(path: string, entry: ZipEntry): Promise<Readable> {
  if (entry.method !== DEFLATED && entry.method !== STORED) {
    throw new ZipError(`member "${entry.name}" uses compression method ${entry.method}; only stored and deflate are supported`);
  }
  const start = await dataStart(path, entry);
  const raw = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
  return entry.method === STORED ? raw : raw.pipe(createInflateRaw());
}
