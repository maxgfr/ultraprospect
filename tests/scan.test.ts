import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFixture } from "../src/fixture.js";
import { runScan, writeScan } from "../src/scan.js";
import type { GeoTarget, OsmPoi } from "../src/types.js";
import { rec } from "./factories.js";

const fixture = join(import.meta.dirname, "..", "assets", "fixtures", "vincennes");
const outDirs: string[] = [];

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ultraprospect-scan-"));
  outDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of outDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fixture identifier fusion", () => {
  it("records identifier yield and provenance without fabricating register records", async () => {
    const target = loadFixture(fixture).target;
    const outcome = await runScan(target, { fixture });

    expect(outcome.manifest.counts.mergedByIdentifier).toBeGreaterThanOrEqual(8);
    const identifierMerges = outcome.places.filter((place) => place.matchedBy === "identifier");
    expect(identifierMerges).toHaveLength(outcome.manifest.counts.mergedByIdentifier);
    expect(identifierMerges.every((place) => place.registryEvidence?.how === "osm-identifier")).toBe(true);
    expect(identifierMerges.every((place) => place.legalIds?.some((id) => id.from?.startsWith("osm:")))).toBe(true);
    expect(
      outcome.places.every((place) => {
        const unmatched = new Set(place.legalIds?.filter((id) => id.status === "unverified").map((id) => id.value));
        return !place.registry || (!unmatched.has(place.registry.id) && (!place.registry.establishmentId || !unmatched.has(place.registry.establishmentId)));
      }),
    ).toBe(true);
  });

  it("writes byte-identical places.json when the same fixture runs twice", async () => {
    const target = loadFixture(fixture).target;
    const first = await runScan(target, { fixture });
    const second = await runScan(target, { fixture });
    const firstDir = outDir();
    const secondDir = outDir();
    writeScan(firstDir, first);
    writeScan(secondDir, second);

    expect(readFileSync(join(firstDir, "places.json"), "utf8")).toBe(readFileSync(join(secondDir, "places.json"), "utf8"));
  });

  it("persists a note when identifier coordinates exceed the scoring gate", async () => {
    const dir = outDir();
    const target: GeoTarget = {
      query: "Far",
      label: "Far, France",
      lat: 48.84,
      lon: 2.43,
      bbox: [48.8, 48.9, 2.4, 2.5],
      countryCode: "fr",
      source: "nominatim",
    };
    const osm: OsmPoi[] = [{ id: "n1", osmType: "node", osmId: 1, name: "Different", lat: 48.84, lon: 2.43, tags: { "ref:FR:SIRET": "30247464801175" } }];
    writeFileSync(join(dir, "target.json"), JSON.stringify(target));
    writeFileSync(join(dir, "osm.json"), JSON.stringify(osm));
    writeFileSync(join(dir, "registry.json"), JSON.stringify([rec({ lat: 48.86, lon: 2.43 })]));

    const outcome = await runScan(target, { fixture: dir });

    expect(outcome.manifest.notes.some((note) => note.includes("150 m scoring gate"))).toBe(true);
  });
});
