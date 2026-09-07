import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveRun } from "../src/run.js";
import type { Place } from "../src/types.js";

it("the shipped CLI imports user feedback and preserves exclusions across repeated exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-cli-"));
  const engine = resolve("skills/ultraprospect/scripts/ultraprospect.mjs");
  const cli = (expected: number, ...args: string[]) => {
    const r = spawnSync(process.execPath, [engine, ...args, "--json"], { encoding: "utf8", timeout: 60000 });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(expected);
    return r;
  };
  try {
    cli(0, "scan", "--fixture", resolve("assets/fixtures/vincennes"), "--out", dir);
    const run = resolveRun(dir);
    const original = readFileSync(join(run, "places.json"), "utf8");
    const todo = JSON.parse(cli(0, "feedback", "--run", run).stdout);
    const source = todo.subjects[0].source;
    const event = { id: "territory-user-1", source, kind: "exclude", reason: "Already served by our team", by: "territory owner", at: "2026-09-07T12:00:00Z" };
    const file = join(dir, "user-feedback.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: [event] }));
    cli(0, "feedback", "--run", run, "--apply", file);
    const stored = readFileSync(join(run, "FEEDBACK.json"), "utf8");
    for (let i = 0; i < 2; i++) {
      cli(0, "render", "--run", run);
      const exported = JSON.parse(readFileSync(join(run, "prospects.json"), "utf8")) as Place[];
      expect(exported).toHaveLength((JSON.parse(original) as Place[]).length - 1);
      expect(exported.some((p) => p.id === source.placeId)).toBe(false);
      expect(readFileSync(join(run, "FEEDBACK.json"), "utf8")).toBe(stored);
    }
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: [{ ...event, id: "forged", source: { ...source, identity: "foreign:999" } }] }));
    expect(cli(1, "feedback", "--run", run, "--apply", file).stderr).toContain("unknown");
    expect(readFileSync(join(run, "FEEDBACK.json"), "utf8")).toBe(stored);
    expect(readFileSync(join(run, "places.json"), "utf8")).toBe(original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
