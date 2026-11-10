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

  it("does not count as attested an identifier whose authority named somebody else", async () => {
    // "Number read, holder not named" is the line this count is printed under.
    // Here a holder WAS named, and it was another company: that is a refusal,
    // and adding it to the count reported a contradiction as a confirmation.
    selection.confirm = [
      fake({
        id: "gleif",
        canVerify: (id) => id.kind !== "vat",
        verifyId: async () =>
          rec({ connectorId: "gleif", legalName: "UGE Klein Dammerow Eins GmbH & Co. KG", names: ["UGE Klein Dammerow Eins GmbH & Co. KG"] }),
      }),
      fake({ id: "eu-vies", canVerify: (id) => id.kind === "vat", verifyId: async () => undefined }),
    ];

    const p = place({ pages: ["P1"] });
    const dir = runWithPage(p.id, "P1", IMPRESSUM);
    const outcome = await runConfirm(dir, [p], { countryCode: "de" });

    // Both identifiers are on the record, neither as an identity…
    expect(p.legalIds?.map((id) => `${id.value}:${id.status}`).sort()).toEqual(["DE811907980:unverified", "HRB 158855:unverified"]);
    expect(p.legalIds?.find((id) => id.kind === "hrb")?.note).toContain("which is not this company");
    // …and only the VAT number, which nobody contradicted, is attested.
    expect(outcome.attested).toBe(1);
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

  it("counts a place whose only authority was down as NOT ASKED, and names the authority", async () => {
    // A connector throws when its upstream fails. The place is then one nobody
    // could be asked about — not one the register had nothing on — and the row
    // for the number must not credit the silent authority with an answer.
    selection.confirm = [
      fake({
        id: "eu-vies",
        verifyId: async () => {
          throw new Error("eu-vies: HTTP 503");
        },
      }),
    ];
    const p = place({ pages: ["P1"] });
    const dir = runWithPage(p.id, "P1", "Impressum\nUSt-IdNr. DE811907980");
    const outcome = await runConfirm(dir, [p], { countryCode: "de" });

    expect(outcome.notAsked).toBe(1);
    expect(outcome.notFound).toBe(0);
    expect(p.legalIds?.[0]).toMatchObject({ value: "DE811907980", status: "unverified", authority: undefined });
    expect(p.legalIds?.[0]?.note).toContain("none answered");
    // Said once, with the reason, however many numbers it cost.
    expect(outcome.notes.filter((n) => n.includes("eu-vies failed to answer"))).toEqual([expect.stringContaining("(HTTP 503)")]);
  });

  it("credits only the authorities that replied when one of several was down", async () => {
    selection.confirm = [
      fake({
        id: "pl-krs",
        verifyId: async () => {
          throw new Error("pl-krs: timed out after 25000 ms");
        },
      }),
      fake({ id: "eu-vies", verifyId: async () => undefined }),
    ];
    const p = place({ pages: ["P1"] });
    const dir = runWithPage(p.id, "P1", "Impressum\nUSt-IdNr. DE811907980");
    const outcome = await runConfirm(dir, [p], { countryCode: "de" });

    // One authority did answer, so this place was asked about.
    expect(outcome.notFound).toBe(1);
    expect(outcome.notAsked).toBe(0);
    expect(p.legalIds?.[0]?.authority).toBe("eu-vies");
    expect(p.legalIds?.[0]?.note).toBe("asked eu-vies; none named a holder; pl-krs did not answer");
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

  // Both pairs are from a live Hamburg run. A name contained in a longer one
  // scores 0.88 wherever the longer one is filed, and GLEIF's search is narrowed
  // by country, not by town.
  it.each([
    ["AM GmbH", "AM Holding GmbH", { codePostal: "80331", commune: "München" }],
    ["Transcargo GmbH", "TRANSCARGO Internat. Speditions-GmbH", { codePostal: "28195", commune: "Bremen" }],
  ])("does not attach %s to %s, filed in another town", async (mine, theirs, filed) => {
    selection.confirm = [
      lookupReturning(rec({ connectorId: "fake", id: "LEI1", establishmentId: undefined, legalName: theirs, names: [theirs], address: filed })),
    ];
    const p = place({ name: mine, address: { commune: "Hamburg", codePostal: "20457" } });
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [p], { countryCode: "de" });

    expect(p.registry).toBeUndefined();
    expect(outcome.matched).toBe(0);
    // Not dropped either: the resemblance is real, and it is the agent's to judge.
    expect(outcome.undecided).toHaveLength(1);
    expect(outcome.undecided[0]).toMatchObject({ osmId: p.id, registryId: "LEI1", registryName: theirs });
    expect(outcome.notes.join("\n")).toContain(`files it at ${filed.codePostal} ${filed.commune}`);
  });

  it("still attaches a namesake filed in the same town under another postcode", async () => {
    // A registered office is often not the door OSM mapped. The town agreeing is
    // enough; demanding the postcode would refuse most correct answers.
    selection.confirm = [
      lookupReturning(
        rec({ connectorId: "fake", legalName: "Transcargo GmbH", names: ["Transcargo GmbH"], address: { codePostal: "20095", commune: "Hamburg" } }),
      ),
    ];
    const p = place({ name: "Transcargo GmbH", address: { commune: "Hamburg", codePostal: "20457" } });
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [p], { countryCode: "de" });
    expect(outcome.matched).toBe(1);
    expect(outcome.undecided).toHaveLength(0);
  });

  it("reads a town the two sides spell differently as one town", async () => {
    // OSM says "Berlin"; the German register files "Berlin (Charlottenburg)".
    selection.confirm = [
      lookupReturning(
        rec({ connectorId: "fake", legalName: "Bäckerei Siebert GmbH", names: ["Bäckerei Siebert GmbH"], address: { commune: "Berlin (Charlottenburg)" } }),
      ),
    ];
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [place()], { countryCode: "de" });
    expect(outcome.matched).toBe(1);
  });

  it("uses the run's territory when the place carries no city of its own", async () => {
    // Most OSM places have no addr:city. They were found inside the territory,
    // so that is where they are — and without it nothing could be compared and
    // the namesake from another town would be attached exactly as before.
    const elsewhere = rec({ connectorId: "fake", legalName: "AM Holding GmbH", names: ["AM Holding GmbH"], address: { commune: "München" } });
    selection.confirm = [lookupReturning(elsewhere)];
    const p = place({ name: "AM GmbH", address: {} });
    const refused = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [p], { countryCode: "de", town: "Hamburg, Deutschland" });
    expect(p.registry).toBeUndefined();
    expect(refused.undecided).toHaveLength(1);

    selection.confirm = [lookupReturning({ ...elsewhere, address: { commune: "Hamburg" } })];
    const q = place({ name: "AM GmbH", address: {} });
    const attached = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [q], { countryCode: "de", town: "Hamburg, Deutschland" });
    expect(attached.matched).toBe(1);
  });

  it("prefers, between two hits the name cannot separate, the one filed in the place's town", async () => {
    const munich = rec({ connectorId: "fake", id: "M", legalName: "Transcargo GmbH", names: ["Transcargo GmbH"], address: { commune: "München" } });
    const hamburg = rec({ connectorId: "fake", id: "H", legalName: "Transcargo GmbH", names: ["Transcargo GmbH"], address: { commune: "Hamburg" } });
    selection.confirm = [lookupReturning(munich, hamburg)];
    const p = place({ name: "Transcargo GmbH", address: { commune: "Hamburg" } });
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [p], { countryCode: "de" });
    expect(outcome.matched).toBe(1);
    expect(p.registry?.id).toBe("H");
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

  it("honours --only, and applies --limit after it", async () => {
    // A limit is a prefix of the strongest-first order; it cannot be aimed. On a
    // live Hamburg run the sixty-two offices worth confirming could not be
    // named, and the unlimited command set off on 2 535 name lookups.
    const asked: string[] = [];
    selection.confirm = [
      fake({
        lookup: async (query) => {
          asked.push(query.names[0]!);
          return [];
        },
      }),
    ];
    const places = [
      place({ id: "a", name: "Alpha" }),
      place({ id: "b", name: "Bravo" }),
      place({ id: "c", name: "Charlie" }),
      place({ id: "d", name: "Delta" }),
    ];
    const dir = mkdtempSync(join(tmpdir(), "up-"));

    const aimed = await runConfirm(dir, places, { countryCode: "de", only: ["d", "b", "not-a-place"] });
    expect(aimed.coverage.requested).toBe(2);
    expect(asked.sort()).toEqual(["Bravo", "Delta"]);

    asked.length = 0;
    const capped = await runConfirm(dir, places, { countryCode: "de", only: ["d", "b"], limit: 1 });
    expect(capped.coverage.requested).toBe(1);
    expect(asked).toEqual(["Bravo"]);
  });

  it("does not ask again about a place that already carries a record because --only named it", async () => {
    const lookup = vi.fn(async () => []);
    selection.confirm = [fake({ lookup })];
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [place({ id: "a", registry: rec() })], { countryCode: "de", only: ["a"] });
    expect(outcome.coverage.requested).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  // "The register said no" and "the register never answered" were the same
  // number. Companies House allows 600 requests per five minutes and a confirm
  // run is one request per company, so a throttled run reported real businesses
  // as having no register entry — the same class of lie as reading an unreadable
  // job board as "not hiring".
  it("counts a place NO authority could be asked about apart from one that was", async () => {
    selection.confirm = [
      fake({
        id: "throttled",
        lookup: async () => {
          throw new Error("companies-house rate limit");
        },
      }),
    ];
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [place()], { countryCode: "gb" });

    expect(outcome.notAsked).toBe(1);
    expect(outcome.notFound).toBe(0);
    expect(outcome.coverage.reason).toContain("NO authority could be asked about");
    expect(outcome.notes.join(" ")).toContain("NOT recorded as having no register entry");
  });

  it("still counts a register that answered nothing as not found", async () => {
    // The distinction has to cut both ways, or it just relabels the old count.
    selection.confirm = [fake({ lookup: async () => [] })];
    const outcome = await runConfirm(mkdtempSync(join(tmpdir(), "up-")), [place()], { countryCode: "de" });

    expect(outcome.notFound).toBe(1);
    expect(outcome.notAsked).toBe(0);
    expect(outcome.coverage.reason).not.toContain("NO authority could be asked about");
  });
});

describe("runConfirm — which authority is asked, and how often", () => {
  it("sends a Greek VAT number to the connector that serves Greece", async () => {
    // Greece files VAT under EL and is "gr" everywhere else. Carried as "el",
    // the number matched no connector's country list and VIES was never asked.
    const asked: string[] = [];
    selection.confirm = [
      fake({
        id: "eu-vies",
        countries: ["gr", "de"],
        verifyId: async (id) => {
          asked.push(`${id.countryCode}:${id.value}`);
          return undefined;
        },
      }),
    ];
    const p = place({ name: "Artopoieio Papadopoulos", pages: ["P1"], address: { commune: "Athina" } });
    const dir = runWithPage(p.id, "P1", "Στοιχεία επιχείρησης\nΑΦΜ EL030440244");
    await runConfirm(dir, [p], { countryCode: "gr" });
    expect(asked).toEqual(["gr:EL030440244"]);
  });

  it("asks about one identifier once, however many pages print it", async () => {
    // A VAT number sits in every page's footer. A live Hamburg run put the same
    // one to VIES three times, a second apiece, for the same answer.
    const verifyId = vi.fn(async () => undefined);
    selection.confirm = [fake({ verifyId })];
    const p = place({ pages: ["P1", "P2", "P3"] });
    const dir = runWithPage(p.id, "P1", "Start\nUSt-IdNr. DE811907980");
    for (const pageId of ["P2", "P3"]) writeFileSync(join(dir, "pages", "osm_n1", `${pageId}.md`), "Kontakt\nUSt-IdNr. DE811907980");
    await runConfirm(dir, [p], { countryCode: "de" });
    expect(verifyId).toHaveBeenCalledTimes(1);
    // Still one finding on the record, as before.
    expect(p.legalIds).toHaveLength(1);
  });

  it("does not ask an authority about a kind of identifier it cannot check, nor record it as asked", async () => {
    const vies = vi.fn(async () => undefined);
    const gleif = vi.fn(async () => undefined);
    selection.confirm = [
      fake({ id: "eu-vies", verifyId: vies, canVerify: (id) => id.kind === "vat" }),
      fake({ id: "gleif", verifyId: gleif, canVerify: (id) => id.kind !== "vat" }),
    ];
    const p = place({ pages: ["P1"] });
    const dir = runWithPage(p.id, "P1", "Impressum\nUSt-IdNr. DE811907980");
    await runConfirm(dir, [p], { countryCode: "de" });
    expect(vies).toHaveBeenCalledTimes(1);
    expect(gleif).not.toHaveBeenCalled();
    expect(p.legalIds?.[0]?.authority).toBe("eu-vies");
  });
});

describe("runConfirm — the name route", () => {
  it("does not attach a dissolved company because it shares the name", async () => {
    // No pages, so only a name lookup is possible — and the register's name
    // search returns struck-off companies alongside live ones.
    const dissolved = {
      ...rec({ connectorId: "fake", id: "1", legalName: "Bäckerei Siebert GmbH", names: ["Bäckerei Siebert GmbH"], countryCode: "de" }),
      status: "ceased" as const,
    };
    selection.confirm = [fake({ lookup: async () => [dissolved] })];
    const p = place();
    const dir = mkdtempSync(join(tmpdir(), "ultraprospect-confirm-"));
    const outcome = await runConfirm(dir, [p], { countryCode: "de" });
    expect(p.registry).toBeUndefined();
    expect(outcome.matched).toBe(0);

    selection.confirm = [fake({ lookup: async () => [{ ...dissolved, status: "active" as const }] })];
    const q = place();
    await runConfirm(dir, [q], { countryCode: "de" });
    expect(q.registry?.legalName).toBe("Bäckerei Siebert GmbH");
  });
});
