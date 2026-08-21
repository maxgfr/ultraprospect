// The territory report: what the run covered, what it found, and what a reader
// still has to decide.
//
// Two rules shape it.
//
// TRUNCATION LEADS. If the sweep could not cover its territory, that is the
// first thing in the document — not a footnote. A prospect file that quietly
// covers 40% of a town is the one failure nobody downstream can detect, and
// burying the disclosure is how a tool participates in it.
//
// NOTHING IS SUMMARISED AWAY. The run measures thirteen score terms, reads
// contacts with the page id beside each, and carries whatever verdict a person
// wrote. This document used to render a six-column table and drop the rest,
// which made a rich run look like a thin one. Everything the run knows has a
// place here, and where it knows nothing the cell stays empty rather than
// filling with a zero.
import { ranked } from "./score.js";
import { coverage, summarise, type RunSummary } from "./summary.js";
import type { Place, RunManifest } from "./types.js";
import { shortLabel, streetLine } from "./util.js";

/**
 * One markdown table cell.
 *
 * A pipe inside a company name silently splits the row into two columns, and
 * every value in this document is upstream text nobody controls. The Hamburg
 * run shipped `| 5 | Schäfer | Group | 56 | strong |` — a real company, a real
 * report, a table that reads a score of "strong" and a fit of "?" from then on.
 * Newlines do the same thing one row at a time.
 */
export function mdCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim();
}

const row = (cells: readonly unknown[]): string => `| ${cells.map(mdCell).join(" | ")} |`;

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

/** `✉ ☎`, or nothing. What channels a row can actually be reached on. */
function contactMark(place: Place): string {
  return [place.contacts.emails.length ? "✉" : "", place.contacts.phones.length ? "☎" : ""].filter(Boolean).join(" ");
}

/** The register identity, short enough for a table cell. */
function registerMark(place: Place): string {
  const s = place.registry;
  if (!s) return "";
  return `${s.id} (${s.connectorId})`;
}

/** A count and its share of the run, so a number says how big it is. */
function share(n: number, total: number): string {
  if (!total) return String(n);
  return `${n} (${Math.round((n / total) * 100)}%)`;
}

function coverageSection(manifest: RunManifest, s: RunSummary, places: readonly Place[]): string[] {
  const l: string[] = ["## Coverage", ""];
  // `mode` is the field types.ts calls the most important one in LaneCoverage,
  // and until recently it was rendered nowhere: the sweep/confirm distinction
  // reached this table only as prose smuggled inside `reason`.
  l.push("| Lane | Mode | Returned | Complete | Note |");
  l.push("|---|---|---:|---|---|");
  for (const lane of manifest.lanes) {
    const mode = lane.mode ?? (lane.lane === "registry" ? "not swept" : "—");
    l.push(row([lane.lane, mode, lane.returned, lane.truncated ? "**no**" : "yes", lane.reason ?? ""]));
  }
  l.push("");

  // Which register answered, and how it was persuaded. `byConnector` and
  // `registryEvidence.how` were both on the manifest and in the places, and
  // neither reached a reader: a run backed by 144 confirmed registration
  // numbers and one backed by 810 name lookups are not the same run.
  if (s.registry.byConnector.length) {
    l.push(`Register records by connector: ${s.registry.byConnector.map(([id, n]) => `${id} ${n}`).join(" · ")}`);
    l.push("");
  }
  if (s.registry.byEvidence.length) {
    l.push(`How each register record was attached: ${s.registry.byEvidence.map(([how, n]) => `${n} ${how}`).join(" · ")}`);
    l.push("");
  }
  // What the run was NARROWED to. Without this the activity table below reads
  // as a broken taxonomy — a run filtered to `office` tags is 99% "office" —
  // rather than as the answer to the question that was actually asked.
  if (s.filters.length) {
    l.push(`What this run looked for: ${s.filters.join(" · ")}.`);
    l.push("");
  }

  l.push(
    `${places.length} companies after fusion (${manifest.counts.merged} matched across both lanes, ${manifest.counts.undecided} pairs left for adjudication).`,
  );
  l.push("");

  // Records out of a bulk snapshot are facts about their date, and the report is
  // where a reader who will never open places.json finds that out. Grouped by date
  // rather than counted, because "1 412 records as of 2018" is the sentence that
  // matters and "some records are dated" is not.
  if (s.registry.dated.count) {
    l.push("> ⚠ **Some register records are dated.**");
    l.push(">");
    l.push(
      `> ${s.registry.dated.count} of ${places.length} companies carry a register record from a bulk open-data snapshot rather than from asking the register: ${s.registry.dated.years.join(", ")}. Those identities were true then. They are not evidence about today, and the \`registry_as_of\` column in the CSV carries the date for each one.`,
    );
    l.push("");
  }
  return l;
}

function inventorySection(s: RunSummary): string[] {
  const l: string[] = ["## What is there", ""];

  const sites = [
    `${s.websites.corroborated} with a website we corroborated`,
    s.websites.declared ? `${s.websites.declared} declared in OSM and never checked` : "",
    s.websites.unverified ? `${s.websites.unverified} unverified` : "",
    `${s.websites.none} with none at all`,
  ].filter(Boolean);
  l.push(`- **Websites.** ${sites.join(" · ")}`);

  // Nobody's site has been read yet, so there is nothing to report about
  // hiring, contacts or stacks — and "0 hiring · 0 not hiring" is not nothing,
  // it is a claim that we looked. Same rule as the three-valued `isHiring`,
  // applied one level up: a run that has not reached `enrich` says so.
  if (s.site.enriched === 0) {
    l.push(
      "- **Hiring, contacts and site signals.** Not established: no site in this run has been read yet. `enrich` fetches the pages and the job boards, and until it runs these are unknown rather than absent.",
    );
  } else {
    // Three states, never two. A job board we could not read is not an absence of
    // hiring, and flattening it into "not hiring" invents a fact about a company.
    const hiring = [`${s.hiring.yes} hiring right now (${s.hiring.roles} open roles read from ATS APIs)`, `${s.hiring.no} not hiring`];
    if (s.hiring.unknown) hiring.push(`${s.hiring.unknown} run a board we could not read — their hiring is unknown, not absent`);
    if (s.site.enriched < s.total) hiring.push(`${s.total - s.site.enriched} whose site was never read at all`);
    l.push(`- **Hiring.** ${hiring.join(" · ")}`);
    if (s.hiring.ats.length) l.push(`  - Boards seen: ${s.hiring.ats.map(([name, n]) => `${name} ${n}`).join(" · ")}`);
    if (s.hiring.matchedRoles) l.push(`  - ${s.hiring.matchedRoles} of those roles match the \`--role\` filter this run was given`);

    l.push(
      `- **Contactable.** ${s.contact.any} from a published address or number — ${s.contact.emails} by email, ${s.contact.phones} by phone, ${s.contact.both} by both`,
    );
  }

  if (s.registry.withRecord) {
    const reg = [`${share(s.registry.withRecord, s.total)} carry a register identity`];
    if (s.registry.headOffices) reg.push(`${s.registry.headOffices} head offices`);
    if (s.registry.ceased) reg.push(`${s.registry.ceased} filed as ceased`);
    if (s.registry.withOfficers) reg.push(`${s.registry.withOfficers} publish officers (${s.registry.officers} people)`);
    l.push(`- **Register.** ${reg.join(" · ")}`);
  }

  // `attested` is the distinction types.ts exists to protect: VIES will confirm
  // a German VAT number is live and refuse to name who holds it. That is a real,
  // citable fact and it is NOT an identity — so it gets counted separately.
  if (s.legalIds.total) {
    l.push(
      `- **Legal identifiers found on the companies' own sites.** ${s.legalIds.total} read · ${s.legalIds.verified} verified and named by an authority · ${s.legalIds.attested} attested live but with no name disclosed · ${s.legalIds.unverified} nobody could answer on`,
    );
  }

  if (s.site.enriched) {
    const site = [`${s.site.pagesRead} pages stored across ${s.site.withPages} companies`];
    if (s.site.withCms) site.push(`${s.site.withCms} on a recognised CMS`);
    if (s.site.withLastContent) site.push(`${s.site.withLastContent} publish a last-modified date`);
    if (s.site.pricing) site.push(`${s.site.pricing} publish pricing`);
    if (s.site.ecommerce) site.push(`${s.site.ecommerce} sell online`);
    l.push(`- **Sites.** ${site.join(" · ")}`);
  }
  l.push("");

  // A run where 1 146 of 2 504 companies score zero is a different run from one
  // where they cluster at 50, and the ranked table's top fifty cannot show it.
  if (s.total) {
    l.push("### Score distribution");
    l.push("");
    l.push("| Measured score | Companies |");
    l.push("|---|---:|");
    for (const [label, n] of s.scores.bands) l.push(row([label, n]));
    l.push("");
    l.push(`Highest measured score in the run: ${s.scores.max}.`);
    l.push("");
  }

  if (s.bySection.length) {
    l.push("### By activity");
    l.push("");
    l.push("| Activity | Companies |");
    l.push("|---|---:|");
    for (const [key, n] of s.bySection.slice(0, 12)) l.push(row([key, n]));
    l.push("");
  }
  if (s.byBand.length) {
    l.push("### By size");
    l.push("");
    l.push("| Headcount | Companies |");
    l.push("|---|---:|");
    for (const [label, n] of s.byBand) l.push(row([label, n]));
    l.push("");
  }
  return l;
}

/** How many rows of a detail table before the document stops being readable. */
const SECTION_CAP = 25;

function hiringSection(places: readonly Place[]): string[] {
  const hiring = ranked(places.filter((p) => p.signals?.isHiring === true && (p.signals.openRoles ?? 0) > 0));
  if (!hiring.length) return [];
  const roles = hiring.reduce((n, p) => n + (p.signals?.openRoles ?? 0), 0);

  const l: string[] = [`## Who is hiring (${hiring.length} companies, ${roles} open roles)`, ""];
  l.push("| Company | Open roles | Matching the brief | Oldest role | Via | Website |");
  l.push("|---|---:|---:|---:|---|---|");
  for (const p of hiring.slice(0, SECTION_CAP)) {
    const sg = p.signals!;
    l.push(
      row([
        p.name,
        sg.openRoles,
        sg.matchedRoles ?? "",
        sg.oldestOpenRoleDays !== undefined ? `${Math.round(sg.oldestOpenRoleDays)} d` : "",
        sg.atsProviders.join(", ") || "the site",
        p.website?.url ?? "",
      ]),
    );
  }
  if (hiring.length > SECTION_CAP) l.push(row([`…and ${hiring.length - SECTION_CAP} more, in PROSPECTS.csv`, "", "", "", "", ""]));
  l.push("");
  return l;
}

/**
 * The verdicts somebody actually wrote, verbatim.
 *
 * `score.why` and `score.angle` are the most expensive fields in the run — a
 * person read a dossier and decided — and they were rendered in neither
 * deliverable. Verbatim rather than summarised: a judgement paraphrased by the
 * tool that carries it is no longer that person's judgement.
 */
function judgedSection(places: readonly Place[], s: RunSummary): string[] {
  const judged = ranked(places).filter((p) => p.score?.fit);
  if (!judged.length) return [];

  const l: string[] = [`## Judged (${judged.length} of ${s.total})`, ""];
  if (s.fit.byVerdict.length) {
    l.push(s.fit.byVerdict.map(([verdict, n]) => `${n} ${verdict}`).join(" · "));
    l.push("");
  }
  for (const [i, p] of judged.slice(0, SECTION_CAP).entries()) {
    l.push(`### ${i + 1}. ${p.name} — ${p.score!.fit} · ${p.score!.total}`);
    l.push("");
    const where = [streetLine(p.address), p.address.codePostal, p.address.commune].filter(Boolean).join(", ");
    const contact = [p.contacts.emails[0], p.contacts.phones[0]].filter(Boolean).map((c) => `${c!.value} [${c!.from}]`);
    const line = [where, p.website?.url, ...contact].filter(Boolean).join(" · ");
    if (line) {
      l.push(line);
      l.push("");
    }
    if (p.score!.why) {
      l.push(`**Why.** ${p.score!.why}`);
      l.push("");
    }
    if (p.score!.angle) {
      l.push(`**Angle.** ${p.score!.angle}`);
      l.push("");
    }
  }
  if (judged.length > SECTION_CAP) {
    l.push(`…and ${judged.length - SECTION_CAP} more verdicts, in the \`fit_why\` and \`angle\` columns of \`PROSPECTS.csv\`.`);
    l.push("");
  }

  // Said plainly, because an empty Fit column looks like a rejection and is not
  // one. The distinction decides whether somebody works the rest of the list.
  const unjudged = s.total - judged.length;
  if (unjudged > 0) {
    l.push(
      `${unjudged} companies carry a measured score and no verdict. Their Fit column is empty because nobody has read them yet, not because they were rejected — \`dossier\` then \`score --apply\` is what fills it.`,
    );
    l.push("");
  }
  return l;
}

/** How many ranked rows the document carries before it stops being a document. */
const RANKED_CAP = 50;

function rankedSection(places: readonly Place[]): string[] {
  const order = ranked(places);
  const l: string[] = ["## Ranked", ""];
  l.push("| # | Company | Score | Fit | Roles | Town | Contact | Register | Website |");
  l.push("|---:|---|---:|---|---|---|---|---|---|");
  for (const [i, p] of order.slice(0, RANKED_CAP).entries()) {
    // "?" means the board could not be read and "—" means none. Neither is a
    // number, and neither may be printed as zero next to a real count.
    const h = p.signals?.isHiring === true ? `${p.signals.openRoles}` : p.signals?.isHiring === false ? "—" : "?";
    l.push(row([i + 1, p.name, p.score?.total ?? 0, p.score?.fit ?? "", h, p.address.commune ?? "", contactMark(p), registerMark(p), p.website?.url ?? ""]));
  }
  l.push("");
  if (order.length > RANKED_CAP) {
    l.push(`The other ${order.length - RANKED_CAP} companies are in \`PROSPECTS.csv\` and \`index.html\`, ranked the same way.`);
    l.push("");
  }
  return l;
}

function notesSection(s: RunSummary): string[] {
  if (!s.notes.lines.length) return [];
  const header =
    s.notes.distinct === s.notes.emitted ? `## Run notes (${s.notes.emitted})` : `## Run notes (${s.notes.distinct} distinct of ${s.notes.emitted})`;
  const l: string[] = [header, ""];
  // The count is the finding. Forty identical VIES lines say something about the
  // German register that one line does not, and printing them forty times says
  // it in the way that pushes every lane summary off the page.
  for (const n of s.notes.lines) l.push(`- ${n.count > 1 ? `×${n.count} ` : ""}${n.text}`);
  const rest = s.notes.distinct - s.notes.lines.length;
  if (rest > 0) l.push(`- …and ${rest} more distinct notes, in \`manifest.json\``);
  l.push("");
  return l;
}

export function buildReport(places: readonly Place[], manifest: RunManifest): string {
  const s = summarise(places, manifest);
  const l: string[] = [];

  l.push(`# ${shortLabel(manifest.target.label || manifest.slug)}`);
  l.push("");
  l.push(...truncationBanner(manifest));
  l.push(`${manifest.target.label}`);
  l.push("");
  l.push(coverage(manifest).sentence);
  l.push("");

  l.push(...coverageSection(manifest, s, places));
  l.push(...inventorySection(s));
  l.push(...hiringSection(places));
  l.push(...judgedSection(places, s));
  l.push(...rankedSection(places));
  l.push(...notesSection(s));

  l.push("## Sources");
  l.push("");
  for (const licence of manifest.licences) l.push(`- ${licence}`);
  l.push("");
  l.push(`Extracted ${manifest.builtAt.slice(0, 10)}.`);
  return l.join("\n") + "\n";
}
