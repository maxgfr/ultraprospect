// Germany — the Handelsregister, by way of OffeneRegister's open export.
//
// Germany has no official machine-readable company register. handelsregister.de
// has been free to search since August 2022 and is a JSF form with no API; the
// register itself is 150 separate databases held by local district courts. What
// exists as OPEN DATA is one export, published by the Open Knowledge Foundation
// Deutschland with OpenCorporates: `de_companies_ocdata.jsonl.bz2`, 260 MB, CC-BY
// 4.0, 4.5 million companies with their officers.
//
// TWO THINGS ABOUT IT THAT DECIDE THE WHOLE DESIGN, both measured rather than read:
//
//   1. IT IS FROZEN. The file's Last-Modified is 2019-02-05 and each record
//      carries its own `retrieved_at`, which in a 120 000-record sample ranged
//      from 2017-06 to 2019-01. Its SQL API is gone — db.offeneregister.de answers
//      502. So every record here is a fact about 2017-2019 and about nothing
//      later, and `asOf` carries that per record rather than as a footnote.
//
//   2. IT NAMES THE HOLDER OF AN HRB NUMBER. This is why it is worth having at
//      all. VIES confirms that a German VAT number is live and flatly refuses to
//      say whose it is — it answers "---" — so until now a German run could prove
//      an identifier real and never learn the company behind it. This export
//      closes exactly that gap, and the two sources answer different questions:
//      VIES says the number is live TODAY, this says who filed under it THEN.
//
// AND THEREFORE NO `sweep`. The export is national and could technically be
// filtered to a town, but an enumeration from 2018 presented as the businesses in
// a Berlin district would be precisely the lie the rest of this tool is built to
// refuse. It confirms; it does not survey.
//
// One more measured trap, and the full export made it sharper than a sample could.
// German register numbers REPEAT ACROSS COURTS — "HRB 1" is filed at TWENTY
// different Amtsgerichte, "HRB 158855" at two — and GLEIF once resolved Immertreu's
// HRA 4792 to a company in another Land. This export is the first source here that
// carries the court, so a bare number is only ever an identity when exactly one
// court has it, and otherwise it is refused with the courts named.
//
// The court is compared by CONTAINMENT rather than matched exactly, which a
// 120 000-record sample would not have shown: Berlin's records are filed under
// "Berlin (Charlottenburg)", while an Impressum says "Amtsgericht Charlottenburg".
// Several courts also carry a "früher …" suffix ("Kleve früher Emmerich"). An
// exact match refused the very company it was holding.
import { snapshotById, snapshotByLocality, snapshotMeta, hasSnapshot, type SnapshotSource } from "../snapshot.js";
import { nameSimilarity, normalizeName } from "../util.js";
import type { Dirigeant, PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, ConnectorContext, LegalId, LookupQuery, RegistryConnector, RegistryRecord } from "./types.js";

const CONNECTOR_ID = "de-offeneregister";
const DUMP_URL = "https://daten.offeneregister.de/de_companies_ocdata.jsonl.bz2";
const HOW_TO_INGEST = "run `ultraprospect ingest --country de` once (260 MB, keyless) to index the German register export.";

/** The register kinds the export covers, measured over a sample of the real file. */
const REGISTER_KINDS = ["HRA", "HRB", "GnR", "VR", "PR"] as const;

/**
 * Split "Charlottenburg HRA 4792" — and "Flensburg HRB 7531 FL", which is why the
 * number is not anchored as digits-to-end.
 *
 * 99.84% of a 120 000-record sample matched this; the misses were all Flensburg's
 * trailing "FL". Written from that measurement rather than from a description of
 * the field.
 */
export function splitNativeNumber(native: string | undefined): { court?: string; kind?: string; number?: string } {
  const m = native?.trim().match(/^(.+?)\s+(HRA|HRB|GnR|VR|PR)\s+(\S+(?:\s+\S+)?)$/);
  if (!m) return {};
  return { court: m[1], kind: m[2], number: m[3]!.trim() };
}

/**
 * Parse the single free-text address the export publishes.
 *
 * "Waidmannstraße 1, 22769 Hamburg." — one string, no components. Present on only
 * 34.9% of records (measured), of which 90.5% match this shape. The rest keep the
 * raw string: a town is still known from `registered_office`, and a half-parsed
 * address is worth more than a discarded one.
 */
export function parseGermanAddress(raw: string | undefined, fallbackTown?: string): PostalAddress {
  const text = raw?.trim().replace(/\.$/, "");
  if (!text) return fallbackTown ? { commune: fallbackTown, pays: "Germany" } : { pays: "Germany" };
  const m = text.match(/^(.*?),\s*(\d{5})\s+(.+)$/);
  if (!m) return { raw: text, commune: fallbackTown, pays: "Germany" };
  return { raw: text, libelleVoie: m[1]?.trim() || undefined, codePostal: m[2], commune: m[3]?.trim() || fallbackTown, pays: "Germany" };
}

/**
 * "currently registered" or "removed", and 61% of the real file is removed.
 *
 * That proportion is the reason this is mapped carefully rather than defaulted:
 * treating "removed" as active would attach a struck-off company to a shop that is
 * open, and most of the export would be eligible to do it.
 */
function statusOf(raw: string | undefined): "active" | "ceased" | "unknown" {
  if (raw === "currently registered") return "active";
  if (raw === "removed") return "ceased";
  return "unknown";
}

function officersOf(raw: unknown): Dirigeant[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o) => o && typeof o === "object")
    .map((o: any) => ({
      nom: o.other_attributes?.lastname ?? o.name ?? undefined,
      prenoms: o.other_attributes?.firstname ?? undefined,
      qualite: o.position ?? undefined,
    }))
    .filter((d) => d.nom);
}

export const offeneRegisterSnapshot: SnapshotSource = {
  format: "jsonl.bz2",
  urls: () => [DUMP_URL],
  licence: "German company data: OffeneRegister.de / OpenCorporates, CC-BY 4.0",
  // The file's own Last-Modified is 2019-02-05, but its records were retrieved
  // over 2017-2019 and each says when. So no global vintage is declared: the
  // per-record `retrieved_at` below is more truthful than any single date.
  approxBytes: 260_455_433,
  // Measured on a full ingest: 5 305 727 records, 3377 MB.
  approxDiskBytes: 3_400_000_000,

  parse(row: any) {
    const attrs = row?.all_attributes ?? {};
    const name: string | undefined = row?.name?.trim();
    const native: string | undefined = attrs.native_company_number;
    if (!name || !native) return undefined;

    const { court, kind, number } = splitNativeNumber(native);
    const town: string | undefined = attrs.registered_office?.trim();
    const asOf = typeof row.retrieved_at === "string" ? row.retrieved_at.slice(0, 10) : undefined;

    const record: RegistryRecord = {
      connectorId: CONNECTOR_ID,
      // The court-qualified number IS the identity. `company_number` in this
      // export is an OpenCorporates internal key ("K1101R_HRB150148") that no
      // German legal notice ever prints, so it is dropped entirely rather than
      // stored under a name that invites somebody to cite it.
      id: native.trim(),
      names: [name],
      legalName: name,
      officers: officersOf(row.officers),
      address: parseGermanAddress(row.registered_address, town),
      countryCode: "de",
      status: statusOf(row.current_status),
      // No activity code: the Handelsregister files none. Declaring a section
      // would invent a classification the register does not publish.
      sourceUrl: "https://offeneregister.de/",
      asOf,
      // Only what is NOT already derivable from the fields beside it. At 5.3
      // million rows every repetition is measured in gigabytes: storing
      // `nativeCompanyNumber` (identical to `id`), `registerKind` (the first token
      // of `registerNumber`), OpenCorporates' internal key and `retrievedAt`
      // (identical to `asOf`) cost about a gigabyte to say nothing new.
      national: {
        registerNumber: kind && number ? `${kind} ${number}` : undefined,
        registerCourt: court ?? attrs.registrar,
        federalState: attrs.federal_state,
      },
    };

    // Indexed under both forms: court-qualified, which is unambiguous, and bare,
    // because that is what a Impressum often prints. A bare hit still has to
    // agree on the name — see `verifyId`.
    const ids = [native.trim(), kind && number ? `${kind} ${number}` : undefined].filter((x): x is string => Boolean(x));
    return { record, localities: town ? [town] : [], ids };
  },
};

export const deOffeneRegister: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["de"],
  label: "Germany — Handelsregister via OffeneRegister (open export, 2017-2019 vintage)",
  licence: offeneRegisterSnapshot.licence,
  // The Handelsregister publishes no activity classification at all, so there is
  // no scheme to declare. Claiming NACE here would imply codes that do not exist.
  activityScheme: "none",
  activityPrefix: CONNECTOR_ID,
  docsUrl: "https://offeneregister.de/",
  snapshot: offeneRegisterSnapshot,

  availability(): Availability {
    if (hasSnapshot(CONNECTOR_ID)) return { available: true };
    return { available: false, reason: "no German register snapshot has been ingested", how: HOW_TO_INGEST };
  },

  /**
   * Look a company up by name in its town.
   *
   * A candidate, not a fact — `confirm` puts it through the same identity-dominant
   * thresholds a French sweep uses. Ceased companies are excluded because 61% of
   * this export is struck-off entries and a name match against one of them would
   * attach a dead registration to a business that is trading.
   */
  async lookup(query: LookupQuery): Promise<RegistryRecord[]> {
    const name = query.names.find((n) => n?.trim());
    if (!name || !query.locality || !hasSnapshot(CONNECTOR_ID)) return [];
    const needle = normalizeName(name);
    if (needle.length < 4) return [];
    return snapshotByLocality(
      CONNECTOR_ID,
      query.locality,
      (r) => r.status !== "ceased" && r.names.some((n) => nameSimilarity(n, name) >= 0.6 || normalizeName(n).includes(needle)),
      Math.min(20, query.limit ?? 5),
    );
  },

  /**
   * Confirm a register number read off a company's own Impressum.
   *
   * German law requires the number and the court on the page (§ 5 DDG), and both
   * are used when both are there. A number WITHOUT its court is ambiguous by
   * construction — HRA 4792 exists at several Amtsgerichte — so a bare match is
   * only returned when the export holds exactly one candidate for it. More than
   * one and it refuses, which is the same refusal `match` makes on a middle-band
   * pair and for the same reason: two rows are recoverable, one wrong attribution
   * is not.
   */
  async verifyId(id: LegalId, ctx: ConnectorContext): Promise<RegistryRecord | undefined> {
    if (!hasSnapshot(CONNECTOR_ID)) return undefined;
    if (!REGISTER_KINDS.some((k) => k.toLowerCase() === id.kind.toLowerCase())) return undefined;

    const value = id.value.trim().replace(/\s+/g, " ");
    // The court, when the legal notice named one, arrives as the identifier's
    // context — the same field the German HRB extractor already fills.
    const court = id.context?.trim();

    // Look the BARE number up first and filter by court, rather than building a
    // court-qualified key and hoping it matches.
    //
    // Measured on the full 5.3-million-record export: Berlin's records are filed
    // under "Berlin (Charlottenburg) HRB 158855", not "Charlottenburg HRB 158855".
    // An Impressum says "Amtsgericht Charlottenburg", so an exact-key lookup
    // refused the very company it was holding — and a 120 000-record sample had
    // only ever shown the short form. So the court is compared by containment,
    // which handles both spellings and the "früher …" suffixes several courts
    // carry ("Kleve früher Emmerich").
    // 50 is a reporting cap, not a belief about how many courts exist: "HRB 1" hit
    // it on the real export. The note below says "at least" for that reason.
    const COURT_REPORT_CAP = 50;
    const bare = await snapshotById(CONNECTOR_ID, value, COURT_REPORT_CAP);
    if (court) {
      const wanted = normalizeName(court);
      const byCourt = bare.filter((r) => {
        const filed = normalizeName(String(r.national?.registerCourt ?? ""));
        return filed === wanted || filed.includes(wanted) || wanted.includes(filed);
      });
      if (byCourt.length === 1) return byCourt[0];
      if (byCourt.length > 1) {
        ctx.onNote?.(`de-offeneregister: ${value} at a court matching "${court}" is filed more than once; not attached.`);
        return undefined;
      }
    }

    if (bare.length === 1) return bare[0];
    if (bare.length > 1) {
      const courts = [...new Set(bare.map((r) => r.national?.registerCourt).filter(Boolean))];
      const atLeast = bare.length >= COURT_REPORT_CAP ? "at least " : "";
      ctx.onNote?.(
        `de-offeneregister: ${value} is filed at ${atLeast}${courts.length} different courts (${courts.slice(0, 8).join(", ")}${courts.length > 8 ? ", …" : ""}). German register numbers repeat, so this one is not an identity without its Amtsgericht.`,
      );
    }
    return undefined;
  },

  /**
   * Is the export still there, still parseable, and still the same vintage?
   *
   * The third check is the interesting one, and it is not a drift alarm: a moved
   * Last-Modified would mean OffeneRegister had resumed publishing after seven
   * years, which is news worth knowing rather than a failure. It is reported as
   * inconclusive so it reads as "go look" instead of "you are broken".
   */
  async canary(): Promise<CanaryCheck[]> {
    const res = await fetch(DUMP_URL, { method: "HEAD" });
    const lastModified = res.headers.get("last-modified");
    const checks: CanaryCheck[] = [
      { name: "the OffeneRegister export is still served", ok: res.ok, detail: `HTTP ${res.status}` },
      {
        name: "the export's Content-Length is still around 260 MB",
        ok: Math.abs(Number(res.headers.get("content-length") ?? 0) - offeneRegisterSnapshot.approxBytes) < 50e6,
        detail: `${res.headers.get("content-length")} bytes`,
      },
    ];
    // 2019-02-05 is the frozen vintage every record's `asOf` is measured against.
    if (lastModified && !lastModified.includes("2019")) {
      checks.push({
        name: "the German export has a NEW vintage — OffeneRegister may have resumed publishing",
        ok: true,
        inconclusive: true,
        detail: `Last-Modified is now ${lastModified}, not 2019. Re-measure the record shape and re-ingest.`,
      });
    }
    return checks;
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const meta = snapshotMeta(CONNECTOR_ID);
    if (meta) return { ok: true, detail: `${meta.rows} records in cache, vintage ${meta.lastModified ?? meta.vintage ?? "unknown"}` };
    const res = await fetch(DUMP_URL, { method: "HEAD" });
    return { ok: res.ok, detail: res.ok ? `export reachable, not yet ingested — ${HOW_TO_INGEST}` : `HTTP ${res.status}` };
  },
};
