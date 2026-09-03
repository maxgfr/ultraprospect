// The MCP surface.
//
// Enough tools that an agent in another harness can go from a place name to a
// deliverable without shelling out: resolve a place, sweep it, ingest a keyless
// bulk register, confirm what the sweep could not reach, enrich, score, look at
// one company, get its grounding packet, run the gate, render, diff two runs, and
// ask why a run came back thin.
//
// It began with five, and the gap was not academic. `confirm` did not exist when
// this file was written, so an MCP client could scan Berlin and had no way at all
// to attach a register identity — the run stopped at OpenStreetMap and nothing
// said why. The rule now is: a command whose input is FLAGS belongs here.
//
// WHAT IS STILL DELIBERATELY ABSENT, and why:
//
//   * `match --apply` and `score --apply` take a FILE of considered verdicts about
//     dozens of pairs. A tool call is the wrong shape for handing that over, and
//     an agent tempted to answer forty adjudications in one argument is an agent
//     about to rubber-stamp them.
//   * `resolve` is the phase the whole run rests on and it is the CLIENT'S
//     WebSearch, not ours. Exposing it as a tool would invite the keyless
//     fallback, which is measurably weaker: on a real Vincennes sweep the silent
//     path corroborated 11 sites out of 1164.
//   * `orchestrate` emits files for a harness that already has this adapter.
//
// The gate is exposed on purpose. An agent that can run a sweep but not check
// it will present ungrounded output, and the check is the reason any of this is
// worth reading.
//
// Every handler here calls the SAME core function and the same persistence helper
// the CLI does — `persistConfirm`, `buildAll`, `scoreAll`. What differs is only
// presentation: the CLI narrates to stderr and returns exit codes, this returns
// JSON. Anything else would be a second implementation of the fold, and it would
// drift on the first change.
import { ToolError, cacheDir, writeArtifact, type McpAdapter, type ToolDecl, type ToolOutcome } from "../engine.js";
import { join } from "node:path";
import { runCheck, formatReport } from "../check.js";
import { needsConfirming, persistConfirm, runConfirm } from "../confirm.js";
import { probeAll } from "../doctor.js";
import { enrichable, persistEnrich, runEnrich } from "../enrich.js";
import { newPageStore } from "../pages.js";
import { buildAll } from "../render.js";
import { CONNECTORS, servesCountry } from "../registry/index.js";
import { ingestSnapshot, listSnapshots, type SnapshotSource } from "../snapshot.js";
import { buildDelta, diffRuns } from "../watch.js";
import { buildDossierPacket } from "../dossier.js";
import { resolveWhere } from "../geocode.js";
import { readPlaces, requireManifest, resolveRun, newRun, writePlaces, DEFAULT_OUT } from "../run.js";
import { runScan, writeScan } from "../scan.js";
import { ranked, scoreAll } from "../score.js";
import { factSheet } from "../dossier.js";
import { clampInt, parseDistanceM } from "../util.js";
import { VERSION } from "../version.js";

/**
 * Credentials from the environment, read off each connector's own declaration.
 *
 * A tool call has no `--flag`, so the environment is the only channel — and taking
 * the variable NAME from `needsKey` rather than hardcoding one means a new
 * key-gated connector is picked up here with nothing to remember. Every source
 * this tool needs is keyless, so the usual answer is an empty object.
 */
const envKeys = (): Record<string, string | undefined> =>
  Object.fromEntries(CONNECTORS.filter((c) => c.needsKey?.env).map((c) => [c.id, process.env[c.needsKey!.env]]));

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${name} must be a non-empty string`);
  return v.trim();
};

const TOOLS: ToolDecl[] = [
  {
    name: "ultraprospect_where",
    title: "Resolve a place",
    description:
      "Resolve a place name to a search area. Returns the centre, the bounding box, the OSM relation and (in France) the INSEE commune code. When several distinct places match with comparable confidence it REFUSES and returns the candidates — pick one and pass `pick`.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A town, a street, an address." },
        country: { type: "string", description: "ISO-3166-1 alpha-2 hint, e.g. fr." },
        pick: { type: "number", description: "Take the Nth candidate (1-based) instead of refusing." },
      },
      required: ["query"],
    } as never,
  },
  {
    name: "ultraprospect_scan",
    title: "Sweep a territory",
    description:
      "Discover every company in a place, from OpenStreetMap worldwide and the French register, fused into one entity each. Returns the run directory and the per-lane coverage. Read `truncated` before reading the counts: a partial sweep says so, and must never be presented as a whole territory.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A town, a street, an address." },
        country: { type: "string" },
        radius: { type: "string", description: "For a point search: 800, 800m, 2km." },
        section: { type: "string", description: "Activity section letters in the country's own scheme, comma-separated. NACE A-U across Europe, e.g. J,M." },
        legalForms: { type: "string", description: "Filed legal-form codes to include, comma-separated." },
        excludeLegalForms: { type: "string", description: "Filed legal-form codes to exclude, comma-separated. Applied client-side in France." },
        minEmployees: { type: "number", description: "Keep companies with at least this many employees, where the register publishes size." },
        maxResults: { type: "number", description: "Register rows before the lane declares itself partial." },
        out: { type: "string", description: "Run root. Defaults to ./.ultraprospect" },
      },
      required: ["query"],
    } as never,
  },
  {
    name: "ultraprospect_places",
    title: "List a run's companies",
    description: "The ranked companies in a run, with score, fit, website and hiring. Use `limit` to keep the response small.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string", description: "Run directory, or a root whose newest run is taken." },
        limit: { type: "number" },
        withWebsiteOnly: { type: "boolean" },
      },
      required: ["run"],
    } as never,
  },
  {
    name: "ultraprospect_dossier",
    title: "Grounding packet for one company",
    description:
      "Everything known about one company: the open-data fact sheet and the FULL TEXT of every page fetched for it, each under the id a write-up must cite. Large by design — a summary cannot be re-opened to check what it said.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string" },
        id: { type: "string", description: "The place id. Omit for the fact sheet of the top-ranked company." },
        factSheetOnly: { type: "boolean", description: "Skip the page texts." },
      },
      required: ["run"],
    } as never,
  },
  {
    name: "ultraprospect_check",
    title: "Run the gate",
    description:
      "Re-opens every citation, demands a source or an [M] on every factual line, and re-reads every contact against the page it claims to come from. Returns the findings. A non-empty error list means the run must not be presented.",
    inputSchema: { type: "object", properties: { run: { type: "string" } }, required: ["run"] } as never,
  },
  {
    name: "ultraprospect_ingest",
    title: "Ingest a keyless bulk register",
    description:
      "Fetch and index a register's bulk open-data export, once. `gb` is Companies House's monthly snapshot (470 MB, indexes to ~1.8 GB) and turns the United Kingdom into a territory that can be ENUMERATED without a key; `de` is the German Handelsregister export (260 MB, ~3 GB) and gives `confirm` a source that names the holder of an HRB number. Slow — minutes, not seconds — and needed only once per country. Pass `list: true` to see what is already cached instead.",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", description: "ISO-3166-1 alpha-2: gb or de. The only two registers publishing a bulk export." },
        list: { type: "boolean", description: "Report what is cached — rows, vintage, disk — and ingest nothing." },
        limit: { type: "number", description: "Stop after this many rows. For a first look at a source." },
      },
      required: [],
    } as never,
  },
  {
    name: "ultraprospect_confirm",
    title: "Attach a register identity, company by company",
    description:
      "For a run whose register lane could not be swept: read the registration number off each company's own legal notice (Impressum, aviso legal — both legally mandatory) and ask an authority whose it is. Run it AFTER enrich tier 1, or it can only look companies up by name, which is a candidate rather than a fact — it refuses rather than doing the weak half silently. Returns how many were verified by a published number, matched by name, attested without a holder, not found, and NOT ASKED because no authority answered. Those last two are different findings.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string" },
        limit: { type: "number", description: "Only confirm this many places. The strongest route runs first, so a limit cuts the speculative half." },
        registry: { type: "string", description: "Restrict to these connector ids, comma-separated." },
      },
      required: ["run"],
    } as never,
  },
  {
    name: "ultraprospect_enrich",
    title: "Read the corroborated websites",
    description:
      "Tier 1 reads the homepage and the legal notice on every site `resolve` proved belongs to its company: four requests, and it answers whether the site is alive, what it says it does, whether a hiring pipeline exists, and whether a registration is published there. Tier 2 is the expensive one — a page per role plus the openings read out of the ATS API rather than a JavaScript shell — so spend it on the companies you have a reason to care about, not on a whole town.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string" },
        tier: { type: "number", description: "1 or 2. Default 1." },
        limit: { type: "number", description: "Only enrich this many places." },
        only: { type: "string", description: "Restrict to these place ids, comma-separated." },
      },
      required: ["run"],
    } as never,
  },
  {
    name: "ultraprospect_score",
    title: "Rank by measured signals",
    description:
      "Adds a total from things the run counted: site alive, recently touched, roles open, headcount band, revenue filed, contactable. It does NOT score whether a company matches a brief, however that brief is phrased — that judgement is yours, and it belongs in `fit`, which sits beside `total` and never overwrites it. Folding verdicts back in is deliberately CLI-only: it takes a file of considered answers.",
    inputSchema: { type: "object", properties: { run: { type: "string" }, limit: { type: "number" } }, required: ["run"] } as never,
  },
  {
    name: "ultraprospect_render",
    title: "Write the deliverables",
    description:
      "Writes PROSPECTS.csv (flat, CRM-shaped, score and fit in separate columns, each contact's source page beside it), prospects.json, REPORT.md and a self-contained index.html that makes no network requests. Both documents carry what the run knows rather than a summary of it: which connector answered and what attached each record, what the run was narrowed to, the score broken into its terms, every fit verdict verbatim, each contact with the page id it was read from. The report's opening sentence is DERIVED from the lanes, so it cannot claim a sweep the run did not perform; a truncated run and a dated register record each lead with that. If PRIVACY.md appears in the file list, the run holds named individuals.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string" },
        minScore: { type: "number" },
        minFit: { type: "string", description: "strong, possible or weak — only rows you judged at least that." },
        noPeople: { type: "boolean", description: "Strip named individuals from the deliverables." },
      },
      required: ["run"],
    } as never,
  },
  {
    name: "ultraprospect_watch",
    title: "Diff two runs",
    description:
      "What moved between an earlier run and this one: who appeared, disappeared, ceased, started or stopped hiring, gained a website. A DISAPPEARANCE IS NOT A CLOSURE — a company drops out of a sweep for half a dozen reasons and only the register can say a business ceased, which is why the two are counted apart. If either run is truncated, a difference may be coverage rather than change, and the output says so.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" }, since: { type: "string", description: "The earlier run directory." } },
      required: ["run", "since"],
    } as never,
  },
  {
    name: "ultraprospect_doctor",
    title: "Why did a run come back thin",
    description:
      "Probes node, the geocoders, every Overpass mirror and the register connectors that serve a country. Also reports which connectors have NEVER been exercised against their live API — a separate question from whether one is up right now, and one a reader deciding how much to trust a record needs answered.",
    inputSchema: {
      type: "object",
      properties: { country: { type: "string", description: "Narrow the register probes to this country." } },
      required: [],
    } as never,
  },
];

export function createAdapter(): McpAdapter {
  return {
    version: VERSION,
    listTools: () => TOOLS,
    // Only `scan` can produce a large response, and only because a dense town
    // holds thousands of companies. The advice names the argument that shrinks
    // it rather than telling the caller to try again.
    capAdvice: {
      ultraprospect_places: "pass a smaller `limit`, or `withWebsiteOnly: true`.",
      ultraprospect_dossier: "pass `factSheetOnly: true` to skip the page texts.",
      ultraprospect_scan: "narrow with `section` or `minEmployees`, or lower `maxResults`.",
      ultraprospect_score: "pass a smaller `limit`.",
      // `watch` has no narrowing argument — the delta is as large as the change —
      // so the advice names where the whole thing already is instead.
      ultraprospect_watch: "the full diff was written to `DELTA.md` in the run directory; read it from there.",
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
      switch (name) {
        case "ultraprospect_where": {
          const result = await resolveWhere(str(args.query, "query"), {
            country: typeof args.country === "string" ? args.country : undefined,
            pick: typeof args.pick === "number" ? clampInt(args.pick, 1, 5, 1) : undefined,
          });
          if (!result.ok) {
            // A refusal is a RESULT, not an error: the caller has to choose, and
            // the candidates are what they choose from.
            return { text: JSON.stringify({ ok: false, reason: result.reason, candidates: result.candidates }, null, 2) };
          }
          return { text: JSON.stringify({ ok: true, target: result.target }, null, 2) };
        }

        case "ultraprospect_scan": {
          const radiusM = typeof args.radius === "string" ? parseDistanceM(args.radius) : undefined;
          const resolved = await resolveWhere(str(args.query, "query"), {
            country: typeof args.country === "string" ? args.country : undefined,
            radiusM,
          });
          if (!resolved.ok) throw new ToolError(`${resolved.reason}. Call ultraprospect_where first, then pass its pick.`);

          const outcome = await runScan(resolved.target, {
            sections: typeof args.section === "string" ? args.section.split(",").map((s) => s.trim()) : undefined,
            legalForms: typeof args.legalForms === "string" ? args.legalForms.split(",").map((s) => s.trim()) : undefined,
            excludeLegalForms: typeof args.excludeLegalForms === "string" ? args.excludeLegalForms.split(",").map((s) => s.trim()) : undefined,
            minEmployees: typeof args.minEmployees === "number" ? args.minEmployees : undefined,
            maxResults: typeof args.maxResults === "number" ? clampInt(args.maxResults, 1, 10_000, 3000) : undefined,
          });
          const run = newRun(typeof args.out === "string" ? args.out : DEFAULT_OUT, resolved.target.label);
          writeScan(run.dir, outcome);
          return {
            text: JSON.stringify(
              { run: run.dir, truncated: outcome.manifest.truncated, lanes: outcome.manifest.lanes, counts: outcome.manifest.counts },
              null,
              2,
            ),
            artifact: run.dir,
          };
        }

        case "ultraprospect_places": {
          const runDir = resolveRun(str(args.run, "run"));
          let places = ranked(readPlaces(runDir));
          if (args.withWebsiteOnly === true) places = places.filter((p) => p.website?.confidence === "corroborated");
          const limit = typeof args.limit === "number" ? clampInt(args.limit, 1, 5000, 50) : 50;
          const manifest = requireManifest(runDir);
          return {
            text: JSON.stringify(
              {
                truncated: manifest.truncated,
                total: places.length,
                showing: Math.min(limit, places.length),
                places: places.slice(0, limit).map((p) => ({
                  id: p.id,
                  name: p.name,
                  score: p.score?.total ?? 0,
                  fit: p.score?.fit,
                  registry: p.registry?.connectorId,
                  activityCode: p.registry?.activityCode,
                  activityScheme: p.registry?.activityScheme,
                  headcount: p.registry?.sizeBand ?? p.registry?.employees,
                  website: p.website?.url,
                  websiteConfidence: p.website?.confidence,
                  openRoles: p.signals?.openRoles,
                  isHiring: p.signals?.isHiring,
                })),
              },
              null,
              2,
            ),
          };
        }

        case "ultraprospect_dossier": {
          const runDir = resolveRun(str(args.run, "run"));
          const places = readPlaces(runDir);
          const place = args.id ? places.find((p) => p.id === args.id) : ranked(places)[0];
          if (!place) throw new ToolError(`no place with id "${String(args.id)}" in ${runDir}`);
          if (args.factSheetOnly === true) return { text: factSheet(place) };
          return { text: buildDossierPacket(runDir, place, requireManifest(runDir)).markdown };
        }

        case "ultraprospect_check": {
          const runDir = resolveRun(str(args.run, "run"));
          const report = runCheck({ runDir, places: readPlaces(runDir), manifest: requireManifest(runDir) });
          return { text: `${formatReport(report)}\n\n${JSON.stringify({ ok: report.ok, errors: report.errors, warnings: report.warnings }, null, 2)}` };
        }

        case "ultraprospect_ingest": {
          if (args.list === true) return { text: JSON.stringify({ cacheDir: cacheDir(), snapshots: listSnapshots() }, null, 2) };
          const country = str(args.country, "country").toLowerCase();
          // Driven by the connector table's own declaration, like every other
          // reader of it — so a new bulk source needs no edit here.
          const applicable = CONNECTORS.filter((c) => c.snapshot && servesCountry(c, country));
          if (applicable.length === 0) {
            const available = CONNECTORS.filter((c) => c.snapshot).map((c) => c.countries.join("/"));
            throw new ToolError(`no register serving ${country} publishes a bulk open-data export. Countries that do: ${available.join(", ")}`);
          }
          const notes: string[] = [];
          const done = [];
          for (const connector of applicable) {
            done.push(
              await ingestSnapshot(connector.id, connector.snapshot as SnapshotSource, {
                limit: typeof args.limit === "number" ? clampInt(args.limit, 1, 100_000_000, 1000) : undefined,
                onNote: (n) => notes.push(n),
              }),
            );
          }
          return { text: JSON.stringify({ ingested: done, notes }, null, 2) };
        }

        case "ultraprospect_confirm": {
          const runDir = resolveRun(str(args.run, "run"));
          const manifest = requireManifest(runDir);
          const places = readPlaces(runDir);
          const targets = needsConfirming(places);
          if (targets.length === 0)
            return { text: JSON.stringify({ run: runDir, verified: 0, matched: 0, note: "every place already carries a register record" }, null, 2) };
          // The same refusal the CLI makes, and for the same reason: without pages
          // the only route left is a name lookup, and a run that quietly fell back
          // to it would fill the same field with weaker evidence.
          if (targets.filter((p) => p.pages.length > 0).length === 0) {
            throw new ToolError(
              `none of the ${targets.length} place(s) has a fetched page, so no legal notice can be read. Run ultraprospect_enrich with tier 1 first (which needs resolve's corroborated websites).`,
            );
          }
          const notes: string[] = [];
          const outcome = await runConfirm(runDir, places, {
            countryCode: manifest.target.countryCode,
            town: manifest.target.label,
            limit: typeof args.limit === "number" ? clampInt(args.limit, 1, 100_000, 200) : undefined,
            registryIds: typeof args.registry === "string" ? args.registry.split(",").map((s) => s.trim()) : undefined,
            keys: envKeys(),
            onNote: (n) => notes.push(n),
          });
          persistConfirm(runDir, places, manifest, outcome);
          return {
            text: JSON.stringify(
              {
                run: runDir,
                verified: outcome.verified,
                matched: outcome.matched,
                attested: outcome.attested,
                undecided: outcome.undecided.length,
                notFound: outcome.notFound,
                notAsked: outcome.notAsked,
                coverage: outcome.coverage,
                notes,
              },
              null,
              2,
            ),
            artifact: runDir,
          };
        }

        case "ultraprospect_enrich": {
          const runDir = resolveRun(str(args.run, "run"));
          const places = readPlaces(runDir);
          if (enrichable(places).length === 0) {
            throw new ToolError(
              "no place has a corroborated website yet. Enrichment only ever reads sites proved to belong to their company; run `resolve` first.",
            );
          }
          const tier = typeof args.tier === "number" ? (clampInt(args.tier, 1, 2, 1) as 1 | 2) : 1;
          const store = newPageStore(places.flatMap((p) => p.pages.map((id) => ({ id }) as never)));
          const notes: string[] = [];
          const outcome = await runEnrich(runDir, places, store, {
            tier,
            limit: typeof args.limit === "number" ? clampInt(args.limit, 1, 100_000, 20) : undefined,
            only: typeof args.only === "string" ? args.only.split(",").map((s) => s.trim()) : undefined,
            onNote: (n) => notes.push(n),
          });
          persistEnrich(runDir, places, tier, outcome);
          return { text: JSON.stringify({ run: runDir, tier, ...outcome, notes }, null, 2), artifact: runDir };
        }

        case "ultraprospect_score": {
          const runDir = resolveRun(str(args.run, "run"));
          const places = readPlaces(runDir);
          scoreAll(places);
          writePlaces(runDir, places);
          const limit = typeof args.limit === "number" ? clampInt(args.limit, 1, 5000, 50) : 50;
          return {
            text: JSON.stringify(
              {
                run: runDir,
                note: "`total` is measured. `fit` is a judgement and is not set here — fold verdicts in with the CLI's `score --apply`.",
                ranked: ranked(places)
                  .slice(0, limit)
                  .map((p) => ({
                    id: p.id,
                    name: p.name,
                    total: p.score?.total ?? 0,
                    fit: p.score?.fit,
                    website: p.website?.url,
                    openRoles: p.signals?.openRoles ?? 0,
                  })),
              },
              null,
              2,
            ),
          };
        }

        case "ultraprospect_render": {
          const runDir = resolveRun(str(args.run, "run"));
          const manifest = requireManifest(runDir);
          const outcome = buildAll(readPlaces(runDir), manifest, {
            runDir,
            noPeople: args.noPeople === true,
            minScore: typeof args.minScore === "number" ? clampInt(args.minScore, 0, 10_000, 0) : undefined,
            minFit: typeof args.minFit === "string" ? (args.minFit as "strong" | "possible" | "weak") : undefined,
          });
          for (const file of outcome.files) writeArtifact(join(runDir, file.path), file.content);
          return {
            text: JSON.stringify(
              {
                run: runDir,
                files: outcome.files.map((f) => join(runDir, f.path)),
                truncated: manifest.truncated,
                privacy: outcome.files.some((f) => f.path === "PRIVACY.md"),
              },
              null,
              2,
            ),
            artifact: runDir,
          };
        }

        case "ultraprospect_watch": {
          const after = resolveRun(str(args.run, "run"));
          const before = resolveRun(str(args.since, "since"));
          const delta = diffRuns(readPlaces(before), readPlaces(after));
          const markdown = buildDelta(delta, requireManifest(before), requireManifest(after));
          writeArtifact(join(after, "DELTA.md"), markdown);
          return { text: markdown, artifact: after };
        }

        case "ultraprospect_doctor": {
          const probes = await probeAll(typeof args.country === "string" ? args.country : undefined, envKeys());
          return { text: JSON.stringify({ version: VERSION, cacheDir: cacheDir(), probes }, null, 2) };
        }

        default:
          throw new ToolError(`unknown tool "${name}"`);
      }
    },
  };
}
