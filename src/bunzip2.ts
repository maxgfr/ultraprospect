// bzip2 decompression, in pure JavaScript, because Node has none.
//
// `zlib` covers gzip, deflate and brotli. It does not cover bzip2, and the German
// company register's only open bulk export — OffeneRegister's
// `de_companies_ocdata.jsonl.bz2` — is bzip2. The alternatives were both worse
// than writing this: shelling out to the system `bzip2` gives up running on
// Windows and turns a data source into a platform requirement, and the same
// project's SQLite export would mean hand-rolling a b-tree reader for 3.7 GB.
//
// So this is the one place in the tree that manipulates bits, and it is tested
// against files produced by the reference `bzip2` binary rather than against
// itself. Everything here is the published format, in the order the format puts
// it:
//
//   stream  := "BZh" level  block+  footer
//   block   := magic(48) crc(32) randomised(1) origPtr(24)
//              symbolMap  nGroups(3) nSelectors(15) selector+  codeLengths+
//              huffman-coded MTF/RLE2 symbols
//   footer  := magic(48) combinedCrc(32)
//
// Decoding a block reverses three transforms in this order: Huffman, then
// move-to-front with its run-length layer, then the Burrows-Wheeler transform,
// then bzip2's outer run-length layer. Getting the ORDER wrong still produces
// plausible-looking bytes, which is exactly why the tests decompress real files
// and compare against the original rather than checking any intermediate stage.
//
// Deliberately NOT streaming its input: the whole compressed file is handed over
// as one buffer (260 MB for the German dump, read once during `ingest`), and the
// OUTPUT is yielded block by block. That is the asymmetry that matters — the
// decompressed dump is several gigabytes, well past what a single Buffer or
// string can hold, so a caller has to be able to consume it in pieces.

/** Longest Huffman code bzip2 permits. */
const MAX_CODE_LEN = 23;
/** Block magic: pi, as binary-coded decimal. */
const BLOCK_MAGIC_HI = 0x3141;
const BLOCK_MAGIC_LO = 0x59265359;
/** End-of-stream magic: sqrt(pi), likewise. */
const FOOTER_MAGIC_HI = 0x1772;
const FOOTER_MAGIC_LO = 0x45385090;

const RUNA = 0;
const RUNB = 1;

export class Bzip2Error extends Error {}

/** Does this buffer start with a bzip2 stream header? */
export function isBzip2(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === 0x42 && buf[1] === 0x5a && buf[2] === 0x68 && buf[3]! >= 0x31 && buf[3]! <= 0x39;
}

/**
 * An MSB-first bit reader over the compressed buffer.
 *
 * bzip2 is not byte-aligned anywhere after the 4-byte stream header — a block
 * can begin mid-byte — so every read goes through here and there is no fast path
 * that assumes alignment.
 */
class BitReader {
  private pos = 0;
  private bitBuf = 0;
  private bitCount = 0;
  private readonly buf: Uint8Array;

  // An explicit field rather than a parameter property: the latter is TypeScript
  // syntax that has to be TRANSFORMED rather than stripped, and this module is
  // worth being able to run under `node --experimental-strip-types` directly when
  // reaching for it to check something against a real dump.
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  /** Up to 24 bits at a time; wider reads are composed by the callers that need them. */
  bits(n: number): number {
    while (this.bitCount < n) {
      if (this.pos >= this.buf.length) throw new Bzip2Error("truncated bzip2 stream");
      this.bitBuf = (this.bitBuf << 8) | this.buf[this.pos++]!;
      this.bitCount += 8;
    }
    this.bitCount -= n;
    const out = (this.bitBuf >>> this.bitCount) & ((1 << n) - 1);
    // Keep the buffer from overflowing 32 bits over a long stream.
    this.bitBuf &= (1 << this.bitCount) - 1;
    return out;
  }

  bit(): number {
    return this.bits(1);
  }

  /** 32 bits, in two halves: `1 << 32` is not a number JavaScript can shift to. */
  uint32(): number {
    return this.bits(16) * 0x10000 + this.bits(16);
  }

  atEnd(): boolean {
    return this.pos >= this.buf.length && this.bitCount === 0;
  }

  /** Skip to the next byte boundary — only ever between concatenated streams. */
  alignToByte(): void {
    this.bitCount -= this.bitCount % 8;
    this.bitBuf &= (1 << this.bitCount) - 1;
  }

  /** Does a whole `BZh` header start here, ignoring any partial byte? */
  looksLikeNewStream(): boolean {
    const at = this.pos - Math.floor(this.bitCount / 8);
    return at + 3 < this.buf.length && this.buf[at] === 0x42 && this.buf[at + 1] === 0x5a && this.buf[at + 2] === 0x68;
  }
}

/**
 * The canonical-Huffman decode tables, in bzip2's own formulation.
 *
 * `limit[len]` is the largest code of that length, `base[len]` the offset that
 * turns a code into an index into `perm`. Decoding then reads `minLen` bits and
 * takes one more at a time while the value exceeds `limit`, which is O(code
 * length) with no per-bit table lookup — the difference between an ingest that
 * takes two minutes and one that takes twenty.
 */
interface DecodeTable {
  limit: Int32Array;
  base: Int32Array;
  perm: Int32Array;
  minLen: number;
  maxLen: number;
}

function decodeTable(lengths: Uint8Array, alphaSize: number): DecodeTable {
  let minLen = 32;
  let maxLen = 0;
  for (let i = 0; i < alphaSize; i++) {
    const l = lengths[i]!;
    if (l > maxLen) maxLen = l;
    if (l < minLen) minLen = l;
  }

  const perm = new Int32Array(alphaSize);
  let pp = 0;
  for (let len = minLen; len <= maxLen; len++) {
    for (let sym = 0; sym < alphaSize; sym++) if (lengths[sym] === len) perm[pp++] = sym;
  }

  const base = new Int32Array(MAX_CODE_LEN + 2);
  const limit = new Int32Array(MAX_CODE_LEN + 2);
  for (let i = 0; i < alphaSize; i++) {
    const slot = lengths[i]! + 1;
    base[slot] = (base[slot] ?? 0) + 1;
  }
  for (let i = 1; i < base.length; i++) base[i] = base[i]! + base[i - 1]!;

  let vec = 0;
  for (let len = minLen; len <= maxLen; len++) {
    vec += base[len + 1]! - base[len]!;
    limit[len] = vec - 1;
    vec <<= 1;
  }
  for (let len = minLen + 1; len <= maxLen; len++) base[len] = ((limit[len - 1]! + 1) << 1) - base[len]!;

  return { limit, base, perm, minLen, maxLen };
}

function decodeSymbol(r: BitReader, t: DecodeTable): number {
  let len = t.minLen;
  let vec = r.bits(len);
  while (len <= t.maxLen && vec > t.limit[len]!) {
    vec = (vec << 1) | r.bit();
    len++;
  }
  if (len > t.maxLen) throw new Bzip2Error("bad Huffman code");
  const idx = vec - t.base[len]!;
  if (idx < 0 || idx >= t.perm.length) throw new Bzip2Error("Huffman code out of range");
  return t.perm[idx]!;
}

/** The symbol map: which byte values this block uses at all. */
function readSymbolMap(r: BitReader): Uint8Array {
  const used: number[] = [];
  const groups = r.bits(16);
  for (let i = 0; i < 16; i++) {
    if ((groups & (0x8000 >>> i)) === 0) continue;
    const bits = r.bits(16);
    for (let j = 0; j < 16; j++) if (bits & (0x8000 >>> j)) used.push(i * 16 + j);
  }
  if (used.length === 0) throw new Bzip2Error("block uses no symbols");
  return Uint8Array.from(used);
}

/** Selectors, themselves move-to-front coded over the table indices. */
function readSelectors(r: BitReader, nGroups: number, nSelectors: number): Uint8Array {
  const mtf = new Uint8Array(nGroups);
  for (let i = 0; i < nGroups; i++) mtf[i] = i;
  const out = new Uint8Array(nSelectors);
  for (let i = 0; i < nSelectors; i++) {
    let j = 0;
    while (r.bit()) {
      j++;
      if (j >= nGroups) throw new Bzip2Error("selector out of range");
    }
    const v = mtf[j]!;
    for (let k = j; k > 0; k--) mtf[k] = mtf[k - 1]!;
    mtf[0] = v;
    out[i] = v;
  }
  return out;
}

/** Per-group code lengths, written as a delta walk rather than absolute values. */
function readCodeLengths(r: BitReader, nGroups: number, alphaSize: number): Uint8Array[] {
  const tables: Uint8Array[] = [];
  for (let g = 0; g < nGroups; g++) {
    const lengths = new Uint8Array(alphaSize);
    let curr = r.bits(5);
    for (let s = 0; s < alphaSize; s++) {
      for (;;) {
        if (curr < 1 || curr > 20) throw new Bzip2Error(`code length ${curr} out of range`);
        if (!r.bit()) break;
        curr += r.bit() ? -1 : 1;
      }
      lengths[s] = curr;
    }
    tables.push(lengths);
  }
  return tables;
}

/**
 * Undo the Burrows-Wheeler transform.
 *
 * `bwt` is the last column; the first column is the same bytes sorted, which is
 * why a counting pass is enough to reconstruct the permutation. `next[j]` is the
 * position in `bwt` of the byte that follows position `j` in the original, so the
 * whole block is one walk from `origPtr`.
 */
function inverseBwt(bwt: Uint8Array, nblock: number, origPtr: number): Uint8Array {
  if (origPtr < 0 || origPtr >= nblock) throw new Bzip2Error("origPtr outside the block");
  const cftab = new Int32Array(257);
  for (let i = 0; i < nblock; i++) {
    const slot = bwt[i]! + 1;
    cftab[slot] = (cftab[slot] ?? 0) + 1;
  }
  for (let i = 1; i < 257; i++) cftab[i] = cftab[i]! + cftab[i - 1]!;

  const next = new Int32Array(nblock);
  for (let i = 0; i < nblock; i++) next[cftab[bwt[i]!]!++] = i;

  const out = new Uint8Array(nblock);
  let p = next[origPtr]!;
  for (let i = 0; i < nblock; i++) {
    out[i] = bwt[p]!;
    p = next[p]!;
  }
  return out;
}

/**
 * Undo bzip2's outer run-length layer.
 *
 * Four identical bytes are followed by a count of 0-251 FURTHER repeats. The
 * counter has to reset on any change, including after a run has been expanded,
 * or a byte that legitimately repeats four times later in the block gets read as
 * a length prefix.
 */
function unRle(data: Uint8Array, len: number): Uint8Array {
  // Worst case 255/4, but growing a chunked list beats guessing: a JSONL dump is
  // mostly non-repeating, so a 64x allocation would dwarf the real output.
  const chunks: Uint8Array[] = [];
  let out = new Uint8Array(Math.max(1024, len * 2));
  let o = 0;
  const push = (b: number) => {
    if (o === out.length) {
      chunks.push(out);
      out = new Uint8Array(out.length);
      o = 0;
    }
    out[o++] = b;
  };

  let i = 0;
  while (i < len) {
    const b = data[i]!;
    let run = 1;
    while (run < 4 && i + run < len && data[i + run] === b) run++;
    if (run < 4) {
      for (let k = 0; k < run; k++) push(b);
      i += run;
      continue;
    }
    if (i + 4 >= len) throw new Bzip2Error("run-length prefix with no count");
    const extra = data[i + 4]!;
    for (let k = 0; k < 4 + extra; k++) push(b);
    i += 5;
  }

  chunks.push(out.subarray(0, o));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  return joined;
}

function readBlock(r: BitReader, blockSize: number): Uint8Array {
  r.uint32(); // Block CRC. Read to advance; integrity is not this reader's job.
  if (r.bit()) throw new Bzip2Error("randomised blocks are deprecated and unsupported");
  const origPtr = r.bits(24);

  const seqToUnseq = readSymbolMap(r);
  const alphaSize = seqToUnseq.length + 2;
  const nGroups = r.bits(3);
  if (nGroups < 2 || nGroups > 6) throw new Bzip2Error(`nGroups ${nGroups} out of range`);
  const nSelectors = r.bits(15);
  const selectors = readSelectors(r, nGroups, nSelectors);
  const tables = readCodeLengths(r, nGroups, alphaSize).map((l) => decodeTable(l, alphaSize));

  // ---- Huffman + MTF + the inner run-length layer, in one pass --------------
  //
  // RUNA/RUNB encode a run of the byte currently at the front of the MTF list as
  // a bijective base-2 number, which is why the run length is accumulated rather
  // than read: it has no fixed width.
  const bwt = new Uint8Array(blockSize);
  let nblock = 0;
  const mtf = Uint8Array.from(seqToUnseq);
  const eob = alphaSize - 1;

  let groupNo = -1;
  let groupPos = 0;
  let table = tables[0]!;
  const nextSymbol = (): number => {
    if (groupPos === 0) {
      groupNo++;
      if (groupNo >= nSelectors) throw new Bzip2Error("ran out of selectors");
      groupPos = 50;
      table = tables[selectors[groupNo]!]!;
    }
    groupPos--;
    return decodeSymbol(r, table);
  };

  let sym = nextSymbol();
  while (sym !== eob) {
    if (sym === RUNA || sym === RUNB) {
      let run = 0;
      let bit = 1;
      while (sym === RUNA || sym === RUNB) {
        run += sym === RUNA ? bit : 2 * bit;
        bit *= 2;
        sym = nextSymbol();
      }
      const b = mtf[0]!;
      if (nblock + run > blockSize) throw new Bzip2Error("block longer than its declared size");
      bwt.fill(b, nblock, nblock + run);
      nblock += run;
      continue;
    }
    // Any other symbol is an MTF index (offset by one, since 0 and 1 are the run
    // codes): move that byte to the front and emit it.
    const j = sym - 1;
    if (j >= mtf.length) throw new Bzip2Error("MTF index out of range");
    const b = mtf[j]!;
    for (let k = j; k > 0; k--) mtf[k] = mtf[k - 1]!;
    mtf[0] = b;
    if (nblock >= blockSize) throw new Bzip2Error("block longer than its declared size");
    bwt[nblock++] = b;
    sym = nextSymbol();
  }

  return unRle(inverseBwt(bwt, nblock, origPtr), nblock);
}

/**
 * Decompress a bzip2 buffer, yielding one chunk per block.
 *
 * Concatenated streams are handled: `pbzip2` and `bzip2 -c a b > c` both produce
 * several `BZh` streams back to back, and a decoder that stops at the first
 * footer silently returns a prefix of the data — the failure mode that looks
 * like a short file rather than a broken one.
 */
export function* bunzip2Blocks(input: Uint8Array): Generator<Uint8Array> {
  if (!isBzip2(input)) throw new Bzip2Error("not a bzip2 stream (no BZh header)");
  const r = new BitReader(input);

  for (;;) {
    // Stream header: "BZh" then the block-size digit, 1-9, in units of 100k.
    if (r.bits(8) !== 0x42 || r.bits(8) !== 0x5a || r.bits(8) !== 0x68) throw new Bzip2Error("bad stream header");
    const level = r.bits(8) - 0x30;
    if (level < 1 || level > 9) throw new Bzip2Error(`bad block-size level ${level}`);
    const blockSize = level * 100_000;

    for (;;) {
      const hi = r.bits(16);
      const lo = r.uint32();
      if (hi === BLOCK_MAGIC_HI && lo === BLOCK_MAGIC_LO) {
        const out = readBlock(r, blockSize);
        if (out.length) yield out;
        continue;
      }
      if (hi === FOOTER_MAGIC_HI && lo === FOOTER_MAGIC_LO) {
        r.uint32(); // Combined CRC.
        break;
      }
      throw new Bzip2Error("bzip2 block magic not found");
    }

    // Another stream may follow, byte-aligned. Anything else is the end.
    r.alignToByte();
    if (r.atEnd() || !r.looksLikeNewStream()) return;
  }
}

/**
 * Decompress into a single buffer.
 *
 * For tests and small files only. The German dump decompresses to several
 * gigabytes, past what one Buffer can hold, so the ingest path consumes
 * `bunzip2Blocks` instead.
 */
export function bunzip2(input: Uint8Array): Uint8Array {
  const parts = [...bunzip2Blocks(input)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
