// The ultraprospect command line.
//
// No shebang here: tsup's `banner` adds one to the bundle. Writing it in the
// source too puts a second `#!` on line 2 of the output, which is a syntax
// error rather than a comment.
//
// Two conventions the whole family shares, and that the agent playbooks rely on:
//
//   * stdout carries the PAYLOAD (JSON, or the one artifact that matters);
//     stderr carries progress, warnings and the next command to run. That split
//     is what makes `ultraprospect where "..." --json | jq` work while a human
//     still sees what happened.
//   * Every stderr message ends by naming the next step, with absolute paths.
//     An installed skill runs far from the user's project, and a relative path
//     in a hint is a path that does not resolve.
//
// Exit codes: 0 ok · 1 a gate failed or nothing was produced · 2 usage, or a
// refusal to guess. Anything non-zero means stop and fix, never present anyway.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
  cacheDir,
  isInvokedDirectly,
  jsonLine,
  parseArgs,
  positionalText,
  setNoWrite,
  writeArtifact,
} from "./engine.js";
import { brandEngine } from "./engine.js";
import { runDoctor } from "./doctor.js";
import { resolveWhere } from "./geocode.js";
import { runScan, writeScan } from "./scan.js";
import { loadFixture, recordFixture } from "./fixture.js";
import { applyVerdicts, type MatchVerdict } from "./match.js";
import { needsConfirming, persistConfirm, runConfirm } from "./confirm.js";
import { CONNECTORS, servesCountry } from "./registry/index.js";
import {
  forgetSnapshot,
  hasSnapshot,
  ingestSnapshot,
  listSnapshots,
  snapshotFreshness,
  staleSnapshots,
  unreadableSnapshots,
  type SnapshotSource,
} from "./snapshot.js";
import { buildResolveTodo, resolveTargets, runResolve, type WebHit } from "./resolve.js";
import { newPageStore } from "./pages.js";
import { enrichable, persistEnrich, runEnrich } from "./enrich.js";
import { applyFit, ranked, scoreAll } from "./score.js";
import { buildDossierPacket, dossierPathFor } from "./dossier.js";
import { formatReport, runCheck } from "./check.js";
import { buildAll } from "./render.js";
import { buildDelta, diffRuns } from "./watch.js";
import { createAdapter } from "./mcp/adapter.js";
import { emitOrchestration } from "./orchestrate.js";
import { runStdioServer, startHttpServer } from "./engine.js";
import type { FitVerdict, PageRole } from "./types.js";
import { DEFAULT_OUT, newRun, readPlaces, requireManifest, resolveRun, shortLabel, writeJson, writePlaces, writeRunManifest } from "./run.js";
import { clampInt, parseBbox, parseDistanceM } from "./util.js";
import { VERSION } from "./version.js";

/**
 * Re-exported for the eval suite, which drives the weekly canaries.
 *
 * `evals/run.mjs` imports from the BUILT BUNDLE rather than from src/, so that
 * what the canary probes is what the skill actually ships. Anything it needs
 * has to leave through this file — the bundle's entry point is cli.ts and tsup
 * exports nothing else.
 *
 * It used to import `politeUa` this way behind a `.catch`, which silently
 * resolved to undefined for as long as that has been there: the bundle never
 * exported it, so every canary ran under the fallback string instead of the
 * User-Agent this tool actually sends. A canary that probes a different client
 * than the one in production is not probing production.
 */
export { CONNECTORS } from "./registry/index.js";
export { politeUa } from "./net.js";
/**
 * Exported because a connector reached through `CONNECTORS` cannot find the
 * cache until somebody brands the engine.
 *
 * `main()` calls this first thing, so every CLI path is branded before it looks
 * at anything. An importer of the bundle is not: `cacheDir()` resolves through
 * the engine's env prefix, and until `configure()` has set that prefix to
 * `ULTRAPROSPECT` the variable the user exported is simply not the variable
 * being read. The snapshot then sits on disk where `ingest` put it while
 * `hasSnapshot` reports there is none — which reads exactly like a broken
 * ingest, and was diagnosed as one.
 *
 * Same failure as `politeUa` above, one layer down: what the bundle withholds,
 * its consumers reimplement wrongly or do without.
 */
export { brandEngine } from "./engine.js";

export const COMMANDS = [
  "where",
  "ingest",
  "scan",
  "match",
  "confirm",
  "resolve",
  "enrich",
  "score",
  "dossier",
  "check",
  "render",
  "watch",
  "orchestrate",
  "mcp",
  "doctor",
  "version",
] as const;

export const VALUE_FLAGS = [
  "where",
  "lat",
  "long",
  "radius",
  "bbox",
  "country",
  "lang",
  "pick",
  "out",
  "run",
  "osm-groups",
  "activity",
  "section",
  "size-band",
  "min-employees",
  "registry",
  "companies-house-key",
  "from-file",
  "max-results",
  "overpass",
  "apply",
  "fixture",
  "record",
  "web-results",
  "limit",
  "roles",
  "terms",
  "terms-on",
  "tier",
  "only",
  "max-pages",
  "concurrency",
  "icp",
  "id",
  "min-score",
  "min-fit",
  "since",
  "transport",
  "port",
  "bind",
  "phase",
] as const;

export const BOOL_FLAGS = [
  "json",
  "no-osm",
  "no-registry",
  "include-ceased",
  "no-people",
  "queries",
  "engine-search",
  "eco",
  "list",
  "forget",
  "check",
  "stdout",
  "help",
  "version",
] as const;

export const HELP = `ultraprospect ${VERSION} — turn a place into a qualified prospect list

USAGE
  ultraprospect <command> [options]

COMMANDS
  where <query>          Resolve a place name to a search area. Refuses to guess when ambiguous.
  ingest --country <cc>  Fetch and index a register's bulk open-data export. Once, then local.
  scan                   Discover every company in the area, from OSM and the country's register.
  match --apply <file>   Fold the agent's adjudication of MATCH.todo.json back into places.json.
  confirm                Check each company against its country's register, outside France's sweep.
  resolve                Find each company's own website and prove it is theirs.
  enrich --tier 1|2      Read those websites: tier 1 on all of them, tier 2 on the ones you pick.
  score                  Rank by measured signals; fold your ICP verdicts in with --apply.
  dossier --id <id>      Print the grounding packet for one company, pages and all.
  check                  The gate: citations resolve, claims are cited, contacts were observed.
  render                 CSV, JSON, report and a self-contained HTML page.
  watch --since <run>    Diff this run against an earlier one: who opened, closed, started hiring.
  orchestrate            Emit the fan-out: one search phase and two judgement phases.
  mcp                    Serve the run over MCP: where, ingest, scan, places, confirm, enrich, score, dossier, check, render, watch, doctor.
  doctor                 Check node, network and every upstream. --country narrows the registers.
  version                Print the version.

TARGETING (scan, where)
  --where <query>        Place name: a town, a street, an address.
  --lat <deg> --long <deg>   Point search. Requires --radius.
  --radius <dist>        Search radius: 800, 800m, 2km. Point searches only.
  --bbox <s,w,n,e>       Explicit bounding box, skipping the geocoder.
  --country <cc>         ISO-3166-1 alpha-2 hint for the geocoder, e.g. fr.
  --lang <code>          Preferred language for geocoder labels.
  --pick <n>             Take the Nth candidate instead of refusing an ambiguous query.

FILTERS (scan)
  --osm-groups <list>    OSM catalogue groups: shop,office,craft,healthcare,amenity,tourism,leisure,club.
  --activity <list>      Activity codes in the register's own scheme, e.g. 62.01Z,70.22Z (NAF, France).
  --section <list>       Section letters in the country's own scheme, e.g. J,M (NACE across Europe).
  --size-band <list>     The register's own headcount band codes, e.g. 11,12,21 (INSEE, France).
  --min-employees <n>    Keep companies with at least n employees, where the register publishes size.
  --include-ceased       Include companies the register marks as ceased. Off by default.
  --max-results <n>      Cap on register rows before the lane declares itself partial (default 3000).
  --no-osm               Skip the OpenStreetMap lane.
  --no-registry          Skip the register lane entirely.
  --registry <ids>       Only these register connectors, e.g. fr-sirene. doctor lists them.
  --overpass <url>       Override the Overpass endpoint instead of rotating mirrors.
  --fixture <dir>        Replay a recorded sweep instead of calling the live lanes. Offline.
  --record <dir>         Write this run's raw lane output as a replayable fixture.

WEBSITE DISCOVERY (resolve)
  --queries              Print the search queries to run, one per line, and stop.
  --web-results <file>   Hits from your own WebSearch: [{url,title,snippet,placeId?}]. "-" reads stdin.
  --engine-search        Fall back to the keyless engines: every query, pooled and rank-fused.
  --limit <n>            Only resolve this many places.
  --only <ids>           Resolve just these place ids, comma-separated. --limit takes a
                         prefix; this takes the ones you actually care about. Narrows
                         --queries too, so the fanned-out worklist matches the fold.

ENRICHMENT (enrich)
  --tier <1|2>           1: home + legal notice on every site. 2: a page per role + the ATS APIs.
  --only <ids>           Enrich just these place ids, comma-separated.
  --roles <list>         Job-title terms YOU care about, e.g. entwickler,developer,engineer.
                         Counted into matched_roles. The engine has no default: it does not
                         know which roles matter to you, and will not invent one.
  --terms <list>         Terms to find VERBATIM in the pages, e.g. freiberuflich,werkvertrag.
                         The engine ships NO vocabulary in any language: translating a concept
                         into a market's own words is your job, not a list frozen into the tool.
                         Each hit is recorded with its page, and the check gate re-reads it.
  --terms-on <roles>     Page roles --terms may be read on. Default: careers. Widen it
                         deliberately (home,about,services) — on a legal page the same words
                         name data processors, and on a services page they name the clients.
  --max-pages <n>        Ceiling on pages fetched per site in tier 2.
  --concurrency <n>      Sites in flight at once. Per-host pacing is separate and always on.

RANKING (score)
  --icp "<text>"         Who you are looking for. Carried into the packets; never scored by the engine.
  --apply <file>         Your fit verdicts: [{id, fit, why, angle}]. "-" reads stdin.

DOSSIER
  --id <place id>        Which company's packet to print. Use --json for the list of ids.

ADJUDICATION (match)
  --apply <file>         A JSON array of {osmId, registryId, connectorId?, merge, why}. "-" reads stdin.

BULK OPEN DATA (ingest)
  --country <cc>         Which country's export to ingest: gb (Companies House, 470 MB),
                         de (Handelsregister via OffeneRegister, 260 MB). Both keyless.
  --list                 What is already in the cache: rows, vintage, size on disk.
  --check                Ask each register whether it has published something newer.
                         Exits 1 when a cache is behind, so a cron can act on it.
  --forget               Delete a country's ingested snapshot.
  --from-file <path>     Index a file already on disk instead of downloading one.
  --limit <n>            Stop after this many rows. For a first look at a new source.

REGISTER CONFIRMATION (confirm)
  --limit <n>            Only confirm this many places.
  --companies-house-key <key>   UK Companies House key. Free, email only. Or set the env var.

DELIVERABLES (render)
  --min-score <n>        Only rows at or above this measured score.
  --min-fit <level>      Only rows you judged strong, possible or weak.

CHANGE (watch)
  --since <dir>          The earlier run to compare against.

FAN-OUT (orchestrate)
  --phase <name>         Emit just one phase: resolve, match or dossier.
  --eco                  Emit only the RUNBOOK and the contracts — the sequential path.
  --list                 Report which phases are ready, as JSON, and emit nothing.

SERVER (mcp)
  --transport <kind>     stdio (default) or http.
  --port <n> --bind <addr>   For the http transport. Loopback only.

OUTPUT
  --out <dir>            Run root. Default ./${DEFAULT_OUT}
  --run <dir>            An existing run directory, or a root whose newest run is taken.
  --json                 Machine-readable payload on stdout.
  --stdout               Produce nothing on disk; stream artifacts instead.
  --no-people            Strip named individuals from the run (register directors included).
  --help                 This text.
  --version              Print the version.

ENVIRONMENT
  ULTRAPROSPECT_CACHE_DIR      Where fetched pages and ingested snapshots are cached.
                               Default <tmpdir>/ultraprospect. "ingest --list" reports the size.
  ULTRAPROSPECT_NO_WRITE=1     Same as --stdout.
  ULTRAPROSPECT_POLITE_DELAY_MS  Per-host delay between requests. Default 400.
  ULTRAPROSPECT_COMPANIES_HOUSE_KEY  UK register key. Free, email only. Same as --companies-house-key.

Data: © OpenStreetMap contributors (ODbL). Register attributions travel per run —
the manifest lists the ones this run actually owes.
`;

const SPEC = { commands: COMMANDS, valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS };

/** Progress and hints. Never stdout: that belongs to the payload. */
function say(message: string): void {
  process.stderr.write(`${message}\n`);
}

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function list(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * `confirm` — attach a register identity to companies no sweep could reach.
 *
 * Runs after `enrich --tier 1`, because the strongest route reads the
 * registration number off the legal-notice page that tier fetches. Ordering
 * matters enough to be enforced rather than documented: without pages, the only
 * route left is a name lookup, and a run that quietly fell back to it would
 * report weaker evidence under the same field.
 */
/**
 * `ingest` — fetch and index a register's bulk open-data export.
 *
 * Driven by the connector table's own `snapshot` declaration, never by a list
 * written here: `CONNECTORS` already decides which register serves which country
 * for the sweep lane, `confirm`, `doctor`, `manifest.licences` and the weekly
 * canary, and this is the sixth reader. Adding a bulk source is a connector edit.
 *
 * Says what it is about to download BEFORE downloading it. Half a gigabyte
 * arriving unannounced has misled somebody about what running a command costs,
 * and the fact that it happens once does not make it invisible.
 */
async function cmdIngest(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  const withSnapshots = CONNECTORS.filter((c) => c.snapshot);

  if (bools.has("list")) {
    const cached = listSnapshots();
    if (bools.has("json")) {
      out(jsonLine({ cacheDir: cacheDir(), snapshots: cached }));
      return EXIT_OK;
    }
    if (cached.length === 0) {
      say("ingest: nothing ingested yet.");
      for (const c of withSnapshots) say(`  available: ${c.id} — ${c.label} (ultraprospect ingest --country ${c.countries[0]})`);
      return EXIT_OK;
    }
    for (const m of cached) {
      const stale = m.toolVersion !== VERSION ? "  (old mapping)" : "";
      out(
        `${m.connectorId.padEnd(22)} ${String(m.rows).padStart(9)} records  ${(m.bytesOnDisk / 1e6).toFixed(0).padStart(5)} MB  vintage ${m.lastModified ?? m.vintage ?? "unknown"}${stale}`,
      );
    }
    // Records are mapped at ingest time, so a connector fix never reaches a cache
    // built before it. Named rather than rebuilt: half a gigabyte is the
    // operator's call to spend, and saying nothing is the worse half of it.
    // A wrong LAYOUT is worse than an old mapper: the shards cannot be read
    // correctly at all, and the only symptom is a lookup that finds nothing.
    for (const m of unreadableSnapshots()) {
      say(
        `  ${m.connectorId}: written in on-disk layout ${m.layoutVersion ?? 1}, which THIS build cannot read correctly — verifyId will find nothing in it. Re-run \`ingest --country <cc>\`.`,
      );
    }
    for (const m of staleSnapshots().filter((m) => (m.layoutVersion ?? 1) === 2)) {
      say(
        `  ${m.connectorId}: indexed by ultraprospect ${m.toolVersion || "(unstamped)"}, now ${VERSION}. Its records carry the OLD mapping — re-run \`ingest --country <cc>\` to pick up connector fixes.`,
      );
    }
    say("");
    say(`  cache: ${cacheDir()}`);
    return EXIT_OK;
  }

  if (bools.has("check")) {
    // One HEAD per ingested source. The other half of `--list`: that says what the
    // cache HOLDS, this says whether the register has moved on since.
    const results = [];
    for (const connector of withSnapshots) {
      if (!hasSnapshot(connector.id)) continue;
      results.push(await snapshotFreshness(connector.id, connector.snapshot as SnapshotSource));
    }
    if (bools.has("json")) {
      out(jsonLine({ snapshots: results }));
      return results.some((r) => r.behind) ? EXIT_FAILURE : EXIT_OK;
    }
    if (results.length === 0) {
      say("ingest --check: nothing ingested yet, so there is nothing to compare.");
      return EXIT_OK;
    }
    for (const r of results) out(`${r.behind ? "STALE" : "ok   "}  ${r.connectorId.padEnd(22)} ${r.detail}`);
    const behind = results.filter((r) => r.behind);
    if (behind.length) {
      say("");
      for (const r of behind) say(`  re-run: ultraprospect ingest --country <cc>   # ${r.connectorId}`);
      // Non-zero so a cron or a script can act on it, which is the point of asking.
      return EXIT_FAILURE;
    }
    return EXIT_OK;
  }

  const country = values.country?.trim().toLowerCase();
  if (!country) {
    throw new UsageError(`ingest needs --country <cc>, or --list. Countries with a bulk export: ${withSnapshots.map((c) => c.countries.join("/")).join(", ")}`);
  }
  const applicable = withSnapshots.filter((c) => servesCountry(c, country));
  if (applicable.length === 0) {
    // Not a failure of this tool. Most registers publish no bulk export at all,
    // and saying which countries do is more use than an error code.
    say(`ingest: no register serving ${country} publishes a bulk open-data export.`);
    for (const c of withSnapshots) say(`  available: ${c.countries.join("/")} — ${c.id}`);
    return EXIT_USAGE;
  }

  if (bools.has("forget")) {
    for (const c of applicable) say(`ingest: ${forgetSnapshot(c.id) ? "forgot" : "nothing cached for"} ${c.id}`);
    return EXIT_OK;
  }

  for (const connector of applicable) {
    const meta = await ingestSnapshot(connector.id, connector.snapshot as SnapshotSource, {
      limit: values.limit ? clampInt(values.limit, 1, 100_000_000, 1000) : undefined,
      fromFile: values["from-file"],
      onNote: (n) => say(`  ${n}`),
      onProgress: (rows) => say(`  ingest: ${rows} records indexed…`),
    });
    if (bools.has("json")) out(jsonLine(meta));
  }
  say("");
  say(`next: ultraprospect scan --where "<place>" --country ${country}`);
  return EXIT_OK;
}

async function cmdConfirm(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("confirm needs --run <dir>");
  const runDir = resolveRun(values.run);
  const manifest = requireManifest(runDir);
  const places = readPlaces(runDir);
  const country = manifest.target.countryCode;

  const targets = needsConfirming(places);
  if (targets.length === 0) {
    say("confirm: every place already carries a register record — nothing to do");
    if (bools.has("json")) out(jsonLine({ run: runDir, verified: 0, matched: 0, undecided: 0, notFound: 0 }));
    return EXIT_OK;
  }

  const withPages = targets.filter((p) => p.pages.length > 0).length;
  if (withPages === 0) {
    // Refuse rather than do the weak half silently. The published-identifier
    // route is what makes this command worth running outside France, and a run
    // that skipped it would fill the same field with name guesses.
    say(`confirm: none of the ${targets.length} place(s) has a fetched page, so no legal notice can be read.`);
    say(`  run: ultraprospect resolve --run ${runDir} --web-results hits.json`);
    say(`  then: ultraprospect enrich --run ${runDir} --tier 1`);
    throw Object.assign(new Error("no pages to read a legal notice from"), { exitCode: EXIT_USAGE, handled: true });
  }

  say(`ultraprospect: confirming ${targets.length} place(s) against the register for ${country ?? "an unknown country"}`);
  const outcome = await runConfirm(runDir, places, {
    countryCode: country,
    town: manifest.target.label,
    limit: values.limit ? clampInt(values.limit, 1, 100_000, 200) : undefined,
    registryIds: list(values.registry),
    keys: connectorKeys(values),
    onNote: (n) => say(`  ${n}`),
    onProgress: (done, total, name) => {
      if (done % 10 === 0 || done === total) say(`  confirm: ${done}/${total} — ${name}`);
    },
  });

  // The fold lives in src/confirm.ts, so the MCP adapter performs the identical
  // sequence rather than carrying a second copy of it.
  persistConfirm(runDir, places, manifest, outcome);

  if (bools.has("json")) {
    out(
      jsonLine({
        run: runDir,
        verified: outcome.verified,
        matched: outcome.matched,
        attested: outcome.attested,
        undecided: outcome.undecided.length,
        notFound: outcome.notFound,
        notAsked: outcome.notAsked,
      }),
    );
  }
  say("");
  say(`  verified by a published number   ${outcome.verified}`);
  say(`  matched by a name lookup         ${outcome.matched}`);
  say(`  number read, holder not named    ${outcome.attested}`);
  say(`  undecided (in MATCH.todo.json)   ${outcome.undecided.length}`);
  say(`  no register record found         ${outcome.notFound}`);
  // Printed only when it happened, and worded so it cannot be read as the line
  // above it: one is the register's answer, the other is our failure to get one.
  if (outcome.notAsked) say(`  NO authority could be asked      ${outcome.notAsked}  (not the same as not found)`);
  say("");
  say("  This is a per-company confirmation, not a territory sweep: a company");
  say("  that is not in OpenStreetMap is not in this run at all.");
  if (outcome.undecided.length) say(`next: ultraprospect orchestrate --run ${runDir} --phase match`);
  else say(`next: ultraprospect score --run ${runDir}`);
  return EXIT_OK;
}

/**
 * Credentials for the connectors that need one, from flag or environment.
 *
 * A flag beats the environment, and an absent key is not an error here: the
 * connector reports itself unavailable with the steps to fix it, and the run
 * continues without pretending the country has no register.
 */
function connectorKeys(values: Record<string, string>): Record<string, string | undefined> {
  const keys: Record<string, string | undefined> = {};
  for (const connector of CONNECTORS) {
    if (!connector.needsKey) continue;
    const flag = connector.needsKey.flag.replace(/^--/, "");
    keys[connector.id] = values[flag] ?? process.env[connector.needsKey.env];
  }
  return keys;
}

/** Build the geographic target from whatever targeting flags were given. */
async function targetFrom(values: Record<string, string>, positional: string) {
  const radiusM = values.radius ? parseDistanceM(values.radius) : undefined;
  if (values.radius && radiusM === undefined) throw new UsageError(`--radius "${values.radius}" is not a distance (try 800, 800m, 2km)`);

  if (values.bbox) {
    const bbox = parseBbox(values.bbox);
    if (!bbox) throw new UsageError(`--bbox "${values.bbox}" is not "south,west,north,east" with south<north and west<east`);
    const [s, n, w, e] = bbox;
    return {
      query: values.bbox,
      label: `bbox ${values.bbox}`,
      lat: (s + n) / 2,
      lon: (w + e) / 2,
      bbox,
      countryCode: values.country?.toLowerCase(),
      source: "nominatim" as const,
    };
  }

  if (values.lat && values.long) {
    const lat = Number.parseFloat(values.lat);
    const lon = Number.parseFloat(values.long);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new UsageError("--lat and --long must be decimal degrees");
    if (!radiusM) throw new UsageError("a point search needs --radius (try --radius 800m)");
    return {
      query: `${lat},${lon}`,
      label: `${lat},${lon} within ${radiusM} m`,
      lat,
      lon,
      bbox: [lat, lat, lon, lon] as [number, number, number, number],
      countryCode: values.country?.toLowerCase(),
      source: "nominatim" as const,
      radiusM,
    };
  }

  const query = values.where ?? positional;
  if (!query) throw new UsageError("say where to look: --where <place>, or --lat/--long with --radius, or --bbox");

  const result = await resolveWhere(query, {
    country: values.country,
    lang: values.lang,
    pick: values.pick ? clampInt(values.pick, 1, 5, 1) : undefined,
    radiusM,
  });
  if (!result.ok) {
    say(`ultraprospect: ${result.reason}`);
    for (const [i, c] of result.candidates.entries()) {
      say(`  ${i + 1}. ${c.label}  [${c.kind}]  ${c.lat.toFixed(5)},${c.lon.toFixed(5)}`);
    }
    if (result.candidates.length) say(`\nnext: re-run with --pick <n>, or give a more specific query (add the département, the postcode, or the country)`);
    // Refusing to choose is a deliberate outcome, not a crash: exit 2 is "you
    // must decide", the same code every other refusal in the family uses.
    throw Object.assign(new Error(result.reason), { exitCode: EXIT_USAGE, handled: true });
  }
  return result.target;
}

async function cmdWhere(values: Record<string, string>, bools: ReadonlySet<string>, positional: string): Promise<number> {
  const target = await targetFrom(values, positional);
  if (bools.has("json")) {
    out(jsonLine(target));
  } else {
    out(`${target.label}`);
    out(`  centre   ${target.lat.toFixed(6)}, ${target.lon.toFixed(6)}`);
    out(`  bbox     ${target.bbox.map((n) => n.toFixed(5)).join(", ")}  (south, north, west, east)`);
    if (target.osmType && target.osmId) out(`  osm      ${target.osmType}/${target.osmId}`);
    if (target.codeCommune) out(`  commune  INSEE ${target.codeCommune}`);
    if (target.countryCode) out(`  country  ${target.countryCode}`);
  }
  say(`\nnext: ultraprospect scan --where ${JSON.stringify(target.query)}`);
  return EXIT_OK;
}

async function cmdScan(values: Record<string, string>, bools: ReadonlySet<string>, positional: string): Promise<number> {
  // A fixture carries the target it was recorded for. Geocoding again would be
  // a live call in what is meant to be an offline run, and would resolve
  // against today's Nominatim rather than the one the sweep was recorded with.
  const target = values.fixture ? loadFixture(values.fixture).target : await targetFrom(values, positional);
  say(`ultraprospect: scanning ${target.label}`);

  const outcome = await runScan(target, {
    osmGroups: list(values["osm-groups"]),
    activityCodes: list(values.activity),
    sections: list(values.section),
    sizeBands: list(values["size-band"]),
    minEmployees: values["min-employees"] ? clampInt(values["min-employees"], 0, 100_000, 0) : undefined,
    includeCeased: bools.has("include-ceased"),
    noOsm: bools.has("no-osm"),
    noRegistry: bools.has("no-registry"),
    registryIds: list(values.registry),
    keys: connectorKeys(values),
    maxResults: values["max-results"] ? clampInt(values["max-results"], 1, 10_000, 3000) : undefined,
    overpass: values.overpass,
    fixture: values.fixture,
    noPeople: bools.has("no-people"),
    onNote: (n) => say(`  ${n}`),
  });

  const run = newRun(values.out ?? DEFAULT_OUT, target.label || target.query);
  writeScan(run.dir, outcome);
  if (values.record) {
    recordFixture(values.record, outcome, target);
    say(`  recorded a replayable fixture in ${values.record}`);
  }

  const c = outcome.manifest.counts;
  if (bools.has("json")) {
    out(jsonLine({ run: run.dir, counts: c, truncated: outcome.manifest.truncated, lanes: outcome.manifest.lanes }));
  } else {
    out(run.dir);
  }

  const registerLane = outcome.manifest.lanes.find((l) => l.lane === "registry");
  say("");
  say(`  OSM              ${c.osm}`);
  if (registerLane?.mode === "sweep") {
    say(`  register         ${c.registry}  (${registerLane.connectorId})`);
    say(`  fused places     ${c.places}  (${c.merged} matched across both lanes)`);
  } else {
    // Saying "register 0" here would read as an empty register rather than as a
    // register that cannot be swept. The distinction is the whole point.
    say(`  register         not swept — ${registerLane?.reason ?? "no connector"}`);
    say(`  places           ${c.places}  (OSM only, so far)`);
  }
  say(`  with a website   ${c.withWebsite}`);
  if (outcome.manifest.truncated) {
    say("");
    say("  ⚠ TRUNCATED — this run does NOT cover the whole territory:");
    for (const lane of outcome.manifest.lanes.filter((l) => l.truncated)) say(`      ${lane.lane}: ${lane.reason}`);
    say("      narrow with --section / --activity / --min-employees, or raise --max-results");
  }
  say("");
  say(`next: ultraprospect resolve --run ${run.dir}`);
  return c.places > 0 ? EXIT_OK : EXIT_FAILURE;
}

async function cmdMatch(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("match needs --run <dir>");
  if (!values.apply) throw new UsageError('match needs --apply <file> (a JSON array of {osmId, registryId, merge}), or "-" for stdin');
  const runDir = resolveRun(values.run);

  const raw = values.apply === "-" ? readFileSync(0, "utf8") : readFileSync(values.apply, "utf8");
  let verdicts: MatchVerdict[];
  try {
    const parsedJson = JSON.parse(raw);
    verdicts = Array.isArray(parsedJson) ? parsedJson : (parsedJson?.verdicts ?? []);
  } catch (e) {
    throw new UsageError(`--apply ${values.apply} is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    throw new UsageError("--apply contained no verdicts — expected [{osmId, registryId, merge, why}, ...]");
  }

  const places = readPlaces(runDir);
  const before = places.length;
  const result = applyVerdicts(places, verdicts);
  writePlaces(runDir, places);

  const manifest = requireManifest(runDir);
  manifest.counts.places = places.length;
  manifest.counts.merged += result.merged;
  manifest.counts.undecided = Math.max(0, manifest.counts.undecided - verdicts.length);
  manifest.notes.push(`match: folded ${verdicts.length} adjudication(s) — ${result.merged} merged, ${result.skipped} kept apart`);
  writeRunManifest(runDir, manifest);

  if (bools.has("json")) out(jsonLine({ run: runDir, ...result, places: places.length }));
  say(`match: ${result.merged} merged, ${result.skipped} kept apart, ${before} -> ${places.length} places`);
  if (result.unknown.length) {
    // A verdict naming a pair that is not in this run is a mistake worth
    // surfacing loudly: it usually means the file came from a different run.
    say(`match: ${result.unknown.length} verdict(s) named a pair this run does not have:`);
    for (const u of result.unknown.slice(0, 10)) say(`    ${u}`);
    say(`next: check that --apply matches ${runDir}/MATCH.todo.json`);
    return EXIT_FAILURE;
  }
  say(`next: ultraprospect resolve --run ${runDir}`);
  return EXIT_OK;
}

async function cmdResolve(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("resolve needs --run <dir>");
  const runDir = resolveRun(values.run);
  const places = readPlaces(runDir);
  const limit = values.limit ? clampInt(values.limit, 1, 100_000, 50) : undefined;
  const selection = { only: list(values.only), limit };
  const targets = resolveTargets(places, selection);

  // The queries lane: the engine sizes the sweep, the agent runs its own
  // WebSearch, and the hits come back through --web-results. The engine never
  // pretends to be a search engine.
  if (bools.has("queries")) {
    // The run's own town backfills a place that has no address of its own —
    // most OSM nodes have no addr:city, and a bare shop name is not a query.
    const manifest = requireManifest(runDir);
    const town = shortLabel(manifest.target.label);
    const todo = buildResolveTodo(places, town, manifest.target.countryCode, selection);
    // The selection is already applied — `buildResolveTodo` takes it, so the
    // worklist and the fold work on the same places by construction.
    const plan = todo.items;
    // Written as a worklist, not just printed: that is what makes the lane
    // fannable by `orchestrate`, and website discovery is the stage that
    // decides whether a run has any content at all.
    writeJson(runDir, "RESOLVE.todo.json", todo);
    if (bools.has("json")) out(jsonLine(plan));
    else for (const item of plan) for (const q of item.queries) out(q);
    say("");
    say(`resolve: ${plan.length} place(s) need a website, ${plan.reduce((n, p) => n + p.queries.length, 0)} quer(y|ies) to run.`);
    say(`  worklist: ${join(runDir, "RESOLVE.todo.json")}`);
    say("  Run your own WebSearch once per query. Pool EVERY hit into ONE JSON array,");
    say('  duplicates and all: [{"url": "…", "title": "…", "snippet": "…", "placeId": "…"}]');
    say(`next: ultraprospect resolve --run ${runDir} --web-results <file>`);
    say(`  or fan it out:  ultraprospect orchestrate --run ${runDir} --phase resolve`);
    return EXIT_OK;
  }

  let webResults: WebHit[] | undefined;
  if (values["web-results"]) {
    const raw = values["web-results"] === "-" ? readFileSync(0, "utf8") : readFileSync(values["web-results"], "utf8");
    try {
      const parsed = JSON.parse(raw);
      webResults = Array.isArray(parsed) ? parsed : (parsed?.hits ?? []);
    } catch (e) {
      throw new UsageError(`--web-results is not valid JSON: ${(e as Error).message}`);
    }
  }

  // Refuse rather than do almost nothing.
  //
  // Without hits, resolve can only re-check the websites OSM already had — on a
  // real Vincennes sweep that is 11 corroborated sites out of 1164, reported as
  // "992 left without a site", which reads as a territory with no web presence
  // instead of as a search nobody ran. The searching is the agent's half of
  // this lane, and silently skipping it produces a confidently empty run.
  if (!webResults?.length && !bools.has("engine-search") && targets.length > 0) {
    say(`resolve: ${targets.length} place(s) need a website and no search results were supplied.`);
    say("  This lane is YOUR WebSearch. Without it, only the handful of sites OSM already");
    say("  tagged can be checked, and the run will look like a territory with no websites.");
    say("");
    say(`next: ultraprospect resolve --run ${runDir} --queries        # the queries to run`);
    say(`  then: ultraprospect resolve --run ${runDir} --web-results hits.json`);
    say(`  or:   ultraprospect resolve --run ${runDir} --engine-search  # keyless fallback, still weaker than your own WebSearch`);
    throw Object.assign(new Error("no search results supplied"), { exitCode: EXIT_USAGE, handled: true });
  }

  const store = newPageStore(places.flatMap((p) => p.pages.map((id) => ({ id }) as any)));
  const runManifest = requireManifest(runDir);
  const outcome = await runResolve(runDir, places, store, {
    webResults,
    town: shortLabel(runManifest.target.label),
    countryCode: runManifest.target.countryCode,
    lang: values.lang,
    ...selection,
    useEngineSearch: bools.has("engine-search"),
    onNote: (n) => say(`  ${n}`),
    onProgress: (done, total, name) => {
      if (done % 10 === 0 || done === total) say(`  resolve: ${done}/${total} — ${name}`);
    },
  });

  writePlaces(runDir, places);
  const manifest = requireManifest(runDir);
  manifest.counts.withWebsite = places.filter((p) => p.website?.confidence === "corroborated").length;
  manifest.notes.push(...outcome.notes);
  writeRunManifest(runDir, manifest);

  if (bools.has("json")) {
    out(
      jsonLine({
        run: runDir,
        corroborated: outcome.corroborated,
        rejected: outcome.rejected,
        unreadable: outcome.unreadable,
        socials: outcome.socials,
        unchanged: outcome.unchanged,
      }),
    );
  }
  say("");

  // The exit code and the last line have to agree.
  //
  // Nothing corroborated means enrichment has nothing to read, so printing
  // `next: enrich` under a failing exit code sends the reader at a command that
  // will only tell them the same thing again. Say what actually comes next: more
  // search results.
  const ok = outcome.corroborated > 0 || outcome.unchanged === 0;
  if (ok) {
    say(`next: ultraprospect enrich --run ${runDir} --tier 1`);
  } else {
    say("resolve: no website was corroborated, so there is nothing for `enrich` to read.");
    say(`next: ultraprospect resolve --run ${runDir} --queries        # search those, then pass the hits back`);
    say(`  then: ultraprospect resolve --run ${runDir} --web-results hits.json`);
  }
  return ok ? EXIT_OK : EXIT_FAILURE;
}

async function cmdEnrich(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("enrich needs --run <dir>");
  const tier = values.tier ? clampInt(values.tier, 1, 2, 1) : 1;
  const runDir = resolveRun(values.run);
  const places = readPlaces(runDir);

  if (enrichable(places).length === 0) {
    say("enrich: no place has a corroborated website yet.");
    say(`next: ultraprospect resolve --run ${runDir} --queries`);
    return EXIT_FAILURE;
  }

  const store = newPageStore(places.flatMap((p) => p.pages.map((id) => ({ id }) as any)));
  const outcome = await runEnrich(runDir, places, store, {
    tier: tier as 1 | 2,
    limit: values.limit ? clampInt(values.limit, 1, 100_000, 20) : undefined,
    only: list(values.only),
    roleFilter: list(values.roles),
    termLexicon: list(values.terms),
    termRoles: list(values["terms-on"]) as PageRole[] | undefined,
    maxPages: values["max-pages"] ? clampInt(values["max-pages"], 1, 40, 9) : undefined,
    concurrency: values.concurrency ? clampInt(values.concurrency, 1, 12, 4) : undefined,
    onNote: (n) => say(`  ${n}`),
    onProgress: (done, total, name) => {
      if (done % 5 === 0 || done === total) say(`  enrich: ${done}/${total} — ${name}`);
    },
  });

  persistEnrich(runDir, places, tier as 1 | 2, outcome);

  if (bools.has("json")) out(jsonLine({ run: runDir, tier, ...outcome, notes: undefined }));
  say("");
  say(
    tier === 1
      ? `next: ultraprospect enrich --run ${runDir} --tier 2 --limit 20`
      : `next: ultraprospect score --run ${runDir} --icp "<who you are looking for>"`,
  );
  return outcome.enriched > 0 ? EXIT_OK : EXIT_FAILURE;
}

function readJsonArg(value: string, what: string): any {
  const raw = value === "-" ? readFileSync(0, "utf8") : readFileSync(value, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`${what} is not valid JSON: ${(e as Error).message}`);
  }
}

async function cmdScore(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("score needs --run <dir>");
  const runDir = resolveRun(values.run);
  const places = readPlaces(runDir);
  scoreAll(places);

  if (values.apply) {
    const parsed = readJsonArg(values.apply, "--apply");
    const verdicts: FitVerdict[] = Array.isArray(parsed) ? parsed : (parsed?.verdicts ?? []);
    const result = applyFit(places, verdicts);
    say(`score: folded ${result.applied} fit verdict(s)`);
    if (result.unknown.length) {
      say(`score: ${result.unknown.length} verdict(s) named an id this run does not have: ${result.unknown.slice(0, 5).join(", ")}`);
      writePlaces(runDir, places);
      return EXIT_FAILURE;
    }
  }

  writePlaces(runDir, places);
  const order = ranked(places);
  if (bools.has("json")) {
    out(
      jsonLine(
        order.map((p) => ({
          id: p.id,
          name: p.name,
          total: p.score?.total ?? 0,
          fit: p.score?.fit,
          website: p.website?.url,
          openRoles: p.signals?.openRoles ?? 0,
        })),
      ),
    );
  } else {
    for (const p of order.slice(0, clampInt(values.limit, 1, 1000, 25))) {
      out(`${String(p.score?.total ?? 0).padStart(4)}  ${(p.score?.fit ?? "-").padEnd(8)}  ${p.name.slice(0, 42).padEnd(42)}  ${p.website?.url ?? ""}`);
    }
  }
  if (values.icp) {
    say("");
    say(`score: the engine does NOT score fit against "${values.icp}" — that judgement is yours.`);
    say(`  Read the packets, then fold your verdicts back: --apply '[{"id":"…","fit":"strong","why":"…"}]'`);
  }
  say("");
  say(`next: ultraprospect dossier --run ${runDir} --id <id>`);
  return EXIT_OK;
}

async function cmdDossier(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("dossier needs --run <dir>");
  const runDir = resolveRun(values.run);
  const places = readPlaces(runDir);

  if (!values.id) {
    // No id: list what can be written up, best first. Cheaper than making
    // someone grep places.json for an id.
    const order = ranked(places).filter((p) => p.pages.length > 0 || p.registry);
    if (bools.has("json")) out(jsonLine(order.map((p) => ({ id: p.id, name: p.name, pages: p.pages.length, total: p.score?.total ?? 0 }))));
    else for (const p of order.slice(0, 40)) out(`${p.id}\t${p.pages.length} page(s)\t${p.name}`);
    say("");
    say(`next: ultraprospect dossier --run ${runDir} --id ${order[0]?.id ?? "<id>"}`);
    return EXIT_OK;
  }

  const place = places.find((p) => p.id === values.id);
  if (!place) throw new UsageError(`no place with id "${values.id}" in ${runDir}`);
  const packet = buildDossierPacket(runDir, place, requireManifest(runDir));
  out(packet.markdown);
  say("");
  say(`write your dossier to ${join(runDir, dossierPathFor(place))}`);
  say(`next: ultraprospect check --run ${runDir}`);
  return EXIT_OK;
}

async function cmdCheck(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("check needs --run <dir>");
  const runDir = resolveRun(values.run);
  const report = runCheck({ runDir, places: readPlaces(runDir), manifest: requireManifest(runDir) });

  if (bools.has("json")) out(jsonLine(report));
  else out(formatReport(report));

  if (!report.ok) {
    say("");
    say("check: the run did not pass. Fix the findings above — do not present the output.");
    return EXIT_FAILURE;
  }
  say("");
  say(`next: ultraprospect render --run ${runDir}`);
  return EXIT_OK;
}

async function cmdRender(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("render needs --run <dir>");
  const runDir = resolveRun(values.run);
  const places = readPlaces(runDir);
  const manifest = requireManifest(runDir);

  const outcome = buildAll(places, manifest, {
    runDir,
    noPeople: bools.has("no-people"),
    minScore: values["min-score"] ? clampInt(values["min-score"], 0, 10_000, 0) : undefined,
    minFit: (values["min-fit"] as "strong" | "possible" | "weak" | undefined) ?? undefined,
  });

  for (const file of outcome.files) writeArtifact(join(runDir, file.path), file.content);

  if (bools.has("json")) out(jsonLine({ run: runDir, files: outcome.files.map((f) => join(runDir, f.path)) }));
  else for (const file of outcome.files) out(join(runDir, file.path));

  say("");
  if (manifest.truncated) {
    say("  ⚠ this run is TRUNCATED — the report and the page both lead with that, and so must you.");
  }
  const privacy = outcome.files.some((f) => f.path === "PRIVACY.md");
  if (privacy) say("  PRIVACY.md was written: this run holds named individuals. Read it before sharing the CSV.");
  say(`next: open ${join(runDir, "index.html")}`);
  return EXIT_OK;
}

async function cmdWatch(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("watch needs --run <dir> (the newer run)");
  if (!values.since) throw new UsageError("watch needs --since <dir> (the earlier run to compare against)");
  const afterDir = resolveRun(values.run);
  const beforeDir = resolveRun(values.since);
  if (afterDir === beforeDir) throw new UsageError("--run and --since resolve to the same run; there is nothing to compare");

  const delta = diffRuns(readPlaces(beforeDir), readPlaces(afterDir));
  const markdown = buildDelta(delta, requireManifest(beforeDir), requireManifest(afterDir));
  writeArtifact(join(afterDir, "DELTA.md"), markdown);

  if (bools.has("json")) {
    out(
      jsonLine({
        run: afterDir,
        since: beforeDir,
        appeared: delta.appeared.length,
        disappeared: delta.disappeared.length,
        closed: delta.closed.length,
        startedHiring: delta.startedHiring.length,
        newRoles: delta.newRoles.length,
        gotWebsite: delta.gotWebsite.length,
      }),
    );
  } else {
    out(join(afterDir, "DELTA.md"));
  }
  say("");
  say(
    `  ${delta.startedHiring.length} started hiring · ${delta.appeared.length} new · ${delta.closed.length} ceased · ${delta.gotWebsite.length} gained a site`,
  );
  return EXIT_OK;
}

async function cmdMcp(values: Record<string, string>): Promise<number> {
  const adapter = createAdapter();
  if ((values.transport ?? "stdio") === "http") {
    const server = await startHttpServer(adapter, {
      port: values.port ? clampInt(values.port, 1, 65535, 8787) : 8787,
      // Loopback unless the operator says otherwise. A prospect run holds
      // personal data; binding it to every interface by default would be a
      // surprising thing for a CLI flag-less invocation to do.
      bind: values.bind ?? "127.0.0.1",
    });
    say(`ultraprospect: MCP over http on ${values.bind ?? "127.0.0.1"}:${values.port ?? 8787}`);
    await new Promise(() => {});
    void server;
    return EXIT_OK;
  }
  await runStdioServer(adapter);
  return EXIT_OK;
}

async function cmdOrchestrate(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("orchestrate needs --run <dir>");
  const runDir = resolveRun(values.run);
  // The emitted scripts bake in the absolute engine path: an installed skill
  // runs far from the user's project, and a subagent handed a relative path
  // resolves it against its own cwd.
  const engineAbs = fileURLToPath(new URL(import.meta.url));

  const result = emitOrchestration(runDir, engineAbs, {
    phase: values.phase,
    eco: bools.has("eco"),
    countryCode: requireManifest(runDir).target.countryCode,
  });

  if (bools.has("list") || bools.has("json")) {
    out(
      jsonLine({
        run: runDir,
        exitCode: result.exitCode,
        phases: result.phases.map((p) => ({ name: p.name, ready: p.ready, items: p.items, prerequisite: p.prerequisite })),
      }),
    );
  } else {
    for (const file of result.written) out(file);
  }
  for (const notice of result.notices) say(`  ${notice}`);
  for (const error of result.errors) say(`  ${error}`);
  return result.exitCode;
}

export async function main(argv: readonly string[]): Promise<number> {
  brandEngine();
  const parsed = parseArgs(argv, SPEC);
  if (parsed.kind === "help") {
    out(HELP);
    return EXIT_OK;
  }
  if (parsed.kind === "version") {
    out(VERSION);
    return EXIT_OK;
  }

  const { command, values, bools } = parsed;
  if (bools.has("stdout") || process.env.ULTRAPROSPECT_NO_WRITE === "1") setNoWrite(true);
  const text = positionalText(parsed);

  switch (command) {
    case "ingest":
      return cmdIngest(values, bools);
    case "where":
      return cmdWhere(values, bools, text);
    case "scan":
      return cmdScan(values, bools, text);
    case "match":
      return cmdMatch(values, bools);
    case "confirm":
      return cmdConfirm(values, bools);
    case "resolve":
      return cmdResolve(values, bools);
    case "enrich":
      return cmdEnrich(values, bools);
    case "score":
      return cmdScore(values, bools);
    case "dossier":
      return cmdDossier(values, bools);
    case "check":
      return cmdCheck(values, bools);
    case "render":
      return cmdRender(values, bools);
    case "watch":
      return cmdWatch(values, bools);
    case "orchestrate":
      return cmdOrchestrate(values, bools);
    case "mcp":
      return cmdMcp(values);
    case "doctor":
      // `--country` narrows the register probes to the ones that serve it, and
      // the keys go WITH the probe: a diagnostic handed a credential must use
      // it, not report the connector as skipped for want of it.
      return runDoctor({ json: bools.has("json"), out, say }, values.country, connectorKeys(values));
    case "version":
      out(VERSION);
      return EXIT_OK;
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

if (isInvokedDirectly(process.argv[1], "ultraprospect")) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: any) => {
      if (!e?.handled) process.stderr.write(`ultraprospect: ${e?.message ?? e}\n`);
      process.exitCode = typeof e?.exitCode === "number" ? e.exitCode : EXIT_FAILURE;
    });
}
