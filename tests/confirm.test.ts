// `confirm` — the stage that decides whether a register identity gets attached.
//
// It is the most consequential thing in a non-French run and the easiest to get
// silently wrong: attaching the wrong company produces one plausible entity
// holding somebody else's registration, which nothing downstream will ever
// flag. So the connectors are faked here — the point is not whether VIES
// answers, it is what this code does with each shape of answer.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryConnector, RegistryRecord } from "../src/registry/types.js";
import type { Place } from "../src/types.js";
import { rec } from "./factories.js";

/** What `connectorsFor` will answer. Set per test. */
let selection: { sweep?: RegistryConnector; confirm: RegistryConnector[]; unavailable: Array<{ connector: RegistryConnector; availability: any }> };

vi.mock("../src/registry/index.js", () => ({
  connectorsFor: () => selection,
  noSweepReason: () => "no register connector covers this country",
  unknownConnectorIds: () => [],
}));

const { needsConfirming, runConfirm } = await import("../src/confirm.js");

/** A connector that answers exactly what a test tells it to. */
function fake(over: Partial<RegistryConnector> = {}): RegistryConnector {
  return {
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
    ...over,
  };
}

function place(over: Partial<Place> = {}): Place {
  return {
    id: "osm:n1",
    name: "Bäckerei Siebert",
    sources: ["osm"],
    address: { commune: "Berlin", codePostal: "10243" },
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
    ...over,
  };
}

/** A run directory holding one page, laid out exactly as `pages.ts` writes it. */
function runWithPage(placeId: string, pageId: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ultraprospect-confirm-"));
  const pages = join(dir, "pages", placeId.replace(/[^a-zA-Z0-9._-]/g, "_"));
  mkdirSync(pages, { recursive: true });
  writeFileSync(join(pages, `${pageId}.md`), text);
  return dir;
}

beforeEach(() => {
  selection = { confirm: [], unavailable: [] };
});

describe("needsConfirming", () => {
  it("puts places with a fetched page first", () => {
    // Ordering is not cosmetic: a place with a page can be confirmed from the
    // registration its own site publishes — one request, conclusive. A place
    // without one can only be looked up by name, which costs a request each and
    // confirms almost nothing where the only connector is GLEIF. A `--limit`
    // must cut off the speculative half, not the useful one.
    const ordered = needsConfirming([
      place({ id: "a", pages: [] }),
      place({ id: "b", pages: ["P1"] }),
      place({ id: "c", pages: [] }),
      place({ id: "d", pages: ["P2"] }),
    ]);
    expect(ordered.slice(0, 2).map((p) => p.id)).toEqual(["b", "d"]);
  });

  it("skips places that already carry a register record", () => {
    expect(needsConfirming([place({ registry: rec() }), place({ id: "b" })]).map((p) => p.id)).toEqual(["b"]);
  });

  it("skips a place with no name to ask about", () => {
    expect(needsConfirming([place({ name: "  " })])).toEqual([]);
  });
});

describe("runConfirm — the published-identifier route", () => {
  const IMPRESSUM = "Impressum\nBäckerei Siebert GmbH\nAmtsgericht Charlottenburg, HRB 158855\nUSt-IdNr. DE811907980";

  it("attaches the register record and records the identifier that produced it", async () => {
    const answer: RegistryRecord = {
      ...rec({ connectorId: "fake", id: "HRB158855", legalName: "Bäckerei Siebert GmbH", names: ["Bäckerei Siebert GmbH"], countryCode: "de" }),
    };
    selection.confirm = [fake({ verifyId: async () => answer })];

    const p = place({ pages: ["P1"] });
    const dir = runWithPage(p.id, "P1", IMPRESSUM);
    const outcome = await runConfirm(dir, [p], { countryCode: "de" });

    expect(outcome.verified).toBe(1);
    expect(p.registry?.legalName).toBe("Bäckerei Siebert GmbH");
    expect(p.sources).toContain("registry");
    // The evidence has to name the page, or `check` cannot re-read it.
    expect(p.registryEvidence).toMatchObject({ mode: "confirm", how: "verified-id", from: "P1" });
    expect(p.legalIds?.some((id) => id.status === "verified" && id.from === "P1")).toBe(true);
  });

  it("REFUSES the answer when the authority named a different company", async () => {
    // Measured on the first real Berlin run: GLEIF resolved a Berlin bar's
    // "HRA 4792" to a company in another Land, because German register numbers
    // repeat across courts. The number matched exactly and the company was
    // somebody else's.
    selection.confirm = [
      fake({
        verifyId: async () =>
          rec({ connectorId: "fake", legalName: "UGE Klein Dammerow Eins GmbH & Co. KG", names: ["UGE Klein Dammerow Eins GmbH & Co. KG"] }),
      }),
    ];

    const p = place({ pages: ["P1"] });
    const dir = runWithPage(p.id, "P1", IMPRESSUM);
    const outcome = await runConfirm(dir, [p], { countryCode: "de" });

    expect(p.registry).toBeUndefined();
    expect(outcome.verified).toBe(0);
    // The identifier is still on the record — it was read off a page this run
    // holds — but never as an identity.
    expect(p.legalIds?.every((id) => id.status !== "verified")).toBe(true);
  });

  it("records an identifier no authority could attribute, and does not invent one", async () => {
    // Germany and Spain answer VIES with a valid number and no name. That is a
    // real finding and it is not an identity.
    selection.confirm = [fake({ verifyId: async () => undefined })];

    const p = place({ pages: ["P1"] });
    const dir = runWithPage(p.id, "P1", IMPRESSUM);
    const outcome = await runConfirm(dir, [p], { countryCode: "de" });

    expect(p.registry).toBeUndefined();
    expect(outcome.notFound).toBe(1);
    expect(outcome.attested).toBeGreaterThan(0);
    const id = p.legalIds?.find((x) => x.value === "DE811907980");
    expect(id?.status).toBe("unverified");
    expect(id?.note).toContain("asked fake");
  });

  it("records one row per identifier, not one per page it appeared on", async () => {
    // A VAT number in the footer of every page is one fact observed several
    // times; three identical rows read as three findings.
    selection.confirm = [fake({ verifyId: async () => undefined })];

    const p = place({ pages: ["P1", "P2"] });
    const dir = runWithPage(p.id, "P1", IMPRESSUM);
    const pages = join(dir, "pages", p.id.replace(/[^a-zA-Z0-9._-]/g, "_"));
    writeFileSync(join(pages, "P2.md"), IMPRESSUM);

    await runConfirm(dir, [p], { countryCode: "de" });
    const vat = (p.legalIds ?? []).filter((x) => x.value === "DE811907980");
    expect(vat).toHaveLength(1);
  });
});

describe("runConfirm — the name-lookup route", () => {
  function lookupReturning(...records: RegistryRecord[]): RegistryConnector {
    return fake({ lookup: async () => records });
  }

  it("merges a lookup the scorer is confident about", async () => {
    selection.confirm = [
      lookupReturning(rec({ connectorId: "fake", legalName: "Bäckerei Siebert GmbH", names: ["Bäckerei Siebert GmbH"], address: { codePostal: "10243" } })),
    ];
    const p = place();
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [p], { countryCode: "de" });

    expect(outcome.matched).toBe(1);
    expect(p.registryEvidence?.how).toBe("name-lookup");
  });

  it("sends a middle-band lookup to adjudication instead of deciding", async () => {
    // Same three bands the sweep matcher uses, deliberately: a second set of
    // thresholds would drift from the first. This is the shape that earns the
    // band — a partial name agreement at the same postcode, which is real
    // evidence and not enough to decide on.
    selection.confirm = [
      lookupReturning(rec({ connectorId: "fake", legalName: "Siebert Immobilien AG", names: ["Siebert Immobilien AG"], address: { codePostal: "10243" } })),
    ];
    const p = place();
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [p], { countryCode: "de" });

    expect(p.registry).toBeUndefined();
    expect(outcome.undecided).toHaveLength(1);
    expect(outcome.undecided[0]).toMatchObject({ osmId: "osm:n1", connectorId: "fake" });
  });

  it("drops a lookup with no name agreement rather than attaching it", async () => {
    selection.confirm = [lookupReturning(rec({ connectorId: "fake", legalName: "Deutsche Bahn AG", names: ["Deutsche Bahn AG"] }))];
    const p = place();
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [p], { countryCode: "de" });

    expect(p.registry).toBeUndefined();
    expect(outcome.undecided).toHaveLength(0);
    expect(outcome.notFound).toBe(1);
  });

  it("survives a connector that throws, and keeps asking the next one", async () => {
    // One authority being down must not lose the companies that came after it.
    const broken = fake({
      id: "broken",
      lookup: async () => {
        throw new Error("upstream down");
      },
    });
    selection.confirm = [broken, lookupReturning(rec({ connectorId: "fake", legalName: "Bäckerei Siebert GmbH", names: ["Bäckerei Siebert GmbH"] }))];
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [place()], { countryCode: "de" });
    expect(outcome.matched).toBe(1);
  });
});

describe("runConfirm — coverage honesty", () => {
  it("says plainly when no connector covers the country, and attaches nothing", async () => {
    selection.confirm = [];
    const p = place({ pages: ["P1"] });
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [p], { countryCode: "xx" });

    expect(p.registry).toBeUndefined();
    expect(outcome.coverage.reason).toContain("no register connector covers");
    expect(outcome.records).toEqual([]);
  });

  it("marks the lane as CONFIRM, never as a sweep", async () => {
    // The most important field in the manifest. A confirmed territory presented
    // as a swept one is the one failure nobody downstream can detect.
    selection.confirm = [fake({ lookup: async () => [] })];
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [place()], { countryCode: "de" });

    expect(outcome.coverage.mode).toBe("confirm");
    expect(outcome.coverage.reason).toContain("NOT a sweep");
  });

  it("reports that a US run had no registration to look for", async () => {
    // "We could not confirm these" and "there is no public identifier to
    // confirm them against" are different findings, and only one of them is a
    // shortcoming of this tool.
    selection.confirm = [fake({ lookup: async () => [] })];
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [place()], { countryCode: "us" });
    expect(outcome.notes.join(" ")).toContain("no federal company register");
  });

  it("honours --limit", async () => {
    selection.confirm = [fake({ lookup: async () => [] })];
    const places = [place({ id: "a" }), place({ id: "b" }), place({ id: "c" })];
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), places, { countryCode: "de", limit: 2 });
    expect(outcome.coverage.requested).toBe(2);
  });
});
