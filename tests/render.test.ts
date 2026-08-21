import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, toCsv } from "../src/csv.js";
import { buildHtml, buildPrivacyNote, buildReport } from "../src/render.js";
import { buildDelta, diffRuns, identityOf } from "../src/watch.js";
import type { Place, RunManifest } from "../src/types.js";
import { rec } from "./factories.js";

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
    counts: {
      osm: 10,
      registry: 5,
      byConnector: { "fr-sirene": 5 },
      places: 12,
      merged: 3,
      undecided: 1,
      withWebsite: 2,
      enrichedTier1: 2,
      enrichedTier2: 1,
      confirmed: 0,
      dossiers: 0,
    },
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

      termMentions: [],
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
    const p = place({ registry: rec({ officers: [{ nom: "MARTIN", prenoms: "JEAN", qualite: "Président" }] }) });
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
    const m = manifest({
      truncated: true,
      lanes: [{ lane: "registry", mode: "sweep", connectorId: "fr-sirene", requested: 0, returned: 3000, truncated: true, reason: "budget reached" }],
    });
    const report = buildReport([place()], m);
    const firstLines = report.split("\n").slice(0, 6).join("\n");
    expect(firstLines).toContain("does not cover the whole territory");
    expect(firstLines).toContain("budget reached");
  });

  it("labels which taxonomy an activity row comes from", () => {
    // "shop 460 / G 128" side by side reads as one ranking of one thing, and it
    // is two incomparable vocabularies.
    const report = buildReport(
      [place({ id: "a", category: "shop=bakery" }), place({ id: "b", registry: rec({ section: "G", activityScheme: "nace" }) })],
      manifest(),
    );
    expect(report).toContain("shop (OSM tag)");
    expect(report).toContain("Trade and vehicle repair (NACE G)");
  });

  it("names an administrative register code rather than calling it unclassified", () => {
    // The UK files dormant companies under SIC 99999, which is not an activity —
    // so it resolves to no section on purpose. "Dormant company" is a finding
    // about a town; "unclassified" throws it away.
    const report = buildReport(
      [
        place({
          registry: rec({ section: undefined, activityCode: "99999", connectorId: "gb-companies-house", national: { administrativeSic: "dormant company" } }),
        }),
      ],
      manifest(),
    );
    expect(report).toContain("dormant company (gb-companies-house, not an activity code)");
    expect(report).not.toContain("extraterritorial");
  });

  it("carries the attributions", () => {
    expect(buildReport([place()], manifest())).toContain("OpenStreetMap contributors, ODbL");
  });

  it("titles with the place, not the whole administrative chain", () => {
    expect(buildReport([place()], manifest()).split("\n")[0]).toBe("# Vincennes");
  });

  // The header used to read `Swept <date>` unconditionally, eight lines above a
  // coverage table saying `This is NOT a sweep`. The document contradicted itself
  // about the one distinction the architecture exists to keep straight, on every
  // run outside France. These are the tests that would have caught it on day one,
  // and the reason the manifest factory now gets a register lane at all.
  const confirmLane = {
    lane: "registry" as const,
    mode: "confirm" as const,
    connectorId: "eu-vies",
    requested: 40,
    returned: 12,
    truncated: false,
    reason: "confirmed one company at a time: 4 by a published registration number. This is NOT a sweep — companies absent from OSM are absent from this run.",
  };
  const sweepLane = { lane: "registry" as const, mode: "sweep" as const, connectorId: "fr-sirene", requested: 0, returned: 672, truncated: false };
  const osmLane = { lane: "osm" as const, requested: 0, returned: 1069, truncated: false };

  it("never calls a confirmed territory a sweep", () => {
    const report = buildReport([place()], manifest({ lanes: [osmLane, confirmLane] }));
    const header = report.split("## Coverage")[0]!;
    // OSM did sweep the ground, so the word may appear about OSM — never as the
    // unqualified claim the register was enumerated.
    expect(header).not.toMatch(/^Swept /m);
    expect(header).toContain("confirmed company by company");
    expect(header).toContain("a company nobody has mapped is not in this list");
  });

  it("still says Swept where the register really was swept", () => {
    // France, and the reason the fix is a derivation rather than a deletion.
    expect(buildReport([place()], manifest({ lanes: [osmLane, sweepLane] }))).toContain("Swept 2026-08-10 with ultraprospect 1.0.0.");
  });

  it("answers on whether ANY lane swept, not on whichever lane came first", () => {
    // A French run that also ran `confirm` carries BOTH lanes, confirm appended
    // last. Reading lanes[0] — or lanes.at(-1) — answers differently by accident.
    const bothWays = [
      buildReport([place()], manifest({ lanes: [osmLane, sweepLane, confirmLane] })),
      buildReport([place()], manifest({ lanes: [confirmLane, sweepLane, osmLane] })),
    ];
    for (const report of bothWays) expect(report).toContain("Swept 2026-08-10");
  });

  it("says OSM covered the ground when no register lane ran at all", () => {
    const report = buildReport([place()], manifest({ lanes: [osmLane] }));
    expect(report).toContain("no register lane covered this territory");
  });

  it("prints each lane's mode as a column, not only inside its note", () => {
    // `mode` is what types.ts calls the most important field in LaneCoverage and
    // it was rendered nowhere: a reader had to find it in the middle of a prose
    // reason, or not at all.
    const table = buildReport([place()], manifest({ lanes: [osmLane, confirmLane] })).split("## Coverage")[1]!;
    expect(table).toContain("| Lane | Mode | Returned | Complete | Note |");
    expect(table).toMatch(/\| registry \| confirm \|/);
    // A register lane that neither swept nor was confirmed is the ambiguous case,
    // so it is named rather than left blank.
    const notYet = buildReport(
      [place()],
      manifest({ lanes: [{ lane: "registry", requested: 0, returned: 0, truncated: false, reason: "no register can be swept for country=de" }] }),
    );
    expect(notYet).toMatch(/\| registry \| not swept \|/);
  });

  it("says out loud when register records are dated, and names the years", () => {
    // The report is where a reader who will never open places.json learns that an
    // identity was true in 2018 and is not evidence about today.
    const report = buildReport(
      [place({ id: "a", registry: rec({ asOf: "2018-11-01" }) }), place({ id: "b", registry: rec({}) })],
      manifest({ lanes: [osmLane, confirmLane] }),
    );
    expect(report).toContain("Some register records are dated");
    expect(report).toContain("1 of 2 companies");
    expect(report).toContain("2018");
    expect(report).toContain("registry_as_of");
    // And says nothing at all when every record is live — a warning about zero
    // dated records would train a reader to skip the banner.
    expect(buildReport([place({ registry: rec({}) })], manifest())).not.toContain("Some register records are dated");
  });

  it("reports unreadable job boards separately from companies that are not hiring", () => {
    const base = {
      hasWebsite: true,
      pageCount: 1,
      openRoles: 0,

      termMentions: [],
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

  it("does not call a confirmed territory swept in the subtitle either", () => {
    // The page carried the same defect as the report's third line: a bare
    // "· swept <date> ·" under the town name, on every German or British run.
    const confirmed = buildHtml(
      [place()],
      manifest({
        lanes: [
          { lane: "osm", requested: 0, returned: 40, truncated: false },
          { lane: "registry", mode: "confirm", connectorId: "eu-vies", requested: 40, returned: 12, truncated: false },
        ],
      }),
    );
    expect(confirmed).not.toContain("· swept ");
    expect(confirmed).toContain("register confirmed company by company");
    const swept = buildHtml(
      [place()],
      manifest({ lanes: [{ lane: "registry", mode: "sweep", connectorId: "fr-sirene", requested: 0, returned: 672, truncated: false }] }),
    );
    expect(swept).toContain("· swept 2026-08-10 ·");
  });
});

describe("PRIVACY.md", () => {
  it("is written only when the run actually holds people", () => {
    expect(buildPrivacyNote([place()], manifest())).toBeUndefined();
    const withOfficer = place({ registry: rec({ officers: [{ nom: "MARTIN", qualite: "Gérant" }] }) });
    // The phrase wraps across lines in the rendered note, so match on a token
    // that cannot: the obligation itself.
    expect(buildPrivacyNote([withOfficer], manifest())).toContain("GDPR");
  });

  it("says where each category of personal data came from", () => {
    const withOfficer = place({ registry: rec({ officers: [{ nom: "MARTIN", qualite: "Gérant" }] }) });
    const note = buildPrivacyNote([withOfficer], manifest())!;
    expect(note).toContain("the company registers listed in the manifest");
    expect(note).toContain("--no-people");
  });
});

describe("watch", () => {
  const base = {
    hasWebsite: true,
    pageCount: 1,
    openRoles: 0,

    termMentions: [],
    atsProviders: [],
    analytics: [],
    techStack: [],
    hasPricingPage: false,
    hasEcommerce: false,
    languages: [],
    socialProfiles: [],
  };
  const reg = (establishmentId: string, status: "active" | "ceased" = "active") => rec({ id: establishmentId.slice(0, 9), establishmentId, status });

  it("keys on the SIRET so a place that gains a register match is not a closure plus an opening", () => {
    const before = place({ id: "fr-sirene:123", registry: reg("12345678900011") });
    const after = place({ id: "osm:n1", osm: { id: "n1", osmType: "node", osmId: 1, lat: 0, lon: 0, tags: {} }, registry: reg("12345678900011") });
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
    const before = [place({ id: "a", registry: reg("11111111100011") }), place({ id: "b", registry: reg("22222222200011") })];
    const after = [place({ id: "a", registry: reg("11111111100011", "ceased") })];
    const d = diffRuns(before, after);
    expect(d.closed.map((p) => p.registry!.establishmentId)).toEqual(["11111111100011"]);
    expect(d.disappeared.map((p) => p.registry!.establishmentId)).toEqual(["22222222200011"]);
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

  it("DELTA.md compares two runs without calling either one a sweep", () => {
    // Same defect as the report's header, third occurrence: two German runs are
    // both confirm-mode, and "comparing the sweep of" describes neither.
    const delta = buildDelta(diffRuns([place()], [place()]), manifest(), manifest({ builtAt: "2026-09-10T00:00:00.000Z" }));
    expect(delta).toContain("Comparing the run of 2026-08-10 with the one of 2026-09-10.");
    expect(delta).not.toContain("Comparing the sweep");
  });
});
