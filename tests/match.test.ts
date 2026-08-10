import { describe, expect, it } from "vitest";
import { MAX_DISTANCE_M, MERGE_HIGH, MERGE_LOW, applyVerdicts, buildMatchTodo, matchLanes, scorePair } from "../src/match.js";
import type { OsmPoi, Place, SireneRecord } from "../src/types.js";

function poi(over: Partial<OsmPoi> = {}): OsmPoi {
  return { id: "n1", osmType: "node", osmId: 1, name: "Naturalia", lat: 48.8475, lon: 2.4397, tags: {}, ...over };
}

function rec(over: Partial<SireneRecord> = {}): SireneRecord {
  return {
    siren: "302474648",
    siret: "30247464801175",
    nomComplet: "NATURALIA FRANCE",
    enseignes: [],
    dirigeants: [],
    address: {},
    lat: 48.8475,
    lon: 2.4397,
    ...over,
  };
}

describe("scorePair", () => {
  it("merges a same-name pair a few metres apart", () => {
    const s = scorePair(poi(), rec());
    expect(s.score).toBeGreaterThanOrEqual(MERGE_HIGH);
    expect(s.matchedName).toBe("NATURALIA FRANCE");
  });

  it("REFUSES a pair with no identity agreement, however close", () => {
    // The load-bearing gate. A Paris office block holds fifty registered
    // companies inside twenty metres; if proximity alone could carry a match,
    // a dense area collapses into nonsense.
    const s = scorePair(poi({ name: "Le Bistrot" }), rec({ nomComplet: "SOCIETE GENERALE" }));
    expect(s.score).toBe(0);
    expect(s.distanceM).toBeLessThan(1);
  });

  it("scores nothing beyond the distance ceiling even on an exact name", () => {
    const far = rec({ lat: 48.86, lon: 2.46 });
    const s = scorePair(poi(), far);
    expect(s.distanceM).toBeGreaterThan(MAX_DISTANCE_M);
    expect(s.score).toBe(0);
  });

  it("sends an address-only pair to ADJUDICATION rather than merging it", () => {
    // A shop trades under its sign and the register holds the operating
    // company, so an exact address with no name agreement is real evidence —
    // and it is not decidable. Measured on one Vincennes run, this exact shape
    // produced "Aux Papilles" ↔ "BRUNO ENCAOUA" and "Synotis" ↔ "SYNALTIC"
    // (both right) alongside "Société Générale" ↔ "PAREX AUDIT S.A.S" (plainly
    // wrong, two tenants of one building). Nothing available here separates
    // them, so the band decides, not the matcher.
    const p = poi({ name: "Les Officiers", tags: { "addr:housenumber": "12", "addr:street": "Avenue de Paris" } });
    const r = rec({ nomComplet: "AUX BARREZIENS", address: { numero: "12", typeVoie: "AVENUE", libelleVoie: "DE PARIS" } });
    const s = scorePair(p, r);
    expect(s.parts.address).toBe(1);
    expect(s.score).toBeGreaterThanOrEqual(MERGE_LOW);
    expect(s.score).toBeLessThan(MERGE_HIGH);
  });

  it("MERGES an address match that even weakly agrees on the name", () => {
    // Two independent signals pointing the same way is a different situation
    // from one signal pointing anywhere. "Maison 1 2 3" against "MAISON 123"
    // scores 0.5 on the name — not enough on its own (it sits in the undecided
    // band in the test below) — but at the same street number it is decided.
    const p = poi({ name: "Maison 1 2 3", tags: { "addr:housenumber": "12", "addr:street": "Avenue de Paris" } });
    const r = rec({ nomComplet: "MAISON 123", address: { numero: "12", typeVoie: "AVENUE", libelleVoie: "DE PARIS" } });
    const s = scorePair(p, r);
    expect(s.parts.address).toBe(1);
    expect(s.parts.name).toBeGreaterThanOrEqual(0.4);
    expect(s.score).toBeGreaterThanOrEqual(MERGE_HIGH);

    // The same name, no address: undecided. The address is what settles it.
    const alone = scorePair(poi({ name: "Maison 1 2 3" }), rec({ nomComplet: "MAISON 123" }));
    expect(alone.score).toBeLessThan(MERGE_HIGH);
  });

  it("uses the brand tag against the register's enseigne", () => {
    const p = poi({ name: "Carrefour City Vincennes", tags: { brand: "Carrefour City" } });
    const r = rec({ nomComplet: "SOMEDIS", enseignes: ["CARREFOUR CITY"] });
    const s = scorePair(p, r);
    expect(s.parts.enseigne).toBeGreaterThan(0.8);
  });

  it("reports which register name produced the score", () => {
    // Not cosmetic: the adjudication file shows this to the agent, and showing
    // the legal name instead makes a correct pair look obviously wrong.
    const r = rec({ nomComplet: "COMMUNE DE VINCENNES", enseignes: ["CRECHE BURGEAT"] });
    const s = scorePair(poi({ name: "Crèche Jean Burgeat" }), r);
    expect(s.matchedName).toBe("CRECHE BURGEAT");
  });

  it("gives no score when the register record has no coordinates", () => {
    expect(scorePair(poi(), rec({ lat: undefined, lon: undefined })).score).toBe(0);
  });
});

describe("matchLanes", () => {
  it("pairs one-to-one, best first", () => {
    const pois = [poi({ id: "n1", name: "Naturalia" }), poi({ id: "n2", name: "Naturalia", lat: 48.8476 })];
    const records = [rec({ siret: "A" })];
    const { merged } = matchLanes(pois, records);
    // One register record cannot be two shopfronts.
    expect(merged.size).toBe(1);
    // The decision carries the score it was made on, never a flat 1: a merge at
    // 0.74 and a merge at 0.99 are both "merged", and only one is worth
    // re-reading when a row looks wrong.
    expect(merged.get("A")).toMatchObject({ osmId: "n1", by: "name" });
    expect(merged.get("A")!.score).toBeGreaterThanOrEqual(MERGE_HIGH);
  });

  it("routes the middle band to the agent instead of deciding", () => {
    const p = poi({ name: "Maison 1 2 3" });
    const r = rec({ nomComplet: "MAISON 123" });
    const s = scorePair(p, r);
    // Guard the fixture: if this pair ever leaves the band, the test below is
    // asserting nothing.
    expect(s.score).toBeGreaterThanOrEqual(MERGE_LOW);
    expect(s.score).toBeLessThan(MERGE_HIGH);

    const { merged, undecided } = matchLanes([p], [r]);
    expect(merged.size).toBe(0);
    expect(undecided).toHaveLength(1);
    expect(undecided[0]!.osmName).toBe("Maison 1 2 3");
  });

  it("drops pairs below the low threshold entirely", () => {
    const { merged, undecided } = matchLanes([poi({ name: "Le Bistrot" })], [rec({ nomComplet: "SOCIETE GENERALE" })]);
    expect(merged.size).toBe(0);
    expect(undecided).toHaveLength(0);
  });
});

describe("buildMatchTodo", () => {
  it("sorts strongest first so the agent works down an easing list", () => {
    const todo = buildMatchTodo([
      { osmId: "a", score: 0.5, parts: { distance: 0, name: 0, enseigne: 0, address: 0 }, distanceM: 10 },
      { osmId: "b", score: 0.7, parts: { distance: 0, name: 0, enseigne: 0, address: 0 }, distanceM: 10 },
    ]);
    expect(todo.pairs.map((p) => p.osmId)).toEqual(["b", "a"]);
    expect(todo.version).toBe(1);
  });
});

describe("applyVerdicts", () => {
  function places(): Place[] {
    return [
      {
        id: "osm:n1",
        name: "Naturalia",
        sources: ["osm"],
        osm: poi(),
        address: {},
        contacts: { emails: [], phones: [], socials: [], people: [] },
        jobs: [],
        pages: [],
      },
      {
        id: "sirene:A",
        name: "NATURALIA FRANCE",
        sources: ["sirene"],
        sirene: rec({ siret: "A", address: { commune: "VINCENNES" } }),
        address: { commune: "VINCENNES" },
        contacts: { emails: [], phones: [], socials: [], people: [] },
        jobs: [],
        pages: [],
      },
    ];
  }

  it("merges a confirmed pair into the OSM entity and removes the duplicate", () => {
    const list = places();
    const result = applyVerdicts(list, [{ osmId: "n1", siret: "A", merge: true }]);
    expect(result.merged).toBe(1);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("osm:n1");
    expect(list[0]!.sirene?.siret).toBe("A");
    expect(list[0]!.sources).toEqual(["osm", "sirene"]);
    // The register's address fills the gaps the shopfront left blank.
    expect(list[0]!.address.commune).toBe("VINCENNES");
  });

  it("changes nothing for a keep-apart verdict", () => {
    // Recording a "no" as a change would make the run non-idempotent.
    const list = places();
    const result = applyVerdicts(list, [{ osmId: "n1", siret: "A", merge: false }]);
    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(1);
    expect(list).toHaveLength(2);
  });

  it("reports a verdict naming a pair this run does not have", () => {
    const list = places();
    const result = applyVerdicts(list, [{ osmId: "n999", siret: "ZZZ", merge: true }]);
    expect(result.merged).toBe(0);
    expect(result.unknown).toHaveLength(1);
    expect(list).toHaveLength(2);
  });
});
