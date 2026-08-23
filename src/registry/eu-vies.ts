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

/**
 * What VIES actually said, kept as three states rather than a boolean.
 *
 * MEASURED, and the reason this is not `valid: boolean`: VIES answers
 * `userError: "MS_UNAVAILABLE"` when the member state's own system is down, and
 * the response still carries `isValid: false`. Reading that as "the number is
 * invalid" reports somebody else's outage as a fact about a company — a wrong
 * answer that looks exactly like a right one.
 *
 *   valid        — a live intra-community VAT registration.
 *   invalid      — the member state answered, and does not know this number.
 *   inconclusive — nobody answered. Says nothing about the number either way.
 */
export type ViesVerdict = "valid" | "invalid" | "inconclusive";

/**
 * Read VIES's answer about the ANSWER rather than about the number.
 *
 * Anything that is not a clean VALID/INVALID is the network reporting on
 * itself. Exported so the rule can be pinned by a test without a live call.
 */
export function viesVerdict(data: { isValid?: unknown; userError?: unknown } | undefined): ViesVerdict {
  if (data?.isValid === true) return "valid";
  return data?.userError === "INVALID" ? "invalid" : "inconclusive";
}

export interface ViesAnswer {
  verdict: ViesVerdict;
  /** True when this member state disclosed the trader's name. */
  identified: boolean;
  name?: string;
  address?: PostalAddress;
  countryCode: string;
  vatNumber: string;
  /** VIES's own word for what happened: VALID, INVALID, MS_UNAVAILABLE, TIMEOUT… */
  userError?: string;
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
  const userError = typeof res.data?.userError === "string" ? res.data.userError : undefined;
  const verdict = viesVerdict(res.data);
  return {
    verdict,
    identified: Boolean(name),
    name,
    address: rawAddress ? parseViesAddress(rawAddress, cc) : undefined,
    countryCode: cc.toLowerCase(),
    vatNumber: `${cc}${digits}`,
    userError,
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
    if (answer.verdict === "inconclusive") {
      ctx.onNote?.(
        `vies: ${answer.vatNumber} could not be checked — ${answer.userError ?? "no answer"}. That is this member state's system, not a fact about the number.`,
      );
      return undefined;
    }
    if (answer.verdict === "invalid") {
      // NOT the same as "made up". VIES only knows numbers enabled for
      // intra-community trade; a small trader's domestic USt-IdNr is legitimate,
      // printed on its Impressum because the law requires it, and unknown here.
      ctx.onNote?.(
        `vies: ${answer.vatNumber} is not registered for intra-community trade. VIES only knows numbers enabled for intra-EU transactions, so this is not evidence that the number is wrong.`,
      );
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
      // No sourceUrl. VIES is a form: it answers a VAT number, it does not host
      // a page for one, so there is nothing to link a reader to. The check
      // itself is the provenance, and `confirm` records which authority made it.
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
      ok: it?.verdict === "valid" && it.identified,
      detail: it?.name ? `named "${it.name}"` : "no name returned — the connector can no longer confirm identity anywhere",
    });

    // A member state that does NOT. This is asserted deliberately: if Germany
    // ever starts disclosing, the Impressum -> VAT -> identity chain becomes
    // real for the largest economy in scope, and the connector should be
    // rewritten to use it.
    const de = await checkVat("DE", "811193231");
    checks.push({
      name: "VIES still REDACTS the trader name for DE",
      // A member state being down is not drift. Germany answers
      // MS_UNAVAILABLE often enough that treating it as a failure would put a
      // red canary in front of the reader most weeks, which is how a canary
      // stops being read at all.
      inconclusive: de?.verdict === "inconclusive",
      ok: de?.verdict === "valid" ? !de.identified : true,
      detail:
        de?.verdict === "inconclusive"
          ? `DE answered ${de.userError ?? "nothing"} — its own system, not a change in policy`
          : de?.identified
            ? `DE now discloses ("${de.name}") — the German path can confirm identity through VIES`
            : "still '---', as measured",
    });

    const invalid = await checkVat("DE", "000000000");
    checks.push({
      name: "VIES still distinguishes INVALID from a member state being unavailable",
      ok: invalid?.verdict === "invalid",
      detail: `userError=${invalid?.userError ?? "none"} — an MS_UNAVAILABLE read as "invalid" reports somebody else's outage as a fact about a company`,
      inconclusive: invalid?.verdict === "inconclusive",
    });

    return checks;
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const answer = await checkVat("IT", "00488410010");
    return { ok: answer?.verdict === "valid", detail: answer ? `${answer.verdict}, identity ${answer.identified ? "disclosed" : "redacted"}` : "no answer" };
  },
};
