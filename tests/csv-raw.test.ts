// `--csv-raw`: the formula guard, switched off for a machine reader.
//
// The apostrophe in front of `=…`, `@…`, `+…` and `-…` is the standard defence
// for a file a person opens in a spreadsheet, and a corrupted value for a CRM
// import or a script that parses it: `-Acme-` arrives as `'-Acme-`. The guard
// stays the default; the flag (and `csvRaw` on the MCP render tool) writes the
// cells as they are. A tenders run is refused rather than half-honoured,
// because TENDERS.csv cannot be written raw yet.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { toCsv } from "../src/csv.js";
import { createServer } from "../src/engine.js";
import { createAdapter } from "../src/mcp/adapter.js";
import type { Place } from "../src/types.js";
import { csvField, csvRow } from "../src/util.js";

const FORMULA = '=HYPERLINK("http://evil.example","Click")';

function place(name: string): Place {
  return { id: "osm:n1", name, sources: ["osm"], address: {}, contacts: { emails: [], phones: [], socials: [], people: [] }, jobs: [], pages: [] };
}

function run(manifest: Record<string, unknown>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ultraprospect-csvraw-")), "runs", "r");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "places.json"), JSON.stringify([place(FORMULA)]));
  return dir;
}

const territory = () =>
  run({
    version: 1,
    tool: "ultraprospect",
    toolVersion: "0.0.0",
    builtAt: "2026-08-11T00:00:00.000Z",
    slug: "t",
    target: { query: "Berlin", label: "Berlin", lat: 52.5, lon: 13.4, bbox: [0, 0, 0, 0], source: "nominatim" },
    filters: {},
    lanes: [],
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
    licences: [],
    timings: {},
  });
const tenders = () => run({ version: 1, kind: "tenders", tool: "ultraprospect", slug: "t" });

async function mcp(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const sent: any[] = [];
  await createServer(createAdapter()).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } as never, (m: unknown) => {
    sent.push(m);
  });
  const reply = sent.at(-1);
  if (reply?.error) return { text: JSON.stringify(reply.error), isError: true };
  return { text: (reply?.result?.content ?? []).map((c: any) => c.text ?? "").join("\n"), isError: reply?.result?.isError === true };
}

const guarded = `"'=HYPERLINK(""http://evil.example"",""Click"")"`;
const raw = `"=HYPERLINK(""http://evil.example"",""Click"")"`;

describe("csvField raw", () => {
  it("writes a formula-looking cell unchanged, and still quotes it per RFC 4180", () => {
    expect(csvField("=1+1", { raw: true })).toBe("=1+1");
    expect(csvField("-Acme-", { raw: true })).toBe("-Acme-");
    expect(csvField(FORMULA, { raw: true })).toBe(raw);
    expect(csvRow(["@SUM(A1)", "a,b"], { raw: true })).toBe('@SUM(A1),"a,b"');
    // The default is unchanged.
    expect(csvField("=1+1")).toBe("'=1+1");
  });

  it("reaches PROSPECTS.csv through toCsv", () => {
    expect(toCsv([place(FORMULA)])).toContain(guarded);
    const csv = toCsv([place(FORMULA)], { csvRaw: true });
    expect(csv).toContain(raw);
    expect(csv).not.toContain("'=");
  });
});

describe("render --csv-raw", () => {
  it("writes the CSV unguarded only when asked", async () => {
    const dir = territory();
    await main(["render", "--run", dir]);
    expect(readFileSync(join(dir, "PROSPECTS.csv"), "utf8")).toContain(guarded);
    await main(["render", "--run", dir, "--csv-raw"]);
    expect(readFileSync(join(dir, "PROSPECTS.csv"), "utf8")).toContain(raw);
  });

  it("refuses it on a tenders run instead of guarding TENDERS.csv anyway", async () => {
    await expect(main(["render", "--run", tenders(), "--csv-raw"])).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("--csv-raw") });
  });

  it("is csvRaw on the MCP render tool, with the same refusal", async () => {
    const dir = territory();
    const res = await mcp("ultraprospect_render", { run: dir, csvRaw: true });
    expect(res.isError).toBe(false);
    expect(readFileSync(join(dir, "PROSPECTS.csv"), "utf8")).toContain(raw);

    const refused = await mcp("ultraprospect_render", { run: tenders(), csvRaw: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("csvRaw");
  });
});
