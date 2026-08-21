// The deliverables: a CRM-ready CSV, a territory report, a self-contained page,
// and the privacy note that has to travel with them.
//
// Four shapes of one run, built from one set of places and one manifest. What
// each of them is for is documented where it is built — `report.ts` for the
// document, `html.ts` for the page, `csv.ts` for the spreadsheet — and every
// aggregate any of them prints comes from `summary.ts`, computed once, so the
// page and the report cannot disagree about a territory.
import { toCsv, type CsvOptions } from "./csv.js";
import { buildHtml } from "./html.js";
import { buildReport } from "./report.js";
import { ranked } from "./score.js";
import type { Place, RunManifest } from "./types.js";

export { buildReport } from "./report.js";
export { buildHtml, HTML_ROW_CAP } from "./html.js";

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
