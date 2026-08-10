// The anti-cap split ladder, against a fake register.
//
// This is the most consequential logic in the repository. It decides whether a
// run covers a territory or silently covers part of one, and its failure mode
// is invisible: a short list that claims to be a whole town. The API it works
// against clamps its own result count, so there is no honest signal to compare
// against at runtime — only this behaviour, pinned here.
//
// The engine module is mocked so the ladder can be driven through cases the
// live API would take minutes to reproduce and could not be made to reproduce
// on demand at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
/** url -> the total_results that fake register reports for it. */
let totals: (url: URL) => number;
/** How many records each page yields, to exercise the budget. */
let perPageRecords = 25;
/** When set, the fake register answers every call with this error. */
let apiError: string | undefined;

vi.mock("../src/engine.js", () => ({
  awaitHostSlot: async () => 0,
  mapLimit: async (items: readonly unknown[], _limit: number, fn: (i: any, n: number) => Promise<unknown>) => {
    const out = [];
    for (const [i, item] of items.entries()) out.push(await fn(item, i));
    return out;
  },
  httpJson: async (_m: string, raw: string) => {
    calls.push(raw);
    if (apiError) return { ok: false, status: 503, data: { erreur: apiError } };
    const url = new URL(raw);
    const total = totals(url);
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "25");
    const remaining = Math.max(0, Math.min(total, 10_000) - (page - 1) * perPage);
    const count = Math.min(perPage, remaining, perPageRecords);
    const results = Array.from({ length: count }, (_, i) => ({
      siren: `S${page}-${i}-${url.searchParams.get("section_activite_principale") ?? url.searchParams.get("activite_principale") ?? "x"}`,
      nom_complet: "FAKE",
      matching_etablissements: [
        {
          siret: `${page}-${i}-${url.searchParams.get("section_activite_principale") ?? url.searchParams.get("activite_principale") ?? "x"}`,
          adresse: "1 RUE DE LA PAIX 75002 PARIS",
          latitude: "48.869",
          longitude: "2.331",
          etat_administratif: "A",
        },
      ],
    }));
    return { ok: true, status: 200, data: { results, total_results: total } };
  },
}));

const { HARD_CAP, fetchSirene } = await import("../src/registry/fr-sirene.js");

function sectionsQueried(): string[] {
  return [...new Set(calls.map((c) => new URL(c).searchParams.get("section_activite_principale")).filter((s): s is string => Boolean(s)))];
}

beforeEach(() => {
  calls.length = 0;
  perPageRecords = 25;
  apiError = undefined;
  totals = () => 10;
});

describe("the split ladder", () => {
  it("does not split when the query fits under the cap", async () => {
    totals = () => 40;
    const result = await fetchSirene({ codeCommune: ["94080"] });
    expect(result.coverage.partitions).toBe(1);
    expect(sectionsQueried()).toEqual([]);
    expect(result.coverage.truncated).toBe(false);
  });

  it("splits by NAF section when the count reports the clamp", async () => {
    // The API clamps total_results at 10 000, so this is what "more than we can
    // page through" actually looks like on the wire. Anything that reads it as
    // a real total stops here and loses the rest of the territory.
    totals = (url) => (url.searchParams.get("section_activite_principale") ? 30 : HARD_CAP);
    const result = await fetchSirene({ codeCommune: ["94080"] });
    expect(sectionsQueried()).toHaveLength(21);
    expect(result.coverage.partitions).toBe(21);
    expect(result.coverage.truncated).toBe(false);
  });

  it("splits a still-capped section into its NAF divisions", async () => {
    totals = (url) => {
      if (url.searchParams.get("activite_principale")) return 5;
      if (url.searchParams.get("section_activite_principale") === "C") return HARD_CAP;
      if (url.searchParams.get("section_activite_principale")) return 10;
      return HARD_CAP;
    };
    const result = await fetchSirene({ codeCommune: ["94080"] });
    const divisionCalls = calls.filter((c) => new URL(c).searchParams.get("activite_principale"));
    // Section C (manufacturing) spans divisions 10-33 — the widest section.
    expect(divisionCalls.length).toBeGreaterThan(20);
    expect(result.coverage.truncated).toBe(false);
  });

  it("DECLARES truncation when a leaf is still capped after the ladder runs out", async () => {
    // The whole point. A partial sweep that presents itself as complete is the
    // one failure nobody downstream can detect, so the run says so instead.
    totals = () => HARD_CAP;
    const result = await fetchSirene({ codeCommune: ["94080"] }, { maxResults: 100_000 });
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.reason).toMatch(/at least 10000/i);
    expect(result.notes.some((n) => n.includes("TRUNCATED"))).toBe(true);
  });

  it("stops at the --max-results budget and says so", async () => {
    totals = () => 5000;
    const result = await fetchSirene({ codeCommune: ["94080"] }, { maxResults: 50 });
    expect(result.records.length).toBeLessThanOrEqual(50);
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.reason).toMatch(/budget of 50/);
  });

  it("never asks for a page beyond the pagination ceiling", async () => {
    // page * per_page <= 10 000. Walking past it returns an empty page, then a
    // 400 — and a naive loop would keep going until the API said no.
    totals = () => 9_999;
    await fetchSirene({ codeCommune: ["94080"] }, { maxResults: 100_000 });
    const worst = Math.max(...calls.map((c) => Number(new URL(c).searchParams.get("page")) * Number(new URL(c).searchParams.get("per_page"))));
    expect(worst).toBeLessThanOrEqual(HARD_CAP);
  });

  it("deduplicates establishments seen through more than one partition", async () => {
    totals = (url) => (url.searchParams.get("section_activite_principale") ? 25 : HARD_CAP);
    perPageRecords = 25;
    const result = await fetchSirene({ codeCommune: ["94080"] });
    const sirets = result.records.map((r) => r.establishmentId);
    expect(new Set(sirets).size).toBe(sirets.length);
  });

  it("reports an upstream error as TRUNCATION, not as an empty territory", async () => {
    // A 500 from the register and a town with no companies produce the same
    // empty array. Only the coverage flag tells them apart, and a caller that
    // reads the array without the flag publishes the wrong one as a fact.
    apiError = "service unavailable";
    const result = await fetchSirene({ codeCommune: ["94080"] });
    expect(result.records).toHaveLength(0);
    expect(result.coverage.truncated).toBe(true);
    expect(result.coverage.reason).toContain("service unavailable");
  });
});

describe("the point endpoint's silent filters", () => {
  it("applies etat_administratif client-side, because the endpoint drops it", async () => {
    // Measured against the live API: /near_point ignores filters it does not
    // implement rather than rejecting them, so the count comes back identical
    // and nothing signals that the filter did nothing.
    totals = () => 2;
    const result = await fetchSirene({ point: { lat: 48.85, lon: 2.35, radiusKm: 1 }, etatAdministratif: "C" });
    // Every fake record is active ("A"), so a "C" filter must empty the result.
    expect(result.records).toHaveLength(0);
    // …and the filter must not have been sent.
    expect(calls.every((c) => !new URL(c).searchParams.get("etat_administratif"))).toBe(true);
  });

  it("keeps records that match the client-side filter", async () => {
    totals = () => 2;
    const result = await fetchSirene({ point: { lat: 48.85, lon: 2.35, radiusKm: 1 }, etatAdministratif: "A" });
    expect(result.records.length).toBeGreaterThan(0);
  });
});
