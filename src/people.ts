// Who is named on a company's own pages, and what they do there.
//
// Prospecting is people. A row saying a company exists and hires is a lead you
// cannot open; a row saying who runs it, what they are called and where that
// was read is one you can. `contacts.people` has carried a type, a gate in
// check.ts and a line in REPORT.md since the beginning — and nothing ever wrote
// to it, so every run reported zero.
//
// THE DISCIPLINE IS IN THE ANCHOR, NOT IN THE PAGE LIST.
//
// The obvious way to find people is to look for capitalised word pairs, and it
// is hopeless: every street, product, city and heading on a German page is a
// capitalised word pair. So nothing is extracted from a name. A ROLE LABEL has
// to be adjacent — "Geschäftsführer", "Gérant", "Head of Engineering" — and the
// name is only what sits beside it.
//
// That is what lets this read EVERY page the run fetched rather than a
// whitelist of page roles. The `--terms-on` default learnt the opposite lesson
// the expensive way: widening the pages produced 48 hits and every sampled one
// was wrong. Here the page does not have to be trusted, because the label
// carries the meaning.
//
// The traps are measured, not imagined. All three of these were on real Hamburg
// pages, each one a role label followed by something that is not a person:
//
//     Geschäftsführer • AFFILITIX Services GmbH      a company
//     Geschäftsführer – dreamIT                      a brand
//     Geschäftsführer an Bord, wodurch neben Handel   prose
//
// So the refusals below are the substance of this file, and `check` re-reads
// every name against the page it was taken from regardless.
import type { PersonRecord } from "./types.js";

/** What one page can contribute, so a staff directory cannot flood a run. */
const PER_PAGE = 12;

/**
 * Role labels that mark the person beside them, by country.
 *
 * Keyed like `legalNoticeTerms` in legal-notice.ts, and for the same reason: a
 * word list frozen into a general tool has to say which market it is for.
 * Longest first within each list, so "Managing Director" wins over "Director".
 */
const ROLES: Record<string, string[]> = {
  de: [
    "Vertreten durch",
    "Geschäftsführerin",
    "Geschäftsführer",
    "Geschäftsleitung",
    "Vorstandsvorsitzender",
    "Vorstand",
    "Inhaberin",
    "Inhaber",
    "Prokuristin",
    "Prokurist",
    "Gründerin",
    "Gründer",
    "Verantwortlich für den Inhalt",
    "Ansprechpartnerin",
    "Ansprechpartner",
    "Leiterin",
    "Leiter",
  ],
  fr: [
    "Représentée par",
    "Directrice générale",
    "Directeur général",
    "Gérante",
    "Gérant",
    "Présidente",
    "Président",
    "Fondatrice",
    "Fondateur",
    "Responsable de la publication",
    "Responsable",
  ],
  es: ["Administradora", "Administrador", "Directora general", "Director general", "Gerente", "Fundadora", "Fundador", "Responsable"],
  it: ["Amministratore delegato", "Amministratore", "Direttore", "Titolare", "Fondatore"],
  nl: ["Vertegenwoordigd door", "Bestuurder", "Zaakvoerder", "Directeur", "Oprichter"],
  pt: ["Administrador", "Diretor", "Gerente", "Fundador"],
  pl: ["Prezes zarządu", "Prezes", "Dyrektor", "Właściciel"],
  cs: ["Jednatel", "Ředitel", "Majitel"],
  da: ["Direktør", "Indehaver", "Stifter"],
  sv: ["Verkställande direktör", "Grundare", "Ägare"],
  fi: ["Toimitusjohtaja", "Perustaja", "Omistaja"],
  no: ["Daglig leder", "Gründer", "Eier"],
};

/**
 * Titles that travel, whatever the site's language.
 *
 * A German SME writes "CEO" and "Head of Sales" on its own team page. A
 * vocabulary keyed only on the country's language misses every one of them,
 * which on a technology sweep is most of the people worth finding.
 */
const NEUTRAL_ROLES = [
  "Chief Executive Officer",
  "Chief Technology Officer",
  "Chief Operating Officer",
  "Chief Financial Officer",
  "Managing Director",
  // "Head of X" is how a team page names the person who runs a function, in
  // English, on sites in every language. The label is kept at "Head of" — what
  // follows is the department, and inventing a canonical department name from
  // it would be a taxonomy this tool does not have.
  "Head of",
  "Co-Founder",
  "Cofounder",
  "Founder",
  "Owner",
  "Partner",
  "CEO",
  "CTO",
  "COO",
  "CFO",
  "CMO",
];

/** Country to the language whose labels its sites are written in. */
const LANGUAGE_OF: Record<string, string> = {
  de: "de",
  at: "de",
  ch: "de",
  li: "de",
  fr: "fr",
  be: "fr",
  lu: "fr",
  mc: "fr",
  es: "es",
  it: "it",
  nl: "nl",
  pt: "pt",
  pl: "pl",
  cz: "cs",
  dk: "da",
  se: "sv",
  fi: "fi",
  no: "no",
};

function rolesFor(countryCode: string | undefined): string[] {
  const lang = LANGUAGE_OF[(countryCode ?? "").toLowerCase()];
  const local = lang ? (ROLES[lang] ?? []) : [];
  // Longest first so "Managing Director" is matched before "Director", and
  // "Geschäftsführerin" before "Geschäftsführer".
  return [...local, ...NEUTRAL_ROLES].sort((a, b) => b.length - a.length);
}

/**
 * Legal forms, worldwide.
 *
 * The single most productive refusal: a role label is very often followed by
 * the entity somebody directs rather than by their name.
 */
const LEGAL_FORM =
  /\b(gmbh|mbh|ug|ag|kg|ohg|gbr|kgaa|e\.?\s?k|e\.?\s?v|ltd|limited|llc|inc|corp|plc|llp|sas|sasu|sarl|sa|sci|eurl|bv|nv|cv|oy|oyj|ab|as|asa|aps|a\/s|spa|srl|snc|sl|slu|sp\.?\s?z\.?\s?o\.?\s?o|s\.?r\.?o|a\.?s|d\.?o\.?o|oü|as|zrt|kft)\b/i;

/** Page furniture that is capitalised and is not anybody. */
const FURNITURE = new Set(
  [
    "impressum",
    "kontakt",
    "datenschutz",
    "datenschutzerklärung",
    "team",
    "karriere",
    "jobs",
    "home",
    "startseite",
    "unternehmen",
    "leistungen",
    "mentions",
    "légales",
    "contact",
    "accueil",
    "équipe",
    "aviso",
    "legal",
    "privacy",
    "imprint",
    "about",
    "careers",
    "services",
    "products",
    "news",
    "blog",
    "cookie",
    "cookies",
    "sitemap",
    "newsletter",
    "telefon",
    "telephone",
    "email",
    "e-mail",
    "fax",
    "adresse",
    "address",
    "straße",
    "strasse",
    "street",
    "postfach",
    "geschäftsführer",
    "vorstand",
    "inhaber",
    "gérant",
    "director",
    "manager",
    "lead",
    "bord",
    "handel",
  ].map((s) => s.toLowerCase()),
);

/** Lowercase particles a real surname may carry. */
const PARTICLES = new Set(["von", "van", "de", "der", "den", "del", "della", "di", "da", "dos", "du", "la", "le", "el", "bin", "ter", "ten", "af", "zu"]);

const LETTERS = "A-Za-zÀ-ÖØ-öø-ÿŁłŚśŻżŹźĆćŃńĄąĘęÖöÄäÜüßÅåØøÆæÇç";
const TOKEN = new RegExp(`^[${LETTERS}][${LETTERS}'’.-]*$`);

/**
 * Business nouns that form capitalised pairs and are nobody.
 *
 * Measured: "Partner • Corporate Planning Cloud" and "CTO Public Sector" both
 * sat beside a real role label on a real page. They read exactly like a name
 * and are a product and a department. Any of these in a token disqualifies the
 * whole string — a surname lost to this list costs one contact, and a
 * department shipped as a person costs the reader's trust in every other row.
 */
const BUSINESS_NOUN = new Set([
  "cloud",
  "sector",
  "public",
  "corporate",
  "planning",
  "digital",
  "solutions",
  "solution",
  "systems",
  "system",
  "group",
  "consulting",
  "media",
  "software",
  "technology",
  "technologies",
  "marketing",
  "sales",
  "finance",
  "support",
  "service",
  "services",
  "development",
  "management",
  "operations",
  "product",
  "products",
  "design",
  "data",
  "security",
  "engineering",
  "international",
  "global",
  "partner",
  "partners",
  "office",
  "agency",
  "studio",
  "labs",
  "ventures",
]);

/**
 * Anchor text a page wraps a name in, stripped before the name is judged.
 *
 * "Gründer: LinkedIn-Profil von Martin Hammer" was observed verbatim. Rejecting
 * the whole string loses a real person; keeping it ships a contact called
 * "LinkedIn". An explicit, short list of prefixes is the honest middle: it
 * recovers the name only where the wrapper is one this file already knows.
 */
const LINK_PREFIX = /^(?:\S*-?(?:Profil|Profile)\s+(?:von|of|de)\s+|(?:LinkedIn|Xing|Twitter|Facebook|Instagram|GitHub|Mastodon)\s*[:–-]?\s*)/i;

/** Trim the punctuation and the link furniture a page wraps a name in. */
function cleanName(raw: string): string {
  return raw
    .trim()
    .replace(LINK_PREFIX, "")
    .replace(/[.,;:•·|–—-]+$/, "")
    .trim();
}

/**
 * Is this string a person's name?
 *
 * Every rule here removed something a real page produced. A false contact is
 * worse than no contact: it is plausible, it is unfalsifiable at a glance, and
 * somebody will email it.
 */
function isName(raw: string, opts: { companyName?: string; town?: string }): boolean {
  const s = cleanName(raw);
  if (!s || s.length < 4 || s.length > 70) return false;
  if (/[0-9@/\\]/.test(s)) return false;
  if (LEGAL_FORM.test(s)) return false;

  const tokens = s.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;

  // A run of capitals is a heading, not a name: "IMPRESSUM KONTAKT".
  if (tokens.every((t) => t === t.toUpperCase() && t.length > 1)) return false;

  for (const t of tokens) {
    if (!TOKEN.test(t)) return false;
    const lower = t.toLowerCase();
    if (FURNITURE.has(lower) || BUSINESS_NOUN.has(lower)) return false;
    // Every token starts uppercase, except the particles a surname may carry.
    if (!PARTICLES.has(lower) && t[0] !== t[0]!.toUpperCase()) return false;
  }

  // The town the run is in is not a person, and neither is the company.
  const norm = (x: string) =>
    x
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  if (opts.town && norm(s).includes(norm(opts.town))) return false;
  if (opts.companyName) {
    const company = new Set(
      norm(opts.companyName)
        .split(" ")
        .filter((w) => w.length > 2 && !LEGAL_FORM.test(w)),
    );
    const overlap = tokens.filter((t) => company.has(norm(t))).length;
    if (overlap >= Math.min(2, company.size) && company.size > 0) return false;
  }
  return true;
}

export interface FoundPerson {
  value: string;
  role: string;
}

export interface PeopleOptions {
  /** Decides which language's role labels apply. */
  countryCode?: string;
  /** The company, so it is never returned as its own director. */
  companyName?: string;
  /** The run's territory, so a district is never returned as a person. */
  town?: string;
}

/**
 * Every person a page names, with the role that identified them.
 *
 * Two shapes, because legal notices and team pages are written differently:
 *
 *   LABEL: Name[, Name, Name]    the Impressum form
 *   Name \n LABEL                the team-card form
 */
export function extractPeople(text: string, opts: PeopleOptions = {}): FoundPerson[] {
  const roles = rolesFor(opts.countryCode);
  const found: FoundPerson[] = [];
  const seen = new Set<string>();

  const add = (value: string, role: string) => {
    const clean = cleanName(value);
    const key = clean.toLowerCase();
    if (seen.has(key) || found.length >= PER_PAGE) return;
    seen.add(key);
    found.push({ value: clean, role });
  };

  for (const role of roles) {
    const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // LABEL: Name, Name — the separator is a colon or a dash, NEVER nothing.
    // Requiring a separator is what refuses "Geschäftsführer an Bord, wodurch",
    // where the label runs straight into prose.
    for (const m of text.matchAll(new RegExp(`${escaped}\\s*[:：]\\s*([^\\n]{3,120})`, "gi"))) {
      for (const candidate of m[1]!.split(/\s*(?:,|;|\bund\b|\band\b|&|\bet\b|\by\b)\s*/i)) {
        if (isName(candidate, opts)) add(candidate, role);
      }
    }

    // Name \n LABEL — a team card. The name is the line above, and it has to be
    // a whole line: a name buried in a sentence is a mention, not a card.
    for (const m of text.matchAll(new RegExp(`(^|\\n)\\s*([^\\n]{4,70})\\s*\\n\\s*[^\\n]{0,20}${escaped}`, "gi"))) {
      if (isName(m[2]!, opts)) add(m[2]!, role);
    }
  }
  return found;
}

/** The same, shaped for the run and carrying the page it was read from. */
export function peopleFrom(text: string, pageId: string, opts: PeopleOptions = {}): PersonRecord[] {
  return extractPeople(text, opts).map((p) => ({ value: p.value, role: p.role, from: pageId, lane: "web" as const }));
}
