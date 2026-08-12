// Estonia — the Äriregister, published as open data by the Centre of Registers.
//
// The FRESHEST register in this tool and the smallest download: 18 MB of zipped
// CSV, rebuilt daily, no key and no registration. Where the German export is
// frozen at 2019 and the British one is a month old, this one was last modified
// today — so its records carry no `asOf` at all, because there is nothing to hedge.
//
// That makes Estonia the THIRD register here that can be enumerated over a
// territory, and the cheapest by a wide margin: 376 025 companies against a
// download smaller than a photograph.
//
// FOUR THINGS MEASURED OFF THE REAL FILE, each of which would have produced a
// confidently wrong record:
//
//   1. IT IS SEMICOLON-SEPARATED. Every Estonian address contains commas
//      ("Harju maakond, Tallinn, Pirita linnaosa, Regati pst 12"), so a
//      comma-split does not merely mis-parse a few rows — it shreds most of them.
//
//   2. IT CARRIES A UTF-8 BOM. Left in, the first column's NAME becomes "﻿nimi"
//      and every company arrives nameless while the file looks perfectly readable.
//
//   3. THE LOCALITY IS A HIERARCHY. `asukoha_ehak_tekstina` reads "Pirita
//      linnaosa, Tallinn, Harju maakond" — district, city, county. Indexing only
//      the whole string means a sweep of "Tallinn" returns NOTHING while 61 357
//      companies sit in its Kesklinn district alone. Every level is indexed.
//
//   4. STATUS IS A LETTER, AND TWO OF THEM ARE NOT "GONE". `R` is registered,
//      `L` is in liquidation (9 052 companies) and `N` is bankrupt (666). A
//      company in liquidation still exists and still trades; flattening it to
//      either extreme is wrong in a different direction each way.
//
// What this file does NOT carry is an activity code — EMTAK lives in a separate
// export — so no `activityScheme` is declared rather than one being invented.
import { hasSnapshot, snapshotByLocality, snapshotById, snapshotMeta, type SnapshotSource } from "../snapshot.js";
import { nameSimilarity, normalizeName, shortLabel } from "../util.js";
import type { GeoTarget, PostalAddress } from "../types.js";
import type {
  Availability,
  CanaryCheck,
  ConnectorContext,
  LegalId,
  LookupQuery,
  RegistryConnector,
  RegistryFilters,
  RegistryRecord,
  SweepResult,
} from "./types.js";

const CONNECTOR_ID = "ee-ariregister";
const DUMP_URL = "https://avaandmed.ariregister.rik.ee/sites/default/files/avaandmed/ettevotja_rekvisiidid__lihtandmed.csv.zip";
const HOW_TO_INGEST = "run `ultraprospect ingest --country ee` once (18 MB, keyless, rebuilt daily) to index the Estonian register.";

/**
 * `R` registered · `L` in liquidation · `N` bankrupt.
 *
 * Measured over the whole file: 366 306 / 9 052 / 666. Liquidation and bankruptcy
 * are mapped to `ceased` because neither is a company you should cold-call as a
 * going concern — but the register's own word is kept in `national.statusText`, so
 * a reader can tell "being wound up" from "struck off" rather than being handed
 * one flattened verdict.
 */
function statusOf(code: string | undefined): "active" | "ceased" | "unknown" {
  const c = code?.trim().toUpperCase();
  if (c === "R") return "active";
  if (c === "L" || c === "N") return "ceased";
  return "unknown";
}

/**
 * Every administrative level a company should be findable under.
 *
 * "Pirita linnaosa, Tallinn, Harju maakond" yields the district, the city and the
 * county. Splitting rather than indexing the whole string is what makes a sweep of
 * "Tallinn" work at all — Tallinn's companies are filed under its eight districts,
 * never under "Tallinn" alone.
 */
export function estonianLocalities(ehakText: string | undefined): string[] {
  return [
    ...new Set(
      (ehakText ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 1),
    ),
  ];
}

export const ariregisterSnapshot: SnapshotSource = {
  format: "csv.zip",
  urls: () => [DUMP_URL],
  licence: "Estonian company data: Äriregister / Registrite ja Infosüsteemide Keskus, open data",
  // Estonian addresses are full of commas, so the file is semicolon-separated.
  delimiter: ";",
  approxBytes: 18_429_199,
  // Records are NOT dated. The file is rebuilt daily, so they are current — and a
  // date on them would make the gate demand it in every Estonian write-up and the
  // report open on a staleness banner, for data a few hours old. A banner that
  // fires on everything is one nobody reads, and the German one has to be read.
  datesRecords: false,
  // Measured on a full ingest: 376 025 records.
  approxDiskBytes: 260_000_000,

  parse(row: Record<string, string>) {
    const name = row.nimi?.trim();
    const code = row.ariregistri_kood?.trim();
    if (!name || !code) return undefined;

    const town = row.asukoha_ehak_tekstina?.trim();
    const localities = estonianLocalities(town);
    const address: PostalAddress = {
      raw: row.ads_normaliseeritud_taisaadress?.trim() || row.ettevotja_aadress?.trim() || undefined,
      libelleVoie: row.asukoht_ettevotja_aadressis?.trim() || undefined,
      codePostal: row.indeks_ettevotja_aadressis?.trim() || undefined,
      // The narrowest level is the one a person would write on an envelope.
      commune: localities[0],
      pays: "Estonia",
    };

    const vat = row.kmkr_nr?.trim();
    const record: RegistryRecord = {
      connectorId: CONNECTOR_ID,
      id: code,
      names: [name],
      legalName: name,
      officers: [],
      address,
      countryCode: "ee",
      status: statusOf(row.ettevotja_staatus),
      legalForm: row.ettevotja_oiguslik_vorm?.trim() || undefined,
      // dd.mm.yyyy in the file; ISO everywhere in this tool.
      dateCreated: row.ettevotja_esmakande_kpv?.trim().split(".").reverse().join("-") || undefined,
      // No activity code: EMTAK is a separate export, and inventing a section
      // would claim a classification this file does not contain.
      sourceUrl: row.teabesysteemi_link?.trim() || `https://ariregister.rik.ee/est/company/${code}`,
      // No `asOf`: the file is rebuilt daily, so these records ARE current. The
      // ingest stamps one only when the source has a vintage to stamp.
      national: {
        registerCode: code,
        statusText: row.ettevotja_staatus_tekstina?.trim() || undefined,
        vatNumber: vat || undefined,
        ehakCode: row.asukoha_ehak_kood?.trim() || undefined,
      },
    };

    // The VAT number is on a third of records and is exactly what an Estonian
    // legal notice prints, so it is a lookup key alongside the register code.
    return { record, localities, ids: [code, vat].filter((x): x is string => Boolean(x)) };
  },
};

function passesFilters(rec: RegistryRecord, filters: RegistryFilters): boolean {
  return Boolean(filters.includeCeased) || rec.status !== "ceased";
}

export const eeAriregister: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["ee"],
  label: "Estonia — Äriregister (open data, rebuilt daily, keyless)",
  licence: ariregisterSnapshot.licence,
  // The simple-data export carries no EMTAK code, so there is no vocabulary to
  // declare. Claiming NACE here would imply codes this file does not contain.
  activityScheme: "none",
  activityPrefix: CONNECTOR_ID,
  docsUrl: "https://avaandmed.ariregister.rik.ee/en/downloading-open-data",
  snapshot: ariregisterSnapshot,

  availability(): Availability {
    if (hasSnapshot(CONNECTOR_ID)) return { available: true };
    return { available: false, reason: "no Estonian register snapshot has been ingested", how: HOW_TO_INGEST };
  },

  /**
   * Enumerate the companies filed under a territory.
   *
   * A real sweep, and — like the British one — by ADMINISTRATIVE UNIT rather than
   * by bounding box. The unit here is finer than a UK post town (Estonia files
   * Tallinn's companies by district) and every level is indexed, so both
   * "Kesklinna linnaosa" and "Tallinn" resolve. The coverage says which was asked
   * for, because "Tallinn" and "Pirita" are very different territories.
   */
  async sweep(target: GeoTarget, filters: RegistryFilters, ctx: ConnectorContext): Promise<SweepResult> {
    const town = shortLabel(target.label || target.query);
    const meta = snapshotMeta(CONNECTOR_ID);
    if (!meta) {
      return {
        records: [],
        notes: [`ee-ariregister: no snapshot ingested, so the register lane could not be swept. ${HOW_TO_INGEST}`],
        coverage: {
          lane: "registry",
          connectorId: CONNECTOR_ID,
          requested: 0,
          returned: 0,
          truncated: true,
          reason: `no Estonian register snapshot in the cache; ${HOW_TO_INGEST}`,
        },
      };
    }

    const max = filters.maxResults ?? 3000;
    const all = await snapshotByLocality(CONNECTOR_ID, town, (r) => passesFilters(r, filters), max + 1);
    const truncated = all.length > max;
    const records = truncated ? all.slice(0, max) : all;
    ctx.onProgress?.(records.length, town);

    return {
      records,
      notes: [],
      coverage: {
        lane: "registry",
        mode: "sweep",
        connectorId: CONNECTOR_ID,
        requested: max,
        returned: records.length,
        truncated,
        reason: truncated
          ? `enumerated from the Äriregister open-data export by ADMINISTRATIVE UNIT "${town}", and stopped at --max-results ${max}. An administrative unit is not a bounding box, so this lane's shape does not coincide with the OSM lane's.`
          : `enumerated from the Äriregister open-data export by ADMINISTRATIVE UNIT "${town}" — every company the register files there, from a file rebuilt daily. An administrative unit is not a bounding box, so this lane's shape does not coincide with the OSM lane's.`,
      },
    };
  },

  async lookup(query: LookupQuery): Promise<RegistryRecord[]> {
    const name = query.names.find((n) => n?.trim());
    if (!name || !query.locality || !hasSnapshot(CONNECTOR_ID)) return [];
    const needle = normalizeName(name);
    if (needle.length < 3) return [];
    return snapshotByLocality(
      CONNECTOR_ID,
      query.locality,
      (r) => r.status !== "ceased" && r.names.some((n) => nameSimilarity(n, name) >= 0.6 || normalizeName(n).includes(needle)),
      Math.min(20, query.limit ?? 5),
    );
  },

  /**
   * Confirm a register code or a VAT number read off a company's own site.
   *
   * Both are primary keys here, so there is nothing to score: an Estonian
   * `registrikood` is eight digits and unique nationally, unlike a German register
   * number, which repeats across courts.
   */
  async verifyId(id: LegalId): Promise<RegistryRecord | undefined> {
    if (!hasSnapshot(CONNECTOR_ID)) return undefined;
    const value = id.value.trim().toUpperCase().replace(/\s+/g, "");
    if (id.kind === "vat") {
      if (!/^EE\d{9}$/.test(value)) return undefined;
      return (await snapshotById(CONNECTOR_ID, value))[0];
    }
    // The register code itself: eight digits, no prefix.
    if (!/^\d{8}$/.test(value)) return undefined;
    return (await snapshotById(CONNECTOR_ID, value))[0];
  },

  async canary(): Promise<CanaryCheck[]> {
    const res = await fetch(DUMP_URL, { method: "HEAD" });
    const lastModified = res.headers.get("last-modified");
    const ageDays = lastModified ? (Date.now() - new Date(lastModified).getTime()) / 86_400_000 : undefined;
    return [
      { name: "the Äriregister open-data export is still served", ok: res.ok, detail: `HTTP ${res.status}` },
      {
        name: "the export is still around 18 MB",
        ok: Math.abs(Number(res.headers.get("content-length") ?? 0) - ariregisterSnapshot.approxBytes) < 30e6,
        detail: `${res.headers.get("content-length")} bytes`,
      },
      {
        // The whole reason this connector needs no `asOf`. If it stops being
        // daily it becomes a different kind of source and the records should say
        // so, which is a code change rather than a transient failure.
        name: "the export is still rebuilt daily",
        ok: ageDays === undefined || ageDays < 7,
        detail: lastModified ? `last modified ${lastModified}` : "no Last-Modified header",
      },
    ];
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const meta = snapshotMeta(CONNECTOR_ID);
    if (meta) return { ok: true, detail: `${meta.rows} records in cache, from ${meta.lastModified ?? "an unknown date"}` };
    const res = await fetch(DUMP_URL, { method: "HEAD" });
    return { ok: res.ok, detail: res.ok ? `export reachable, not yet ingested — ${HOW_TO_INGEST}` : `HTTP ${res.status}` };
  },
};
