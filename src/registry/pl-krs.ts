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
import { naceSection } from "../classification/nace.js";
import { politeUa } from "../net.js";
import type { PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, ConnectorContext, LegalId, RegistryConnector, RegistryRecord } from "./types.js";
import { registerAnswer } from "./upstream.js";

const BASE = "https://api-krs.ms.gov.pl/api/krs";
const CONNECTOR_ID = "pl-krs";
const REQUEST_DELAY_MS = 500;

/**
 * A struck-off company a canary can ask about: Kredyt Bank S.A., merged away
 * in 2013. Its full extract ends on "WYKREŚLENIE Z KRAJOWEGO REJESTRU SĄDOWEGO".
 */
const STRUCK_OFF_KRS = "0000019597";

/**
 * The current extract of one number in one register, status included.
 *
 * The STATUS is half of the answer here, which is why this does not return the
 * body alone. MEASURED on 2026-11-10 against the live API:
 *
 *   200, `naglowekA.stanPozycji: 1`   a current entry        (0000041581)
 *   204, no body at all               an entity struck off   (0000019597,
 *                                      0000021828, 0000006107)
 *   404                               no such number in this register
 *
 * So `OdpisAktualny` never describes a struck-off company: it has no current
 * extract to give. The state code that says so in words, `stanPozycji: 2`, is
 * only ever served by `OdpisPelny`, the full extract.
 */
async function currentExtract(krs: string, rejestr: "P" | "S"): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  const url = `${BASE}/OdpisAktualny/${krs}?rejestr=${rejestr}&format=json`;
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  return httpJson("GET", url, undefined, { timeoutMs: 25_000, retries: 1, userAgent: politeUa() });
}

/** For the canary and the probe: any failure is "no answer", which is what they report. */
async function get(krs: string, rejestr: "P" | "S"): Promise<any> {
  const res = await currentExtract(krs, rejestr);
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
    // The SECTION LETTER, like every other NACE connector. This used to hand
    // back the division's two digits ("62"), which no `--section J` filter and
    // no section label could ever match.
    section: activityCode ? naceSection(activityCode) : undefined,
    activityScheme: "nace",
    legalForm: dzial1?.danePodmiotu?.formaPrawna ?? undefined,
    // `stanPozycji` is a STATE CODE, not a presence flag: 1 on a current entry,
    // 2 on one struck off the register (both measured, the second on the full
    // extract of Kredyt Bank S.A., whose last entry is its deletion). Reading
    // "any value" as active would file a struck-off company as trading the day
    // this endpoint starts serving one. Any other code says "unknown".
    status: odpis?.naglowekA?.stanPozycji === 1 ? "active" : odpis?.naglowekA?.stanPozycji === 2 ? "ceased" : "unknown",
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

  async verifyId(id: LegalId, ctx: ConnectorContext): Promise<RegistryRecord | undefined> {
    // A KRS number is ten digits, usually written with its leading zeros.
    if (id.kind !== "krs" && id.kind !== "company-number") return undefined;
    const digits = id.value.replace(/\D/g, "");
    if (!digits || digits.length > 10) return undefined;
    const krs = digits.padStart(10, "0");
    for (const rejestr of ["P", "S"] as const) {
      const res = await currentExtract(krs, rejestr);
      // Thrown on anything that is not an answer, so `confirm` records that KRS
      // could not be asked instead of reading an outage as a number it does not
      // hold. The 404 of the wrong register IS an answer. See `./upstream.ts`.
      const payload = registerAnswer(CONNECTOR_ID, res);
      if (res.status === 204) {
        // The number is real and its entity is gone. There is no body to build
        // a record from, so nothing is attached — but saying nothing would
        // leave "the register holds no such number", which is not what it said.
        ctx.onNote?.(
          `pl-krs: KRS ${krs} has no current extract (HTTP 204) — the register has struck this entity off. Its history is in the full extract: ${BASE}/OdpisPelny/${krs}?rejestr=${rejestr}&format=json`,
        );
        return undefined;
      }
      const rec = toRecord(payload);
      if (rec) return rec;
    }
    return undefined;
  },

  async canary(): Promise<CanaryCheck[]> {
    const payload = await get("0000041581", "P");
    const rec = toRecord(payload);
    const struckOff = await currentExtract(STRUCK_OFF_KRS, "P");
    return [
      { name: "KRS still answers OdpisAktualny with odpis.naglowekA.numerKRS", ok: Boolean(payload?.odpis?.naglowekA?.numerKRS) },
      { name: "KRS still nests the name under dane.dzial1.danePodmiotu.nazwa", ok: Boolean(rec?.legalName) },
      { name: "KRS still returns siedzibaIAdres with a postal address", ok: Boolean(rec?.address.codePostal) },
      {
        name: "KRS still marks a current entry with stanPozycji 1",
        ok: payload?.odpis?.naglowekA?.stanPozycji === 1,
        detail: `stanPozycji = ${String(payload?.odpis?.naglowekA?.stanPozycji ?? "absent")} — the only code this connector reads as active`,
      },
      {
        name: "KRS still answers 204, with no body, for an entity it has struck off",
        ok: struckOff.status === 204,
        // The upstream being down is not drift.
        inconclusive: struckOff.status === 0 || struckOff.status >= 500,
        detail: `HTTP ${struckOff.status} for ${STRUCK_OFF_KRS} — if a body now comes back, its stanPozycji is what says ceased`,
      },
    ];
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const rec = toRecord(await get("0000041581", "P"));
    return { ok: Boolean(rec), detail: rec ? `resolved ${rec.legalName?.slice(0, 40)}` : "no answer" };
  },
};
