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
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError, isInvokedDirectly, jsonLine, parseArgs, positionalText, setNoWrite } from "./engine.js";
import { brandEngine } from "./engine.js";
import { runDoctor } from "./doctor.js";
import { resolveWhere } from "./geocode.js";
import { runScan, writeScan } from "./scan.js";
import { loadFixture, recordFixture } from "./fixture.js";
import { applyVerdicts, type MatchVerdict } from "./match.js";
import { needsResolving, queriesFor, runResolve, type WebHit } from "./resolve.js";
import { newPageStore } from "./pages.js";
import { DEFAULT_OUT, newRun, readPlaces, requireManifest, resolveRun, writePlaces, writeRunManifest } from "./run.js";
import { clampInt, parseBbox, parseDistanceM } from "./util.js";
import { VERSION } from "./version.js";

export const COMMANDS = ["where", "scan", "match", "resolve", "doctor", "version"] as const;

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
  "naf",
  "section",
  "effectif",
  "min-effectif",
  "max-results",
  "overpass",
  "apply",
  "fixture",
  "record",
  "web-results",
  "limit",
] as const;

export const BOOL_FLAGS = ["json", "no-osm", "no-sirene", "include-ceased", "no-people", "queries", "engine-search", "stdout", "help", "version"] as const;

export const HELP = `ultraprospect ${VERSION} — turn a place into a qualified prospect list

USAGE
  ultraprospect <command> [options]

COMMANDS
  where <query>          Resolve a place name to a search area. Refuses to guess when ambiguous.
  scan                   Discover every company in the area, from OSM and the French register.
  match --apply <file>   Fold the agent's adjudication of MATCH.todo.json back into places.json.
  resolve                Find each company's own website and prove it is theirs.
  doctor                 Check node, network and the health of every upstream.
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
  --naf <list>           Full NAF codes, e.g. 62.01Z,70.22Z. Prefixes are rejected by the register.
  --section <list>       NAF section letters, e.g. J,M.
  --effectif <list>      INSEE employee-band codes, e.g. 11,12,21.
  --min-effectif <n>     Keep companies with at least n employees.
  --include-ceased       Include companies the register marks as ceased. Off by default.
  --max-results <n>      Cap on register rows before the lane declares itself partial (default 3000).
  --no-osm               Skip the OpenStreetMap lane.
  --no-sirene            Skip the French register lane.
  --overpass <url>       Override the Overpass endpoint instead of rotating mirrors.
  --fixture <dir>        Replay a recorded sweep instead of calling the live lanes. Offline.
  --record <dir>         Write this run's raw lane output as a replayable fixture.

WEBSITE DISCOVERY (resolve)
  --queries              Print the search queries to run, one per line, and stop.
  --web-results <file>   Hits from your own WebSearch: [{url,title,snippet,placeId?}]. "-" reads stdin.
  --engine-search        Fall back to the keyless search engine when no hits were supplied.
  --limit <n>            Only resolve this many places.

ADJUDICATION (match)
  --apply <file>         A JSON array of {osmId, siret|siren, merge, why}. "-" reads stdin.

OUTPUT
  --out <dir>            Run root. Default ./${DEFAULT_OUT}
  --run <dir>            An existing run directory, or a root whose newest run is taken.
  --json                 Machine-readable payload on stdout.
  --stdout               Produce nothing on disk; stream artifacts instead.
  --no-people            Strip named individuals from the run (register directors included).
  --help                 This text.
  --version              Print the version.

ENVIRONMENT
  ULTRAPROSPECT_CACHE_DIR      Where fetched pages are cached. Default <tmpdir>/ultraprospect.
  ULTRAPROSPECT_NO_WRITE=1     Same as --stdout.
  ULTRAPROSPECT_POLITE_DELAY_MS  Per-host delay between requests. Default 400.

Data: © OpenStreetMap contributors (ODbL); base Sirene / RNE via data.gouv.fr (Licence Ouverte 2.0).
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
    naf: list(values.naf),
    sections: list(values.section),
    effectif: list(values.effectif),
    minEffectif: values["min-effectif"] ? clampInt(values["min-effectif"], 0, 100_000, 0) : undefined,
    includeCeased: bools.has("include-ceased"),
    noOsm: bools.has("no-osm"),
    noSirene: bools.has("no-sirene"),
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

  say("");
  say(`  OSM              ${c.osm}`);
  say(`  register         ${c.sirene}`);
  say(`  fused places     ${c.places}  (${c.merged} matched across both lanes)`);
  say(`  with a website   ${c.withWebsite}`);
  if (outcome.manifest.truncated) {
    say("");
    say("  ⚠ TRUNCATED — this run does NOT cover the whole territory:");
    for (const lane of outcome.manifest.lanes.filter((l) => l.truncated)) say(`      ${lane.lane}: ${lane.reason}`);
    say("      narrow with --section / --naf / --min-effectif, or raise --max-results");
  }
  say("");
  say(`next: ultraprospect resolve --run ${run.dir}`);
  return c.places > 0 ? EXIT_OK : EXIT_FAILURE;
}

async function cmdMatch(values: Record<string, string>, bools: ReadonlySet<string>): Promise<number> {
  if (!values.run) throw new UsageError("match needs --run <dir>");
  if (!values.apply) throw new UsageError('match needs --apply <file> (a JSON array of {osmId, siret, merge}), or "-" for stdin');
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
    throw new UsageError("--apply contained no verdicts — expected [{osmId, siret, merge, why}, ...]");
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
  const targets = needsResolving(places).slice(0, limit ?? Number.POSITIVE_INFINITY);

  // The queries lane: the engine sizes the sweep, the agent runs its own
  // WebSearch, and the hits come back through --web-results. The engine never
  // pretends to be a search engine.
  if (bools.has("queries")) {
    const plan = targets.map((p) => ({ placeId: p.id, name: p.name, queries: queriesFor(p) }));
    if (bools.has("json")) out(jsonLine(plan));
    else for (const item of plan) for (const q of item.queries) out(q);
    say("");
    say(`resolve: ${targets.length} place(s) need a website, ${plan.reduce((n, p) => n + p.queries.length, 0)} quer(y|ies) to run.`);
    say("  Run your own WebSearch once per query. Pool EVERY hit into ONE JSON array,");
    say('  duplicates and all: [{"url": "…", "title": "…", "snippet": "…", "placeId": "…"}]');
    say(`next: ultraprospect resolve --run ${runDir} --web-results <file>`);
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

  const store = newPageStore(places.flatMap((p) => p.pages.map((id) => ({ id }) as any)));
  const outcome = await runResolve(runDir, places, store, {
    webResults,
    limit,
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
    out(jsonLine({ run: runDir, corroborated: outcome.corroborated, rejected: outcome.rejected, socials: outcome.socials, unchanged: outcome.unchanged }));
  }
  say("");
  say(`next: ultraprospect enrich --run ${runDir} --tier 1`);
  return outcome.corroborated > 0 || outcome.unchanged === 0 ? EXIT_OK : EXIT_FAILURE;
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
    case "where":
      return cmdWhere(values, bools, text);
    case "scan":
      return cmdScan(values, bools, text);
    case "match":
      return cmdMatch(values, bools);
    case "resolve":
      return cmdResolve(values, bools);
    case "doctor":
      return runDoctor({ json: bools.has("json"), out, say });
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
