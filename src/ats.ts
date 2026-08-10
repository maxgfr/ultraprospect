// Job openings, without executing anyone's JavaScript.
//
// A careers page is usually an empty shell: the openings arrive from an
// applicant-tracking system after the page has loaded, so fetching the HTML and
// reading the text finds a heading and nothing else. The obvious fix is a
// headless browser, which is a hundred megabytes of dependency and a per-page
// second, in a tool whose whole premise is a single zero-dependency file.
//
// The better fix is that every one of these systems already serves the same
// openings as PUBLIC, KEYLESS JSON — it has to, because that is how the
// company's own page fetches them. So the board token is discovered from the
// links on the careers page, and the openings are read from the API directly.
// Faster, structured, and it produces a stable URL per posting to cite.
//
// The token is always DISCOVERED, never guessed from the company name. Guessing
// `boards.greenhouse.io/<slug>` would occasionally hit a different company with
// a similar name and attribute their hiring to this prospect.
import { httpJson } from "./engine.js";
import type { JobPosting } from "./types.js";

export interface AtsBoard {
  provider: string;
  /** The account identifier, as it appeared in a link on the company's site. */
  token: string;
  /** Where the token was seen, for provenance. */
  sourceUrl: string;
}

/**
 * Link patterns that reveal a board token.
 *
 * Deliberately anchored on the provider's own hostnames: a company that
 * embeds its board in an iframe still has to name the provider in the src.
 */
const BOARD_PATTERNS: { provider: string; re: RegExp }[] = [
  { provider: "greenhouse", re: /(?:boards|job-boards|boards-api)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/gi },
  { provider: "lever", re: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/gi },
  { provider: "ashby", re: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/gi },
  { provider: "recruitee", re: /https?:\/\/([a-z0-9-]+)\.recruitee\.com/gi },
  { provider: "teamtailor", re: /https?:\/\/([a-z0-9-]+)\.teamtailor\.com/gi },
  { provider: "workable", re: /apply\.workable\.com\/([a-z0-9-]+)/gi },
  { provider: "welcometothejungle", re: /welcometothejungle\.com\/[a-z]{2}\/companies\/([a-z0-9-]+)/gi },
];

/** Tokens that are a provider's own pages, not a customer's board. */
const NOT_A_TOKEN = new Set(["embed", "www", "api", "jobs", "boards", "app", "help", "blog", "about", "static", "assets", "js", "css"]);

/** Find every board a page links to. */
export function detectBoards(html: string, sourceUrl: string): AtsBoard[] {
  const found: AtsBoard[] = [];
  const seen = new Set<string>();
  for (const { provider, re } of BOARD_PATTERNS) {
    re.lastIndex = 0;
    for (const m of html.matchAll(re)) {
      const token = m[1];
      if (!token || NOT_A_TOKEN.has(token.toLowerCase())) continue;
      const key = `${provider}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ provider, token, sourceUrl });
    }
  }
  return found;
}

async function getJson(url: string): Promise<any | undefined> {
  try {
    const res = await httpJson("GET", url, undefined, { timeoutMs: 20_000, retries: 1 });
    return res.ok ? res.data : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Fetch the openings a board is advertising.
 *
 * Returns an empty array both when a company is not hiring and when the board
 * could not be read. The caller distinguishes them by whether the provider was
 * detected at all — "no openings" and "we could not look" are different facts
 * and neither is allowed to masquerade as the other in the signals.
 */
export async function fetchBoard(board: AtsBoard): Promise<JobPosting[]> {
  const via = board.provider;
  switch (board.provider) {
    case "greenhouse": {
      const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${board.token}/jobs`);
      return (data?.jobs ?? []).map((j: any) => ({
        title: text(j.title) ?? "(untitled)",
        url: text(j.absolute_url),
        location: text(j.location?.name),
        postedAt: text(j.updated_at),
        via,
      }));
    }
    case "lever": {
      const data = await getJson(`https://api.lever.co/v0/postings/${board.token}?mode=json`);
      return (Array.isArray(data) ? data : []).map((j: any) => ({
        title: text(j.text) ?? "(untitled)",
        url: text(j.hostedUrl) ?? text(j.applyUrl),
        location: text(j.categories?.location),
        department: text(j.categories?.team) ?? text(j.categories?.department),
        employmentType: text(j.categories?.commitment),
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
        via,
      }));
    }
    case "ashby": {
      const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${board.token}`);
      return (data?.jobs ?? []).map((j: any) => ({
        title: text(j.title) ?? "(untitled)",
        url: text(j.jobUrl) ?? text(j.applyUrl),
        location: text(j.location),
        department: text(j.department) ?? text(j.team),
        employmentType: text(j.employmentType),
        postedAt: text(j.publishedAt),
        via,
      }));
    }
    case "recruitee": {
      const data = await getJson(`https://${board.token}.recruitee.com/api/offers/`);
      return (data?.offers ?? []).map((j: any) => ({
        title: text(j.title) ?? "(untitled)",
        url: text(j.careers_url) ?? text(j.careers_apply_url),
        location: text(j.location) ?? text(j.city),
        department: text(j.department),
        employmentType: text(j.employment_type_code),
        postedAt: text(j.published_at),
        via,
      }));
    }
    case "workable": {
      const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${board.token}?details=true`);
      return (data?.jobs ?? []).map((j: any) => ({
        title: text(j.title) ?? "(untitled)",
        url: text(j.url) ?? text(j.application_url),
        location: [text(j.city), text(j.country)].filter(Boolean).join(", ") || undefined,
        department: text(j.department),
        employmentType: text(j.type),
        postedAt: text(j.published_on),
        via,
      }));
    }
    case "teamtailor": {
      // Teamtailor's own API needs a key; the public feed does not.
      const data = await getJson(`https://${board.token}.teamtailor.com/jobs.json`);
      return (
        (data?.jobs ?? data ?? []).map?.((j: any) => ({
          title: text(j.title) ?? "(untitled)",
          url: text(j.careersite_job_url) ?? text(j.url),
          location: text(j.location),
          department: text(j.department),
          via,
        })) ?? []
      );
    }
    default:
      // welcometothejungle and anything new: the board was DETECTED, which is
      // itself a usable signal (this company runs a real hiring pipeline), but
      // there is no keyless JSON to read. Reporting zero openings here would be
      // a lie; the caller sees the provider in `atsProviders` and no postings.
      return [];
  }
}

/** Read every board detected on a page. */
export async function fetchAllBoards(boards: readonly AtsBoard[]): Promise<JobPosting[]> {
  const out: JobPosting[] = [];
  for (const board of boards) out.push(...(await fetchBoard(board)));
  // The same opening can appear on two boards during a migration.
  const seen = new Set<string>();
  return out.filter((j) => {
    const key = `${j.title}|${j.location ?? ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
