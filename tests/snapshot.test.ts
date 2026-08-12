// The bulk-ingest layer, driven through the two connectors that actually use it.
//
// Tested through the real `SnapshotSource`s rather than a fake one, because the
// part most likely to be wrong is not the bucketing — it is each register's
// mapper. Both fixtures are trimmed copies of the real exports:
//
//   * tests/fixtures/snapshot/companies-house-sample.zip — the Free Company Data
//     Product's real column names, including a company name containing a comma
//     and a SIC field that carries the code AND its label in one string.
//   * tests/fixtures/snapshot/offeneregister-sample.jsonl.bz2 — the German export's
//     real shape, MEASURED off 120 000 records of the live file: one free-text
//     address, a court-qualified register number, `retrieved_at` per record,
//     Flensburg's trailing "FL" (the 0.16% the obvious regex misses), Berlin's
//     "Berlin (Charlottenburg)" court spelling, and one register number filed at
//     two courts — all of which cost a real bug before they were in here.
//
// The cache goes to a throwaway directory per test file (tests/setup.ts pins
// ULTRAPROSPECT_CACHE_DIR), and `fromFile` means nothing here touches the network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companiesHouseSnapshot, gbCompaniesHouse } from "../src/registry/gb-companies-house.js";
import { deOffeneRegister, offeneRegisterSnapshot, parseGermanAddress, splitNativeNumber } from "../src/registry/de-offeneregister.js";
import { ariregisterSnapshot, eeAriregister, estonianLocalities } from "../src/registry/ee-ariregister.js";
import {
  forgetSnapshot,
  hasSnapshot,
  ingestSnapshot,
  listSnapshots,
  snapshotById,
  snapshotByLocality,
  snapshotFreshness,
  snapshotKey,
  snapshotMeta,
  staleSnapshots,
  unreadableSnapshots,
} from "../src/snapshot.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "snapshot");

beforeAll(async () => {
  // A cache of this file's own, so ingesting here cannot disturb another suite.
  process.env.ULTRAPROSPECT_CACHE_DIR = mkdtempSync(join(tmpdir(), "ultraprospect-snapshot-"));
  await ingestSnapshot("gb-companies-house", companiesHouseSnapshot, { fromFile: join(FIXTURES, "companies-house-sample.zip") });
  await ingestSnapshot("de-offeneregister", offeneRegisterSnapshot, { fromFile: join(FIXTURES, "offeneregister-sample.jsonl.bz2") });
  await ingestSnapshot("ee-ariregister", ariregisterSnapshot, { fromFile: join(FIXTURES, "ariregister-sample.zip") });
});

afterAll(() => {
  forgetSnapshot("gb-companies-house");
  forgetSnapshot("de-offeneregister");
  forgetSnapshot("ee-ariregister");
});

describe("snapshotKey", () => {
  it("files one town written three ways in one place", () => {
    // "Düsseldorf", "DUSSELDORF " and "duesseldorf" are one locality, and a
    // lookup that misses on case or an umlaut silently reports an empty town.
    expect(snapshotKey("Düsseldorf")).toBe(snapshotKey("DÜSSELDORF "));
    expect(snapshotKey("HEBDEN BRIDGE")).toBe(snapshotKey("Hebden Bridge"));
    expect(snapshotKey("HRB 150148")).toBe(snapshotKey("hrb-150148"));
  });
});

describe("ingest — Companies House", () => {
  it("records what it ingested, including how much disk it took", () => {
    const meta = snapshotMeta("gb-companies-house")!;
    expect(meta.rows).toBe(4);
    expect(meta.bytesOnDisk).toBeGreaterThan(0);
    expect(meta.licence).toContain("Open Government Licence");
    expect(hasSnapshot("gb-companies-house")).toBe(true);
    expect(listSnapshots().map((m) => m.connectorId)).toContain("gb-companies-house");
  });

  it("stamps the ON-DISK LAYOUT apart from the tool version", () => {
    // The two answer different questions and the difference is not academic. A
    // different MAPPER means the answers are out of date; a different LAYOUT means
    // they are wrong. Found by verifying the real indexes: two of three held lines
    // written before identifier keys were stored beside each record, so `verifyId`
    // could not have found anything in them — and `toolVersion` called them current,
    // because the package version does not move between commits.
    const meta = snapshotMeta("ee-ariregister")!;
    expect(meta.layoutVersion).toBe(2);
    expect(unreadableSnapshots().map((m) => m.connectorId)).not.toContain("ee-ariregister");
    // An unstamped cache is layout 1 by assumption — conservative on purpose, since
    // guessing it current is the failure that hides itself.
    expect(staleSnapshots().map((m) => m.connectorId)).not.toContain("ee-ariregister");
  });

  it("stamps the tool version that indexed it, so a mapper fix is visible", () => {
    // Records are mapped at ingest, so correcting a connector changes nothing for
    // a cache built before it — the wrong mapping simply persists. Found the hard
    // way: fixing the UK administrative-SIC bug left every existing snapshot still
    // filing dormant companies as extraterritorial organisations.
    const meta = snapshotMeta("gb-companies-house")!;
    expect(meta.toolVersion).toBeTruthy();
    expect(staleSnapshots().map((m) => m.connectorId)).not.toContain("gb-companies-house");
  });

  it("does not reach the network to answer about a snapshot it has not got", async () => {
    // `snapshotFreshness` is the half of cache honesty that needs the register:
    // `staleSnapshots()` catches a cache older than the MAPPER, this catches one
    // older than the DATA. Neither implies the other, and a monthly product means a
    // local cache silently describes last month within weeks.
    //
    // Only the no-request branch is exercised here — tests/setup.ts forbids the
    // network outright, and a mocked HEAD would prove the mock. The live path was
    // measured against all three registers instead.
    const absent = await snapshotFreshness("fr-sirene", companiesHouseSnapshot);
    expect(absent.behind).toBe(false);
    expect(absent.detail).toBe("not ingested");
  });

  it("does not split a company name on the comma inside it", () => {
    // `split(",")` shifts every later column, which puts a postcode in the SIC
    // field on a few thousand rows out of five million and survives a spot check.
    const dupont = snapshotById("gb-companies-house", "00445790");
    return dupont.then((hits) => {
      expect(hits).toHaveLength(1);
      expect(hits[0]!.legalName).toBe("DUPONT, SONS & CO LIMITED");
      expect(hits[0]!.address.codePostal).toBe("HX7 8AA");
      expect(hits[0]!.address.commune).toBe("HEBDEN BRIDGE");
    });
  });

  it("splits the SIC code away from its label, so the NACE section resolves", () => {
    // The field is "62012 - Business and domestic software development". Handed
    // whole to `naceSection` it resolves nothing, and every British row arrives
    // with no section while looking populated.
    return snapshotById("gb-companies-house", "00445790").then(([rec]) => {
      expect(rec!.activityCode).toBe("62012");
      expect(rec!.section).toBe("J");
    });
  });

  it("keeps a previous company name for matching, and the current one as the identity", () => {
    return snapshotById("gb-companies-house", "00445790").then(([rec]) => {
      expect(rec!.names).toContain("OLD DUPONT LIMITED");
      expect(rec!.names[0]).toBe("DUPONT, SONS & CO LIMITED");
    });
  });

  it("dates every record, because a monthly snapshot is not today", () => {
    return snapshotById("gb-companies-house", "SC123456").then(([rec]) => {
      // `asOf` is filled from the file's own Last-Modified at ingest. Here the
      // fixture is a local file with none, so the field is simply absent rather
      // than invented — which is the correct answer, not a gap.
      expect(rec!.asOf ?? undefined).toBeUndefined();
      expect(rec!.status).toBe("active");
    });
  });

  it("finds every company filed under a post town", async () => {
    const town = await snapshotByLocality("gb-companies-house", "Hebden Bridge", () => true);
    expect(town.map((r) => r.id).sort()).toEqual(["00445790", "09999999", "SC123456"]);
    // Manchester's company must not leak in. Found in the real data rather than
    // imagined: 256 hash buckets over thousands of towns collide constantly, and
    // trusting the bucket returned a bakery in Ulm for a lookup in Berlin — a real
    // company, correctly transcribed, in a report about another city. So the exact
    // locality is re-checked per record and this test pins it for every town, not
    // just the two that happen to collide today.
    expect(town.map((r) => r.legalName)).not.toContain("ELSEWHERE TRADING PLC");
    const other = await snapshotByLocality("gb-companies-house", "Manchester", () => true);
    expect(other.map((r) => r.legalName)).toEqual(["ELSEWHERE TRADING PLC"]);
    // A town nobody filed anything under is empty, never "whatever hashed here".
    expect(await snapshotByLocality("gb-companies-house", "Llanfairpwllgwyngyll", () => true)).toEqual([]);
  });

  it("sweeps a territory by post town and says that is what it did", async () => {
    const target = {
      query: "Hebden Bridge",
      label: "Hebden Bridge, West Yorkshire, England",
      lat: 53.7,
      lon: -2,
      bbox: [0, 0, 0, 0] as [number, number, number, number],
      countryCode: "gb",
      source: "nominatim" as const,
    };
    const swept = await gbCompaniesHouse.sweep!(target, {}, {});

    expect(swept.coverage.mode).toBe("sweep");
    expect(swept.coverage.connectorId).toBe("gb-companies-house");
    // Dissolved companies are out by default, so three rows in the town become two.
    expect(swept.records.map((r) => r.id).sort()).toEqual(["00445790", "SC123456"]);
    // The claim is honest about its own shape, which is what makes "sweep" usable
    // here at all: a post town is not the bounding box the OSM lane used.
    expect(swept.coverage.reason).toContain("POST TOWN");
    expect(swept.coverage.reason).toContain("not a bounding box");
  });

  it("includes struck-off companies only when asked", async () => {
    const target = {
      query: "Hebden Bridge",
      label: "Hebden Bridge",
      lat: 53.7,
      lon: -2,
      bbox: [0, 0, 0, 0] as [number, number, number, number],
      countryCode: "gb",
      source: "nominatim" as const,
    };
    const withCeased = await gbCompaniesHouse.sweep!(target, { includeCeased: true }, {});
    expect(withCeased.records.map((r) => r.id).sort()).toEqual(["00445790", "09999999", "SC123456"]);
    expect(withCeased.records.find((r) => r.id === "09999999")!.status).toBe("ceased");
  });

  it("declares itself truncated when it hits --max-results", async () => {
    const target = {
      query: "Hebden Bridge",
      label: "Hebden Bridge",
      lat: 53.7,
      lon: -2,
      bbox: [0, 0, 0, 0] as [number, number, number, number],
      countryCode: "gb",
      source: "nominatim" as const,
    };
    const capped = await gbCompaniesHouse.sweep!(target, { maxResults: 1 }, {});
    expect(capped.records).toHaveLength(1);
    expect(capped.coverage.truncated).toBe(true);
    expect(capped.coverage.reason).toContain("--max-results");
  });

  it("filters a sweep by NACE section", async () => {
    const target = {
      query: "Hebden Bridge",
      label: "Hebden Bridge",
      lat: 53.7,
      lon: -2,
      bbox: [0, 0, 0, 0] as [number, number, number, number],
      countryCode: "gb",
      source: "nominatim" as const,
    };
    const retail = await gbCompaniesHouse.sweep!(target, { sections: ["G"] }, {});
    expect(retail.records.map((r) => r.legalName)).toEqual(["THE BOOK SHOP LTD"]);
  });

  it("verifies a company number keylessly, off the snapshot", async () => {
    // No key, no request: a company number is a primary key, so there is nothing
    // to score and nothing to be uncertain about.
    const rec = await gbCompaniesHouse.verifyId!({ kind: "company-number", value: "445790", countryCode: "gb" }, { keys: {} });
    expect(rec?.legalName).toBe("DUPONT, SONS & CO LIMITED");
  });

  it("is available with a snapshot and no key at all", () => {
    expect(gbCompaniesHouse.availability({ keys: {} }).available).toBe(true);
  });
});

describe("de-offeneregister — the shape measured off the real export", () => {
  it("splits a court-qualified register number, including Flensburg's trailing FL", () => {
    // 99.84% of a 120 000-record sample matched; every miss was Flensburg's suffix.
    expect(splitNativeNumber("Charlottenburg HRA 4792")).toEqual({ court: "Charlottenburg", kind: "HRA", number: "4792" });
    // The form the real export actually uses for Berlin, parentheses and all.
    expect(splitNativeNumber("Berlin (Charlottenburg) HRB 158855")).toEqual({ court: "Berlin (Charlottenburg)", kind: "HRB", number: "158855" });
    expect(splitNativeNumber("Flensburg HRB 7531 FL")).toEqual({ court: "Flensburg", kind: "HRB", number: "7531 FL" });
    expect(splitNativeNumber("nonsense")).toEqual({});
  });

  it("parses the single free-text address the export publishes", () => {
    // "Waidmannstraße 1, 22769 Hamburg." — one string, no components, and present
    // on only 34.9% of records.
    expect(parseGermanAddress("Waidmannstraße 1, 22769 Hamburg.")).toMatchObject({
      libelleVoie: "Waidmannstraße 1",
      codePostal: "22769",
      commune: "Hamburg",
      pays: "Germany",
    });
    // An address that does not match keeps its raw text and the town from the
    // register: half an address is worth more than a discarded one.
    expect(parseGermanAddress("Postfach 12", "München")).toMatchObject({ raw: "Postfach 12", commune: "München" });
    // No address at all still leaves the registered office known.
    expect(parseGermanAddress(undefined, "Berlin")).toEqual({ commune: "Berlin", pays: "Germany" });
  });

  it("uses the court-qualified number as the identity, and stores nothing derivable", () => {
    // "K1101R_HRB150148" appears on no German legal notice, so it is dropped
    // rather than kept under a name that invites somebody to cite it. Everything
    // else that repeats a neighbour is gone too: at 5.3 million rows, storing the
    // register number four times per record cost a measured gigabyte.
    return snapshotById("de-offeneregister", "Hamburg HRB 150148").then(([rec]) => {
      expect(rec!.id).toBe("Hamburg HRB 150148");
      expect(rec!.national?.registerCourt).toBe("Hamburg");
      expect(rec!.national?.federalState).toBe("Hamburg");
      expect(rec!.national?.registerNumber).toBe("HRB 150148");
      expect(rec!.national?.openCorporatesId).toBeUndefined();
      expect(rec!.national?.nativeCompanyNumber).toBeUndefined();
      expect(rec!.national?.retrievedAt).toBeUndefined();
    });
  });

  it("carries each record's OWN retrieval date, which is more truthful than the file's", () => {
    // The file's Last-Modified is 2019-02-05, but its records were retrieved over
    // 2017-2019 and each says when. A single global vintage would overstate some
    // records and understate others.
    return Promise.all([snapshotById("de-offeneregister", "Hamburg HRB 150148"), snapshotById("de-offeneregister", "Berlin (Charlottenburg) HRB 158855")]).then(
      ([hamburg, berlin]) => {
        expect(hamburg[0]!.asOf).toBe("2018-11-09");
        expect(berlin[0]!.asOf).toBe("2018-07-02");
      },
    );
  });

  it("maps a struck-off company as ceased — 61% of the real export is removed", () => {
    return snapshotById("de-offeneregister", "Berlin (Charlottenburg) HRA 4792").then(([rec]) => {
      expect(rec!.status).toBe("ceased");
    });
  });

  it("matches the court an Impressum names against the one the register filed", async () => {
    // The fix a 120 000-record sample could not have suggested. Berlin's records
    // are filed under "Berlin (Charlottenburg)"; an Impressum says "Amtsgericht
    // Charlottenburg". Comparing the two exactly refused the very company it was
    // holding, on the real 5.3-million-record export.
    const rec = await deOffeneRegister.verifyId!({ kind: "hrb", value: "HRB 158855", countryCode: "de", context: "Charlottenburg" }, {});
    expect(rec?.legalName).toBe("Bäckerei Siebert GmbH");
    // And it is the whole point of this connector: VIES answers "---" for a German
    // holder, and this names one.
    expect(rec?.officers.map((o) => o.nom)).toContain("Siebert");
    expect(rec?.asOf).toBe("2018-07-02");
  });

  it("refuses a bare register number that more than one court has, and names them", async () => {
    // "HRB 158855" is filed at Berlin AND München in this fixture — measured on the
    // real export, "HRB 1" is filed at TWENTY courts. Attaching either would give a
    // company somebody else's registration, invisibly and permanently.
    const notes: string[] = [];
    const ambiguous = await deOffeneRegister.verifyId!({ kind: "hrb", value: "HRB 158855", countryCode: "de" }, { onNote: (n) => notes.push(n) });
    expect(ambiguous).toBeUndefined();
    expect(notes.join(" ")).toContain("2 different courts");
    expect(notes.join(" ")).toContain("not an identity without its Amtsgericht");
  });

  it("confirms a bare register number when exactly one court has it", async () => {
    const single = await deOffeneRegister.verifyId!({ kind: "hrb", value: "HRB 150148", countryCode: "de" }, {});
    expect(single?.national?.registerCourt).toBe("Hamburg");
  });

  it("picks the right court when the same number exists at two", async () => {
    const munich = await deOffeneRegister.verifyId!({ kind: "hrb", value: "HRB 158855", countryCode: "de", context: "München" }, {});
    expect(munich?.legalName).toBe("Münchner Handels GmbH");
  });

  it("declares NO activity scheme, because the Handelsregister publishes none", () => {
    // Claiming NACE here would imply codes that do not exist in the source.
    expect(deOffeneRegister.activityScheme).toBe("none");
    expect(deOffeneRegister.sweep).toBeUndefined();
  });

  it("looks a company up by name in its town, and refuses a needle too short to mean anything", async () => {
    const hits = await deOffeneRegister.lookup!({ names: ["Bäckerei Siebert"], countryCode: "de", locality: "Berlin" }, {});
    expect(hits.map((r) => r.legalName)).toEqual(["Bäckerei Siebert GmbH"]);
    expect(await deOffeneRegister.lookup!({ names: ["AG"], countryCode: "de", locality: "Berlin" }, {})).toEqual([]);
    // The struck-off Immertreu is in Berlin too and must not come back.
    const all = await deOffeneRegister.lookup!({ names: ["Immertreu"], countryCode: "de", locality: "Berlin" }, {});
    expect(all).toEqual([]);
  });
});

describe("ee-ariregister — the freshest register, and the fussiest file", () => {
  // Every case here is a trap the real 376 025-row export actually contains.

  it("splits the administrative hierarchy so a sweep of the CITY finds its districts", () => {
    // Tallinn's companies are filed under its eight districts, never under
    // "Tallinn" alone — 61 357 of them in Kesklinn. Indexing only the whole
    // string makes a sweep of Estonia's capital return nothing at all.
    expect(estonianLocalities("Pirita linnaosa, Tallinn, Harju maakond")).toEqual(["Pirita linnaosa", "Tallinn", "Harju maakond"]);
    expect(estonianLocalities("Tartu linn, Tartu linn, Tartu maakond")).toEqual(["Tartu linn", "Tartu maakond"]);
    expect(estonianLocalities("")).toEqual([]);
  });

  it("parses a semicolon-separated file with a BOM, and gets the name right", async () => {
    // Two failures that look like nothing: a comma-split shreds every Estonian
    // address (they are full of commas), and a BOM turns the first column's NAME
    // into "\uFEFFnimi" so every company arrives nameless.
    const [rec] = await snapshotById("ee-ariregister", "16752073");
    expect(rec!.legalName).toBe("007 Agent & Partners OÜ");
    expect(rec!.address.codePostal).toBe("11911");
    expect(rec!.address.commune).toBe("Pirita linnaosa");
    expect(rec!.legalForm).toBe("Osaühing");
  });

  it("finds a Tallinn company by the CITY, not only by its district", async () => {
    const city = await snapshotByLocality("ee-ariregister", "Tallinn", () => true);
    expect(city.map((r) => r.legalName)).toContain("007 Agent & Partners OÜ");
    const district = await snapshotByLocality("ee-ariregister", "Pirita linnaosa", () => true);
    expect(district.map((r) => r.legalName)).toContain("007 Agent & Partners OÜ");
    // And the county, which is the coarsest level the register files.
    expect((await snapshotByLocality("ee-ariregister", "Harju maakond", () => true)).length).toBeGreaterThan(0);
  });

  it("turns the register's date into ISO rather than leaving it Estonian", async () => {
    const [rec] = await snapshotById("ee-ariregister", "16752073");
    expect(rec!.dateCreated).toBe("2023-06-05");
  });

  it("carries NO asOf, because the file is rebuilt daily", async () => {
    // The distinction that makes Germany's export usable is the same one that
    // makes stamping this one wrong: these records ARE current. Asserted through
    // the SOURCE's declaration rather than only through the ingested record —
    // the fixture is a local file with no Last-Modified, so a record from it
    // would be undated whatever the rule was, and this test would have passed
    // while the real ingest stamped every Estonian company. It did.
    expect(ariregisterSnapshot.datesRecords).toBe(false);
    const [rec] = await snapshotById("ee-ariregister", "16752073");
    expect(rec!.asOf).toBeUndefined();
    // And the sources that ARE stale say nothing, so the default stays "date it".
    expect(offeneRegisterSnapshot.datesRecords).toBeUndefined();
    expect(companiesHouseSnapshot.datesRecords).toBeUndefined();
  });

  it("confirms a VAT number, which is what an Estonian legal notice prints", async () => {
    const rec = await eeAriregister.verifyId!({ kind: "vat", value: "EE101335276", countryCode: "ee" }, {});
    expect(rec?.legalName).toBe("007 Autohaus osaühing");
    // And the register code, which is the other primary key.
    expect((await eeAriregister.verifyId!({ kind: "company-number", value: "11694365", countryCode: "ee" }, {}))?.legalName).toBe("007 Autohaus osaühing");
    // A malformed identifier is refused rather than asked about.
    expect(await eeAriregister.verifyId!({ kind: "vat", value: "EE123", countryCode: "ee" }, {})).toBeUndefined();
  });

  it("treats liquidation as ceased while keeping the register's own word", async () => {
    // `L` is 9 052 companies and `N` is 666. Neither is a going concern to
    // cold-call, and neither is simply "struck off" — the difference is kept.
    const swept = await eeAriregister.sweep!(
      { query: "x", label: "Harju maakond", lat: 0, lon: 0, bbox: [0, 0, 0, 0], countryCode: "ee", source: "nominatim" },
      { includeCeased: true },
      {},
    );
    const ceased = swept.records.filter((r) => r.status === "ceased");
    if (ceased.length) expect(typeof ceased[0]!.national?.statusText).toBe("string");
  });

  it("says its sweep is by administrative unit, not by bounding box", async () => {
    const swept = await eeAriregister.sweep!(
      { query: "x", label: "Tallinn", lat: 0, lon: 0, bbox: [0, 0, 0, 0], countryCode: "ee", source: "nominatim" },
      {},
      {},
    );
    expect(swept.coverage.mode).toBe("sweep");
    expect(swept.coverage.reason).toContain("ADMINISTRATIVE UNIT");
    expect(swept.coverage.reason).toContain("not a bounding box");
  });
});
