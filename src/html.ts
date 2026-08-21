// The page: one file, no requests, everything the run knows.
//
// THE PAGE MAKES NO REQUESTS. No tiles, no CDN, no font, no analytics. The map
// is projected SVG points drawn from coordinates already in the run. Partly
// that is so the file works from a USB stick in a meeting room, and partly
// because a page about who a company's prospects are should not phone anybody
// while it is being read.
//
// EVERY ROW OPENS. The table is for scanning; the panel underneath each row is
// where the run actually lives — the verdict somebody wrote, the score broken
// into the thirteen terms that produced it, each contact with the page id it
// was read from, the open roles, the register identity and what an authority
// would confirm about it. The table used to be the whole page, seven columns
// wide, and a run that had read 1 116 pages looked exactly like one that had
// read none.
//
// The panel is markup, not something the script builds, so a browser with
// JavaScript switched off shows every panel open rather than showing nothing.
import { ranked, SCORE_PART_LABELS } from "./score.js";
import { coverage, summarise, type RunSummary } from "./summary.js";
import type { Place, RunManifest, SourcedValue } from "./types.js";
import { shortLabel, streetLine } from "./util.js";

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A link to somewhere outside the run. Never followed while the page loads. */
function link(url: string, text?: string): string {
  return `<a href="${esc(url)}" rel="noreferrer nofollow">${esc(text ?? url)}</a>`;
}

/** The host, when the URL parses. A malformed URL prints whole rather than throwing. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** How many rows the table holds before a browser starts to struggle. */
export const HTML_ROW_CAP = 2000;

/**
 * The map, as SVG points.
 *
 * An equirectangular projection with a cos(lat) correction, which is accurate
 * enough at the scale of a town and needs no library, no tiles and no network.
 * A real basemap would be prettier and would make the page phone a tile server
 * every time somebody opens it.
 *
 * Each point carries the index of its row, so clicking a dot opens that
 * company's panel instead of only showing a tooltip.
 */
function mapSvg(order: readonly Place[], manifest: RunManifest): string {
  const pts = order.map((p, i) => ({ p, i })).filter(({ p }) => typeof p.lat === "number" && typeof p.lon === "number");
  if (pts.length === 0) return "";
  const lats = pts.map(({ p }) => p.lat!);
  const lons = pts.map(({ p }) => p.lon!);
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

  const max = Math.max(1, ...pts.map(({ p }) => p.score?.total ?? 0));
  const circles = pts
    .map(({ p, i }) => {
      const t = (p.score?.total ?? 0) / max;
      const r = 2.5 + t * 5;
      const fit = p.score?.fit;
      const cls = fit === "strong" || fit === "possible" ? `pt ${fit}` : fit === "no" ? "pt no" : p.website?.confidence === "corroborated" ? "pt sited" : "pt";
      const hiring = p.signals?.isHiring === true ? ` — ${p.signals.openRoles} open role(s)` : "";
      return `<circle class="${cls}" data-i="${i}" cx="${x(p.lon!).toFixed(1)}" cy="${y(p.lat!).toFixed(1)}" r="${r.toFixed(1)}"><title>${esc(p.name)} — ${p.score?.total ?? 0}${esc(hiring)}</title></circle>`;
    })
    .join("");

  return `<figure class="map">
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Every company in ${esc(manifest.target.label)}, positioned by coordinate and sized by score">${circles}</svg>
<figcaption>${pts.length} located companies. Larger is a higher measured score. <b class="k strong"></b> judged a strong fit · <b class="k possible"></b> possible · <b class="k sited"></b> a corroborated website · <b class="k plain"></b> everything else. Click a point to open its row.</figcaption>
</figure>`;
}

/** One labelled block inside a company's panel. Absent data renders nothing. */
function block(label: string, body: string): string {
  return body ? `<div class="b"><dt>${esc(label)}</dt><dd>${body}</dd></div>` : "";
}

/** A contact, always with the page id it was read from. */
function sourced(items: readonly SourcedValue[], href?: (v: string) => string): string {
  if (!items.length) return "";
  return items
    .map((c) => {
      const value = href ? `<a href="${esc(href(c.value))}">${esc(c.value)}</a>` : esc(c.value);
      // The page id is the whole basis of the citation gate: `check` re-opens it
      // and fails the run when the value is not there. A contact rendered
      // without it cannot be audited by whoever ends up emailing it.
      return `<span class="c">${value} <span class="src">[${esc(c.from)}]</span></span>`;
    })
    .join("");
}

/**
 * The score, broken into the terms that produced it.
 *
 * `score.parts` is what makes a ranking arguable rather than believed — the
 * whole reason score.ts keeps the terms additive and unnormalised — and it
 * reached no deliverable at all. Shown as a bar and as numbers, because the bar
 * says which term dominates and the numbers say by how much.
 */
function scoreBreakdown(place: Place): string {
  const parts = Object.entries(place.score?.parts ?? {}).filter(([, v]) => v > 0);
  if (!parts.length) return "";
  const total = parts.reduce((n, [, v]) => n + v, 0);
  // No `title` on the segments: the same labels are printed underneath, and
  // repeating them as a tooltip on every term of every row cost a quarter of a
  // megabyte on a 2 000-row page to say what is already on screen.
  const bar = parts.map(([, v]) => `<i style="width:${((v / total) * 100).toFixed(1)}%"></i>`).join("");
  const words = parts.map(([k, v]) => `<span class="c">${esc(SCORE_PART_LABELS[k] ?? k)} <b>${v}</b></span>`).join("");
  return `<div class="bar">${bar}</div>${words}<span class="c">total <b>${place.score?.total ?? 0}</b></span>`;
}

function registerBlock(place: Place): string {
  const s = place.registry;
  if (!s) return "";
  const bits: string[] = [];
  if (s.legalName && s.legalName !== place.name) bits.push(`<span class="c">legal name <b>${esc(s.legalName)}</b></span>`);
  bits.push(`<span class="c">${esc(s.connectorId)} <b>${esc(s.id)}</b></span>`);
  if (s.establishmentId && s.establishmentId !== s.id) bits.push(`<span class="c">establishment <b>${esc(s.establishmentId)}</b></span>`);
  if (s.legalForm) bits.push(`<span class="c">form <b>${esc(s.legalForm)}</b></span>`);
  if (s.status && s.status !== "unknown") bits.push(`<span class="c">state <b>${esc(s.status)}</b></span>`);
  if (s.dateCreated) bits.push(`<span class="c">since <b>${esc(s.dateCreated)}</b></span>`);
  if (s.isHeadOffice) bits.push(`<span class="c">head office</span>`);
  if (s.establishmentCount) bits.push(`<span class="c">establishments <b>${s.establishmentCount}</b></span>`);
  if (s.finances?.revenue)
    bits.push(`<span class="c">revenue ${s.finances.year ?? ""} <b>${esc(s.finances.revenue)} ${esc(s.finances.currency ?? "")}</b></span>`);
  if (place.registryEvidence) {
    const ev = place.registryEvidence;
    bits.push(
      `<span class="c">matched <b>${esc(ev.mode)} / ${esc(ev.how)}</b>${ev.legalId ? ` ${esc(ev.legalId)}` : ""}${ev.from ? ` <span class="src">[${esc(ev.from)}]</span>` : ""}</span>`,
    );
  }
  // A record out of a bulk snapshot is a fact about its date. Marked here as
  // loudly as in the report, because this panel is where somebody decides
  // whether to act on the identity.
  if (s.asOf) bits.push(`<span class="c warnc">as of ${esc(s.asOf)} — from a bulk snapshot, not from asking the register</span>`);
  if (s.officers.length) {
    bits.push(
      `<span class="c">officers ${esc(s.officers.map((d) => [d.denomination ?? [d.prenoms, d.nom].filter(Boolean).join(" "), d.qualite].filter(Boolean).join(" — ")).join("; "))}</span>`,
    );
  }
  if (s.sourceUrl) bits.push(`<span class="c">${link(s.sourceUrl, "open on the register")}</span>`);
  return bits.join("");
}

function siteBlock(place: Place): string {
  const sg = place.signals;
  if (!sg) return "";
  const bits: string[] = [];
  // The count of extracts on disk — the `[P…]` ids a reader can re-open, and
  // what `check` re-resolves. Named for what it is, because the score's `depth`
  // term counts something else.
  bits.push(`<span class="c">pages stored <b>${place.pages.length}</b></span>`);
  if (sg.lastContentAt) bits.push(`<span class="c">newest content <b>${esc(sg.lastContentAt.slice(0, 10))}</b></span>`);
  if (sg.sitemapUrls) bits.push(`<span class="c">sitemap <b>${sg.sitemapUrls}</b> urls</span>`);
  if (sg.cms) bits.push(`<span class="c">CMS <b>${esc(sg.cms)}</b></span>`);
  if (sg.analytics.length) bits.push(`<span class="c">analytics <b>${esc(sg.analytics.join(", "))}</b></span>`);
  if (sg.techStack.length) bits.push(`<span class="c">stack <b>${esc(sg.techStack.join(", "))}</b></span>`);
  if (sg.languages.length) bits.push(`<span class="c">languages <b>${esc(sg.languages.join(", "))}</b></span>`);
  if (sg.hasPricingPage) bits.push(`<span class="c">publishes pricing</span>`);
  if (sg.hasEcommerce) bits.push(`<span class="c">sells online</span>`);
  if (sg.legalIdOnSite) bits.push(`<span class="c">legal id on site <b>${esc(sg.legalIdOnSite)}</b></span>`);
  if (sg.siteReachable === false) bits.push(`<span class="c warnc">the site did not respond</span>`);
  return bits.join("");
}

function legalIdBlock(place: Place): string {
  if (!place.legalIds?.length) return "";
  return place.legalIds
    .map((x) => {
      // `attested` is not `verified`, and the page must not blur them: an
      // authority said this number is live and refused to say whose it is.
      const note = x.note ? ` — ${esc(x.note)}` : "";
      const who = x.authority ? ` (${esc(x.authority)})` : "";
      return `<span class="c"><b>${esc(x.kind)} ${esc(x.value)}</b> <span class="tag ${esc(x.status)}">${esc(x.status)}</span>${who}${note}${x.from ? ` <span class="src">[${esc(x.from)}]</span>` : ""}</span>`;
    })
    .join("");
}

function jobsBlock(place: Place): string {
  if (!place.jobs.length) return "";
  const rows = place.jobs
    .slice(0, 25)
    .map((j) => {
      const where = [j.location, j.department, j.employmentType].filter(Boolean).join(" · ");
      const title = j.url ? link(j.url, j.title) : esc(j.title);
      const when = j.postedAt ? ` <span class="src">posted ${esc(j.postedAt.slice(0, 10))}</span>` : "";
      return `<li>${title}${where ? ` — ${esc(where)}` : ""}${when} <span class="src">via ${esc(j.via)}</span></li>`;
    })
    .join("");
  const more = place.jobs.length > 25 ? `<li class="src">…and ${place.jobs.length - 25} more</li>` : "";
  return `<ul class="jobs">${rows}${more}</ul>`;
}

/** Everything known about one company, as the panel under its row. */
function detail(place: Place, columns: number): string {
  const blocks = [
    // The verdict first: it is the only thing in the run a person wrote, and
    // verbatim, because a judgement paraphrased by the tool carrying it is no
    // longer that person's judgement.
    block("Why", place.score?.why ? esc(place.score.why) : ""),
    block("Angle", place.score?.angle ? esc(place.score.angle) : ""),
    block("Score", scoreBreakdown(place)),
    block(
      "Emails",
      sourced(place.contacts.emails, (v) => `mailto:${v}`),
    ),
    block(
      "Phones",
      sourced(place.contacts.phones, (v) => `tel:${v.replace(/[^\d+]/g, "")}`),
    ),
    block("Socials", sourced(place.contacts.socials)),
    block(
      "People named on the site",
      place.contacts.people
        .map((p) => `<span class="c">${esc(p.value)}${p.role ? ` — ${esc(p.role)}` : ""} <span class="src">[${esc(p.from)}]</span></span>`)
        .join(""),
    ),
    block(`Open roles (${place.jobs.length})`, jobsBlock(place)),
    block("Register", registerBlock(place)),
    block("Legal identifiers", legalIdBlock(place)),
    block("Site", siteBlock(place)),
    block(
      "Where",
      [streetLine(place.address), place.address.codePostal, place.address.commune, place.address.pays].filter(Boolean).map(esc).join(", ") +
        (typeof place.lat === "number" ? ` <span class="src">${place.lat.toFixed(5)}, ${place.lon?.toFixed(5)}</span>` : ""),
    ),
    block(
      "Provenance",
      `<span class="c">id <b>${esc(place.id)}</b></span><span class="c">lanes <b>${esc(place.sources.join(" + "))}</b></span>` +
        (place.matchConfidence !== undefined
          ? `<span class="c">match confidence <b>${place.matchConfidence}</b>${place.matchedBy ? ` on ${esc(place.matchedBy)}` : ""}</span>`
          : "") +
        (place.website ? `<span class="c">website <b>${esc(place.website.confidence)}</b> — ${esc(place.website.evidence.join(", "))}</span>` : ""),
    ),
  ]
    .filter(Boolean)
    .join("");

  const empty = `<p class="src">Nothing beyond the row above: no site was corroborated for this company, so no page was fetched and nothing was read from one.</p>`;
  return `<tr class="d" id="d${esc(place.id)}"><td colspan="${columns}"><dl>${blocks || empty}</dl></td></tr>`;
}

/** The facet tokens a row answers to. Only facets that match anything are shown. */
const FACETS: { key: string; label: string; of: (p: Place) => boolean }[] = [
  { key: "hiring", label: "hiring", of: (p) => p.signals?.isHiring === true },
  { key: "site", label: "website proved", of: (p) => p.website?.confidence === "corroborated" },
  { key: "contact", label: "contactable", of: (p) => p.contacts.emails.length > 0 || p.contacts.phones.length > 0 },
  { key: "reg", label: "in the register", of: (p) => Boolean(p.registry) },
  { key: "judged", label: "judged possible or better", of: (p) => p.score?.fit === "strong" || p.score?.fit === "possible" },
  { key: "dated", label: "register record is dated", of: (p) => Boolean(p.registry?.asOf) },
];

function statCards(s: RunSummary, manifest: RunManifest): string {
  const cards: [string | number, string][] = [
    [s.total, "companies"],
    [s.registry.withRecord, "carry a register identity"],
    [s.websites.corroborated, "with a website we proved"],
  ];
  // A big "0" under "hiring now" is a claim that we looked. On a run that has
  // not reached `enrich`, nobody has — so the card says unknown rather than
  // zero, which is the same rule the three-valued `isHiring` field exists for.
  if (s.site.enriched === 0) {
    cards.push(["—", "hiring: no site read yet, so unknown rather than none"]);
  } else {
    cards.push([s.hiring.yes, `hiring now · ${s.hiring.roles} open roles`]);
    cards.push([s.contact.any, "contactable"]);
    cards.push([s.site.pagesRead, `pages stored across ${s.site.withPages} sites`]);
  }
  cards.push([s.fit.judged, "judged for fit by a person"]);
  if (manifest.counts.merged) cards.push([manifest.counts.merged, "matched across lanes"]);
  return `<div class="cards">${cards.map(([n, what]) => `<div class="card"><b>${esc(n)}</b><span>${esc(what)}</span></div>`).join("")}</div>`;
}

/**
 * The coverage table, on the page rather than only in the report.
 *
 * Somebody handed the HTML and not the report has, until now, had no way to
 * learn whether the register was enumerated or merely consulted — which is the
 * difference between "every company filed here" and "the companies OSM
 * happened to have".
 */
function coverageTable(manifest: RunManifest, s: RunSummary): string {
  const rows = manifest.lanes
    .map((l) => {
      const mode = l.mode ?? (l.lane === "registry" ? "not swept" : "—");
      return `<tr><td>${esc(l.lane)}</td><td>${esc(mode)}</td><td class="n">${l.returned}</td><td>${l.truncated ? "<b>no</b>" : "yes"}</td><td>${esc(l.reason ?? "")}</td></tr>`;
    })
    .join("");
  const under: string[] = [];
  if (s.registry.byConnector.length) under.push(`Register records by connector: ${esc(s.registry.byConnector.map(([id, n]) => `${id} ${n}`).join(" · "))}`);
  if (s.registry.byEvidence.length) under.push(`How each was attached: ${esc(s.registry.byEvidence.map(([how, n]) => `${n} ${how}`).join(" · "))}`);
  return `<details class="cov" open><summary>Coverage — what this run actually asked</summary>
<div class="scroll"><table><thead><tr><th>Lane</th><th>Mode</th><th class="n">Returned</th><th>Complete</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>
${under.map((x) => `<p class="cap">${x}</p>`).join("")}</details>`;
}

export function buildHtml(places: readonly Place[], manifest: RunManifest): string {
  const s = summarise(places, manifest);
  const order = ranked(places);
  const shown = Math.min(order.length, HTML_ROW_CAP);
  const visible = order.slice(0, HTML_ROW_CAP);
  const COLUMNS = 10;

  const rows = visible
    .map((p, i) => {
      const h = p.signals?.isHiring === true ? `${p.signals.openRoles}` : p.signals?.isHiring === false ? "—" : "?";
      const site = p.website?.url ? link(p.website.url, hostOf(p.website.url)) : "";
      const hay = [
        p.name,
        p.registry?.legalName,
        p.registry?.id,
        p.registry?.activityCode,
        p.category,
        p.address.commune,
        p.website?.url,
        p.score?.fit,
        p.score?.why,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const facets = FACETS.filter((f) => f.of(p))
        .map((f) => f.key)
        .join(" ");
      const contact = [p.contacts.emails.length ? "✉" : "", p.contacts.phones.length ? "☎" : ""].filter(Boolean).join(" ");
      const reg = p.registry ? `${p.registry.id}` : "";
      return `<tr class="r" id="r${i}" data-h="${esc(hay)}" data-f="${esc(facets)}"><td class="n">${i + 1}</td><td><button type="button" class="tog" aria-expanded="false" aria-controls="d${esc(p.id)}">${esc(p.name)}</button></td><td class="n">${p.score?.total ?? 0}</td><td>${esc(p.score?.fit ?? "")}</td><td class="n">${h}</td><td>${esc(p.registry?.activityCode ?? p.category ?? "")}</td><td>${esc(p.address.commune ?? "")}</td><td>${contact}</td><td>${esc(reg)}</td><td>${site}</td></tr>
${detail(p, COLUMNS)}`;
    })
    .join("\n");

  const banners: string[] = [];
  if (manifest.truncated) {
    banners.push(
      `<div class="warn"><strong>This run does not cover the whole territory.</strong> ${manifest.lanes
        .filter((l) => l.truncated)
        .map((l) => `${esc(l.lane)}: ${esc(l.reason ?? "capped")}`)
        .join(" · ")} Every count below is a floor.</div>`,
    );
  }
  // The report has carried this since the German connector landed and the page
  // never has, which made the page the safer-looking of the two documents about
  // exactly the fact that makes it less safe.
  if (s.registry.dated.count) {
    banners.push(
      `<div class="warn"><strong>Some register records are dated.</strong> ${s.registry.dated.count} of ${s.total} companies carry a register record from a bulk open-data snapshot rather than from asking the register: ${esc(s.registry.dated.years.join(", "))}. Those identities were true then. They are not evidence about today.</div>`,
    );
  }
  if (s.filters.length) {
    banners.push(
      `<div class="note"><strong>What this run looked for:</strong> ${esc(s.filters.join(" · "))}. A company outside that is absent from this list because it was not asked for, not because it is not there.</div>`,
    );
  }

  const activeFacets = FACETS.map((f) => ({ ...f, n: places.filter(f.of).length })).filter((f) => f.n > 0 && f.n < places.length);
  const chips = activeFacets
    .map((f) => `<button type="button" class="chip" data-facet="${esc(f.key)}" aria-pressed="false">${esc(f.label)} <span class="src">${f.n}</span></button>`)
    .join("");

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
:root{--bg:#fff;--fg:#16181d;--muted:#5b6270;--line:#e3e6ec;--soft:#f6f7fa;--accent:#1c6dd0;--warnbg:#fff4e5;--warnfg:#7a4b00;--notebg:#eef4fd;--notefg:#1c4a80;--pt:#9aa3b2;--sited:#1c6dd0;--strong:#0a7d4f;--possible:#b7791f;--no:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#11131a;--fg:#e8eaf0;--muted:#98a0b0;--line:#252a35;--soft:#171a22;--accent:#6aa9ff;--warnbg:#3a2a06;--warnfg:#ffd68a;--notebg:#12233a;--notefg:#a9ccf5;--pt:#4c5566;--sited:#6aa9ff;--strong:#3ddc9a;--possible:#e0b357;--no:#e77f72}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem 4rem;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1240px;margin:0 auto}
h1{font-size:1.7rem;margin:0 0 .25rem;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0 0 1.25rem}
.warn,.note{border-radius:8px;padding:.85rem 1rem;margin:0 0 .75rem}
.warn{background:var(--warnbg);color:var(--warnfg)}
.note{background:var(--notebg);color:var(--notefg)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:.6rem;margin:1.25rem 0}
.card{border:1px solid var(--line);border-radius:8px;padding:.7rem .85rem;background:var(--soft)}
.card b{display:block;font-size:1.45rem;font-weight:650;font-variant-numeric:tabular-nums}
.card span{color:var(--muted);font-size:.8rem;line-height:1.35;display:block}
.cov{border:1px solid var(--line);border-radius:8px;padding:.6rem .9rem;margin:0 0 1.25rem;background:var(--soft)}
.cov summary{cursor:pointer;font-weight:600}
.cov .scroll{margin-top:.6rem;background:var(--bg)}
.map{margin:0 0 1.25rem}
.map svg{width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:transparent}
.map figcaption{color:var(--muted);font-size:.82rem;margin-top:.4rem}
circle.pt{fill:var(--pt);opacity:.6;cursor:pointer}
circle.sited{fill:var(--sited);opacity:.75}
circle.possible{fill:var(--possible);opacity:.95}
circle.strong{fill:var(--strong);opacity:.95}
circle.no{fill:var(--no);opacity:.5}
b.k{display:inline-block;width:.62rem;height:.62rem;border-radius:50%;background:var(--pt);vertical-align:baseline}
b.k.strong{background:var(--strong)}b.k.possible{background:var(--possible)}b.k.sited{background:var(--sited)}
.tools{display:flex;gap:.5rem;align-items:center;margin:0 0 .5rem;flex-wrap:wrap}
#q{flex:1 1 18rem;min-width:12rem;padding:.5rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
.chip{border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:999px;padding:.35rem .75rem;font:inherit;font-size:.85rem;cursor:pointer}
.chip:hover{border-color:var(--accent)}
.chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.chip[aria-pressed="true"] .src{color:#fff;opacity:.75}
.muted{color:var(--muted);font-size:.85rem}
.cap{color:var(--muted);font-size:.85rem;margin:.4rem 0}
.src{color:var(--muted);font-size:.85em;font-weight:400}
th[data-sort]{cursor:pointer;user-select:none}
th[data-sort]:hover{color:var(--accent)}
th[aria-sort]::after{content:" ▲";font-size:.7em}
th[aria-sort="descending"]::after{content:" ▼"}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:.9rem}
th,td{text-align:left;padding:.45rem .7rem;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}
th{position:sticky;top:0;background:var(--bg);font-weight:600;z-index:1}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr.r:hover td{background:var(--soft)}
tr.r.on td{background:var(--soft)}
.tog{background:none;border:0;padding:0;font:inherit;color:var(--accent);cursor:pointer;text-align:left;max-width:26rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tog::before{content:"▸ ";color:var(--muted)}
tr.r.on .tog::before{content:"▾ "}
tr.d{display:none}
tr.d.open{display:table-row}
tr.d td{white-space:normal;background:var(--soft);padding:.9rem 1.1rem}
tr.d dl{margin:0;display:grid;grid-template-columns:minmax(9rem,11rem) 1fr;gap:.1rem .9rem}
tr.d .b{display:contents}
tr.d dt{color:var(--muted);font-size:.82rem;padding:.3rem 0;text-transform:uppercase;letter-spacing:.04em}
tr.d dd{margin:0;padding:.3rem 0;min-width:0}
.c{display:inline-block;margin:0 .7rem .2rem 0}
.c b{font-weight:600}
.warnc{color:var(--warnfg)}
.tag{border:1px solid var(--line);border-radius:4px;padding:0 .3rem;font-size:.78rem;text-transform:uppercase;letter-spacing:.03em}
.tag.verified{color:var(--strong);border-color:currentColor}
.tag.attested{color:var(--possible);border-color:currentColor}
.bar{display:flex;height:.5rem;border-radius:3px;overflow:hidden;margin:.15rem 0 .45rem;max-width:32rem;background:var(--line)}
.bar i{display:block;height:100%;background:var(--accent);border-right:1px solid var(--bg)}
.bar i:nth-child(even){opacity:.62}
ul.jobs{margin:0;padding-left:1.1rem}
ul.jobs li{margin:.15rem 0}
a{color:var(--accent)}
footer{color:var(--muted);font-size:.82rem;margin-top:2rem;border-top:1px solid var(--line);padding-top:1rem}
footer p{margin:.25rem 0}
footer details{margin:.5rem 0}
footer summary{cursor:pointer}
footer li{margin:.1rem 0}
</style>
<noscript><style>tr.d{display:table-row}.tog{color:inherit;cursor:default}.tog::before{content:""}.tools{display:none}</style></noscript>
</head>
<body>
<main>
<h1>${esc(shortLabel(manifest.target.label || manifest.slug))}</h1>
<p class="sub">${esc(manifest.target.label)} · ${esc(coverage(manifest).short)} · ultraprospect ${esc(manifest.toolVersion)}</p>
${banners.join("\n")}
${statCards(s, manifest)}
${coverageTable(manifest, s)}
${mapSvg(visible, manifest)}
<div class="tools">
<input id="q" type="search" placeholder="Filter — name, legal name, register id, activity, town, domain, verdict" autocomplete="off" aria-label="Filter the table">
${chips}
<span id="count" class="muted"></span>
</div>
${
  order.length > shown
    ? `<p class="cap">Showing the ${shown} highest-ranked of ${order.length} companies. The rest are in <code>PROSPECTS.csv</code> and <code>prospects.json</code> — this table is capped so a browser can open it, not because the run stopped there.</p>`
    : ""
}
<p class="cap">Every company name opens a panel: the verdict, the score broken into its terms, each contact with the page it was read from, the open roles, and what the register filed.</p>
<div class="scroll">
<table>
<thead><tr><th class="n">#</th><th data-sort="t">Company</th><th class="n" data-sort="n">Score</th><th data-sort="t">Fit</th><th class="n" data-sort="n">Roles</th><th data-sort="t">Activity</th><th data-sort="t">Town</th><th data-sort="t">Contact</th><th data-sort="t">Register</th><th data-sort="t">Website</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
<footer>
${manifest.licences.map((x) => `<p>${esc(x)}</p>`).join("\n")}
${
  s.notes.lines.length
    ? `<details><summary>Run notes (${s.notes.distinct === s.notes.emitted ? s.notes.emitted : `${s.notes.distinct} distinct of ${s.notes.emitted}`})</summary><ul>${s.notes.lines
        .map((n) => `<li>${n.count > 1 ? `×${n.count} ` : ""}${esc(n.text)}</li>`)
        .join(
          "",
        )}${s.notes.distinct > s.notes.lines.length ? `<li>…and ${s.notes.distinct - s.notes.lines.length} more distinct notes, in <code>manifest.json</code></li>` : ""}</ul></details>`
    : ""
}
<p>Extracted ${esc(manifest.builtAt.slice(0, 10))}. This page makes no network requests.</p>
</footer>
</main>
<script>
// Filtering, faceting, sorting and the detail panels — inline and offline.
// Without JavaScript every panel is open and the table is still a table, which
// is why the cap note above is markup rather than something this script writes.
(function(){
  var tb=document.querySelector("tbody"), q=document.getElementById("q"), c=document.getElementById("count");
  if(!tb) return;
  var rows=[].slice.call(tb.querySelectorAll("tr.r")), total=rows.length, on={};
  rows.forEach(function(r){ r.detail = r.nextElementSibling; });

  function tell(n){ if(c) c.textContent = n===total ? total+" rows" : n+" of "+total+" rows"; }

  function apply(){
    var t=(q&&q.value||"").trim().toLowerCase(), keys=Object.keys(on).filter(function(k){return on[k]}), n=0;
    for(var i=0;i<rows.length;i++){
      var r=rows[i], f=" "+(r.dataset.f||"")+" ", hit = !t || (r.dataset.h||"").indexOf(t) !== -1;
      for(var j=0;hit&&j<keys.length;j++) if(f.indexOf(" "+keys[j]+" ")===-1) hit=false;
      r.hidden=!hit;
      if(r.detail) r.detail.hidden=!hit;
      if(hit) n++;
    }
    tell(n);
  }
  tell(total);
  if(q) q.addEventListener("input", apply);

  [].forEach.call(document.querySelectorAll(".chip"), function(chip){
    chip.addEventListener("click", function(){
      var k=chip.dataset.facet, next = chip.getAttribute("aria-pressed") !== "true";
      chip.setAttribute("aria-pressed", next ? "true" : "false");
      on[k]=next; apply();
    });
  });

  function open(r, want){
    if(!r.detail) return;
    var next = want===undefined ? !r.classList.contains("on") : want;
    r.classList.toggle("on", next);
    r.detail.classList.toggle("open", next);
    var b=r.querySelector(".tog"); if(b) b.setAttribute("aria-expanded", next ? "true" : "false");
  }
  tb.addEventListener("click", function(e){
    var b=e.target.closest ? e.target.closest(".tog") : null;
    if(!b) return;
    open(b.parentNode.parentNode);
  });

  // A point on the map is a row. Clicking one opens it rather than only
  // naming it, which is the difference between a picture and an index.
  [].forEach.call(document.querySelectorAll("circle[data-i]"), function(dot){
    dot.addEventListener("click", function(){
      var r=document.getElementById("r"+dot.dataset.i);
      if(!r) return;
      if(r.hidden){ if(q) q.value=""; [].forEach.call(document.querySelectorAll(".chip"), function(ch){ ch.setAttribute("aria-pressed","false"); on[ch.dataset.facet]=false; }); apply(); }
      open(r, true);
      r.scrollIntoView({block:"center"});
    });
  });

  var heads=[].slice.call(document.querySelectorAll("th[data-sort]"));
  heads.forEach(function(th){
    th.addEventListener("click", function(){
      var i=[].indexOf.call(th.parentNode.children, th);
      var desc = th.getAttribute("aria-sort") !== "descending";
      heads.forEach(function(h){ h.removeAttribute("aria-sort"); });
      th.setAttribute("aria-sort", desc ? "descending" : "ascending");
      var num = th.dataset.sort === "n";
      rows.sort(function(a,b){
        var x=a.cells[i].textContent.trim(), y=b.cells[i].textContent.trim();
        // "?" means the board could not be read and "—" means none: neither is
        // a number, and neither may sort as zero next to a real count.
        if(num){ var nx=parseFloat(x), ny=parseFloat(y);
          if(isNaN(nx)&&isNaN(ny)) return 0; if(isNaN(nx)) return 1; if(isNaN(ny)) return -1;
          return desc ? ny-nx : nx-ny; }
        if(!x&&!y) return 0; if(!x) return 1; if(!y) return -1;
        return desc ? y.localeCompare(x) : x.localeCompare(y);
      });
      // A row and its panel move together, or the panel ends up under a
      // different company.
      rows.forEach(function(r){ tb.appendChild(r); if(r.detail) tb.appendChild(r.detail); });
    });
  });
})();
</script>
</body>
</html>
`;
}
