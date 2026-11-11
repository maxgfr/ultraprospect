// A manifest count that did not mean what it said.
//
// `withWebsite` was the number of sites ON RECORD after `scan` (1 365 on a
// Hamburg run) and was overwritten with the number CORROBORATED after
// `resolve` (35), so it fell as work was done. It now keeps the first meaning
// and `corroboratedWebsites` carries the second.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Place, RunManifest } from "../src/types.js";

// resolve's network half is replaced: it proves the first place's site and
// leaves the other declared sites as they were.
vi.mock("../src/resolve.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/resolve.js")>()),
  runResolve: async (_runDir: string, places: Place[]) => {
    places[0]!.website = { url: "https://a.example", confidence: "corroborated", evidence: ["P1"] };
    return { pages: new Map(), corroborated: 1, rejected: 0, socialOnly: 0, jsOnly: 0, unreadable: 0, unchanged: 0, socials: 0, notes: [] };
  },
}));

const { main } = await import("../src/cli.js");
const { emptyManifest } = await import("../src/run.js");

function place(id: string, website?: string): Place {
  return {
    id,
    name: `Company ${id}`,
    sources: ["osm"],
    address: {},
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
    ...(website ? { website: { url: website, confidence: "declared" as const, evidence: ["osm"] } } : {}),
  };
}

function run(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ultraprospect-counts-")), "runs", "r");
  mkdirSync(dir, { recursive: true });
  const places = [place("osm:n1", "https://a.example"), place("osm:n2", "https://b.example"), place("osm:n3", "https://c.example"), place("osm:n4")];
  const manifest = emptyManifest("r");
  manifest.counts.places = places.length;
  manifest.counts.withWebsite = 3;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "places.json"), JSON.stringify(places));
  return dir;
}

const counts = (dir: string): RunManifest["counts"] => (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as RunManifest).counts;

describe("withWebsite after resolve", () => {
  it("still counts every site on record, and the proved ones are counted apart", async () => {
    const dir = run();
    const hits = join(dir, "..", "hits.json");
    writeFileSync(hits, JSON.stringify([{ url: "https://a.example", title: "A", snippet: "", placeId: "osm:n1" }]));
    await main(["resolve", "--run", dir, "--web-results", hits]);
    expect(counts(dir).withWebsite).toBe(3);
    expect(counts(dir).corroboratedWebsites).toBe(1);
  });

  it("starts at zero on a new manifest", () => {
    expect(emptyManifest("x").counts.corroboratedWebsites).toBe(0);
  });
});
