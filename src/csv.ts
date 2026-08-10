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
import { EFFECTIF_LABELS } from "./sirene.js";
import { ranked } from "./score.js";
import type { Place } from "./types.js";
import { csvRow } from "./util.js";

export interface CsvOptions {
  /** Drop every named individual and personal address. */
  noPeople?: boolean;
  /** Only rows at or above this measured score. */
  minScore?: number;
  /** Only rows the agent judged at least this well. */
  minFit?: "strong" | "possible" | "weak";
}

const HEADER = [
  "id",
  "name",
  "score",
  "fit",
  "fit_why",
  "angle",
  "category",
  "naf",
  "section",
  "company_naf",
  "company_section",
  "headcount_band",
  "company_headcount_band",
  "revenue_eur",
  "revenue_year",
  "siren",
  "siret",
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
  "emails",
  "contact_source",
  "phones",
  "socials",
  "officers",
  "is_hiring",
  "open_roles",
  "ats",
  "cms",
  "last_content_at",
  "pages_read",
  "sources",
  "match_confidence",
] as const;

const FIT_ORDER = ["weak", "possible", "strong"] as const;

function keep(place: Place, opts: CsvOptions): boolean {
  if (opts.minScore !== undefined && (place.score?.total ?? 0) < opts.minScore) return false;
  if (opts.minFit) {
    const want = FIT_ORDER.indexOf(opts.minFit);
    const got = place.score?.fit ? FIT_ORDER.indexOf(place.score.fit as (typeof FIT_ORDER)[number]) : -1;
    if (got < want) return false;
  }
  return true;
}

function streetOf(place: Place): string {
  const a = place.address;
  const type = a.typeVoie?.trim();
  const name = a.libelleVoie?.trim();
  if (!name) return [a.numero, type].filter(Boolean).join(" ");
  const prefixed = type ? new RegExp(`^${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(name) : false;
  return [a.numero, prefixed ? undefined : type, name].filter(Boolean).join(" ");
}

export function toCsv(places: readonly Place[], opts: CsvOptions = {}): string {
  const rows: string[] = [csvRow(HEADER)];

  for (const place of ranked(places).filter((p) => keep(p, opts))) {
    const s = place.sirene;
    const sg = place.signals;
    const people = opts.noPeople
      ? ""
      : (s?.dirigeants ?? []).map((d) => [d.denomination ?? [d.prenoms, d.nom].filter(Boolean).join(" "), d.qualite].filter(Boolean).join(" — ")).join(" | ");

    rows.push(
      csvRow([
        place.id,
        place.name,
        place.score?.total ?? 0,
        place.score?.fit ?? "",
        place.score?.why ?? "",
        place.score?.angle ?? "",
        place.category ?? "",
        s?.nafCode ?? "",
        s?.section ?? "",
        // The legal unit's, in its own columns: every register filter matched
        // on these, so a row that looks off-target can be explained instead of
        // looking like a bug.
        s?.company?.nafCode ?? "",
        s?.company?.section ?? "",
        s?.effectifTranche ? (EFFECTIF_LABELS[s.effectifTranche] ?? s.effectifTranche) : "",
        s?.company?.effectifTranche ? (EFFECTIF_LABELS[s.company.effectifTranche] ?? s.company.effectifTranche) : "",
        s?.finances?.ca ?? "",
        s?.finances?.annee ?? "",
        s?.siren ?? "",
        s?.siret ?? "",
        s?.estSiege ? "yes" : s ? "no" : "",
        s?.dateCreation ?? "",
        streetOf(place),
        place.address.codePostal ?? "",
        place.address.commune ?? "",
        place.address.codeCommune ?? "",
        place.lat ?? "",
        place.lon ?? "",
        place.website?.url ?? "",
        place.website?.confidence ?? "",
        place.contacts.emails.map((e) => e.value).join(" | "),
        // The page each contact came from, in the same order as the column
        // beside it. A CRM row without this cannot be audited later.
        place.contacts.emails.map((e) => e.from).join(" | "),
        place.contacts.phones.map((p) => p.value).join(" | "),
        place.contacts.socials.map((x) => x.value).join(" | "),
        people,
        // Three states, not two: an empty cell means a board was found and
        // could not be read, which is not the same as "no".
        sg?.isHiring === true ? "yes" : sg?.isHiring === false ? "no" : "",
        sg?.openRoles ?? "",
        sg?.atsProviders.join(" | ") ?? "",
        sg?.cms ?? "",
        sg?.lastContentAt ?? "",
        place.pages.length,
        place.sources.join("+"),
        place.matchConfidence ?? "",
      ]),
    );
  }

  return rows.join("\n") + "\n";
}

/** The column list, exported so the docs and the tests cannot drift from it. */
export const CSV_COLUMNS: readonly string[] = HEADER;
