// Poland — KRS, the National Court Register, keyless.
//
// It answers only one question: given a KRS number, who is that? There is no
// name search and no address search in the public API, so this connector
// declares `verifyId` and nothing else. That is not a degraded lookup — it is
// the whole of what the register exposes, and a connector that pretended
// otherwise would have to invent the search.
//
// Two registers share the numbering space and the API needs to be told which:
//   rejestr=P  przedsiębiorcy — entrepreneurs. What a prospect list wants.
//   rejestr=S  stowarzyszenia — associations and foundations.
// A number is tried against P first, then S, because a KRS number is unique
// across both and the wrong one simply answers 404.
//
// It publishes more than most: the company's email and website come back in
// `siedzibaIAdres`, which is unusual for a court register.
import { awaitHostSlot, httpJson } from "../engine.js";
import { politeUa } from "../net.js";
import type { PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, LegalId, RegistryConnector, RegistryRecord } from "./types.js";

const BASE = "https://api-krs.ms.gov.pl/api/krs";
const CONNECTOR_ID = "pl-krs";
const REQUEST_DELAY_MS = 500;

async function get(krs: string, rejestr: "P" | "S"): Promise<any> {
  const url = `${BASE}/OdpisAktualny/${krs}?rejestr=${rejestr}&format=json`;
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, undefined, { timeoutMs: 25_000, retries: 1, userAgent: politeUa() });
  return res.ok ? res.data : undefined;
}

function addressOf(raw: any): PostalAddress {
  const adres = raw?.adres;
  if (!adres) return {};
  return {
    raw: [adres?.ulica, adres?.nrDomu, adres?.kodPocztowy, adres?.miejscowosc].filter(Boolean).join(" ") || undefined,
    libelleVoie: adres?.ulica ?? undefined,
    numero: adres?.nrDomu ?? undefined,
    codePostal: adres?.kodPocztowy ?? undefined,
    commune: adres?.miejscowosc ?? undefined,
    pays: adres?.kraj ?? "POLSKA",
  };
}

export function toRecord(payload: any): RegistryRecord | undefined {
  const odpis = payload?.odpis;
  const krs = odpis?.naglowekA?.numerKRS;
  if (!krs) return undefined;
  const dzial1 = odpis?.dane?.dzial1;
  const name = dzial1?.danePodmiotu?.nazwa;
  if (!name) return undefined;
  const siedziba = dzial1?.siedzibaIAdres;
  const pkd = dzial1?.przedmiotDzialalnosci?.przedmiotPrzewazajacejDzialalnosci?.[0];
  // PKD is Polish NACE: "62.01.Z" — the leading two digits are the NACE division.
  const activityCode = pkd ? [pkd?.dzial, pkd?.grupa, pkd?.podklasa].filter(Boolean).join(".") || undefined : undefined;
  return {
    connectorId: CONNECTOR_ID,
    id: String(krs),
    names: [name],
    legalName: name,
    officers: [],
    address: addressOf(siedziba),
    countryCode: "pl",
    activityCode,
    section: activityCode ? activityCode.slice(0, 2).replace(/\D/g, "") : undefined,
    activityScheme: "nace",
    legalForm: dzial1?.danePodmiotu?.formaPrawna ?? undefined,
    status: odpis?.naglowekA?.stanPozycji != null ? "active" : "unknown",
    sourceUrl: `https://wyszukiwarka-krs.ms.gov.pl/podmiot/${krs}`,
    national: {
      krs: String(krs),
      nip: dzial1?.danePodmiotu?.identyfikatory?.nip ?? undefined,
      regon: dzial1?.danePodmiotu?.identyfikatory?.regon ?? undefined,
      // A court register that publishes contact details is unusual, and these
      // are open data — but they are still contact details, so they travel as
      // register facts and are subject to `--no-people` like everything else.
      email: siedziba?.adresPocztyElektronicznej ?? undefined,
      website: siedziba?.adresStronyInternetowej ?? undefined,
    },
  };
}

export const plKrs: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["pl"],
  label: "Poland — KRS (National Court Register). Lookup by KRS number only; the public API has no name search.",
  licence: "Polish company data: Krajowy Rejestr Sądowy, Ministerstwo Sprawiedliwości, open data",
  activityScheme: "nace",
  activityPrefix: "pkd",
  docsUrl: "https://api-krs.ms.gov.pl/",

  availability(): Availability {
    return { available: true };
  },

  async verifyId(id: LegalId): Promise<RegistryRecord | undefined> {
    // A KRS number is ten digits, usually written with its leading zeros.
    if (id.kind !== "krs" && id.kind !== "company-number") return undefined;
    const digits = id.value.replace(/\D/g, "");
    if (!digits || digits.length > 10) return undefined;
    const krs = digits.padStart(10, "0");
    return toRecord(await get(krs, "P")) ?? toRecord(await get(krs, "S"));
  },

  async canary(): Promise<CanaryCheck[]> {
    const payload = await get("0000041581", "P");
    const rec = toRecord(payload);
    return [
      { name: "KRS still answers OdpisAktualny with odpis.naglowekA.numerKRS", ok: Boolean(payload?.odpis?.naglowekA?.numerKRS) },
      { name: "KRS still nests the name under dane.dzial1.danePodmiotu.nazwa", ok: Boolean(rec?.legalName) },
      { name: "KRS still returns siedzibaIAdres with a postal address", ok: Boolean(rec?.address.codePostal) },
    ];
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const rec = toRecord(await get("0000041581", "P"));
    return { ok: Boolean(rec), detail: rec ? `resolved ${rec.legalName?.slice(0, 40)}` : "no answer" };
  },
};
