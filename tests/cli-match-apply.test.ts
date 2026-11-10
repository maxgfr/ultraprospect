// `match --apply`, end to end over a run on disk.
//
// The fold changed places.json and the manifest and left MATCH.todo.json as
// `scan` had written it. A second pass, or a fan-out re-emitted from that file,
// was then handed every pair that had already been answered — and answering one
// again is reported as an unknown pair. The worklist is the one file that says
// what is still open, so it has to be the one that is kept current.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { emptyManifest } from "../src/run.js";
import type { MatchCandidate, MatchTodo, Place, RunManifest } from "../src/types.js";
import { rec } from "./factories.js";

const shop = (n: number, name: string): Place => ({
  id: `osm:n${n}`,
  name,
  sources: ["osm"],
  osm: { id: `n${n}`, osmType: "node", osmId: n, name, lat: 48.8475, lon: 2.4397, tags: {} },
  address: {},
  contacts: { emails: [], phones: [], socials: [], people: [] },
  jobs: [],
  pages: [],
});

const filed = (id: string, name: string): Place => ({
  id: `fr-sirene:${id}`,
  name,
  sources: ["registry"],
  registry: rec({ establishmentId: id, legalName: name }),
  registryEvidence: { mode: "sweep", how: "sweep-match" },
  address: {},
  contacts: { emails: [], phones: [], socials: [], people: [] },
  jobs: [],
  pages: [],
});

const pair = (osmId: string, registryId: string, score: number): MatchCandidate => ({
  osmId,
  connectorId: "fr-sirene",
  registryId,
  score,
  parts: { distance: 0.9, name: 0.4, enseigne: 0, address: 0 },
  distanceM: 12,
});

function run(pairs: MatchCandidate[] | undefined): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ultraprospect-match-")), "runs", "vincennes");
  mkdirSync(dir, { recursive: true });
  const manifest = emptyManifest("Vincennes");
  manifest.counts.places = 6;
  manifest.counts.undecided = 3;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(dir, "places.json"),
    JSON.stringify([
      shop(1, "Naturalia"),
      shop(2, "Aux Papilles"),
      shop(3, "Synotis"),
      filed("A", "NATURALIA FRANCE"),
      filed("B", "BRUNO ENCAOUA"),
      filed("C", "SYNALTIC"),
    ]),
  );
  if (pairs) writeFileSync(join(dir, "MATCH.todo.json"), JSON.stringify({ version: 1, generatedAt: "2026-11-01T00:00:00.000Z", pairs } satisfies MatchTodo));
  return dir;
}

const read = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8"));

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("match --apply keeps the worklist current", () => {
  const verdicts = [
    { osmId: "n1", registryId: "A", connectorId: "fr-sirene", merge: true, why: "same sign, same door" },
    { osmId: "n2", registryId: "B", connectorId: "fr-sirene", merge: false, why: "a tenant of the same building" },
  ];

  it("drops the answered pairs from MATCH.todo.json and counts what is left", async () => {
    const dir = run([pair("n1", "A", 0.6512), pair("n2", "B", 0.6), pair("n3", "C", 0.55)]);
    const file = join(dir, "verdicts.json");
    writeFileSync(file, JSON.stringify(verdicts));

    expect(await main(["match", "--run", dir, "--apply", file])).toBe(0);

    expect(read<MatchTodo>(dir, "MATCH.todo.json").pairs).toEqual([pair("n3", "C", 0.55)]);
    expect(read<RunManifest>(dir, "manifest.json").counts.undecided).toBe(1);
    const merged = read<Place[]>(dir, "places.json").find((p) => p.id === "osm:n1")!;
    expect(merged.registry?.establishmentId).toBe("A");
    // The score the pair was listed with, not a certainty nobody measured.
    expect(merged.matchConfidence).toBe(0.651);
  });

  it("still folds a run that has no worklist on disk, and writes none", async () => {
    const dir = run(undefined);
    const file = join(dir, "verdicts.json");
    writeFileSync(file, JSON.stringify(verdicts));

    expect(await main(["match", "--run", dir, "--apply", file])).toBe(0);

    expect(() => readFileSync(join(dir, "MATCH.todo.json"))).toThrow();
    expect(read<RunManifest>(dir, "manifest.json").counts.undecided).toBe(1);
    expect(read<Place[]>(dir, "places.json").find((p) => p.id === "osm:n1")).not.toHaveProperty("matchConfidence");
  });
});
