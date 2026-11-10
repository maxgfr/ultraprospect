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
import { recordKey } from "./registry/types.js";
import { MERGE_HIGH, MERGE_LOW } from "./match.js";
import { extractLegalIds, legalIdCoverage } from "./legal-notice.js";
import { join } from "node:path";
import { readJsonSafe } from "./engine.js";
import { buildMatchTodo } from "./match.js";
import { licencesFor, writeJson, writePlaces, writeRunManifest } from "./run.js";
import { readPageText } from "./run.js";
import type { LaneCoverage, MatchCandidate, MatchTodo, Place, RunManifest } from "./types.js";
import { foldAccents, nameSimilarity, normalizeName, shortLabel, tokenSet } from "./util.js";

export interface ConfirmOptions {
  /** The run's country, from the geocoded target. Decides which connectors apply. */
  countryCode?: string;
  /** The run's territory, used when a place carries no locality of its own. */
  town?: string;
  /** Only work on this many places. Applied AFTER `only`, the order `enrich` and `resolve` use. */
  limit?: number;
  /** Place ids to confirm. Empty or absent means every place that still needs a record. */
  only?: readonly string[];
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
  /**
   * Name lookups left for adjudication; they join MATCH.todo.json. The middle
   * band, and the confident names whose record is filed in another town.
   */
  undecided: MatchCandidate[];
  /** Places that were asked about and came back with nothing. A finding, not a gap. */
  notFound: number;
  /**
   * Places NO authority could be asked about, because every applicable
   * connector failed to answer — a rate limit, an outage, a rejected key.
   *
   * Kept apart from `notFound` for the reason `isHiring: false` is kept apart
   * from `isHiring` absent. A register that answered "no such company" is
   * evidence; a register that never answered is our own loss of reach, and
   * counting the second as the first reports a company as unregistered because
   * we ran out of quota. Companies House permits 600 requests per five minutes,
   * so on a long confirm run this is reachable rather than theoretical.
   */
  notAsked: number;
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

/** A locality as a set of words: accent-folded, lowercased, punctuation dropped. */
function localityWords(raw: string | undefined): Set<string> {
  return tokenSet(
    foldAccents(raw ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim(),
  );
}

/**
 * Do the place and the register record sit in the same postcode or town?
 *
 * `undefined` when the two publish nothing comparable, which is neither answer.
 *
 * This is what `scoreLookup` cannot say. Its score is the NAME's, and a name
 * contained in a longer one scores 0.88 wherever the longer one is filed: on a
 * live Hamburg run "AM GmbH" was handed "AM Holding GmbH", and "Transcargo
 * GmbH" (TCO Transcargo, in the port) "TRANSCARGO Internat. Speditions-GmbH".
 * The agreeing postcode only ever ADDS to that score, so a record filed in
 * another town lost nothing for it.
 *
 * Towns are compared as word sets, one contained in the other, because the two
 * sides spell them differently: OSM says "Berlin", the German register "Berlin
 * (Charlottenburg)", VIES "MILANO MI". The run's territory stands in when the
 * place carries no city of its own — the place was found inside it.
 */
function sameLocality(place: Place, rec: RegistryRecord, town?: string): boolean | undefined {
  const compact = (raw: string | undefined) => (raw ?? "").replace(/\s+/g, "").toUpperCase();
  let comparable = false;

  const myPostcode = compact(place.address.codePostal);
  const theirPostcode = compact(rec.address.codePostal);
  if (myPostcode && theirPostcode) {
    if (myPostcode === theirPostcode) return true;
    comparable = true;
  }

  const mine = localityWords(place.address.commune ?? (town ? shortLabel(town) : undefined));
  const theirs = localityWords(rec.address.commune);
  if (mine.size && theirs.size) {
    const [small, large] = mine.size <= theirs.size ? [mine, theirs] : [theirs, mine];
    if ([...small].every((word) => large.has(word))) return true;
    comparable = true;
  }
  return comparable ? false : undefined;
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
async function verify(
  id: LegalId,
  connectors: readonly RegistryConnector[],
  ctx: ConnectorContext,
): Promise<{ record?: RegistryRecord; asked: string[]; answered: number; silent: Array<{ id: string; why: string }> }> {
  const asked: string[] = [];
  // Asked and ANSWERED are different counts. "We put the question to VIES" is
  // not "VIES replied", and only the second one makes a silence into evidence.
  let answered = 0;
  // The authorities that were asked and did not reply, with what went wrong.
  // A connector THROWS when its upstream failed (see registry/upstream.ts);
  // one that returns `undefined` answered that it holds nothing.
  const silent: Array<{ id: string; why: string }> = [];
  for (const connector of connectors) {
    if (!connector.verifyId) continue;
    if (!connector.countries.includes("*") && !connector.countries.includes(id.countryCode)) continue;
    if (connector.canVerify && !connector.canVerify(id)) continue;
    asked.push(connector.id);
    try {
      const record = await connector.verifyId(id, ctx);
      answered++;
      if (record) return { record, asked, answered, silent };
    } catch (e) {
      // One authority being down must not stop the next one being asked. The
      // lane's coverage records what was reached; a throw here would lose the
      // companies that came after.
      silent.push({ id: connector.id, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return { asked, answered, silent };
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
    notAsked: 0,
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

  // `only` exists because `limit` is a prefix, not a choice. The strongest-first
  // order decides WHICH places a limit keeps, never which ones the caller cares
  // about: on a live Hamburg run of 2 584 offices the sixty-two worth confirming
  // could not be named, and the command without a limit set off on 2 535 name
  // lookups against GLEIF before it was stopped. Narrowing only ever removes
  // work — a place already carrying a record is not asked about again because
  // it was named — and the limit applies after it, as in `enrich` and `resolve`.
  let targets = needsConfirming(places);
  if (opts.only?.length) {
    const wanted = new Set(opts.only);
    targets = targets.filter((p) => wanted.has(p.id));
  }
  if (opts.limit) targets = targets.slice(0, opts.limit);
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

  // One question per identifier per run. A VAT number sits in the footer of
  // every page of a site, and a landlord's on every tenant's: asked per
  // OCCURRENCE, a live Hamburg run put the same number to VIES three times over,
  // at a second each, to be told the same thing. The court travels in the key
  // because a German register number means a different company at each one.
  const verified = new Map<string, ReturnType<typeof verify>>();
  const verifyOnce = (id: LegalId): ReturnType<typeof verify> => {
    const key = [id.kind, id.countryCode, id.value.replace(/[\s.]/g, "").toUpperCase(), id.context ?? ""].join("|");
    let pending = verified.get(key);
    if (!pending) {
      pending = verify(id, selection.confirm, ctx);
      verified.set(key, pending);
    }
    return pending;
  };

  // An authority that failed to answer is named once, with what went wrong.
  // The counts at the end say how many places it cost; without this line
  // nothing says WHICH register was down, and an outage that hit one of three
  // authorities left no trace at all.
  const silentConnectors = new Set<string>();
  const couldNotAsk = (connectorId: string, why: string) => {
    if (silentConnectors.has(connectorId)) return;
    silentConnectors.add(connectorId);
    // A connector's own error already starts with its id; said once is enough.
    const reason = why.startsWith(`${connectorId}: `) ? why.slice(connectorId.length + 2) : why;
    note(`confirm: ${connectorId} failed to answer at least once (${reason}). What it was not asked is kept apart from what it did not find.`);
  };

  for (const place of targets) {
    done++;
    opts.onProgress?.(done, targets.length, place.name);

    // ---- Route 1: an identifier the company published on its own site -------
    let attached: { rec: RegistryRecord; how: string; from?: string; legalId?: string } | undefined;
    const found: NonNullable<Place["legalIds"]> = [];
    // Identifiers an authority answered about by naming a DIFFERENT company.
    // They stay on the record, sourced and unverified, and are kept out of the
    // attested count below.
    const contradicted = new Set<string>();
    // Did ANY authority actually reply about this place, on either route? A
    // place nobody could be asked about is not a place with no register record.
    let anyAnswer = false;
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
        const { record: rec, asked, answered, silent } = await verifyOnce(id);
        for (const failure of silent) couldNotAsk(failure.id, failure.why);
        if (answered > 0) anyAnswer = true;
        if (!rec) {
          // The number was read off a page this run holds, and no authority
          // named its holder. That is a real finding — the identifier is on the
          // record, sourced and re-readable — and it is NOT an identity.
          //
          // The row says who REPLIED, not who was asked. An authority that was
          // down named no holder either, and writing it beside the ones that
          // answered would turn its outage into a finding about the number.
          const down = silent.map((failure) => failure.id);
          const replied = asked.filter((connectorId) => !down.includes(connectorId));
          const court = id.context ? ` (court: ${id.context})` : "";
          found.push({
            kind: id.kind,
            value: id.value,
            from: id.from,
            status: "unverified",
            authority: replied.join(",") || undefined,
            note: !asked.length
              ? "no authority here can check this kind of identifier"
              : !replied.length
                ? `asked ${asked.join(", ")}; none answered, which says nothing about this number${court}`
                : `asked ${replied.join(", ")}; none named a holder${court}${down.length ? `; ${down.join(", ")} did not answer` : ""}`,
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
          contradicted.add(`${id.kind}:${id.value}`);
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
      // Only the identifiers no authority contradicted. This used to count every
      // row that was not verified, the refused ones included, so a German number
      // GLEIF resolved to a company in another Land was reported as "number
      // read, holder not named" — when a holder had been named, and was wrong.
      outcome.attested += place.legalIds.filter((f) => f.status !== "verified" && !contradicted.has(`${f.kind}:${f.value}`)).length;
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
        } catch (e) {
          // Could not ask. Deliberately NOT counted as an answer, so the place
          // does not end up reported as absent from a register that never spoke.
          couldNotAsk(connector.id, e instanceof Error ? e.message : String(e));
          continue;
        }
        anyAnswer = true;
        usedConnectors.add(connector.id);
        let best: { rec: RegistryRecord; score: number; matchedName?: string; nearby?: boolean } | undefined;
        for (const rec of hits) {
          // A name search returns dissolved companies too, and a shopfront that
          // is trading today is not the struck-off company that once shared its
          // name. Route 1 can attach one — a published number is a fact — but a
          // name is only a resemblance.
          if (rec.status === "ceased") continue;
          const { score, matchedName } = scoreLookup(place, rec);
          const nearby = sameLocality(place, rec, opts.town);
          // Between two hits the name cannot separate, the one filed here wins:
          // a register returns every branch of a name, in its own order.
          if (!best || score > best.score || (score === best.score && nearby === true && best.nearby !== true)) best = { rec, score, matchedName, nearby };
        }
        if (!best) continue;
        // The same three bands the sweep matcher uses, and for the same reason:
        // one wrong merge produces a plausible company holding somebody else's
        // registration, and that is invisible downstream forever.
        if (best.score >= MERGE_HIGH && best.nearby === false) {
          // A confident NAME, filed somewhere else. Both sides published where
          // they are and they disagree, so the resemblance is all there is —
          // which is a question for adjudication, not an identity.
          const filedAt = [best.rec.address.codePostal, best.rec.address.commune].filter(Boolean).join(" ");
          note(
            `confirm: ${place.name} resembles "${best.rec.legalName ?? best.rec.names[0]}" by name, but ${best.rec.connectorId} files it at ${filedAt} — not attached, left in MATCH.todo.json`,
          );
          outcome.undecided.push(toCandidate(place, best.rec, best.score, best.matchedName));
        } else if (best.score >= MERGE_HIGH) {
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
    } else if (anyAnswer) {
      outcome.notFound++;
    } else {
      outcome.notAsked++;
    }
  }

  outcome.coverage.returned = outcome.records.length;
  outcome.coverage.connectorId = [...usedConnectors].sort().join(",") || selection.confirm[0]?.id;
  // `notAsked` is only mentioned when it happened. Naming a zero would suggest
  // the run had a reach problem it did not have.
  const unreachable = outcome.notAsked ? `, ${outcome.notAsked} that NO authority could be asked about` : "";
  outcome.coverage.reason = `confirmed one company at a time: ${outcome.verified} by a published registration number, ${outcome.matched} by a name lookup, ${outcome.notFound} not found${unreachable}. This is NOT a sweep — companies absent from OSM are absent from this run.`;
  if (outcome.notAsked) {
    note(
      `confirm: ${outcome.notAsked} place(s) reached no authority at all — every applicable register failed to answer (a rate limit, an outage, a rejected key). They are NOT recorded as having no register entry, because nobody asked.`,
    );
  }

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

/**
 * Fold a confirm outcome into the run on disk.
 *
 * Extracted from `cmdConfirm` so the CLI and the MCP adapter share it rather than
 * each carrying its own copy. The sequence is not incidental — six manifest fields,
 * a merge into `registry.json` that must not replace what a previous pass attached,
 * and an APPEND to `MATCH.todo.json` rather than a second worklist with the same
 * job and a different filename. A second implementation of that would drift on the
 * first change, and the drift would be silent.
 */
export function persistConfirm(runDir: string, places: Place[], manifest: RunManifest, outcome: ConfirmOutcome): void {
  writePlaces(runDir, places);
  const held = mergeRegistryRecords(runDir, outcome.records);
  writeJson(runDir, "registry.json", held);
  if (outcome.undecided.length) {
    const existing = (readJsonSafe(join(runDir, "MATCH.todo.json")) as MatchTodo | undefined)?.pairs ?? [];
    writeJson(runDir, "MATCH.todo.json", buildMatchTodo([...existing, ...outcome.undecided]));
  }

  // Keep a sweep lane (France ran one before this) and replace the non-sweep one.
  manifest.lanes = [...manifest.lanes.filter((l) => l.lane !== "registry" || l.mode === "sweep"), outcome.coverage];
  manifest.counts.registry += outcome.records.length;
  // Added, like every other count here: a second `confirm --limit` pass used to
  // overwrite this with its own total while `registry` above accumulated.
  manifest.counts.confirmed += outcome.verified + outcome.matched;
  manifest.counts.undecided += outcome.undecided.length;
  for (const rec of outcome.records) manifest.counts.byConnector[rec.connectorId] = (manifest.counts.byConnector[rec.connectorId] ?? 0) + 1;
  // From the records the run HOLDS, not only from this pass's lane. The lane is
  // replaced each time, so a later pass that attached nothing dropped the
  // attribution owed for records an earlier pass had written — including the
  // CC-BY notice the German export requires.
  manifest.licences = licencesFor(manifest.lanes, held);
  manifest.notes.push(...outcome.notes);
  writeRunManifest(runDir, manifest);
}

/**
 * Every register record the run holds, this pass's added to the previous ones.
 *
 * A re-run adds rather than replaces: `confirm --limit 50` twice must leave 100
 * records behind, not the last 50.
 */
function mergeRegistryRecords(runDir: string, fresh: readonly RegistryRecord[]): RegistryRecord[] {
  const existing = (readJsonSafe(join(runDir, "registry.json")) as RegistryRecord[] | undefined) ?? [];
  const byKey = new Map<string, RegistryRecord>();
  for (const rec of [...existing, ...fresh]) byKey.set(recordKey(rec), rec);
  return [...byKey.values()];
}
