// The EU — VIES, the VAT Information Exchange System.
//
// The one authority that answers about all 27 member states with no key, no
// registration and no quota form:
//
//   GET https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{CC}/vat/{NUMBER}
//
// It is a VAT registry, not a company register: it says whether a number is a
// live intra-community VAT registration, and — for SOME member states — who
// holds it.
//
// THE "SOME" IS THE WHOLE STORY, AND IT WAS MEASURED, NOT READ:
//
//   IT 00488410010  -> name "TIM S.P.A.",  address "VIA GAETANO NEGRI 1 …"
//   NL 004495445B01 -> name and address disclosed
//   BE 0403170701   -> name "SA ELECTRABEL", address disclosed
//   DE 811193231    -> isValid true, name "---", address "---"
//   ES A28017895    -> isValid true, name "---", address "---"
//
// Germany and Spain — the two countries this connector was most wanted for — do
// NOT disclose trader details through VIES. A member state may legally answer
// "yes, that number is valid" and nothing else, and several do.
//
// So this connector's `verifyId` returns a record ONLY when the identity was
// actually disclosed. When it was not, it returns undefined and says why: the
// number is live, and the register did not name its holder. Returning a nameless
// record would let `confirm` attach an identity nobody asserted, which is the
// exact failure this tool exists to refuse. The validity itself is not thrown
// away — `confirm` records it against the place as an attested identifier.
import { awaitHostSlot, httpJson } from "../engine.js";
import { politeUa } from "../net.js";
import type { PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, ConnectorContext, LegalId, RegistryConnector, RegistryRecord } from "./types.js";

const BASE = "https://ec.europa.eu/taxation_customs/vies/rest-api";
const CONNECTOR_ID = "eu-vies";
/** A shared European service with no published quota. One request per second is not a burden on it. */
const REQUEST_DELAY_MS = 1000;

/** The 27, lowercased. Greece files VAT under EL, not GR — the API rejects GR. */
export const VIES_COUNTRIES = [
  "at",
  "be",
  "bg",
  "cy",
  "cz",
  "de",
  "dk",
  "ee",
  "es",
  "fi",
  "fr",
  "gr",
  "hr",
  "hu",
  "ie",
  "it",
  "lt",
  "lu",
  "lv",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "se",
  "si",
  "sk",
] as const;

/** VIES speaks EL for Greece. Everyone else's ISO code is the VAT prefix. */
function vatPrefix(countryCode: string): string {
  const cc = countryCode.toUpperCase();
  return cc === "GR" ? "EL" : cc;
}

/** A field VIES redacts comes back as "---", not as an empty string or null. */
function disclosed(value: unknown): string | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s || s === "---") return undefined;
  return s;
}

/**
 * VIES returns the address as one newline-joined blob, differently shaped per
 * member state, so only the parts that can be read without guessing are split
 * out. `raw` always holds what was actually returned.
 */
export function parseViesAddress(raw: string | undefined, countryCode: string): PostalAddress {
  const address: PostalAddress = { raw, pays: countryCode.toUpperCase() };
  if (!raw) return address;
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return address;
  address.libelleVoie = lines[0];
  const tail = lines.slice(1).join(" ");
  // Postcode-then-town is the common European order; the postcode itself varies
  // in length and may carry a country prefix ("L-1219").
  const m = /\b([A-Z]{0,2}-?\d{4,6})\s+(.+)$/.exec(tail);
  if (m) {
    address.codePostal = m[1];
    address.commune = m[2];
  } else if (tail) {
    address.commune = tail;
  }
  return address;
}

export interface ViesAnswer {
  valid: boolean;
  /** True when this member state disclosed the trader's name. */
  identified: boolean;
  name?: string;
  address?: PostalAddress;
  countryCode: string;
  vatNumber: string;
}

export async function checkVat(countryCode: string, number: string): Promise<ViesAnswer | undefined> {
  const cc = vatPrefix(countryCode);
  const digits = number.replace(/^[A-Z]{2}/i, "").replace(/[\s.-]/g, "");
  if (!digits) return undefined;
  const url = `${BASE}/ms/${cc}/vat/${encodeURIComponent(digits)}`;
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, undefined, { timeoutMs: 20_000, retries: 1, userAgent: politeUa() });
  if (!res.ok) return undefined;
  const name = disclosed(res.data?.name);
  const rawAddress = disclosed(res.data?.address);
  return {
    valid: res.data?.isValid === true,
    identified: Boolean(name),
    name,
    address: rawAddress ? parseViesAddress(rawAddress, cc) : undefined,
    countryCode: cc.toLowerCase(),
    vatNumber: `${cc}${digits}`,
  };
}

export const euVies: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: [...VIES_COUNTRIES],
  label: "EU — VAT registration check via VIES (identity disclosed by some member states only)",
  licence: "VAT registration status: VIES, European Commission (DG TAXUD)",
  activityScheme: "none",
  activityPrefix: "vat",
  docsUrl: "https://ec.europa.eu/taxation_customs/vies/",

  availability(): Availability {
    return { available: true };
  },

  async verifyId(id: LegalId, ctx: ConnectorContext): Promise<RegistryRecord | undefined> {
    if (id.kind !== "vat") return undefined;
    const answer = await checkVat(id.countryCode, id.value);
    if (!answer) return undefined;
    if (!answer.valid) {
      ctx.onNote?.(`vies: ${id.value} is NOT a live VAT registration`);
      return undefined;
    }
    if (!answer.identified) {
      // The number is real. Who holds it is a fact this member state does not
      // publish, and inventing one — or attaching a nameless record that later
      // code would treat as an identity — is the failure mode this refuses.
      ctx.onNote?.(
        `vies: ${answer.vatNumber} is a live VAT registration, but ${answer.countryCode.toUpperCase()} does not disclose the trader's name through VIES`,
      );
      return undefined;
    }
    return {
      connectorId: CONNECTOR_ID,
      id: answer.vatNumber,
      names: [answer.name!],
      legalName: answer.name,
      officers: [],
      address: answer.address ?? {},
      countryCode: answer.countryCode,
      status: "active",
      activityScheme: "none",
      sourceUrl: "https://ec.europa.eu/taxation_customs/vies/",
      national: { vatNumber: answer.vatNumber, viesDisclosesIdentity: true },
    };
  },

  async canary(): Promise<CanaryCheck[]> {
    const checks: CanaryCheck[] = [];

    // A member state that DOES disclose. If this stops, the connector can no
    // longer identify anyone and is only a validity check.
    const it = await checkVat("IT", "00488410010");
    checks.push({
      name: "VIES still discloses the trader name for at least one member state (IT)",
      ok: Boolean(it?.valid && it.identified),
      detail: it?.name ? `named "${it.name}"` : "no name returned — the connector can no longer confirm identity anywhere",
    });

    // A member state that does NOT. This is asserted deliberately: if Germany
    // ever starts disclosing, the Impressum -> VAT -> identity chain becomes
    // real for the largest economy in scope, and the connector should be
    // rewritten to use it.
    const de = await checkVat("DE", "811193231");
    checks.push({
      name: "VIES still REDACTS the trader name for DE",
      ok: Boolean(de?.valid && !de.identified),
      detail: de?.identified ? `DE now discloses ("${de.name}") — the German path can confirm identity through VIES` : "still '---', as measured",
    });

    const invalid = await checkVat("DE", "000000000");
    checks.push({ name: "VIES still answers isValid:false rather than an error for an unknown number", ok: invalid?.valid === false });

    return checks;
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const answer = await checkVat("IT", "00488410010");
    return { ok: Boolean(answer?.valid), detail: answer ? `isValid=${answer.valid}, identity ${answer.identified ? "disclosed" : "redacted"}` : "no answer" };
  },
};
