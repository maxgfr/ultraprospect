// Reading a company's legal identity off its own website.
//
// This is the answer to a problem that has no API: outside France, no public
// company register can be swept, and most cannot even be searched without a key.
// But most of Europe LEGALLY REQUIRES a company to publish its registration on
// its own site, and that page is already in the run — `enrich --tier 1` fetches
// the legal notice on every site it reaches.
//
//   Germany   § 5 DDG (formerly § 5 TMG): the Impressum must carry the
//             Handelsregister number, the registry court, and the USt-IdNr.
//   Spain     Ley 34/2002 (LSSI) art. 10: the aviso legal must carry the NIF/CIF
//             and the Registro Mercantil entry.
//   France    mentions légales: SIREN/SIRET and the RCS entry.
//   UK        Companies Act 2006 / SI 2008/495: the company number and
//             registered office on the website.
//   EU-wide   an intra-community VAT number, which VIES will confirm keylessly
//             and answer with the registered name and address.
//
// So the chain is: fetch the page the law requires -> read the identifier the
// law requires -> ask the authority whether it is real and whose it is. Every
// step is evidence someone can re-read, which is the only kind this tool keeps.
//
// THE UNITED STATES HAS NO EQUIVALENT. There is no federal register, no
// published company number, and an EIN is a tax secret. A US run therefore gets
// no legal identifier from this module, and that is reported rather than
// papered over — see `legalIdCoverage`.
import type { LegalId } from "./registry/types.js";

/** Countries whose law puts a re-checkable company identifier on the company's own website. */
export const LEGAL_NOTICE_COUNTRIES = ["fr", "de", "es", "gb", "it", "nl", "be", "at", "pt", "pl", "ie", "lu", "cz", "dk", "fi", "se", "no"] as const;

/**
 * The EU VAT number formats, by member state.
 *
 * Kept as a table rather than one permissive regex because the lengths differ
 * and a loose pattern matches phone numbers, order references and dates. The
 * body patterns are the official ones; VIES rejects anything else anyway, but a
 * bad candidate costs a request and a wrong answer costs a wrong company.
 */
const VAT_PATTERNS: Record<string, RegExp> = {
  at: /ATU\d{8}/i,
  be: /BE0\d{9}/i,
  bg: /BG\d{9,10}/i,
  cy: /CY\d{8}[A-Z]/i,
  cz: /CZ\d{8,10}/i,
  de: /DE\d{9}/i,
  dk: /DK\d{8}/i,
  ee: /EE\d{9}/i,
  el: /EL\d{9}/i,
  es: /ES[A-Z0-9]\d{7}[A-Z0-9]/i,
  fi: /FI\d{8}/i,
  fr: /FR[0-9A-Z]{2}\d{9}/i,
  hr: /HR\d{11}/i,
  hu: /HU\d{8}/i,
  ie: /IE\d[A-Z0-9+*]\d{5}[A-Z]{1,2}/i,
  it: /IT\d{11}/i,
  lt: /LT(?:\d{9}|\d{12})/i,
  lu: /LU\d{8}/i,
  lv: /LV\d{11}/i,
  mt: /MT\d{8}/i,
  nl: /NL\d{9}B\d{2}/i,
  pl: /PL\d{10}/i,
  pt: /PT\d{9}/i,
  ro: /RO\d{2,10}/i,
  se: /SE\d{12}/i,
  si: /SI\d{8}/i,
  sk: /SK\d{10}/i,
};

/**
 * A VAT number found anywhere in the text, for any member state.
 *
 * Separators are stripped before matching, because sites write "DE 811 907 980"
 * as often as "DE811907980". That alone produced a whole class of false
 * positives, found on the first real Berlin run: "Tel 030 440 244" compacts to
 * "Tel030440244", and `EL\d{9}` reads the "el" of "Tel" as Greece's VAT prefix.
 * A print shop in Prenzlauer Berg acquired two Greek VAT numbers, both of them
 * its own phone number.
 *
 * So the compaction keeps a map back to the original offsets, and a match is
 * accepted only when its prefix was not preceded by a letter in the ORIGINAL
 * text. That is the boundary compaction destroys, and the one that matters.
 */
export function extractVatNumbers(text: string): Array<{ countryCode: string; value: string }> {
  const out: Array<{ countryCode: string; value: string }> = [];
  const seen = new Set<string>();

  let compact = "";
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "." || ch === "-") continue;
    compact += ch;
    origin.push(i);
  }

  for (const [cc, re] of Object.entries(VAT_PATTERNS)) {
    for (const m of compact.matchAll(new RegExp(re.source, "gi"))) {
      const before = text[(origin[m.index ?? 0] ?? 0) - 1];
      if (before && /[A-Za-z]/.test(before)) continue;
      // A VAT prefix is written in capitals. Matching is case-insensitive and
      // runs on text with its spaces removed, so ordinary words did duty as
      // prefixes: "El teléfono es 912 345 678" compacts to "…es912345678" and
      // was read as the Spanish number ES912345678, "en el 912345678" as a
      // Greek one. The same trap as "Tel", through a lowercase word.
      if (!/^[A-Z]{2}/.test(m[0])) continue;
      const value = m[0].toUpperCase();
      if (seen.has(value)) continue;
      seen.add(value);
      out.push({ countryCode: cc, value });
    }
  }
  return out;
}

/**
 * A German Handelsregister entry: the court and the number.
 *
 * "HRB 12345" alone is NOT unique — every Amtsgericht numbers its own register
 * from 1, so there are dozens of HRB 12345s in Germany. The court is part of the
 * identifier, and a record that lost it would point at the wrong company with
 * complete confidence. When the court cannot be read, the entry is still
 * returned but marked, so a caller can decline to treat it as conclusive.
 */
export function extractHandelsregister(text: string): { value: string; court?: string } | undefined {
  const m = /\bHR([AB])\s*[:\s]?\s*(\d{1,7})\b/i.exec(text);
  if (!m) return undefined;
  const value = `HR${m[1]!.toUpperCase()} ${m[2]}`;
  // The court is usually within a line or so of the number, either before
  // ("Amtsgericht München, HRB 12345") or after ("HRB 12345, Amtsgericht Berlin").
  const around = text.slice(Math.max(0, m.index - 120), m.index + 160);
  // Two negative lookaheads, both earned by a failing case:
  //   (?!HR[AB]) — "Handelsregister HRA 4711" otherwise captures "HRA" as the
  //     court, which is the register's own name, not a place.
  //   (?!Amtsgericht…) — "Registergericht: Amtsgericht München" otherwise
  //     captures "Amtsgericht München", because the word after the first
  //     keyword is the second keyword.
  const court =
    /\b(?:Amtsgerichts?|Registergerichts?)\s*:?\s*(?!HR[AB]\b)(?!Amtsgericht|Registergericht)([A-ZÄÖÜ][\wÄÖÜäöüß.]*(?:[- ][A-ZÄÖÜ][\wÄÖÜäöüß.]*)?)/.exec(
      around,
    );
  return { value, court: court?.[1]?.trim() };
}

/** A UK company number: eight digits, or two letters and six digits for the devolved registers. */
export function extractUkCompanyNumber(text: string): string | undefined {
  // The separator class is punctuation and space ONLY. `\D` was tried and ate
  // the two-letter prefix: "Company Registration Number: SC123456" came back as
  // "123456", a Scottish company reported under an English number.
  const m =
    /\b(?:compan(?:y|ies)\s+(?:reg(?:istration|istered)?\.?\s*)?(?:no\.?|number)|registered\s+in\s+England[^.]{0,40}?no\.?)[\s:.–—-]{0,10}((?:[A-Z]{2})?\d{6,8})\b/i.exec(
      text,
    );
  return m?.[1]?.toUpperCase();
}

/** A French SIREN/SIRET, from the words that introduce it. */
export function extractSirenSiret(text: string): { kind: "siren" | "siret"; value: string } | undefined {
  const siret = /\b(?:SIRET)\D{0,12}(\d[\d\s.]{12,17}\d)\b/i.exec(text);
  if (siret) return { kind: "siret", value: siret[1]!.replace(/\D/g, "") };
  const siren = /\b(?:SIREN|RCS[^\d]{0,30})\D{0,6}(\d[\d\s.]{7,12}\d)\b/i.exec(text);
  if (siren) return { kind: "siren", value: siren[1]!.replace(/\D/g, "") };
  return undefined;
}

/**
 * Is this a well-formed Norwegian organisasjonsnummer — exactly nine digits
 * whose last is the mod-11 check digit over the first eight?
 *
 * Weights 3 2 7 6 5 4 3 2; a remainder of 0 gives check digit 0, a remainder
 * of 1 has no valid check digit (Brønnøysund never issues such a number), and
 * anything else gives 11 − remainder. A transposed or mistyped digit fails it,
 * which matters because a nine-digit number that is merely WRONG is very often
 * somebody else's live registration.
 */
export function isNorwegianOrgNumber(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  const remainder = sum % 11;
  if (remainder === 1) return false;
  const check = remainder === 0 ? 0 : 11 - remainder;
  return check === Number(digits[8]);
}

/**
 * Every Norwegian organisation number a page publishes.
 *
 * Norwegian sites print it as "Org.nr. 923 609 016", "Org. nr: 923609016",
 * "Organisasjonsnummer 923 609 016" or "Foretaksregisteret NO 923 609 016 MVA",
 * and the VAT form on its own as "NO 923 609 016 MVA" (MVA is the VAT
 * register). All of them carry the same nine digits, so one number is
 * returned once whichever forms it appears in — `confirm` asks one question per
 * number, not per spelling.
 *
 * Only numbers that pass the mod-11 check are returned. Nine digits after
 * "Org.nr" that fail it are a typo or something else entirely, and asking the
 * register about them can only produce a stranger.
 */
export function extractNorwegianOrgNumbers(text: string): Array<{ kind: "orgnr" | "vat"; value: string }> {
  const out: Array<{ kind: "orgnr" | "vat"; value: string; digits: string }> = [];
  // Three groups of three, a space or a no-break space between them, and not
  // the first nine digits of a longer number.
  const nine = String.raw`(\d{3}[ \u00a0]?\d{3}[ \u00a0]?\d{3})(?!\d)`;
  const keyword = new RegExp(
    String.raw`\b(?:Org(?:anisasjons)?\.?\s*nr\.?|Organisasjonsnummer|Foretaksregisteret)[\s:.,\u2013\u2014-]{0,6}(?:NO[ \u00a0]?)?${nine}`,
    "gi",
  );
  // "NO" in capitals only: matched case-insensitively it would be the English
  // word in "no 123 456 789", which is an order or phone number.
  const vat = new RegExp(String.raw`(?<![A-Za-z])NO[ \u00a0]?${nine}[ \u00a0]?[Mm][Vv][Aa]\b`, "g");
  const add = (kind: "orgnr" | "vat", raw: string) => {
    const digits = raw.replace(/\D/g, "");
    if (!isNorwegianOrgNumber(digits) || out.some((o) => o.digits === digits)) return;
    out.push({ kind, value: kind === "vat" ? `NO${digits}MVA` : digits, digits });
  };
  // Keyword forms first: one that is also followed by MVA is reported as the
  // organisation number, which is what the page called it, and the bare VAT
  // form only when no keyword form already carried the same digits.
  for (const m of text.matchAll(keyword)) add("orgnr", m[1]!);
  for (const m of text.matchAll(vat)) add("vat", m[1]!);
  return out.map(({ kind, value }) => ({ kind, value }));
}

/** A Spanish CIF/NIF, from the words that introduce it. Distinct from the VAT form, which prefixes ES. */
export function extractSpanishNif(text: string): string | undefined {
  // Spanish pages write it "CIF", "C.I.F." and "N.I.F." about equally often.
  const m = /\b(?:C\.?I\.?F\.?|N\.?I\.?F\.?)\s*[:.]?\s*([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])\b/i.exec(text);
  return m?.[1]?.toUpperCase();
}

/**
 * Every legal identifier a page carries, strongest first.
 *
 * `countryCode` is the run's country, used to decide which national patterns are
 * worth trying — but VAT numbers are matched for EVERY member state regardless,
 * because a German company's site legitimately carries an Austrian subsidiary's
 * number and the one that matters is the one whose country matches the record.
 */
export function extractLegalIds(text: string, countryCode: string | undefined, pageId?: string): LegalId[] {
  const cc = countryCode?.toLowerCase();
  const out: LegalId[] = [];
  const push = (id: LegalId) => {
    if (!out.some((x) => x.kind === id.kind && x.value === id.value)) out.push(id);
  };

  // National register numbers first: they identify the company in the register
  // this tool would query, whereas a VAT number identifies a taxpayer.
  if (cc === "fr" || !cc) {
    const fr = extractSirenSiret(text);
    if (fr) push({ kind: fr.kind, value: fr.value, countryCode: "fr", from: pageId });
  }
  if (cc === "de" || !cc) {
    const de = extractHandelsregister(text);
    if (de) push({ kind: "hrb", value: de.value, countryCode: "de", from: pageId, context: de.court });
  }
  if (cc === "gb") {
    const gb = extractUkCompanyNumber(text);
    if (gb) push({ kind: "company-number", value: gb, countryCode: "gb", from: pageId });
  }
  if (cc === "es" || !cc) {
    const es = extractSpanishNif(text);
    if (es) push({ kind: "nif", value: es, countryCode: "es", from: pageId });
  }
  // Norway is in LEGAL_NOTICE_COUNTRIES, so the coverage note told every
  // Norwegian run that sites must publish a registration number — and with no
  // pattern to read one, each run then reported that not one site had. Both
  // kinds are ones no-brreg's `verifyId` answers; Norway is not in VIES, so
  // the "vat" form goes to the Norwegian register and nowhere else.
  if (cc === "no" || !cc) {
    for (const no of extractNorwegianOrgNumbers(text)) push({ kind: no.kind, value: no.value, countryCode: "no", from: pageId });
  }

  for (const vat of extractVatNumbers(text)) {
    // A VAT prefix is not always the country's ISO code, and `LegalId.countryCode`
    // is the ISO code — it is what decides which authority is asked. Greece files
    // VAT under EL and is `gr` everywhere else; carried through as "el", a Greek
    // number matched no connector's country list and was never sent to VIES.
    push({ kind: "vat", value: vat.value, countryCode: vat.countryCode === "el" ? "gr" : vat.countryCode, from: pageId });
  }
  return out;
}

/**
 * Backwards-compatible single answer, for the `Signals.legalIdOnSite` field.
 *
 * One string, because that field is a corroboration hint rather than a record:
 * `resolve` uses it to say "this site published a registration number", and the
 * full list goes to `confirm`.
 */
export function extractLegalId(text: string, countryCode?: string): string | undefined {
  return extractLegalIds(text, countryCode)[0]?.value;
}

/**
 * What a legal-notice page is CALLED, in the language of the territory.
 *
 * Used as a search angle rather than as a path guess (`enrich` has the paths).
 * It earns its place because a small company's own site often ranks below every
 * directory for its bare name, and "«Name» Impressum" is the query that pulls
 * the company's own domain to the top — the page only its own site has.
 */
export function legalNoticeTerms(countryCode: string | undefined): string[] {
  switch ((countryCode ?? "").toLowerCase()) {
    case "de":
    case "at":
    case "ch":
      return ["Impressum"];
    case "es":
      return ["aviso legal"];
    case "fr":
      return ["mentions légales"];
    case "it":
      return ["note legali"];
    case "nl":
      return ["colofon"];
    case "pt":
      return ["aviso legal"];
    case "pl":
      return ["polityka prywatności"];
    case "gb":
    case "ie":
    case "us":
      return ["legal notice"];
    default:
      return [];
  }
}

/**
 * Whether this country's law puts a checkable identifier on company websites.
 *
 * `confirm` prints this. A US run that found no legal identifiers has not
 * failed to look — there was nothing to look for, and saying so is the
 * difference between "we could not confirm these companies" and "there is no
 * public identifier to confirm them against".
 */
export function legalIdCoverage(countryCode: string | undefined): { expected: boolean; note: string } {
  const cc = countryCode?.toLowerCase();
  if (cc && (LEGAL_NOTICE_COUNTRIES as readonly string[]).includes(cc)) {
    return { expected: true, note: `${cc}: company websites are legally required to publish a registration number` };
  }
  if (cc === "us") {
    return {
      expected: false,
      note: "us: there is no federal company register and no published company number — an EIN is never disclosed. Identity here rests on address and name, not on a registration.",
    };
  }
  return { expected: false, note: `${cc ?? "this country"}: no legal-notice obligation is modelled, so no registration number is expected on company sites` };
}
