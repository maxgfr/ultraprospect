// `confirm` — attaching a register identity to companies that were never swept.
//
// In France `scan` enumerates the register over the territory and `match` fuses
// the two lanes. That is not available anywhere else: no other public register
// can be swept without a key. So outside France the register work happens HERE,
// after the websites have been read, one company at a time.
//
// Two routes, and they are not equally strong:
//
//   1. VERIFY AN IDENTIFIER. The company's own legal notice published a
//      registration number — German law, Spanish law, French law and UK law all
//      require it — and an authority confirms that the number is live and says
//      whose it is. Nothing is guessed: the number came off a page this run
//      fetched and can be re-read, and the answer came from the register.
//
//   2. LOOK UP BY NAME. No identifier was published, so the register is asked
//      for the name in the town. The answer is a CANDIDATE, not a fact, and it
//      goes through the same identity-dominant scoring `match.ts` applies to a
//      French sweep — merge above 0.72, undecided in the middle band, and the
//      undecided ones join MATCH.todo.json for the agent. Reusing that scoring
//      is deliberate: a second set of thresholds would drift from the first.
//
// The manifest records `mode: "confirm"` for the lane, and every place records
// which of the two routes attached its record. A reader must be able to tell a
// swept territory from a confirmed one; blurring them would let a Berlin run
// read exactly like a Vincennes run.
import { connectorsFor, noSweepReason, unknownConnectorIds } from "./registry/index.js";
import type { ConnectorContext, LegalId, RegistryConnector, RegistryRecord } from "./registry/types.js";
import { MERGE_HIGH, MERGE_LOW } from "./match.js";
import { extractLegalIds, legalIdCoverage } from "./legal-notice.js";
import { readPageText } from "./run.js";
import type { LaneCoverage, MatchCandidate, Place } from "./types.js";
import { nameSimilarity, normalizeName, tokenSet } from "./util.js";

export interface ConfirmOptions {
  /** The run's country, from the geocoded target. Decides which connectors apply. */
  countryCode?: string;
  /** The run's territory, used when a place carries no locality of its own. */
  town?: string;
  /** Only work on this many places. */
  limit?: number;
  /** Restrict to these connector ids. */
  registryIds?: string[];
  /** Credentials, by connector id. */
  keys?: Record<string, string | undefined>;
  onNote?: (note: string) => void;
  onProgress?: (done: number, total: number, name: string) => void;
}

export interface ConfirmOutcome {
  /** Every register record attached, for `registry.json`. */
  records: RegistryRecord[];
  /** Confirmed by an identifier the company published. */
  verified: number;
  /** Merged from a name lookup the scorer was confident about. */
  matched: number;
  /** Name lookups that landed in the middle band; they join MATCH.todo.json. */
  undecided: MatchCandidate[];
  /** Places that were asked about and came back with nothing. A finding, not a gap. */
  notFound: number;
  coverage: LaneCoverage;
  notes: string[];
}

/** Places worth asking a register about: no register record yet, and a name to ask with. */
export function needsConfirming(places: readonly Place[]): Place[] {
  return places.filter((p) => !p.registry && Boolean(p.name?.trim()));
}

/**
 * The locality to narrow a lookup with.
 *
 * Almost always the difference between one hit and four hundred: "Müller" is a
 * company name in every German town. The place's own city first, then the run's
 * territory — which we always know, because the place was found inside it.
 */
function localityOf(place: Place, fallback?: string): string | undefined {
  return place.address.commune ?? place.address.codePostal ?? fallback;
}

/** Every name worth asking a register for, best first. */
function namesOf(place: Place): string[] {
  const names = [place.osm?.name, place.name].filter((n): n is string => Boolean(n?.trim()));
  return [...new Set(names)];
}

/**
 * Does this register answer describe the company we asked about?
 *
 * A lookup returns what the register thought we meant, which is not the same as
 * what we meant. Without this gate a search for "Le Pain Quotidien" in Berlin
 * that returned "Pain GmbH" would be attached as fact.
 */
function scoreLookup(place: Place, rec: RegistryRecord): { score: number; matchedName?: string } {
  let best = 0;
  let matchedName: string | undefined;
  for (const mine of namesOf(place)) {
    for (const theirs of rec.names) {
      const s = nameSimilarity(mine, theirs);
      if (s > best) {
        best = s;
        matchedName = theirs;
      }
    }
  }
  // A postcode agreement is corroboration, never identity on its own — the same
  // rule the sweep matcher applies to a street address.
  const postcodeAgrees = Boolean(place.address.codePostal && rec.address.codePostal && place.address.codePostal === rec.address.codePostal);
  return { score: postcodeAgrees ? Math.min(1, best + 0.1) : best, matchedName };
}

/** A name-lookup near-miss, in the same shape the sweep matcher produces. */
function toCandidate(place: Place, rec: RegistryRecord, score: number, matchedName: string | undefined): MatchCandidate {
  return {
    osmId: place.id,
    connectorId: rec.connectorId,
    registryId: rec.establishmentId ?? rec.id,
    legalId: rec.establishmentId ? rec.id : undefined,
    registryName: rec.legalName ?? rec.names[0],
    matchedName,
    osmName: place.name,
    score: Number(score.toFixed(4)),
    // A name lookup has no coordinates to reason about, and saying "0 m apart"
    // would be a claim rather than an absence. The parts a lookup cannot
    // measure are reported as zero and `distanceM` as unknown-far.
    parts: { distance: 0, name: Number(score.toFixed(4)), enseigne: 0, address: 0 },
    distanceM: Number.POSITIVE_INFINITY,
  };
}

/** Ask every applicable connector to verify one identifier, strongest connector first. */
async function verify(id: LegalId, connectors: readonly RegistryConnector[], ctx: ConnectorContext): Promise<RegistryRecord | undefined> {
  for (const connector of connectors) {
    if (!connector.verifyId) continue;
    if (!connector.countries.includes("*") && !connector.countries.includes(id.countryCode)) continue;
    try {
      const rec = await connector.verifyId(id, ctx);
      if (rec) return rec;
    } catch {
      // One authority being down must not stop the next one being asked. The
      // lane's coverage records what was reached; a throw here would lose the
      // companies that came after.
    }
  }
  return undefined;
}

export async function runConfirm(runDir: string, places: Place[], opts: ConfirmOptions = {}): Promise<ConfirmOutcome> {
  const notes: string[] = [];
  const note = (n: string) => {
    notes.push(n);
    opts.onNote?.(n);
  };
  const ctx: ConnectorContext = { keys: opts.keys, onNote: note };
  const selection = connectorsFor(opts.countryCode, { only: opts.registryIds, ctx });

  for (const bogus of unknownConnectorIds(opts.registryIds)) {
    note(`--registry: no connector is called ${bogus} — run \`doctor\` for the list`);
  }
  for (const { connector, availability } of selection.unavailable) {
    if (availability.available) continue;
    note(`confirm: ${connector.id} covers this country but cannot run — ${availability.reason}${availability.how ? `. ${availability.how}` : ""}`);
  }

  const outcome: ConfirmOutcome = {
    records: [],
    verified: 0,
    matched: 0,
    undecided: [],
    notFound: 0,
    notes,
    coverage: {
      lane: "registry",
      mode: "confirm",
      requested: 0,
      returned: 0,
      truncated: false,
    },
  };

  if (!selection.confirm.length) {
    outcome.coverage.reason = noSweepReason(opts.countryCode, selection);
    note(`confirm: ${outcome.coverage.reason}`);
    return outcome;
  }

  const coverage = legalIdCoverage(opts.countryCode);
  note(`confirm: ${coverage.note}`);

  const targets = needsConfirming(places).slice(0, opts.limit ?? Number.POSITIVE_INFINITY);
  outcome.coverage.requested = targets.length;
  const usedConnectors = new Set<string>();
  let idsFound = 0;
  let done = 0;

  for (const place of targets) {
    done++;
    opts.onProgress?.(done, targets.length, place.name);

    // ---- Route 1: an identifier the company published on its own site -------
    let attached: { rec: RegistryRecord; how: string; from?: string; legalId?: string } | undefined;
    for (const pageRel of place.pages) {
      if (attached) break;
      const text = readPageText(runDir, pageRel);
      if (!text) continue;
      const pageId = pageIdOf(pageRel);
      for (const id of extractLegalIds(text, opts.countryCode, pageId)) {
        idsFound++;
        const rec = await verify(id, selection.confirm, ctx);
        if (!rec) continue;
        // The register answered about SOME company. Check it is this one before
        // believing it: a legal notice can carry a parent group's number, and a
        // shared building's landlord number appears on tenants' pages.
        const { score } = scoreLookup(place, rec);
        if (score < 0.3 && !sharesToken(place, rec)) {
          note(`confirm: ${place.name} published ${id.value}, but the register returned "${rec.names[0]}" — not attached`);
          continue;
        }
        attached = { rec, how: "verified-id", from: id.from, legalId: id.value };
        break;
      }
    }

    // ---- Route 2: ask the register for the name in the town -----------------
    if (!attached) {
      const query = {
        names: namesOf(place),
        countryCode: opts.countryCode ?? "",
        locality: localityOf(place, opts.town),
        postcode: place.address.codePostal,
        limit: 5,
      };
      for (const connector of selection.confirm) {
        if (!connector.lookup || attached) continue;
        let hits: RegistryRecord[] = [];
        try {
          hits = await connector.lookup(query, ctx);
        } catch {
          continue;
        }
        usedConnectors.add(connector.id);
        let best: { rec: RegistryRecord; score: number; matchedName?: string } | undefined;
        for (const rec of hits) {
          const { score, matchedName } = scoreLookup(place, rec);
          if (!best || score > best.score) best = { rec, score, matchedName };
        }
        if (!best) continue;
        // The same three bands the sweep matcher uses, and for the same reason:
        // one wrong merge produces a plausible company holding somebody else's
        // registration, and that is invisible downstream forever.
        if (best.score >= MERGE_HIGH) {
          attached = { rec: best.rec, how: "name-lookup" };
        } else if (best.score >= MERGE_LOW) {
          outcome.undecided.push(toCandidate(place, best.rec, best.score, best.matchedName));
        }
      }
    }

    if (attached) {
      place.registry = attached.rec;
      place.registryEvidence = { mode: "confirm", how: attached.how, from: attached.from, legalId: attached.legalId };
      place.sources = [...new Set([...place.sources, "registry" as const])];
      // The register's filed address fills the gaps OSM left, never overwrites
      // what a mapper saw at the door — the same precedence the sweep uses.
      place.address = { ...attached.rec.address, ...Object.fromEntries(Object.entries(place.address).filter(([, v]) => v !== undefined && v !== "")) };
      outcome.records.push(attached.rec);
      usedConnectors.add(attached.rec.connectorId);
      if (attached.how === "verified-id") outcome.verified++;
      else outcome.matched++;
    } else {
      outcome.notFound++;
    }
  }

  outcome.coverage.returned = outcome.records.length;
  outcome.coverage.connectorId = [...usedConnectors].sort().join(",") || selection.confirm[0]?.id;
  outcome.coverage.reason = `confirmed one company at a time: ${outcome.verified} by a published registration number, ${outcome.matched} by a name lookup, ${outcome.notFound} not found. This is NOT a sweep — companies absent from OSM are absent from this run.`;

  if (coverage.expected && idsFound === 0 && targets.length > 0) {
    note(
      `confirm: not one of ${targets.length} site(s) published a registration number, though ${opts.countryCode} requires it. Either the legal pages were not fetched (run \`enrich --tier 1\` first) or they were not reachable.`,
    );
  }
  note(`confirm: ${outcome.verified} verified, ${outcome.matched} matched by name, ${outcome.undecided.length} undecided, ${outcome.notFound} not found`);
  return outcome;
}

/** The page id (`P3`) for a stored extract path, so evidence can be cited. */
function pageIdOf(pageRel: string): string | undefined {
  const file = pageRel.split("/").pop() ?? "";
  const m = /^(P\d+)/.exec(file);
  return m?.[1] ?? undefined;
}

/**
 * A weaker agreement than the name scorer's, for the verified-id path.
 *
 * A published registration number is already strong evidence, so the name check
 * that follows it only has to catch the case where the register answered about
 * a plainly different company. One shared distinctive token is enough.
 */
function sharesToken(place: Place, rec: RegistryRecord): boolean {
  const mine = new Set([...tokenSet(normalizeName(place.name))].filter((t) => t.length >= 4));
  if (mine.size === 0) return false;
  for (const theirs of rec.names) {
    for (const t of tokenSet(normalizeName(theirs))) if (t.length >= 4 && mine.has(t)) return true;
  }
  return false;
}
