// The fan-out, emitted against a run on disk.
//
// Two things are worth pinning here. The first is a filename contract that
// broke silently once: the engine writes each dispatch contract to
// `agents/<role>.md`, and the emitted workflow reads it back by the same role,
// so a key carrying its own extension produces `adjudicator.md.md` and a
// workflow that cannot find its instructions. Nothing fails loudly — the
// subagent simply starts with no contract.
//
// The second is a policy: enrichment must never become a fan-out phase.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitOrchestration } from "../src/orchestrate.js";

let runDir: string;
const ENGINE = "/abs/path/to/ultraprospect.mjs";

function writeRun(pairs: number, placesWithPages: number, toResolve = 3): void {
  writeFileSync(
    join(runDir, "RESOLVE.todo.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "",
      items: Array.from({ length: toResolve }, (_, i) => ({ placeId: `osm:n${i}`, name: `C${i}`, queries: [`C${i} Town`] })),
    }),
  );
  writeFileSync(
    join(runDir, "MATCH.todo.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "",
      pairs: Array.from({ length: pairs }, (_, i) => ({ osmId: `n${i}`, connectorId: "fr-sirene", registryId: `S${i}`, score: 0.5, parts: {}, distanceM: 10 })),
    }),
  );
  writeFileSync(
    join(runDir, "places.json"),
    JSON.stringify(
      Array.from({ length: placesWithPages }, (_, i) => ({
        id: `osm:n${i}`,
        name: `C${i}`,
        sources: ["osm"],
        address: {},
        contacts: { emails: [], phones: [], socials: [], people: [] },
        jobs: [],
        pages: ["P1"],
        score: { total: i, parts: {} },
      })),
    ),
  );
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify({ version: 1 }));
}

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "ultraprospect-orch-"));
  mkdirSync(runDir, { recursive: true });
});
afterEach(() => rmSync(runDir, { recursive: true, force: true }));

describe("emitOrchestration", () => {
  it("writes each contract to agents/<role>.md, matching what the workflow reads", () => {
    writeRun(5, 2);
    const result = emitOrchestration(runDir, ENGINE);
    expect(result.exitCode).toBe(0);

    // The filename the engine wrote…
    const contract = join(runDir, "orchestration", "agents", "adjudicator.md");
    expect(readFileSync(contract, "utf8")).toContain("# Adjudicator");
    expect(result.written.some((f) => f.endsWith("adjudicator.md.md"))).toBe(false);

    // …is the one the workflow resolves.
    const workflow = readFileSync(join(runDir, "orchestration", "match.workflow.mjs"), "utf8");
    expect(workflow).toContain('contract("adjudicator"');
    expect(workflow).toContain("'/orchestration/agents'");
  });

  it("fans match out in batches and dossiers one at a time", () => {
    // A packet carries the full text of every page fetched for a company, so
    // two per context is mostly a way to run out of room in the second.
    writeRun(45, 3);
    emitOrchestration(runDir, ENGINE);
    const match = readFileSync(join(runDir, "orchestration", "match.workflow.mjs"), "utf8");
    const dossier = readFileSync(join(runDir, "orchestration", "dossier.workflow.mjs"), "utf8");
    const batches = JSON.parse(match.match(/const BATCHES = (\[.*?\])\n/s)![1]!);
    expect(batches.flat()).toHaveLength(45);
    expect(Math.max(...batches.map((b: unknown[]) => b.length))).toBeLessThanOrEqual(20);
    const dossierBatches = JSON.parse(dossier.match(/const BATCHES = (\[.*?\])\n/s)![1]!);
    expect(Math.max(...dossierBatches.map((b: unknown[]) => b.length))).toBe(1);
  });

  it("only offers dossiers for companies that have pages to cite", () => {
    // A company with no fetched page has nothing a dossier could be grounded
    // in, and dispatching an agent at it invites a write-up from memory.
    writeRun(1, 0);
    const result = emitOrchestration(runDir, ENGINE);
    const dossierPhase = result.phases.find((p) => p.name === "dossier");
    expect(dossierPhase?.items).toBe(0);
  });

  it("fans out the three judgement phases and NOT enrichment", () => {
    // Policy, not omission. Searching for a company's website is per-company
    // thinking and fans out; reading that website is I/O against other
    // people's servers, and spreading it across subagents multiplies the
    // request rate while the per-host pacing only governs one process.
    writeRun(3, 1);
    const result = emitOrchestration(runDir, ENGINE);
    expect(result.phases.map((p) => p.name)).toEqual(["resolve", "match", "dossier"]);
    expect(result.phases.map((p) => p.name)).not.toContain("enrich");
  });

  it("gives the searcher a contract that says pool everything and tag every hit", () => {
    // The searcher's two failure modes are filtering the pool (which throws
    // away the evidence the engine corroborates with) and guessing a placeId
    // (which is how one company's dossier describes another's website).
    writeRun(3, 1);
    emitOrchestration(runDir, ENGINE);
    const text = readFileSync(join(runDir, "orchestration", "agents", "searcher.md"), "utf8");
    expect(text).toContain("Pool EVERY result");
    expect(text).toContain("Never guess a placeId");
    expect(text.toLowerCase()).toContain("do not fetch");
  });

  it("names the command that produces a missing worklist", () => {
    // Nothing on disk: the run is not ready, and saying so beats an empty
    // workflow over an absent file.
    const result = emitOrchestration(runDir, ENGINE);
    expect(result.phases.every((p) => !p.ready)).toBe(true);
    expect(result.phases.find((p) => p.name === "resolve")!.prerequisite).toContain("resolve --run");
    expect(result.phases.find((p) => p.name === "match")!.prerequisite).toContain("scan");
  });

  it("tells subagents not to write, in every contract", () => {
    writeRun(2, 1);
    emitOrchestration(runDir, ENGINE);
    for (const role of ["searcher", "adjudicator", "writer"]) {
      const text = readFileSync(join(runDir, "orchestration", "agents", `${role}.md`), "utf8");
      expect(text.toLowerCase()).toContain("do not write");
    }
  });

  it("tells the adjudicator to judge on the name that actually scored", () => {
    writeRun(2, 1);
    emitOrchestration(runDir, ENGINE);
    const text = readFileSync(join(runDir, "orchestration", "agents", "adjudicator.md"), "utf8");
    expect(text).toContain("matchedName");
    expect(text).toContain("usually NOT the legal name");
  });

  it("sends each phase to the model its failure mode deserves", () => {
    // The fan-out decides HOW MANY agents; this decides WHICH HEAD. It is the
    // line this file's header already draws, pushed one notch: a searcher runs
    // WebSearch and drops each hit in a basket, and a mis-tagged hit cannot
    // reach the deliverable — the engine fetches the page and keeps it only if
    // it corroborates THAT place. The adjudicator and the writer have no such
    // net under them, and a wrong merge is invisible forever.
    writeRun(45, 5);
    emitOrchestration(runDir, ENGINE);
    const read = (p: string) => readFileSync(join(runDir, "orchestration", `${p}.workflow.mjs`), "utf8");
    expect(read("resolve")).toContain("model: 'haiku'");
    expect(read("match")).toContain("model: 'sonnet'");
    expect(read("dossier")).toContain("model: 'sonnet'");
  });

  it("names the model in every contract and in the runbook, not only in the workflow", () => {
    // `orchestrate` serves three harnesses and only ONE of them reads the
    // emitted workflow. A tiering that lives solely in the .workflow.mjs is
    // absent from the subagent-dispatch path and from --eco — which is exactly
    // where a rule stops applying without anyone noticing.
    writeRun(2, 1);
    emitOrchestration(runDir, ENGINE);
    for (const [role, model] of [
      ["searcher", "haiku"],
      ["adjudicator", "sonnet"],
      ["writer", "sonnet"],
    ]) {
      const text = readFileSync(join(runDir, "orchestration", "agents", `${role}.md`), "utf8");
      expect(text.toLowerCase()).toContain(model);
    }
    expect(readFileSync(join(runDir, "orchestration", "RUNBOOK.md"), "utf8").toLowerCase()).toContain("haiku");
  });

  it("under --eco emits the runbook and contracts but no workflows", () => {
    writeRun(2, 1);
    const result = emitOrchestration(runDir, ENGINE, { eco: true });
    expect(result.written.some((f) => f.endsWith("RUNBOOK.md"))).toBe(true);
    expect(result.written.some((f) => f.endsWith(".workflow.mjs"))).toBe(false);
  });
});
