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

  for (const vat of extractVatNumbers(text)) {
    push({ kind: "vat", value: vat.value, countryCode: vat.countryCode, from: pageId });
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
