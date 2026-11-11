// The look-alike pairs a tenders run leaves for the agent, across the web lane
// and across `--apply`: what search time proposed must survive until judged.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Tender } from "../src/tenders/types.js";

/** url -> { title, text }. Anything else answers 404. */
let site: Record<string, { title: string; text: string }> = {};

vi.mock("../src/engine.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/engine.js")>();
  const answer = async (url: string) => {
    const p = site[url];
    if (!p) return { status: 404, text: "", finalUrl: url };
    return { status: 200, text: p.text, title: p.title, finalUrl: url };
  };
  return { ...real, cachedFetchAndExtract: answer, fetchAndExtract: answer };
});

const { applyVerdictsToRun, foldWeb } = await import("../src/tenders/commands.js");
const { buildTendersTodo } = await import("../src/tenders/verdicts.js");
const { emptyTenderManifest, writeTenders } = await import("../src/tenders/run.js");
const { writeRunManifest } = await import("../src/run.js");

function tender(over: Partial<Tender>): Tender {
  return {
    id: "x",
    connectorId: "eu-ted",
    noticeId: "x",
    country: "it",
    kind: "call",
    status: "open",
    title: "Servizio",
    buyer: { name: "Comune di Test", country: "it" },
    cpv: [],
    nature: "services",
    lots: [],
    deadline: "2027-03-01T12:00:00+01:00",
    documentsAccess: "unknown",
    places: [],
    criteria: [],
    awards: [],
    coverage: "above-threshold",
    aliases: [],
    ...over,
  };
}

const PAIR_AB = { keep: "eu-ted:a", drop: "it-other:b", score: 0.7, why: "search time" };
const PAIR_CD = { keep: "eu-ted:c", drop: "it-other:d", score: 0.6, why: "search time" };

function runWithPairs(): string {
  const dir = mkdtempSync(join(tmpdir(), "tenders-pairs-"));
  mkdirSync(dir, { recursive: true });
  const tenders = [
    tender({ id: "eu-ted:a", title: "Fornitura di software gestionale per la biblioteca comunale" }),
    tender({ id: "it-other:b", connectorId: "it-other", title: "Licenze annuali" }),
    tender({ id: "eu-ted:c", title: "Pulizia uffici" }),
    tender({ id: "it-other:d", connectorId: "it-other", title: "Pulizia degli uffici" }),
  ];
  const manifest = emptyTenderManifest("it", { keywords: ["software"] });
  manifest.tenderCounts.pairs = 2;
  writeRunManifest(dir, manifest);
  writeTenders(dir, tenders);
  writeFileSync(join(dir, "TENDERS.todo.json"), JSON.stringify(buildTendersTodo(tenders, [PAIR_AB, PAIR_CD])));
  writeFileSync(
    join(dir, "WEB.todo.json"),
    JSON.stringify({ version: 1, generatedAt: "", why: "", items: [{ country: "it", lang: "it-IT", terms: ["software"], queries: ["q"] }] }),
  );
  return dir;
}

const todoOf = (dir: string) => JSON.parse(readFileSync(join(dir, "TENDERS.todo.json"), "utf8"));
const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

describe("look-alike pairs", () => {
  it("survive the web lane, and a web lead is paired with the API copy of the same call", async () => {
    const dir = runWithPairs();
    const url = "https://comune.example/bando-software";
    site = {
      [url]: {
        title: "Fornitura di software gestionale per la biblioteca comunale",
        text: `Bando di gara. Fornitura di software gestionale per la biblioteca comunale. Scadenza: 01/03/2027 ore 12:00. ${"Testo del bando. ".repeat(20)}`,
      },
    };
    const r = await foldWeb(dir, { hits: [{ url, country: "it", query: "q" }] });
    expect(r.tenders).toHaveLength(1);
    const pairs = todoOf(dir).pairs as { keep: string; drop: string }[];
    expect(pairs.map((p) => `${p.keep}|${p.drop}`)).toEqual(["eu-ted:a|it-other:b", "eu-ted:c|it-other:d", `eu-ted:a|${r.tenders[0]!.id}`]);
    expect(manifestOf(dir).tenderCounts.pairs).toBe(3);
  });

  it("keep the unjudged ones after a partial --apply, and drop the one a verdict settled", () => {
    const dir = runWithPairs();
    applyVerdictsToRun(dir, [{ pair: ["eu-ted:c", "it-other:d"], same: false }]);
    expect(todoOf(dir).pairs).toEqual([PAIR_AB]);
    expect(manifestOf(dir).tenderCounts.pairs).toBe(1);
    // A merge removes the dropped notice, and with it the pair.
    applyVerdictsToRun(dir, [{ pair: ["eu-ted:a", "it-other:b"], same: true }]);
    expect(todoOf(dir).pairs).toEqual([]);
    expect(manifestOf(dir).tenderCounts.pairs).toBe(0);
  });
});
