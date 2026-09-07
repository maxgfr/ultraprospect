// Two ways the gate could be walked past, as regressions.
//
// 1. PROVENANCE OWNERSHIP. Every stored page and every OSM feature in a run is
//    evidence about ONE company. The gate re-read the cited source but never
//    asked whose it was, so a place could carry the neighbour's email address,
//    the neighbour's quote and the neighbour's VAT number and pass — each one
//    re-readable, each one about somebody else. `citation-foreign` already says
//    a dossier may not borrow a page; a contact may not borrow one either.
//
// 2. FACTUAL UNITS THAT ARE SHORT. Structure was recognised by LENGTH, so any
//    line under 40 characters, any table row and any block quote was exempt —
//    and `Revenue: 500 million euros.` is 27 characters. A number is the most
//    citable thing a dossier can contain and it was the easiest to smuggle in
//    uncited. Counting WORDS instead of characters moved the hole rather than
//    closing it: `Acme is hiring.` is three words, `Acme recrute.` is two, and
//    ``Employees: `500` `` hides its figure in a code span. The gate now asks
//    what a unit IS, not how much of it there is: prose, a data row and quoted
//    text all need a `[P#]` or an `[M]`, and only genuine Markdown structure —
//    headings, rules, fences, a table's scaffolding, a bare link, a bulleted
//    section label — is exempt.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CheckReport, runCheck } from "../src/check.js";
import type { OsmPoi, Place, RunManifest } from "../src/types.js";

let runDir: string;

/** The place under test, and the neighbour every foreign source belongs to. */
const N1: OsmPoi = {
  id: "n1",
  osmType: "node",
  osmId: 1,
  lat: 48.84,
  lon: 2.43,
  tags: { email: "first@example.com", "ref:FR:SIRET": "30247464801175" },
};
const N2: OsmPoi = {
  id: "n2",
  osmType: "node",
  osmId: 2,
  lat: 48.85,
  lon: 2.44,
  tags: { email: "other@example.com", "ref:FR:SIRET": "55210055400021" },
};

const P1_BODY = "# P1 — Acme\n\n- url: https://acme.fr/contact\n- role: contact\n\n---\n\nWrite to first@example.com. VAT DE811907980.\n";
const P2_BODY = "# P2 — Other\n\n- url: https://other.fr/contact\n- role: contact\n\n---\n\nWrite to other@example.com. VAT DE123456789.\n";

function place(over: Partial<Place> = {}): Place {
  return {
    id: "osm:n1",
    name: "Acme",
    sources: ["osm"],
    address: {},
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: ["P1"],
    ...over,
  };
}

/** The company the foreign page and the foreign feature actually describe. */
const neighbour = () => place({ id: "osm:n2", name: "Other", pages: ["P2"] });

function manifest(): RunManifest {
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
  };
}

function signals(termMentions: Place["contacts"]["emails"]): NonNullable<Place["signals"]> {
  return {
    hasWebsite: true,
    pageCount: 1,
    openRoles: 0,
    termMentions,
    atsProviders: [],
    analytics: [],
    techStack: [],
    hasPricingPage: false,
    hasEcommerce: false,
    languages: [],
    socialProfiles: [],
  };
}

function writeDossier(placeId: string, lines: string[]): void {
  mkdirSync(join(runDir, "dossiers"), { recursive: true });
  writeFileSync(join(runDir, "dossiers", `${placeId.replace(/[^a-zA-Z0-9._-]/g, "_")}.md`), `${lines.join("\n")}\n`);
}

/** Every place in the run, so a foreign source has a genuine owner. */
const check = (places: readonly Place[]): CheckReport => runCheck({ runDir, places, manifest: manifest() });
const rules = (report: CheckReport): string[] => report.errors.map((e) => e.rule);

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "ultraprospect-owned-"));
  mkdirSync(join(runDir, "pages", "osm_n1"), { recursive: true });
  mkdirSync(join(runDir, "pages", "osm_n2"), { recursive: true });
  writeFileSync(join(runDir, "pages", "osm_n1", "P1.md"), P1_BODY);
  writeFileSync(join(runDir, "pages", "osm_n2", "P2.md"), P2_BODY);
  writeFileSync(join(runDir, "osm.json"), JSON.stringify([N1, N2]));
});

afterEach(() => rmSync(runDir, { recursive: true, force: true }));

describe("a source belongs to one company", () => {
  it("accepts a contact read from the place's OWN page", () => {
    const p = place({ contacts: { emails: [{ value: "first@example.com", from: "P1", lane: "web" }], phones: [], socials: [], people: [] } });
    expect(check([p, neighbour()]).errors).toEqual([]);
  });

  it("REJECTS a contact read from another company's page", () => {
    // The address is real and re-readable — on the NEIGHBOUR's page. It will be
    // emailed as this company's, which is the failure the contact rule exists for.
    const p = place({ contacts: { emails: [{ value: "other@example.com", from: "P2", lane: "web" }], phones: [], socials: [], people: [] } });
    const r = check([p, neighbour()]);
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("contact-foreign");
    expect(r.errors.find((e) => e.rule === "contact-foreign")!.message).toContain("osm:n2");
  });

  it("still calls a page this run does not hold UNSOURCED, not foreign", () => {
    const p = place({ contacts: { emails: [{ value: "x@y.fr", from: "P77", lane: "web" }], phones: [], socials: [], people: [] } });
    const r = check([p, neighbour()]);
    expect(rules(r)).toEqual(["contact-unsourced"]);
  });

  it("REJECTS a person read from another company's page", () => {
    const p = place({ contacts: { emails: [], phones: [], socials: [], people: [{ value: "Other Person", from: "P2", lane: "web" }] } });
    expect(rules(check([p, neighbour()]))).toContain("contact-foreign");
  });

  it("REJECTS a term mention quoted from another company's page", () => {
    // A term mention is the reason someone gets called. Quoted off the wrong
    // site it is a reason to call about somebody else's business.
    const p = place({ signals: signals([{ value: "VAT DE123456789", from: "P2", lane: "web" }]) });
    expect(rules(check([p, neighbour()]))).toContain("contact-foreign");
  });

  it("REJECTS a legal identifier read from another company's page", () => {
    const p = place({ legalIds: [{ kind: "vat", value: "DE123456789", from: "P2", status: "unverified" }] });
    const r = check([p, neighbour()]);
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("legal-id-foreign");
  });

  it("still calls a legal identifier with no stored page UNSOURCED, not foreign", () => {
    const p = place({ legalIds: [{ kind: "vat", value: "DE811907980", from: "P77", status: "unverified" }] });
    expect(rules(check([p, neighbour()]))).toEqual(["legal-id-unsourced"]);
  });

  it("accepts a legal identifier read from the place's OWN page", () => {
    const p = place({ legalIds: [{ kind: "vat", value: "DE811907980", from: "P1", status: "unverified" }] });
    expect(check([p, neighbour()]).errors).toEqual([]);
  });

  it("REJECTS an OSM contact declared on another company's feature", () => {
    const p = place({ contacts: { emails: [{ value: "other@example.com", from: "osm:n2", lane: "osm" }], phones: [], socials: [], people: [] } });
    const r = check([p, neighbour()]);
    expect(r.ok).toBe(false);
    expect(rules(r)).toContain("contact-foreign");
  });

  it("REJECTS an OSM legal identifier declared on another company's feature", () => {
    const p = place({ legalIds: [{ kind: "siret", value: "55210055400021", from: "osm:n2", status: "verified" }] });
    expect(rules(check([p, neighbour()]))).toContain("legal-id-foreign");
  });

  it("keys OSM ownership on the feature the place CARRIES, not on its id", () => {
    // A merged place keeps the register's id in some runs and the OSM feature in
    // `osm`. Reading ownership off the id alone would reject its own contacts.
    const merged = place({
      id: "fr-sirene:30247464801175",
      sources: ["osm", "registry"],
      osm: N1,
      contacts: { emails: [{ value: "first@example.com", from: "osm:n1", lane: "osm" }], phones: [], socials: [], people: [] },
      legalIds: [{ kind: "siret", value: "30247464801175", from: "osm:n1", status: "verified" }],
    });
    expect(check([merged, neighbour()]).errors).toEqual([]);
  });

  it("still rejects a FOREIGN feature on a merged place", () => {
    const merged = place({
      id: "fr-sirene:30247464801175",
      sources: ["osm", "registry"],
      osm: N1,
      contacts: { emails: [{ value: "other@example.com", from: "osm:n2", lane: "osm" }], phones: [], socials: [], people: [] },
    });
    expect(rules(check([merged, neighbour()]))).toContain("contact-foreign");
  });

  it("accepts a page fetched for a merged place under its register id", () => {
    // Pages are filed under the place's own id, so a merged place's extracts sit
    // in a `fr-sirene_…` directory. Ownership has to follow the place's page
    // list, not the shape of its id.
    mkdirSync(join(runDir, "pages", "fr-sirene_30247464801175"), { recursive: true });
    writeFileSync(join(runDir, "pages", "fr-sirene_30247464801175", "P3.md"), "# P3 — Acme\n\n---\n\nWrite to first@example.com.\n");
    const merged = place({
      id: "fr-sirene:30247464801175",
      sources: ["osm", "registry"],
      osm: N1,
      pages: ["P3"],
      contacts: { emails: [{ value: "first@example.com", from: "P3", lane: "web" }], phones: [], socials: [], people: [] },
    });
    expect(check([merged, neighbour()]).errors).toEqual([]);
  });
});

describe("a short line can still be a claim", () => {
  it("REJECTS a factual sentence in an entirely bold bullet", () => {
    writeDossier("osm:n1", ["# Company", "", "- **Acme is hiring.**"]);
    expect(rules(check([p()]))).toEqual(["claim-uncited"]);
  });

  const p = () => place();

  it("REJECTS a three-word uncited sentence", () => {
    // "Acme is hiring." is a fact about the world, a reason someone gets called,
    // and short. Length has nothing to do with whether it needs a source.
    writeDossier("osm:n1", ["# Company", "", "Acme is hiring."]);
    const r = check([p()]);
    expect(rules(r)).toEqual(["claim-uncited"]);
    expect(r.errors[0]!.message).toContain("Acme is hiring.");
  });

  it("REJECTS a two-word uncited sentence, in any language", () => {
    // The gate counts no words and knows no grammar: a dossier written in
    // French must not pass a claim an English one would have been held to.
    writeDossier("osm:n1", ["# Company", "", "Acme recrute."]);
    expect(rules(check([p()]))).toEqual(["claim-uncited"]);
  });

  it("REJECTS a figure hidden in a code span", () => {
    // Backticks are typography. A number set in them is still a number, and
    // stripping code before deciding made `500` disappear from the claim.
    writeDossier("osm:n1", ["# Company", "", "Employees: `500`"]);
    expect(rules(check([p()]))).toEqual(["claim-uncited"]);
  });

  it("REJECTS a sentence under a bold blanket", () => {
    // A bulleted "- **Contacts.**" labels a section. A bold line on its own is
    // indistinguishable from a bolded sentence, so emphasis buys nothing here.
    writeDossier("osm:n1", ["# Company", "", "**Acme is hiring.**"]);
    expect(rules(check([p()]))).toEqual(["claim-uncited"]);
  });

  it("reads a WRAPPED block quote as one paragraph, cited at its end", () => {
    // `>` on the second line is the same quote continuing, not a new claim, so
    // the citation that closes the quote covers all of it.
    writeDossier("osm:n1", ["# Company", "", "> This company operates a manufacturing", "> plant and publishes its annual report. [P1]"]);
    expect(check([p()]).errors).toEqual([]);
  });

  it("rejects that same wrapped quote ONCE when nothing cites it", () => {
    writeDossier("osm:n1", ["# Company", "", "> This company operates a manufacturing", "> plant and publishes its annual report."]);
    const r = check([p()]);
    expect(rules(r)).toEqual(["claim-uncited"]);
    expect(r.errors[0]!.message).toContain("This company operates a manufacturing plant");
  });

  it("does not let a cited table row vouch for the next one", () => {
    writeDossier("osm:n1", ["# Company", "", "| Fact | Value |", "| --- | --- |", "| Revenue | 500 million euros [P1] |", "| Staff | fifty in Vincennes |"]);
    const r = check([p()]);
    expect(rules(r)).toEqual(["claim-uncited"]);
    expect(r.errors[0]!.message).toContain("Staff");
  });

  it("REJECTS a short uncited factual sentence", () => {
    writeDossier("osm:n1", ["# Company", "", "Revenue: 500 million euros."]);
    const r = check([p()]);
    expect(r.ok).toBe(false);
    expect(rules(r)).toEqual(["claim-uncited"]);
    expect(r.errors[0]!.message).toContain("Revenue: 500 million euros.");
  });

  it("REJECTS a short uncited factual bullet", () => {
    writeDossier("osm:n1", ["# Company", "", "- Revenue: 500 million euros."]);
    expect(rules(check([p()]))).toEqual(["claim-uncited"]);
  });

  it("REJECTS an uncited table DATA row, and leaves its header and separator alone", () => {
    writeDossier("osm:n1", ["# Company", "", "| Fact | Value |", "| --- | --- |", "| Annual revenue | 500 million euros |"]);
    const r = check([p()]);
    expect(r.ok).toBe(false);
    expect(rules(r)).toEqual(["claim-uncited"]);
    expect(r.errors[0]!.message).toContain("Annual revenue");
  });

  it("REJECTS uncited factual text inside a block quote", () => {
    writeDossier("osm:n1", ["# Company", "", "> Revenue reached 500 million euros in 2025."]);
    expect(rules(check([p()]))).toEqual(["claim-uncited"]);
  });

  it("REJECTS one uncited bullet among cited ones", () => {
    // A citation on the line above does not vouch for the line below it.
    writeDossier("osm:n1", ["# Company", "", "- Founded in 1987. [P1]", "- Revenue: 500 million euros.", "- Fifty staff in Vincennes. [P1]"]);
    const r = check([p()]);
    expect(rules(r)).toEqual(["claim-uncited"]);
    expect(r.errors[0]!.message).toContain("Revenue");
  });

  it("accepts the same short claims once they are cited or marked", () => {
    writeDossier("osm:n1", [
      "# Company",
      "",
      "Revenue: 500 million euros. [P1]",
      "",
      "- Revenue: 500 million euros. [P1]",
      "",
      "| Fact | Value |",
      "| --- | --- |",
      "| Annual revenue | 500 million euros [P1] |",
      "",
      "> Revenue reached 500 million euros in 2025. [P1]",
      "",
      "Worth a call about their booking software. [M]",
    ]);
    expect(check([p()]).errors).toEqual([]);
  });

  it("leaves genuine structure alone", () => {
    // Headings, rules, a table's header and separator, bulleted section labels,
    // fenced blocks and bare links assert nothing. Demanding ids on them would
    // teach whoever writes the dossier to sprinkle ids to silence the gate, and
    // then the ids stop meaning anything. Everything that is not one of these —
    // including the quoted line here, which is why it carries [M] — is a claim.
    writeDossier("osm:n1", [
      "# Company",
      "",
      "## What they do",
      "",
      "---",
      "",
      "- **Contacts.**",
      "",
      "- **Size and shape.**",
      "",
      "| Fact | Value |",
      "| --- | --- |",
      "| Annual revenue | 500 million euros [P1] |",
      "",
      "> worth a call about their booking software [M]",
      "",
      "- https://acme.fr/contact",
      "",
      "```",
      "a fenced block whose contents look exactly like an uncited factual claim about revenue",
      "```",
    ]);
    expect(check([p()]).errors).toEqual([]);
  });

  it("accepts a wrapped cited paragraph whose lines are each short", () => {
    // Markdown wraps, and the citation belongs at the end of the thing it
    // supports. Flagging the earlier lines punishes the author for a text width.
    writeDossier("osm:n1", ["# Company", "", "Acme is a pizzeria in", "Vincennes with a menu of", "more than fifty pizzas. [P1]"]);
    expect(check([p()]).errors).toEqual([]);
  });

  it("still rejects a wrapped SHORT-lined paragraph with no citation anywhere in it", () => {
    writeDossier("osm:n1", ["# Company", "", "Acme is a pizzeria in", "Vincennes with a menu of", "more than fifty pizzas."]);
    expect(rules(check([p()]))).toEqual(["claim-uncited"]);
  });
});
