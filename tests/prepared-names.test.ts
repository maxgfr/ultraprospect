// Names prepared once, compared many times — with the same answers.
//
// The matcher used to re-derive every name's variants, normal forms, tokens and
// trigrams once per candidate PAIR, so a register name within reach of two
// hundred shopfronts went through the same regex passes two hundred times.
// Preparing each name once is only an optimisation if no score moves, so this
// holds the prepared path to the per-pair algorithm it replaced, reproduced
// here verbatim, over every OSM name × register name of the recorded Vincennes
// sweep.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RegistryRecord } from "../src/registry/types.js";
import type { OsmPoi } from "../src/types.js";
import {
  bestNameMatch,
  bestPreparedMatch,
  isNameContained,
  jaccard,
  nameSimilarity,
  nameVariants,
  normalizeName,
  prepareName,
  preparedSimilarity,
  tokenSet,
  trigrams,
} from "../src/util.js";

/** The per-pair algorithm `nameSimilarity` ran before names were prepared. */
function reference(a: string, b: string): number {
  let best = 0;
  for (const va of nameVariants(a)) {
    for (const vb of nameVariants(b)) {
      const na = normalizeName(va);
      const nb = normalizeName(vb);
      if (!na || !nb) continue;
      if (na === nb) return 1;
      const contained = isNameContained(na, nb) ? 0.88 : 0;
      const tok = jaccard(tokenSet(na), tokenSet(nb));
      const tri = jaccard(trigrams(na), trigrams(nb));
      best = Math.max(best, contained, tok, tri);
      if (best >= 1) return 1;
    }
  }
  return best;
}

const fixture = join(import.meta.dirname, "..", "assets", "fixtures", "vincennes");
const pois = JSON.parse(readFileSync(join(fixture, "osm.json"), "utf8")) as OsmPoi[];
const records = JSON.parse(readFileSync(join(fixture, "registry.json"), "utf8")) as RegistryRecord[];
const osmNames = [...new Set(pois.flatMap((p) => [p.name, p.tags.brand].filter((n): n is string => Boolean(n))))];
const registerNames = [...new Set(records.flatMap((r) => [...r.names, ...(r.tradingNames ?? [])]))];
// Shapes the fixture may not hold: boilerplate only, parenthesised alternates, empty.
const edge = ["SARL", "", "CREDIT LYONNAIS (LCL)", "KID'HOME SERVICES (KLEEN'HOME SERVICES; KH)", "LCL", "Crèche Jean Burgeat", "CRECHE BURGEAT"];

describe("prepared names", () => {
  it("score every pair of the recorded sweep exactly as the per-pair algorithm did", () => {
    const left = [...osmNames, ...edge];
    const right = [...registerNames, ...edge];
    const preparedRight = right.map(prepareName);
    let compared = 0;
    // Collected rather than asserted pair by pair: tens of thousands of
    // `expect` calls cost more than the comparisons and pushed this past the
    // default timeout under a parallel run.
    const mismatches: string[] = [];
    for (const a of left) {
      const pa = prepareName(a);
      for (const [j, b] of right.entries()) {
        const want = reference(a, b);
        if (nameSimilarity(a, b) !== want || preparedSimilarity(pa, preparedRight[j]!) !== want) mismatches.push(`${a} | ${b}`);
        compared++;
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(5000);
  }, 30_000);

  it("pick the same best register name, and report it as written", () => {
    for (const a of [...osmNames.slice(0, 40), ...edge]) {
      const want = bestNameMatch(a, registerNames);
      expect(bestPreparedMatch(prepareName(a), registerNames.map(prepareName))).toEqual(want);
    }
    expect(bestPreparedMatch(prepareName("LCL"), ["SOCIETE GENERALE", "CREDIT LYONNAIS (LCL)"].map(prepareName))).toEqual({
      name: "CREDIT LYONNAIS (LCL)",
      score: 1,
    });
  });
});
