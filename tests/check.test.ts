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
import { rec } from "./factories.js";

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
    counts: {
      osm: 0,
      registry: 0,
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

function writeDossier(placeId: string, body: string): void {
  mkdirSync(join(runDir, "dossiers"), { recursive: true });
  writeFileSync(join(runDir, "dossiers", `${placeId.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`), body);
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "ultraprospect-check-"));
  mkdirSync(join(runDir, "pages", "osm_n1"), { recursive: true });
  writeFileSync(join(runDir, "pages", "osm_n1", "P1.md"), PAGE_BODY);
  writeFileSync(
    join(runDir, "osm.json"),
    JSON.stringify([
      {
        id: "n1",
        osmType: "node",
        osmId: 1,
        lat: 48.84,
        lon: 2.43,
        tags: {
          email: "OSM@Example.FR",
          phone: "+33 1 43 28 30 07",
          "contact:facebook": "https://facebook.com/osm-example",
          "ref:FR:SIRET": "30247464801175",
        },
      },
    ]),
  );
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
      contacts: { emails: [], phones: [], socials: [], people: [{ value: "CYRIL KOLODZIEJSKI", from: "registry", lane: "registry", registry: true }] },
    });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).ok).toBe(true);
  });

  it("accepts an OSM contact that is still present in the feature's contact tags", () => {
    const p = place({
      contacts: {
        emails: [{ value: "osm@example.fr", from: "osm:n1", lane: "osm" }],
        phones: [{ value: "+33143283007", from: "osm:n1", lane: "osm" }],
        socials: [{ value: "https://facebook.com/osm-example", from: "osm:n1", lane: "osm" }],
        people: [],
      },
    });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).ok).toBe(true);
  });

  it("REJECTS an OSM contact value that is not in the feature's contact tags", () => {
    const p = place({
      contacts: { emails: [{ value: "invented@example.fr", from: "osm:n1", lane: "osm" }], phones: [], socials: [], people: [] },
    });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).errors[0]!.rule).toBe("contact-not-on-page");
  });

  it("REJECTS an OSM contact attributed to a feature this run does not hold", () => {
    const p = place({
      contacts: { emails: [{ value: "osm@example.fr", from: "osm:n999", lane: "osm" }], phones: [], socials: [], people: [] },
    });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).errors[0]!.rule).toBe("contact-unsourced");
  });

  it('REJECTS the old bare from: "osm" provenance', () => {
    const p = place({
      contacts: { emails: [{ value: "osm@example.fr", from: "osm", lane: "osm" }], phones: [], socials: [], people: [] },
    });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).errors[0]!.rule).toBe("contact-unsourced");
  });

  it("does not find a phone number in a non-contact OSM tag", () => {
    const p = place({
      contacts: { emails: [], phones: [{ value: "30247464801175", from: "osm:n1", lane: "osm" }], socials: [], people: [] },
    });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).errors[0]!.rule).toBe("contact-not-on-page");
  });

  it("REJECTS an OSM social that is not in the feature's contact tags", () => {
    const p = place({
      contacts: { emails: [], phones: [], socials: [{ value: "https://instagram.com/invented", from: "osm:n1", lane: "osm" }], people: [] },
    });
    expect(runCheck({ runDir, places: [p], manifest: manifest() }).errors[0]!.rule).toBe("contact-not-on-page");
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

  it("accepts a WRAPPED paragraph whose citation is at the end", () => {
    // Markdown wraps. A citation belongs at the end of the thing it supports,
    // and flagging the earlier lines of a paragraph punishes the author for
    // using a text width — the first real dossier produced 13 such errors
    // against one properly-cited paragraph.
    writeDossier(
      "osm:n1",
      "# X\n\n**What they do.** Renine is an Italian restaurant-pizzeria at 33 rue de\nStrasbourg in Vincennes, open Tuesday to Sunday, with a menu of more than\nfifty pizzas. [P1]\n",
    );
    expect(runCheck({ runDir, places: [place()], manifest: manifest() }).ok).toBe(true);
  });

  it("still rejects a wrapped paragraph with no citation anywhere in it", () => {
    writeDossier(
      "osm:n1",
      "# X\n\n**What they do.** Renine is an Italian restaurant-pizzeria at 33 rue de\nStrasbourg in Vincennes, open Tuesday to Sunday.\n",
    );
    expect(runCheck({ runDir, places: [place()], manifest: manifest() }).errors.some((e) => e.rule === "claim-uncited")).toBe(true);
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

        termMentions: [],
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

describe("a dated register record", () => {
  // Germany's only open register export stopped in 2019. A record from it is who
  // filed under that number THEN, and "is registered at" reads exactly like "was,
  // as of 2018-07" to everyone downstream — which is the same class of claim as a
  // confirmed territory presented as a swept one.
  const dated = () =>
    place({
      registry: {
        connectorId: "de-offeneregister",
        id: "Berlin (Charlottenburg) HRB 158855",
        names: ["Zalando SE"],
        legalName: "Zalando SE",
        officers: [],
        address: { commune: "Berlin" },
        countryCode: "de",
        status: "active",
        asOf: "2018-11-01",
      },
      pages: [],
    });

  it("FAILS a write-up that states it without its date", () => {
    writeDossier(
      "osm:n1",
      "# Zalando SE\n\n**Identity.** The company is registered at the Amtsgericht Charlottenburg under HRB 158855, and trades from Berlin. [M]\n",
    );
    const report = runCheck({ runDir, places: [dated()], manifest: manifest() });
    expect(report.ok).toBe(false);
    expect(report.errors.map((e) => e.rule)).toContain("dated-record-undated");
    // The message has to say what to write instead, not merely that it is wrong.
    expect(report.errors.find((e) => e.rule === "dated-record-undated")!.message).toContain("as of 2018-11");
  });

  it("passes once the date is stated", () => {
    writeDossier(
      "osm:n1",
      "# Zalando SE\n\n**Identity.** The register held HRB 158855 at the Amtsgericht Charlottenburg as of 2018-11-01, the date of the open-data snapshot this run used. [M]\n",
    );
    const report = runCheck({ runDir, places: [dated()], manifest: manifest() });
    expect(report.errors.map((e) => e.rule)).not.toContain("dated-record-undated");
  });

  it("says nothing about a LIVE record, which has no date to state", () => {
    // `asOf` absent means the register was asked just now. Demanding a date there
    // would train whoever writes the dossier to invent one.
    writeDossier("osm:n1", "# X\n\n**Identity.** The company is registered under SIREN 123456789 and trades from Vincennes. [M]\n");
    const live = place({ registry: { connectorId: "fr-sirene", id: "123456789", names: ["X"], officers: [], address: {}, status: "active" }, pages: [] });
    const report = runCheck({ runDir, places: [live], manifest: manifest() });
    expect(report.errors.map((e) => e.rule)).not.toContain("dated-record-undated");
  });
});

describe("a legal identifier is re-read the way it was written down", () => {
  // Found on a real German run: four identities were rejected because the
  // Impressum writes "HRB: 77491" with a colon, while the extractor records
  // "HRB 77491" — it has to, since no register accepts a colon in a lookup.
  // The gate then hunted the normalised form in the raw page and failed to
  // find it. The identity was genuine and re-readable; the gate's normaliser
  // simply did not strip the punctuation the extractor had.
  //
  // A gate that rejects true evidence is not "strict", it is broken: people
  // learn to pass --force, and then it stops catching the fabricated ones.
  const withId = (body: string) => {
    mkdirSync(join(runDir, "pages", "osm_n2"), { recursive: true });
    writeFileSync(join(runDir, "pages", "osm_n2", "P2.md"), `# P2\n\n- url: https://acme.de/impressum\n- role: legal\n\n---\n\n${body}\n`);
    return place({
      id: "osm:n2",
      pages: ["P2"],
      legalIds: [{ kind: "hrb", value: "HRB 77491", from: "P2", status: "verified" as const }],
    });
  };

  it.each([
    ["HRB: 77491", "a colon, as most Impressums write it"],
    ["HRB 77491", "a plain space"],
    ["HRB 77491", "a non-breaking space"],
    ["HRB / 77491", "a slash"],
    ["Amtsgericht Hamburg, HRB: 77.491", "a colon and a thousands dot"],
  ])("accepts %s (%s)", (body) => {
    const r = runCheck({ runDir, places: [withId(body)], manifest: manifest() });
    expect(r.errors.filter((e) => e.rule === "legal-id-not-on-page")).toEqual([]);
  });

  it("still rejects a number that is genuinely not on the page", () => {
    const r = runCheck({ runDir, places: [withId("Amtsgericht Hamburg, HRB: 11111")], manifest: manifest() });
    expect(r.errors.map((e) => e.rule)).toContain("legal-id-not-on-page");
  });

  it("accepts an OSM legal id that is present in the feature's ref tags", () => {
    const p = place({
      legalIds: [{ kind: "siret", value: "30247464801175", from: "osm:n1", status: "verified" }],
      registry: rec(),
      registryEvidence: { mode: "sweep", how: "osm-identifier", from: "osm:n1", legalId: "30247464801175" },
    });

    const r = runCheck({ runDir, places: [p], manifest: manifest() });

    expect(r.errors.filter((error) => error.rule === "legal-id-unsourced" || error.rule === "legal-id-not-on-page")).toEqual([]);
    expect(r.errors.map((error) => error.rule)).not.toContain("registry-evidence-unbacked");
  });

  it("rejects an OSM legal id that is absent from the feature's ref tags", () => {
    const p = place({
      legalIds: [{ kind: "siret", value: "99999999999999", from: "osm:n1", status: "verified" }],
      registry: rec({ establishmentId: "99999999999999" }),
      registryEvidence: { mode: "sweep", how: "osm-identifier", from: "osm:n1", legalId: "99999999999999" },
    });

    const r = runCheck({ runDir, places: [p], manifest: manifest() });

    expect(r.errors.map((error) => error.rule)).toContain("legal-id-not-on-page");
    expect(r.errors.map((error) => error.rule)).toContain("registry-evidence-unbacked");
  });

  it("rejects OSM identifier evidence that names a different registry record", () => {
    const p = place({
      legalIds: [{ kind: "siret", value: "30247464801175", from: "osm:n1", status: "verified", authority: "fr-sirene" }],
      registry: rec({ id: "999999999", establishmentId: "99999999999999" }),
      registryEvidence: { mode: "sweep", how: "osm-identifier", from: "osm:n1", legalId: "30247464801175" },
    });

    const r = runCheck({ runDir, places: [p], manifest: manifest() });

    expect(r.errors.map((error) => error.rule)).toContain("registry-evidence-unbacked");
  });
});
