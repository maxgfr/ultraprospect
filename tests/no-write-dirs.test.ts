// `--stdout` writes nothing — not even an empty directory.
//
// Every artifact goes through the engine's writeArtifact, which collects
// instead of writing when writing is off. The run directory and a recorded
// fixture's directory were created with a bare mkdirSync before that, so
// "write nothing" still left runs/<slug>-<id>/ on disk.
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetNoWrite, setNoWrite, takeArtifacts } from "../src/engine.js";
import { recordFixture } from "../src/fixture.js";
import { newRun } from "../src/run.js";
import type { GeoTarget } from "../src/types.js";

const target: GeoTarget = { query: "Vincennes", label: "Vincennes", lat: 48.85, lon: 2.44, bbox: [48.84, 48.86, 2.42, 2.45], source: "nominatim" };

afterEach(() => {
  resetNoWrite();
  takeArtifacts();
});

describe("with writing off", () => {
  it("newRun names the run directory without creating it", () => {
    const root = mkdtempSync(join(tmpdir(), "ultraprospect-nowrite-"));
    setNoWrite(true);
    const run = newRun(root, "Vincennes, France");
    expect(run.dir.startsWith(join(root, "runs"))).toBe(true);
    expect(existsSync(run.dir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("recordFixture collects the three files and creates no directory", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ultraprospect-nowrite-")), "fixture");
    setNoWrite(true);
    recordFixture(dir, { osm: [], registry: [] }, target);
    expect(existsSync(dir)).toBe(false);
    expect(
      takeArtifacts()
        .map((a) => a.path)
        .sort(),
    ).toEqual(["osm.json", "registry.json", "target.json"].map((f) => join(dir, f)));
  });

  it("still creates the run directory when writing is on", () => {
    const root = mkdtempSync(join(tmpdir(), "ultraprospect-nowrite-"));
    expect(existsSync(newRun(root, "Vincennes").dir)).toBe(true);
  });
});
