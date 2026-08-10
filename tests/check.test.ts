// The gate, against a run built on disk.
//
// These are the tests that decide whether anything this tool emits can be
// trusted. Each one is a way a plausible, fluent, wrong output could otherwise
// ship — and the assertion is always that the run FAILS, not that it warns.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/check.js";
import type { Place, RunManifest } from "../src/types.js";

let runDir: string;

const PAGE_BODY = `# P1 — Les Officiers

- url: https://lesofficiers.fr/contact
- role: contact

---

Retrouvez-nous 3 Avenue de Nogent, 94300 Vincennes.

---

## Contacts in the markup

- mailto: reservation@lesofficiers.fr
- tel: +33 1 43 28 25 10
`;

function place(over: Partial<Place> = {}): Place {
  return {
    id: "osm:n1",
    name: "Les Officiers",
    sources: ["osm"],
    address: {},
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: ["P1"],
    ...over,
  };
}

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    tool: "ultraprospect",
    toolVersion: "0.0.0",
    builtAt: "",
    slug: "t",
    target: { query: "", label: "", lat: 0, lon: 0, bbox: [0, 0, 0, 0], source: "nominatim" },
    filters: {},
    lanes: [],
    counts: { osm: 0, sirene: 0, google: 0, places: 1, merged: 0, undecided: 0, withWebsite: 0, enrichedTier1: 0, enrichedTier2: 0, dossiers: 0 },
    truncated: false,
    notes: [],
    licences: [],
    timings: {},
    ...over,
  };
}

function writeDossier(placeId: string, body: string): void {
  mkdirSync(join(runDir, "dossiers"), { recursive: true });
  writeFileSync(join(runDir, "dossiers", `${placeId.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`), body);
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "ultraprospect-check-"));
  mkdirSync(join(runDir, "pages", "osm_n1"), { recursive: true });
  writeFileSync(join(runDir, "pages", "osm_n1", "P1.md"), PAGE_BODY);
});

afterEach(() => rmSync(runDir, { recursive: true, force: true }));

describe("contacts", () => {
  it("accepts one that is in the page, formatting differences and all", () => {
    // Stored as +33143282510, written on the page as +33 1 43 28 25 10.
    const p = place({
      contacts: {
        emails: [{ value: "reservation@lesofficiers.fr", from: "P1", lane: "web" }],
        phones: [{ value: "+33143282510", from: "P1", lane: "web" }],
        socials: [],
        people: [],
      },
    });
    const r = runCheck({ runDir, places: [p], manifest: manifest() });
    expect(r.errors).toEqual([]);
    expect(r.counts.contacts).toBe(2);
  });

  it("REJECTS a plausible address built from a naming convention", () => {
    // The whole reason this gate exists. The domain is real, the person is real
    // (the register names them), the page is real — and the address was never
    // published. It reads as correct and it will be emailed.
    const p = place({
      contacts: { emails: [{ value: "cyril.kolodziejski@lesofficiers.fr", from: "P1", lane: "web" }], phones: [], socials: [], people: [] },
    });
    const r = runCheck({ runDir, places: [p], manifest: manifest() });
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.rule).toBe("contact-not-on-page");
  });

  it("REJECTS a contact attributed to a page this run does not hold", () => {
    const p = place({ contacts: { emails: [{ value: "x@y.fr", from: "P77", lane: "web" }], phones: [], socials: [], people: [] } });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).errors[0]!.rule).toBe("contact-unsourced");
  });

  it("lets open-data provenance through — it is not a page and cannot be one", () => {
    const p = place({
      contacts: { emails: [], phones: [], socials: [], people: [{ value: "CYRIL KOLODZIEJSKI", from: "sirene", lane: "sirene", registry: true }] },
    });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).ok).toBe(true);
  });
});

describe("citations", () => {
  it("accepts a dossier whose every claim is cited or marked", () => {
    writeDossier(
      "osm:n1",
      "# Les Officiers\n\n**What they do.** A cafe-restaurant on Avenue de Nogent in Vincennes, per the register. [P1]\n\n**Angle.** Worth a call about booking software. [M]\n",
    );
    const r = runCheck({ runDir, places: [place()], manifest: manifest() });
    expect(r.errors).toEqual([]);
    expect(r.counts.citations).toBe(1);
  });

  it("REJECTS a citation that resolves to nothing", () => {
    writeDossier("osm:n1", "# X\n\n**What they do.** A long enough factual sentence to count as a claim about the world. [P9999]\n");
    const r = runCheck({ runDir, places: [place()], manifest: manifest() });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.rule === "citation-unresolved")).toBe(true);
  });

  it("REJECTS a citation belonging to another company", () => {
    // A page is evidence about the company it was fetched FOR. Borrowing one is
    // how a dossier ends up describing the neighbour's business.
    mkdirSync(join(runDir, "pages", "osm_n2"), { recursive: true });
    writeFileSync(join(runDir, "pages", "osm_n2", "P2.md"), "# P2\n\nsomething else entirely\n");
    writeDossier("osm:n1", "# X\n\n**What they do.** A long enough factual sentence to count as a claim about the world. [P2]\n");
    const r = runCheck({ runDir, places: [place(), place({ id: "osm:n2", pages: ["P2"] })], manifest: manifest() });
    expect(r.errors.map((e) => e.rule)).toContain("citation-foreign");
    // Guards the regex-state bug this test found: a shared global regex made
    // matchAll resume from the previous dossier's offset, so later dossiers
    // had their early citations skipped and the gate stopped checking them.
    expect(r.counts.citations).toBe(1);
  });

  it("REJECTS an uncited factual sentence", () => {
    writeDossier("osm:n1", "# X\n\n**What they do.** A long enough factual sentence to count as a claim about the world.\n");
    expect(runCheck({ runDir, places: [place()], manifest: manifest() }).errors.some((e) => e.rule === "claim-uncited")).toBe(true);
  });

  it("does not demand a citation on structure", () => {
    // Headings, separators, short labels and fenced blocks make no claims.
    // Demanding ids on them teaches whoever writes the dossier to sprinkle ids
    // to silence the gate, and then the ids stop meaning anything.
    writeDossier(
      "osm:n1",
      "# Title\n\n## Section\n\n---\n\n- **Contacts.**\n\n> a quote\n\n```\nsome code that is quite long and would otherwise look like a claim\n```\n\n| a | b |\n",
    );
    expect(runCheck({ runDir, places: [place()], manifest: manifest() }).ok).toBe(true);
  });

  it("REJECTS a dossier for a company this run does not contain", () => {
    writeDossier("osm:nope", "# Ghost\n\n**What they do.** A long enough factual sentence to count as a claim. [M]\n");
    const r = runCheck({ runDir, places: [place()], manifest: manifest() });
    expect(r.errors[0]!.rule).toBe("dossier-orphan");
    expect(r.errors[0]!.message).toContain("dossier --id");
  });
});

describe("warnings", () => {
  it("says loudly when the run is truncated", () => {
    const r = runCheck({ runDir, places: [place()], manifest: manifest({ truncated: true }) });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.rule === "run-truncated")).toBe(true);
  });

  it("flags a website that was fetched but corroborated nothing", () => {
    const p = place({ website: { url: "https://maybe.fr", confidence: "unverified", evidence: ["P1", "no corroboration"] } });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).warnings.some((w) => w.rule === "website-unverified")).toBe(true);
  });

  it("flags a site that could not be reached", () => {
    const p = place({
      signals: {
        hasWebsite: true,
        siteReachable: false,
        pageCount: 0,
        openRoles: 0,
        atsProviders: [],
        analytics: [],
        techStack: [],
        hasPricingPage: false,
        hasEcommerce: false,
        languages: [],
        socialProfiles: [],
      },
    });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).warnings.some((w) => w.rule === "site-unreachable")).toBe(true);
  });

  it("a warning never fails the run", () => {
    const r = runCheck({ runDir, places: [place()], manifest: manifest({ truncated: true }) });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.ok).toBe(true);
  });
});
