// `where` refuses a name that two distinct places answer to, and must not refuse
// one that a place and its own namesake parent answer to.
//
// The engine module is mocked: `tests/setup.ts` forbids live network.
import { beforeEach, describe, expect, it, vi } from "vitest";

let hits: unknown[] = [];
/** What the Base Adresse Nationale answers, best first. Empty: it knows nothing. */
let ban: unknown[] = [];

vi.mock("../src/engine.js", () => ({
  awaitHostSlot: async () => 0,
  httpJson: async (_method: string, url: string) => {
    if (url.includes("nominatim")) return { ok: true, status: 200, data: hits };
    if (url.includes("api-adresse")) return { ok: true, status: 200, data: { type: "FeatureCollection", features: ban } };
    return { ok: false, status: 404, data: undefined };
  },
}));

const { resolveWhere } = await import("../src/geocode.js");

// Shapes as Nominatim returned them for "Issoire" in 2026-10.
const ISSOIRE_COMMUNE = {
  display_name: "Issoire, Puy-de-Dôme, Auvergne-Rhône-Alpes, France métropolitaine, 63500, France",
  lat: "45.5433",
  lon: "3.25019",
  boundingbox: ["45.5216981", "45.5669748", "3.2107931", "3.2781449"],
  osm_type: "relation",
  osm_id: 123712,
  addresstype: "town",
  importance: 0.5757,
};
const ISSOIRE_ARRONDISSEMENT = {
  display_name: "Issoire, Puy-de-Dôme, Auvergne-Rhône-Alpes, France métropolitaine, France",
  lat: "45.55022",
  lon: "2.97944",
  boundingbox: ["45.2870513", "45.8135654", "2.5072757", "3.5212571"],
  osm_type: "relation",
  osm_id: 1693119,
  addresstype: "municipality",
  importance: 0.5246,
};

beforeEach(() => {
  hits = [];
  ban = [];
});

/** A BAN feature, in the shape the live API returned in 2026-11. */
const banFeature = (type: string, citycode: string, postcode: string, lon: number, lat: number) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: { type, citycode, postcode },
});

const fr = (over: Record<string, unknown>) => ({ ...ISSOIRE_COMMUNE, address: { country_code: "fr" }, ...over });

const SAINT_DENIS_93 = fr({
  display_name: "Saint-Denis, Seine-Saint-Denis, Île-de-France, France",
  lat: "48.9358",
  lon: "2.3539",
  boundingbox: ["48.9015", "48.9517", "2.3338", "2.3983"],
  osm_id: 87644,
  importance: 0.6,
});
const SAINT_DENIS_974 = fr({
  display_name: "Saint-Denis, La Réunion, France",
  lat: "-20.8799",
  lon: "55.4481",
  boundingbox: ["-21.0100", "-20.8700", "55.3800", "55.5300"],
  osm_id: 1785276,
  importance: 0.59,
});
// BAN ranks the two the other way round, and follows them with streets.
const BAN_SAINT_DENIS = [
  banFeature("municipality", "97411", "97400", 55.444588, -20.909778),
  banFeature("municipality", "93066", "93200", 2.361503, 48.937483),
  banFeature("street", "35152", "35340", -1.577874, 48.195056),
];

describe("the commune code belongs to the candidate that was picked", () => {
  it("takes the commune BAN places inside the picked candidate, not BAN's own first answer", async () => {
    hits = [SAINT_DENIS_93, SAINT_DENIS_974];
    ban = BAN_SAINT_DENIS;
    const first = await resolveWhere("Saint-Denis", { pick: 1 });
    expect(first.ok && first.target.codeCommune).toBe("93066");
    expect(first.ok && first.target.postcode).toBe("93200");
    const second = await resolveWhere("Saint-Denis", { pick: 2 });
    expect(second.ok && second.target.codeCommune).toBe("97411");
  });

  it("leaves the code unset when no BAN answer lies inside the picked candidate", async () => {
    hits = [SAINT_DENIS_93, SAINT_DENIS_974];
    // BAN only knows the other one: its code must not be borrowed.
    ban = [BAN_SAINT_DENIS[0]];
    const r = await resolveWhere("Saint-Denis", { pick: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.codeCommune).toBeUndefined();
      expect(r.target.postcode).toBeUndefined();
    }
  });

  it("does not sweep a whole commune for a street or an address", async () => {
    // "rue de Rivoli, Paris": Nominatim returns one stretch of the street, BAN
    // the street with the code of the arrondissement around it.
    hits = [
      fr({
        display_name: "Rue de Rivoli, Paris 1er Arrondissement, Paris, France",
        lat: "48.8607",
        lon: "2.3408",
        boundingbox: ["48.8550", "48.8660", "2.3250", "2.3620"],
        osm_type: "way",
        osm_id: 4433,
      }),
    ];
    ban = [banFeature("street", "75101", "75001", 2.3362, 48.862442), banFeature("housenumber", "75101", "75001", 2.34, 48.861)];
    const r = await resolveWhere("rue de Rivoli, Paris");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.codeCommune).toBeUndefined();
  });

  it("still gives an unambiguous commune its code", async () => {
    hits = [fr({})];
    ban = [banFeature("municipality", "63178", "63500", 3.24313, 45.542007)];
    const r = await resolveWhere("Issoire");
    expect(r.ok && r.target.codeCommune).toBe("63178");
    expect(r.ok && r.target.postcode).toBe("63500");
  });
});

describe("resolveWhere ambiguity", () => {
  it("resolves a commune whose arrondissement shares its name", async () => {
    hits = [ISSOIRE_COMMUNE, ISSOIRE_ARRONDISSEMENT];
    const r = await resolveWhere("Issoire");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.osmId).toBe(123712);
  });

  it("still refuses two far-apart places of comparable weight", async () => {
    hits = [
      {
        ...ISSOIRE_COMMUNE,
        display_name: "Vincennes, Val-de-Marne, France",
        lat: "48.8474",
        lon: "2.4396",
        boundingbox: ["48.83", "48.86", "2.42", "2.46"],
        importance: 0.6,
      },
      {
        ...ISSOIRE_COMMUNE,
        display_name: "Vincennes, Knox County, Indiana",
        lat: "38.677",
        lon: "-87.528",
        boundingbox: ["38.64", "38.71", "-87.56", "-87.49"],
        importance: 0.58,
      },
    ];
    const r = await resolveWhere("Vincennes");
    expect(r.ok).toBe(false);
  });
});
