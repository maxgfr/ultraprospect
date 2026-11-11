// The file handles a snapshot lookup opens, and whether it gives them back.
//
// A lookup that reaches its limit stops reading its shard early. That `break`
// closed the readline interface and left the ReadStream under it paused with
// its file descriptor open — one leaked fd per capped lookup, which a long
// `confirm` run or the MCP server accumulates until EMFILE. `createReadStream`
// is wrapped here so every stream a lookup opens can be checked afterwards.
//
// The shard is written directly and made larger than one read chunk (64 KB):
// a shard small enough to be read whole reaches its end and closes itself,
// which would hide the leak.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { ReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fnv1a64 } from "../src/engine.js";

const opened: ReadStream[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    createReadStream: (...args: Parameters<typeof real.createReadStream>) => {
      const s = real.createReadStream(...args);
      opened.push(s);
      return s;
    },
  };
});

const { snapshotById, snapshotByLocality, snapshotKey } = await import("../src/snapshot.js");

const CONNECTOR = "leak-probe";
/** The shard a key is filed in — the same hash `snapshot.ts` uses. */
const bucketOf = (key: string) => (Number(fnv1a64(key) % 256n) | 0).toString(16).padStart(2, "0");

beforeAll(() => {
  const cache = mkdtempSync(join(tmpdir(), "ultraprospect-streams-"));
  process.env.ULTRAPROSPECT_CACHE_DIR = cache;
  const root = join(cache, "snapshots", CONNECTOR);
  mkdirSync(join(root, "loc"), { recursive: true });
  mkdirSync(join(root, "id"), { recursive: true });
  writeFileSync(join(root, "meta.json"), JSON.stringify({ connectorId: CONNECTOR, layoutVersion: 2, rows: 4000 }));

  const town = snapshotKey("Big Town");
  const id = snapshotKey("ID-1");
  const record = { connectorId: CONNECTOR, id: "ID-1", names: ["Probe Ltd"], legalName: "Probe Ltd", officers: [], address: { commune: "Big Town" } };
  const lines = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ l: town, k: [id], r: { ...record, legalName: `Probe ${i} Ltd` } }));
  writeFileSync(join(root, "loc", `${bucketOf(town)}.jsonl`), `${lines.join("\n")}\n`);
  writeFileSync(join(root, "id", `${bucketOf(id)}.jsonl`), `${JSON.stringify({ k: id, l: town })}\n`);
});

beforeEach(() => {
  opened.length = 0;
});

describe("a snapshot lookup that stops at its limit", () => {
  it("closes the locality shard it stopped reading", async () => {
    const hits = await snapshotByLocality(CONNECTOR, "Big Town", () => true, 1);
    expect(hits).toHaveLength(1);
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((s) => s.destroyed)).toBe(true);
  });

  it("closes every shard an identifier lookup read", async () => {
    const hits = await snapshotById(CONNECTOR, "ID-1", 1);
    expect(hits).toHaveLength(1);
    expect(opened.length).toBe(2);
    expect(opened.every((s) => s.destroyed)).toBe(true);
  });
});
