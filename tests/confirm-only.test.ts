// `confirm --only`, through the command itself.
//
// The selection has to reach the command's own pre-flight, not just the pass:
// "is there a fetched page to read a legal notice from" is a question about the
// places this invocation was aimed at. Asked of the whole run, `--only` naming
// three places without a page would start three name lookups — the weak half
// the command exists to refuse doing silently.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

/** A German run of two places: one with a fetched page, one without. */
function run(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ultraprospect-confirm-only-")), "runs", "test-run");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      tool: "ultraprospect",
      toolVersion: "0.0.0",
      builtAt: "2026-11-10T00:00:00.000Z",
      slug: "test",
      target: { query: "Hamburg", label: "Hamburg, Germany", lat: 53.55, lon: 9.99, bbox: [0, 0, 0, 0], countryCode: "de", source: "nominatim" },
      filters: {},
      lanes: [{ lane: "osm", requested: 0, returned: 2, truncated: false }],
      counts: {
        osm: 2,
        registry: 0,
        registryWithCoordinates: 0,
        byConnector: {},
        places: 2,
        merged: 0,
        mergedByIdentifier: 0,
        undecided: 0,
        withWebsite: 0,
        enrichedTier1: 0,
        enrichedTier2: 0,
        confirmed: 0,
        dossiers: 0,
      },
      truncated: false,
      notes: [],
      licences: [],
      timings: {},
    }),
  );
  const place = (id: string, name: string, pages: string[]) => ({
    id,
    name,
    sources: ["osm"],
    address: { commune: "Hamburg" },
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages,
  });
  writeFileSync(join(dir, "places.json"), JSON.stringify([place("osm:n1", "Hafen Software GmbH", ["P1"]), place("osm:n2", "Elbe Logistik GmbH", [])]));
  return dir;
}

describe("confirm --only", () => {
  it("refuses a selection with no fetched page, although another place in the run has one", async () => {
    await expect(main(["confirm", "--run", run(), "--only", "osm:n2"])).rejects.toMatchObject({ exitCode: 2 });
  });

  it("does nothing, and says so, when no id names a place still waiting for a record", async () => {
    const dir = run();
    await expect(main(["confirm", "--run", dir, "--only", "osm:not-in-this-run"])).resolves.toBe(0);
    // Nothing was asked of anybody, so the run on disk is exactly as it was.
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).lanes).toHaveLength(1);
  });
});
