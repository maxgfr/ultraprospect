import { describe, expect, it } from "vitest";
import { applyFit, ranked, scoreOf } from "../src/score.js";
import { DOSSIER_TEMPLATE, dossierPathFor, factSheet } from "../src/dossier.js";
import type { Place, Signals } from "../src/types.js";

function signals(over: Partial<Signals> = {}): Signals {
  return {
    hasWebsite: true,
    siteReachable: true,
    pageCount: 3,
    openRoles: 0,
    atsProviders: [],
    analytics: [],
    techStack: [],
    hasPricingPage: false,
    hasEcommerce: false,
    languages: [],
    socialProfiles: [],
    ...over,
  };
}

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

describe("scoreOf", () => {
  it("scores nothing for a place with no site and no register entry", () => {
    expect(scoreOf(place()).total).toBe(0);
  });

  it("rewards a corroborated, reachable site", () => {
    const p = place({ website: { url: "https://x.fr", confidence: "corroborated", evidence: ["P1"] }, signals: signals() });
    expect(scoreOf(p).parts.hasSite).toBeGreaterThan(0);
    expect(scoreOf(p).parts.siteWorks).toBeGreaterThan(0);
  });

  it("does NOT reward a website we could not corroborate", () => {
    // An unverified candidate is not a site — treating it as one would let a
    // wrong domain lift a company up the ranking.
    const p = place({ website: { url: "https://maybe.fr", confidence: "unverified", evidence: ["P1"] } });
    expect(scoreOf(p).parts.hasSite).toBeUndefined();
  });

  it("does not penalise a site with no lastmod as stale", () => {
    // Plenty of generators omit it. Absence of a date is not evidence of
    // dormancy, so it scores zero rather than negative.
    const fresh = scoreOf(place({ signals: signals({ lastContentAt: new Date().toISOString() }) }));
    const undated = scoreOf(place({ signals: signals() }));
    expect(fresh.parts.fresh).toBeGreaterThan(0);
    expect(undated.parts.fresh).toBeUndefined();
    expect(undated.total).toBeGreaterThanOrEqual(0);
  });

  it("decays freshness with age", () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const recent = scoreOf(place({ signals: signals({ lastContentAt: days(10) }) })).parts.fresh ?? 0;
    const older = scoreOf(place({ signals: signals({ lastContentAt: days(150) }) })).parts.fresh ?? 0;
    expect(recent).toBeGreaterThan(older);
    expect(scoreOf(place({ signals: signals({ lastContentAt: days(400) }) })).parts.fresh).toBeUndefined();
  });

  it("rewards hiring, and caps the per-role bonus", () => {
    const three = scoreOf(place({ signals: signals({ isHiring: true, openRoles: 3 }) }));
    const fifty = scoreOf(place({ signals: signals({ isHiring: true, openRoles: 50 }) }));
    expect(three.parts.hiring).toBeGreaterThan(0);
    // A company with fifty openings is not ten times the prospect of one with
    // five; without a cap the ranking becomes a list of the largest employers.
    expect(fifty.parts.openRoles).toBeLessThanOrEqual(10);
  });

  it("treats an undetermined headcount as unknown, not as zero", () => {
    const unknown = scoreOf(place({ sirene: { siren: "1", enseignes: [], dirigeants: [], address: {}, effectifTranche: "NN" } }));
    const zero = scoreOf(place({ sirene: { siren: "1", enseignes: [], dirigeants: [], address: {}, effectifTranche: "00" } }));
    expect(unknown.parts.size).toBeUndefined();
    expect(zero.parts.size).toBeDefined();
  });

  it("grows with headcount but sub-linearly", () => {
    const small = scoreOf(place({ sirene: { siren: "1", enseignes: [], dirigeants: [], address: {}, effectifTranche: "11" } })).parts.size ?? 0;
    const large = scoreOf(place({ sirene: { siren: "1", enseignes: [], dirigeants: [], address: {}, effectifTranche: "42" } })).parts.size ?? 0;
    // 100x the headcount is worth ~3x the points, not 100x: the term saturates
    // at its weight so the ranking does not become a list of large employers.
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(small * 3);
  });

  it("rewards being contactable at all", () => {
    const p = place({ contacts: { emails: [{ value: "a@b.fr", from: "P1", lane: "web" }], phones: [], socials: [], people: [] } });
    expect(scoreOf(p).parts.contactable).toBeGreaterThan(0);
  });

  it("keeps the parts visible so a ranking can be argued with", () => {
    const p = place({ signals: signals({ hasPricingPage: true, hasEcommerce: true }) });
    const s = scoreOf(p);
    expect(Object.keys(s.parts)).toContain("pricing");
    expect(s.total).toBe(Object.values(s.parts).reduce((n, v) => n + v, 0));
  });
});

describe("applyFit", () => {
  it("adds the verdict WITHOUT touching the measured total", () => {
    // The measured column is the one nobody had to be trusted for. Overwriting
    // it with a judgement would destroy the only number in the file that is
    // independent of whoever wrote the dossier.
    const p = place({ signals: signals({ isHiring: true, openRoles: 2 }) });
    p.score = scoreOf(p);
    const before = p.score.total;
    applyFit([p], [{ id: p.id, fit: "strong", why: "matches the brief" }]);
    expect(p.score!.total).toBe(before);
    expect(p.score!.fit).toBe("strong");
    expect(p.score!.why).toBe("matches the brief");
  });

  it("reports a verdict for an id this run does not have", () => {
    const result = applyFit([place()], [{ id: "nope", fit: "strong", why: "x" }]);
    expect(result.applied).toBe(0);
    expect(result.unknown).toEqual(["nope"]);
  });

  it("scores a place that had no score yet rather than dropping the verdict", () => {
    const p = place();
    applyFit([p], [{ id: p.id, fit: "weak", why: "x" }]);
    expect(p.score?.fit).toBe("weak");
    expect(typeof p.score?.total).toBe("number");
  });
});

describe("ranked", () => {
  it("puts the agent's verdict ahead of the measurement", () => {
    const judged = place({ id: "a", score: { total: 5, parts: {}, fit: "strong" } });
    const measured = place({ id: "b", score: { total: 90, parts: {} } });
    expect(ranked([measured, judged]).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("falls back to the measured total within the same verdict", () => {
    const lo = place({ id: "a", score: { total: 5, parts: {}, fit: "possible" } });
    const hi = place({ id: "b", score: { total: 40, parts: {}, fit: "possible" } });
    expect(ranked([lo, hi]).map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("ranks an explicit `no` below an unjudged place", () => {
    // A company you looked at and rejected should not outrank one you have not
    // read yet.
    const rejected = place({ id: "a", score: { total: 90, parts: {}, fit: "no" } });
    const unjudged = place({ id: "b", score: { total: 10, parts: {} } });
    expect(ranked([rejected, unjudged]).map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("factSheet", () => {
  it("does not say the street type twice when both lanes supplied one", () => {
    // The register keeps "AVENUE" and "DE NOGENT" apart; OSM's addr:street is
    // "Avenue de Nogent". Joining blindly gives "3 AVENUE Avenue de Nogent".
    const p = place({ address: { numero: "3", typeVoie: "AVENUE", libelleVoie: "Avenue de Nogent", codePostal: "94300", commune: "VINCENNES" } });
    expect(factSheet(p)).toContain("3 Avenue de Nogent, 94300, VINCENNES");
  });

  it("still prefixes the type when the name does not carry it", () => {
    const p = place({ address: { numero: "3", typeVoie: "RUE", libelleVoie: "DE LA PAIX" } });
    expect(factSheet(p)).toContain("3 RUE DE LA PAIX");
  });

  it("states the three hiring states in words, not as a boolean", () => {
    expect(factSheet(place({ signals: signals({ isHiring: true, openRoles: 4, atsProviders: ["lever"] }) }))).toContain("4 open role(s)");
    expect(factSheet(place({ signals: signals({ isHiring: false }) }))).toContain("we looked");
    expect(factSheet(place({ signals: signals({ isHiring: undefined, atsProviders: ["welcometothejungle"] }) }))).toContain("UNKNOWN");
  });

  it("says plainly when no website was found", () => {
    expect(factSheet(place())).toContain("website: none found");
  });

  it("carries the page id beside every contact", () => {
    const p = place({ contacts: { emails: [{ value: "a@b.fr", from: "P7", lane: "web" }], phones: [], socials: [], people: [] } });
    expect(factSheet(p)).toContain("a@b.fr [P7]");
  });
});

describe("dossier scaffolding", () => {
  it("names the file after the place id, sanitised", () => {
    expect(dossierPathFor(place({ id: "osm:n1" }))).toBe("dossiers/osm_n1.md");
  });

  it("marks the one paragraph allowed to be unsourced", () => {
    expect(DOSSIER_TEMPLATE).toContain("[M]");
  });
});
