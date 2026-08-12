// The deliverables: a CRM-ready CSV, a territory report, a self-contained page,
// and the privacy note that has to travel with them.
//
// Two rules shape all of it.
//
// TRUNCATION LEADS. If the sweep could not cover its territory, that is the
// first thing in the report and a banner at the top of the page — not a
// footnote. A prospect file that quietly covers 40% of a town is the one
// failure nobody downstream can detect, and burying the disclosure is how a
// tool participates in it.
//
// THE PAGE MAKES NO REQUESTS. No tiles, no CDN, no font, no analytics. The map
// is projected SVG points drawn from coordinates already in the run. Partly
// that is so the file works from a USB stick in a meeting room, and partly
// because a page about who a company's prospects are should not phone anybody
// while it is being read.
import { vocabularyOf } from "./classification/index.js";
import { connectorById } from "./registry/index.js";
import { ranked } from "./score.js";
import { toCsv, type CsvOptions } from "./csv.js";
import { shortLabel } from "./run.js";
import type { Place, RunManifest } from "./types.js";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function truncationBanner(manifest: RunManifest): string[] {
  if (!manifest.truncated) return [];
  const lanes = manifest.lanes.filter((l) => l.truncated);
  return [
    "> ⚠ **This run does not cover the whole territory.**",
    ">",
    ...lanes.map((l) => `> - **${l.lane}**: ${l.reason ?? "capped"} (${l.returned} returned)`),
    ">",
    "> Treat every count below as a floor, not a total.",
    "",
  ];
}

/**
 * What this run actually DID to the territory, in one sentence, derived.
 *
 * The header used to read `Swept <date>` unconditionally — eight lines above a
 * coverage table reporting `This is NOT a sweep`, on every run outside France.
 * The document contradicted itself about the one thing the whole architecture
 * exists to keep straight, and the word it chose was the one four documents
 * forbid.
 *
 * So the sentence is DERIVED from `manifest.lanes` and there is no longer a code
 * path that can claim a sweep the run did not perform. Two properties matter:
 *
 *   * The question is whether ANY register lane swept, never what the first one
 *     happened to say. A French run that also ran `confirm` carries both lanes
 *     (cli.ts keeps the `sweep` one and appends the `confirm` one), and reading
 *     `lanes[0]` would answer differently depending on which arrived first.
 *   * OSM sweeps worldwide, so its half is a sweep in every mode. Only the
 *     REGISTER half changes shape, and only that half is hedged.
 */
function coverage(manifest: RunManifest): { sentence: string; short: string } {
  const date = manifest.builtAt.slice(0, 10);
  const version = `ultraprospect ${manifest.toolVersion}`;
  const registry = manifest.lanes.filter((l) => l.lane === "registry");
  const osm = manifest.lanes.find((l) => l.lane === "osm");
  const osmRan = Boolean(osm) && osm?.reason !== "skipped (--no-osm)";

  if (registry.some((l) => l.mode === "sweep")) {
    // The register was asked for every company in the area. France, and only
    // where a keyless enumeration exists.
    return { sentence: `Swept ${date} with ${version}.`, short: `swept ${date}` };
  }
  if (registry.some((l) => l.mode === "confirm")) {
    return {
      sentence: `OpenStreetMap swept ${date}; the register confirmed company by company, so a company nobody has mapped is not in this list. ${version}.`,
      short: `OSM swept ${date}, register confirmed company by company`,
    };
  }
  if (osmRan) {
    return {
      sentence: `OpenStreetMap swept ${date}; no register lane covered this territory. ${version}.`,
      short: `OSM swept ${date}, no register lane`,
    };
  }
  return { sentence: `Built ${date} with ${version}.`, short: `built ${date}` };
}

/**
 * Group by activity, saying which taxonomy each row comes from.
 *
 * Several vocabularies are in play and they are NOT comparable. A register files
 * a company under a section letter, OSM tags a shopfront by feature key (shop,
 * amenity, office) — and now the section letters themselves disagree across
 * countries: NACE "D" is electricity and gas, US SIC "D" is manufacturing. A
 * table listing "shop 460 / D 128" side by side reads as one ranking of one
 * thing, and it is neither. So every label names its own scheme.
 */
function activityLabel(place: Place): string {
  const rec = place.registry;
  const section = rec?.section;
  if (section && rec) {
    const vocabulary = vocabularyOf(rec.activityScheme);
    const scheme = vocabulary.scheme === "none" ? rec.connectorId : vocabulary.scheme.toUpperCase();
    return `${vocabulary.label(section)} (${scheme} ${section})`;
  }
  // A register can file a company under a code that is NOT an activity — the UK's
  // "dormant company" and "residents property management" are administrative. Those
  // resolve to no section on purpose, and saying what the register actually said
  // beats falling through to "unclassified": a row of dormant shells is a finding
  // about a town, and one worth seeing before calling any of them.
  const administrative = rec?.national?.administrativeSic;
  if (typeof administrative === "string" && administrative) return `${administrative} (${rec!.connectorId}, not an activity code)`;

  const key = place.category?.split("=")[0];
  return key ? `${key} (OSM tag)` : "unclassified";
}

function distribution(places: readonly Place[]): { bySection: [string, number][]; byBand: [string, number][] } {
  const bySection = new Map<string, number>();
  for (const p of places) {
    const key = activityLabel(p);
    bySection.set(key, (bySection.get(key) ?? 0) + 1);
  }
  // Bands are walked in each connector's own ordered array, never in key order —
  // France's codes are canonical integer keys and an object literal reorders
  // them silently. A run can hold records from more than one connector, and
  // their band vocabularies do not line up, so each is counted on its own terms.
  const byBand: [string, number][] = [];
  const connectorIds = [...new Set(places.map((p) => p.registry?.connectorId).filter((id): id is string => Boolean(id)))];
  for (const id of connectorIds) {
    const bands = connectorById(id)?.sizeBands;
    if (!bands) continue;
    const scoped = places.filter((p) => p.registry?.connectorId === id);
    for (const band of bands) {
      const n = scoped.filter((p) => p.registry?.sizeBand === band.code).length;
      if (n > 0) byBand.push([connectorIds.length > 1 ? `${band.label} (${id})` : band.label, n]);
    }
  }
  return { bySection: [...bySection.entries()].sort((a, b) => b[1] - a[1]), byBand };
}

export function buildReport(places: readonly Place[], manifest: RunManifest): string {
  const l: string[] = [];
  const order = ranked(places);
  const withSite = places.filter((p) => p.website?.confidence === "corroborated");
  const hiring = places.filter((p) => p.signals?.isHiring === true);
  const unknownHiring = places.filter((p) => p.signals && p.signals.isHiring === undefined);
  const { bySection, byBand } = distribution(places);

  l.push(`# ${shortLabel(manifest.target.label || manifest.slug)}`);
  l.push("");
  l.push(...truncationBanner(manifest));
  l.push(`${manifest.target.label}`);
  l.push("");
  l.push(coverage(manifest).sentence);
  l.push("");

  l.push("## Coverage");
  l.push("");
  // `mode` is the field types.ts calls the most important one in LaneCoverage,
  // and until now it was rendered nowhere: the sweep/confirm distinction reached
  // this table only as prose smuggled inside `reason`. It gets a column.
  l.push("| Lane | Mode | Returned | Complete | Note |");
  l.push("|---|---|---:|---|---|");
  for (const lane of manifest.lanes) {
    const mode = lane.mode ?? (lane.lane === "registry" ? "not swept" : "—");
    l.push(`| ${lane.lane} | ${mode} | ${lane.returned} | ${lane.truncated ? "**no**" : "yes"} | ${lane.reason ?? ""} |`);
  }
  l.push("");
  l.push(
    `${places.length} companies after fusion (${manifest.counts.merged} matched across both lanes, ${manifest.counts.undecided} pairs left for adjudication).`,
  );
  l.push("");

  // Records out of a bulk snapshot are facts about their date, and the report is
  // where a reader who will never open places.json finds that out. Grouped by date
  // rather than counted, because "1 412 records as of 2018" is the sentence that
  // matters and "some records are dated" is not.
  const dated = places.filter((p) => p.registry?.asOf);
  if (dated.length) {
    const years = [...new Set(dated.map((p) => p.registry!.asOf!.slice(0, 4)))].sort();
    l.push("> ⚠ **Some register records are dated.**");
    l.push(">");
    l.push(
      `> ${dated.length} of ${places.length} companies carry a register record from a bulk open-data snapshot rather than from asking the register: ${years.join(", ")}. Those identities were true then. They are not evidence about today, and the \`registry_as_of\` column in the CSV carries the date for each one.`,
    );
    l.push("");
  }

  l.push("## What is there");
  l.push("");
  l.push(`- ${withSite.length} with a website we corroborated · ${places.length - withSite.length} without one`);
  l.push(`- ${hiring.length} hiring right now (${hiring.reduce((n, p) => n + (p.signals?.openRoles ?? 0), 0)} open roles read from ATS APIs)`);
  if (unknownHiring.length) l.push(`- ${unknownHiring.length} run a job board we could not read — their hiring is unknown, not absent`);
  l.push(`- ${places.filter((p) => p.contacts.emails.length || p.contacts.phones.length).length} contactable from a published address or number`);
  l.push("");

  if (bySection.length) {
    l.push("### By activity");
    l.push("");
    l.push("| Activity | Companies |");
    l.push("|---|---:|");
    for (const [key, n] of bySection.slice(0, 12)) l.push(`| ${key} | ${n} |`);
    l.push("");
  }
  if (byBand.length) {
    l.push("### By size");
    l.push("");
    l.push("| Headcount | Companies |");
    l.push("|---|---:|");
    for (const [label, n] of byBand) l.push(`| ${label} | ${n} |`);
    l.push("");
  }

  l.push("## Ranked");
  l.push("");
  l.push("| # | Company | Score | Fit | Hiring | Website |");
  l.push("|---:|---|---:|---|---|---|");
  for (const [i, p] of order.slice(0, 50).entries()) {
    const h = p.signals?.isHiring === true ? `${p.signals.openRoles}` : p.signals?.isHiring === false ? "—" : "?";
    l.push(`| ${i + 1} | ${p.name} | ${p.score?.total ?? 0} | ${p.score?.fit ?? ""} | ${h} | ${p.website?.url ?? ""} |`);
  }
  l.push("");

  if (manifest.notes.length) {
    l.push("## Run notes");
    l.push("");
    for (const n of manifest.notes.slice(-25)) l.push(`- ${n}`);
    l.push("");
  }

  l.push("## Sources");
  l.push("");
  for (const licence of manifest.licences) l.push(`- ${licence}`);
  l.push("");
  l.push(`Extracted ${manifest.builtAt.slice(0, 10)}.`);
  return l.join("\n") + "\n";
}

/**
 * The map, as SVG points.
 *
 * An equirectangular projection with a cos(lat) correction, which is accurate
 * enough at the scale of a town and needs no library, no tiles and no network.
 * A real basemap would be prettier and would make the page phone a tile server
 * every time somebody opens it.
 */
function mapSvg(places: readonly Place[], manifest: RunManifest): string {
  const pts = places.filter((p) => typeof p.lat === "number" && typeof p.lon === "number");
  if (pts.length === 0) return "";
  const lats = pts.map((p) => p.lat!);
  const lons = pts.map((p) => p.lon!);
  const [s, n] = [Math.min(...lats), Math.max(...lats)];
  const [w, e] = [Math.min(...lons), Math.max(...lons)];
  const midLat = (s + n) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const width = 900;
  const spanX = Math.max(1e-6, (e - w) * kx);
  const spanY = Math.max(1e-6, n - s);
  const height = Math.max(220, Math.min(620, Math.round((width * spanY) / spanX)));
  const x = (lon: number) => ((lon - w) * kx * (width - 24)) / spanX + 12;
  const y = (lat: number) => height - 12 - ((lat - s) * (height - 24)) / spanY;

  const max = Math.max(1, ...pts.map((p) => p.score?.total ?? 0));
  const circles = pts
    .map((p) => {
      const t = (p.score?.total ?? 0) / max;
      const r = 2.5 + t * 5;
      const cls = p.score?.fit === "strong" ? "pt strong" : p.website?.confidence === "corroborated" ? "pt sited" : "pt";
      return `<circle class="${cls}" cx="${x(p.lon!).toFixed(1)}" cy="${y(p.lat!).toFixed(1)}" r="${r.toFixed(1)}"><title>${esc(p.name)} — ${p.score?.total ?? 0}</title></circle>`;
    })
    .join("");

  return `<figure class="map">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Every company in ${esc(manifest.target.label)}, positioned by coordinate and sized by score">${circles}</svg>
<figcaption>${pts.length} located companies. Larger is a higher measured score; filled points have a corroborated website.</figcaption>
</figure>`;
}

export function buildHtml(places: readonly Place[], manifest: RunManifest): string {
  const order = ranked(places);
  const rows = order
    .slice(0, 500)
    .map((p) => {
      const h = p.signals?.isHiring === true ? `${p.signals.openRoles}` : p.signals?.isHiring === false ? "—" : "?";
      const site = p.website?.url ? `<a href="${esc(p.website.url)}" rel="noreferrer nofollow">${esc(new URL(p.website.url).hostname)}</a>` : "";
      return `<tr><td>${esc(p.name)}</td><td class="n">${p.score?.total ?? 0}</td><td>${esc(p.score?.fit ?? "")}</td><td class="n">${h}</td><td>${esc(p.registry?.activityCode ?? p.category ?? "")}</td><td>${esc(p.address.commune ?? "")}</td><td>${site}</td></tr>`;
    })
    .join("\n");

  const banner = manifest.truncated
    ? `<div class="warn"><strong>This run does not cover the whole territory.</strong> ${manifest.lanes
        .filter((l) => l.truncated)
        .map((l) => `${esc(l.lane)}: ${esc(l.reason ?? "capped")}`)
        .join(" · ")} Every count below is a floor.</div>`
    : "";

  // One file, no requests. Colours are defined on :root and only overridden
  // under prefers-color-scheme, so the page is readable in either theme and in
  // neither (a print, a preview pane, an email client).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(shortLabel(manifest.target.label || manifest.slug))} — ultraprospect</title>
<style>
:root{--bg:#fff;--fg:#16181d;--muted:#5b6270;--line:#e3e6ec;--accent:#1c6dd0;--warnbg:#fff4e5;--warnfg:#7a4b00;--pt:#9aa3b2;--sited:#1c6dd0;--strong:#0a7d4f}
@media (prefers-color-scheme:dark){:root{--bg:#11131a;--fg:#e8eaf0;--muted:#98a0b0;--line:#252a35;--accent:#6aa9ff;--warnbg:#3a2a06;--warnfg:#ffd68a;--pt:#4c5566;--sited:#6aa9ff;--strong:#3ddc9a}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem 4rem;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{font-size:1.6rem;margin:0 0 .25rem}
.sub{color:var(--muted);margin:0 0 1.5rem}
.warn{background:var(--warnbg);color:var(--warnfg);border-radius:8px;padding:.9rem 1rem;margin:0 0 1.5rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin:0 0 1.5rem}
.card{border:1px solid var(--line);border-radius:8px;padding:.75rem .9rem}
.card b{display:block;font-size:1.5rem;font-weight:650}
.card span{color:var(--muted);font-size:.82rem}
.map{margin:0 0 1.5rem}
.map svg{width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:transparent}
.map figcaption{color:var(--muted);font-size:.82rem;margin-top:.4rem}
circle.pt{fill:var(--pt);opacity:.65}
circle.sited{fill:var(--sited);opacity:.8}
circle.strong{fill:var(--strong);opacity:.95}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:.5rem .7rem;border-bottom:1px solid var(--line);white-space:nowrap}
th{position:sticky;top:0;background:var(--bg);font-weight:600}
td.n,th.n{text-align:right}
tr:last-child td{border-bottom:0}
a{color:var(--accent)}
footer{color:var(--muted);font-size:.82rem;margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem}
footer p{margin:.25rem 0}
</style>
</head>
<body>
<main>
<h1>${esc(shortLabel(manifest.target.label || manifest.slug))}</h1>
<p class="sub">${esc(manifest.target.label)} · ${esc(coverage(manifest).short)} · ultraprospect ${esc(manifest.toolVersion)}</p>
${banner}
<div class="cards">
<div class="card"><b>${places.length}</b><span>companies</span></div>
<div class="card"><b>${places.filter((p) => p.website?.confidence === "corroborated").length}</b><span>with a proven website</span></div>
<div class="card"><b>${places.filter((p) => p.signals?.isHiring === true).length}</b><span>hiring now</span></div>
<div class="card"><b>${places.filter((p) => p.contacts.emails.length || p.contacts.phones.length).length}</b><span>contactable</span></div>
<div class="card"><b>${manifest.counts.merged}</b><span>matched across lanes</span></div>
</div>
${mapSvg(places, manifest)}
<div class="scroll">
<table>
<thead><tr><th>Company</th><th class="n">Score</th><th>Fit</th><th class="n">Roles</th><th>Activity</th><th>Town</th><th>Website</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
<footer>
${manifest.licences.map((x) => `<p>${esc(x)}</p>`).join("\n")}
<p>Extracted ${esc(manifest.builtAt.slice(0, 10))}. This page makes no network requests.</p>
</footer>
</main>
</body>
</html>
`;
}

/**
 * The privacy note, emitted whenever the run holds named individuals.
 *
 * Not boilerplate: it lists WHICH fields are personal and where each came from,
 * because the obligations that attach to this file depend on that and nobody
 * will reconstruct it later from a CSV.
 */
export function buildPrivacyNote(places: readonly Place[], manifest: RunManifest): string | undefined {
  const withOfficers = places.filter((p) => (p.registry?.officers.length ?? 0) > 0);
  const withPeople = places.filter((p) => p.contacts.people.length > 0);
  const namedEmails = places.flatMap((p) => p.contacts.emails.filter((e) => /^[a-z]+[._-][a-z]+@/i.test(e.value)));
  if (withOfficers.length === 0 && withPeople.length === 0 && namedEmails.length === 0) return undefined;

  return `# Personal data in this run

Produced ${manifest.builtAt.slice(0, 10)} for ${manifest.target.label || manifest.slug}.

This run contains data about identified people. Whoever holds it is a data
controller under the GDPR, and that is a role rather than a formality.

## What is in it, and where it came from

| Category | Records | Source |
|---|---:|---|
| Company officers (name, role, sometimes year of birth) | ${withOfficers.reduce((n, p) => n + p.registry!.officers.length, 0)} across ${withOfficers.length} companies | the company registers listed in the manifest, published open data |
| People named on a company's own website | ${withPeople.reduce((n, p) => n + p.contacts.people.length, 0)} across ${withPeople.length} companies | Fetched web pages, each recorded with its page id |
| Personal-looking email addresses | ${namedEmails.length} | Published verbatim on a fetched page — never constructed |

Every one of these was **observed**. No address was derived from a naming
pattern, no name was inferred from a role. The \`check\` gate re-reads each value
against the page it came from and fails the run when one does not appear there.

## What that means for you

- **Basis.** B2B prospecting can rest on legitimate interest when the message
  concerns the person's professional role. That is a judgement about your use.
- **Information and opposition.** The people listed have a right to know they
  are in this file and to object. Offer that in the first contact.
- **Retention.** Decide how long this file lives, and delete it then. A
  prospect list is not a permanent record.
- **Minimisation.** If your use does not need the people, re-run with
  \`--no-people\`: it strips them at scan time, before anything is written.

## Attribution

${manifest.licences.map((x) => `- ${x}`).join("\n")}
`;
}

export interface RenderOutcome {
  files: { path: string; content: string }[];
}

/** Everything a run hands over, built from the same places and manifest. */
export function buildAll(places: readonly Place[], manifest: RunManifest, opts: CsvOptions = {}): RenderOutcome {
  const files = [
    { path: "PROSPECTS.csv", content: toCsv(places, opts) },
    { path: "prospects.json", content: JSON.stringify(ranked(places), null, 2) + "\n" },
    { path: "REPORT.md", content: buildReport(places, manifest) },
    { path: "index.html", content: buildHtml(places, manifest) },
  ];
  const privacy = opts.noPeople ? undefined : buildPrivacyNote(places, manifest);
  if (privacy) files.push({ path: "PRIVACY.md", content: privacy });
  return { files };
}
