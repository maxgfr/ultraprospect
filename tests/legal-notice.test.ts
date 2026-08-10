// Reading a legal identity off a company's own website.
//
// The strings here are taken from real legal-notice pages, formatting quirks
// included, because the quirks ARE the problem: sites write "DE 811 907 980" as
// often as "DE811907980", and a pattern that tolerates arbitrary separators also
// matches across sentence boundaries and turns two unrelated numbers into one.
import { describe, expect, it } from "vitest";
import { extractHandelsregister, extractLegalIds, extractSpanishNif, extractUkCompanyNumber, extractVatNumbers, legalIdCoverage } from "../src/legal-notice.js";

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

describe("extractLegalIds", () => {
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
