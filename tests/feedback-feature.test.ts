import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll } from "../src/render.js";
import { emptyManifest } from "../src/run.js";
import type { Place } from "../src/types.js";
import { rec } from "./factories.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const place = (): Place => ({
  id: "osm:n1",
  name: "Acme",
  sources: ["osm"],
  osm: { id: "n1", osmType: "node", osmId: 1, lat: 1, lon: 1, tags: { name: "Acme" } },
  address: {},
  website: { url: "https://acme.example", confidence: "declared", evidence: ["osm"] },
  contacts: { emails: [{ value: "hello@acme.example", lane: "osm", from: "osm" }], phones: [], socials: [], people: [] },
  jobs: [],
  pages: [],
});
async function setup() {
  const feedback = await import("../src/feedback.js");
  const dir = mkdtempSync(join(tmpdir(), "prospect-feedback-"));
  dirs.push(dir);
  const company = place();
  const source = feedback.feedbackSource(company);
  const event = { id: "human-1", source, kind: "exclude", reason: "Not in our territory", by: "territory owner", at: "2026-09-07T12:00:00Z" };
  return { ...feedback, dir, company, event };
}

describe("user feedback is a separate, persistent export decision", () => {
  it("imports an exclusion and applies it to every later export without deleting source data", async () => {
    const { importFeedback, dir, company, event } = await setup();
    const snapshot = JSON.stringify(company);
    const ledger = importFeedback(dir, [company], { schemaVersion: 1, entries: [event] });
    expect(ledger.entries).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      const files = buildAll([company], emptyManifest("test"), { runDir: dir }).files;
      expect(JSON.parse(files.find((f) => f.path === "prospects.json")!.content)).toEqual([]);
      expect(files.find((f) => f.path === "PROSPECTS.csv")!.content).not.toContain("Acme");
      expect(files.find((f) => f.path === "FEEDBACK.json")).toBeDefined();
    }
    expect(JSON.stringify(company)).toBe(snapshot);
  });

  it("useful is recorded separately and cannot silently cancel an exclusion", async () => {
    const { importFeedback, dir, company, event } = await setup();
    importFeedback(dir, [company], { schemaVersion: 1, entries: [event] });
    const ledger = importFeedback(dir, [company], { schemaVersion: 1, entries: [{ ...event, id: "human-2", kind: "useful" }] });
    expect(ledger.entries).toHaveLength(2);
    expect(JSON.parse(buildAll([company], emptyManifest("test"), { runDir: dir }).files.find((f) => f.path === "prospects.json")!.content)).toEqual([]);
    expect(company.score).toBeUndefined();
  });

  it("preserves exclusion when confirm adds a stronger registry identity", async () => {
    const { importFeedback, dir, company, event } = await setup();
    importFeedback(dir, [company], { schemaVersion: 1, entries: [event] });
    const confirmed = { ...company, registry: rec({ id: "123456789" }) };
    const exported = buildAll([confirmed], emptyManifest("test"), { runDir: dir }).files;
    expect(JSON.parse(exported.find((f) => f.path === "prospects.json")!.content)).toEqual([]);
  });

  it("accepts genuine website and contact corrections and quarantines the row", async () => {
    const { importFeedback, dir, company, event } = await setup();
    const entries = [
      { ...event, kind: "wrong-site", subject: { field: "website", value: company.website!.url, from: "osm" } },
      { ...event, id: "human-2", kind: "wrong-contact", subject: { field: "emails", value: "hello@acme.example", from: "osm", lane: "osm" } },
    ];
    expect(importFeedback(dir, [company], { schemaVersion: 1, entries }).entries).toHaveLength(2);
    expect(JSON.parse(buildAll([company], emptyManifest("test"), { runDir: dir }).files.find((f) => f.path === "prospects.json")!.content)).toEqual([]);
  });

  it("accepts useful and wrong-company feedback without inferring a new score", async () => {
    const { importFeedback, dir, company, event } = await setup();
    importFeedback(dir, [company], { schemaVersion: 1, entries: [{ ...event, kind: "useful" }] });
    expect(JSON.parse(buildAll([company], emptyManifest("test"), { runDir: dir }).files.find((f) => f.path === "prospects.json")!.content)).toHaveLength(1);
    importFeedback(dir, [company], { schemaVersion: 1, entries: [{ ...event, id: "human-2", kind: "wrong-company" }] });
    expect(JSON.parse(buildAll([company], emptyManifest("test"), { runDir: dir }).files.find((f) => f.path === "prospects.json")!.content)).toHaveLength(0);
  });

  it("reimport is idempotent, but changing a known event id is refused atomically", async () => {
    const { importFeedback, dir, company, event } = await setup();
    importFeedback(dir, [company], { schemaVersion: 1, entries: [event] });
    const before = readFileSync(join(dir, "FEEDBACK.json"), "utf8");
    expect(importFeedback(dir, [company], { schemaVersion: 1, entries: [event] }).entries).toHaveLength(1);
    expect(() => importFeedback(dir, [company], { schemaVersion: 1, entries: [{ ...event, kind: "useful" }] })).toThrow(/conflict/);
    expect(readFileSync(join(dir, "FEEDBACK.json"), "utf8")).toBe(before);
  });

  it("refuses malformed, stale, unknown, foreign and contradictory provenance without writing", async () => {
    const { importFeedback, dir, company, event } = await setup();
    for (const invalid of [
      null,
      { ...event, kind: "maybe" },
      { ...event, by: "" },
      { ...event, at: "yesterday" },
      { ...event, source: { ...event.source, identity: "osm:n999" } },
      { ...event, source: { ...event.source, digest: "0".repeat(64) } },
      { ...event, kind: "wrong-site", subject: { field: "website", value: "https://foreign.example", from: "osm" } },
      { ...event, kind: "wrong-contact", subject: { field: "emails", value: "hello@acme.example", from: "P999", lane: "web" } },
    ]) {
      // A distinct event ID reaches provenance validation, not duplicate-ID rejection.
      const entry = invalid && { ...invalid, id: "invalid-2" };
      expect(() => importFeedback(dir, [company], { schemaVersion: 1, entries: [event, entry] })).toThrow();
      expect(existsSync(join(dir, "FEEDBACK.json"))).toBe(false);
    }
  });

  it("rejects a changed source snapshot even when the stable company ID remains", async () => {
    const { importFeedback, dir, company, event } = await setup();
    const changed = { ...company, name: "A different company name" };
    expect(() => importFeedback(dir, [changed], { schemaVersion: 1, entries: [event] })).toThrow(/stale/);
    expect(existsSync(join(dir, "FEEDBACK.json"))).toBe(false);
  });

  it("a malformed stored ledger blocks exports instead of silently dropping exclusions", async () => {
    const { dir, company } = await setup();
    writeFileSync(join(dir, "FEEDBACK.json"), JSON.stringify({ schemaVersion: 2, entries: [] }));
    expect(() => buildAll([company], emptyManifest("test"), { runDir: dir })).toThrow(/schemaVersion/);
  });

  it("refuses duplicate import IDs and ambiguous current identities", async () => {
    const { importFeedback, dir, company, event } = await setup();
    expect(() => importFeedback(dir, [company], { schemaVersion: 1, entries: [event, event] })).toThrow(/duplicate/);
    expect(() => importFeedback(dir, [company, company], { schemaVersion: 1, entries: [event] })).toThrow(/ambiguous/);
    expect(existsSync(join(dir, "FEEDBACK.json"))).toBe(false);
  });
});
