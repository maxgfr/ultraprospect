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
import { join } from "node:path";
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
  /**
   * Identifiers an authority confirmed as live without naming their holder.
   *
   * Germany and Spain answer VIES this way. It is not an identity and never
   * becomes one, but it is more than nothing: the number on the page is real.
   */
  attested: number;
  coverage: LaneCoverage;
  notes: string[];
}

/**
 * Places worth asking a register about, STRONGEST ROUTE FIRST.
 *
 * Ordering is not cosmetic here. A place with a fetched page can be confirmed
 * from the registration number its own site publishes — one request, a
 * conclusive answer. A place without one can only be looked up by name, which
 * costs a request per company and, in a country where the only connector is
 * GLEIF, will confirm almost nothing. Doing the cheap conclusive work first
 * means a `--limit` cuts off the speculative half rather than the useful one.
 */
export function needsConfirming(places: readonly Place[]): Place[] {
  const targets = places.filter((p) => !p.registry && Boolean(p.name?.trim()));
  return [...targets].sort((a, b) => (b.pages.length > 0 ? 1 : 0) - (a.pages.length > 0 ? 1 : 0));
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

/**
 * Ask every applicable authority about one identifier, strongest first.
 *
 * Returns WHICH authorities were asked as well as what came back, because
 * "nobody could answer" and "we did not ask" are different findings and the
 * place record has to be able to tell them apart.
 */
async function verify(id: LegalId, connectors: readonly RegistryConnector[], ctx: ConnectorContext): Promise<{ record?: RegistryRecord; asked: string[] }> {
  const asked: string[] = [];
  for (const connector of connectors) {
    if (!connector.verifyId) continue;
    if (!connector.countries.includes("*") && !connector.countries.includes(id.countryCode)) continue;
    asked.push(connector.id);
    try {
      const record = await connector.verifyId(id, ctx);
      if (record) return { record, asked };
    } catch {
      // One authority being down must not stop the next one being asked. The
      // lane's coverage records what was reached; a throw here would lose the
      // companies that came after.
    }
  }
  return { asked };
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
    attested: 0,
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

  // Say what this is going to cost before spending it. A name lookup is one
  // request per company against someone else's public service, and on a dense
  // territory that is thousands of them — most asking about a corner shop that
  // no cross-border register has ever heard of.
  const withPages = targets.filter((p) => p.pages.length > 0).length;
  const speculative = targets.length - withPages;
  if (speculative > 50) {
    note(
      `confirm: ${withPages} place(s) have a fetched page and can be confirmed from the number their own site publishes. The other ${speculative} can only be looked up by name — one request each against ${selection.confirm.map((c) => c.id).join(", ")}. Use --limit ${Math.max(withPages, 50)} to stop after the conclusive ones.`,
    );
  }
  const usedConnectors = new Set<string>();
  let idsFound = 0;
  let done = 0;

  for (const place of targets) {
    done++;
    opts.onProgress?.(done, targets.length, place.name);

    // ---- Route 1: an identifier the company published on its own site -------
    let attached: { rec: RegistryRecord; how: string; from?: string; legalId?: string } | undefined;
    const found: NonNullable<Place["legalIds"]> = [];
    for (const pageId of place.pages) {
      if (attached) break;
      // `place.pages` holds page IDS ("P17"), not paths. The extract lives at
      // pages/<sanitised place id>/<page id>.md, which is how `check` finds it
      // too — reading the id as a path silently found no text at all, and the
      // run reported "no German site published a registration number" while
      // sitting on a fetched Impressum that did.
      const text = readPageText(runDir, join("pages", place.id.replace(/[^a-zA-Z0-9._-]/g, "_"), `${pageId}.md`));
      if (!text) continue;
      for (const id of extractLegalIds(text, opts.countryCode, pageId)) {
        idsFound++;
        const { record: rec, asked } = await verify(id, selection.confirm, ctx);
        if (!rec) {
          // The number was read off a page this run holds, and no authority
          // named its holder. That is a real finding — the identifier is on the
          // record, sourced and re-readable — and it is NOT an identity.
          found.push({
            kind: id.kind,
            value: id.value,
            from: id.from,
            status: "unverified",
            authority: asked.join(",") || undefined,
            note: asked.length
              ? `asked ${asked.join(", ")}; none named a holder${id.context ? ` (court: ${id.context})` : ""}`
              : "no authority here can check this kind of identifier",
          });
          continue;
        }
        // The register answered about SOME company. Check it is this one before
        // believing it: a legal notice can carry a parent group's number, and a
        // shared building's landlord number appears on tenants' pages.
        const { score } = scoreLookup(place, rec);
        if (score < 0.3 && !sharesToken(place, rec)) {
          note(`confirm: ${place.name} published ${id.value}, but the register returned "${rec.names[0]}" — not attached`);
          // Not "attested": the authority named SOMEBODY, and it was not this
          // company. In Germany that is usually the register number's fault
          // rather than the page's — HRA/HRB numbers repeat across courts.
          found.push({
            kind: id.kind,
            value: id.value,
            from: id.from,
            status: "unverified",
            authority: rec.connectorId,
            note: `${rec.connectorId} named "${rec.names[0]}", which is not this company`,
          });
          continue;
        }
        found.push({ kind: id.kind, value: id.value, from: id.from, status: "verified", authority: rec.connectorId, note: id.context });
        attached = { rec, how: "verified-id", from: id.from, legalId: id.value };
        break;
      }
    }
    if (found.length) {
      // One row per identifier, not per page it appeared on: a VAT number in
      // the footer of every page is one fact observed several times, and three
      // identical rows read as three findings.
      const byValue = new Map<string, (typeof found)[number]>();
      for (const f of found) {
        const key = `${f.kind}:${f.value}`;
        const existing = byValue.get(key);
        // Keep the strongest outcome, and with it the page that produced it.
        if (!existing || (existing.status === "unverified" && f.status !== "unverified")) byValue.set(key, f);
      }
      place.legalIds = [...byValue.values()];
      outcome.attested += place.legalIds.filter((f) => f.status !== "verified").length;
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
  note(
    `confirm: ${outcome.verified} verified, ${outcome.matched} matched by name, ${outcome.undecided.length} undecided, ${outcome.notFound} not found, ${outcome.attested} identifier(s) read but not resolved to an identity`,
  );
  return outcome;
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
