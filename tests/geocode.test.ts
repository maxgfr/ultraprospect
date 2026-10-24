// `where` refuses a name that two distinct places answer to, and must not refuse
// one that a place and its own namesake parent answer to.
//
// The engine module is mocked: `tests/setup.ts` forbids live network.
import { beforeEach, describe, expect, it, vi } from "vitest";

let hits: unknown[] = [];

vi.mock("../src/engine.js", () => ({
  awaitHostSlot: async () => 0,
  httpJson: async (_method: string, url: string) =>
    url.includes("nominatim") ? { ok: true, status: 200, data: hits } : { ok: false, status: 404, data: undefined },
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
