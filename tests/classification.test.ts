// Activity vocabularies, and the one rule that keeps them apart.
//
// NACE and US SIC both label their top level A, B, C… and they disagree about
// what those letters mean. NACE "D" is electricity and gas; US SIC "D" is all of
// manufacturing. A section that travelled without its scheme would let a filter
// return a different economy on either side of the Atlantic and look completely
// normal doing it.
import { describe, expect, it } from "vitest";
import { NACE_SECTIONS, naceSection, partitionSections, splitCategory, US_SIC_SECTIONS, usSicDivision, vocabularyOf } from "../src/classification/index.js";

describe("naceSection", () => {
  it("reads the division out of any national spelling of a NACE code", () => {
    // The whole reason `--section J,M` means one thing across Europe: NAF adds a
    // letter, WZ adds a digit, CNAE and UK SIC renumber the 4th level, and all
    // four agree on the two digits that decide the section.
    expect(naceSection("62.01Z")).toBe("J"); // NAF, France
    expect(naceSection("62.01-0")).toBe("J"); // WZ, Germany
    expect(naceSection("6201")).toBe("J"); // CNAE, Spain
    expect(naceSection("62012")).toBe("J"); // SIC 2007, United Kingdom
    expect(naceSection("06.100")).toBe("B"); // Brreg, Norway
  });

  it("says nothing rather than guessing for a code it cannot read", () => {
    expect(naceSection("nope")).toBeUndefined();
    expect(naceSection("")).toBeUndefined();
    // Division 04 exists in no NACE section.
    expect(naceSection("04.10Z")).toBeUndefined();
  });

  it("covers the whole 21-letter alphabet", () => {
    expect(NACE_SECTIONS).toHaveLength(21);
    expect(NACE_SECTIONS[0]).toBe("A");
    expect(NACE_SECTIONS.at(-1)).toBe("U");
  });
});

describe("usSicDivision", () => {
  it("uses the same letters as NACE for entirely different industries", () => {
    // This is the collision the scheme field exists to prevent.
    expect(usSicDivision("3571")).toBe("D"); // Electronic computers -> Manufacturing
    expect(naceSection("35.71")).toBe("D"); // …and NACE D is electricity and gas.
    expect(vocabularyOf("us-sic").label("D")).toContain("Manufacturing");
    expect(vocabularyOf("nace").label("D")).toContain("Electricity");
  });

  it("pads a short SIC code rather than misreading it", () => {
    expect(usSicDivision("100")).toBe("A"); // 0100, agriculture
    expect(US_SIC_SECTIONS).toContain("K");
  });
});

describe("vocabularyOf", () => {
  it("answers `none` for a scheme it does not know, instead of throwing", () => {
    expect(vocabularyOf(undefined).scheme).toBe("none");
    expect(vocabularyOf("none").sections).toEqual([]);
    // An unlabelled section comes back as itself, never as a confident guess.
    expect(vocabularyOf("none").label("Z")).toBe("Z");
  });

  it("names its own top level, so an error message can use the right word", () => {
    expect(vocabularyOf("nace").sectionTerm).toContain("NACE");
    expect(vocabularyOf("us-sic").sectionTerm).toContain("SIC");
  });
});

describe("partitionSections", () => {
  it("keeps the valid letters and reports the rest instead of failing on the first", () => {
    // Someone who typed `--section J,Zz,M` should be told about Zz and still
    // get J and M.
    const { valid, unknown } = partitionSections(["J", "Zz", "m"], vocabularyOf("nace"));
    expect(valid).toEqual(["J", "M"]);
    expect(unknown).toEqual(["Zz"]);
  });

  it("rejects a NACE letter aimed at a scheme that has no sections", () => {
    // Better an explicit "this means nothing here" than an empty result set the
    // user reads as "there are no such companies".
    const { valid, unknown } = partitionSections(["J"], vocabularyOf("none"));
    expect(valid).toEqual([]);
    expect(unknown).toEqual(["J"]);
  });

  it("ignores empty entries from a trailing comma", () => {
    expect(partitionSections(["J", "", "  "], vocabularyOf("nace")).valid).toEqual(["J"]);
  });
});

describe("splitCategory", () => {
  it("reads a namespaced category back into its parts", () => {
    expect(splitCategory("naf=62.01Z")).toEqual({ prefix: "naf", code: "62.01Z" });
    expect(splitCategory("shop=bakery")).toEqual({ prefix: "shop", code: "bakery" });
    expect(splitCategory("sic=62012")).toEqual({ prefix: "sic", code: "62012" });
  });

  it("does not invent a namespace for an unprefixed string", () => {
    expect(splitCategory("bakery")).toEqual({ code: "bakery" });
    expect(splitCategory(undefined)).toEqual({});
  });
});
