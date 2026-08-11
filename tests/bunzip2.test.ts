// The bzip2 decoder, against files the reference `bzip2` binary produced.
//
// This is the only module in the tree that manipulates bits, and the only one
// where a wrong answer looks like data rather than like an error: reverse the
// four transforms in the wrong order and you still get bytes out, just not the
// right ones. So nothing here asserts on an intermediate stage — every case
// decompresses something a real bzip2 compressed and compares the whole output.
//
// Two layers of reference, on purpose:
//
//   * Committed fixtures under tests/fixtures/bzip2/, so the decoder is covered
//     where `bzip2` is not installed — which includes Windows, the platform this
//     module exists in order not to abandon.
//   * A live round-trip through the system `bzip2` when it IS present, so CI
//     compares against the reference implementation on data the fixtures do not
//     cover, rather than only against bytes committed once by one machine.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bzip2Error, bunzip2, bunzip2Blocks, isBzip2 } from "../src/bunzip2.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "bzip2");
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const expected = readFileSync(join(FIXTURES, "reference.txt"));

/** Is the reference binary available on this machine? */
function haveBzip2(): boolean {
  try {
    execFileSync("bzip2", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Compress with the REFERENCE implementation, so the test never grades our own work. */
function reference(plain: Buffer | string, level = "-9"): Buffer {
  return execFileSync("bzip2", [level, "-c"], { input: plain, maxBuffer: 256 * 1024 * 1024 });
}

describe("isBzip2", () => {
  it("recognises a header and rejects gzip, which is the mistake worth catching", () => {
    expect(isBzip2(fixture("reference.bz2"))).toBe(true);
    // A gzip magic here would mean the wrong decompressor for the wrong file,
    // and the ingest path picks by content rather than by extension.
    expect(isBzip2(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(false);
    expect(isBzip2(Uint8Array.from([0x42, 0x5a, 0x68]))).toBe(false);
  });
});

describe("bunzip2 — against the reference binary's output", () => {
  it("decompresses a level-9 stream byte for byte", () => {
    expect(Buffer.from(bunzip2(fixture("reference.bz2")))).toEqual(expected);
  });

  it("decompresses a level-1 stream, whose 100k blocks split the same data differently", () => {
    // The block size is not cosmetic: it changes how many blocks there are, where
    // each one's BWT rotation lands, and therefore every table in the stream.
    expect(Buffer.from(bunzip2(fixture("reference-level1.bz2")))).toEqual(expected);
  });

  it("reads BOTH streams of a concatenated file rather than stopping at the first footer", () => {
    // `pbzip2` and `bzip2 -c a b > c` both produce streams back to back. A decoder
    // that stops at the first end-of-stream magic returns a PREFIX of the data,
    // which reads as a short input file rather than as a broken decoder — the
    // failure that would quietly halve an ingested register.
    const out = Buffer.from(bunzip2(fixture("reference-concatenated.bz2")));
    expect(out.length).toBe(expected.length * 2);
    expect(out).toEqual(Buffer.concat([expected, expected]));
  });

  it("handles an empty stream, which has a footer and no blocks at all", () => {
    expect(bunzip2(fixture("empty.bz2")).length).toBe(0);
  });

  it("yields block by block, because the real dump does not fit in one buffer", () => {
    // The German export decompresses to several gigabytes, past what a single
    // Buffer can hold. Consuming it in pieces is the whole reason the generator
    // exists, so the generator is what the ingest path is tested on.
    const blocks = [...bunzip2Blocks(fixture("reference-level1.bz2"))];
    expect(blocks.length).toBeGreaterThan(0);
    expect(Buffer.concat(blocks.map((b) => Buffer.from(b)))).toEqual(expected);
  });

  it("refuses a buffer that is not bzip2 instead of returning nonsense", () => {
    expect(() => bunzip2(Buffer.from("not compressed at all"))).toThrow(Bzip2Error);
  });

  it("refuses a truncated stream rather than returning the part it managed", () => {
    // Silently returning a prefix is how a half-ingested register looks complete.
    const whole = fixture("reference.bz2");
    expect(() => bunzip2(whole.subarray(0, Math.floor(whole.length / 2)))).toThrow(Bzip2Error);
  });
});

describe.runIf(haveBzip2())("bunzip2 — live round-trip through the system bzip2", () => {
  const roundTrip = (plain: string | Buffer, level?: string) => Buffer.from(bunzip2(reference(plain, level)));

  it("survives the outer run-length layer, including a run longer than one count byte", () => {
    // Four identical bytes are followed by a count of 0-251 FURTHER repeats, so a
    // 600-byte run is several encoded groups and the counter has to reset between
    // them. An off-by-one here yields a file that is almost right.
    const plain = `${"x".repeat(600)}y${"z".repeat(4)}w${"q".repeat(255)}`;
    expect(roundTrip(plain)).toEqual(Buffer.from(plain));
  });

  it("survives data with no runs at all, where the run codes never appear", () => {
    const plain = "ab".repeat(5000);
    expect(roundTrip(plain)).toEqual(Buffer.from(plain));
  });

  it("survives every byte value, so the symbol map is exercised across all 16 groups", () => {
    // A JSONL dump is ASCII, which uses a handful of the sixteen symbol-map
    // groups. Binary exercises all of them, and with them the full alphabet.
    const plain = Buffer.from(Array.from({ length: 256 }, (_, i) => i).flatMap((b) => [b, b, b]));
    expect(roundTrip(plain)).toEqual(plain);
  });

  it("survives a single byte, and a single repeated byte", () => {
    expect(roundTrip("a")).toEqual(Buffer.from("a"));
    expect(roundTrip("aaaa")).toEqual(Buffer.from("aaaa"));
  });

  it("spans multiple blocks", () => {
    // At level 1 a block holds 100k, so 250k is three blocks and the decoder has
    // to carry nothing between them. One shared array reused across blocks is the
    // classic bug, and it shows up only past the first boundary.
    let seed = 7;
    let plain = "";
    for (let i = 0; i < 250_000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      plain += String.fromCharCode(97 + (seed % 26));
    }
    const out = roundTrip(plain, "-1");
    expect(out.length).toBe(plain.length);
    expect(out).toEqual(Buffer.from(plain));
  });

  it("agrees with the reference on incompressible input, the worst case for the tables", () => {
    let seed = 99;
    const bytes = new Uint8Array(120_000);
    for (let i = 0; i < bytes.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      bytes[i] = seed & 0xff;
    }
    const plain = Buffer.from(bytes);
    expect(roundTrip(plain, "-1")).toEqual(plain);
  });
});
