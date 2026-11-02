// The tender commands as MCP tools. Same core as the CLI (`commands.ts`).
//
// Left out on purpose, as in the territory adapter: anything whose input is a
// FILE of the agent's judgement (`tenders --apply`) or the agent's own web
// search (`tenders --web-results`). Those fold through the CLI, which validates
// them, so the server never becomes a second way to write a verdict.
import { ToolError, type ToolDecl, type ToolOutcome } from "../engine.js";
import { DEFAULT_OUT } from "../run.js";
import { clampInt } from "../util.js";
import { bidPacket, readTenderNotice, runAwards, startTenders, TenderUsageError } from "./commands.js";
import { resolveTenderRun } from "./run.js";

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${name} must be a non-empty string`);
  return v.trim();
};
const csv = (v: unknown): string[] | undefined =>
  typeof v === "string" && v.trim()
    ? v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : undefined;
const opt = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export const TENDER_TOOLS: ToolDecl[] = [
  {
    name: "ultraprospect_tenders",
    title: "Find public calls for tenders",
    description:
      "Search every procurement source a set of countries has — TED (EU, above the thresholds), BOAMP (France, every threshold), Find a Tender and Contracts Finder (UK), the German daily export, CanadaBuys, SAM.gov (key) and USAspending (US), AusTender, PNCP (Brazil), Prozorro (Ukraine), SECOP (Colombia), the World Bank — de-duplicated by eForms procedure id. Returns the run directory, per-source coverage, and `gaps`: countries seen only above the EU thresholds, or not at all. Read `truncated` and `gaps` before the counts.",
    inputSchema: {
      type: "object",
      properties: {
        countries: { type: "string", description: 'ISO alpha-2, comma-separated: fr,de,gb. "eu" is the 27.' },
        cpv: { type: "string", description: "CPV prefixes, comma-separated: 72,48." },
        keywords: { type: "string", description: "Terms in the market's own language, comma-separated. Nothing is translated for you." },
        profile: { type: "string", description: "Path to the bidder's profile.json: offer, CPV, keywords per language, references R#, certifications C#." },
        status: { type: "string", enum: ["open", "awarded", "all"], description: "Default open." },
        since: { type: "string", description: "Published since: 30d, 6m, 2y or an ISO date. Default 30d." },
        sources: { type: "string", description: "Only these source ids, comma-separated." },
        limit: { type: "number", description: "Per source. Default 200." },
        out: { type: "string", description: "Run root. Defaults to ./.ultraprospect" },
      },
      required: [],
    } as never,
  },
  {
    name: "ultraprospect_tender",
    title: "Read one notice and its documents",
    description:
      "Store one notice as citable pages: the API record, the publisher's notice text (for TED, the PDF in the buyer's language) and, with documents: true, every public document of the DCE — PDFs, office files, ZIP members — kept only when it names this procedure. A DCE behind a registration wall is reported, never bypassed.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" }, id: { type: "string" }, documents: { type: "boolean" }, maxPages: { type: "number" } },
      required: ["run", "id"],
    } as never,
  },
  {
    name: "ultraprospect_bid",
    title: "The grounding packet for a response",
    description:
      "Everything a response to one notice may rely on: the published deadline, the bidder's profile under its citation ids ([R#], [C#], [profile.x]), the jurisdiction's administrative checklist, the RESPONSE.md and COMPLIANCE.md templates, and the full text of every stored page under its [P#]. Write the two files to bids/<id>/, then call ultraprospect_check.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" }, id: { type: "string" }, profile: { type: "string" } },
      required: ["run", "id"],
    } as never,
  },
  {
    name: "ultraprospect_awards",
    title: "Who wins, and when it comes back",
    description:
      "Analyse award notices: top winners by notices won (identifier first, never a fuzzy name), recurring buyers, median values, and re-tender windows ESTIMATED from the duration each notice publishes — none drawn without one. The top identified winners are confirmed against their national register. Pass `run` for an existing tenders run, or countries / cpv to fetch the awards first.",
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string" },
        countries: { type: "string" },
        cpv: { type: "string" },
        keywords: { type: "string" },
        since: { type: "string", description: "Default 2y." },
        buyer: { type: "string" },
        horizonMonths: { type: "number" },
        confirm: { type: "boolean", description: "Confirm the top winners against their register. Default true." },
        out: { type: "string" },
      },
      required: [],
    } as never,
  },
];

export const TENDER_CAP_ADVICE: Record<string, string> = {
  ultraprospect_tenders: "pass a smaller `limit`, fewer `countries`, or a shorter `since`.",
  ultraprospect_bid: "read the notice first with `ultraprospect_tender` and fewer `maxPages`, or open the run's pages/<id>/ files directly.",
  ultraprospect_awards:
    "the full analysis was written to `AWARDS.md` and `awards.json` in the run directory; read it from there, or pass a narrower `cpv` or `buyer`.",
};

/** Answer a tender tool, or undefined when the name is not one. */
export async function callTenderTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome | undefined> {
  try {
    switch (name) {
      case "ultraprospect_tenders": {
        const r = await startTenders({
          out: opt(args.out) ?? DEFAULT_OUT,
          countries: csv(args.countries),
          cpv: csv(args.cpv),
          keywords: csv(args.keywords),
          profilePath: opt(args.profile),
          status: (["open", "awarded", "all"] as const).find((x) => x === args.status),
          since: opt(args.since),
          sources: csv(args.sources),
          limit: args.limit !== undefined ? clampInt(args.limit, 1, 10_000, 200) : undefined,
        });
        const m = r.manifest;
        return {
          text: JSON.stringify(
            { run: r.runDir, truncated: m.truncated, gaps: m.gaps, counts: m.tenderCounts, lanes: m.lanes, worklist: r.todo.items.slice(0, 30) },
            null,
            2,
          ),
          artifact: r.runDir,
        };
      }
      case "ultraprospect_tender": {
        const runDir = resolveTenderRun(str(args.run, "run"));
        const r = await readTenderNotice(runDir, str(args.id, "id"), {
          documents: args.documents === true,
          maxPages: args.maxPages !== undefined ? clampInt(args.maxPages, 1, 100, 12) : undefined,
        });
        return {
          text: JSON.stringify({ id: r.tender.id, pages: r.tender.pages, documentsAccess: r.tender.documentsAccess, note: r.note }, null, 2),
          artifact: runDir,
        };
      }
      case "ultraprospect_bid": {
        const runDir = resolveTenderRun(str(args.run, "run"));
        const r = bidPacket(runDir, str(args.id, "id"), opt(args.profile));
        return { text: `${r.markdown}\n\n<!-- write RESPONSE.md and COMPLIANCE.md to ${r.dir}, then call ultraprospect_check -->` };
      }
      case "ultraprospect_awards": {
        const r = await runAwards({
          out: opt(args.out) ?? DEFAULT_OUT,
          run: opt(args.run) ? resolveTenderRun(opt(args.run)!) : undefined,
          countries: csv(args.countries),
          cpv: csv(args.cpv),
          keywords: csv(args.keywords),
          since: opt(args.since),
          buyer: opt(args.buyer),
          horizonMonths: args.horizonMonths !== undefined ? clampInt(args.horizonMonths, 1, 120, 24) : undefined,
          confirm: args.confirm !== false,
          limit: 500,
        });
        return {
          text: JSON.stringify(
            {
              run: r.runDir,
              report: r.path,
              suppliers: r.analysis.suppliers.slice(0, 25),
              buyers: r.analysis.buyers.slice(0, 25),
              upcoming: r.analysis.upcoming.slice(0, 40),
              medians: r.analysis.medians,
              identities: r.identities,
            },
            null,
            2,
          ),
          artifact: r.runDir,
        };
      }
      default:
        return undefined;
    }
  } catch (e) {
    // A refusal is a result the caller can act on, as everywhere else in the adapter.
    if (e instanceof TenderUsageError) return { text: `refused: ${e.message}` };
    throw e;
  }
}
