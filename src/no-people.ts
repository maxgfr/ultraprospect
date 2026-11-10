// `--no-people`, held for the life of a run.
//
// The flag is given once, to `scan`, by someone who does not want named
// individuals in the run at all. It used to bind that one command: the names
// were stripped before the first write, and then `enrich` read people off the
// team page and `confirm` attached a register record with its directors, and
// the run that "holds organisation data only" held them again. Nothing said so,
// because each later stage was right by its own lights.
//
// So the choice is recorded where every stage already looks — the manifest —
// and the stages that can bring a person into the run ask this file first.
import { readManifest } from "./engine.js";
import type { RegistryRecord } from "./registry/types.js";
import type { Place, RunManifest } from "./types.js";

/** Whether the run was scanned with `--no-people`, as its manifest records it. */
export function bindsNoPeople(manifest: Pick<RunManifest, "filters"> | undefined): boolean {
  return manifest?.filters?.noPeople === true;
}

/** The same question, for a stage that holds the run directory and not the manifest. */
export function runBindsNoPeople(runDir: string): boolean {
  return bindsNoPeople(readManifest<RunManifest>(runDir));
}

/** A copy of the record with no officer on it; the record itself when it names none. */
export function withoutOfficers(record: RegistryRecord): RegistryRecord {
  return record.officers.length ? { ...record, officers: [] } : record;
}

/** A copy of the place with no named individual on it: no officers, no people read off a page. */
export function withoutPeople(place: Place): Place {
  return {
    ...place,
    registry: place.registry ? withoutOfficers(place.registry) : place.registry,
    contacts: { ...place.contacts, people: [] },
  };
}

/**
 * Take the named individuals back out of a run that was scanned without them.
 *
 * Called by a stage after it has worked and before it persists, so a person the
 * stage found is never written. In place, because the caller writes the same
 * array. Returns how many were removed — 0 for a run that is not bound, which
 * is every run scanned without the flag.
 */
export function holdNoPeople(manifest: Pick<RunManifest, "filters"> | undefined, places: Place[]): number {
  if (!bindsNoPeople(manifest)) return 0;
  let removed = 0;
  for (const place of places) {
    removed += place.contacts.people.length + (place.registry?.officers.length ?? 0);
    place.contacts.people = [];
    if (place.registry) place.registry = withoutOfficers(place.registry);
  }
  return removed;
}

/** The line a stage reports when `holdNoPeople` removed somebody. */
export function noPeopleNote(removed: number): string {
  return `--no-people (recorded at scan): removed ${removed} named individual(s) this stage read; the run still holds organisation data only`;
}
