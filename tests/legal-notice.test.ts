// Reading a legal identity off a company's own website.
//
// The strings here are taken from real legal-notice pages, formatting quirks
// included, because the quirks ARE the problem: sites write "DE 811 907 980" as
// often as "DE811907980", and a pattern that tolerates arbitrary separators also
// matches across sentence boundaries and turns two unrelated numbers into one.
import { describe, expect, it } from "vitest";
import {
  extractHandelsregister,
  extractNorwegianOrgNumbers,
  extractLegalIds,
  extractSpanishNif,
  extractUkCompanyNumber,
  extractVatNumbers,
  isNorwegianOrgNumber,
  legalIdCoverage,
} from "../src/legal-notice.js";

describe("extractVatNumbers", () => {
  it("reads a VAT number however the page spaced it", () => {
    for (const written of ["DE811907980", "DE 811 907 980", "USt-IdNr.: DE 811.907.980"]) {
      expect(extractVatNumbers(written), written).toContainEqual({ countryCode: "de", value: "DE811907980" });
    }
  });

  it("honours each member state's own length", () => {
    // One permissive pattern would match a phone number. These are the official
    // shapes: 9 digits for DE, 11 for FR (two check characters first), 11 for IT.
    expect(extractVatNumbers("FR44306184100")).toContainEqual({ countryCode: "fr", value: "FR44306184100" });
    expect(extractVatNumbers("IT00488410010")).toContainEqual({ countryCode: "it", value: "IT00488410010" });
    expect(extractVatNumbers("NL004495445B01")).toContainEqual({ countryCode: "nl", value: "NL004495445B01" });
  });

  it("does not read a phone number as a Greek VAT number", () => {
    // Found on the first real Berlin run. Stripping separators turns
    // "Tel 030 440 244" into "Tel030440244", where `EL\d{9}` matches the "el"
    // of "Tel": a Prenzlauer Berg print shop acquired two Greek VAT numbers,
    // both of them its own phone number.
    expect(extractVatNumbers("Solid Earth GmbH, Tel 030 440 244, Fax 030 440 377")).toEqual([]);
    // …without losing a real Greek one, whose prefix is not glued to a word.
    expect(extractVatNumbers("ΑΦΜ EL030440244")).toContainEqual({ countryCode: "el", value: "EL030440244" });
  });

  it("files a Greek VAT number under Greece's ISO code, which is what picks the authority", () => {
    // The PREFIX is EL; the country is gr. `extractVatNumbers` reports the
    // prefix it read, `extractLegalIds` the country a connector is keyed on.
    expect(extractLegalIds("ΑΦΜ EL030440244", "gr", "P1")).toContainEqual({ kind: "vat", value: "EL030440244", countryCode: "gr", from: "P1" });
  });

  it("does not read an ordinary lowercase word as a VAT prefix", () => {
    expect(extractVatNumbers("El teléfono es 912 345 678")).toEqual([]);
    expect(extractVatNumbers("Llámenos en el 912345678")).toEqual([]);
    expect(extractVatNumbers("Rufen Sie uns an, es 912 345 678 ist kostenlos")).toEqual([]);
    // The real thing, in capitals, still reads.
    expect(extractVatNumbers("NIF-IVA: ES B12345678")).toContainEqual({ countryCode: "es", value: "ESB12345678" });
    expect(extractVatNumbers("USt-IdNr. DE 811 907 980")).toContainEqual({ countryCode: "de", value: "DE811907980" });
  });

  it("reads a prefix written apart from its digits", () => {
    expect(extractVatNumbers("USt-ID: DE - 811907980")).toContainEqual({ countryCode: "de", value: "DE811907980" });
    expect(extractVatNumbers("USt-IdNr.\nDE\n811907980")).toContainEqual({ countryCode: "de", value: "DE811907980" });
    // …without letting the digits that follow the number run into it.
    expect(extractVatNumbers("CZ - 12345678 724 123 456").map((v) => v.value)).toEqual(["CZ12345678"]);
  });

  it("does not read a number glued to a word as a VAT number", () => {
    expect(extractVatNumbers("ordersDE123456789 shipped")).toEqual([]);
  });

  it("does not run a variable-length number on into the phone number after it", () => {
    // Separators are removed before matching, so "CZ12345678 724 123 456"
    // compacts to "CZ12345678724123456", and `CZ\d{8,10}` took two digits of
    // the phone number with it: CZ1234567872, which is nobody's.
    for (const written of ["DIČ: CZ12345678 Tel. 724 123 456", "DIČ: CZ12345678 724 123 456", "DIČ: CZ12345678\n724 123 456"]) {
      expect(extractVatNumbers(written), written).toEqual([{ countryCode: "cz", value: "CZ12345678" }]);
    }
    expect(extractVatNumbers("ДДС BG123456789 0888 123 456")).toEqual([{ countryCode: "bg", value: "BG123456789" }]);
    // RO is 2 to 10 digits, so "021 123" fits whole; the " - " between them is
    // what says it is a second thing.
    expect(extractVatNumbers("CUI RO1234 - 021 123")).toEqual([{ countryCode: "ro", value: "RO1234" }]);
    // And nine digits taken from the front of a longer run are not a German number.
    expect(extractVatNumbers("DE811907980123")).toEqual([]);
  });

  it("reads Lithuania's twelve-digit form whole, not its first nine digits", () => {
    // `LT(?:\d{9}|\d{12})` stops at the first branch that fits.
    expect(extractVatNumbers("PVM LT100001919017")).toEqual([{ countryCode: "lt", value: "LT100001919017" }]);
    expect(extractVatNumbers("PVM LT123456715")).toEqual([{ countryCode: "lt", value: "LT123456715" }]);
  });

  it("finds a foreign subsidiary's number alongside the local one", () => {
    // A German group's Impressum legitimately carries an Austrian number. Which
    // one matters is decided later, by the country of the record.
    const found = extractVatNumbers("USt-IdNr. DE811907980 — Zweigniederlassung ATU12345678");
    expect(found.map((v) => v.countryCode).sort()).toEqual(["at", "de"]);
  });
});

describe("extractHandelsregister", () => {
  it("keeps the registry court, because the number alone is not unique", () => {
    // Every Amtsgericht numbers its own register from 1, so there are dozens of
    // HRB 12345s in Germany. A record that lost the court would point at the
    // wrong company with complete confidence.
    expect(extractHandelsregister("Registergericht: Amtsgericht München, HRB 12345")).toEqual({ value: "HRB 12345", court: "München" });
    expect(extractHandelsregister("HRB 158855, Amtsgericht Berlin-Charlottenburg")).toEqual({ value: "HRB 158855", court: "Berlin-Charlottenburg" });
  });

  it("still returns the number when no court could be read, so the caller can decide", () => {
    const found = extractHandelsregister("Handelsregister HRA 4711");
    expect(found?.value).toBe("HRA 4711");
    expect(found?.court).toBeUndefined();
  });

  it("finds nothing in a page with no register entry", () => {
    expect(extractHandelsregister("Impressum — Max Mustermann, Berlin")).toBeUndefined();
  });
});

describe("extractUkCompanyNumber", () => {
  it("reads the number from the wording UK sites are required to use", () => {
    expect(extractUkCompanyNumber("Registered in England and Wales, company no. 01234567")).toBe("01234567");
    expect(extractUkCompanyNumber("Company Registration Number: SC123456")).toBe("SC123456");
  });

  it("does not read a bare eight-digit number as a company number", () => {
    // Without the introducing words this matches VAT numbers, order references
    // and dates.
    expect(extractUkCompanyNumber("Call us on 020 7946 0958 — reference 01234567")).toBeUndefined();
  });
});

describe("extractSpanishNif", () => {
  it("reads a CIF from an aviso legal", () => {
    expect(extractSpanishNif("CIF: A28017895")).toBe("A28017895");
    expect(extractSpanishNif("N.I.F. 12345678Z")).toBe("12345678Z");
  });
});

describe("isNorwegianOrgNumber", () => {
  it("accepts real organisation numbers", () => {
    // Equinor ASA and DNB Bank ASA, as Brønnøysund files them.
    expect(isNorwegianOrgNumber("923609016")).toBe(true);
    expect(isNorwegianOrgNumber("984851006")).toBe(true);
  });

  it("refuses a wrong check digit, a wrong length, and a remainder of 1", () => {
    expect(isNorwegianOrgNumber("923609017")).toBe(false);
    expect(isNorwegianOrgNumber("9236090161")).toBe(false);
    expect(isNorwegianOrgNumber("92360901")).toBe(false);
    // 4·3 = 12, remainder 1: no check digit makes this a valid number.
    for (let d = 0; d <= 9; d++) expect(isNorwegianOrgNumber(`40000000${d}`)).toBe(false);
  });
});

describe("extractNorwegianOrgNumbers", () => {
  it("reads every way a Norwegian site writes the organisation number", () => {
    for (const written of [
      "Org.nr. 923 609 016",
      "Org. nr.: 923609016",
      "Org nr 923 609 016",
      "Orgnr: 923609016",
      "Organisasjonsnummer: 923 609 016",
      "Organisasjonsnr. 923 609 016",
      "Foretaksregisteret NO 923 609 016 MVA",
      "Equinor ASA · Org.nr. 923 609 016",
    ]) {
      expect(extractNorwegianOrgNumbers(written), written).toEqual([{ kind: "orgnr", value: "923609016" }]);
    }
  });

  it("reads the VAT form on its own, and reports one number once whatever forms it takes", () => {
    expect(extractNorwegianOrgNumbers("Equinor ASA, NO 923 609 016 MVA")).toEqual([{ kind: "vat", value: "NO923609016MVA" }]);
    expect(extractNorwegianOrgNumbers("Org.nr. 923 609 016 · MVA: NO 923 609 016 MVA")).toEqual([{ kind: "orgnr", value: "923609016" }]);
  });

  it("refuses nine digits that fail the mod-11 check, and the start of a longer number", () => {
    // Equinor's number with its check digit changed is nobody's.
    expect(extractNorwegianOrgNumbers("Org.nr. 923 609 017")).toEqual([]);
    expect(extractNorwegianOrgNumbers("Org.nr. 9236090161")).toEqual([]);
    // A phone number without the words that introduce an organisation number.
    expect(extractNorwegianOrgNumbers("Telefon 923 609 016")).toEqual([]);
  });

  it("goes past an invalid number to a valid one on the same page", () => {
    expect(extractNorwegianOrgNumbers("Org.nr. 123 456 789. Morselskap: org.nr. 984 851 006")).toEqual([{ kind: "orgnr", value: "984851006" }]);
  });
});

describe("extractLegalIds", () => {
  it("reads a Norwegian organisation number on a Norwegian run, filed under Norway", () => {
    // LEGAL_NOTICE_COUNTRIES has always said Norwegian sites must publish one,
    // and with no pattern to read it every Norwegian run then reported that not
    // one site had.
    expect(legalIdCoverage("no").expected).toBe(true);
    expect(extractLegalIds("Equinor ASA, Forusbeen 50, 4035 Stavanger. Org.nr. 923 609 016", "no", "P2")).toEqual([
      { kind: "orgnr", value: "923609016", countryCode: "no", from: "P2" },
    ]);
    expect(extractLegalIds("NO 923 609 016 MVA", "no")).toEqual([{ kind: "vat", value: "NO923609016MVA", countryCode: "no", from: undefined }]);
    // Not tried on another country's run, like every national pattern.
    expect(extractLegalIds("Org.nr. 923 609 016", "de")).toEqual([]);
  });

  it("puts the national register number before the VAT number", () => {
    // The register number identifies the company in the register this tool
    // would query; a VAT number identifies a taxpayer.
    const impressum = "Zalando SE, Amtsgericht Charlottenburg, HRB 158855 B, USt-IdNr. DE260543043";
    const ids = extractLegalIds(impressum, "de", "P4");
    expect(ids[0]!.kind).toBe("hrb");
    expect(ids.map((i) => i.kind)).toContain("vat");
    expect(ids[0]!.from).toBe("P4");
  });

  it("only tries a country's national pattern when the run is in that country", () => {
    // A UK company number pattern loose enough to fire on a German page would
    // turn an Impressum's postcode into a company number.
    const uk = "Registered in England, company no. 01234567";
    expect(extractLegalIds(uk, "gb").some((i) => i.kind === "company-number")).toBe(true);
    expect(extractLegalIds(uk, "de").some((i) => i.kind === "company-number")).toBe(false);
  });

  it("returns nothing for a page with no identifier at all", () => {
    expect(extractLegalIds("About us — we make bread.", "de")).toEqual([]);
  });
});

describe("legalIdCoverage", () => {
  it("says a country's law requires a published identifier", () => {
    for (const cc of ["de", "es", "fr", "gb"]) {
      expect(legalIdCoverage(cc).expected, cc).toBe(true);
    }
  });

  it("says plainly that the United States has no equivalent", () => {
    // The distinction that keeps a US run honest: "we could not confirm these"
    // and "there is no public identifier to confirm them against" are different
    // findings, and only one of them is a shortcoming of this tool.
    const us = legalIdCoverage("us");
    expect(us.expected).toBe(false);
    expect(us.note).toContain("no federal company register");
  });
});
