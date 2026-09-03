import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let entities: any[] = [];

vi.mock("../src/engine.js", () => ({
  awaitHostSlot: async () => 0,
  mapLimit: async (items: readonly unknown[], _limit: number, fn: (item: any, index: number) => Promise<unknown>) => {
    const out = [];
    for (const [index, item] of items.entries()) out.push(await fn(item, index));
    return out;
  },
  httpJson: async (_method: string, raw: string) => {
    calls.push(raw);
    const url = new URL(raw);
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "25");
    const start = (page - 1) * perPage;
    return {
      ok: true,
      status: 200,
      data: { results: entities.slice(start, start + perPage), total_results: entities.length },
    };
  },
}));

const { fetchSirene } = await import("../src/registry/fr-sirene.js");

function entity(siren: string, legalForm: string): any {
  return {
    siren,
    nom_complet: `FAKE ${siren}`,
    nature_juridique: legalForm,
    matching_etablissements: [
      {
        siret: `${siren}00001`,
        adresse: "1 RUE DE LA PAIX 75002 PARIS",
        latitude: "48.869",
        longitude: "2.331",
        etat_administratif: "A",
      },
    ],
  };
}

beforeEach(() => {
  calls.length = 0;
  entities = [entity("111111111", "9110"), entity("222222222", "5710")];
});

describe("French legal-form filters", () => {
  it("sends the include list to /search as nature_juridique", async () => {
    await fetchSirene({ codeCommune: ["94080"], legalForms: ["9110", "5710"] });

    const urls = calls.map((raw) => new URL(raw));
    expect(urls.every((url) => url.pathname.endsWith("/search"))).toBe(true);
    expect(urls.every((url) => url.searchParams.get("nature_juridique") === "9110,5710")).toBe(true);
  });

  it("does not send the include list to /near_point and reapplies it client-side", async () => {
    const result = await fetchSirene({ point: { lat: 48.85, lon: 2.35, radiusKm: 1 }, legalForms: ["5710"] });

    expect(calls.every((raw) => !new URL(raw).searchParams.has("nature_juridique"))).toBe(true);
    expect(result.records.map((record) => record.legalForm)).toEqual(["5710"]);
  });

  it("keeps exclusions out of every URL and spends the budget only on kept rows", async () => {
    entities = [entity("111111111", "9110"), entity("222222222", "5710"), entity("333333333", "5499")];

    const result = await fetchSirene({ codeCommune: ["94080"], excludeLegalForms: ["9110"] }, { maxResults: 2 });

    expect(calls.every((raw) => !new URL(raw).searchParams.has("nature_juridique"))).toBe(true);
    expect(result.records.map((record) => record.legalForm)).toEqual(["5710", "5499"]);
    expect(result.records).toHaveLength(2);
  });
});
