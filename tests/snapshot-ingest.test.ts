// `ingestSnapshot` against downloads that go wrong.
//
// Nothing here reaches the network: `fetch` is replaced per test by a fake that
// answers each candidate URL with a scripted Response, and the one that succeeds
// serves the trimmed German fixture export from disk.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("ingest — two at once", () => {
  const fromFile = join(import.meta.dirname, "fixtures", "snapshot", "offeneregister-sample.jsonl.bz2");
  const lockPath = () => join(cache, "snapshots", CONNECTOR, "ingest.lock");

  it("refuses a second ingest of the same connector while the first runs, and releases the lock after", async () => {
    // Both would append into the same shard files, interleaving their records
    // and indexing every one twice under a meta.json that vouches for it.
    const [first, second] = await Promise.allSettled([
      ingestSnapshot(CONNECTOR, offeneRegisterSnapshot, { fromFile }),
      ingestSnapshot(CONNECTOR, offeneRegisterSnapshot, { fromFile }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(String((second as PromiseRejectedResult).reason)).toContain(`another ingest of ${CONNECTOR} is already running (pid ${process.pid}`);
    expect(existsSync(lockPath())).toBe(false);
    // Each record once: the second ingest wrote nothing into the first one's shards.
    const meta = (first as PromiseFulfilledResult<Awaited<ReturnType<typeof ingestSnapshot>>>).value;
    expect(snapshotMeta(CONNECTOR)?.rows).toBe(meta.rows);
    // And once the first is done, the next one is let in.
    await expect(ingestSnapshot(CONNECTOR, offeneRegisterSnapshot, { fromFile })).resolves.toMatchObject({ rows: meta.rows });
  });

  it("takes over a lock whose process is gone", async () => {
    mkdirSync(join(cache, "snapshots", CONNECTOR), { recursive: true });
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lockPath(), JSON.stringify({ pid: gone, startedAt: new Date().toISOString() }));
    await expect(ingestSnapshot(CONNECTOR, offeneRegisterSnapshot, { fromFile })).resolves.toMatchObject({ connectorId: CONNECTOR });
    expect(existsSync(lockPath())).toBe(false);
  });

  it("takes over a lock older than any ingest takes, even if its pid is alive", async () => {
    // A pid outlives its process when the system reuses it; age is the backstop.
    mkdirSync(join(cache, "snapshots", CONNECTOR), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z" }));
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(lockPath(), yesterday, yesterday);
    await expect(ingestSnapshot(CONNECTOR, offeneRegisterSnapshot, { fromFile })).resolves.toMatchObject({ connectorId: CONNECTOR });
  });

  it("refuses while a fresh lock is held by a live process", async () => {
    mkdirSync(join(cache, "snapshots", CONNECTOR), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await expect(ingestSnapshot(CONNECTOR, offeneRegisterSnapshot, { fromFile })).rejects.toThrow(/already running/);
    // Somebody else's lock is left where it is.
    expect(existsSync(lockPath())).toBe(true);
  });
});
