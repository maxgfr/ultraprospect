// The administrative pieces a bid usually needs, per jurisdiction.
//
// A REMINDER, never the rule. The notice's own list of required documents
// governs, and it is in the DCE; this exists so that the compliance matrix
// starts from the pieces that sink bids most often — an expired social-security
// certificate, a missing registration — rather than from a blank page. Every
// entry names the official text it comes from, so a reader can check it, and a
// jurisdiction with no entry here says so instead of borrowing another's.
export interface ChecklistItem {
  piece: string;
  note?: string;
}

export interface Checklist {
  jurisdiction: string;
  source: string;
  items: ChecklistItem[];
}

const EU_ESPD: ChecklistItem = {
  piece: "ESPD / DUME — European Single Procurement Document",
  note: "accepted for every above-threshold procedure in the EU (Implementing Regulation (EU) 2016/7)",
};

export const CHECKLISTS: Record<string, Checklist> = {
  fr: {
    jurisdiction: "France — Code de la commande publique",
    source: "https://www.economie.gouv.fr/daj/formulaires-declaration-du-candidat",
    items: [
      { piece: "DC1 (lettre de candidature) and DC2 (déclaration du candidat), or the DUME instead of both" },
      { piece: "Attestation de vigilance URSSAF", note: "under six months old at the time of award (art. D8222-5 Code du travail)" },
      { piece: "Attestation de régularité fiscale" },
      { piece: "Extrait Kbis or registration certificate, under three months" },
      { piece: "Acte d'engagement (ATTRI1 or the buyer's own form), signed" },
      { piece: "Price schedule as the DCE requires it: BPU, DQE or DPGF" },
      { piece: "Mémoire technique, structured on the published award criteria" },
      { piece: "Insurance certificates (RC professionnelle; décennale for works)" },
      { piece: "RIB" },
    ],
  },
  de: {
    jurisdiction: "Germany — GWB / VgV / UVgO",
    source: "https://www.gesetze-im-internet.de/vgv_2016/__48.html",
    items: [
      { piece: "Einheitliche Europäische Eigenerklärung (EEE) above thresholds, or the buyer's Eigenerklärungen" },
      { piece: "Handelsregisterauszug" },
      { piece: "Präqualifizierung (AVPQ / PQ-VOL, PQ-VOB for works) when it replaces individual evidence" },
      { piece: "Tariftreue- und Mindestlohnerklärung where the Land requires it" },
      { piece: "Referenzen as the notice specifies (number, age, value)" },
      { piece: "Angebot in the e-Vergabe platform's format, signed as required (Textform / fortgeschrittene Signatur)" },
    ],
  },
  gb: {
    jurisdiction: "United Kingdom — Procurement Act 2023",
    source: "https://www.gov.uk/government/collections/procurement-act-2023-guidance-documents",
    items: [
      { piece: "Registration and core supplier information on the Central Digital Platform" },
      { piece: "Procurement Specific Questionnaire (PSQ), or the Standard Selection Questionnaire for procurements under the 2015 Regulations" },
      { piece: "Evidence against the conditions of participation (financial standing, insurance, technical ability)" },
      { piece: "Tender response to the published award criteria and their weightings" },
    ],
  },
  us: {
    jurisdiction: "United States — Federal Acquisition Regulation",
    source: "https://www.acquisition.gov/far/subpart-4.11",
    items: [
      { piece: "Active SAM.gov entity registration with a Unique Entity ID (UEI)", note: "FAR 4.1102: registration is required at offer submission" },
      { piece: "Representations and certifications (FAR 52.204-8) in SAM" },
      { piece: "Set-aside eligibility evidence when the notice is set aside (8(a), HUBZone, SDVOSB, WOSB)" },
      { piece: "Response in the solicitation's sections L/M structure (instructions and evaluation factors)" },
    ],
  },
  ca: {
    jurisdiction: "Canada — federal procurement (PSPC)",
    source: "https://canadabuys.canada.ca/en/how-procurement-works",
    items: [
      { piece: "Supplier registration on CanadaBuys and a Procurement Business Number (PBN)" },
      { piece: "Integrity Regime declaration" },
      { piece: "Security clearance where the solicitation requires it (Contract Security Program)" },
      { piece: "Bid in the solicitation's mandatory and rated-criteria structure" },
    ],
  },
  au: {
    jurisdiction: "Australia — Commonwealth Procurement Rules",
    source: "https://www.finance.gov.au/government/procurement/commonwealth-procurement-rules",
    items: [
      { piece: "Australian Business Number (ABN)" },
      { piece: "Registration on AusTender to download documents and lodge a response" },
      { piece: "Statement of tax record when the procurement is above A$4 million (Black Economy procurement connected policy)" },
      { piece: "Response against the conditions for participation and evaluation criteria" },
    ],
  },
  br: {
    jurisdiction: "Brazil — Lei 14.133/2021, arts. 62–70 (habilitação)",
    source: "https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm",
    items: [
      { piece: "Habilitação jurídica (contrato social, CNPJ)" },
      { piece: "Regularidade fiscal, social e trabalhista (CND federal, FGTS, CNDT)" },
      { piece: "Qualificação econômico-financeira as the edital requires" },
      { piece: "Qualificação técnica (atestados de capacidade técnica)" },
      { piece: "SICAF registration for federal purchases" },
    ],
  },
};

const EU_MEMBERS = new Set([
  "at",
  "be",
  "bg",
  "hr",
  "cy",
  "cz",
  "dk",
  "ee",
  "fi",
  "fr",
  "de",
  "gr",
  "hu",
  "ie",
  "it",
  "lv",
  "lt",
  "lu",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "sk",
  "si",
  "es",
  "se",
]);

export function checklistFor(country: string, aboveThreshold: boolean): Checklist | undefined {
  const own = CHECKLISTS[country];
  if (own) {
    if (aboveThreshold && EU_MEMBERS.has(country) && !own.items.some((i) => i.piece.includes("ESPD") || i.piece.includes("DUME") || i.piece.includes("EEE"))) {
      return { ...own, items: [EU_ESPD, ...own.items] };
    }
    return own;
  }
  if (EU_MEMBERS.has(country)) {
    return {
      jurisdiction: `${country.toUpperCase()} — EU public procurement directives (2014/24/EU)`,
      source: "https://eur-lex.europa.eu/eli/reg_impl/2016/7/oj",
      items: [EU_ESPD],
    };
  }
  return undefined;
}

export function checklistMarkdown(country: string, aboveThreshold: boolean): string {
  const c = checklistFor(country, aboveThreshold);
  if (!c)
    return `No administrative checklist is shipped for ${country.toUpperCase()}. Build the list from the notice's own requirements — and say so in COMPLIANCE.md.`;
  return [
    `**${c.jurisdiction}** — source: ${c.source}`,
    "",
    ...c.items.map((i) => `- [ ] ${i.piece}${i.note ? ` — ${i.note}` : ""}`),
    "",
    "A reminder, not the rule: the notice's own list of required documents governs.",
  ].join("\n");
}
