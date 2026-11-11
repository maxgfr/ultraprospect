// The tender lane: mappers against real answers captured on 2026-11-02, the
// query builders, de-duplication, verdicts, awards, and the bid gate.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyseAwards, awardsMarkdown, FORECAST_LABEL } from "../src/tenders/awards.js";
import { bidDirFor, buildBidPacket } from "../src/tenders/bid.js";
import { runTenderCheck } from "../src/tenders/check.js";
import { checklistFor } from "../src/tenders/checklists.js";
import { expandCountries, legalIdOf } from "../src/tenders/commands.js";
import { dedupeTenders } from "../src/tenders/dedupe.js";
import { isRegistrationId, kindOfNoticeType, tedQuery, toTender as tedToTender } from "../src/tenders/eu-ted.js";
import { boampWhere, kindOfNature, toTender as boampToTender } from "../src/tenders/fr-boamp.js";
import { tenderConnectorsFor, TENDER_CONNECTORS } from "../src/tenders/index.js";
import { packageToTenders, releaseToTender } from "../src/tenders/ocds.js";
import { cfUrl } from "../src/tenders/ocds-sources.js";
import { profileCitations, profileMarkdown, validateProfile } from "../src/tenders/profile.js";
import { emptyTenderManifest } from "../src/tenders/run.js";
import type { Tender, TenderQuery } from "../src/tenders/types.js";
import { cpvPrefix, deadlinePassed, durationMonths, keepByQuery, readEforms, sinceToDate } from "../src/tenders/util.js";
import { applyTenderVerdicts, buildTendersTodo, rankTenders } from "../src/tenders/verdicts.js";
import { diffTenderRuns } from "../src/tenders/watch.js";
import { buildWebTodo, dateOrderFor, readLabelledDeadline } from "../src/tenders/web.js";
import { caRowToTender, pncpCallToTender, secopToTender, usaToTender, worldBankToTender } from "../src/tenders/world-sources.js";

const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "tenders", name), "utf8"));
const NOW = new Date("2026-11-02T10:00:00Z");

function tender(over: Partial<Tender> = {}): Tender {
  return {
    id: "eu-ted:1-2026",
    connectorId: "eu-ted",
    noticeId: "1-2026",
    country: "fr",
    kind: "call",
    status: "open",
    title: "Développement d'une application web",
    buyer: { name: "Ville de Test", country: "fr" },
    cpv: ["72200000"],
    nature: "services",
    lots: [],
    deadline: "2026-12-01T12:00:00+01:00",
    documentsAccess: "unknown",
    places: [],
    criteria: [],
    awards: [],
    coverage: "above-threshold",
    aliases: ["1-2026"],
    ...over,
  };
}

const query = (over: Partial<TenderQuery> = {}): TenderQuery => ({ countries: [], cpv: [], keywords: [], kinds: ["call"], limit: 50, ...over });

describe("TED", () => {
  it("maps a live contract notice: buyer in its own language, CPV, deadline as published, documents link", () => {
    const t = tedToTender(fx("ted-cn.json").notices[0], NOW)!;
    expect(t.id).toBe("eu-ted:722908-2026");
    expect(t.country).toBe("fr");
    expect(t.kind).toBe("call");
    expect(t.buyer.name).toBe("Métropole européenne de Lille");
    expect(t.cpv).toEqual(["72000000"]);
    expect(t.deadline).toBe("2026-11-23+02:00");
    expect(t.status).toBe("open");
    expect(t.documentsUrl).toMatch(/^https:\/\/marchespublics596280\.fr\//);
    expect(t.sourceUrl).toBe("https://ted.europa.eu/en/notice/-/detail/722908-2026");
    expect(t.coverage).toBe("above-threshold");
    // The French title, not the Hungarian one TED lists first.
    expect(t.title).toMatch(/^France/);
  });

  it("maps a live award notice: winners keep their own identifiers and the published duration", () => {
    const t = tedToTender(fx("ted-can.json").notices[0], NOW)!;
    expect(t.kind).toBe("award");
    expect(t.status).toBe("awarded");
    expect(t.awards.map((a) => a.supplier.legalId)).toEqual(["609801535", "449101427"]);
    expect(t.awards[0]!.durationMonths).toBe(48);
    expect(t.awards[0]!.date).toBe("2026-09-01");
    expect(t.value).toEqual({ amount: 222457, currency: "EUR", estimated: false });
  });

  it("builds an expert query: alpha-3 countries, padded CPV, CPV OR keywords by default", () => {
    const q = tedQuery(query({ countries: ["fr", "de"], cpv: ["72"], keywords: ["logiciel"], publishedFrom: "2026-10-01" }));
    expect(q).toContain("buyer-country IN (FRA DEU)");
    expect(q).toContain('(classification-cpv IN (72000000) OR FT~("logiciel"))');
    expect(q).toContain("notice-type IN (cn-standard");
    expect(q).toContain("publication-date>=20261001");
    expect(tedQuery(query({ cpv: ["72"], keywords: ["x"], match: "all" }))).toContain('classification-cpv IN (72000000) AND FT~("x")');
  });

  it("asks newest first — TED's default order is oldest first", () => {
    expect(tedQuery(query({ cpv: ["72"] }))).toMatch(/ SORT BY publication-date DESC$/);
  });

  it("keeps registration numbers as winner identities, not a platform's lot references", () => {
    expect(isRegistrationId("938 703 626 00011")).toBe(true);
    expect(isRegistrationId("609801535")).toBe(true);
    expect(isRegistrationId("1819914-1-0-1")).toBe(false);
    expect(isRegistrationId("France")).toBe(false);
  });

  it("reads eForms notice types as kinds", () => {
    expect(kindOfNoticeType("can-standard")).toBe("award");
    expect(kindOfNoticeType("cn-social")).toBe("call");
    expect(kindOfNoticeType("pin-only")).toBe("prior");
  });
});

describe("BOAMP", () => {
  it("maps a live notice and reads the CPV out of its eForms payload", () => {
    const t = boampToTender(fx("boamp-call.json").results[0], NOW)!;
    expect(t.id).toBe("fr-boamp:26-105857");
    // Every lot carries its own CPV; the main one comes first.
    expect(t.cpv[0]).toBe("30200000");
    expect(t.cpv.length).toBeGreaterThan(1);
    expect(t.value).toEqual({ amount: 2800000, currency: "EUR", estimated: true });
    expect(t.deadline).toBe("2026-11-30T11:00:00+00:00");
    expect(t.national?.european).toBe(true);
    expect(t.aliases).toContain("c17886c5-ed34-4cca-926d-504e3580c389");
    expect(t.sourceUrl).toBe("https://www.boamp.fr/pages/avis/?q=idweb:26-105857");
  });

  it("sends keywords upstream, and the deadline floor only for calls", () => {
    const w = boampWhere(query({ keywords: ["logiciel"], deadlineAfter: "2026-11-02", publishedFrom: "2026-10-01" }));
    expect(w).toContain('nature IN ("APPEL_OFFRE")');
    expect(w).toContain(`datelimitereponse >= date'2026-11-02'`);
    expect(w).toContain('search(objet, "logiciel")');
    expect(boampWhere(query({ kinds: ["award"], deadlineAfter: "2026-11-02" }))).not.toContain("datelimitereponse");
  });

  it("reads natures as kinds", () => {
    expect(kindOfNature("ATTRIBUTION")).toBe("award");
    expect(kindOfNature("ANNULATION")).toBe("cancellation");
    expect(kindOfNature("APPEL_OFFRE")).toBe("call");
  });
});

describe("OCDS publishers", () => {
  it("Find a Tender: CPV, deadline, criteria with weights, the FTS notice page", () => {
    const [t] = packageToTenders(fx("fts.json"), {
      connectorId: "gb-fts",
      country: "gb",
      coverage: "above-threshold",
      sourceUrl: (r) => `https://www.find-tender.service.gov.uk/Notice/${r.id}`,
      now: NOW,
    });
    expect(t!.cpv).toEqual(["38000000"]);
    expect(t!.deadline).toBe("2026-11-30T12:00:00Z");
    expect(t!.criteria.find((c) => c.name.startsWith("Section 1"))?.weight).toBe("29%");
    expect(t!.places).toContain("UKM82");
    expect(t!.sourceUrl).toBe("https://www.find-tender.service.gov.uk/Notice/103248-2026");
  });

  it("Contracts Finder: an award with its supplier, value, contract end, and its Notice page", () => {
    const release = fx("cf.json").releases[0];
    const t = releaseToTender(release, { connectorId: "gb-contracts-finder", country: "gb", coverage: "below-threshold", sourceUrl: cfUrl, now: NOW })!;
    expect(t.kind).toBe("award");
    expect(t.awards[0]!.supplier.name).toBe("hansom taxis");
    expect(t.awards[0]!.value).toEqual({ amount: 35042, currency: "GBP", estimated: false });
    expect(t.awards[0]!.endDate).toBe("2027-07-31");
    expect(t.sourceUrl).toMatch(/^https:\/\/www\.contractsfinder\.service\.gov\.uk\/Notice\//);
  });

  it("AusTender: a contract, its supplier identified by ABN, classified in UNSPSC (no CPV)", () => {
    const [t] = packageToTenders(fx("au.json"), { connectorId: "au-austender", country: "au", coverage: "all", now: NOW });
    expect(t!.kind).toBe("award");
    expect(t!.awards[0]!.supplier.legalId).toBe("AU-ABN 65988953849");
    expect(t!.cpv).toEqual([]);
    expect(t!.national?.noCpvScheme).toBe(true);
  });

  it("the German export: the procedure UUID joins it to its TED copy, and no deadline is made up", () => {
    const [t] = packageToTenders(fx("de-release.json"), { connectorId: "de-oeffentlichevergabe", country: "de", coverage: "all", now: NOW });
    expect(t!.country).toBe("de");
    expect(t!.buyer.legalId).toBe("HRB 4923");
    expect(t!.aliases).toContain("65c5c245-290f-4a39-8e60-a88e304676f0");
    expect(t!.deadline).toBeUndefined();
    expect(t!.status).toBe("unknown");
  });
});

describe("sources outside Europe", () => {
  it("PNCP: an open call with its deadline and the edital page", () => {
    const t = pncpCallToTender(fx("pncp.json").data[0])!;
    expect(t.country).toBe("br");
    expect(t.deadline).toBe("2026-11-06T17:30:00");
    expect(t.buyer.legalId).toBe("CNPJ 04104816000116");
    expect(t.sourceUrl).toBe("https://pncp.gov.br/app/editais/04104816000116/2023/114");
  });

  it("SECOP II: a process links to its own page", () => {
    const t = secopToTender(fx("secop.json")[0])!;
    expect(t.country).toBe("co");
    expect(t.sourceUrl).toMatch(/^https:\/\/community\.secop\.gov\.co\//);
  });

  it("World Bank: a funded notice with its deadline, never claimed as a country census", () => {
    const t = worldBankToTender(fx("worldbank.json").procnotices[0])!;
    expect(t.coverage).toBe("funded");
    expect(t.country).toBe("zm");
    expect(t.deadline).toBe("2026-10-31T22:00");
    expect(t.publishedAt).toBe("2026-10-31");
  });

  it("CanadaBuys and USAspending rows map from their own column names", () => {
    const ca = caRowToTender({
      "referenceNumber-numeroReference": "cb-1",
      "title-titre-eng": "Software",
      "tenderClosingDate-appelOffresDateCloture": "2026-12-01T14:00:00",
      "noticeURL-URLavis-eng": "https://canadabuys.canada.ca/x",
    })!;
    expect(ca.deadline).toBe("2026-12-01T14:00:00");
    expect(ca.national?.noCpvScheme).toBe(true);
    const us = usaToTender({
      "Award ID": "A1",
      "Recipient Name": "ACME",
      "Recipient UEI": "TJNNJBZYGSY5",
      "Award Amount": 1000,
      "Start Date": "2026-01-01",
      "End Date": "2028-01-01",
    })!;
    expect(us.awards[0]!.supplier.legalId).toBe("UEI TJNNJBZYGSY5");
    expect(us.awards[0]!.durationMonths).toBe(24);
  });
});

describe("filters", () => {
  it("keeps a notice matching CPV OR keywords by default, both with match all", () => {
    const t = tender({ cpv: ["72200000"], title: "Travaux de voirie" });
    expect(keepByQuery(t, query({ cpv: ["72"], keywords: ["logiciel"] }))).toBe(true);
    expect(keepByQuery(t, query({ cpv: ["72"], keywords: ["logiciel"], match: "all" }))).toBe(false);
  });

  it("never keeps a no-CPV notice on a CPV filter alone — keywords must carry it", () => {
    const t = tender({ cpv: [], title: "Logiciel de gestion", national: { noCpvScheme: true } });
    expect(keepByQuery(t, query({ cpv: ["72"] }))).toBe(false);
    expect(keepByQuery(t, query({ cpv: ["72"], keywords: ["logiciel"] }))).toBe(true);
  });

  it("drops a call whose deadline is before the floor, accent-insensitive on keywords", () => {
    expect(keepByQuery(tender({ deadline: "2026-10-01" }), query({ deadlineAfter: "2026-11-02" }))).toBe(false);
    expect(keepByQuery(tender({ title: "Numérique" }), query({ keywords: ["numerique"] }))).toBe(true);
  });

  it("parses --since and CPV prefixes, and never calls an unknown deadline open", () => {
    expect(sinceToDate("30d", NOW)).toBe("2026-10-03");
    expect(sinceToDate("2y", NOW)).toBe("2024-11-02");
    expect(sinceToDate("soon", NOW)).toBeUndefined();
    expect(cpvPrefix("72000000")).toBe("72");
    expect(cpvPrefix("72220000")).toBe("7222");
    expect(deadlinePassed(undefined, NOW)).toBeUndefined();
    expect(deadlinePassed("2026-11-02+02:00", NOW)).toBe(false);
    expect(durationMonths("4", "YEAR")).toBe(48);
    expect(durationMonths("720", "DAY")).toBe(24);
  });

  it("reads a deadline in its own timezone, not in UTC's", () => {
    // Due 23:00 Pacific on the 23rd. At 02:00 UTC on the 24th it is 18:00 on the 23rd there: still open.
    expect(deadlinePassed("2026-11-23T23:00:00-08:00", new Date("2026-11-24T02:00:00Z"))).toBe(false);
    expect(deadlinePassed("2026-11-23T23:00:00-08:00", new Date("2026-11-24T07:00:01Z"))).toBe(true);
    // Due noon in Sydney. At 05:00 UTC the same day it is 16:00 there: closed four hours ago.
    expect(deadlinePassed("2026-11-23T12:00:00+11:00", new Date("2026-11-23T05:00:00Z"))).toBe(true);
    // A day with an offset is open all of that day, at that offset.
    expect(deadlinePassed("2026-11-23+02:00", new Date("2026-11-23T21:59:00Z"))).toBe(false);
    expect(deadlinePassed("2026-11-23+02:00", new Date("2026-11-23T22:00:00Z"))).toBe(true);
    // No offset: only the day is known, compared as before.
    expect(deadlinePassed("2026-11-23", new Date("2026-11-23T23:00:00Z"))).toBe(false);
    expect(deadlinePassed("2026-11-23", new Date("2026-11-24T00:30:00Z"))).toBe(true);
    expect(deadlinePassed("2026-11-23T12:00:00Z", new Date("2026-11-23T12:00:01Z"))).toBe(true);
  });

  it("walks an eForms payload for CPV, documents, duration and criteria", () => {
    const donnees = JSON.parse(fx("boamp-call.json").results[0].donnees);
    const e = readEforms(donnees);
    expect(e.cpv).toContain("30200000");
    expect(e.durationMonths).toBe(5);
    expect(e.documents.length).toBeGreaterThan(0);
  });
});

describe("coverage", () => {
  it("names a country seen only above the thresholds, and one no source serves", () => {
    const { gaps, connectors } = tenderConnectorsFor(["fr", "it", "jp"]);
    expect(gaps).toEqual([
      { country: "it", coverage: "above-threshold" },
      { country: "jp", coverage: "none" },
    ]);
    expect(connectors.map((c) => c.id)).toEqual(expect.arrayContaining(["fr-boamp", "eu-ted", "ww-worldbank"]));
  });

  it("the UK is covered by FTS and Contracts Finder together, not by either alone", () => {
    expect(tenderConnectorsFor(["gb"]).gaps).toEqual([]);
    expect(tenderConnectorsFor(["gb"], { only: ["gb-fts"] }).gaps).toEqual([{ country: "gb", coverage: "above-threshold" }]);
  });

  it("every source declares a licence, a docs URL and what it can return", () => {
    for (const c of TENDER_CONNECTORS) {
      expect(c.licence.length, c.id).toBeGreaterThan(10);
      expect(() => new URL(c.docsUrl), c.id).not.toThrow();
      expect(c.kinds.length, c.id).toBeGreaterThan(0);
    }
  });

  it("SAM.gov says how to get a key instead of failing", () => {
    const sam = TENDER_CONNECTORS.find((c) => c.id === "us-sam")!;
    expect(sam.availability({}).available).toBe(false);
    expect(sam.availability({}).reason).toMatch(/ULTRAPROSPECT_SAM_API_KEY/);
  });

  it("expands eu and uk", () => {
    expect(expandCountries(["eu"]).length).toBe(27);
    expect(expandCountries(["uk"])).toEqual(["gb"]);
  });
});

describe("de-duplication", () => {
  const uuid = "444c99a9-b1a9-4102-873f-e624ad414937";
  it("merges a TED copy into the national one on the shared eForms procedure id, filling what it lacked", () => {
    const national = tender({ id: "fr-boamp:26-1", connectorId: "fr-boamp", aliases: ["26-1", uuid], deadline: undefined, status: "unknown", cpv: [] });
    const ted = tender({ id: "eu-ted:9-2026", aliases: ["9-2026", uuid] });
    const d = dedupeTenders([national, ted]);
    expect(d.tenders.map((t) => t.id)).toEqual(["fr-boamp:26-1"]);
    expect(d.tenders[0]!.deadline).toBe(ted.deadline);
    expect(d.tenders[0]!.status).toBe("open");
    expect(d.tenders[0]!.cpv).toEqual(["72200000"]);
    expect(d.merged).toHaveLength(1);
  });

  it("never joins on a publication number — TED's and FTS's look alike and mean different things", () => {
    const a = tender({ id: "eu-ted:103248-2026", aliases: ["103248-2026"] });
    const b = tender({ id: "gb-fts:103248-2026", connectorId: "gb-fts", country: "gb", aliases: ["103248-2026"] });
    expect(dedupeTenders([a, b]).tenders).toHaveLength(2);
  });

  it("proposes a look-alike pair without merging it", () => {
    const a = tender({ id: "fr-boamp:1", connectorId: "fr-boamp", aliases: ["1"] });
    const b = tender({ id: "web:abc", connectorId: "web", aliases: ["x"], title: "Développement d'une application web." });
    const d = dedupeTenders([a, b]);
    expect(d.tenders).toHaveLength(2);
    expect(d.pairs).toHaveLength(1);
  });
});

describe("verdicts", () => {
  it("folds a verdict, refuses a go on an expired call, and reports unknown ids", () => {
    const open = tender({ id: "a" });
    const closed = tender({ id: "b", deadline: "2026-10-01", status: "closed" });
    const { tenders, outcome } = applyTenderVerdicts(
      [open, closed],
      [
        { id: "a", decision: "go", fit: "strong", why: "fits [P1]" },
        { id: "b", decision: "go", fit: "strong", why: "late" },
        { id: "zz", decision: "go", fit: "strong", why: "?" },
        { id: "a", decision: "yes", fit: "strong", why: "bad shape" },
      ],
      NOW,
    );
    expect(tenders.find((t) => t.id === "a")!.verdict?.decision).toBe("go");
    expect(outcome.expired).toEqual(["b"]);
    expect(outcome.unknown).toEqual(["zz"]);
    expect(outcome.invalid).toEqual(["a"]);
  });

  it("never drops a notice because a pair named it twice, or named a pair both ways round", () => {
    const self = applyTenderVerdicts([tender({ id: "x" }), tender({ id: "y" })], [{ pair: ["x", "x"], same: true, why: "?" }], NOW);
    expect(self.tenders.map((t) => t.id)).toEqual(["x", "y"]);
    expect(self.outcome.merged).toBe(0);
    expect(self.outcome.invalid).toHaveLength(1);

    const both = applyTenderVerdicts(
      [tender({ id: "a" }), tender({ id: "b" })],
      [
        { pair: ["a", "b"], same: true, why: "same call" },
        { pair: ["b", "a"], same: true, why: "same call" },
      ],
      NOW,
    );
    expect(both.tenders.map((t) => t.id)).toEqual(["a"]);
    expect(both.outcome.merged).toBe(1);
    expect(both.outcome.invalid).toHaveLength(1);
  });

  it("merges a look-alike pair only on same: true", () => {
    const { tenders, outcome } = applyTenderVerdicts(
      [tender({ id: "a" }), tender({ id: "b" })],
      [{ pair: ["a", "b"], same: true, why: "same buyer, object, deadline" }],
      NOW,
    );
    expect(tenders.map((t) => t.id)).toEqual(["a"]);
    expect(outcome.merged).toBe(1);
  });

  it("the worklist holds only calls still open or unknown, soonest first; go ranks first", () => {
    const todo = buildTendersTodo(
      [
        tender({ id: "late", deadline: "2026-12-20" }),
        tender({ id: "soon", deadline: "2026-11-10" }),
        tender({ id: "award", kind: "award", status: "awarded" }),
      ],
      [],
    );
    expect(todo.items.map((i) => i.id)).toEqual(["soon", "late"]);
    const ranked = rankTenders([tender({ id: "x" }), tender({ id: "y", verdict: { id: "y", decision: "go", fit: "strong", why: "." } })]);
    expect(ranked[0]!.id).toBe("y");
  });
});

describe("awards", () => {
  const award = (id: string, supplier: string, legalId: string | undefined, date: string, months?: number, amount?: number): Tender =>
    tender({
      id,
      kind: "award",
      status: "awarded",
      awards: [
        {
          supplier: { name: supplier, legalId, country: "fr" },
          date,
          durationMonths: months,
          value: amount ? { amount, currency: "EUR", estimated: false } : undefined,
        },
      ],
    });

  it("counts notices won, joins SIRETs of one company on the SIREN, and draws a window only from a published duration", () => {
    const a = analyseAwards(
      [
        award("n1", "ACME SAS", "12345678900011", "2024-06-01", 36, 100_000),
        award("n2", "Acme", "12345678900029", "2025-01-01", undefined, 50_000),
        award("n3", "Other", undefined, "2025-01-01"),
      ],
      { now: NOW },
    );
    const acme = a.suppliers[0]!;
    expect(acme.wins).toBe(2);
    expect(acme.total).toBe(150_000);
    expect(a.upcoming.map((r) => r.tenderId)).toEqual(["n1"]);
    expect(a.upcoming[0]!.endsAt).toBe("2027-06-01");
    expect(a.upcoming[0]!.retenderWindow).toMatchObject({ from: "2026-06-01", to: "2026-12-01" });
    expect(a.withoutDuration).toBe(2);
    expect(awardsMarkdown(a, { truncated: true, gaps: [], title: "t" })).toContain(FORECAST_LABEL);
  });
});

describe("awards in more than one currency", () => {
  const award = (id: string, amount: number | undefined, currency: string): Tender =>
    tender({
      id,
      kind: "award",
      status: "awarded",
      awards: [
        {
          supplier: { name: "ACME SAS", legalId: "12345678900011", country: "fr" },
          date: "2025-01-01",
          value: amount ? { amount, currency, estimated: false } : undefined,
        },
      ],
    });

  it("totals one currency, even when the supplier's first award published no value", () => {
    // The first row has no value, so it used to leave the currency unset — and
    // every later amount, euros and pounds alike, went into one bare number.
    const a = analyseAwards([award("n1", undefined, "EUR"), award("n2", 100_000, "EUR"), award("n3", 50_000, "GBP")], { now: NOW });
    expect(a.suppliers[0]!.total).toBe(100_000);
    expect(a.suppliers[0]!.currency).toBe("EUR");
    expect(a.buyers[0]!.total).toBe(100_000);
    expect(a.buyers[0]!.currency).toBe("EUR");
  });
});

describe("a profile that is not complete", () => {
  it("names the problem instead of crashing, and can still be printed", () => {
    const { problems, profile } = validateProfile({ offer: "Software" });
    expect(problems.map((p) => p.field)).toContain("company.name");
    expect(() => profileMarkdown(profile!)).not.toThrow();
    expect(profileMarkdown(profile!)).toContain("no legal name");
  });

  it("reports a name that is not text as a missing name, not as broken JSON", () => {
    const { problems } = validateProfile({ company: { name: 42 }, offer: 7 });
    expect(problems.map((p) => p.field)).toEqual(expect.arrayContaining(["company.name", "offer"]));
  });
});

describe("profile", () => {
  it("validates ids and exposes every citable entry", () => {
    const { problems, profile } = validateProfile({
      company: { name: "X" },
      offer: "We build software.",
      references: [
        { id: "R1", client: "Y", scope: "Z" },
        { id: "bad", client: "Y", scope: "Z" },
      ],
      certifications: [{ id: "C1", name: "ISO 27001" }],
      staff: 4,
    });
    expect(problems.map((p) => p.field)).toEqual(["references[].id"]);
    const cites = profileCitations(profile);
    for (const id of ["R1", "C1", "profile.staff", "profile.offer", "profile.company"]) expect(cites.has(id), id).toBe(true);
  });

  it("checklists name their source; an unknown jurisdiction gets none borrowed from another", () => {
    expect(checklistFor("fr", true)?.source).toMatch(/^https:\/\/www\.economie\.gouv\.fr\//);
    expect(checklistFor("it", true)?.items[0]?.piece).toMatch(/ESPD/);
    expect(checklistFor("jp", false)).toBeUndefined();
  });

  it("reads identifier shapes the register connectors accept", () => {
    expect(legalIdOf("938 703 626 00011", "fr")).toEqual({ kind: "siret", value: "93870362600011", countryCode: "fr" });
    expect(legalIdOf("609801535", "fr")?.kind).toBe("siren");
  });
});

describe("web lane", () => {
  it("writes queries in the market's language, with its portals", () => {
    const todo = buildWebTodo(["it"], (lang) => (lang === "it" ? ["sviluppo software"] : []), 6, NOW);
    expect(todo.items[0]!.lang).toBe("it-IT");
    expect(todo.items[0]!.queries).toContain('"sviluppo software" bando di gara 2026');
    expect(todo.items[0]!.queries.some((q) => q.startsWith("site:"))).toBe(true);
    expect(buildWebTodo(["it"], () => [], 6, NOW).items).toEqual([]);
  });

  it("reads a deadline only where a deadline label introduces it", () => {
    expect(
      readLabelledDeadline("Objet du marché. Date limite de réception des offres : 23/11/2026 à 12h00", ["date limite de réception des offres"]).deadline,
    ).toBe("2026-11-23T12:00");
    expect(readLabelledDeadline("Publié le 23/11/2026. Réunion le 01/12/2026.", ["date limite"]).deadline).toBeUndefined();
  });

  it("reads nn/nn/yyyy in the market's own order: month first in the United States", () => {
    // Read day first, this notice closed on 3 April — a month after it shut.
    expect(readLabelledDeadline("Due date: 03/04/2026 at 14:00", ["due date"], dateOrderFor("us")).deadline).toBe("2026-03-04T14:00");
    expect(readLabelledDeadline("Date limite : 03/04/2026", ["date limite"], dateOrderFor("fr")).deadline).toBe("2026-04-03");
    expect(dateOrderFor("jp")).toBe("dmy");
  });

  it("reads a date with one possible reading as that day, whatever the market", () => {
    expect(readLabelledDeadline("Due date: 23/11/2026", ["due date"], "mdy").deadline).toBe("2026-11-23");
    expect(readLabelledDeadline("Date limite : 11/23/2026", ["date limite"], "dmy").deadline).toBe("2026-11-23");
    expect(readLabelledDeadline("Date limite : 31/13/2026", ["date limite"], "dmy").deadline).toBeUndefined();
  });

  it("reads no deadline from a date Canada could mean two ways, and still reads one it could not", () => {
    expect(dateOrderFor("ca")).toBe("either");
    expect(readLabelledDeadline("Closing date: 03/04/2026", ["closing date"], "either").deadline).toBeUndefined();
    expect(readLabelledDeadline("Date de clôture : 23/11/2026", ["date de clôture"], "either").deadline).toBe("2026-11-23");
    expect(readLabelledDeadline("Closing date: 2026-03-04", ["closing date"], "either").deadline).toBe("2026-03-04");
  });
});

describe("watch", () => {
  it("does not report a notice as new when only its copy changed, and flags a moved deadline", () => {
    const uuid = "0c4f7a52-9d1e-4b8a-a3f0-6e2b1c9d8e7f";
    const before = [tender({ id: "eu-ted:1", aliases: [uuid] })];
    const after = [tender({ id: "fr-boamp:9", aliases: [uuid.toUpperCase()], deadline: "2026-11-10" }), tender({ id: "new", aliases: [] })];
    const d = diffTenderRuns(before, after, { now: NOW });
    expect(d.appeared.map((t) => t.id)).toEqual(["new"]);
    expect(d.changed[0]!.what[0]).toMatch(/^deadline/);
    expect(d.closingSoon.map((t) => t.id)).toEqual(["fr-boamp:9"]);
  });

  it("does not match a Find a Tender notice to a TED notice on a publication number of the same shape", () => {
    const before = [tender({ id: "eu-ted:103248-2026", aliases: ["103248-2026"] })];
    const after = [tender({ id: "gb-fts:103248-2026", connectorId: "gb-fts", aliases: ["103248-2026"], deadline: "2026-11-10" })];
    const d = diffTenderRuns(before, after, { now: NOW });
    expect(d.appeared.map((t) => t.id)).toEqual(["gb-fts:103248-2026"]);
    expect(d.changed).toEqual([]);
    expect(d.notReturned.map((t) => t.id)).toEqual(["eu-ted:103248-2026"]);
  });

  it("follows a copy merged into another by a pair verdict", () => {
    const before = [tender({ id: "eu-ted:1", aliases: ["1"] })];
    const after = [tender({ id: "fr-boamp:9", aliases: ["9", "1", "eu-ted:1"], national: { alsoPublishedAs: ["eu-ted:1"] } })];
    expect(diffTenderRuns(before, after, { now: NOW }).appeared).toEqual([]);
  });
});

describe("the bid gate", () => {
  function runWith(response: string, over: Partial<Tender> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "up-bid-"));
    const t = tender({
      pages: [{ id: "P1", url: "record:x", role: "notice", fetchedAt: NOW.toISOString(), chars: 10, extract: "pages/x/P1.md" }],
      ...over,
    });
    mkdirSync(join(dir, "pages", "x"), { recursive: true });
    writeFileSync(join(dir, "pages", "x", "P1.md"), "# P1\n\nThe notice.\n");
    writeFileSync(
      join(dir, "profile.json"),
      JSON.stringify({ company: { name: "Bidder" }, offer: "Software.", staff: 25, references: [{ id: "R1", client: "Lyon", scope: "Portal" }] }),
    );
    mkdirSync(join(dir, bidDirFor(t)), { recursive: true });
    writeFileSync(join(dir, bidDirFor(t), "RESPONSE.md"), response);
    const manifest = emptyTenderManifest("t", {});
    return runTenderCheck({ runDir: dir, tenders: [t], manifest, now: NOW });
  }

  it("passes a response that cites the notice for the need and the profile for the bidder", () => {
    const r = runWith(
      "# Response\n\nDate limite de remise des offres : 2026-12-01 [P1]\n\nThe buyer needs a web application for its residents [P1].\n\nNous avons refondu le portail de Lyon en 2025 [R1].\n\nNotre équipe compte 25 personnes [profile.staff].\n",
    );
    expect(r.errors).toEqual([]);
  });

  it("refuses an invented reference, a wrong deadline, an unsourced claim about the bidder, and an unlabelled renewal date", () => {
    const r = runWith(
      "# Response\n\nDeadline: 2026-12-15 [P1]\n\nWe delivered fifteen similar portals [R7].\n\nNotre équipe compte 120 ingénieurs certifiés [P1].\n\nThe renewal comes on 2030-01-01 [M].\n",
    );
    const rules = r.errors.map((e) => e.rule).sort();
    expect(rules).toEqual(["award-forecast-unlabelled", "bid-claim-unsourced", "deadline-mismatch", "reference-unknown"]);
  });

  it("compares a deadline written month first with a US notice's, and day first with a French one's", () => {
    const stated = "# Response\n\nDue date: 03/04/2026 [P1]\n";
    const us = runWith(stated, { country: "us", deadline: "2026-03-04T17:00:00-05:00" });
    expect(us.errors.map((e) => e.rule)).not.toContain("deadline-mismatch");
    // The same line against a notice that closes on 3 April, in each market.
    expect(runWith(stated, { country: "us", deadline: "2026-04-03" }).errors.map((e) => e.rule)).toContain("deadline-mismatch");
    expect(runWith(stated, { country: "fr", deadline: "2026-04-03" }).errors.map((e) => e.rule)).not.toContain("deadline-mismatch");
    // Canada writes both: either reading matches, a third date does not.
    expect(runWith(stated, { country: "ca", deadline: "2026-03-04" }).errors.map((e) => e.rule)).not.toContain("deadline-mismatch");
    expect(runWith(stated, { country: "ca", deadline: "2026-05-05" }).errors.map((e) => e.rule)).toContain("deadline-mismatch");
  });

  it("refuses a citation to another notice's page, and a go on a closed call", () => {
    const r = runWith("# Response\n\nThe need is stated [P9].\n", {
      verdict: { id: "eu-ted:1-2026", decision: "go", fit: "strong", why: "." },
      deadline: "2026-10-01",
    });
    expect(r.errors.map((e) => e.rule)).toEqual(expect.arrayContaining(["deadline-passed", "citation-unresolved"]));
  });

  it("the packet leads with the deadline, the profile ids and the checklist", () => {
    const dir = mkdtempSync(join(tmpdir(), "up-packet-"));
    const md = buildBidPacket(dir, tender(), emptyTenderManifest("t", {}), {
      company: { name: "B" },
      offer: "Software.",
      references: [{ id: "R1", client: "L", scope: "P" }],
    });
    expect(md).toContain("**Submission deadline: 2026-12-01T12:00:00+01:00**");
    expect(md).toContain("[R1] L: P");
    expect(md).toContain("Code de la commande publique");
  });
});
