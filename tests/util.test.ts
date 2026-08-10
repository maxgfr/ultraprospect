import { describe, expect, it } from "vitest";
import {
  bboxAround,
  bboxQuadrants,
  clampInt,
  csvField,
  csvRow,
  firstText,
  foldAccents,
  haversineM,
  isNameContained,
  jaccard,
  nameSimilarity,
  nameVariants,
  normalizeName,
  parseBbox,
  parseDistanceM,
  tokenSet,
  uniqueBy,
} from "../src/util.js";

describe("haversineM", () => {
  it("measures a known distance", () => {
    // Paris Notre-Dame to the Eiffel Tower is about 4.2 km.
    expect(haversineM(48.853, 2.3499, 48.8584, 2.2945)).toBeGreaterThan(3900);
    expect(haversineM(48.853, 2.3499, 48.8584, 2.2945)).toBeLessThan(4400);
  });

  it("is zero for a point against itself", () => {
    expect(haversineM(48.85, 2.35, 48.85, 2.35)).toBe(0);
  });
});

describe("normalizeName", () => {
  it("folds accents and case", () => {
    expect(normalizeName("Boulangerie Rêve")).toBe(normalizeName("BOULANGERIE REVE"));
  });

  it("drops legal forms, which carry no identity", () => {
    expect(normalizeName("Dupont SARL")).toBe("dupont");
    expect(normalizeName("SAS Dupont")).toBe("dupont");
  });

  it("returns empty for a name that is only boilerplate", () => {
    // The matcher must treat this as "no signal", never as a match: two
    // companies called only "SARL" are not the same company.
    expect(normalizeName("SARL")).toBe("");
  });
});

describe("nameVariants", () => {
  it("splits the register's parenthesised trade names", () => {
    // Measured shape: the register packs alternates into nomComplet, and
    // comparing the whole string drags every similarity measure down.
    expect(nameVariants("CREDIT LYONNAIS (LCL)")).toEqual(["CREDIT LYONNAIS (LCL)", "CREDIT LYONNAIS", "LCL"]);
  });

  it("splits several alternates in one group", () => {
    expect(nameVariants("TRICOTAGE DES VOSGES (BLEU FORET, OLYMPIA)")).toContain("BLEU FORET");
    expect(nameVariants("TRICOTAGE DES VOSGES (BLEU FORET, OLYMPIA)")).toContain("OLYMPIA");
  });

  it("leaves a plain name alone", () => {
    expect(nameVariants("NATURALIA FRANCE")).toEqual(["NATURALIA FRANCE"]);
  });
});

describe("isNameContained", () => {
  it("accepts a multi-token subset", () => {
    expect(isNameContained("creche burgeat", "creche jean burgeat")).toBe(true);
  });

  it("accepts a single distinctive token", () => {
    expect(isNameContained("marionnaud", "marionnaud lafayette")).toBe(true);
  });

  it("REFUSES a single generic trade word", () => {
    // Without this guard every nursery in a town merges with every other one.
    expect(isNameContained("creche", "creche jean burgeat")).toBe(false);
    expect(isNameContained("pharmacie", "pharmacie du centre")).toBe(false);
  });

  it("refuses a single short token", () => {
    expect(isNameContained("bio", "bio market")).toBe(false);
  });

  it("refuses a partial overlap that is not a subset", () => {
    expect(isNameContained("cafe de paris", "cafe de lyon")).toBe(false);
  });
});

describe("nameSimilarity", () => {
  it("is 1 for the same name written differently", () => {
    expect(nameSimilarity("Naturalia", "NATURALIA")).toBe(1);
  });

  it("scores a shopfront against its register entry high enough to merge", () => {
    // These three were measured in a real Vincennes run sitting in the
    // undecided band at ~0.5, when all three are certain matches.
    expect(nameSimilarity("Marionnaud", "MARIONNAUD LAFAYETTE")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("Crèche Jean Burgeat", "CRECHE BURGEAT")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("LCL", "CREDIT LYONNAIS (LCL)")).toBe(1);
  });

  it("stays low for unrelated names at the same address", () => {
    expect(nameSimilarity("Crèche Jean Burgeat", "COMMUNE DE VINCENNES")).toBeLessThan(0.25);
    expect(nameSimilarity("Le Bistrot", "SOCIETE GENERALE")).toBeLessThan(0.25);
  });

  it("is 0 when either side is only a legal form", () => {
    expect(nameSimilarity("SARL", "Dupont")).toBe(0);
  });
});

describe("jaccard and tokenSet", () => {
  it("ignores one-character tokens", () => {
    expect(tokenSet("a bb ccc")).toEqual(new Set(["bb", "ccc"]));
  });

  it("is 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("is 0 when either side is empty", () => {
    expect(jaccard(new Set(), new Set(["b"]))).toBe(0);
  });
});

describe("bbox helpers", () => {
  it("quarters a box into four covering parts", () => {
    const quads = bboxQuadrants([0, 2, 0, 2]);
    expect(quads).toHaveLength(4);
    expect(quads).toContainEqual([0, 1, 0, 1]);
    expect(quads).toContainEqual([1, 2, 1, 2]);
  });

  it("builds a box around a point that contains it", () => {
    const [s, n, w, e] = bboxAround(48.85, 2.35, 1000);
    expect(s).toBeLessThan(48.85);
    expect(n).toBeGreaterThan(48.85);
    expect(w).toBeLessThan(2.35);
    expect(e).toBeGreaterThan(2.35);
  });

  it("parses south,west,north,east into [s,n,w,e]", () => {
    expect(parseBbox("48.81,2.22,48.90,2.47")).toEqual([48.81, 48.9, 2.22, 2.47]);
  });

  it("rejects an inverted box rather than silently swapping it", () => {
    expect(parseBbox("48.90,2.22,48.81,2.47")).toBeUndefined();
    expect(parseBbox("nope")).toBeUndefined();
  });
});

describe("parseDistanceM", () => {
  it("treats a bare number as metres", () => {
    expect(parseDistanceM("800")).toBe(800);
  });

  it("understands m and km, with a comma decimal", () => {
    expect(parseDistanceM("800m")).toBe(800);
    expect(parseDistanceM("2km")).toBe(2000);
    expect(parseDistanceM("1,5 km")).toBe(1500);
  });

  it("rejects nonsense instead of defaulting", () => {
    // A silent default here turns a 2 km sweep into an empty run that looks
    // like an empty territory.
    expect(parseDistanceM("soon")).toBeUndefined();
    expect(parseDistanceM("-5")).toBeUndefined();
    expect(parseDistanceM("0")).toBeUndefined();
  });
});

describe("csv", () => {
  it("quotes fields containing a delimiter, quote or newline", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("renders undefined as an empty field, not the string undefined", () => {
    expect(csvRow(["a", undefined, null, 3])).toBe("a,,,3");
  });
});

describe("misc helpers", () => {
  it("firstText skips blanks", () => {
    expect(firstText(undefined, "  ", "x")).toBe("x");
    expect(firstText(undefined, null)).toBeUndefined();
  });

  it("uniqueBy keeps the first occurrence", () => {
    expect(uniqueBy([{ a: 1 }, { a: 1 }, { a: 2 }], (x) => String(x.a))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("clampInt falls back on nonsense", () => {
    expect(clampInt("7", 1, 10, 3)).toBe(7);
    expect(clampInt("99", 1, 10, 3)).toBe(10);
    expect(clampInt("x", 1, 10, 3)).toBe(3);
  });

  it("foldAccents strips diacritics", () => {
    expect(foldAccents("Île-de-Fränce")).toBe("Ile-de-France");
  });
});
