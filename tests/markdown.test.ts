// Text from outside cannot change the structure of a markdown deliverable:
// not in a table cell, and not in a heading or a bullet either.
import { describe, expect, it } from "vitest";
import { mdInline, mdLink } from "../src/markdown.js";
import { buildReport } from "../src/report.js";
import { analyseAwards, awardsMarkdown } from "../src/tenders/awards.js";
import { tendersReport } from "../src/tenders/report.js";
import { emptyTenderManifest } from "../src/tenders/run.js";
import type { Tender } from "../src/tenders/types.js";
import type { Place, RunManifest } from "../src/types.js";
import { buildDelta, diffRuns } from "../src/watch.js";

const HOSTILE = "Evil Corp\n# Owned\n[click](javascript:alert(1)) <img src=x onerror=alert(1)>";

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

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    tool: "ultraprospect",
    toolVersion: "1.0.0",
    builtAt: "2026-08-10T00:00:00.000Z",
    slug: "Vincennes",
    target: { query: "Vincennes", label: "Vincennes, France", lat: 48.8, lon: 2.4, bbox: [48.8, 48.9, 2.4, 2.5], source: "nominatim" },
    filters: {},
    lanes: [{ lane: "osm", requested: 0, returned: 1, truncated: false }],
    counts: {
      osm: 1,
      registry: 0,
      registryWithCoordinates: 0,
      byConnector: {},
      places: 1,
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

/** No line of the document may start with what the hostile value carried. */
function assertInert(doc: string): void {
  expect(doc).not.toMatch(/^# Owned/m);
  expect(doc).not.toMatch(/(?<!\\)\]\(javascript:/);
  expect(doc).not.toMatch(/(?<!\\)<img/);
  expect(doc).toContain("\\](javascript:");
}

describe("mdInline", () => {
  it("folds line breaks and escapes what opens a construct", () => {
    expect(mdInline("a\n\nb")).toBe("a b");
    expect(mdInline("[x](javascript:1)")).toBe("\\[x\\](javascript:1)");
    expect(mdInline("<b>*hi*</b>")).toBe("\\<b\\>\\*hi\\*\\</b\\>");
    expect(mdInline("# title")).toBe("\\# title");
    expect(mdInline("1. first")).toBe("1\\. first");
  });

  it("escapes a backslash already in front of a pipe, so the pipe stays escaped", () => {
    // `a\|b` used to become `a\\|b`: an escaped backslash, then a live pipe.
    expect(mdInline("a\\|b")).toBe("a\\\\\\|b");
  });
});

describe("mdLink", () => {
  it("links only http and https, with the destination fenced", () => {
    expect(mdLink("Notice", "https://x.example/a b)c")).toBe("[Notice](<https://x.example/a%20b)c>)");
    expect(mdLink("Notice", "javascript:alert(1)")).toBe("Notice");
    expect(mdLink("Notice", undefined)).toBe("Notice");
  });
});

describe("the deliverables", () => {
  it("REPORT.md keeps a hostile name and verdict inside their heading and paragraph", () => {
    const p = place({ name: HOSTILE, score: { total: 50, parts: {}, fit: "strong", why: HOSTILE, angle: HOSTILE } });
    const doc = buildReport([p], manifest({ notes: [HOSTILE], target: { ...manifest().target, label: HOSTILE } }));
    assertInert(doc);
    expect(doc).toMatch(/^### 1\. Evil Corp # Owned \\\[click\\\]/m);
  });

  it("DELTA.md keeps a hostile name inside its bullet", () => {
    const doc = buildDelta(diffRuns([], [place({ name: HOSTILE, address: { commune: HOSTILE } })]), manifest(), manifest());
    assertInert(doc);
  });

  it("the tenders report keeps a pipe or a newline in a title inside its cell", () => {
    const t: Tender = {
      id: "eu-ted:1",
      connectorId: "eu-ted",
      noticeId: "1",
      country: "fr",
      kind: "call",
      status: "open",
      title: "Lot 1 | Lot 2\nsecond line",
      buyer: { name: HOSTILE },
      cpv: [],
      nature: "services",
      lots: [],
      documentsAccess: "unknown",
      places: [],
      criteria: [],
      awards: [],
      coverage: "above-threshold",
      aliases: [],
      sourceUrl: "https://ted.europa.eu/en/notice/-/detail/1",
      verdict: { id: "eu-ted:1", decision: "go", fit: "strong", why: HOSTILE, at: "2026-11-01T00:00:00Z" },
    };
    const doc = tendersReport([t], emptyTenderManifest("fr", {}));
    assertInert(doc);
    const row = doc.split("\n").find((l) => l.includes("Lot 1"))!;
    // Eight columns: nine delimiters once escaped pipes are left alone.
    expect(row.split(/(?<!\\)\|/)).toHaveLength(10);
    expect(row).toContain("[Lot 1 \\| Lot 2 second line](<https://ted.europa.eu/en/notice/-/detail/1>)");
  });

  it("AWARDS.md keeps a supplier name inside its cell", () => {
    const award: Tender = {
      id: "eu-ted:2",
      connectorId: "eu-ted",
      noticeId: "2",
      country: "fr",
      kind: "award",
      status: "awarded",
      title: "Maintenance",
      buyer: { name: "Ville" },
      cpv: [],
      nature: "services",
      lots: [],
      documentsAccess: "unknown",
      places: [],
      criteria: [],
      awards: [{ supplier: { name: HOSTILE } }],
      coverage: "above-threshold",
      aliases: [],
    };
    assertInert(awardsMarkdown(analyseAwards([award]), { truncated: false, gaps: [], title: "x" }));
  });
});
