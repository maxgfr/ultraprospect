import { describe, expect, it } from "vitest";
import { describeFilters, foldNotes, summarise } from "../src/summary.js";
import type { Place, RunManifest } from "../src/types.js";
import { rec } from "./factories.js";

function place(over: Partial<Place> = {}): Place {
  return {
    id: "osm:n1",
    name: "Acme",
    sources: ["osm"],
    address: {},
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
    ...over,
  };
}

const signals = {
  hasWebsite: true,
  pageCount: 1,
  openRoles: 0,
  termMentions: [],
  atsProviders: [],
  analytics: [],
  techStack: [],
  hasPricingPage: false,
  hasEcommerce: false,
  languages: [],
  socialProfiles: [],
};

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    tool: "ultraprospect",
    toolVersion: "1.0.0",
    builtAt: "2026-08-10T00:00:00.000Z",
    slug: "Vincennes",
    target: { query: "Vincennes", label: "Vincennes, Val-de-Marne, France", lat: 48.8, lon: 2.4, bbox: [48.8, 48.9, 2.4, 2.5], source: "nominatim" },
    filters: {},
    lanes: [],
    counts: {
      osm: 0,
      registry: 0,
      byConnector: {},
      places: 0,
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
    ...over,
  };
}

describe("summarise", () => {
  it("keeps hiring three-valued", () => {
    // An unreadable job board is not an absence of hiring, and a summary that
    // folded it into `no` would invent a fact about a company in every
    // deliverable at once.
    const s = summarise(
      [
        place({ id: "a", signals: { ...signals, isHiring: true, openRoles: 3 } }),
        place({ id: "b", signals: { ...signals, isHiring: false } }),
        place({ id: "c", signals: { ...signals, isHiring: undefined, atsProviders: ["welcometothejungle"] } }),
        place({ id: "d" }),
      ],
      manifest(),
    );
    expect(s.hiring.yes).toBe(1);
    expect(s.hiring.no).toBe(1);
    expect(s.hiring.unknown).toBe(1);
    expect(s.hiring.roles).toBe(3);
    expect(s.hiring.ats).toEqual([["welcometothejungle", 1]]);
  });

  it("counts only the roles of companies we know are hiring", () => {
    // `openRoles` on a place whose board could not be read is a leftover, not a
    // count, and adding it to the total inflates the one number people quote.
    const s = summarise([place({ signals: { ...signals, isHiring: undefined, openRoles: 9 } })], manifest());
    expect(s.hiring.roles).toBe(0);
  });

  it("separates an attested identifier from a verified one", () => {
    // VIES confirms a German VAT number is live and refuses to name its holder.
    // That is a real, citable fact, and it is not an identity.
    const s = summarise(
      [
        place({
          legalIds: [
            { kind: "vat", value: "DE1", status: "attested", authority: "eu-vies" },
            { kind: "hrb", value: "HRB 1", status: "verified" },
            { kind: "vat", value: "FR1", status: "unverified" },
          ],
        }),
      ],
      manifest(),
    );
    expect(s.legalIds).toMatchObject({ verified: 1, attested: 1, unverified: 1, total: 3 });
  });

  it("splits register records by connector and by what attached them", () => {
    const s = summarise(
      [
        place({ id: "a", registry: rec({ connectorId: "gleif" }), registryEvidence: { mode: "confirm", how: "verified-id" } }),
        place({ id: "b", registry: rec({ connectorId: "gleif" }), registryEvidence: { mode: "confirm", how: "name-lookup" } }),
        place({ id: "c", registry: rec({ connectorId: "de-offeneregister" }), registryEvidence: { mode: "confirm", how: "name-lookup" } }),
        place({ id: "d" }),
      ],
      manifest(),
    );
    expect(s.registry.withRecord).toBe(3);
    expect(s.registry.byConnector).toEqual([
      ["gleif", 2],
      ["de-offeneregister", 1],
    ]);
    expect(s.registry.byEvidence).toEqual([
      ["by a name lookup", 2],
      ["by a published registration number", 1],
    ]);
  });

  it("names the years a dated register record was true", () => {
    const s = summarise(
      [
        place({ id: "a", registry: rec({ asOf: "2018-11-01" }) }),
        place({ id: "b", registry: rec({ asOf: "2017-01-01" }) }),
        place({ id: "c", registry: rec({}) }),
      ],
      manifest(),
    );
    expect(s.registry.dated).toEqual({ count: 2, years: ["2017", "2018"] });
  });

  it("bands the measured scores so a run of zeroes cannot hide behind its top fifty", () => {
    const s = summarise(
      [
        place({ id: "a", score: { total: 81, parts: {} } }),
        place({ id: "b", score: { total: 55, parts: {} } }),
        place({ id: "c", score: { total: 0, parts: {} } }),
        place({ id: "d" }),
      ],
      manifest(),
    );
    expect(s.scores.bands).toEqual([
      ["70+", 1],
      ["50–69", 1],
      ["30–49", 0],
      ["1–29", 0],
      ["0", 2],
    ]);
    expect(s.scores.max).toBe(81);
  });

  it("counts a declared website apart from a corroborated one", () => {
    // `declared` is a URL a mapper typed into OSM and nobody has checked.
    const site = (confidence: "declared" | "corroborated") => ({ url: "https://a.fr", confidence, evidence: ["P1"] });
    const s = summarise([place({ id: "a", website: site("corroborated") }), place({ id: "b", website: site("declared") }), place({ id: "c" })], manifest());
    expect(s.websites).toMatchObject({ corroborated: 1, declared: 1, none: 1 });
  });
});

describe("describeFilters", () => {
  it("reports what narrowed the run and stays silent about the defaults", () => {
    expect(describeFilters({ osmGroups: ["office", "shop"], includeCeased: false })).toEqual(["OSM `office`, `shop` tags only"]);
    // "all" is not a narrowing, and neither is excluding ceased companies.
    expect(describeFilters({ osmGroups: "all", includeCeased: false, activityCodes: null })).toEqual([]);
  });

  it("reports keeping ceased companies, which is not the default", () => {
    expect(describeFilters({ includeCeased: true })).toEqual(["ceased companies included"]);
  });

  it("reports a result cap, because it decides what could be found at all", () => {
    expect(describeFilters({ maxResults: 200 })).toEqual(["capped at 200 results"]);
  });
});

describe("foldNotes", () => {
  it("counts a repeated note instead of reprinting it", () => {
    const folded = foldNotes(["vies: nope", "vies: nope", "vies: nope"]);
    expect(folded).toMatchObject({ distinct: 1, emitted: 3 });
    expect(folded.lines).toEqual([{ text: "vies: nope", count: 3 }]);
  });

  it("puts the lane summaries first, however many times a per-company note repeats", () => {
    // The bug this replaces: `notes.slice(-25)` on a 1 447-note run printed
    // twenty-five VIES lines and dropped every summary of what the run did.
    const notes = [...Array.from({ length: 40 }, () => "vies: DE0 is not registered"), "confirm: 144 verified, 810 matched by name"];
    const folded = foldNotes(notes, 5);
    expect(folded.lines[0]).toEqual({ text: "confirm: 144 verified, 810 matched by name", count: 1 });
    expect(folded.lines[1]).toEqual({ text: "vies: DE0 is not registered", count: 40 });
  });

  it("orders the rest by how often the run said them", () => {
    const folded = foldNotes(["rare", "common", "common", "common", "mid", "mid"]);
    expect(folded.lines.map((l) => l.text)).toEqual(["common", "mid", "rare"]);
  });

  it("caps the list and reports how many distinct notes it holds", () => {
    const folded = foldNotes(
      Array.from({ length: 60 }, (_, i) => `note ${i}`),
      25,
    );
    expect(folded.lines).toHaveLength(25);
    expect(folded.distinct).toBe(60);
  });
});
