// What an index is allowed to claim after an ingest that did not finish.
//
// `meta.json` is the claim: `hasSnapshot` reads it, and every lane that finds it
// sweeps the shards beside it as "every company the register files there". So
// an ingest that fails partway, or that was told to stop early, must not leave
// that claim standing over shards that do not back it.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { companiesHouseSnapshot, gbCompaniesHouse } from "../src/registry/gb-companies-house.js";
import { hasSnapshot, ingestSnapshot, partialIngestNote, snapshotMeta } from "../src/snapshot.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "snapshot");
const SAMPLE = join(FIXTURES, "companies-house-sample.zip");
const ID = "gb-companies-house";

const hebdenBridge = {
  query: "Hebden Bridge",
  label: "Hebden Bridge",
  lat: 53.7,
  lon: -2,
  bbox: [0, 0, 0, 0] as [number, number, number, number],
  countryCode: "gb",
  source: "nominatim" as const,
};

let scratch = "";

beforeEach(() => {
  // A cache per test: each one leaves the index in a different state on purpose.
  scratch = mkdtempSync(join(tmpdir(), "ultraprospect-ingest-"));
  process.env.ULTRAPROSPECT_CACHE_DIR = scratch;
});

describe("an ingest that fails partway", () => {
  it("does not leave the previous meta standing over a half-written index", async () => {
    await ingestSnapshot(ID, companiesHouseSnapshot, { fromFile: SAMPLE });
    expect(hasSnapshot(ID)).toBe(true);

    // This month's file arrives truncated: a zip with its directory cut off.
    const broken = join(scratch, "truncated.zip");
    writeFileSync(broken, readFileSync(SAMPLE).subarray(0, 120));
    await expect(ingestSnapshot(ID, companiesHouseSnapshot, { fromFile: broken })).rejects.toThrow();

    expect(hasSnapshot(ID)).toBe(false);
    expect(gbCompaniesHouse.availability({}).available).toBe(false);
    const swept = await gbCompaniesHouse.sweep!(hebdenBridge, {}, {});
    expect(swept.records).toEqual([]);
    expect(swept.coverage.truncated).toBe(true);
  });

  it("leaves no meta at all when the very first ingest fails", async () => {
    const broken = join(scratch, "not-a-zip.zip");
    writeFileSync(broken, "this is not an archive");
    await expect(ingestSnapshot(ID, companiesHouseSnapshot, { fromFile: broken })).rejects.toThrow();
    expect(hasSnapshot(ID)).toBe(false);
  });
});

describe("an ingest stopped by --limit", () => {
  it("records that it is a sample, and a sweep of it says so instead of claiming the register", async () => {
    const meta = await ingestSnapshot(ID, companiesHouseSnapshot, { fromFile: SAMPLE, limit: 1 });
    expect(meta.rows).toBe(1);
    expect(meta.limited).toBe(1);
    expect(snapshotMeta(ID)?.limited).toBe(1);

    const swept = await gbCompaniesHouse.sweep!(hebdenBridge, {}, {});
    expect(swept.coverage.truncated).toBe(true);
    expect(swept.coverage.reason).toContain("PARTIAL INGEST");
    expect(swept.coverage.reason).toContain("--limit 1");
    expect(swept.notes.some((n) => n.includes("PARTIAL INGEST"))).toBe(true);
  });

  it("says nothing of the kind about an ingest that read the whole file", async () => {
    const meta = await ingestSnapshot(ID, companiesHouseSnapshot, { fromFile: SAMPLE });
    expect(meta.limited).toBeUndefined();
    expect(partialIngestNote(meta)).toBeUndefined();
    // A limit the file never reached is not a partial ingest either.
    const roomy = await ingestSnapshot(ID, companiesHouseSnapshot, { fromFile: SAMPLE, limit: 1000 });
    expect(roomy.limited).toBeUndefined();
    const swept = await gbCompaniesHouse.sweep!(hebdenBridge, {}, {});
    expect(swept.coverage.truncated).toBe(false);
    expect(swept.coverage.reason).not.toContain("PARTIAL");
  });
});
