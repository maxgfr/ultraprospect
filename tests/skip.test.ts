import { describe, expect, it } from "vitest";
import { describeSkips, partitionSkipped, skipReasonsFor } from "../src/skip.js";
import { buildResolveTodo, skipOutcomeFor } from "../src/resolve.js";
import type { OsmPoi, Place } from "../src/types.js";
import { rec } from "./factories.js";

function poi(tags: Record<string, string>, name?: string): OsmPoi {
  return { id: "n1", osmType: "node", osmId: 1, name, lat: 48.84, lon: 2.42, tags };
}

function place(over: Partial<Place> = {}): Place {
  return {
    id: "osm:n1",
    name: "Le Paris Café",
    sources: ["osm"],
    address: {},
    category: "amenity=cafe",
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: [],
    ...over,
  };
}

describe("skipReasonsFor — every test reads a tag somebody asserted", () => {
  it("calls a place with a brand a chain", () => {
    expect(skipReasonsFor(place({ osm: poi({ amenity: "bank", brand: "BNP Paribas" }, "BNP Paribas") }))).toContain("chain");
  });

  it("accepts brand:wikidata, which is the strongest form of the assertion", () => {
    expect(skipReasonsFor(place({ osm: poi({ shop: "supermarket", "brand:wikidata": "Q3085454" }, "Franprix") }))).toContain("chain");
  });

  it("does not call an independent café a chain", () => {
    expect(skipReasonsFor(place({ osm: poi({ amenity: "cafe" }, "Le Paris Café") }))).toEqual([]);
  });

  it("does NOT treat operator:wikidata as a chain", () => {
    // It identifies whoever RUNS the place, which for a museum, a clinic or a
    // one-site company is the business itself. Skipping on it would drop the
    // independent operators this flag exists to keep.
    const p = place({ osm: poi({ amenity: "cafe", "operator:wikidata": "Q42" }, "Le Paris Café") });
    expect(skipReasonsFor(p)).not.toContain("chain");
  });

  it("calls a row whose name is only its category unnamed", () => {
    const p = place({ name: "amenity=restaurant", category: "amenity=restaurant", osm: poi({ amenity: "restaurant" }) });
    expect(skipReasonsFor(p)).toContain("unnamed");
  });

  it("does NOT call a row unnamed when the register knows a name for it", () => {
    // `queriesFor` searches the register's names too, so this row is perfectly
    // searchable — skipping it would drop exactly what the register enriched.
    const p = place({
      name: "amenity=restaurant",
      category: "amenity=restaurant",
      osm: poi({ amenity: "restaurant" }),
      registry: rec({ legalName: "AUX BARREZIENS" }),
    });
    expect(skipReasonsFor(p)).not.toContain("unnamed");
  });

  it("does NOT call a row unnamed when it carries a registration number", () => {
    // A quoted registration number is the highest-precision query in the lane.
    const p = place({ name: "amenity=restaurant", category: "amenity=restaurant", registry: rec({ legalName: "", tradingNames: [], names: [] }) });
    expect(skipReasonsFor(p)).not.toContain("unnamed");
  });

  it("calls operator:type=public a public body", () => {
    expect(skipReasonsFor(place({ osm: poi({ amenity: "school", "operator:type": "public" }, "École Paul Bert") }))).toContain("public");
  });

  it("leaves a PRIVATE school alone — it is a business", () => {
    expect(skipReasonsFor(place({ osm: poi({ amenity: "school", "operator:type": "private" }, "Saint-Michel") }))).not.toContain("public");
  });

  it("calls a French legal unit with filed legal form 7210 a public body", () => {
    expect(skipReasonsFor(place({ registry: rec({ legalForm: "7210" }) }))).toContain("public");
  });

  it("does not call filed legal form 5710 a public body", () => {
    expect(skipReasonsFor(place({ registry: rec({ legalForm: "5710" }) }))).not.toContain("public");
  });

  it("does not interpret a GB legal form without a connector rule", () => {
    expect(skipReasonsFor(place({ registry: rec({ connectorId: "gb-companies-house", countryCode: "gb", legalForm: "7210" }) }))).not.toContain("public");
  });

  it("calls shop=vacant and disused:* vacant", () => {
    expect(skipReasonsFor(place({ osm: poi({ shop: "vacant" }) }))).toContain("vacant");
    expect(skipReasonsFor(place({ osm: poi({ "disused:shop": "bakery" }) }))).toContain("vacant");
  });

  it("does NOT call was:* vacant — a trading business keeps what it used to be", () => {
    // `was:shop=bakery` on a live restaurant says what the unit USED to be, not
    // that it is empty. Counting it as vacant skips a business you can sell to.
    const p = place({ osm: poi({ amenity: "restaurant", "was:shop": "bakery" }, "Le Mumtaz") });
    expect(skipReasonsFor(p)).not.toContain("vacant");
  });

  it("reports every reason that applies, not the first", () => {
    const p = place({ name: "shop=vacant", category: "shop=vacant", osm: poi({ shop: "vacant", brand: "X" }) });
    expect(skipReasonsFor(p).sort()).toEqual(["chain", "unnamed", "vacant"]);
  });
});

describe("partitionSkipped", () => {
  const chain = place({ id: "a", osm: poi({ shop: "supermarket", brand: "Franprix" }, "Franprix") });
  const indie = place({ id: "b", osm: poi({ amenity: "cafe" }, "Le Paris Café") });

  it("keeps only the reasons asked for", () => {
    const only = partitionSkipped([chain, indie], ["unnamed"]);
    expect(only.kept.map((p) => p.id)).toEqual(["a", "b"]);

    const both = partitionSkipped([chain, indie], ["chain"]);
    expect(both.kept.map((p) => p.id)).toEqual(["b"]);
    expect(both.counts.chain).toBe(1);
  });

  it("records the reason per place so the decision is reversible", () => {
    expect(partitionSkipped([chain], ["chain"]).skipped.get("a")).toEqual(["chain"]);
  });
});

describe("describeSkips", () => {
  it("says nothing when nothing was skipped", () => {
    expect(describeSkips({ kept: [], skipped: new Map(), counts: {} })).toBeUndefined();
  });

  it("reconciles the per-reason counts against the total when they overlap", () => {
    // A row can be both a chain and unnamed, so the parts sum higher than the
    // total. Unexplained, that reads as one of the numbers being wrong.
    const line = describeSkips({ kept: [], skipped: new Map([["a", ["chain", "unnamed"]]]), counts: { chain: 1, unnamed: 1 } } as any);
    expect(line).toContain("skipped 1 place(s)");
    expect(line).toContain("counted under more than one reason");
  });
});

describe("skipOutcomeFor — the count describes the SELECTION, not the run", () => {
  const chainA = place({ id: "a", osm: poi({ shop: "supermarket", brand: "Franprix" }, "Franprix") });
  const chainB = place({ id: "b", osm: poi({ shop: "supermarket", brand: "Monoprix" }, "Monoprix") });
  const indie = place({ id: "c", osm: poi({ amenity: "cafe" }, "Le Paris Café") });

  it("counts only within --only", () => {
    // Reporting 2 skipped on a run that was only ever going to search `a`
    // describes work the user never asked for.
    const scoped = skipOutcomeFor([chainA, chainB, indie], { only: ["a"], skip: ["chain"] });
    expect(scoped.skipped.size).toBe(1);
    expect(scoped.counts.chain).toBe(1);

    const whole = skipOutcomeFor([chainA, chainB, indie], { skip: ["chain"] });
    expect(whole.skipped.size).toBe(2);
  });

  it("skips nothing when no reasons were given", () => {
    expect(skipOutcomeFor([chainA, indie], {}).skipped.size).toBe(0);
    expect(skipOutcomeFor([chainA, indie], {}).kept).toHaveLength(2);
  });
});

describe("describeSkips under --limit", () => {
  const outcome = { kept: [], skipped: new Map([["a", ["chain"]]]), counts: { chain: 1 } } as any;

  it("calls them searches saved when no limit is in force", () => {
    expect(describeSkips(outcome, false)).toContain("skipped 1 place(s) before searching");
  });

  it("says they were REPLACED, not saved, when a limit is in force", () => {
    // --limit takes a prefix of whatever survives, so skipping refills the
    // window from further down the list instead of shortening it. Same count,
    // opposite consequence.
    const line = describeSkips(outcome, true);
    expect(line).toContain("replaced rather than saved");
    expect(line).not.toContain("before searching");
  });
});

describe("the worklist records what was skipped", () => {
  it("names each skipped id and its reasons, so the call can be argued with", () => {
    const chain = place({ id: "a", name: "Franprix", osm: poi({ shop: "supermarket", brand: "Franprix" }, "Franprix") });
    const indie = place({ id: "b", osm: poi({ amenity: "cafe" }, "Le Paris Café") });
    const todo = buildResolveTodo([chain, indie], "Saint-Mandé", "fr", { skip: ["chain"] });

    expect(todo.items.map((i) => i.placeId)).toEqual(["b"]);
    expect(todo.skipped).toEqual([{ placeId: "a", name: "Franprix", reasons: ["chain"] }]);
  });

  it("omits the array entirely when nothing was skipped", () => {
    const indie = place({ id: "b", osm: poi({ amenity: "cafe" }, "Le Paris Café") });
    expect(buildResolveTodo([indie], "Saint-Mandé", "fr", {}).skipped).toBeUndefined();
  });
});
