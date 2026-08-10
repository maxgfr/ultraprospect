// Norway — Brønnøysundregistrene (the Enhetsregisteret), keyless and complete.
//
// The best register in this tool after France's, and in two respects better:
// it publishes an EXACT headcount (`antallAnsatte`) rather than a band, and it
// publishes the company's own WEBSITE (`hjemmeside`) — which is the field
// `resolve` otherwise has to go and prove from a search engine.
//
// What it cannot do is enumerate a territory the way France can. It searches by
// name and by municipality, not by radius or bounding box, so it confirms
// companies OSM already found rather than sweeping the ground itself.
//
// Activity codes are NACE with a Norwegian 5-digit tail: "06.100" is NACE
// division 06. The section resolves through the shared NACE table.
import { awaitHostSlot, httpJson } from "../engine.js";
import { naceSection } from "../classification/nace.js";
import { politeUa } from "../net.js";
import type { PostalAddress } from "../types.js";
import type { Availability, CanaryCheck, LegalId, LookupQuery, RegistryConnector, RegistryRecord } from "./types.js";

const BASE = "https://data.brreg.no/enhetsregisteret/api";
const CONNECTOR_ID = "no-brreg";
const REQUEST_DELAY_MS = 300;

async function get(path: string): Promise<any> {
  const url = `${BASE}${path}`;
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, undefined, { timeoutMs: 20_000, retries: 1, userAgent: politeUa() });
  return res.ok ? res.data : undefined;
}

function addressOf(raw: any): PostalAddress {
  const lines: string[] = (raw?.adresse ?? []).filter(Boolean);
  return {
    raw: [lines.join(", "), raw?.postnummer, raw?.poststed].filter(Boolean).join(" ") || undefined,
    libelleVoie: lines[0],
    codePostal: raw?.postnummer ?? undefined,
    commune: raw?.poststed ?? undefined,
    // Not an INSEE code, but the same kind of thing: the state's own code for
    // the municipality, and the only precise locality key Norway publishes.
    codeCommune: raw?.kommunenummer ?? undefined,
    pays: raw?.land ?? "Norge",
  };
}

export function toRecord(unit: any): RegistryRecord | undefined {
  const id = unit?.organisasjonsnummer;
  if (!id) return undefined;
  const name = unit?.navn;
  // Historic names are kept for MATCHING only: a shopfront often still carries
  // the name the company traded under five years ago, and Brreg is one of the
  // few registers that publishes the trail. They are not trading names, so they
  // do not go in `tradingNames`.
  const historic: string[] = (unit?.historiskeNavn ?? []).map((h: any) => h?.navn).filter(Boolean);
  const activityCode = unit?.naeringskode1?.kode ?? undefined;
  // `postadresse` is often a PO box; the business address is what a prospector
  // can visit and what OSM mapped.
  const address = addressOf(unit?.beliggenhetsadresse ?? unit?.postadresse);
  return {
    connectorId: CONNECTOR_ID,
    id: String(id),
    names: [name, ...historic].filter(Boolean),
    legalName: name,
    officers: [],
    address,
    countryCode: "no",
    activityCode,
    section: activityCode ? naceSection(activityCode) : undefined,
    activityScheme: "nace",
    employees: unit?.harRegistrertAntallAnsatte ? (unit?.antallAnsatte ?? undefined) : undefined,
    legalForm: unit?.organisasjonsform?.beskrivelse ?? unit?.organisasjonsform?.kode ?? undefined,
    dateCreated: unit?.registreringsdatoEnhetsregisteret ?? undefined,
    // `slettedato` is set when the unit has been struck off. Absent means live.
    status: unit?.slettedato ? "ceased" : unit?.konkurs === true ? "ceased" : "active",
    dateClosed: unit?.slettedato ?? undefined,
    sourceUrl: `https://virksomhet.brreg.no/nb/oppslag/enheter/${id}`,
    national: {
      // Brreg publishes the company's own website. Nothing else in this tool
      // gets that from a register, and `resolve` treats it as a declared claim
      // to be corroborated like any other, not as a fact.
      hjemmeside: unit?.hjemmeside ?? undefined,
      naeringskoder: [unit?.naeringskode1, unit?.naeringskode2, unit?.naeringskode3].filter(Boolean),
      registrertIMvaregisteret: unit?.registrertIMvaregisteret ?? undefined,
    },
  };
}

export const noBrreg: RegistryConnector = {
  id: CONNECTOR_ID,
  countries: ["no"],
  label: "Norway — Enhetsregisteret via data.brreg.no",
  licence: "Norwegian company data: Enhetsregisteret, Brønnøysundregistrene, NLOD 2.0",
  activityScheme: "nace",
  activityPrefix: "nace-no",
  docsUrl: "https://data.brreg.no/enhetsregisteret/api/dokumentasjon/",

  availability(): Availability {
    return { available: true };
  },

  async lookup(query: LookupQuery): Promise<RegistryRecord[]> {
    const name = query.names.find((n) => n?.trim());
    if (!name) return [];
    const params = new URLSearchParams({ navn: name, size: String(Math.min(20, query.limit ?? 5)) });
    if (query.postcode) params.set("postadresse.postnummer", query.postcode);
    const data = await get(`/enheter?${params.toString()}`);
    return (data?._embedded?.enheter ?? []).map(toRecord).filter((r: RegistryRecord | undefined): r is RegistryRecord => Boolean(r));
  },

  async verifyId(id: LegalId): Promise<RegistryRecord | undefined> {
    // The organisasjonsnummer is nine digits, and it is also the body of the
    // Norwegian VAT number ("NO 923 609 016 MVA").
    const digits = id.value.replace(/\D/g, "");
    const orgnr = digits.length >= 9 ? digits.slice(0, 9) : undefined;
    if (!orgnr) return undefined;
    if (id.kind !== "vat" && id.kind !== "orgnr" && id.kind !== "company-number") return undefined;
    return toRecord(await get(`/enheter/${orgnr}`));
  },

  async canary(): Promise<CanaryCheck[]> {
    const data = await get("/enheter?navn=Equinor&size=1");
    const unit = data?._embedded?.enheter?.[0];
    const rec = toRecord(unit);
    return [
      { name: "Brreg still answers a name search with _embedded.enheter", ok: Boolean(unit?.organisasjonsnummer) },
      {
        name: "Brreg still publishes an EXACT headcount (antallAnsatte)",
        ok: typeof unit?.antallAnsatte === "number",
        detail: "the only register here that gives a number rather than a band",
      },
      {
        name: "Brreg still publishes the company's own website (hjemmeside)",
        ok: typeof unit?.hjemmeside === "string" && unit.hjemmeside.length > 0,
        detail: "if this goes, Norwegian websites have to be found by search like everywhere else",
      },
      { name: "Brreg naeringskode1 still resolves to a NACE section", ok: Boolean(rec?.section) },
    ];
  },

  async probe(): Promise<{ ok: boolean; detail: string }> {
    const data = await get("/enheter/923609016");
    return { ok: Boolean(data?.organisasjonsnummer), detail: data?.navn ? `resolved ${data.navn}` : "no answer" };
  },
};
