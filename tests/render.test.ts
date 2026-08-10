import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, toCsv } from "../src/csv.js";
import { buildHtml, buildPrivacyNote, buildReport } from "../src/render.js";
import { diffRuns, identityOf } from "../src/watch.js";
import type { Place, RunManifest } from "../src/types.js";

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
    target: { query: "Vincennes", label: "Vincennes, Val-de-Marne, France", lat: 48.8, lon: 2.4, bbox: [48.8, 48.9, 2.4, 2.5], source: "nominatim" },
    filters: {},
    lanes: [{ lane: "osm", requested: 0, returned: 10, truncated: false }],
    counts: { osm: 10, sirene: 5, google: 0, places: 12, merged: 3, undecided: 1, withWebsite: 2, enrichedTier1: 2, enrichedTier2: 1, dossiers: 0 },
    truncated: false,
    notes: [],
    licences: ["Places and tags: © OpenStreetMap contributors, ODbL"],
    timings: {},
    ...over,
  };
}

describe("CSV", () => {
  it("keeps the measured score and the human verdict in separate columns", () => {
    // A single blended number would be more convenient and would destroy the
    // only column nobody had to be trusted for.
    expect(CSV_COLUMNS).toContain("score");
    expect(CSV_COLUMNS).toContain("fit");
    const csv = toCsv([place({ score: { total: 42, parts: {}, fit: "strong", why: "matches" } })]);
    const row = csv.split("\n")[1]!.split(",");
    expect(row[2]).toBe("42");
    expect(row[3]).toBe("strong");
  });

  it("carries the provenance of every contact beside it", () => {
    const csv = toCsv([place({ contacts: { emails: [{ value: "a@b.fr", from: "P7", lane: "web" }], phones: [], socials: [], people: [] } })]);
    expect(csv).toContain("a@b.fr");
    expect(csv).toContain("P7");
  });

  it("distinguishes not-hiring from we-could-not-look", () => {
    const base = {
      hasWebsite: true,
      pageCount: 1,
      openRoles: 0,
      atsProviders: [],
      analytics: [],
      techStack: [],
      hasPricingPage: false,
      hasEcommerce: false,
      languages: [],
      socialProfiles: [],
    };
    const rows = toCsv([
      place({ id: "a", signals: { ...base, isHiring: false } }),
      place({ id: "b", signals: { ...base, isHiring: undefined, atsProviders: ["welcometothejungle"] } }),
    ]).split("\n");
    const hiringCol = CSV_COLUMNS.indexOf("is_hiring");
    expect(rows[1]!.split(",")[hiringCol]).toBe("no");
    // Empty, not "no": a board we could not read is not an absence of hiring.
    expect(rows[2]!.split(",")[hiringCol]).toBe("");
  });

  it("quotes a name containing a comma rather than splitting the row", () => {
    const csv = toCsv([place({ name: 'Dupont, Fils & Cie "Le Vrai"' })]);
    expect(csv.split("\n")).toHaveLength(3); // header, row, trailing newline
    expect(csv).toContain('"Dupont, Fils & Cie ""Le Vrai"""');
  });

  it("drops officers under --no-people", () => {
    const p = place({ sirene: { siren: "1", enseignes: [], address: {}, dirigeants: [{ nom: "MARTIN", prenoms: "JEAN", qualite: "Président" }] } });
    expect(toCsv([p])).toContain("MARTIN");
    expect(toCsv([p], { noPeople: true })).not.toContain("MARTIN");
  });

  it("filters by measured score and by verdict", () => {
    const list = [place({ id: "a", score: { total: 10, parts: {} } }), place({ id: "b", score: { total: 80, parts: {}, fit: "strong" } })];
    expect(toCsv(list, { minScore: 50 }).split("\n").filter(Boolean)).toHaveLength(2);
    expect(toCsv(list, { minFit: "possible" }).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("does not print the street type twice", () => {
    const p = place({ address: { numero: "3", typeVoie: "AVENUE", libelleVoie: "Avenue de Nogent" } });
    expect(toCsv([p])).toContain("3 Avenue de Nogent");
  });
});

describe("REPORT.md", () => {
  it("LEADS with the truncation warning", () => {
    // Not a footnote. A prospect file that quietly covers part of a town is the
    // one failure nobody downstream can detect.
    const m = manifest({ truncated: true, lanes: [{ lane: "sirene", requested: 0, returned: 3000, truncated: true, reason: "budget reached" }] });
    const report = buildReport([place()], m);
    const firstLines = report.split("\n").slice(0, 6).join("\n");
    expect(firstLines).toContain("does not cover the whole territory");
    expect(firstLines).toContain("budget reached");
  });

  it("labels which taxonomy an activity row comes from", () => {
    // "shop 460 / G 128" side by side reads as one ranking of one thing, and it
    // is two incomparable vocabularies.
    const report = buildReport(
      [place({ id: "a", category: "shop=bakery" }), place({ id: "b", sirene: { siren: "1", enseignes: [], dirigeants: [], address: {}, section: "G" } })],
      manifest(),
    );
    expect(report).toContain("shop (OSM tag)");
    expect(report).toContain("Trade and vehicle repair (NAF G)");
  });

  it("carries the attributions", () => {
    expect(buildReport([place()], manifest())).toContain("OpenStreetMap contributors, ODbL");
  });

  it("titles with the place, not the whole administrative chain", () => {
    expect(buildReport([place()], manifest()).split("\n")[0]).toBe("# Vincennes");
  });

  it("reports unreadable job boards separately from companies that are not hiring", () => {
    const base = {
      hasWebsite: true,
      pageCount: 1,
      openRoles: 0,
      atsProviders: ["welcometothejungle"],
      analytics: [],
      techStack: [],
      hasPricingPage: false,
      hasEcommerce: false,
      languages: [],
      socialProfiles: [],
    };
    expect(buildReport([place({ signals: { ...base, isHiring: undefined } })], manifest())).toContain("unknown, not absent");
  });
});

describe("index.html", () => {
  const html = buildHtml([place({ lat: 48.8, lon: 2.4, score: { total: 10, parts: {} } })], manifest());

  it("loads no external asset", () => {
    // No tiles, no CDN, no font, no analytics. A page about who somebody's
    // prospects are should not phone anyone while it is being read.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/@import|url\(https?:/i);
  });

  it("draws the map as inline SVG from the run's own coordinates", () => {
    expect(html).toContain("<svg");
    expect(html).toContain("<circle");
  });

  it("defines its colours for both themes", () => {
    expect(html).toContain(":root{--bg:");
    expect(html).toContain("prefers-color-scheme:dark");
  });

  it("escapes a company name containing markup", () => {
    const nasty = buildHtml([place({ name: "<script>alert(1)</script>" })], manifest());
    expect(nasty).not.toContain("<script>alert(1)</script>");
    expect(nasty).toContain("&lt;script&gt;");
  });

  it("shows the truncation banner when the run is partial", () => {
    expect(buildHtml([place()], manifest({ truncated: true }))).toContain("does not cover the whole territory");
  });
});

describe("PRIVACY.md", () => {
  it("is written only when the run actually holds people", () => {
    expect(buildPrivacyNote([place()], manifest())).toBeUndefined();
    const withOfficer = place({ sirene: { siren: "1", enseignes: [], address: {}, dirigeants: [{ nom: "MARTIN", qualite: "Gérant" }] } });
    // The phrase wraps across lines in the rendered note, so match on a token
    // that cannot: the obligation itself.
    expect(buildPrivacyNote([withOfficer], manifest())).toContain("GDPR");
  });

  it("says where each category of personal data came from", () => {
    const withOfficer = place({ sirene: { siren: "1", enseignes: [], address: {}, dirigeants: [{ nom: "MARTIN", qualite: "Gérant" }] } });
    const note = buildPrivacyNote([withOfficer], manifest())!;
    expect(note).toContain("Registre national des entreprises");
    expect(note).toContain("--no-people");
  });
});

describe("watch", () => {
  const base = {
    hasWebsite: true,
    pageCount: 1,
    openRoles: 0,
    atsProviders: [],
    analytics: [],
    techStack: [],
    hasPricingPage: false,
    hasEcommerce: false,
    languages: [],
    socialProfiles: [],
  };
  const sirene = (siret: string, etat = "A") => ({ siren: siret.slice(0, 9), siret, enseignes: [], dirigeants: [], address: {}, etatAdministratif: etat });

  it("keys on the SIRET so a place that gains a register match is not a closure plus an opening", () => {
    const before = place({ id: "sirene:123", sirene: sirene("12345678900011") });
    const after = place({ id: "osm:n1", osm: { id: "n1", osmType: "node", osmId: 1, lat: 0, lon: 0, tags: {} }, sirene: sirene("12345678900011") });
    expect(identityOf(before)).toBe(identityOf(after));
    const d = diffRuns([before], [after]);
    expect(d.appeared).toHaveLength(0);
    expect(d.disappeared).toHaveLength(0);
  });

  it("reports a company that started hiring", () => {
    const before = place({ signals: { ...base, isHiring: false } });
    const after = place({ signals: { ...base, isHiring: true, openRoles: 3 }, jobs: [{ title: "Dev", via: "lever" }] });
    const d = diffRuns([before], [after]);
    expect(d.startedHiring).toHaveLength(1);
    expect(d.startedHiring[0]!.roles).toBe(3);
  });

  it("does NOT call an unreadable board 'stopped hiring'", () => {
    // That would invent a change out of our own loss of reach.
    const before = place({ signals: { ...base, isHiring: true, openRoles: 2 } });
    const after = place({ signals: { ...base, isHiring: undefined, atsProviders: ["welcometothejungle"] } });
    expect(diffRuns([before], [after]).stoppedHiring).toHaveLength(0);
  });

  it("separates ceased-by-the-register from gone-from-the-sweep", () => {
    const before = [place({ id: "a", sirene: sirene("11111111100011") }), place({ id: "b", sirene: sirene("22222222200011") })];
    const after = [place({ id: "a", sirene: sirene("11111111100011", "C") })];
    const d = diffRuns(before, after);
    expect(d.closed.map((p) => p.sirene!.siret)).toEqual(["11111111100011"]);
    expect(d.disappeared.map((p) => p.sirene!.siret)).toEqual(["22222222200011"]);
  });

  it("notices a new website and a moved one", () => {
    const site = (url: string) => ({ url, confidence: "corroborated" as const, evidence: ["P1"] });
    expect(diffRuns([place()], [place({ website: site("https://a.fr") })]).gotWebsite).toHaveLength(1);
    expect(diffRuns([place({ website: site("https://a.fr") })], [place({ website: site("https://b.fr") })]).siteChanged).toHaveLength(1);
  });

  it("does not count an unverified candidate as gaining a website", () => {
    const after = place({ website: { url: "https://maybe.fr", confidence: "unverified", evidence: ["P1"] } });
    expect(diffRuns([place()], [after]).gotWebsite).toHaveLength(0);
  });
});
