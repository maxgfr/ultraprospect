import { describe, expect, it } from "vitest";
import { EFFECTIF_BANDS, EFFECTIF_FLOOR, EFFECTIF_LABELS, HARD_CAP, PER_PAGE, buildUrl, expandRecord, parseRawAddress } from "../src/sirene.js";
import { bandsAtLeast } from "../src/scan.js";

describe("buildUrl", () => {
  it("uses /near_point for a bare point search", () => {
    const url = new URL(buildUrl({ point: { lat: 48.85, lon: 2.35, radiusKm: 0.3 } }, 1, 25));
    expect(url.pathname).toBe("/near_point");
    expect(url.searchParams.get("lat")).toBe("48.85");
    expect(url.searchParams.get("radius")).toBe("0.3");
  });

  it("clamps the radius to the API's 50 km ceiling instead of letting it 400", () => {
    const url = new URL(buildUrl({ point: { lat: 48.85, lon: 2.35, radiusKm: 500 } }, 1, 25));
    expect(url.searchParams.get("radius")).toBe("50");
  });

  it("uses /search when a commune code is available", () => {
    const url = new URL(buildUrl({ codeCommune: ["94080"] }, 1, 25));
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("code_commune")).toBe("94080");
  });

  it("does NOT send etat_administratif to /near_point", () => {
    // Measured: the point endpoint silently ignores filters it does not
    // implement — the result count comes back identical — so sending it would
    // create a false belief that the filter applied. It is re-applied
    // client-side instead.
    const url = new URL(buildUrl({ point: { lat: 48.85, lon: 2.35, radiusKm: 1 }, etatAdministratif: "A" }, 1, 25));
    expect(url.searchParams.get("etat_administratif")).toBeNull();
  });

  it("does send etat_administratif to /search, where it works", () => {
    const url = new URL(buildUrl({ codeCommune: ["94080"], etatAdministratif: "A" }, 1, 25));
    expect(url.searchParams.get("etat_administratif")).toBe("A");
  });

  it("sends NAF sections and full codes as comma lists on both endpoints", () => {
    const url = new URL(buildUrl({ codeCommune: ["94080"], sections: ["J", "M"], activitePrincipale: ["62.01Z", "62.02A"] }, 2, 25));
    expect(url.searchParams.get("section_activite_principale")).toBe("J,M");
    expect(url.searchParams.get("activite_principale")).toBe("62.01Z,62.02A");
    expect(url.searchParams.get("page")).toBe("2");
  });

  it("asks for the establishments, which are the unit this tool matches on", () => {
    const url = new URL(buildUrl({ codeCommune: ["94080"] }, 1, 25));
    expect(url.searchParams.get("limite_matching_etablissements")).toBe("100");
  });
});

describe("the API's documented and undocumented ceilings", () => {
  it("pins the pagination cap the splitter is built around", () => {
    expect(HARD_CAP).toBe(10_000);
    expect(PER_PAGE).toBe(25);
    // page * per_page may not exceed HARD_CAP, so this is the last reachable page.
    expect(Math.floor(HARD_CAP / PER_PAGE)).toBe(400);
  });
});

describe("parseRawAddress", () => {
  it("splits a raw establishment address into its parts", () => {
    const a = parseRawAddress("54 QUAI CHARLES PASQUA 92300 LEVALLOIS-PERRET");
    expect(a).toMatchObject({ numero: "54", typeVoie: "QUAI", libelleVoie: "CHARLES PASQUA", codePostal: "92300", commune: "LEVALLOIS-PERRET" });
  });

  it("keeps a first name that is not a street type", () => {
    // "CHARLES DE GAULLE" must not lose "CHARLES" to a street-type guess.
    const a = parseRawAddress("1 CHARLES DE GAULLE 94300 VINCENNES");
    expect(a.typeVoie).toBeUndefined();
    expect(a.libelleVoie).toBe("CHARLES DE GAULLE");
  });

  it("handles an address with no house number", () => {
    const a = parseRawAddress("RUE DE LA PAIX 75002 PARIS");
    expect(a.numero).toBeUndefined();
    expect(a.typeVoie).toBe("RUE");
    expect(a.commune).toBe("PARIS");
  });

  it("keeps the raw string when it cannot be parsed", () => {
    const a = parseRawAddress("somewhere odd");
    expect(a.raw).toBe("somewhere odd");
    expect(a.codePostal).toBeUndefined();
  });

  it("tolerates null", () => {
    expect(parseRawAddress(null)).toEqual({ raw: undefined });
  });
});

describe("expandRecord", () => {
  const entity = {
    siren: "794598813",
    nom_complet: "DOCTOLIB",
    section_activite_principale: "J",
    dirigeants: [{ nom: "NIOX-CHATEAU", prenoms: "STANISLAS", qualite: "Président de SAS", type_dirigeant: "personne physique" }],
    finances: { "2023": { ca: 1, resultat_net: 2 }, "2024": { ca: 311448000, resultat_net: -127499000 } },
    siege: {
      siret: "79459881300077",
      adresse: "54 QUAI CHARLES PASQUA 92300 LEVALLOIS-PERRET",
      numero_voie: "54",
      type_voie: "QUAI",
      libelle_voie: "CHARLES PASQUA",
      code_postal: "92300",
      commune: "92044",
      libelle_commune: "LEVALLOIS-PERRET",
    },
    matching_etablissements: [
      {
        siret: "79459881300077",
        adresse: "54 QUAI CHARLES PASQUA 92300 LEVALLOIS-PERRET",
        latitude: "48.900771302",
        longitude: "2.2849148026",
        est_siege: true,
        etat_administratif: "A",
        activite_principale: "62.01Z",
        tranche_effectif_salarie: "42",
        commune: "92044",
        libelle_commune: "LEVALLOIS-PERRET",
      },
      {
        siret: "79459881300085",
        adresse: "10 RUE DE LA PAIX 75002 PARIS",
        latitude: "48.869",
        longitude: "2.331",
        est_siege: false,
        etat_administratif: "A",
        activite_principale: "62.01Z",
        commune: "75102",
        libelle_commune: "PARIS",
      },
    ],
  };

  it("emits one record per establishment, not one per legal unit", () => {
    // The register's unit is the company; this tool's unit is the place. A
    // chain with four branches is four prospects at four addresses.
    const out = expandRecord(entity);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.siret)).toEqual(["79459881300077", "79459881300085"]);
  });

  it("takes the latest filed year from the year-keyed finances map", () => {
    expect(expandRecord(entity)[0]!.finances).toMatchObject({ annee: "2024", ca: 311448000, resultatNet: -127499000 });
  });

  it("prefers the siege's pre-parsed address for the siege establishment", () => {
    const [siege, branch] = expandRecord(entity);
    expect(siege!.address).toMatchObject({ numero: "54", typeVoie: "QUAI", libelleVoie: "CHARLES PASQUA", codeCommune: "92044" });
    // The branch only has the raw string, so it goes through the parser.
    expect(branch!.address).toMatchObject({ numero: "10", typeVoie: "RUE", libelleVoie: "DE LA PAIX", commune: "PARIS" });
  });

  it("carries coordinates as numbers", () => {
    const [first] = expandRecord(entity);
    expect(first!.lat).toBeCloseTo(48.9008, 3);
    expect(first!.lon).toBeCloseTo(2.2849, 3);
  });

  it("maps directors, natural and legal alike", () => {
    expect(expandRecord(entity)[0]!.dirigeants[0]).toMatchObject({ nom: "NIOX-CHATEAU", prenoms: "STANISLAS", qualite: "Président de SAS" });
  });

  it("falls back to the siege when there are no matching establishments", () => {
    const out = expandRecord({ ...entity, matching_etablissements: [] });
    expect(out).toHaveLength(1);
    expect(out[0]!.siret).toBe("79459881300077");
  });

  it("returns nothing for an entity with neither", () => {
    expect(expandRecord({ siren: "1" })).toEqual([]);
  });
});

describe("employee bands", () => {
  it("expands a minimum headcount into every band that satisfies it", () => {
    const bands = bandsAtLeast(20);
    expect(bands).toContain("12"); // 20-49
    expect(bands).toContain("53"); // 10000+
    expect(bands).not.toContain("11"); // 10-19 does not satisfy "at least 20"
    expect(bands).not.toContain("00");
  });

  it("keeps the bands in size order, which an object literal would NOT", () => {
    // Half these codes are canonical array indices, so `{ "00": 0, ..., "11": 10 }`
    // reorders itself: Object.values returns [10, 20, ..., 0, 1, 3, 6]. The
    // ordered array is what makes a size-distribution table correct.
    const floors = EFFECTIF_BANDS.map((b) => b.floor);
    expect([...floors].sort((a, b) => a - b)).toEqual(floors);
    expect(Object.values(EFFECTIF_FLOOR)).not.toEqual(floors);
  });

  it("treats an undetermined headcount as unknown, not as zero", () => {
    expect(EFFECTIF_FLOOR.NN).toBe(-1);
    expect(EFFECTIF_LABELS.NN).toBe("non déterminé");
    // and so it never satisfies a minimum
    expect(bandsAtLeast(0)).not.toContain("NN");
  });
});
