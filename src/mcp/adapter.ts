// The MCP surface.
//
// Five tools, chosen so that an agent in another harness can do the whole loop
// without shelling out: resolve a place, sweep it, look at one company, get its
// grounding packet, run the gate. Everything that WRITES a judgement back —
// `match --apply`, `score --apply` — is deliberately absent: those take a file
// of verdicts, and a tool call is the wrong shape for handing over a considered
// answer about forty pairs.
//
// The gate is exposed on purpose. An agent that can run a sweep but not check
// it will present ungrounded output, and the check is the reason any of this is
// worth reading.
import { ToolError, type McpAdapter, type ToolDecl, type ToolOutcome } from "../engine.js";
import { runCheck, formatReport } from "../check.js";
import { buildDossierPacket } from "../dossier.js";
import { resolveWhere } from "../geocode.js";
import { readPlaces, requireManifest, resolveRun, newRun, DEFAULT_OUT } from "../run.js";
import { runScan, writeScan } from "../scan.js";
import { ranked } from "../score.js";
import { factSheet } from "../dossier.js";
import { clampInt, parseDistanceM } from "../util.js";
import { VERSION } from "../version.js";

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
        section: { type: "string", description: "NAF section letters, comma-separated, e.g. J,M." },
        minEffectif: { type: "number", description: "Keep companies with at least this many employees." },
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
      ultraprospect_scan: "narrow with `section` or `minEffectif`, or lower `maxResults`.",
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
            minEffectif: typeof args.minEffectif === "number" ? args.minEffectif : undefined,
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
                  naf: p.sirene?.nafCode,
                  headcount: p.sirene?.effectifTranche,
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

        default:
          throw new ToolError(`unknown tool "${name}"`);
      }
    },
  };
}
