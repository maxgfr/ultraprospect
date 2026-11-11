// `manifest.counts.dossiers` counts the write-ups that exist.
//
// It stayed 0 on a run with a dossier for every company: the agent saves each
// one by hand to the path `dossier` prints, and no command of ours ever counted
// them. `check` and `render` — the two that run after the writing — now count
// the files on disk for this run's places, from the CLI and from MCP alike.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { createServer } from "../src/engine.js";
import { createAdapter } from "../src/mcp/adapter.js";
import { emptyManifest } from "../src/run.js";
import type { Place, RunManifest } from "../src/types.js";

function place(id: string): Place {
  return { id, name: `Company ${id}`, sources: ["osm"], address: {}, contacts: { emails: [], phones: [], socials: [], people: [] }, jobs: [], pages: [] };
}

function run(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ultraprospect-dossiers-")), "runs", "r");
  mkdirSync(dir, { recursive: true });
  const places = ["osm:n1", "osm:n2", "osm:n3", "osm:n4"].map(place);
  const manifest = emptyManifest("r");
  manifest.counts.places = places.length;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "places.json"), JSON.stringify(places));
  return dir;
}

const dossiers = (dir: string): number => (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as RunManifest).counts.dossiers;

function writeDossier(dir: string, file: string): void {
  mkdirSync(join(dir, "dossiers"), { recursive: true });
  writeFileSync(join(dir, "dossiers", file), "# Company\n\nWorth a call. [M]\n");
}

async function mcp(name: string, args: Record<string, unknown>): Promise<void> {
  await createServer(createAdapter()).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } as never, () => {});
}

describe("the dossier count", () => {
  it("is taken from the files on disk by check and by render", async () => {
    const dir = run();
    writeDossier(dir, "osm_n1.md");
    await main(["check", "--run", dir]);
    expect(dossiers(dir)).toBe(1);

    writeDossier(dir, "osm_n2.md");
    // A file for no place of this run is check's error, not one of its dossiers.
    writeDossier(dir, "osm_n99.md");
    await main(["render", "--run", dir]);
    expect(dossiers(dir)).toBe(2);
  });

  it("is taken by the MCP check and render tools as well", async () => {
    const dir = run();
    writeDossier(dir, "osm_n3.md");
    await mcp("ultraprospect_check", { run: dir });
    expect(dossiers(dir)).toBe(1);
    writeDossier(dir, "osm_n4.md");
    await mcp("ultraprospect_render", { run: dir });
    expect(dossiers(dir)).toBe(2);
  });
});
