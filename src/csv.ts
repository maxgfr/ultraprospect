// The CSV, which is the artifact most people will actually use.
//
// It goes into a CRM, so its columns are flat, its header is stable, and the
// two kinds of judgement in it are kept in separate columns: `score` is what
// the engine measured, `fit` is what a person decided. A single blended number
// would be more convenient and would destroy the only column nobody had to be
// trusted for.
//
// Provenance travels with the risky fields. `website_confidence` says whether
// the URL was proved or merely claimed; `contact_source` names the page each
// email came from. A CRM row that has lost its provenance cannot be audited,
// and this file exists precisely so that it can be.
import { sizeBandLabel } from "./registry/index.js";
import { ranked } from "./score.js";
import type { Place } from "./types.js";
import { UsageError } from "./engine.js";
import { csvRow, streetLine } from "./util.js";

export interface CsvOptions {
  /** Drop every named individual and personal address. */
  noPeople?: boolean;
  /** Only rows at or above this measured score. */
  minScore?: number;
  /** Only rows the agent judged at least this well. */
  minFit?: "strong" | "possible" | "weak";
  /** Write formula-looking cells unchanged instead of apostrophe-guarded (`--csv-raw`). */
  csvRaw?: boolean;
}

const HEADER = [
  "id",
  "name",
  "score",
  "fit",
  "fit_why",
  "angle",
  "category",
  "registry",
  "activity_code",
  "activity_scheme",
  "section",
  "company_activity_code",
  "company_section",
  "headcount_band",
  "company_headcount_band",
  "revenue",
  "revenue_currency",
  "revenue_year",
  "registry_id",
  "establishment_id",
  "registry_url",
  "registry_evidence",
  // The date the register record was TRUE, when it came from a bulk snapshot
  // rather than from asking the register. Empty means live. A CRM importing this
  // column is the last place the distinction can still be made.
  "registry_as_of",
  "is_head_office",
  "registered_since",
  "street",
  "postcode",
  "city",
  "insee_code",
  "lat",
  "lon",
  "website",
  "website_confidence",
  "web_presence",
  "emails",
  "contact_source",
  "phones",
  "phone_source",
  "socials",
  "social_source",
  "officers",
  "is_hiring",
  "open_roles",
  "matched_roles",
  "role_filter",
  "oldest_open_role_days",
  "term_matches",
  "term_match_source",
  "ats",
  "cms",
  "last_content_at",
  "pages_read",
  "sources",
  "match_confidence",
] as const;

const FIT_ORDER = ["weak", "possible", "strong"] as const;

/**
 * Read a `--min-fit` value, or refuse it.
 *
 * The value used to be cast and trusted. A typo — `--min-fit strng` — then
 * ranked below every level, so the filter kept EVERY row, including the ones
 * judged "no": the user asked for the shortlist and was handed the whole file
 * with nothing to say so.
 */
export function parseMinFit(raw: unknown): CsvOptions["minFit"] {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string" && (FIT_ORDER as readonly string[]).includes(raw)) return raw as CsvOptions["minFit"];
  throw new UsageError(`--min-fit must be strong, possible or weak — got ${JSON.stringify(raw)}`);
}

function keep(place: Place, opts: CsvOptions): boolean {
  if (opts.minScore !== undefined && (place.score?.total ?? 0) < opts.minScore) return false;
  if (opts.minFit) {
    const want = FIT_ORDER.indexOf(opts.minFit);
    const got = place.score?.fit ? FIT_ORDER.indexOf(place.score.fit as (typeof FIT_ORDER)[number]) : -1;
    if (got < want) return false;
  }
  return true;
}

/** What `--min-score` / `--min-fit` did to a run, for the deliverables to state. */
export interface RowSelection {
  /** The filter in words: "score at least 40, fit at least possible". */
  filter: string;
  /** Rows the run holds, before the filter. */
  total: number;
  kept: number;
  removed: number;
}

/**
 * The rows `--min-score` and `--min-fit` keep, and an account of the cut.
 *
 * One function, because the filter used to live inside the CSV writer alone:
 * `render --min-fit strong` wrote a CSV of the shortlist beside a page, a
 * report and a prospects.json that still held every row, so the four
 * deliverables of one command described two different lists. Every one of them
 * is now cut here, and `selection` is what lets a document say it is a
 * selection — undefined when no filter was asked for.
 */
export function selectRows<T extends Place>(places: readonly T[], opts: CsvOptions = {}): { rows: T[]; selection?: RowSelection } {
  // Checked here as well as at the flag, so no caller can hand over a level the
  // filter would silently treat as "keep everything".
  parseMinFit(opts.minFit);
  const asked = [opts.minScore !== undefined ? `score at least ${opts.minScore}` : "", opts.minFit ? `fit at least ${opts.minFit}` : ""].filter(Boolean);
  const rows = places.filter((p) => keep(p, opts));
  if (asked.length === 0) return { rows };
  return { rows, selection: { filter: asked.join(", "), total: places.length, kept: rows.length, removed: places.length - rows.length } };
}

export function toCsv(places: readonly Place[], opts: CsvOptions = {}): string {
  const raw = { raw: opts.csvRaw === true };
  const rows: string[] = [csvRow(HEADER, raw)];

  for (const place of ranked(selectRows(places, opts).rows)) {
    const s = place.registry;
    const sg = place.signals;
    const people = opts.noPeople
      ? ""
      : (s?.officers ?? []).map((d) => [d.denomination ?? [d.prenoms, d.nom].filter(Boolean).join(" "), d.qualite].filter(Boolean).join(" — ")).join(" | ");

    rows.push(
      csvRow(
        [
          place.id,
          place.name,
          place.score?.total ?? 0,
          place.score?.fit ?? "",
          place.score?.why ?? "",
          place.score?.angle ?? "",
          place.category ?? "",
          s?.connectorId ?? "",
          s?.activityCode ?? "",
          // The scheme travels with the code, always. NACE "D" and US SIC "D" are
          // different economies, and a spreadsheet that lost the scheme would
          // merge them without anyone noticing.
          s?.activityScheme ?? "",
          s?.section ?? "",
          // The legal unit's, in its own columns: every register filter matched
          // on these, so a row that looks off-target can be explained instead of
          // looking like a bug.
          s?.parent?.activityCode ?? "",
          s?.parent?.section ?? "",
          s ? (sizeBandLabel(s, s.sizeBand) ?? (s.employees != null ? String(s.employees) : "")) : "",
          s ? (sizeBandLabel(s, s.parent?.sizeBand) ?? (s.parent?.employees != null ? String(s.parent.employees) : "")) : "",
          s?.finances?.revenue ?? "",
          s?.finances?.currency ?? "",
          s?.finances?.year ?? "",
          s?.id ?? "",
          s?.establishmentId ?? "",
          s?.sourceUrl ?? "",
          // How the register record got attached: swept with the territory, or
          // confirmed against an identifier read off the company's own site. Not
          // equally strong, so the CSV says which.
          place.registryEvidence ? `${place.registryEvidence.mode}:${place.registryEvidence.how}` : "",
          place.registry?.asOf ?? "",
          s?.isHeadOffice ? "yes" : s ? "no" : "",
          s?.dateCreated ?? "",
          streetLine(place.address),
          place.address.codePostal ?? "",
          place.address.commune ?? "",
          place.address.codeCommune ?? "",
          place.lat ?? "",
          place.lon ?? "",
          place.website?.url ?? "",
          place.website?.confidence ?? "",
          // Empty means discovery has not run for this row — NOT that it has no
          // presence. "none" is the measured absence; blank is silence.
          place.webPresence ?? "",
          place.contacts.emails.map((e) => e.value).join(" | "),
          // The page each contact came from, in the same order as the column
          // beside it. A CRM row without this cannot be audited later.
          place.contacts.emails.map((e) => e.from).join(" | "),
          place.contacts.phones.map((p) => p.value).join(" | "),
          place.contacts.phones.map((p) => p.from).join(" | "),
          place.contacts.socials.map((x) => x.value).join(" | "),
          place.contacts.socials.map((x) => x.from).join(" | "),
          people,
          // Three states, not two: an empty cell means a board was found and
          // could not be read, which is not the same as "no".
          sg?.isHiring === true ? "yes" : sg?.isHiring === false ? "no" : "",
          sg?.openRoles ?? "",
          sg?.matchedRoles ?? "",
          sg?.roleFilter?.join(" | ") ?? "",
          sg?.oldestOpenRoleDays ?? "",
          // The terms the company itself used, verbatim, with the page beside
          // them — so a row can be checked without opening the run.
          sg?.termMentions?.map((m) => m.value).join(" | ") ?? "",
          [...new Set(sg?.termMentions?.map((m) => m.from) ?? [])].join(" | "),
          sg?.atsProviders.join(" | ") ?? "",
          sg?.cms ?? "",
          sg?.lastContentAt ?? "",
          place.pages.length,
          place.sources.join("+"),
          place.matchConfidence ?? "",
        ],
        raw,
      ),
    );
  }

  return rows.join("\n") + "\n";
}

/** The column list, exported so the docs and the tests cannot drift from it. */
export const CSV_COLUMNS: readonly string[] = HEADER;
