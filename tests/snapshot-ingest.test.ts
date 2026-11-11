// `ingestSnapshot` against downloads that go wrong.
//
// Nothing here reaches the network: `fetch` is replaced per test by a fake that
// answers each candidate URL with a scripted Response, and the one that succeeds
// serves the trimmed German fixture export from disk.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offeneRegisterSnapshot } from "../src/registry/de-offeneregister.js";
import { forgetSnapshot, ingestSnapshot, snapshotMeta, type SnapshotSource } from "../src/snapshot.js";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "snapshot", "offeneregister-sample.jsonl.bz2"));
const CONNECTOR = "ingest-probe";

/** A body that delivers a first chunk, then fails the way a reset connection does. */
function cutOffBody(): ReadableStream<Uint8Array> {
  let pulls = 0;
  return new ReadableStream({
    pull(c) {
      if (pulls++ === 0) c.enqueue(new Uint8Array(64 * 1024).fill(0x42));
      else c.error(new Error("connection reset midway"));
    },
  });
}

let cache: string;
const realFetch = global.fetch;

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "ultraprospect-ingest-"));
  process.env.ULTRAPROSPECT_CACHE_DIR = cache;
});

afterEach(() => {
  global.fetch = realFetch;
  forgetSnapshot(CONNECTOR);
});

const source = (urls: string[]): SnapshotSource => ({ ...offeneRegisterSnapshot, urls: () => urls });
const downloadPath = () => join(cache, "snapshots", CONNECTOR, "download.jsonl-bz2");

describe("ingest — a candidate URL that fails", () => {
  it("tries the next candidate after one that is cut off midway, and cancels an unread error body", async () => {
    let cancelled = false;
    const errorBody = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const asked: string[] = [];
    global.fetch = (async (input: any) => {
      const url = String(input);
      asked.push(url);
      if (url.endsWith("/missing")) return new Response(errorBody, { status: 404 });
      if (url.endsWith("/cut")) return new Response(cutOffBody(), { status: 200 });
      return new Response(FIXTURE, { status: 200 });
    }) as typeof fetch;

    const meta = await ingestSnapshot(CONNECTOR, source(["https://x.invalid/missing", "https://x.invalid/cut", "https://x.invalid/good"]));
    expect(asked).toEqual(["https://x.invalid/missing", "https://x.invalid/cut", "https://x.invalid/good"]);
    expect(meta.sourceUrl).toBe("https://x.invalid/good");
    expect(meta.rows).toBeGreaterThan(0);
    expect(cancelled).toBe(true);
  });

  it("deletes the partial file when every candidate fails, and names each failure", async () => {
    global.fetch = (async () => new Response(cutOffBody(), { status: 200 })) as typeof fetch;
    await expect(ingestSnapshot(CONNECTOR, source(["https://x.invalid/a", "https://x.invalid/b"]))).rejects.toThrow(
      /a → connection reset midway; https:\/\/x\.invalid\/b → connection reset midway/,
    );
    expect(existsSync(downloadPath())).toBe(false);
    expect(snapshotMeta(CONNECTOR)).toBeUndefined();
  });
});
