// `--no-people` is given once, to `scan`, and has to hold for the whole run.
//
// It used to bind that one command. The names were stripped before the first
// write, then `enrich` read the managing directors off the Impressum and
// `confirm` attached a register record with its officers, and a run that said
// it held organisation data only held them again. These drive each later stage
// against a run whose manifest carries the choice, and against one that does
// not — the second half is what proves the pages really named somebody.
//
// The engine's fetchers are mocked: `tests/setup.ts` forbids live network.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryConnector } from "../src/registry/types.js";
import type { Place, RunManifest } from "../src/types.js";
import { rec } from "./factories.js";

const IMPRESSUM = [
  "Impressum",
  "Siebert Backwaren GmbH, Warschauer Straße 12, 10243 Berlin.",
  "Geschäftsführer: Chris Kahlefendt",
  "Wir backen seit 1987 in Friedrichshain und liefern an Cafés und Kantinen in der ganzen Stadt.",
].join("\n");

vi.mock("../src/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine.js")>()),
  fetchRobots: async () => undefined,
  fetchSitemap: async () => ({ urls: [] }),
  fetchAndExtract: async (url: string) => ({ status: 200, text: IMPRESSUM, html: "<p>Impressum</p>", finalUrl: url }),
  cachedFetchAndExtract: async (url: string) => ({ status: 200, text: IMPRESSUM, finalUrl: url }),
}));

/** What `connectorsFor` answers inside `confirm`. The table itself stays real. */
let confirmWith: RegistryConnector[] = [];
vi.mock("../src/registry/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/registry/index.js")>();
  return {
    ...real,
    connectorsFor: (...args: Parameters<typeof real.connectorsFor>) =>
      confirmWith.length ? { confirm: confirmWith, unavailable: [] } : real.connectorsFor(...args),
  };
});

const { createServer } = await import("../src/engine.js");
const { createAdapter } = await import("../src/mcp/adapter.js");
const { main } = await import("../src/cli.js");
const { runConfirm } = await import("../src/confirm.js");
const { buildAll } = await import("../src/render.js");
const { emptyManifest } = await import("../src/run.js");
const { runScan } = await import("../src/scan.js");
const { holdNoPeople } = await import("../src/no-people.js");

function bakery(over: Partial<Place> = {}): Place {
  return {
    id: "osm:n1",
    name: "Siebert Backwaren",
    sources: ["osm"],
    address: { commune: "Berlin", codePostal: "10243" },
    website: { url: "https://siebert.example/", confidence: "corroborated", evidence: ["P0"] },
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
    ...over,
  };
}

function manifestFor(noPeople: boolean): RunManifest {
  const m = emptyManifest("Berlin");
  m.target = { query: "Berlin", label: "Berlin, Deutschland", lat: 52.5, lon: 13.4, bbox: [52.3, 52.7, 13.1, 13.8], countryCode: "de", source: "nominatim" };
  if (noPeople) m.filters = { noPeople: true };
  return m;
}

/** A run on disk, scanned with or without the flag. */
function runDir(noPeople: boolean, places: Place[] = [bakery()]): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ultraprospect-no-people-")), "runs", "berlin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifestFor(noPeople)));
  writeFileSync(join(dir, "places.json"), JSON.stringify(places));
  return dir;
}

const placesOf = (dir: string): Place[] => JSON.parse(readFileSync(join(dir, "places.json"), "utf8"));

beforeEach(() => {
  confirmWith = [];
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("scan records the choice", () => {
  it("writes filters.noPeople into the manifest, and only when the flag was given", async () => {
    const fixture = join(import.meta.dirname, "..", "assets", "fixtures", "vincennes");
    const { loadFixture } = await import("../src/fixture.js");
    const target = loadFixture(fixture).target;
    expect((await runScan(target, { fixture, noPeople: true })).manifest.filters.noPeople).toBe(true);
    expect((await runScan(target, { fixture })).manifest.filters).not.toHaveProperty("noPeople");
  });
});

describe("enrich keeps no person a page named, on a run scanned with --no-people", () => {
  it("through the CLI", async () => {
    const open = runDir(false);
    await main(["enrich", "--run", open, "--tier", "1"]);
    expect(placesOf(open)[0]!.contacts.people.map((p) => p.value)).toContain("Chris Kahlefendt");

    const bound = runDir(true);
    await main(["enrich", "--run", bound, "--tier", "1"]);
    const place = placesOf(bound)[0]!;
    expect(place.contacts.people).toEqual([]);
    // The stage still did its work: the pages were read and are on the record.
    expect(place.pages.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(join(bound, "manifest.json"), "utf8")).notes.join("\n")).toContain("--no-people");
  });

  it("through the MCP tool", async () => {
    const call = async (run: string) => {
      const sent: any[] = [];
      await createServer(createAdapter()).handle(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ultraprospect_enrich", arguments: { run } } } as never,
        (m: unknown) => {
          sent.push(m);
        },
      );
      return sent.at(-1);
    };
    const open = runDir(false);
    await call(open);
    expect(placesOf(open)[0]!.contacts.people.length).toBeGreaterThan(0);

    const bound = runDir(true);
    const reply = await call(bound);
    expect(placesOf(bound)[0]!.contacts.people).toEqual([]);
    expect(JSON.stringify(reply)).toContain("--no-people");
  });
});

describe("confirm attaches a record without its officers, on a run scanned with --no-people", () => {
  const record = () =>
    rec({
      connectorId: "fake",
      id: "HRB158855",
      legalName: "Siebert Backwaren GmbH",
      names: ["Siebert Backwaren GmbH"],
      countryCode: "de",
      officers: [{ nom: "KAHLEFENDT", prenoms: "Chris", qualite: "Geschäftsführer" }],
    });
  const connector = (): RegistryConnector => ({
    id: "fake",
    countries: ["*"],
    label: "fake",
    licence: "fake licence",
    activityScheme: "none",
    activityPrefix: "fake",
    docsUrl: "https://example.invalid/docs",
    availability: () => ({ available: true }),
    canary: async () => [],
    probe: async () => ({ ok: true, detail: "" }),
    lookup: async () => [record()],
  });

  it("leaves them off the place and off the records bound for registry.json", async () => {
    confirmWith = [connector()];
    const place = bakery({ website: undefined });
    const outcome = await runConfirm(runDir(true, [place]), [place], { countryCode: "de" });
    expect(outcome.matched).toBe(1);
    expect(place.registry?.legalName).toBe("Siebert Backwaren GmbH");
    expect(place.registry?.officers).toEqual([]);
    expect(outcome.records[0]!.officers).toEqual([]);
  });

  it("keeps them on a run that never asked for --no-people", async () => {
    confirmWith = [connector()];
    const place = bakery({ website: undefined });
    await runConfirm(runDir(false, [place]), [place], { countryCode: "de" });
    expect(place.registry?.officers).toHaveLength(1);
  });
});

describe("render strips without being asked again", () => {
  const withNames = () =>
    bakery({
      registry: rec({ officers: [{ nom: "KAHLEFENDT", prenoms: "Chris", qualite: "Gérant" }] }),
      contacts: { emails: [], phones: [], socials: [], people: [{ value: "Marta Nowak", role: "CEO", from: "P1", lane: "web" }] },
    });

  it("applies noPeople to every deliverable when the manifest says the run was scanned with it", () => {
    const outcome = buildAll([withNames()], manifestFor(true));
    for (const file of outcome.files) {
      expect(file.content, file.path).not.toContain("KAHLEFENDT");
      expect(file.content, file.path).not.toContain("Marta Nowak");
    }
    expect(outcome.files.map((f) => f.path)).not.toContain("PRIVACY.md");
  });

  it("still hands the names over on a run that holds them by choice", () => {
    const outcome = buildAll([withNames()], manifestFor(false));
    expect(outcome.files.find((f) => f.path === "prospects.json")!.content).toContain("KAHLEFENDT");
    expect(outcome.files.map((f) => f.path)).toContain("PRIVACY.md");
  });
});

describe("holdNoPeople", () => {
  it("removes people and officers in place and says how many, only on a bound run", () => {
    const person = { value: "Marta Nowak", from: "P1", lane: "web" as const };
    const bound = [bakery({ registry: rec({ officers: [{ nom: "MARTIN" }] }), contacts: { emails: [], phones: [], socials: [], people: [person] } })];
    expect(holdNoPeople(manifestFor(true), bound)).toBe(2);
    expect(bound[0]!.contacts.people).toEqual([]);
    expect(bound[0]!.registry?.officers).toEqual([]);

    const open = [bakery({ contacts: { emails: [], phones: [], socials: [], people: [person] } })];
    expect(holdNoPeople(manifestFor(false), open)).toBe(0);
    expect(open[0]!.contacts.people).toHaveLength(1);
  });
});
