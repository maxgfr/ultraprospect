// A box swept by a register that can only search around a point.
//
// The French API has a commune search and a disc search, and no box. `--bbox`
// used to reach it as a fixed 1 km disc around the box's centre whatever the
// box's size, so a 10 km box got a 1 km register lane beside an OSM lane that
// covered all of it — two lanes over two territories, reported as one.
//
// The engine module is mocked: `tests/setup.ts` forbids live network.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoTarget } from "../src/types.js";

const calls: URL[] = [];
/** The establishments the fake register holds, as [siret, lat, lon]. */
let establishments: [string, number, number][] = [];

vi.mock("../src/engine.js", () => ({
  awaitHostSlot: async () => 0,
  mapLimit: async (items: readonly unknown[], _limit: number, fn: (i: any, n: number) => Promise<unknown>) => {
    const out = [];
    for (const [i, item] of items.entries()) out.push(await fn(item, i));
    return out;
  },
  httpJson: async (_m: string, raw: string) => {
    const url = new URL(raw);
    calls.push(url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const results =
      page === 1
        ? establishments.map(([siret, lat, lon]) => ({
            siren: siret.slice(0, 9),
            nom_complet: `COMPANY ${siret}`,
            matching_etablissements: [
              { siret, adresse: "1 RUE DE LA PAIX 75002 PARIS", latitude: String(lat), longitude: String(lon), etat_administratif: "A" },
            ],
          }))
        : [];
    return { ok: true, status: 200, data: { results, total_results: establishments.length } };
  },
}));

const { frSirene } = await import("../src/registry/fr-sirene.js");
const { haversineM } = await import("../src/util.js");

/** About 10 km on a side, around the centre of Paris. */
const BOX: [number, number, number, number] = [48.81, 48.9, 2.28, 2.42];

const boxTarget = (bbox: [number, number, number, number], over: Partial<GeoTarget> = {}): GeoTarget => ({
  query: "box",
  label: "bbox",
  lat: (bbox[0] + bbox[1]) / 2,
  lon: (bbox[2] + bbox[3]) / 2,
  bbox,
  countryCode: "fr",
  source: "nominatim",
  ...over,
});

const sweep = (target: GeoTarget) => frSirene.sweep!(target, {}, {});

beforeEach(() => {
  calls.length = 0;
  establishments = [];
});

describe("a box is swept as the disc that covers it, then trimmed back to the box", () => {
  it("asks for the half-diagonal of the box, not for a fixed kilometre", async () => {
    await sweep(boxTarget(BOX));
    const url = calls[0]!;
    expect(url.pathname).toBe("/near_point");
    const radiusKm = Number(url.searchParams.get("radius"));
    const cornerKm = haversineM(48.855, 2.35, 48.81, 2.42) / 1000;
    expect(radiusKm).toBeGreaterThan(7);
    expect(radiusKm).toBeCloseTo(cornerKm, 1);
    expect(Number(url.searchParams.get("lat"))).toBeCloseTo(48.855, 6);
    expect(Number(url.searchParams.get("long"))).toBeCloseTo(2.35, 6);
  });

  it("centres the disc on the box, not on a geocoder's off-centre label point", async () => {
    await sweep(boxTarget(BOX, { lat: 48.82, lon: 2.29 }));
    expect(Number(calls[0]!.searchParams.get("lat"))).toBeCloseTo(48.855, 6);
    expect(Number(calls[0]!.searchParams.get("long"))).toBeCloseTo(2.35, 6);
  });

  it("drops what the disc returned outside the box, and says how many", async () => {
    establishments = [
      ["11111111100011", 48.85, 2.35], // the middle of the box
      ["22222222200022", 48.89, 2.41], // a corner, 7 km out and still inside
      ["33333333300033", 48.855, 2.44], // inside the disc, east of the box
      ["44444444400044", 48.915, 2.35], // inside the disc, north of the box
    ];
    const notes: string[] = [];
    const result = await frSirene.sweep!(boxTarget(BOX), {}, { onNote: (n) => notes.push(n) });
    expect(result.records.map((r) => r.establishmentId).sort()).toEqual(["11111111100011", "22222222200022"]);
    expect(result.coverage.returned).toBe(2);
    expect(result.coverage.truncated).toBe(false);
    expect(result.notes.some((n) => n.includes("2 establishments") && n.includes("outside the box"))).toBe(true);
    expect(notes.some((n) => n.includes("outside the box"))).toBe(true);
  });

  it("marks the lane truncated, with the reason, when the box is wider than the API's 50 km", async () => {
    // Two degrees of latitude: about 111 km from the centre to an edge.
    const result = await sweep(boxTarget([47, 49, 1, 4]));
    expect(calls[0]!.searchParams.get("radius")).toBe("50");
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.reason).toMatch(/50 km/);
    expect(result.coverage.reason).toMatch(/NOT swept/);
  });

  it("says it swept a rectangle when the place was an outline with no commune code", async () => {
    const result = await sweep(boxTarget(BOX, { osmType: "relation", osmId: 71525 }));
    expect(result.coverage.truncated).toBe(false);
    expect(result.coverage.reason).toMatch(/bounding box/);
  });
});

describe("the two shapes the API does have are left as they were", () => {
  it("sweeps a commune by its code", async () => {
    const result = await sweep(boxTarget(BOX, { codeCommune: "94080" }));
    expect(calls[0]!.pathname).toBe("/search");
    expect(calls[0]!.searchParams.get("code_commune")).toBe("94080");
    expect(result.coverage.reason).toBeUndefined();
  });

  it("sweeps a --radius point search with the radius it was given, untrimmed", async () => {
    establishments = [["11111111100011", 48.86, 2.36]];
    const result = await sweep(boxTarget([48.855, 48.855, 2.35, 2.35], { radiusM: 2000 }));
    expect(calls[0]!.pathname).toBe("/near_point");
    expect(calls[0]!.searchParams.get("radius")).toBe("2");
    expect(result.records).toHaveLength(1);
  });
});
