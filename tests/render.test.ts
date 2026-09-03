import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, toCsv } from "../src/csv.js";
import { collectEvidence } from "../src/excerpts.js";
import { buildHtml, buildPrivacyNote, buildReport, HTML_ROW_CAP } from "../src/render.js";
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

/** A signals block with every list present and nothing claimed. */
const signals = {
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
      registryWithCoordinates: 5,
      byConnector: { "fr-sirene": 5 },
      places: 12,
      merged: 3,
      mergedByIdentifier: 0,
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
    const csv = toCsv([
      place({
        contacts: {
          emails: [{ value: "a@b.fr", from: "P7", lane: "web" }],
          phones: [{ value: "+33143283007", from: "osm:n1", lane: "osm" }],
          socials: [{ value: "https://instagram.com/acme", from: "P9", lane: "web" }],
          people: [],
        },
      }),
    ]);
    const row = csv.split("\n")[1]!.split(",");
    expect(CSV_COLUMNS).toContain("phone_source");
    expect(CSV_COLUMNS).toContain("social_source");
    expect(row[CSV_COLUMNS.indexOf("contact_source")]).toBe("P7");
    expect(row[CSV_COLUMNS.indexOf("phone_source")]).toBe("osm:n1");
    expect(row[CSV_COLUMNS.indexOf("social_source")]).toBe("P9");
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

describe("HTML contact citations", () => {
  it.each([
    ["osm:n248494308", "node", "248494308"],
    ["osm:w42", "way", "42"],
    ["osm:r7", "relation", "7"],
  ])("links %s to the mapped OpenStreetMap feature", (from, featureType, id) => {
    const p = place({
      contacts: { emails: [{ value: "a@b.fr", from, lane: "osm" }], phones: [], socials: [], people: [] },
    });
    const html = buildHtml([p], manifest(), collectEvidence(".", [p]));
    expect(html).toContain(`href="https://www.openstreetmap.org/${featureType}/${id}"`);
  });

  it("renders a verbatim social handle as text, not as a relative link", () => {
    const p = place({
      contacts: { emails: [], phones: [], socials: [{ value: "@acme", from: "osm:n1", lane: "osm" }], people: [] },
    });
    const html = buildHtml([p], manifest(), collectEvidence(".", [p]));
    expect(html).toContain("@acme");
    expect(html).not.toContain('href="@acme"');
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

  // A pipe inside a company name silently splits a markdown row into two
  // columns. The Hamburg run shipped `| 5 | Schäfer | Group | 56 | strong |` —
  // a real company, and a table that read a score of "strong" from then on.
  it("escapes a pipe in a company name rather than splitting the row", () => {
    const p = place({ name: "Schäfer | Group", score: { total: 56, parts: {} } });
    const report = buildReport([p], manifest());
    const rankedRow = report.split("\n").find((line) => line.includes("Schäfer"))!;
    expect(rankedRow).toContain("Schäfer \\| Group");
    // Nine columns of content, so ten cells once split on the delimiters.
    expect(rankedRow.split(/(?<!\\)\|/)).toHaveLength(11);
  });

  it("escapes a pipe in the hiring table too", () => {
    const p = place({
      name: "A | B",
      signals: { ...signals, isHiring: true, openRoles: 2, atsProviders: ["personio"] },
    });
    const hiring = buildReport([p], manifest()).split("## Who is hiring")[1]!.split("##")[0]!;
    expect(hiring).toContain("A \\| B");
  });

  it("quotes the verdict somebody wrote, verbatim", () => {
    // `why` and `angle` are the most expensive fields in a run — a person read a
    // dossier and decided — and they reached no deliverable at all. Verbatim,
    // because a judgement paraphrased by the tool carrying it is no longer that
    // person's judgement.
    const why = "A DevOps role has been open 305 days on their Personio board.";
    const angle = "Write to the opening directly.";
    const report = buildReport([place({ score: { total: 81, parts: {}, fit: "strong", why, angle } })], manifest());
    expect(report).toContain("## Judged (1 of 1)");
    expect(report).toContain(`**Why.** ${why}`);
    expect(report).toContain(`**Angle.** ${angle}`);
  });

  it("says an empty Fit column means unread, not rejected", () => {
    const judged = place({ id: "a", score: { total: 80, parts: {}, fit: "strong", why: "yes" } });
    const report = buildReport([judged, place({ id: "b" }), place({ id: "c" })], manifest());
    expect(report).toContain("2 companies carry a measured score and no verdict");
    expect(report).toContain("not because they were rejected");
    // And no section at all when nobody has judged anything: a "Judged (0)"
    // heading is a heading that trains a reader to skip the section.
    expect(buildReport([place()], manifest())).not.toContain("## Judged");
  });

  it("names what the run was narrowed to, and stays quiet when it was not", () => {
    // A run filtered to `office` tags produces an activity table that is 99%
    // "office", which reads as a broken taxonomy rather than as the answer to
    // the question that was actually asked.
    const narrowed = buildReport([place()], manifest({ filters: { osmGroups: ["office"], includeCeased: false } }));
    expect(narrowed).toContain("What this run looked for: OSM `office` tags only");
    // Excluding ceased companies is the default; a default reported as a finding
    // trains a reader to skip the section that matters.
    expect(narrowed).not.toContain("ceased companies");
    expect(buildReport([place()], manifest({ filters: { osmGroups: "all", includeCeased: false } }))).not.toContain("What this run looked for");
  });

  it("counts repeated run notes instead of drowning in them", () => {
    // The report printed `notes.slice(-25)` — the last 25 of 1 447 on a real run
    // — so twenty-five near-identical VIES lines pushed every lane summary out
    // of the window. Repetition is information; it is counted, not reprinted.
    const notes = ["confirm: 144 verified, 810 matched by name", ...Array.from({ length: 40 }, () => "vies: DE032000000 is not registered")];
    const report = buildReport([place()], manifest({ notes }));
    expect(report).toContain("## Run notes (2 distinct of 41)");
    expect(report).toContain("- ×40 vies: DE032000000 is not registered");
    // The lane summary is what describes the run, so it survives and it leads.
    expect(report).toContain("- confirm: 144 verified, 810 matched by name");
    const lines = report
      .split("## Run notes")[1]!
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("confirm:");
  });

  it("does not report zero hiring on a run that never read a site", () => {
    // Straight off the Vincennes fixture: `scan` alone produced
    // "0 hiring right now · 0 not hiring", which reads as "we looked and found
    // nobody". Nobody had looked. Same rule as the three-valued `isHiring`,
    // applied one level up.
    const report = buildReport([place(), place({ id: "b" })], manifest());
    expect(report).not.toContain("0 hiring right now");
    expect(report).toContain("no site in this run has been read yet");
    expect(report).toContain("unknown rather than absent");
    // And on a run that did enrich, the counts come back.
    expect(buildReport([place({ signals: { ...signals, isHiring: false } })], manifest())).toContain("0 hiring right now");
  });

  it("counts the companies whose site was never read apart from the ones not hiring", () => {
    const report = buildReport([place({ id: "a", signals: { ...signals, isHiring: false } }), place({ id: "b" })], manifest());
    expect(report).toContain("1 whose site was never read at all");
  });

  it("says which register answered, and how it was persuaded", () => {
    // A run backed by confirmed registration numbers and one backed by name
    // lookups are not the same run, and neither fact reached a reader.
    const report = buildReport(
      [
        place({ id: "a", registry: rec({ connectorId: "gleif" }), registryEvidence: { mode: "confirm", how: "verified-id" } }),
        place({ id: "b", registry: rec({ connectorId: "de-offeneregister" }), registryEvidence: { mode: "confirm", how: "name-lookup" } }),
      ],
      manifest(),
    );
    expect(report).toContain("Register records by connector: gleif 1 · de-offeneregister 1");
    expect(report).toContain("1 by a published registration number");
    expect(report).toContain("1 by a name lookup");
  });

  it("does not describe an OSM-declared legal identifier as found on a company site", () => {
    const report = buildReport(
      [place({ legalIds: [{ kind: "siret", value: "30247464801175", from: "osm:n1", status: "verified", authority: "fr-sirene" }] })],
      manifest(),
    );

    expect(report).toContain("declared in OSM or found on the companies' own sites");
    expect(report).not.toContain("Legal identifiers found on the companies' own sites");
  });

  it("renders a legacy manifest without an undefined identifier count", () => {
    const legacy = manifest();
    delete (legacy.counts as Partial<RunManifest["counts"]>).mergedByIdentifier;

    const report = buildReport([place()], legacy);

    expect(report).toContain("0 by a declared identifier");
    expect(report).not.toContain("undefined by a declared identifier");
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

  it("binds its script to the prospects table, not to whichever tbody comes first", () => {
    // The page carries TWO tables: Coverage (Lane/Mode/Returned) above, and the
    // prospects below. `document.querySelector("tbody")` takes the first one in
    // the document, which is Coverage — and Coverage holds no `tr.r` at all.
    //
    // Measured on a real Hamburg run: `rows` came out empty, so the click
    // listener sat on the wrong table and every interactive feature on the page
    // was dead at once — opening a company, the search box, the facet chips,
    // the column sort, the row counter, and clicking a point on the map (which
    // resolves its row by id but then needs the `detail` link this loop
    // assigns). Nothing threw; the page just stopped responding.
    //
    // So the selector must name the prospects table. Anchoring the test on the
    // rendered markup rather than on the source string keeps it honest: the id
    // has to exist on the table AND be what the script looks for.
    const id = html.match(/<table id="([a-z-]+)">\s*<thead><tr><th class="n">#<\/th>/)?.[1];
    expect(id, "the prospects table needs an id the script can address").toBeTruthy();
    expect(html).toContain(`#${id} tbody`);

    // And the Coverage table must still come first in the document, because
    // that ordering is exactly what made the bare selector wrong.
    expect(html.indexOf("<th>Lane</th>")).toBeLessThan(html.indexOf(`<table id="${id}">`));
  });

  it("lists every opening in one place, not just a count per company", () => {
    // A count tells you a company is hiring. It does not tell you what for,
    // which is the only thing a reader can act on — and reaching the titles
    // meant opening one company panel at a time.
    const hiring = (id: string, name: string, titles: string[]) =>
      place({
        id,
        name,
        jobs: titles.map((t) => ({ title: t, url: `https://x/${t}`, location: "Hamburg", employmentType: "freelance", via: "personio" })),
        signals: { ...signals, isHiring: true, openRoles: titles.length },
      });
    const page = buildHtml([hiring("osm:n1", "Acme", ["Backend Entwickler", "DevOps Engineer"]), hiring("osm:n2", "Beta", ["Datenanalyst"])], manifest());

    const board = page.slice(page.indexOf('id="openings"'));
    expect(board).toBeTruthy();
    for (const t of ["Backend Entwickler", "DevOps Engineer", "Datenanalyst"]) expect(board).toContain(t);
    // Each opening names the company it belongs to: a title with no employer is
    // not a lead, and the list is sorted across companies rather than grouped.
    expect(board).toContain("Acme");
    expect(board).toContain("Beta");
    expect(board).toContain("freelance");
  });

  it("loads no external asset, and cannot reach the network at all", () => {
    // No tiles, no CDN, no font, no analytics. A page about who somebody's
    // prospects are should not phone anyone while it is being read.
    //
    // This used to be enforced by banning `<script>` outright, which was the
    // blunt way to say it while the page had nothing to run. The page now
    // filters and sorts in place — eight hundred rows are not readable
    // otherwise — so the ban is stated as what it always meant, and it is
    // STRICTER than before: an inline script that called fetch() would have
    // passed the old rule and fails this one.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/@import|url\(https?:/i);
    expect(html).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource|\bimport\s*\(/i);
  });

  it("makes every citation openable, even where no passage was collected", () => {
    // Measured on a Hamburg run: 877 of 1251 citations rendered as a bare
    // `[P42]` — an id the reader cannot resolve to anything. The passage cache
    // is capped so the file stays openable (QUOTES_PER_PLACE, QUOTES_TOTAL),
    // and past the cap the citation lost its link entirely.
    //
    // But the page's URL is known for every citation, always, and it costs ~60
    // bytes against a passage's ~340. So the two are separate: the passage is
    // rationed, the link never is. A source you cannot open is not a source.
    const withContact = place({
      contacts: { emails: [{ value: "kontakt@acme.de", from: "P4", lane: "web" }], phones: [], socials: [], people: [] },
      pages: ["P4"],
    });
    const pages = new Map([["osm:n1 P4", { url: "https://acme.de/impressum", role: "legal", fetchedAt: "2026-08-23T10:00:00.000Z" }]]);
    const page = buildHtml([withContact], manifest(), { pages });
    expect(page).toContain("https://acme.de/impressum");
    expect(page).not.toMatch(/<span class="src">\[P4\]<\/span>/);
  });

  it("carries no map, and says the coordinates on the row instead", () => {
    // The map was removed rather than improved. Points on white with no
    // coastline and no street tell a prospector nothing they can act on, and a
    // basemap worth reading needs tiles — which need the network this page
    // refuses. Pinned so it does not creep back as a half-map.
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<circle");
    expect(html).toContain("48.80000, 2.40000");
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

  // Everything below is what the page was missing: the run reads contacts, roles,
  // register identities and a thirteen-term score, and rendered a seven-column
  // table. A run that had read 1 116 pages looked exactly like one that read none.
  const rich = place({
    name: "WPS",
    lat: 53.58,
    lon: 10.01,
    score: {
      total: 81,
      parts: { hasSite: 10, hiring: 15, staleRole: 8 },
      fit: "strong",
      why: "A DevOps role has been open 305 days.",
      angle: "Write to the opening directly.",
    },
    website: { url: "https://www.wps.de/", confidence: "corroborated", evidence: ["P340"] },
    contacts: {
      emails: [{ value: "info@wps.de", from: "P1587", lane: "web" }],
      phones: [{ value: "+49402294990", from: "P1587", lane: "web" }],
      socials: [],
      people: [],
    },
    jobs: [{ title: "DevOps Engineer", location: "Hamburg", via: "personio", url: "https://example.invalid/job" }],
    registry: rec({ connectorId: "gleif", id: "9676009W8TU4WAOPEI88", legalName: "WPS - Workplace Solutions GmbH" }),
    legalIds: [{ kind: "vat", value: "DE118593050", status: "attested", authority: "eu-vies", note: "DE discloses no name" }],
    signals: { ...signals, isHiring: true, openRoles: 1, cms: "TYPO3", pageCount: 4 },
    pages: ["P340", "P1587"],
  });
  const detailed = buildHtml([rich], manifest());

  it("renders the verdict a person wrote", () => {
    expect(detailed).toContain("A DevOps role has been open 305 days.");
    expect(detailed).toContain("Write to the opening directly.");
  });

  it("renders each contact with the page it was read from", () => {
    // The page id is the whole basis of the citation gate. A contact rendered
    // without it cannot be audited by whoever ends up emailing it.
    expect(detailed).toContain("info@wps.de");
    expect(detailed).toContain("[P1587]");
    expect(detailed).toContain("mailto:info@wps.de");
  });

  it("renders the open roles, the register identity and the score breakdown", () => {
    expect(detailed).toContain("DevOps Engineer");
    expect(detailed).toContain("9676009W8TU4WAOPEI88");
    expect(detailed).toContain("WPS - Workplace Solutions GmbH");
    // The parts are what make a ranking arguable rather than believed.
    expect(detailed).toContain("website corroborated");
    expect(detailed).toContain("a role open 90+ days");
  });

  it("does not let an attested identifier read as a verified one", () => {
    // VIES will confirm a German VAT number is live and refuse to say whose it
    // is. That is a real, citable fact and it is NOT an identity.
    expect(detailed).toContain("DE118593050");
    expect(detailed).toContain(">attested<");
  });

  it("escapes markup inside a verdict, not only inside a name", () => {
    const nasty = buildHtml([place({ score: { total: 1, parts: {}, fit: "strong", why: "<script>alert(1)</script>", angle: "<b>x</b>" } })], manifest());
    expect(nasty).not.toContain("<script>alert(1)</script>");
    expect(nasty).toContain("&lt;script&gt;");
  });

  it("still makes no network request once it carries contacts and links", () => {
    // mailto: and tel: are handoffs to another application, not requests, and
    // an external link is only followed if a reader clicks it. The promise is
    // that OPENING the page reaches nobody.
    expect(detailed).not.toMatch(/<script[^>]+src=/i);
    expect(detailed).not.toMatch(/<link[^>]+stylesheet/i);
    expect(detailed).not.toMatch(/<img/i);
    expect(detailed).not.toMatch(/@import|url\(https?:/i);
    expect(detailed).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource|\bimport\s*\(/i);
  });

  // The brief is `--term` and `--role`: what the caller actually asked. It was
  // carried on every place, used by the score and written to the CSV, and stated
  // nowhere a reader would see — so the page reported "termMatches 12" without
  // ever saying what had been matched.
  describe("the question the run was asked", () => {
    const brief = { termLexicon: ["honorarbasis", "freelancer"], roleFilter: ["devops", "engineer"] };
    const hit = place({
      name: "No Limit",
      signals: {
        ...signals,
        ...brief,
        termMentions: [{ value: "Honorarbasis", from: "P6733", lane: "web", note: "auf Honorarbasis oder im festen" }],
      },
      pages: ["P6733"],
    });

    it("states the brief on the page, with its own vocabulary", () => {
      const html = buildHtml([hit], manifest());
      expect(html).toContain("The question this run was given");
      expect(html).toContain("<code>honorarbasis</code>");
      expect(html).toContain("<code>devops</code>");
      // …and says nothing at all when no brief was given, rather than an empty box.
      expect(buildHtml([place()], manifest())).not.toContain("The question this run was given");
    });

    it("answers it per company, quoting their own words", () => {
      const html = buildHtml([hit], manifest());
      expect(html).toContain("their own site uses the words you asked about");
      expect(html).toContain("“<b>Honorarbasis</b>”");
      expect(html).toContain("[P6733]");
    });

    it("does not turn our own reach into a fact about them", () => {
      // No mentions but the site WAS read: a miss on the pages we read.
      const read = place({ id: "b", signals: { ...signals, ...brief }, pages: ["P1"] });
      expect(buildHtml([read], manifest())).toContain("That is a miss on the pages we read, not proof they never use the word");
      // Site never read: the brief has not been tested against them at all. The
      // brief has to exist in the run for the question to arise, so `hit`
      // carries the lexicon and `unread` is the company nobody reached.
      const unread = place({ id: "c" });
      expect(buildHtml([hit, unread], manifest())).toContain("terms you asked about have not been looked for here at all");
      // And a run with no brief says nothing about one, rather than an empty verdict.
      expect(buildHtml([unread], manifest())).not.toContain("have not been looked for here");
    });

    it("offers a facet for the companies that answer it", () => {
      const html = buildHtml([hit, place({ id: "z" })], manifest());
      expect(html).toContain('data-facet="brief"');
      expect(html).toContain("answers the brief");
    });
  });

  it("lays the panel out the way a dossier is written", () => {
    // Same headings as DOSSIER_TEMPLATE, so the page and the write-up a person
    // produces from the same run are the same shape.
    for (const heading of ["What they do", "Size and shape", "Signals", "Angle", "Contacts", "Gaps"]) {
      expect(detailed).toContain(`<dt>${heading}</dt>`);
    }
  });

  it("names what could not be established instead of leaving a hole", () => {
    const bare = buildHtml([place()], manifest());
    expect(bare).toContain("<dt>Gaps</dt>");
    expect(bare).toContain("an OpenStreetMap point and nothing more");
    // A place with some of it missing gets the itemised list, not the sentence.
    const partial = buildHtml([place({ website: { url: "https://a.fr", confidence: "corroborated", evidence: ["P1"] }, signals: { ...signals } })], manifest());
    expect(partial).toContain("no register record was attached");
    expect(partial).not.toContain("an OpenStreetMap point and nothing more");
  });

  it("collapses an officer the register filed twice", () => {
    const twice = buildHtml(
      [
        place({
          registry: rec({
            officers: [
              { nom: "DASSLER", prenoms: "Stephan", qualite: "Geschäftsführer" },
              { nom: "DASSLER", prenoms: "Stephan", qualite: "Geschäftsführer" },
            ],
          }),
        }),
      ],
      manifest(),
    );
    expect(twice.match(/Stephan DASSLER/g) ?? []).toHaveLength(1);
  });

  it("renders a written dossier when one exists, and escapes it", () => {
    const dossiers = new Map([["osm:n1", "## What they do\n\nThey ship **widgets**. [P1]\n\n- one\n- <script>alert(1)</script>\n"]]);
    const html = buildHtml([place()], manifest(), { dossiers });
    expect(html).toContain("<dt>Written dossier</dt>");
    expect(html).toContain("<h4>What they do</h4>");
    expect(html).toContain("ship <b>widgets</b>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not put a zero under 'hiring now' when no site was read", () => {
    const html = buildHtml([place()], manifest());
    expect(html).toContain("hiring: no site read yet, so unknown rather than none");
    expect(html).not.toContain("open roles</span>");
    expect(buildHtml([place({ signals: { ...signals, isHiring: false } })], manifest())).toContain("open roles</span>");
  });

  it("carries the dated-register warning the report has always carried", () => {
    // The page was the safer-looking of the two documents about exactly the fact
    // that makes it less safe.
    const html = buildHtml([place({ registry: rec({ asOf: "2018-11-01" }) })], manifest());
    expect(html).toContain("Some register records are dated");
    expect(html).toContain("2018");
    expect(buildHtml([place({ registry: rec({}) })], manifest())).not.toContain("Some register records are dated");
  });

  it("says on the page what the run was narrowed to", () => {
    const html = buildHtml([place()], manifest({ filters: { osmGroups: ["office"] } }));
    expect(html).toContain("What this run looked for:");
    expect(html).toContain("OSM `office` tags only");
    expect(buildHtml([place()], manifest())).not.toContain("What this run looked for");
  });

  it("puts the coverage table on the page, not only in the report", () => {
    const html = buildHtml(
      [place()],
      manifest({
        lanes: [
          { lane: "osm", requested: 0, returned: 40, truncated: false },
          { lane: "registry", mode: "confirm", connectorId: "eu-vies", requested: 40, returned: 12, truncated: false },
        ],
      }),
    );
    expect(html).toContain("Coverage — what this run actually asked");
    expect(html).toContain("<td>confirm</td>");
  });

  it("shows every panel when JavaScript is switched off", () => {
    // The panel is markup rather than something the script builds, so a browser
    // with scripting off shows everything rather than nothing.
    expect(detailed).toContain("<noscript>");
    expect(detailed).toMatch(/<noscript><style>[^<]*tr\.d\{display:table-row\}/);
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

describe("buildHtml is usable at the size a real run produces", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => place({ id: `osm:n${i}`, name: `Firma ${i}` }));

  it("says so when the table shows fewer rows than the run holds", () => {
    // The page caps the table so a browser can open it. Capping is fine;
    // capping SILENTLY is the one thing this tool refuses everywhere else —
    // a reader counting rows would conclude the territory stops at the cap.
    //
    // Asserted against the exported constant rather than against a number typed
    // here: this test used to hardcode 500 and started failing the day the cap
    // moved, which tested the number instead of the disclosure.
    const html = buildHtml(many(HTML_ROW_CAP + 354), manifest());
    expect(html).toMatch(new RegExp(`showing .*${HTML_ROW_CAP}.* of .*${HTML_ROW_CAP + 354}`, "i"));
  });

  it("says nothing about a cap when there was none", () => {
    expect(buildHtml(many(12), manifest())).not.toMatch(/showing/i);
  });

  it("ships a filter and sortable columns, and still makes no network request", () => {
    const html = buildHtml(many(30), manifest());
    expect(html).toContain('id="q"');
    expect(html).toContain("data-sort");
    // Self-contained is a promise the page makes in its own footer.
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="http|@import|fetch\(/);
  });
});
