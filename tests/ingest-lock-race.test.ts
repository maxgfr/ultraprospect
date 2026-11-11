// Two processes that find the same abandoned ingest lock at the same moment.
//
// Both read it, both judge it stale. The first takes it over and starts its
// ingest; the second must NOT then remove the first one's fresh lock and start
// a second ingest into the same shards. The take-over moves the stale file by
// rename and checks that what it moved is what it read, so the race is
// reproduced here by letting "the other process" take the lock in the gap
// between this process reading the stale lock and renaming it.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Set by the test: runs once, just before the stale lock is renamed aside. */
let beforeTakeover: (() => void) | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    // Whichever way a take-over removes the stale file — by rename now, by
    // deleting the path before — the other process wins the race just before it.
    rmSync: (path: string, opts?: Parameters<typeof real.rmSync>[1]) => {
      if (String(path).endsWith("ingest.lock") && beforeTakeover) {
        const hook = beforeTakeover;
        beforeTakeover = undefined;
        hook();
      }
      return real.rmSync(path, opts);
    },
    renameSync: (from: string, to: string) => {
      if (String(from).endsWith("ingest.lock") && String(to).includes(".stale-") && beforeTakeover) {
        const hook = beforeTakeover;
        beforeTakeover = undefined;
        hook();
      }
      return real.renameSync(from, to);
    },
  };
});

const { offeneRegisterSnapshot } = await import("../src/registry/de-offeneregister.js");
const { ingestSnapshot } = await import("../src/snapshot.js");

const CONNECTOR = "de-offeneregister";
const fromFile = join(import.meta.dirname, "fixtures", "snapshot", "offeneregister-sample.jsonl.bz2");
let cache = "";
const lockPath = () => join(cache, "snapshots", CONNECTOR, "ingest.lock");

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "ultraprospect-lock-race-"));
  process.env.ULTRAPROSPECT_CACHE_DIR = cache;
});

describe("taking over an abandoned ingest lock", () => {
  it("backs off when another process took the lock between the read and the take-over", async () => {
    mkdirSync(join(cache, "snapshots", CONNECTOR), { recursive: true });
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lockPath(), JSON.stringify({ pid: gone, startedAt: "2026-01-01T00:00:00.000Z" }));

    // The other process wins the race: its fresh lock replaces the stale one.
    const theirs = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), other: true });
    beforeTakeover = () => writeFileSync(lockPath(), theirs);

    await expect(ingestSnapshot(CONNECTOR, offeneRegisterSnapshot, { fromFile })).rejects.toThrow(/already running/);
    // Their lock is back where it was, untouched.
    expect(readFileSync(lockPath(), "utf8")).toBe(theirs);
  });

  it("still takes over the stale lock when nobody else does", async () => {
    mkdirSync(join(cache, "snapshots", CONNECTOR), { recursive: true });
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lockPath(), JSON.stringify({ pid: gone, startedAt: "2026-01-01T00:00:00.000Z" }));
    beforeTakeover = undefined;
    await expect(ingestSnapshot(CONNECTOR, offeneRegisterSnapshot, { fromFile })).resolves.toMatchObject({ connectorId: CONNECTOR });
  });
});
