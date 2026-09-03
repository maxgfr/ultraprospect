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
  it("explains when coordinate-less register records make scored fusion impossible", async () => {
    const source = loadFixture(fixture);
    const dir = outDir();
    writeFileSync(join(dir, "target.json"), JSON.stringify(source.target));
    writeFileSync(join(dir, "osm.json"), JSON.stringify(source.osm));
    writeFileSync(join(dir, "registry.json"), JSON.stringify(source.registry.map(({ lat: _lat, lon: _lon, ...record }) => record)));

    const outcome = await runScan(source.target, { fixture: dir });
    const registryLane = outcome.manifest.lanes.find((lane) => lane.lane === "registry");

    expect(registryLane?.reason).toContain("could not run");
    expect(outcome.manifest.counts.registryWithCoordinates).toBe(0);
  });

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

  it("records legal-form include and exclude lists in the manifest", async () => {
    const target = loadFixture(fixture).target;
    const outcome = await runScan(target, { fixture, legalForms: ["5710"], excludeLegalForms: ["9110", "9220"] });

    expect(outcome.manifest.filters.legalForms).toEqual(["5710"]);
    expect(outcome.manifest.filters.excludeLegalForms).toEqual(["9110", "9220"]);
  });

  it("says when a legacy register filter leaves the OSM lane sweeping the whole catalogue", async () => {
    const source = loadFixture(fixture);
    const outcome = await runScan(source.target, { fixture, sections: ["I"] });

    expect(outcome.manifest.notes).toContain(
      `these filters narrow only the register lane; the OSM lane swept the whole catalogue (${source.osm.length} rows) — pass --category to narrow both`,
    );
    expect(outcome.manifest.filters.narrowedLanes).toEqual(["registry"]);
  });

  it("does not report a half-narrowed run when --category was supplied", async () => {
    const source = loadFixture(fixture);
    const outcome = await runScan(source.target, { fixture, sections: ["I"], categories: ["amenity=cafe", "naf=56.30Z"] });

    expect(outcome.manifest.notes.some((note) => note.includes("filters narrow only the register lane"))).toBe(false);
    expect(outcome.manifest.filters.narrowedLanes).toBeUndefined();
  });

  it("records minEmployees and asks the fixture connector to translate it into size bands", async () => {
    const source = loadFixture(fixture);
    const outcome = await runScan(source.target, { fixture, minEmployees: 10 });

    expect(outcome.manifest.filters.minEmployees).toBe(10);
    expect(outcome.manifest.filters.sizeBands).toEqual(["11", "12", "21", "22", "31", "32", "41", "42", "51", "52", "53"]);
  });

  it("refuses a size filter when the fixture connector cannot honour it", async () => {
    const source = loadFixture(fixture);
    const dir = outDir();
    writeFileSync(join(dir, "target.json"), JSON.stringify({ ...source.target, countryCode: "gb" }));
    writeFileSync(join(dir, "osm.json"), JSON.stringify(source.osm));
    writeFileSync(join(dir, "registry.json"), JSON.stringify(source.registry.map((record) => ({ ...record, connectorId: "gb-companies-house" }))));

    await expect(runScan({ ...source.target, countryCode: "gb" }, { fixture: dir, minEmployees: 10 })).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/gb-companies-house.*size/i),
    });
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
