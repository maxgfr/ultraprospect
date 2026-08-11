// What changed since last time.
//
// A territory is not a snapshot. Companies open and close, sites get rebuilt,
// and a job posting is the single most actionable thing in the whole file —
// which makes "who started hiring this month" worth more than the list it came
// from. `watch` diffs a fresh run against an earlier one and writes only the
// movement.
//
// It compares RUNS, not live services. Re-fetching to answer "did this change"
// would conflate two questions — what is different, and what is reachable
// today — and an upstream having a bad afternoon would show up as a town full
// of closures.
import { shortLabel } from "./run.js";
import type { Place, RunManifest } from "./types.js";

export interface Delta {
  appeared: Place[];
  disappeared: Place[];
  /** Now marked ceased by the register, having been active before. */
  closed: Place[];
  startedHiring: { place: Place; roles: number }[];
  stoppedHiring: Place[];
  newRoles: { place: Place; titles: string[] }[];
  gotWebsite: Place[];
  siteChanged: { place: Place; before?: string; after?: string }[];
  wentDark: Place[];
}

/**
 * A stable identity across runs.
 *
 * The place id is derived from the OSM node or the SIRET, so it survives a
 * re-scan — but a company that gains a register match between runs changes id
 * from `fr-sirene:…` to `osm:…`. Keying on the register id first, then the OSM id, keeps
 * that company one company rather than one closure and one opening.
 */
export function identityOf(place: Place): string {
  if (place.registry) return `${place.registry.connectorId}:${place.registry.establishmentId ?? place.registry.id}`;
  if (place.osm) return `osm:${place.osm.id}`;
  return place.id;
}

export function diffRuns(before: readonly Place[], after: readonly Place[]): Delta {
  const prev = new Map(before.map((p) => [identityOf(p), p]));
  const next = new Map(after.map((p) => [identityOf(p), p]));

  const delta: Delta = {
    appeared: [],
    disappeared: [],
    closed: [],
    startedHiring: [],
    stoppedHiring: [],
    newRoles: [],
    gotWebsite: [],
    siteChanged: [],
    wentDark: [],
  };

  for (const [key, place] of next) {
    const old = prev.get(key);
    if (!old) {
      delta.appeared.push(place);
      continue;
    }

    if (old.registry?.status === "active" && place.registry?.status === "ceased") delta.closed.push(place);

    const wasHiring = old.signals?.isHiring === true;
    const isHiring = place.signals?.isHiring === true;
    if (!wasHiring && isHiring) delta.startedHiring.push({ place, roles: place.signals?.openRoles ?? 0 });
    // Only when we actually looked both times. An unreadable board flips
    // isHiring to undefined, and calling that "stopped hiring" would invent a
    // change out of our own loss of reach.
    if (wasHiring && place.signals?.isHiring === false) delta.stoppedHiring.push(place);

    if (isHiring) {
      const had = new Set(old.jobs.map((j) => j.title.toLowerCase()));
      const fresh = place.jobs.filter((j) => !had.has(j.title.toLowerCase()));
      if (fresh.length) delta.newRoles.push({ place, titles: fresh.map((j) => j.title) });
    }

    const oldSite = old.website?.confidence === "corroborated" ? old.website.url : undefined;
    const newSite = place.website?.confidence === "corroborated" ? place.website.url : undefined;
    if (!oldSite && newSite) delta.gotWebsite.push(place);
    else if (oldSite && newSite && oldSite !== newSite) delta.siteChanged.push({ place, before: oldSite, after: newSite });

    if (old.signals?.siteReachable === true && place.signals?.siteReachable === false) delta.wentDark.push(place);
  }

  for (const [key, place] of prev) if (!next.has(key)) delta.disappeared.push(place);

  return delta;
}

function section(title: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  return [`## ${title}`, "", ...lines, ""];
}

export function buildDelta(delta: Delta, before: RunManifest, after: RunManifest): string {
  const l: string[] = [];
  l.push(`# What changed — ${shortLabel(after.slug)}`);
  l.push("");
  // "the sweep" was wrong on every run outside France, where the register half
  // was confirmed company by company rather than enumerated. "run" is true in
  // both modes, and the mode itself is in each run's own manifest.
  l.push(`Comparing the run of ${before.builtAt.slice(0, 10)} with the one of ${after.builtAt.slice(0, 10)}.`);
  l.push("");

  if (before.truncated || after.truncated) {
    l.push("> ⚠ **One of these runs is truncated**, so an appearance or a disappearance here");
    l.push("> may be a difference in coverage rather than a change on the ground.");
    l.push("");
  }

  const total =
    delta.appeared.length +
    delta.disappeared.length +
    delta.closed.length +
    delta.startedHiring.length +
    delta.stoppedHiring.length +
    delta.newRoles.length +
    delta.gotWebsite.length +
    delta.siteChanged.length +
    delta.wentDark.length;
  if (total === 0) {
    l.push("Nothing moved.");
    return l.join("\n") + "\n";
  }

  l.push(
    ...section(
      "Started hiring",
      delta.startedHiring.map((x) => `- **${x.place.name}** — ${x.roles} open role(s)${x.place.website ? ` · ${x.place.website.url}` : ""}`),
    ),
  );
  l.push(
    ...section(
      "New roles at companies already hiring",
      delta.newRoles.map((x) => `- **${x.place.name}** — ${x.titles.slice(0, 6).join(", ")}`),
    ),
  );
  l.push(
    ...section(
      "New to the territory",
      delta.appeared.map((p) => `- **${p.name}**${p.address.commune ? ` — ${p.address.commune}` : ""}`),
    ),
  );
  l.push(
    ...section(
      "Now marked ceased by the register",
      delta.closed.map((p) => `- **${p.name}** — ${p.registry?.connectorId ?? "register"} ${p.registry?.establishmentId ?? p.registry?.id ?? "?"}`),
    ),
  );
  l.push(
    ...section(
      "Gone from the sweep",
      delta.disappeared.map((p) => `- ${p.name}`),
    ),
  );
  l.push(
    ...section(
      "Now has a website",
      delta.gotWebsite.map((p) => `- **${p.name}** — ${p.website?.url}`),
    ),
  );
  l.push(
    ...section(
      "Moved their website",
      delta.siteChanged.map((x) => `- **${x.place.name}** — ${x.before} → ${x.after}`),
    ),
  );
  l.push(
    ...section(
      "Stopped hiring",
      delta.stoppedHiring.map((p) => `- ${p.name}`),
    ),
  );
  l.push(
    ...section(
      "Site went unreachable",
      delta.wentDark.map((p) => `- ${p.name} — ${p.website?.url ?? ""}`),
    ),
  );

  l.push("---");
  l.push("");
  l.push("“Gone from the sweep” is not the same as “closed”: a company can drop out because");
  l.push("a filter changed, because an Overpass tile failed, or because a mapper deleted a");
  l.push("node. Only the register can say a business ceased, and that is its own section.");
  return l.join("\n") + "\n";
}
