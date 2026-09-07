// User decisions travel independently of measured signals and fetched facts.
// Imports validate the current source snapshot; exports retain exclusions even
// after another stage refreshes places.json. Nothing here sends outreach.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "./engine.js";
import type { Place } from "./types.js";
import { identityOf } from "./watch.js";

export const FEEDBACK_KINDS = ["wrong-company", "wrong-site", "wrong-contact", "exclude", "useful"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export interface FeedbackSource {
  placeId: string;
  identity: string;
  digest: string;
}
export interface FeedbackEntry {
  id: string;
  source: FeedbackSource;
  kind: FeedbackKind;
  reason: string;
  by: string;
  at: string;
  subject?: { field: string; value: string; from: string; lane?: string };
}
export interface FeedbackLedger {
  schemaVersion: 1;
  entries: FeedbackEntry[];
}

/** The fields the user saw, bound to their recorded upstream identities. */
export function feedbackSource(place: Place): FeedbackSource {
  const identity = identityOf(place);
  const snapshot = { id: place.id, identity, name: place.name, sources: place.sources, website: place.website, contacts: place.contacts };
  return { placeId: place.id, identity, digest: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseLedger(input: unknown): FeedbackLedger {
  if (!record(input) || input.schemaVersion !== 1 || !Array.isArray(input.entries)) throw new Error("feedback needs schemaVersion:1 and an entries array");
  const ids = new Set<string>();
  const entries = input.entries.map((row: unknown): FeedbackEntry => {
    if (
      !record(row) ||
      !text(row.id) ||
      !text(row.reason) ||
      !text(row.by) ||
      !text(row.at) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(row.at) ||
      !Number.isFinite(Date.parse(row.at)) ||
      !FEEDBACK_KINDS.includes(row.kind as FeedbackKind) ||
      !record(row.source) ||
      !text(row.source.placeId) ||
      !text(row.source.identity) ||
      typeof row.source.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.source.digest)
    ) {
      throw new Error("malformed feedback entry: identity, digest, kind, author, reason and ISO timestamp are required");
    }
    if (ids.has(row.id)) throw new Error(`duplicate feedback event id: ${row.id}`);
    ids.add(row.id);
    const subject = row.subject;
    let parsedSubject: FeedbackEntry["subject"];
    if (subject !== undefined) {
      if (!record(subject) || !text(subject.field) || !text(subject.value) || !text(subject.from) || (subject.lane !== undefined && !text(subject.lane)))
        throw new Error(`${row.id}: malformed feedback subject`);
      // JSON object order is not event identity. Canonicalize both imported and
      // stored subjects, retaining only the fields defined by this schema.
      parsedSubject = {
        field: subject.field,
        value: subject.value,
        from: subject.from,
        ...(subject.lane === undefined ? {} : { lane: subject.lane }),
      };
    }
    if ((row.kind === "wrong-site" || row.kind === "wrong-contact") && subject === undefined)
      throw new Error(`${row.id}: this feedback kind requires a sourced subject`);
    if (row.kind !== "wrong-site" && row.kind !== "wrong-contact" && subject !== undefined) throw new Error(`${row.id}: this feedback kind has no subject`);
    return {
      id: row.id,
      source: { placeId: row.source.placeId, identity: row.source.identity, digest: row.source.digest },
      kind: row.kind as FeedbackKind,
      reason: row.reason,
      by: row.by,
      at: row.at,
      ...(parsedSubject === undefined ? {} : { subject: parsedSubject }),
    };
  });
  return { schemaVersion: 1, entries };
}

export function readFeedback(runDir: string): FeedbackLedger {
  const file = join(runDir, "FEEDBACK.json");
  return existsSync(file) ? parseLedger(JSON.parse(readFileSync(file, "utf8"))) : { schemaVersion: 1, entries: [] };
}

function validateSource(entry: FeedbackEntry, places: readonly Place[]): void {
  const matches = places.filter((place) => identityOf(place) === entry.source.identity && place.id === entry.source.placeId);
  if (matches.length !== 1) throw new Error(`${entry.id}: unknown or ambiguous feedback identity`);
  const place = matches[0]!;
  if (feedbackSource(place).digest !== entry.source.digest) throw new Error(`${entry.id}: stale feedback source snapshot; regenerate feedback subjects`);
  const subject = entry.subject;
  if (entry.kind === "wrong-site") {
    if (
      !subject ||
      subject.field !== "website" ||
      subject.lane !== undefined ||
      place.website?.url !== subject.value ||
      !place.website.evidence.includes(subject.from)
    ) {
      throw new Error(`${entry.id}: website subject is not backed by this company's provenance`);
    }
  } else if (entry.kind === "wrong-contact") {
    const contacts = subject && Object.hasOwn(place.contacts, subject.field) ? place.contacts[subject.field as keyof Place["contacts"]] : [];
    if (!subject || !contacts.some((contact) => contact.value === subject.value && contact.from === subject.from && contact.lane === subject.lane)) {
      throw new Error(`${entry.id}: contact subject is not backed by this company's provenance`);
    }
  }
}

/** Validate the whole import before writing once. Replays are idempotent. */
export function importFeedback(runDir: string, places: readonly Place[], input: unknown): FeedbackLedger {
  const incoming = parseLedger(input),
    previous = readFeedback(runDir);
  const byId = new Map(previous.entries.map((entry) => [entry.id, entry]));
  for (const entry of incoming.entries) {
    validateSource(entry, places);
    const existing = byId.get(entry.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error(`${entry.id}: feedback event id conflict`);
    byId.set(entry.id, entry);
  }
  const ledger: FeedbackLedger = { schemaVersion: 1, entries: [...byId.values()] };
  writeArtifact(join(runDir, "FEEDBACK.json"), JSON.stringify(ledger, null, 2) + "\n");
  return ledger;
}

/** Quarantine flagged rows in every export; useful never cancels an exclusion. */
export function feedbackSelection(places: readonly Place[], ledger: FeedbackLedger): Place[] {
  const exclusions = ledger.entries.filter((entry) => entry.kind !== "useful");
  const blocked = new Set(exclusions.map((entry) => entry.source.identity));
  const blockedIds = new Set(exclusions.map((entry) => entry.source.placeId));
  // Confirm can add a stronger registry identity to an existing OSM row.
  // That enrichment must not silently undo its user's export decision.
  return places.filter((place) => !blocked.has(identityOf(place)) && !blockedIds.has(place.id));
}
