// The MCP surface, over real JSON-RPC.
//
// It had no tests at all, which is how `confirm` stayed missing from it for a
// whole release: the adapter's tool list was a literal nobody compared against
// anything. These go through the engine's `createServer`, in process — so the
// JSON Schemas are genuinely VALIDATED the way a client's call would be, rather
// than bypassed by calling `callTool` directly.
//
// `global.fetch` is still forbidden by tests/setup.ts, so only the handlers that
// touch neither network nor an ingested snapshot are exercised end to end here.
// That is on purpose: the register logic is covered against its own fixtures, and
// what this file is for is the CONTRACT — names, schemas, refusals, and the shape
// of what comes back.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/engine.js";
import { createAdapter } from "../src/mcp/adapter.js";
import { COMMANDS } from "../src/cli.js";

/** Drive one JSON-RPC call the way a client would, schema validation included. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const server = createServer(createAdapter());
  const sent: any[] = [];
  await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } as never, (m: unknown) => {
    sent.push(m);
  });
  const reply = sent.at(-1);
  if (reply?.error) return { text: JSON.stringify(reply.error), isError: true };
  const content = reply?.result?.content ?? [];
  return { text: content.map((c: any) => c.text ?? "").join("\n"), isError: reply?.result?.isError === true };
}

/** A run directory with just enough on disk to be resolvable. */
function emptyRun(): string {
  const root = mkdtempSync(join(tmpdir(), "ultraprospect-mcp-"));
  const dir = join(root, "runs", "test-run");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      tool: "ultraprospect",
      toolVersion: "0.0.0",
      builtAt: "2026-08-11T00:00:00.000Z",
      slug: "test",
      target: { query: "Berlin", label: "Berlin, Germany", lat: 52.5, lon: 13.4, bbox: [0, 0, 0, 0], countryCode: "de", source: "nominatim" },
      filters: {},
      lanes: [{ lane: "osm", requested: 0, returned: 1, truncated: false }],
      counts: {
        osm: 1,
        registry: 0,
        byConnector: {},
        places: 1,
        merged: 0,
        undecided: 0,
        withWebsite: 0,
        enrichedTier1: 0,
        enrichedTier2: 0,
        confirmed: 0,
        dossiers: 0,
      },
      truncated: false,
      notes: [],
      licences: ["Places and tags: © OpenStreetMap contributors, ODbL"],
      timings: {},
    }),
  );
  writeFileSync(
    join(dir, "places.json"),
    JSON.stringify([
      {
        id: "osm:n1",
        name: "Bäckerei Siebert",
        sources: ["osm"],
        address: { commune: "Berlin" },
        contacts: { emails: [], phones: [], socials: [], people: [] },
        jobs: [],
        pages: [],
      },
    ]),
  );
  return dir;
}

describe("the tool list", () => {
  const tools = createServer(createAdapter()).tools();

  it("serves confirm, which was missing for a whole release", () => {
    // A client could scan Berlin and had no way to attach a register identity at
    // all: the run stopped at OpenStreetMap and nothing said why.
    expect(tools.map((t) => t.name)).toContain("ultraprospect_confirm");
  });

  it("covers every command whose input is FLAGS, and names the exceptions", () => {
    // The rule, asserted rather than described. A new command lands in COMMANDS and
    // this test asks out loud whether it belongs on the MCP surface too.
    const exposed = new Set(tools.map((t) => t.name.replace("ultraprospect_", "")));
    const deliberatelyAbsent = new Set([
      // Take a FILE of considered verdicts about dozens of pairs.
      "match",
      // The client's own WebSearch, and the keyless fallback is measurably weaker.
      "resolve",
      // Emits files for a harness that already has this adapter.
      "orchestrate",
      // Not a pipeline stage: `mcp` IS this, `version` is metadata, `places` and
      // `dossier` are reads with no CLI command of their own.
      "mcp",
      "version",
    ]);
    const missing = [...COMMANDS].filter((c) => !exposed.has(c) && !deliberatelyAbsent.has(c));
    expect(missing, `not on the MCP surface and not listed as deliberately absent: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every tool a schema an argument can be validated against", () => {
    for (const t of tools) {
      expect(t.inputSchema, `${t.name} has no input schema`).toBeTruthy();
      expect((t.inputSchema as any).type).toBe("object");
      expect(Array.isArray((t.inputSchema as any).required), `${t.name} declares no required list`).toBe(true);
      // The descriptions carry the honesty contract into other harnesses, where
      // SKILL.md is not loaded. A terse one there is a rule nobody downstream sees.
      expect(t.description.length, `${t.name}'s description is too thin to carry its caveats`).toBeGreaterThan(80);
    }
  });

  it("keeps the two --apply folds off the surface", () => {
    // A tool call is the wrong shape for handing over forty considered verdicts,
    // and an agent that answers them in one argument is rubber-stamping them.
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("ultraprospect_match");
    expect(names).not.toContain("ultraprospect_resolve");
  });
});

describe("argument validation happens before the handler runs", () => {
  it("rejects a call with no run directory", async () => {
    const res = await call("ultraprospect_check", {});
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/run/i);
  });

  it("rejects an unknown tool by name", async () => {
    const res = await call("ultraprospect_nope", {});
    expect(res.isError).toBe(true);
  });
});

describe("the handlers", () => {
  it("reports what is cached rather than ingesting, when asked to list", async () => {
    const res = await call("ultraprospect_ingest", { list: true });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.text);
    expect(payload).toHaveProperty("cacheDir");
    expect(Array.isArray(payload.snapshots)).toBe(true);
  });

  it("refuses a country whose register publishes no bulk export, and says which do", async () => {
    const res = await call("ultraprospect_ingest", { country: "fr" });
    expect(res.isError).toBe(true);
    // France's register is swept over its API; there is no file to ingest, and the
    // message names the two countries where there is one.
    expect(res.text).toMatch(/gb/);
    expect(res.text).toMatch(/de/);
  });

  it("refuses to confirm a run with no fetched pages, naming the step that comes first", async () => {
    // The same refusal the CLI makes. Without pages the only route left is a name
    // lookup, and a run that quietly fell back to it would fill the same field
    // with weaker evidence under the same name.
    const res = await call("ultraprospect_confirm", { run: emptyRun() });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no legal notice can be read/);
    expect(res.text).toMatch(/tier 1/);
  });

  it("refuses to enrich a run whose websites were never corroborated", async () => {
    const res = await call("ultraprospect_enrich", { run: emptyRun() });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/corroborated website/);
  });

  it("scores a run and says out loud that `fit` is not its job", async () => {
    const res = await call("ultraprospect_score", { run: emptyRun() });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.text);
    expect(payload.ranked[0].name).toBe("Bäckerei Siebert");
    expect(payload.note).toMatch(/judgement/);
  });

  it("renders the deliverables and reports whether the run was truncated", async () => {
    const res = await call("ultraprospect_render", { run: emptyRun() });
    expect(res.isError).toBe(false);
    const payload = JSON.parse(res.text);
    expect(payload.files.some((f: string) => f.endsWith("REPORT.md"))).toBe(true);
    expect(payload.files.some((f: string) => f.endsWith("index.html"))).toBe(true);
    expect(payload.truncated).toBe(false);
  });

  it("returns a where refusal as a RESULT, not as an error", async () => {
    // The caller has to choose between candidates, and the candidates are what
    // they choose from — an error would throw that away. Covered without network
    // by a query the geocoder is never reached for.
    const res = await call("ultraprospect_where", { query: "" });
    // An empty query fails validation rather than reaching the geocoder, which is
    // itself the contract: `str()` refuses before a request is spent.
    expect(res.isError).toBe(true);
  });

  it("lists a run's companies with the truncation flag beside the count", async () => {
    const res = await call("ultraprospect_places", { run: emptyRun() });
    const payload = JSON.parse(res.text);
    expect(payload.total).toBe(1);
    // `truncated` sits next to `total` on purpose: a count read without it is the
    // one number nobody downstream can sanity-check.
    expect(payload).toHaveProperty("truncated");
  });

  it("advises how to shrink a response that got capped", () => {
    // Only useful if it names the argument. "Try again" is not advice.
    const advice = createAdapter().capAdvice ?? {};
    for (const [tool, text] of Object.entries(advice)) {
      expect(text, `${tool}'s cap advice names no argument`).toMatch(/`[^`]+`/);
    }
  });
});
