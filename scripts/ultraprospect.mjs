#!/usr/bin/env node

// src/cli.ts
import { readFileSync as readFileSync2 } from "fs";

// src/vendor/webindex-engine.mjs
import { join as join4 } from "path";
import { tmpdir as tmpdir4 } from "os";
import { mkdirSync as mkdirSync3, renameSync, unlinkSync, writeFileSync as writeFileSync3 } from "fs";
import { join as join5 } from "path";
import { readFileSync as readFileSync4 } from "fs";
import { basename as basename2 } from "path";
var DEFAULT_BRAND = {
  name: "webindex",
  envPrefix: "WEBINDEX",
  cli: "webindex",
  contactUrl: "https://github.com/maxgfr/webindex"
};
var current = { ...DEFAULT_BRAND };
function configure(next) {
  if (!next.envPrefix || !/^[A-Z][A-Z0-9_]*$/.test(next.envPrefix)) {
    throw new Error(`webindex: envPrefix must be UPPER_SNAKE, got ${JSON.stringify(next.envPrefix)}`);
  }
  if (!next.name || !next.cli) {
    throw new Error("webindex: configure() requires both `name` and `cli`");
  }
  current = { ...next };
}
function brand() {
  return current;
}
function countFetch(bytes, cached = false) {
  const hook = current.onFetch;
  if (!hook) return;
  try {
    hook(bytes, cached);
  } catch {
  }
}
function envName(suffix) {
  return `${current.envPrefix}_${suffix}`;
}
function env(suffix) {
  const raw = process.env[envName(suffix)];
  if (typeof raw !== "string") return void 0;
  const trimmed = raw.trim();
  return trimmed ? trimmed : void 0;
}
function envFlag(suffix) {
  const v = env(suffix);
  if (v === void 0) return false;
  const lower = v.toLowerCase();
  return lower !== "0" && lower !== "false" && lower !== "no" && lower !== "off";
}
function envInt(suffix, def, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = env(suffix);
  if (raw === void 0) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
var MAX_STDOUT_BYTES = 24 * 1024 * 1024;
var BINARY = { textFallback: false };
var CSV = { format: "csv", textFallback: true };
var BY_EXTENSION = {
  // Word
  doc: BINARY,
  docx: BINARY,
  docm: BINARY,
  odt: BINARY,
  rtf: BINARY,
  // PowerPoint
  ppt: BINARY,
  pps: BINARY,
  pot: BINARY,
  pptx: BINARY,
  pptm: BINARY,
  ppsx: BINARY,
  ppsm: BINARY,
  odp: BINARY,
  // Excel
  xls: BINARY,
  xlsx: BINARY,
  xlsm: BINARY,
  xlsb: BINARY,
  ods: BINARY,
  // Everything else the converter reads
  epub: BINARY,
  csv: CSV
};
var DOC_EXTENSIONS = Object.keys(BY_EXTENSION);
function bomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return { encoding: "utf-8", skip: 3 };
  if (bytes.length >= 2 && bytes[0] === 255 && bytes[1] === 254) return { encoding: "utf-16le", skip: 2 };
  if (bytes.length >= 2 && bytes[0] === 254 && bytes[1] === 255) return { encoding: "utf-16be", skip: 2 };
  return void 0;
}
var CHARSET_IN_CONTENT_TYPE = /charset\s*=\s*["']?([a-z0-9_:.+-]+)/i;
function charsetFromContentType(contentType) {
  return CHARSET_IN_CONTENT_TYPE.exec(contentType ?? "")?.[1]?.toLowerCase();
}
function charsetFromHtml(head) {
  const window = head.slice(0, 4096);
  const direct = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_:.+-]+)/i.exec(window);
  if (direct) return direct[1].toLowerCase();
  const httpEquiv = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.+-]+)/i.exec(window);
  return httpEquiv?.[1]?.toLowerCase();
}
function decodeBody(bytes, contentType = "") {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);
  const declared = charsetFromContentType(contentType);
  if (declared && declared !== "utf-8" && declared !== "utf8") return decodeWith(bytes, declared);
  if (declared) return bytes.toString("utf8");
  const meta = charsetFromHtml(bytes.subarray(0, 4096).toString("latin1"));
  if (meta && meta !== "utf-8" && meta !== "utf8") return decodeWith(bytes, meta);
  return bytes.toString("utf8");
}
var CP1252_C1 = [
  8364,
  129,
  8218,
  402,
  8222,
  8230,
  8224,
  8225,
  710,
  8240,
  352,
  8249,
  338,
  141,
  381,
  143,
  144,
  8216,
  8217,
  8220,
  8221,
  8226,
  8211,
  8212,
  732,
  8482,
  353,
  8250,
  339,
  157,
  382,
  376
];
var CP1252_LABELS = /* @__PURE__ */ new Set([
  "windows-1252",
  "cp1252",
  "cp-1252",
  "x-cp1252",
  "ansi_x3.4-1968",
  "iso-8859-1",
  "iso8859-1",
  "latin1",
  "l1",
  "us-ascii",
  "ascii"
]);
function decodeCp1252(bytes) {
  let out2 = "";
  for (const b of bytes) out2 += String.fromCharCode(b >= 128 && b <= 159 ? CP1252_C1[b - 128] : b);
  return out2;
}
function decodeWith(bytes, encoding) {
  if (CP1252_LABELS.has(encoding)) return decodeCp1252(bytes);
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}
var ACCENT_CLASSES = {
  a: "a\xE0\xE1\xE2\xE3\xE4\xE5\u0101\u0103\u0105",
  c: "c\xE7\u0107\u0109\u010B\u010D",
  d: "d\u010F\u0111",
  e: "e\xE8\xE9\xEA\xEB\u0113\u0115\u0117\u0119\u011B",
  g: "g\u011D\u011F\u0121\u0123",
  i: "i\xEC\xED\xEE\xEF\u0129\u012B\u012D\u012F\u0131",
  l: "l\u013A\u013C\u013E\u0140\u0142",
  n: "n\xF1\u0144\u0146\u0148",
  o: "o\xF2\xF3\xF4\xF5\xF6\xF8\u014D\u014F\u0151",
  r: "r\u0155\u0157\u0159",
  s: "s\u015B\u015D\u015F\u0161",
  t: "t\u0163\u0165\u0167",
  u: "u\xF9\xFA\xFB\xFC\u0169\u016B\u016D\u016F\u0171\u0173",
  y: "y\xFD\xFF\u0177",
  z: "z\u017A\u017C\u017E"
};
var BASE_OF = /* @__PURE__ */ new Map();
for (const [base, cls] of Object.entries(ACCENT_CLASSES)) {
  for (const ch of cls) BASE_OF.set(ch, base);
}
function slugify(input, opts = {}) {
  const s = input.toLowerCase().replace(/^https?:\/\//, "").replace(/^git@/, "").replace(/\.git$/, "").replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, opts.max ?? 120);
  return s || (opts.fallback ?? "");
}
var SCRAPE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var DEFAULT_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
function browserUa() {
  return env("UA") || DEFAULT_BROWSER_UA;
}
function contactUa() {
  const b = brand();
  return `${b.name}/${b.version ?? "1.x"} (+${b.contactUrl ?? `https://github.com/maxgfr/${b.name}`})`;
}
function defaultUa() {
  return brand().defaultUa === "contact" ? contactUa() : browserUa();
}
var RETRY_STATUS = /* @__PURE__ */ new Set([429, 503, 502, 504]);
var maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
var defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5e3);
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function detectRateLimited(status, headers) {
  if (status === 429) return true;
  return status === 403 && headers.get("x-ratelimit-remaining") === "0";
}
function parseRetryAfter(headers, capMs = 5e3) {
  const h = headers.get("retry-after");
  if (!h) return void 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs) * 1e3, capMs);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), capMs);
  return void 0;
}
function retryDelayMs(headers) {
  return parseRetryAfter(headers) ?? defaultRetryMs();
}
function attemptsFor(retries) {
  return retries === void 0 ? maxAttempts() : Math.min(4, Math.max(0, Math.trunc(retries))) + 1;
}
async function readCappedBytes(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const remaining = max - total;
    if (chunk.length >= remaining) {
      chunks.push(chunk.subarray(0, remaining));
      await reader.cancel().catch(() => {
      });
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks);
}
async function httpGet(url, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, body: "", contentType: "", url };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = { "user-agent": opts.userAgent ?? defaultUa(), accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers
      });
      const max = opts.maxBytes ?? 4 * 1024 * 1024;
      const meta = {
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url,
        etag: res.headers.get("etag") ?? void 0,
        lastModified: res.headers.get("last-modified") ?? void 0,
        rateLimited: detectRateLimited(res.status, res.headers),
        retryAfterMs: parseRetryAfter(res.headers)
      };
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > max) {
        ctrl.abort();
        return { ok: false, status: res.status, body: "", ...meta, error: `response too large: ${declared} bytes > ${max} cap` };
      }
      const bytes = res.status === 304 ? Buffer.alloc(0) : await readCappedBytes(res, max);
      countFetch(bytes.length, false);
      const result = {
        ok: res.ok,
        status: res.status,
        // Decoded per the response's own encoding, not assumed UTF-8. A
        // Windows-1252 page used to come back with every accented character
        // replaced by U+FFFD, and nothing anywhere noticed.
        body: opts.binary ? "" : decodeBody(bytes, meta.contentType),
        bytes: opts.binary ? bytes : void 0,
        ...meta
      };
      if (RETRY_STATUS.has(res.status) && attempt < attempts - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, body: "", contentType: "", url, error: e.message };
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
async function httpJson(method, url, body, opts = {}) {
  const attempts = attemptsFor(opts.retries);
  let last = { ok: false, status: 0, data: void 0 };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2e4);
    try {
      const headers = {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": opts.userAgent ?? defaultUa()
      };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers,
        body: body === void 0 ? void 0 : JSON.stringify(body)
      });
      const text = await res.text();
      countFetch(Buffer.byteLength(text), false);
      let data;
      try {
        data = text ? JSON.parse(text) : void 0;
      } catch {
        data = text;
      }
      const result = { ok: res.ok, status: res.status, data };
      if (RETRY_STATUS.has(res.status) && attempt < attempts - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, data: void 0, error: e.message };
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}
var ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "\u2014",
  "&ndash;": "\u2013",
  "&hellip;": "\u2026",
  "&copy;": "\xA9",
  // Typographic punctuation CMSes emit as named refs (WordPress "smart" text) —
  // otherwise a curly quote/apostrophe leaks into the report prose verbatim.
  "&lsquo;": "\u2018",
  "&rsquo;": "\u2019",
  "&sbquo;": "\u201A",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&bdquo;": "\u201E",
  "&bull;": "\u2022",
  "&middot;": "\xB7",
  "&laquo;": "\xAB",
  "&raquo;": "\xBB",
  "&deg;": "\xB0",
  "&plusmn;": "\xB1",
  "&times;": "\xD7",
  "&divide;": "\xF7",
  "&frac12;": "\xBD",
  "&frac14;": "\xBC",
  "&frac34;": "\xBE",
  "&sup2;": "\xB2",
  "&sup3;": "\xB3",
  "&micro;": "\xB5",
  "&trade;": "\u2122",
  "&reg;": "\xAE",
  "&sect;": "\xA7",
  "&para;": "\xB6",
  "&dagger;": "\u2020",
  "&Dagger;": "\u2021",
  "&prime;": "\u2032",
  "&Prime;": "\u2033",
  "&iexcl;": "\xA1",
  "&iquest;": "\xBF",
  "&cent;": "\xA2",
  "&pound;": "\xA3",
  "&curren;": "\xA4",
  "&yen;": "\xA5",
  "&euro;": "\u20AC",
  // Latin-1 accented letters — pervasive in non-English titles/snippets.
  "&agrave;": "\xE0",
  "&aacute;": "\xE1",
  "&acirc;": "\xE2",
  "&atilde;": "\xE3",
  "&auml;": "\xE4",
  "&aring;": "\xE5",
  "&aelig;": "\xE6",
  "&ccedil;": "\xE7",
  "&egrave;": "\xE8",
  "&eacute;": "\xE9",
  "&ecirc;": "\xEA",
  "&euml;": "\xEB",
  "&igrave;": "\xEC",
  "&iacute;": "\xED",
  "&icirc;": "\xEE",
  "&iuml;": "\xEF",
  "&ntilde;": "\xF1",
  "&ograve;": "\xF2",
  "&oacute;": "\xF3",
  "&ocirc;": "\xF4",
  "&otilde;": "\xF5",
  "&ouml;": "\xF6",
  "&oslash;": "\xF8",
  "&ugrave;": "\xF9",
  "&uacute;": "\xFA",
  "&ucirc;": "\xFB",
  "&uuml;": "\xFC",
  "&yacute;": "\xFD",
  "&yuml;": "\xFF",
  "&szlig;": "\xDF",
  "&Agrave;": "\xC0",
  "&Aacute;": "\xC1",
  "&Acirc;": "\xC2",
  "&Auml;": "\xC4",
  "&Aring;": "\xC5",
  "&AElig;": "\xC6",
  "&Ccedil;": "\xC7",
  "&Egrave;": "\xC8",
  "&Eacute;": "\xC9",
  "&Ecirc;": "\xCA",
  "&Euml;": "\xCB",
  "&Iacute;": "\xCD",
  "&Ntilde;": "\xD1",
  "&Oacute;": "\xD3",
  "&Ouml;": "\xD6",
  "&Oslash;": "\xD8",
  "&Uacute;": "\xDA",
  "&Uuml;": "\xDC"
};
var ENTITY_BY_NAME = new Map(Object.entries(ENTITIES).map(([k, v]) => [k.slice(1, -1), v]));
var PDF_FETCH_OPTS = { accept: "application/pdf,*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
var DOC_FETCH_OPTS = { accept: "*/*", binary: true, maxBytes: 16 * 1024 * 1024 };
var MASK64 = (1n << 64n) - 1n;
var STDOUT_CAP = 24 * 1024 * 1024;
var MODEL_PULL_TIMEOUT_MS = 6e5;
function embedModel() {
  return env("EMBED_MODEL") ?? "nomic-embed-text";
}
var STACKS = {
  searxng: {
    profiles: ["search"],
    summary: "SearXNG is up (:8888) \u2014 keyless discovery, JSON API enabled."
  },
  firecrawl: {
    profiles: ["search", "extract"],
    summary: "Firecrawl is up (:3002 \xB7 playwright \xB7 redis \xB7 rabbitmq \xB7 postgres), with SearXNG behind it.",
    postUp: () => [
      "  keyless: USE_DB_AUTHENTICATION=false \u2014 no API key is sent or needed.",
      "  effect:  pages are now cleaned by a real browser; --firecrawl off opts out."
    ]
  },
  semantic: {
    profiles: ["semantic"],
    summary: "Qdrant (:6333) and Ollama (:11434) are up.",
    postUp: (file, run) => {
      const model = embedModel();
      const pull = run("docker", ["compose", "-f", file, "exec", "-T", "ollama", "ollama", "pull", model], { timeoutMs: MODEL_PULL_TIMEOUT_MS, capture: true });
      return [pull.ok ? `  model:   ${model} ready` : `  model:   pull it yourself: docker compose -f ${file} exec ollama ollama pull ${model}`];
    }
  },
  all: {
    profiles: ["all", "extract"],
    summary: "The whole stack is up (Qdrant \xB7 Ollama \xB7 SearXNG \xB7 Firecrawl).",
    postUp: (file, run) => STACKS.semantic.postUp(file, run)
  }
};
var STACK_SERVICES = Object.keys(STACKS);
var SERVICE_PROFILES = Object.fromEntries(Object.entries(STACKS).map(([k, v]) => [k, v.profiles]));
async function mapLimit(items, limit, fn) {
  const width = Math.max(1, Math.floor(limit));
  if (items.length <= 1 || width === 1) {
    const out2 = [];
    for (let i = 0; i < items.length; i++) out2.push(await fn(items[i], i));
    return out2;
  }
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (; ; ) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
var flagged = false;
function setNoWrite(on) {
  flagged = on;
}
function isNoWrite() {
  return flagged || envFlag("NO_WRITE");
}
var collected = [];
function writeArtifact(path, content) {
  if (isNoWrite()) {
    const at = collected.findIndex((a) => a.path === path);
    if (at !== -1) collected[at] = { path, content };
    else collected.push({ path, content });
    return path;
  }
  writeFileAtomic(path, content);
  return path;
}
var tmpCounter = 0;
function writeFileAtomic(path, content) {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    writeFileSync3(tmp, content);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw e;
  }
}
var DEFAULT_TTL_MS = 24 * 60 * 60 * 1e3;
function cacheDir() {
  return env("CACHE_DIR") ?? brand().cacheDir ?? join4(tmpdir4(), brand().name, "cache");
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function runId(d = /* @__PURE__ */ new Date()) {
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync4(path, "utf8"));
  } catch {
    return void 0;
  }
}
function readManifest(dir, file = "manifest.json") {
  return readJsonSafe(join5(dir, file));
}
function writeManifest(dir, value, file = "manifest.json") {
  return writeArtifact(join5(dir, file), `${JSON.stringify(value, null, 2)}
`);
}
var nextFree = /* @__PURE__ */ new Map();
function hostDelayMs() {
  return envInt("POLITE_DELAY_MS", 400, 0, 5e3);
}
function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}
async function awaitHostSlot(url, delayMs = hostDelayMs(), now = Date.now()) {
  const host = hostOf(url);
  if (!host || delayMs <= 0) return 0;
  const free = nextFree.get(host) ?? 0;
  const waited = Math.max(0, free - now);
  nextFree.set(host, Math.max(free, now) + delayMs);
  if (waited > 0) await sleep(waited);
  return waited;
}
var EXIT_OK = 0;
var EXIT_FAILURE = 1;
var EXIT_USAGE = 2;
var UsageError = class extends Error {
  exitCode = EXIT_USAGE;
};
function parseArgs(argv, spec) {
  const commands = new Set(spec.commands);
  const valueFlags = new Set(spec.valueFlags);
  const boolFlags = new Set(spec.boolFlags);
  if (argv.length === 0) return { kind: "help" };
  if (isHelpWord(argv[0])) return { kind: "help" };
  if (isVersionWord(argv[0])) return { kind: "version" };
  const command = argv[0];
  if (!commands.has(command)) {
    throw new UsageError(`unknown command "${command}" \u2014 run --help for the supported commands`);
  }
  const values = {};
  const bools = /* @__PURE__ */ new Set();
  const positional = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") && arg !== "-h" && arg !== "-v") {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
    if (!boolFlags.has(key) && !valueFlags.has(key)) {
      if (isHelpWord(arg)) return { kind: "help" };
      if (isVersionWord(arg)) return { kind: "version" };
    }
    if (boolFlags.has(key)) {
      if (eq !== -1) throw new UsageError(`--${key} is a boolean flag and takes no value`);
      bools.add(key);
      continue;
    }
    if (!valueFlags.has(key)) {
      throw new UsageError(`unknown flag "--${key}" \u2014 run --help for the supported options`);
    }
    if (eq !== -1) {
      values[key] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === void 0 || next.startsWith("--")) {
      throw new UsageError(`missing value for --${key}`);
    }
    values[key] = next;
    i++;
  }
  return { kind: "command", command, positional, values, bools };
}
function isHelpWord(a) {
  return a === "--help" || a === "-h" || a === "help";
}
function isVersionWord(a) {
  return a === "--version" || a === "-v" || a === "version";
}
function positionalText(p) {
  return p.positional.join(" ");
}
function jsonLine(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function isInvokedDirectly(argv1 = process.argv[1], cli = brand().cli) {
  if (!argv1) return false;
  return basename2(argv1).replace(/\.(mjs|cjs|js)$/, "") === cli;
}
var PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
var LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];
var MAX_BODY_BYTES = 4 * 1024 * 1024;
var DRAIN_LIMIT = MAX_BODY_BYTES * 8;

// src/version.ts
var VERSION = "1.0.0";

// src/engine.ts
function brandEngine() {
  configure({
    name: "ultraprospect",
    envPrefix: "ULTRAPROSPECT",
    cli: "ultraprospect",
    version: VERSION
  });
}

// src/net.ts
var CONTACT_URL = "https://github.com/maxgfr/ultraprospect";
function politeUa() {
  return `ultraprospect/${VERSION} (+${CONTACT_URL})`;
}

// src/util.ts
function haversineM(aLat, aLon, bLat, bLon) {
  const R = 63710088e-1;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function foldAccents(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
var LEGAL_FORMS = /\b(?:sarl|sas|sasu|eurl|sa|sci|scp|scm|selarl|snc|gie|eirl|earl|scop|scic|asso(?:ciation)?|societe|ste|ets|etablissements?|entreprise|cie|compagnie|groupe|holding|france|international|gmbh|ltd|llc|inc|bv|nv|spa|srl|plc|ag)\b/g;
function normalizeName(raw) {
  return foldAccents(raw).toLowerCase().replace(/[’']/g, " ").replace(/[^a-z0-9]+/g, " ").replace(LEGAL_FORMS, " ").replace(/\s+/g, " ").trim();
}
function tokenSet(s) {
  return new Set(s.split(" ").filter((t) => t.length > 1));
}
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
function trigrams(s) {
  const padded = `  ${s} `;
  const out2 = /* @__PURE__ */ new Set();
  for (let i = 0; i < padded.length - 2; i++) out2.add(padded.slice(i, i + 3));
  return out2;
}
var GENERIC_TRADE_WORDS = /* @__PURE__ */ new Set([
  "creche",
  "ecole",
  "college",
  "lycee",
  "boulangerie",
  "patisserie",
  "boucherie",
  "pharmacie",
  "restaurant",
  "brasserie",
  "cafe",
  "bar",
  "tabac",
  "presse",
  "garage",
  "hotel",
  "salon",
  "coiffure",
  "agence",
  "cabinet",
  "centre",
  "maison",
  "clinique",
  "institut",
  "bureau",
  "magasin",
  "boutique",
  "atelier",
  "banque",
  "immobilier",
  "opticien",
  "pressing",
  "fleuriste",
  "librairie",
  "supermarche",
  "epicerie",
  "traiteur",
  "primeur",
  "poissonnerie",
  "fromagerie",
  "caviste",
  "auto",
  "ecole",
  "taxi",
  "clinic",
  "shop",
  "store",
  "market",
  "school",
  "office"
]);
function isNameContained(a, b) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!large.has(t)) return false;
  if (small.size >= 2) return true;
  const only = [...small][0];
  return only.length >= 6 && !GENERIC_TRADE_WORDS.has(only);
}
function nameVariants(raw) {
  const variants = [raw];
  const outside = raw.replace(/\([^)]*\)/g, " ").trim();
  if (outside && outside !== raw) variants.push(outside);
  for (const m of raw.matchAll(/\(([^)]+)\)/g)) {
    for (const part of m[1].split(/[,;]/)) {
      const v = part.trim();
      if (v) variants.push(v);
    }
  }
  return [...new Set(variants.filter(Boolean))];
}
function nameSimilarity(a, b) {
  let best = 0;
  for (const va of nameVariants(a)) {
    for (const vb of nameVariants(b)) {
      const na = normalizeName(va);
      const nb = normalizeName(vb);
      if (!na || !nb) continue;
      if (na === nb) return 1;
      const contained = isNameContained(na, nb) ? 0.88 : 0;
      const tok = jaccard(tokenSet(na), tokenSet(nb));
      const tri = jaccard(trigrams(na), trigrams(nb));
      best = Math.max(best, contained, tok, tri);
      if (best >= 1) return 1;
    }
  }
  return best;
}
function bestNameMatch(probe, candidates) {
  let best = { name: void 0, score: 0 };
  for (const c of candidates) {
    const score = nameSimilarity(probe, c);
    if (score > best.score) best = { name: c, score };
  }
  return best;
}
function bboxQuadrants(bbox) {
  const [s, n, w, e] = bbox;
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  return [
    [s, midLat, w, midLon],
    [s, midLat, midLon, e],
    [midLat, n, w, midLon],
    [midLat, n, midLon, e]
  ];
}
function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
  return [lat - dLat, lat + dLat, lon - dLon, lon + dLon];
}
function firstText(...values) {
  for (const v of values) if (typeof v === "string" && v.trim()) return v.trim();
  return void 0;
}
function clampInt(value, min, max, fallback) {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function parseDistanceM(raw) {
  const m = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m|km)?\s*$/i.exec(raw);
  if (!m) return void 0;
  const value = Number.parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return void 0;
  return (m[2] ?? "m").toLowerCase() === "km" ? Math.round(value * 1e3) : Math.round(value);
}
function parseBbox(raw) {
  const parts = raw.split(",").map((p) => Number.parseFloat(p.trim()));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) return void 0;
  const [s, w, n, e] = parts;
  if (s >= n || w >= e) return void 0;
  return [s, n, w, e];
}

// src/overpass.ts
var OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];
var OSM_TAG_GROUPS = {
  shop: '["shop"]',
  office: '["office"]',
  craft: '["craft"]',
  healthcare: '["healthcare"]',
  club: '["club"]',
  amenity: '["amenity"~"^(restaurant|cafe|bar|pub|fast_food|food_court|ice_cream|biergarten|bank|bureau_de_change|atm|pharmacy|clinic|doctors|dentist|veterinary|driving_school|language_school|prep_school|music_school|training|childcare|kindergarten|school|college|university|hospital|nursing_home|social_facility|funeral_directors|fuel|car_wash|car_rental|car_sharing|charging_station|cinema|theatre|nightclub|casino|marketplace|post_office|coworking_space|studio|internet_cafe|animal_boarding|animal_shelter|vehicle_inspection)$"]',
  tourism: '["tourism"~"^(hotel|motel|hostel|guest_house|apartment|chalet|camp_site|caravan_site|museum|gallery)$"]',
  leisure: '["leisure"~"^(fitness_centre|sports_centre|sports_hall|dance|escape_game|bowling_alley|amusement_arcade|adult_gaming_centre|horse_riding|golf_course|marina|hackerspace|trampoline_park)$"]'
};
function areaIdFor(target) {
  if (target.osmType !== "relation" || typeof target.osmId !== "number") return void 0;
  return 36e8 + target.osmId;
}
function scopeClause(area, bbox) {
  if (area !== void 0) return { header: `area(${area})->.searchArea;
`, suffix: "(area.searchArea)" };
  const [s, n, w, e] = bbox;
  return { header: "", suffix: `(${s},${w},${n},${e})` };
}
function buildQuery(area, bbox, opts = {}) {
  const groups = opts.groups?.length ? opts.groups : Object.keys(OSM_TAG_GROUPS);
  const filters = [...groups.map((g) => OSM_TAG_GROUPS[g]).filter((f) => Boolean(f)), ...opts.extraFilters ?? []];
  const { header, suffix } = scopeClause(area, bbox);
  const body = filters.map((f) => `  nwr${f}${suffix};`).join("\n");
  return `[out:json][timeout:${opts.timeoutS ?? 90}];
${header}(
${body}
);
out center tags;`;
}
function overpassError(body) {
  if (body.trimStart().startsWith("{")) return void 0;
  const m = /<strong[^>]*>Error<\/strong>:\s*([^<]+)/i.exec(body);
  return (m?.[1] ?? body.slice(0, 160)).replace(/\s+/g, " ").trim();
}
function isInstanceBusy(message) {
  return /dispatcher|open64|too busy|rate.?limit|HTTP 50[234]|HTTP 429|HTTP 0\b|not JSON|fetch failed|aborted|socket|ETIMEDOUT|ECONNRESET/i.test(message);
}
function isQueryTooBig(message) {
  return /query timed out|out of memory|too many results|memory limit/i.test(message);
}
async function runOnce(query, opts) {
  const mirrors = opts.mirrors ?? OVERPASS_MIRRORS;
  const failures = [];
  for (const mirror of mirrors) {
    await awaitHostSlot(mirror, 1e3);
    let body;
    try {
      const res = await httpGet(`${mirror}?data=${encodeURIComponent(query)}`, {
        timeoutMs: (opts.timeoutS ?? 90) * 1e3 + 15e3,
        // An identifying User-Agent is not optional here: the reference instance
        // answers 406 to a browser string. See src/net.ts.
        userAgent: politeUa(),
        // Well above the engine's HTML default: a dense arrondissement answers
        // with several megabytes of JSON, and a truncated body would parse as a
        // syntax error and be retried on every mirror in turn for nothing.
        maxBytes: 64 * 1024 * 1024,
        // Overpass is slow by nature and its failures are capacity failures;
        // retrying the same heavy query at the same instance just doubles the
        // load that caused it. Rotation and splitting are the recovery here.
        retries: 0
      });
      body = res.body ?? "";
      if (!res.ok && !body) {
        failures.push(`${mirror}: HTTP ${res.status}`);
        continue;
      }
    } catch (e) {
      failures.push(`${mirror}: ${e.message}`);
      continue;
    }
    const err = overpassError(body);
    if (err) {
      failures.push(`${mirror}: ${err}`);
      if (isQueryTooBig(err)) return { error: err, mirror, tooBig: true };
      continue;
    }
    try {
      return { json: JSON.parse(body), mirror };
    } catch {
      failures.push(`${mirror}: response was not JSON`);
    }
  }
  const joined = failures.join(" | ");
  return { error: joined, tooBig: failures.every((f) => isQueryTooBig(f) || isInstanceBusy(f)) };
}
function toPoi(el) {
  const tags = el?.tags ?? {};
  const lat = el?.lat ?? el?.center?.lat;
  const lon = el?.lon ?? el?.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return void 0;
  const osmType = el?.type === "way" || el?.type === "relation" ? el.type : "node";
  return {
    id: `${osmType[0]}${el.id}`,
    osmType,
    osmId: el.id,
    name: tags.name ?? tags["name:fr"] ?? tags.brand ?? tags.operator,
    lat,
    lon,
    tags
  };
}
async function fetchOsmPois(target, opts = {}) {
  const maxDepth = opts.maxSplitDepth ?? 3;
  const notes = [];
  const mirrorsUsed = /* @__PURE__ */ new Set();
  const byId = /* @__PURE__ */ new Map();
  let partitions = 0;
  let incomplete = false;
  const area = target.radiusM ? void 0 : areaIdFor(target);
  const rootBbox = target.radiusM ? bboxAround(target.lat, target.lon, target.radiusM) : target.bbox;
  async function walk(bbox, useArea, depth) {
    const query = buildQuery(useArea, bbox, opts);
    const { json, error, mirror, tooBig } = await runOnce(query, opts);
    if (mirror) mirrorsUsed.add(mirror);
    if (error) {
      if (useArea !== void 0) {
        notes.push(`overpass: the administrative-area query failed (${error}); fell back to the bounding box, which extends past the commune boundary`);
        opts.onNote?.("overpass: area query failed, falling back to bbox (edges will overshoot the boundary)");
        return walk(bbox, void 0, depth);
      }
      if (tooBig && depth < maxDepth) {
        notes.push(`overpass: splitting a too-large area at depth ${depth} (${error})`);
        opts.onNote?.(`overpass: area too large, splitting into 4 (depth ${depth + 1})`);
        for (const q of bboxQuadrants(bbox)) await walk(q, void 0, depth + 1);
        return;
      }
      incomplete = true;
      notes.push(`overpass: gave up on a tile after depth ${depth} \u2014 ${error}`);
      opts.onNote?.("overpass: a tile could not be fetched; the OSM lane is INCOMPLETE");
      return;
    }
    partitions++;
    for (const el of json?.elements ?? []) {
      const poi = toPoi(el);
      if (poi && !byId.has(poi.id)) byId.set(poi.id, poi);
    }
  }
  await walk(rootBbox, area, 0);
  return {
    pois: [...byId.values()],
    mirrorsUsed: [...mirrorsUsed],
    partitions: Math.max(1, partitions),
    notes,
    incomplete
  };
}
function poiCategory(poi) {
  for (const key of ["shop", "office", "craft", "healthcare", "amenity", "tourism", "leisure", "club"]) {
    const v = poi.tags[key];
    if (v && v !== "yes") return `${key}=${v}`;
    if (v === "yes") return key;
  }
  return void 0;
}
function poiWebsite(poi) {
  const raw = poi.tags.website ?? poi.tags["contact:website"] ?? poi.tags.url;
  if (!raw) return void 0;
  const first = raw.split(/[;\s]+/)[0];
  if (!first) return void 0;
  return /^https?:\/\//i.test(first) ? first : `https://${first}`;
}

// src/doctor.ts
async function timed(fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, detail: e.message, ms: Date.now() - t0 };
  }
}
var OVERPASS_PING = "[out:json][timeout:25];node[amenity=cafe](48.8550,2.3300,48.8680,2.3550);out count;";
var PLANET_FLOOR = 50;
var OVERPASS_PROBE_TIMEOUT_MS = 45e3;
async function probeOverpass(url) {
  const r = await timed(async () => {
    const res = await httpGet(`${url}?data=${encodeURIComponent(OVERPASS_PING)}`, { timeoutMs: OVERPASS_PROBE_TIMEOUT_MS, userAgent: politeUa(), retries: 0 });
    const body = res.body ?? "";
    if (!body.trimStart().startsWith("{")) {
      const m = /<strong[^>]*>Error<\/strong>:\s*([^<]+)/i.exec(body);
      return { ok: false, detail: (m?.[1] ?? `HTTP ${res.status}`).replace(/\s+/g, " ").trim().slice(0, 90) };
    }
    const count = Number.parseInt(JSON.parse(body)?.elements?.[0]?.tags?.nodes ?? "0", 10);
    if (!Number.isFinite(count) || count < PLANET_FLOOR) {
      return { ok: false, detail: `regional extract, not planet-wide (${count} caf\xE9s in central Paris) \u2014 excluded` };
    }
    return { ok: true, detail: `planet data (${count} caf\xE9s in central Paris)` };
  });
  return { name: "overpass", target: new URL(url).host, required: false, ...r };
}
async function probeAll() {
  const probes = [];
  probes.push({
    name: "node",
    target: process.version,
    ok: Number.parseInt(process.versions.node.split(".")[0], 10) >= 18,
    ms: 0,
    detail: Number.parseInt(process.versions.node.split(".")[0], 10) >= 18 ? "supported" : "ultraprospect needs Node 18 or newer",
    required: true
  });
  const nominatim = await timed(async () => {
    const res = await httpJson("GET", "https://nominatim.openstreetmap.org/search?q=paris&format=jsonv2&limit=1", void 0, {
      timeoutMs: 2e4,
      userAgent: politeUa()
    });
    return { ok: res.ok && Array.isArray(res.data) && res.data.length > 0, detail: res.ok ? "geocodes" : `HTTP ${res.status}` };
  });
  probes.push({ name: "nominatim", target: "nominatim.openstreetmap.org", required: true, ...nominatim });
  const ban = await timed(async () => {
    const res = await httpJson("GET", "https://api-adresse.data.gouv.fr/search/?q=paris&limit=1", void 0, { timeoutMs: 15e3, userAgent: politeUa() });
    return { ok: res.ok && Array.isArray(res.data?.features), detail: res.ok ? "geocodes French addresses" : `HTTP ${res.status}` };
  });
  probes.push({ name: "ban", target: "api-adresse.data.gouv.fr", required: false, ...ban });
  const sirene = await timed(async () => {
    const res = await httpJson("GET", "https://recherche-entreprises.api.gouv.fr/search?q=test&per_page=1", void 0, {
      timeoutMs: 25e3,
      userAgent: politeUa()
    });
    return { ok: res.ok && typeof res.data?.total_results === "number", detail: res.ok ? "answers register queries" : `HTTP ${res.status}` };
  });
  probes.push({ name: "sirene", target: "recherche-entreprises.api.gouv.fr", required: false, ...sirene });
  probes.push(...await Promise.all(OVERPASS_MIRRORS.map(probeOverpass)));
  return probes;
}
async function runDoctor(io) {
  const probes = await probeAll();
  const overpass = probes.filter((p) => p.name === "overpass");
  const liveMirrors = overpass.filter((p) => p.ok).length;
  const healthy = probes.filter((p) => p.required).every((p) => p.ok) && liveMirrors > 0;
  if (io.json) {
    io.out(JSON.stringify({ version: VERSION, cacheDir: cacheDir(), healthy, liveOverpassMirrors: liveMirrors, probes }, null, 2));
    return healthy ? EXIT_OK : EXIT_FAILURE;
  }
  io.out(`ultraprospect ${VERSION}`);
  io.out(`cache: ${cacheDir()}`);
  io.out("");
  for (const p of probes) {
    const mark = p.ok ? "ok  " : p.required ? "FAIL" : "down";
    const ms = p.ms ? `${String(p.ms).padStart(5)} ms` : "        ";
    io.out(`  ${mark}  ${p.name.padEnd(10)} ${ms}  ${p.target.padEnd(34)} ${p.detail}`);
  }
  io.out("");
  io.out(`  ${liveMirrors}/${overpass.length} Overpass mirrors answering`);
  if (!healthy) {
    io.say("");
    io.say("ultraprospect: an upstream this skill cannot work without is unreachable.");
    io.say("next: re-run `ultraprospect doctor` in a few minutes, or check your network");
    return EXIT_FAILURE;
  }
  if (liveMirrors < overpass.length) {
    io.say("");
    io.say(`note: ${overpass.length - liveMirrors} Overpass mirror(s) are down; runs will rotate onto the ones that answer.`);
  }
  return EXIT_OK;
}

// src/geocode.ts
var NOMINATIM = "https://nominatim.openstreetmap.org/search";
var BAN = "https://api-adresse.data.gouv.fr/search/";
var NOMINATIM_DELAY_MS = 1100;
var DISTINCT_PLACE_M = 1e4;
var AMBIGUITY_RATIO = 0.85;
async function resolveWhere(query, opts = {}) {
  const q = query.trim();
  if (!q) return { ok: false, candidates: [], reason: "empty query" };
  const hits = await nominatimSearch(q, opts);
  if (hits.length === 0) {
    return { ok: false, candidates: [], reason: `no geocoder result for "${q}"` };
  }
  const picked = opts.pick ? hits[opts.pick - 1] : hits[0];
  if (!picked) {
    return { ok: false, candidates: hits.map(toCandidate), reason: `--pick ${opts.pick} is out of range (${hits.length} candidates)` };
  }
  if (!opts.pick) {
    const rival = hits.slice(1).find((h) => isRival(hits[0], h));
    if (rival) {
      return {
        ok: false,
        candidates: hits.map(toCandidate),
        reason: `"${q}" is ambiguous \u2014 several distinct places match with comparable confidence`
      };
    }
  }
  const target = await toTarget(q, picked, opts);
  return { ok: true, target };
}
function isRival(top, other) {
  const ti = top.importance ?? 0;
  const oi = other.importance ?? 0;
  if (ti > 0 && oi / ti < AMBIGUITY_RATIO) return false;
  const [tLat, tLon] = [Number(top.lat), Number(top.lon)];
  const [oLat, oLon] = [Number(other.lat), Number(other.lon)];
  if (![tLat, tLon, oLat, oLon].every(Number.isFinite)) return false;
  return haversineM(tLat, tLon, oLat, oLon) > DISTINCT_PLACE_M;
}
function toCandidate(h) {
  return {
    label: h.display_name ?? "(unnamed)",
    lat: Number(h.lat),
    lon: Number(h.lon),
    kind: firstText(h.addresstype, h.type) ?? "place",
    source: "nominatim"
  };
}
async function nominatimSearch(q, opts) {
  const url = new URL(NOMINATIM);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("addressdetails", "1");
  if (opts.country) url.searchParams.set("countrycodes", opts.country.toLowerCase());
  if (opts.lang) url.searchParams.set("accept-language", opts.lang);
  await awaitHostSlot(url.href, NOMINATIM_DELAY_MS);
  const res = await httpJson("GET", url.href, void 0, { timeoutMs: 2e4, acceptLanguage: opts.lang, userAgent: politeUa() });
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data;
}
async function toTarget(query, hit, opts) {
  const lat = Number(hit.lat);
  const lon = Number(hit.lon);
  const bb = hit.boundingbox?.map(Number) ?? [];
  const bbox = bb.length === 4 && bb.every(Number.isFinite) ? [bb[0], bb[1], bb[2], bb[3]] : [lat - 0.01, lat + 0.01, lon - 0.015, lon + 0.015];
  const countryCode = hit.address?.country_code?.toLowerCase();
  const target = {
    query,
    label: hit.display_name ?? query,
    lat,
    lon,
    bbox,
    countryCode,
    osmType: hit.osm_type === "relation" || hit.osm_type === "way" || hit.osm_type === "node" ? hit.osm_type : void 0,
    osmId: typeof hit.osm_id === "number" ? hit.osm_id : void 0,
    postcode: hit.address?.postcode,
    source: "nominatim",
    radiusM: opts.radiusM
  };
  if (countryCode === "fr") {
    const insee = await banCityCode(query);
    if (insee) {
      target.codeCommune = insee.citycode;
      target.postcode ??= insee.postcode;
    }
  }
  return target;
}
async function banCityCode(query) {
  const url = new URL(BAN);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");
  await awaitHostSlot(url.href);
  const res = await httpJson("GET", url.href, void 0, { timeoutMs: 15e3, userAgent: politeUa() });
  const props = res.ok ? res.data?.features?.[0]?.properties : void 0;
  if (!props) return void 0;
  return { citycode: props.citycode, postcode: props.postcode };
}

// src/match.ts
var MAX_DISTANCE_M = 150;
var MERGE_HIGH = 0.72;
var MERGE_LOW = 0.4;
var MIN_IDENTITY = 0.25;
var CELL = 2e-3;
function cellKey(lat, lon) {
  return `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
}
function buildIndex(records) {
  const index = /* @__PURE__ */ new Map();
  for (const r of records) {
    if (typeof r.lat !== "number" || typeof r.lon !== "number") continue;
    const key = cellKey(r.lat, r.lon);
    const bucket = index.get(key);
    if (bucket) bucket.push(r);
    else index.set(key, [r]);
  }
  return index;
}
function nearby(index, lat, lon) {
  const out2 = [];
  const baseLat = Math.floor(lat / CELL);
  const baseLon = Math.floor(lon / CELL);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = index.get(`${baseLat + dy}:${baseLon + dx}`);
      if (bucket) out2.push(...bucket);
    }
  }
  return out2;
}
function registerNames(r) {
  return [r.nomComplet, r.nomRaisonSociale, r.sigle, ...r.enseignes].filter((n) => Boolean(n?.trim()));
}
function poiAddress(poi) {
  return {
    numero: poi.tags["addr:housenumber"],
    libelleVoie: poi.tags["addr:street"],
    codePostal: poi.tags["addr:postcode"],
    commune: poi.tags["addr:city"]
  };
}
function sameStreet(a, b, bType) {
  if (!a || !b) return false;
  const norm = (s) => foldAccents(s).toLowerCase().replace(/^(rue|avenue|av|boulevard|bd|quai|place|pl|impasse|allee|chemin|route|rte|cours|square|passage)\s+/i, "").replace(/\bde\s+la\b|\bdes\b|\bdu\b|\bde\b|\ble\b|\bla\b|\bl\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const na = norm(a);
  const nb = norm(bType ? `${bType} ${b}` : b);
  return na.length > 2 && na === nb;
}
function scorePair(poi, rec) {
  const distanceM = typeof rec.lat === "number" && typeof rec.lon === "number" ? haversineM(poi.lat, poi.lon, rec.lat, rec.lon) : Number.POSITIVE_INFINITY;
  const zero = { score: 0, parts: { distance: 0, name: 0, enseigne: 0, address: 0 }, distanceM };
  if (!Number.isFinite(distanceM) || distanceM > MAX_DISTANCE_M) return zero;
  const poiName = poi.name ?? "";
  const best = poiName ? bestNameMatch(poiName, registerNames(rec)) : { name: void 0, score: 0 };
  const nameScore = best.score;
  const brand2 = poi.tags.brand ?? poi.tags.operator ?? "";
  const enseigneScore = brand2 && rec.enseignes.length ? Math.max(0, ...rec.enseignes.map((e) => nameSimilarity(brand2, e))) : 0;
  const pa = poiAddress(poi);
  const numberAgrees = Boolean(
    pa.numero && rec.address.numero && pa.numero.replace(/\s/g, "").toLowerCase() === rec.address.numero.replace(/\s/g, "").toLowerCase()
  );
  const streetAgrees = sameStreet(pa.libelleVoie, rec.address.libelleVoie, rec.address.typeVoie);
  const addressScore = numberAgrees && streetAgrees ? 1 : streetAgrees ? 0.6 : 0;
  const identity = Math.max(nameScore, enseigneScore, addressScore === 1 ? 0.85 : addressScore * 0.5);
  if (identity < MIN_IDENTITY) return zero;
  const proximity = 1 - Math.min(1, distanceM / MAX_DISTANCE_M);
  const score = 0.8 * identity + 0.2 * proximity;
  return { score, parts: { distance: proximity, name: nameScore, enseigne: enseigneScore, address: addressScore }, distanceM, matchedName: best.name };
}
function recordKey(rec) {
  return rec.siret ?? `siren:${rec.siren}`;
}
function toCandidate2(poi, rec, scored) {
  return {
    osmId: poi.id,
    siret: rec.siret,
    siren: rec.siren,
    sireneName: rec.nomComplet ?? rec.nomRaisonSociale,
    // The name the score came from, which is often NOT nomComplet.
    matchedName: scored.matchedName,
    osmName: poi.name,
    score: Number(scored.score.toFixed(4)),
    parts: {
      distance: Number(scored.parts.distance.toFixed(4)),
      name: Number(scored.parts.name.toFixed(4)),
      enseigne: Number(scored.parts.enseigne.toFixed(4)),
      address: Number(scored.parts.address.toFixed(4))
    },
    distanceM: Math.round(scored.distanceM)
  };
}
function matchLanes(pois, records) {
  const index = buildIndex(records);
  const scored = [];
  for (const poi of pois) {
    for (const rec of nearby(index, poi.lat, poi.lon)) {
      const s = scorePair(poi, rec);
      if (s.score >= MERGE_LOW) scored.push({ poi, rec, s });
    }
  }
  scored.sort((a, b) => b.s.score - a.s.score);
  const merged = /* @__PURE__ */ new Map();
  const usedPoi = /* @__PURE__ */ new Set();
  const usedRec = /* @__PURE__ */ new Set();
  const undecided = [];
  for (const { poi, rec, s } of scored) {
    const key = recordKey(rec);
    if (usedPoi.has(poi.id) || usedRec.has(key)) continue;
    if (s.score >= MERGE_HIGH) {
      merged.set(key, poi.id);
      usedPoi.add(poi.id);
      usedRec.add(key);
    } else {
      undecided.push(toCandidate2(poi, rec, s));
    }
  }
  return { merged, undecided };
}
function buildMatchTodo(undecided) {
  return {
    version: 1,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    // Strongest first: the agent works down a list that gets easier to reject,
    // and can stop when the evidence thins out.
    pairs: [...undecided].sort((a, b) => b.score - a.score)
  };
}
function applyVerdicts(places, verdicts) {
  const byOsm = /* @__PURE__ */ new Map();
  const byRecord = /* @__PURE__ */ new Map();
  for (const p of places) {
    if (p.osm) byOsm.set(p.osm.id, p);
    if (p.sirene) byRecord.set(recordKey(p.sirene), p);
  }
  let mergedCount = 0;
  let skipped = 0;
  const unknown = [];
  for (const v of verdicts) {
    if (!v.merge) {
      skipped++;
      continue;
    }
    const key = v.siret ?? (v.siren ? `siren:${v.siren}` : void 0);
    const osmPlace = byOsm.get(v.osmId);
    const recPlace = key ? byRecord.get(key) : void 0;
    if (!osmPlace || !recPlace || osmPlace === recPlace) {
      unknown.push(`${v.osmId} <-> ${key ?? "?"}`);
      continue;
    }
    osmPlace.sirene = recPlace.sirene;
    osmPlace.sources = [.../* @__PURE__ */ new Set([...osmPlace.sources, "sirene"])];
    osmPlace.matchConfidence = 1;
    osmPlace.address = { ...recPlace.address, ...osmPlace.address };
    recPlace.id = "";
    mergedCount++;
  }
  for (let i = places.length - 1; i >= 0; i--) if (places[i].id === "") places.splice(i, 1);
  return { merged: mergedCount, skipped, unknown };
}

// src/naf.ts
var NAF_SECTION_DIVISIONS = [
  ["A", 1, 3],
  ["B", 5, 9],
  ["C", 10, 33],
  ["D", 35, 35],
  ["E", 36, 39],
  ["F", 41, 43],
  ["G", 45, 47],
  ["H", 49, 53],
  ["I", 55, 56],
  ["J", 58, 63],
  ["K", 64, 66],
  ["L", 68, 68],
  ["M", 69, 75],
  ["N", 77, 82],
  ["O", 84, 84],
  ["P", 85, 85],
  ["Q", 86, 88],
  ["R", 90, 93],
  ["S", 94, 96],
  ["T", 97, 98],
  ["U", 99, 99]
];
var NAF_CODES = [
  "01.11Z",
  "01.12Z",
  "01.13Z",
  "01.14Z",
  "01.15Z",
  "01.16Z",
  "01.19Z",
  "01.21Z",
  "01.22Z",
  "01.23Z",
  "01.24Z",
  "01.25Z",
  "01.26Z",
  "01.27Z",
  "01.28Z",
  "01.29Z",
  "01.30Z",
  "01.41Z",
  "01.42Z",
  "01.43Z",
  "01.44Z",
  "01.45Z",
  "01.46Z",
  "01.47Z",
  "01.49Z",
  "01.50Z",
  "01.61Z",
  "01.62Z",
  "01.63Z",
  "01.64Z",
  "01.70Z",
  "02.10Z",
  "02.20Z",
  "02.30Z",
  "02.40Z",
  "03.11Z",
  "03.12Z",
  "03.21Z",
  "03.22Z",
  "05.10Z",
  "05.20Z",
  "06.10Z",
  "06.20Z",
  "07.10Z",
  "07.21Z",
  "07.29Z",
  "08.11Z",
  "08.12Z",
  "08.91Z",
  "08.92Z",
  "08.93Z",
  "08.99Z",
  "09.10Z",
  "09.90Z",
  "10.11Z",
  "10.12Z",
  "10.13A",
  "10.13B",
  "10.20Z",
  "10.31Z",
  "10.32Z",
  "10.39A",
  "10.39B",
  "10.41A",
  "10.41B",
  "10.42Z",
  "10.51A",
  "10.51B",
  "10.51C",
  "10.51D",
  "10.52Z",
  "10.61A",
  "10.61B",
  "10.62Z",
  "10.71A",
  "10.71B",
  "10.71C",
  "10.71D",
  "10.72Z",
  "10.73Z",
  "10.81Z",
  "10.82Z",
  "10.83Z",
  "10.84Z",
  "10.85Z",
  "10.86Z",
  "10.89Z",
  "10.91Z",
  "10.92Z",
  "11.01Z",
  "11.02A",
  "11.02B",
  "11.03Z",
  "11.04Z",
  "11.05Z",
  "11.06Z",
  "11.07A",
  "11.07B",
  "12.00Z",
  "13.10Z",
  "13.20Z",
  "13.30Z",
  "13.91Z",
  "13.92Z",
  "13.93Z",
  "13.94Z",
  "13.95Z",
  "13.96Z",
  "13.99Z",
  "14.11Z",
  "14.12Z",
  "14.13Z",
  "14.14Z",
  "14.19Z",
  "14.20Z",
  "14.31Z",
  "14.39Z",
  "15.11Z",
  "15.12Z",
  "15.20Z",
  "16.10A",
  "16.10B",
  "16.21Z",
  "16.22Z",
  "16.23Z",
  "16.24Z",
  "16.29Z",
  "17.11Z",
  "17.12Z",
  "17.21A",
  "17.21B",
  "17.21C",
  "17.22Z",
  "17.23Z",
  "17.24Z",
  "17.29Z",
  "18.11Z",
  "18.12Z",
  "18.13Z",
  "18.14Z",
  "18.20Z",
  "19.10Z",
  "19.20Z",
  "20.11Z",
  "20.12Z",
  "20.13A",
  "20.13B",
  "20.14Z",
  "20.15Z",
  "20.16Z",
  "20.17Z",
  "20.20Z",
  "20.30Z",
  "20.41Z",
  "20.42Z",
  "20.51Z",
  "20.52Z",
  "20.53Z",
  "20.59Z",
  "20.60Z",
  "21.10Z",
  "21.20Z",
  "22.11Z",
  "22.19Z",
  "22.21Z",
  "22.22Z",
  "22.23Z",
  "22.29A",
  "22.29B",
  "23.11Z",
  "23.12Z",
  "23.13Z",
  "23.14Z",
  "23.19Z",
  "23.20Z",
  "23.31Z",
  "23.32Z",
  "23.41Z",
  "23.42Z",
  "23.43Z",
  "23.44Z",
  "23.49Z",
  "23.51Z",
  "23.52Z",
  "23.61Z",
  "23.62Z",
  "23.63Z",
  "23.64Z",
  "23.65Z",
  "23.69Z",
  "23.70Z",
  "23.91Z",
  "23.99Z",
  "24.10Z",
  "24.20Z",
  "24.31Z",
  "24.32Z",
  "24.33Z",
  "24.34Z",
  "24.41Z",
  "24.42Z",
  "24.43Z",
  "24.44Z",
  "24.45Z",
  "24.46Z",
  "24.51Z",
  "24.52Z",
  "24.53Z",
  "24.54Z",
  "25.11Z",
  "25.12Z",
  "25.21Z",
  "25.29Z",
  "25.30Z",
  "25.40Z",
  "25.50A",
  "25.50B",
  "25.61Z",
  "25.62A",
  "25.62B",
  "25.71Z",
  "25.72Z",
  "25.73A",
  "25.73B",
  "25.91Z",
  "25.92Z",
  "25.93Z",
  "25.94Z",
  "25.99A",
  "25.99B",
  "26.11Z",
  "26.12Z",
  "26.20Z",
  "26.30Z",
  "26.40Z",
  "26.51A",
  "26.51B",
  "26.52Z",
  "26.60Z",
  "26.70Z",
  "26.80Z",
  "27.11Z",
  "27.12Z",
  "27.20Z",
  "27.31Z",
  "27.32Z",
  "27.33Z",
  "27.40Z",
  "27.51Z",
  "27.52Z",
  "27.90Z",
  "28.11Z",
  "28.12Z",
  "28.13Z",
  "28.14Z",
  "28.15Z",
  "28.21Z",
  "28.22Z",
  "28.23Z",
  "28.24Z",
  "28.25Z",
  "28.29A",
  "28.29B",
  "28.30Z",
  "28.41Z",
  "28.49Z",
  "28.91Z",
  "28.92Z",
  "28.93Z",
  "28.94Z",
  "28.95Z",
  "28.96Z",
  "28.99A",
  "28.99B",
  "29.10Z",
  "29.20Z",
  "29.31Z",
  "29.32Z",
  "30.11Z",
  "30.12Z",
  "30.20Z",
  "30.30Z",
  "30.40Z",
  "30.91Z",
  "30.92Z",
  "30.99Z",
  "31.01Z",
  "31.02Z",
  "31.03Z",
  "31.09A",
  "31.09B",
  "32.11Z",
  "32.12Z",
  "32.13Z",
  "32.20Z",
  "32.30Z",
  "32.40Z",
  "32.50A",
  "32.50B",
  "32.91Z",
  "32.99Z",
  "33.11Z",
  "33.12Z",
  "33.13Z",
  "33.14Z",
  "33.15Z",
  "33.16Z",
  "33.17Z",
  "33.19Z",
  "33.20A",
  "33.20B",
  "33.20C",
  "33.20D",
  "35.11Z",
  "35.12Z",
  "35.13Z",
  "35.14Z",
  "35.21Z",
  "35.22Z",
  "35.23Z",
  "35.30Z",
  "36.00Z",
  "37.00Z",
  "38.11Z",
  "38.12Z",
  "38.21Z",
  "38.22Z",
  "38.31Z",
  "38.32Z",
  "39.00Z",
  "41.10A",
  "41.10B",
  "41.10C",
  "41.10D",
  "41.20A",
  "41.20B",
  "42.11Z",
  "42.12Z",
  "42.13A",
  "42.13B",
  "42.21Z",
  "42.22Z",
  "42.91Z",
  "42.99Z",
  "43.11Z",
  "43.12A",
  "43.12B",
  "43.13Z",
  "43.21A",
  "43.21B",
  "43.22A",
  "43.22B",
  "43.29A",
  "43.29B",
  "43.31Z",
  "43.32A",
  "43.32B",
  "43.32C",
  "43.33Z",
  "43.34Z",
  "43.39Z",
  "43.91A",
  "43.91B",
  "43.99A",
  "43.99B",
  "43.99C",
  "43.99D",
  "43.99E",
  "45.11Z",
  "45.19Z",
  "45.20A",
  "45.20B",
  "45.31Z",
  "45.32Z",
  "45.40Z",
  "46.11Z",
  "46.12A",
  "46.12B",
  "46.13Z",
  "46.14Z",
  "46.15Z",
  "46.16Z",
  "46.17A",
  "46.17B",
  "46.18Z",
  "46.19A",
  "46.19B",
  "46.21Z",
  "46.22Z",
  "46.23Z",
  "46.24Z",
  "46.31Z",
  "46.32A",
  "46.32B",
  "46.32C",
  "46.33Z",
  "46.34Z",
  "46.35Z",
  "46.36Z",
  "46.37Z",
  "46.38A",
  "46.38B",
  "46.39A",
  "46.39B",
  "46.41Z",
  "46.42Z",
  "46.43Z",
  "46.44Z",
  "46.45Z",
  "46.46Z",
  "46.47Z",
  "46.48Z",
  "46.49Z",
  "46.51Z",
  "46.52Z",
  "46.61Z",
  "46.62Z",
  "46.63Z",
  "46.64Z",
  "46.65Z",
  "46.66Z",
  "46.69A",
  "46.69B",
  "46.69C",
  "46.71Z",
  "46.72Z",
  "46.73A",
  "46.73B",
  "46.74A",
  "46.74B",
  "46.75Z",
  "46.76Z",
  "46.77Z",
  "46.90Z",
  "47.11A",
  "47.11B",
  "47.11C",
  "47.11D",
  "47.11E",
  "47.11F",
  "47.19A",
  "47.19B",
  "47.21Z",
  "47.22Z",
  "47.23Z",
  "47.24Z",
  "47.25Z",
  "47.26Z",
  "47.29Z",
  "47.30Z",
  "47.41Z",
  "47.42Z",
  "47.43Z",
  "47.51Z",
  "47.52A",
  "47.52B",
  "47.53Z",
  "47.54Z",
  "47.59A",
  "47.59B",
  "47.61Z",
  "47.62Z",
  "47.63Z",
  "47.64Z",
  "47.65Z",
  "47.71Z",
  "47.72A",
  "47.72B",
  "47.73Z",
  "47.74Z",
  "47.75Z",
  "47.76Z",
  "47.77Z",
  "47.78A",
  "47.78B",
  "47.78C",
  "47.79Z",
  "47.81Z",
  "47.82Z",
  "47.89Z",
  "47.91A",
  "47.91B",
  "47.99A",
  "47.99B",
  "49.10Z",
  "49.20Z",
  "49.31Z",
  "49.32Z",
  "49.39A",
  "49.39B",
  "49.39C",
  "49.41A",
  "49.41B",
  "49.41C",
  "49.42Z",
  "49.50Z",
  "50.10Z",
  "50.20Z",
  "50.30Z",
  "50.40Z",
  "51.10Z",
  "51.21Z",
  "51.22Z",
  "52.10A",
  "52.10B",
  "52.21Z",
  "52.22Z",
  "52.23Z",
  "52.24A",
  "52.24B",
  "52.29A",
  "52.29B",
  "53.10Z",
  "53.20Z",
  "55.10Z",
  "55.20Z",
  "55.30Z",
  "55.90Z",
  "56.10A",
  "56.10B",
  "56.10C",
  "56.21Z",
  "56.29A",
  "56.29B",
  "56.30Z",
  "58.11Z",
  "58.12Z",
  "58.13Z",
  "58.14Z",
  "58.19Z",
  "58.21Z",
  "58.29A",
  "58.29B",
  "58.29C",
  "59.11A",
  "59.11B",
  "59.11C",
  "59.12Z",
  "59.13A",
  "59.13B",
  "59.14Z",
  "59.20Z",
  "60.10Z",
  "60.20A",
  "60.20B",
  "61.10Z",
  "61.20Z",
  "61.30Z",
  "61.90Z",
  "62.01Z",
  "62.02A",
  "62.02B",
  "62.03Z",
  "62.09Z",
  "63.11Z",
  "63.12Z",
  "63.91Z",
  "63.99Z",
  "64.11Z",
  "64.19Z",
  "64.20Z",
  "64.30Z",
  "64.91Z",
  "64.92Z",
  "64.99Z",
  "65.11Z",
  "65.12Z",
  "65.20Z",
  "65.30Z",
  "66.11Z",
  "66.12Z",
  "66.19A",
  "66.19B",
  "66.21Z",
  "66.22Z",
  "66.29Z",
  "66.30Z",
  "68.10Z",
  "68.20A",
  "68.20B",
  "68.31Z",
  "68.32A",
  "68.32B",
  "69.10Z",
  "69.20Z",
  "70.10Z",
  "70.21Z",
  "70.22Z",
  "71.11Z",
  "71.12A",
  "71.12B",
  "71.20A",
  "71.20B",
  "72.11Z",
  "72.19Z",
  "72.20Z",
  "73.11Z",
  "73.12Z",
  "73.20Z",
  "74.10Z",
  "74.20Z",
  "74.30Z",
  "74.90A",
  "74.90B",
  "75.00Z",
  "77.11A",
  "77.11B",
  "77.12Z",
  "77.21Z",
  "77.22Z",
  "77.29Z",
  "77.31Z",
  "77.32Z",
  "77.33Z",
  "77.34Z",
  "77.35Z",
  "77.39Z",
  "77.40Z",
  "78.10Z",
  "78.20Z",
  "78.30Z",
  "79.11Z",
  "79.12Z",
  "79.90Z",
  "80.10Z",
  "80.20Z",
  "80.30Z",
  "81.10Z",
  "81.21Z",
  "81.22Z",
  "81.29A",
  "81.29B",
  "81.30Z",
  "82.11Z",
  "82.19Z",
  "82.20Z",
  "82.30Z",
  "82.91Z",
  "82.92Z",
  "82.99Z",
  "84.11Z",
  "84.12Z",
  "84.13Z",
  "84.21Z",
  "84.22Z",
  "84.23Z",
  "84.24Z",
  "84.25Z",
  "84.30A",
  "84.30B",
  "84.30C",
  "85.10Z",
  "85.20Z",
  "85.31Z",
  "85.32Z",
  "85.41Z",
  "85.42Z",
  "85.51Z",
  "85.52Z",
  "85.53Z",
  "85.59A",
  "85.59B",
  "85.60Z",
  "86.10Z",
  "86.21Z",
  "86.22A",
  "86.22B",
  "86.22C",
  "86.23Z",
  "86.90A",
  "86.90B",
  "86.90C",
  "86.90D",
  "86.90E",
  "86.90F",
  "87.10A",
  "87.10B",
  "87.10C",
  "87.20A",
  "87.20B",
  "87.30A",
  "87.30B",
  "87.90A",
  "87.90B",
  "88.10A",
  "88.10B",
  "88.10C",
  "88.91A",
  "88.91B",
  "88.99A",
  "88.99B",
  "90.01Z",
  "90.02Z",
  "90.03A",
  "90.03B",
  "90.04Z",
  "91.01Z",
  "91.02Z",
  "91.03Z",
  "91.04Z",
  "92.00Z",
  "93.11Z",
  "93.12Z",
  "93.13Z",
  "93.19Z",
  "93.21Z",
  "93.29Z",
  "94.11Z",
  "94.12Z",
  "94.20Z",
  "94.91Z",
  "94.92Z",
  "94.99Z",
  "95.11Z",
  "95.12Z",
  "95.21Z",
  "95.22Z",
  "95.23Z",
  "95.24Z",
  "95.25Z",
  "95.29Z",
  "96.01A",
  "96.01B",
  "96.02A",
  "96.02B",
  "96.03Z",
  "96.04Z",
  "96.09Z",
  "97.00Z",
  "98.10Z",
  "98.20Z",
  "99.00Z"
];
function nafSection(code) {
  const div = Number.parseInt(code.slice(0, 2), 10);
  if (!Number.isFinite(div)) return void 0;
  return NAF_SECTION_DIVISIONS.find(([, lo, hi]) => div >= lo && div <= hi)?.[0];
}
function divisionsOfSection(section) {
  const byDivision = /* @__PURE__ */ new Map();
  for (const code of NAF_CODES) {
    if (nafSection(code) !== section) continue;
    const div = code.slice(0, 2);
    const list2 = byDivision.get(div);
    if (list2) list2.push(code);
    else byDivision.set(div, [code]);
  }
  return [...byDivision.values()];
}
var NAF_SECTIONS = NAF_SECTION_DIVISIONS.map(([s]) => s);

// src/sirene.ts
var BASE = "https://recherche-entreprises.api.gouv.fr";
var HARD_CAP = 1e4;
var PER_PAGE = 25;
var REQUEST_DELAY_MS = 200;
var PAGE_CONCURRENCY = 4;
var EFFECTIF_BANDS = [
  { code: "NN", floor: -1, label: "non d\xE9termin\xE9" },
  { code: "00", floor: 0, label: "0 salari\xE9" },
  { code: "01", floor: 1, label: "1 \xE0 2" },
  { code: "02", floor: 3, label: "3 \xE0 5" },
  { code: "03", floor: 6, label: "6 \xE0 9" },
  { code: "11", floor: 10, label: "10 \xE0 19" },
  { code: "12", floor: 20, label: "20 \xE0 49" },
  { code: "21", floor: 50, label: "50 \xE0 99" },
  { code: "22", floor: 100, label: "100 \xE0 199" },
  { code: "31", floor: 200, label: "200 \xE0 249" },
  { code: "32", floor: 250, label: "250 \xE0 499" },
  { code: "41", floor: 500, label: "500 \xE0 999" },
  { code: "42", floor: 1e3, label: "1 000 \xE0 1 999" },
  { code: "51", floor: 2e3, label: "2 000 \xE0 4 999" },
  { code: "52", floor: 5e3, label: "5 000 \xE0 9 999" },
  { code: "53", floor: 1e4, label: "10 000 et plus" }
];
var EFFECTIF_LABELS = Object.fromEntries(EFFECTIF_BANDS.map((b) => [b.code, b.label]));
var EFFECTIF_FLOOR = Object.fromEntries(EFFECTIF_BANDS.map((b) => [b.code, b.floor]));
function endpointFor(query) {
  return query.point && !query.codeCommune?.length && !query.q ? "near_point" : "search";
}
function buildUrl(query, page, perPage) {
  const endpoint = endpointFor(query);
  const url = new URL(`${BASE}/${endpoint}`);
  if (endpoint === "near_point" && query.point) {
    url.searchParams.set("lat", String(query.point.lat));
    url.searchParams.set("long", String(query.point.lon));
    url.searchParams.set("radius", String(Math.min(50, query.point.radiusKm)));
  } else {
    if (query.q) url.searchParams.set("q", query.q);
    if (query.codeCommune?.length) url.searchParams.set("code_commune", query.codeCommune.join(","));
    if (query.etatAdministratif) url.searchParams.set("etat_administratif", query.etatAdministratif);
    if (query.tranchesEffectif?.length) url.searchParams.set("tranche_effectif_salarie", query.tranchesEffectif.join(","));
  }
  if (query.sections?.length) url.searchParams.set("section_activite_principale", query.sections.join(","));
  if (query.activitePrincipale?.length) url.searchParams.set("activite_principale", query.activitePrincipale.join(","));
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("limite_matching_etablissements", "100");
  return url.href;
}
async function fetchPage(query, page, perPage = PER_PAGE) {
  const url = buildUrl(query, page, perPage);
  await awaitHostSlot(url, REQUEST_DELAY_MS);
  const res = await httpJson("GET", url, void 0, { timeoutMs: 3e4, retries: 2, userAgent: politeUa() });
  if (!res.ok) {
    const message = firstText(res.data?.erreur, res.data?.detail, res.error) ?? `HTTP ${res.status}`;
    return { results: [], total: 0, error: message };
  }
  return { results: res.data?.results ?? [], total: res.data?.total_results ?? 0 };
}
function parseRawAddress(raw) {
  const address = { raw: raw ?? void 0 };
  if (!raw) return address;
  const m = /^(?:(\d+[A-Z]?)\s+)?(.*?)\s+(\d{5})\s+(.+)$/.exec(raw.trim());
  if (!m) return address;
  address.numero = m[1];
  address.codePostal = m[3];
  address.commune = m[4];
  const street = (m[2] ?? "").trim();
  const typeMatch = /^(RUE|AVENUE|AV|BOULEVARD|BD|QUAI|PLACE|PL|IMPASSE|ALLEE|ALLÉE|CHEMIN|ROUTE|RTE|COURS|SQUARE|PASSAGE|VILLA|SENTIER|ESPLANADE|PARVIS|ROND[- ]POINT|ZONE|ZA|ZI|ZAC|LIEU[- ]DIT|CITE|CITÉ|FAUBOURG|GALERIE|MAIL|PROMENADE|TRAVERSE|VOIE)\s+(.+)$/i.exec(
    street
  );
  if (typeMatch) {
    address.typeVoie = typeMatch[1]?.toUpperCase();
    address.libelleVoie = typeMatch[2];
  } else {
    address.libelleVoie = street || void 0;
  }
  return address;
}
function mapDirigeants(raw) {
  return (raw ?? []).map((d) => ({
    nom: d?.nom ?? void 0,
    prenoms: d?.prenoms ?? void 0,
    qualite: d?.qualite ?? void 0,
    dateNaissance: d?.date_de_naissance ?? d?.annee_de_naissance ?? void 0,
    denomination: d?.denomination ?? void 0,
    siren: d?.siren ?? void 0
  }));
}
function latestFinances(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const years = Object.keys(raw).filter((y) => /^\d{4}$/.test(y));
  if (years.length === 0) return void 0;
  const year = years.sort().at(-1);
  const entry = raw[year] ?? {};
  return { annee: year, ca: entry.ca ?? void 0, resultatNet: entry.resultat_net ?? void 0 };
}
function expandRecord(entity) {
  const base = {
    siren: String(entity?.siren ?? ""),
    nomComplet: entity?.nom_complet ?? void 0,
    nomRaisonSociale: entity?.nom_raison_sociale ?? void 0,
    sigle: entity?.sigle ?? void 0,
    section: entity?.section_activite_principale ?? void 0,
    categorieEntreprise: entity?.categorie_entreprise ?? void 0,
    natureJuridique: entity?.nature_juridique ?? void 0,
    dateCreation: entity?.date_creation ?? void 0,
    nombreEtablissements: entity?.nombre_etablissements ?? void 0,
    dirigeants: mapDirigeants(entity?.dirigeants),
    finances: latestFinances(entity?.finances)
  };
  const establishments = entity?.matching_etablissements?.length ? entity.matching_etablissements : entity?.siege ? [entity.siege] : [];
  return establishments.filter((e) => e).map((e) => {
    const siege = entity?.siege;
    const address = siege && e.siret === siege.siret ? {
      raw: siege.adresse ?? void 0,
      numero: siege.numero_voie ?? void 0,
      typeVoie: siege.type_voie ?? void 0,
      libelleVoie: siege.libelle_voie ?? void 0,
      codePostal: siege.code_postal ?? void 0,
      codeCommune: siege.commune ?? void 0,
      commune: siege.libelle_commune ?? void 0,
      pays: siege.libelle_pays_etranger ?? "France"
    } : { ...parseRawAddress(e.adresse), codeCommune: e.commune ?? void 0, commune: e.libelle_commune ?? void 0, pays: "France" };
    const lat = Number.parseFloat(e.latitude);
    const lon = Number.parseFloat(e.longitude);
    return {
      ...base,
      siret: e.siret ?? void 0,
      enseignes: (e.liste_enseignes ?? []).filter(Boolean),
      nafCode: e.activite_principale ?? entity?.activite_principale ?? void 0,
      effectifTranche: e.tranche_effectif_salarie ?? entity?.tranche_effectif_salarie ?? void 0,
      effectifAnnee: e.annee_tranche_effectif_salarie ?? void 0,
      dateFermeture: e.date_fermeture ?? void 0,
      etatAdministratif: e.etat_administratif ?? entity?.etat_administratif ?? void 0,
      estSiege: Boolean(e.est_siege),
      address,
      lat: Number.isFinite(lat) ? lat : void 0,
      lon: Number.isFinite(lon) ? lon : void 0
    };
  });
}
function applyClientFilters(records, query, endpoint) {
  if (endpoint !== "near_point") return records;
  let out2 = records;
  if (query.etatAdministratif) out2 = out2.filter((r) => r.etatAdministratif === query.etatAdministratif);
  if (query.tranchesEffectif?.length) {
    const wanted = new Set(query.tranchesEffectif);
    out2 = out2.filter((r) => r.effectifTranche && wanted.has(r.effectifTranche));
  }
  return out2;
}
async function drain(query, budget, label, opts) {
  const first = await fetchPage(query, 1);
  if (first.error) return { records: [], total: 0, error: first.error };
  const endpoint = endpointFor(query);
  const collected2 = [];
  const push = (entities) => {
    for (const e of entities) {
      for (const rec of applyClientFilters(expandRecord(e), query, endpoint)) {
        if (budget.left <= 0) return;
        collected2.push(rec);
        budget.left--;
      }
    }
  };
  push(first.results);
  const reachablePages = Math.floor(HARD_CAP / PER_PAGE);
  const lastPage = Math.min(reachablePages, Math.ceil(Math.min(first.total, HARD_CAP) / PER_PAGE));
  const pages = [];
  for (let p = 2; p <= lastPage; p++) pages.push(p);
  let stopped = false;
  await mapLimit(pages, PAGE_CONCURRENCY, async (page) => {
    if (stopped || budget.left <= 0) return;
    const outcome = await fetchPage(query, page);
    if (outcome.error) {
      stopped = true;
      return;
    }
    push(outcome.results);
    opts.onProgress?.(collected2.length, label);
    if (budget.left <= 0) stopped = true;
  });
  return { records: collected2, total: first.total };
}
async function fetchSirene(query, opts = {}) {
  const maxResults = opts.maxResults ?? 3e3;
  const maxDepth = opts.maxSplitDepth ?? 2;
  const budget = { left: maxResults };
  const notes = [];
  const bySiret = /* @__PURE__ */ new Map();
  let partitions = 0;
  let truncated = false;
  let truncReason;
  const absorb = (records2) => {
    for (const r of records2) {
      const key = r.siret ?? `siren:${r.siren}`;
      if (!bySiret.has(key)) bySiret.set(key, r);
    }
  };
  async function walk(part, label, depth) {
    if (budget.left <= 0) return;
    const probe = await fetchPage(part, 1, 1);
    if (probe.error) {
      notes.push(`sirene: ${label} failed \u2014 ${probe.error}`);
      opts.onNote?.(`sirene: ${label} failed (${probe.error})`);
      truncated = true;
      truncReason ??= probe.error;
      return;
    }
    if (probe.total >= HARD_CAP && depth < maxDepth) {
      if (depth === 0) {
        opts.onNote?.(`sirene: ${label} reports >= ${HARD_CAP} (the API clamps the count) \u2014 splitting by NAF section`);
        notes.push(`sirene: ${label} is at or above the ${HARD_CAP} cap; split into ${NAF_SECTIONS.length} NAF sections`);
        for (const section2 of part.sections?.length ? part.sections : NAF_SECTIONS) {
          await walk({ ...part, sections: [section2] }, `${label} / section ${section2}`, depth + 1);
        }
        return;
      }
      const section = part.sections?.[0];
      if (section) {
        const divisions = divisionsOfSection(section);
        opts.onNote?.(`sirene: ${label} still at the cap \u2014 splitting into ${divisions.length} NAF divisions`);
        notes.push(`sirene: ${label} is at or above the ${HARD_CAP} cap; split into ${divisions.length} NAF divisions`);
        for (const codes of divisions) {
          await walk({ ...part, activitePrincipale: codes }, `${label} / division ${codes[0]?.slice(0, 2)}`, depth + 1);
        }
        return;
      }
    }
    if (probe.total >= HARD_CAP) {
      truncated = true;
      truncReason ??= `a partition (${label}) still reports at least ${HARD_CAP} results after the split ladder ran out`;
      notes.push(`sirene: TRUNCATED at ${label} \u2014 at least ${HARD_CAP} results and no split left`);
      opts.onNote?.(`sirene: TRUNCATED \u2014 ${label} has at least ${HARD_CAP} results`);
    }
    partitions++;
    const { records: records2, error } = await drain(part, budget, label, opts);
    if (error) {
      notes.push(`sirene: ${label} stopped early \u2014 ${error}`);
      truncated = true;
      truncReason ??= error;
    }
    absorb(records2);
  }
  await walk(query, "query", 0);
  if (budget.left <= 0) {
    truncated = true;
    truncReason ??= `the --max-results budget of ${maxResults} was reached`;
    notes.push(`sirene: stopped at the --max-results budget of ${maxResults}; raise it or narrow the filters`);
    opts.onNote?.(`sirene: hit the --max-results budget of ${maxResults} \u2014 the lane is INCOMPLETE`);
  }
  const records = [...bySiret.values()];
  return {
    records,
    notes,
    coverage: {
      lane: "sirene",
      requested: maxResults,
      returned: records.length,
      truncated,
      reason: truncReason,
      partitions: Math.max(1, partitions)
    }
  };
}

// src/run.ts
import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
var DEFAULT_OUT = ".ultraprospect";
function shortLabel(label) {
  const first = label.split(",")[0]?.trim();
  return first && first.length > 1 ? first : label;
}
function newRun(outRoot, label) {
  const slug = slugify(shortLabel(label)) || "run";
  const id = runId();
  const root = resolve(outRoot);
  const dir = join(root, "runs", `${slug}-${id}`);
  mkdirSync(dir, { recursive: true });
  return { root, dir, slug, id };
}
function resolveRun(pathOrRoot) {
  const p = resolve(pathOrRoot);
  if (existsSync(join(p, "manifest.json"))) return p;
  const runsDir = existsSync(join(p, "runs")) ? join(p, "runs") : p;
  if (!existsSync(runsDir)) throw new Error(`no run directory at ${p}`);
  const candidates = readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(runsDir, e.name, "manifest.json"))).map((e) => e.name).sort();
  const newest = candidates.at(-1);
  if (!newest) throw new Error(`no run with a manifest.json under ${runsDir}`);
  return join(runsDir, newest);
}
function requireManifest(runDir) {
  const m = readManifest(runDir);
  if (!m) throw new Error(`${join(runDir, "manifest.json")} is missing or unreadable \u2014 is this a run directory?`);
  return m;
}
function writeRunManifest(runDir, manifest) {
  writeManifest(runDir, manifest);
}
function readPlaces(runDir) {
  const places = readJsonSafe(join(runDir, "places.json"));
  if (!places) throw new Error(`${join(runDir, "places.json")} is missing \u2014 run \`ultraprospect scan\` first`);
  return places;
}
function writePlaces(runDir, places) {
  writeArtifact(join(runDir, "places.json"), JSON.stringify(places, null, 2) + "\n");
}
function writeJson(runDir, file, value) {
  writeArtifact(join(runDir, file), JSON.stringify(value, null, 2) + "\n");
}
var LICENCES = [
  "Places and tags: \xA9 OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright)",
  "French company data: base Sirene / RNE via recherche-entreprises.api.gouv.fr, Licence Ouverte 2.0",
  "Geocoding: Nominatim (ODbL) and Base Adresse Nationale (Licence Ouverte 2.0)"
];
function emptyManifest(slug) {
  return {
    version: 1,
    tool: "ultraprospect",
    toolVersion: VERSION,
    builtAt: (/* @__PURE__ */ new Date()).toISOString(),
    slug,
    target: { query: "", label: "", lat: 0, lon: 0, bbox: [0, 0, 0, 0], source: "nominatim" },
    filters: {},
    lanes: [],
    counts: { osm: 0, sirene: 0, google: 0, places: 0, merged: 0, undecided: 0, withWebsite: 0, enrichedTier1: 0, enrichedTier2: 0, dossiers: 0 },
    truncated: false,
    notes: [],
    licences: LICENCES,
    timings: {}
  };
}

// src/fixture.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2 } from "fs";
import { join as join2 } from "path";
function loadFixture(dir) {
  const target = readJsonSafe(join2(dir, "target.json"));
  if (!target) throw new Error(`${join2(dir, "target.json")} is missing \u2014 a fixture needs the geocoded target it was recorded for`);
  for (const file of ["osm.json", "sirene.json"]) {
    if (!existsSync2(join2(dir, file))) throw new Error(`${join2(dir, file)} is missing \u2014 record it with \`ultraprospect scan --record <dir>\``);
  }
  return {
    target,
    osm: readJsonSafe(join2(dir, "osm.json")) ?? [],
    sirene: readJsonSafe(join2(dir, "sirene.json")) ?? []
  };
}
function recordFixture(dir, outcome, target) {
  mkdirSync2(dir, { recursive: true });
  writeArtifact(join2(dir, "target.json"), JSON.stringify(target, null, 2) + "\n");
  writeArtifact(join2(dir, "osm.json"), JSON.stringify(outcome.osm, null, 2) + "\n");
  writeArtifact(join2(dir, "sirene.json"), JSON.stringify(outcome.sirene, null, 2) + "\n");
}

// src/scan.ts
function bandsAtLeast(minHeadcount) {
  return EFFECTIF_BANDS.filter((b) => b.floor >= 0 && b.floor >= minHeadcount).map((b) => b.code);
}
function placeFromPoi(poi) {
  const website = poiWebsite(poi);
  return {
    id: `osm:${poi.id}`,
    name: poi.name ?? poiCategory(poi) ?? poi.id,
    sources: ["osm"],
    osm: poi,
    address: {
      numero: poi.tags["addr:housenumber"],
      libelleVoie: poi.tags["addr:street"],
      codePostal: poi.tags["addr:postcode"],
      commune: poi.tags["addr:city"]
    },
    lat: poi.lat,
    lon: poi.lon,
    category: poiCategory(poi),
    // A website tagged in OSM is DECLARED by a mapper, not corroborated by us.
    // `resolve` upgrades it to "corroborated" only after fetching the page and
    // finding the company on it.
    website: website ? { url: website, confidence: "declared", evidence: ["osm"] } : void 0,
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: []
  };
}
function placeFromRecord(rec) {
  return {
    id: `sirene:${rec.siret ?? rec.siren}`,
    name: firstText(rec.enseignes[0], rec.nomComplet, rec.nomRaisonSociale, rec.sigle) ?? rec.siren,
    sources: ["sirene"],
    sirene: rec,
    address: rec.address,
    lat: rec.lat,
    lon: rec.lon,
    category: rec.nafCode ? `naf=${rec.nafCode}` : void 0,
    contacts: { emails: [], phones: [], socials: [], people: [] },
    jobs: [],
    pages: []
  };
}
function mergeInto(poiPlace, rec, confidence) {
  poiPlace.sirene = rec;
  poiPlace.sources = [.../* @__PURE__ */ new Set([...poiPlace.sources, "sirene"])];
  poiPlace.matchConfidence = Number(confidence.toFixed(3));
  poiPlace.address = {
    ...rec.address,
    ...Object.fromEntries(Object.entries(poiPlace.address).filter(([, v]) => v !== void 0 && v !== ""))
  };
}
async function runScan(target, opts = {}) {
  const notes = [];
  const note = (n) => {
    notes.push(n);
    opts.onNote?.(n);
  };
  const lanes = [];
  const timings = {};
  const effectifBands = opts.effectif?.length ? opts.effectif : opts.minEffectif ? bandsAtLeast(opts.minEffectif) : void 0;
  const replay = opts.fixture ? loadFixture(opts.fixture) : void 0;
  if (replay) {
    note(`fixture: replaying a recorded sweep from ${opts.fixture}`);
    lanes.push({ lane: "osm", requested: 0, returned: replay.osm.length, truncated: false, reason: "replayed from a fixture", partitions: 1 });
    lanes.push({ lane: "sirene", requested: 0, returned: replay.sirene.length, truncated: false, reason: "replayed from a fixture", partitions: 1 });
  }
  let pois = replay?.osm ?? [];
  if (!replay && !opts.noOsm) {
    const t02 = Date.now();
    const osm = await fetchOsmPois(target, { groups: opts.osmGroups, mirrors: opts.overpass ? [opts.overpass] : void 0, onNote: note });
    timings.osm = Date.now() - t02;
    pois = osm.pois;
    for (const n of osm.notes) notes.push(n);
    lanes.push({
      lane: "osm",
      requested: 0,
      returned: pois.length,
      truncated: osm.incomplete,
      reason: osm.incomplete ? "at least one Overpass tile could not be fetched after the split budget ran out" : void 0,
      partitions: osm.partitions
    });
    if (osm.mirrorsUsed.length) notes.push(`overpass: answered by ${osm.mirrorsUsed.join(", ")}`);
  } else if (!replay) {
    lanes.push({ lane: "osm", requested: 0, returned: 0, truncated: false, reason: "skipped (--no-osm)" });
  }
  let records = replay?.sirene ?? [];
  const registerApplies = target.countryCode === "fr";
  if (!replay && !opts.noSirene && registerApplies) {
    const t02 = Date.now();
    const result = await fetchSirene(
      {
        // A commune code searches the real boundary; a radius is the fallback
        // when the geocoder gave us a point rather than an administrative area.
        codeCommune: target.codeCommune && !target.radiusM ? [target.codeCommune] : void 0,
        point: target.radiusM || !target.codeCommune ? { lat: target.lat, lon: target.lon, radiusKm: (target.radiusM ?? 1e3) / 1e3 } : void 0,
        sections: opts.sections,
        activitePrincipale: opts.naf,
        tranchesEffectif: effectifBands,
        etatAdministratif: opts.includeCeased ? void 0 : "A"
      },
      { maxResults: opts.maxResults, onNote: note }
    );
    timings.sirene = Date.now() - t02;
    records = result.records;
    for (const n of result.notes) notes.push(n);
    lanes.push(result.coverage);
  } else if (!replay) {
    lanes.push({
      lane: "sirene",
      requested: 0,
      returned: 0,
      truncated: false,
      // Not applicable is not the same as failed, and the manifest must not blur
      // them: one is a property of the territory, the other of the run.
      reason: opts.noSirene ? "skipped (--no-sirene)" : `not applicable outside France (country=${target.countryCode ?? "unknown"})`
    });
  }
  const t0 = Date.now();
  const { merged, undecided } = matchLanes(pois, records);
  timings.match = Date.now() - t0;
  const places = [];
  const poiPlaces = /* @__PURE__ */ new Map();
  for (const poi of pois) {
    const p = placeFromPoi(poi);
    poiPlaces.set(poi.id, p);
    places.push(p);
  }
  const claimed = /* @__PURE__ */ new Set();
  for (const rec of records) {
    const key = rec.siret ?? `siren:${rec.siren}`;
    const poiId = merged.get(key);
    const host = poiId ? poiPlaces.get(poiId) : void 0;
    if (host) {
      mergeInto(host, rec, 1);
      claimed.add(key);
    } else {
      places.push(placeFromRecord(rec));
    }
  }
  if (opts.noPeople) {
    let stripped = 0;
    for (const p of places) {
      if (p.sirene?.dirigeants.length) {
        stripped += p.sirene.dirigeants.length;
        p.sirene = { ...p.sirene, dirigeants: [] };
      }
      p.contacts.people = [];
    }
    note(`--no-people: removed ${stripped} named individual(s); the run holds organisation data only`);
  }
  const manifest = emptyManifest(target.label || target.query);
  manifest.target = target;
  manifest.filters = {
    osmGroups: opts.osmGroups ?? "all",
    naf: opts.naf ?? null,
    sections: opts.sections ?? null,
    effectif: effectifBands ?? null,
    includeCeased: Boolean(opts.includeCeased),
    maxResults: opts.maxResults ?? null
  };
  manifest.lanes = lanes;
  manifest.timings = timings;
  manifest.counts = {
    ...manifest.counts,
    osm: pois.length,
    sirene: records.length,
    places: places.length,
    merged: claimed.size,
    undecided: undecided.length,
    withWebsite: places.filter((p) => p.website?.url).length
  };
  manifest.truncated = lanes.some((l) => l.truncated);
  manifest.notes = notes;
  return { places, manifest, osm: pois, sirene: records, undecided, notes };
}
function writeScan(runDir, outcome) {
  writeJson(runDir, "osm.json", outcome.osm);
  writeJson(runDir, "sirene.json", outcome.sirene);
  writePlaces(runDir, outcome.places);
  writeJson(runDir, "MATCH.todo.json", buildMatchTodo(outcome.undecided));
  writeRunManifest(runDir, outcome.manifest);
}

// src/cli.ts
var COMMANDS = ["where", "scan", "match", "doctor", "version"];
var VALUE_FLAGS = [
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
  "record"
];
var BOOL_FLAGS = ["json", "no-osm", "no-sirene", "include-ceased", "no-people", "stdout", "help", "version"];
var HELP = `ultraprospect ${VERSION} \u2014 turn a place into a qualified prospect list

USAGE
  ultraprospect <command> [options]

COMMANDS
  where <query>          Resolve a place name to a search area. Refuses to guess when ambiguous.
  scan                   Discover every company in the area, from OSM and the French register.
  match --apply <file>   Fold the agent's adjudication of MATCH.todo.json back into places.json.
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

Data: \xA9 OpenStreetMap contributors (ODbL); base Sirene / RNE via data.gouv.fr (Licence Ouverte 2.0).
`;
var SPEC = { commands: COMMANDS, valueFlags: VALUE_FLAGS, boolFlags: BOOL_FLAGS };
function say(message) {
  process.stderr.write(`${message}
`);
}
function out(message) {
  process.stdout.write(`${message}
`);
}
function list(raw) {
  if (!raw) return void 0;
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : void 0;
}
async function targetFrom(values, positional) {
  const radiusM = values.radius ? parseDistanceM(values.radius) : void 0;
  if (values.radius && radiusM === void 0) throw new UsageError(`--radius "${values.radius}" is not a distance (try 800, 800m, 2km)`);
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
      source: "nominatim"
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
      bbox: [lat, lat, lon, lon],
      countryCode: values.country?.toLowerCase(),
      source: "nominatim",
      radiusM
    };
  }
  const query = values.where ?? positional;
  if (!query) throw new UsageError("say where to look: --where <place>, or --lat/--long with --radius, or --bbox");
  const result = await resolveWhere(query, {
    country: values.country,
    lang: values.lang,
    pick: values.pick ? clampInt(values.pick, 1, 5, 1) : void 0,
    radiusM
  });
  if (!result.ok) {
    say(`ultraprospect: ${result.reason}`);
    for (const [i, c] of result.candidates.entries()) {
      say(`  ${i + 1}. ${c.label}  [${c.kind}]  ${c.lat.toFixed(5)},${c.lon.toFixed(5)}`);
    }
    if (result.candidates.length) say(`
next: re-run with --pick <n>, or give a more specific query (add the d\xE9partement, the postcode, or the country)`);
    throw Object.assign(new Error(result.reason), { exitCode: EXIT_USAGE, handled: true });
  }
  return result.target;
}
async function cmdWhere(values, bools, positional) {
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
  say(`
next: ultraprospect scan --where ${JSON.stringify(target.query)}`);
  return EXIT_OK;
}
async function cmdScan(values, bools, positional) {
  const target = values.fixture ? loadFixture(values.fixture).target : await targetFrom(values, positional);
  say(`ultraprospect: scanning ${target.label}`);
  const outcome = await runScan(target, {
    osmGroups: list(values["osm-groups"]),
    naf: list(values.naf),
    sections: list(values.section),
    effectif: list(values.effectif),
    minEffectif: values["min-effectif"] ? clampInt(values["min-effectif"], 0, 1e5, 0) : void 0,
    includeCeased: bools.has("include-ceased"),
    noOsm: bools.has("no-osm"),
    noSirene: bools.has("no-sirene"),
    maxResults: values["max-results"] ? clampInt(values["max-results"], 1, 1e4, 3e3) : void 0,
    overpass: values.overpass,
    fixture: values.fixture,
    noPeople: bools.has("no-people"),
    onNote: (n) => say(`  ${n}`)
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
    say("  \u26A0 TRUNCATED \u2014 this run does NOT cover the whole territory:");
    for (const lane of outcome.manifest.lanes.filter((l) => l.truncated)) say(`      ${lane.lane}: ${lane.reason}`);
    say("      narrow with --section / --naf / --min-effectif, or raise --max-results");
  }
  say("");
  say(`next: ultraprospect resolve --run ${run.dir}`);
  return c.places > 0 ? EXIT_OK : EXIT_FAILURE;
}
async function cmdMatch(values, bools) {
  if (!values.run) throw new UsageError("match needs --run <dir>");
  if (!values.apply) throw new UsageError('match needs --apply <file> (a JSON array of {osmId, siret, merge}), or "-" for stdin');
  const runDir = resolveRun(values.run);
  const raw = values.apply === "-" ? readFileSync2(0, "utf8") : readFileSync2(values.apply, "utf8");
  let verdicts;
  try {
    const parsedJson = JSON.parse(raw);
    verdicts = Array.isArray(parsedJson) ? parsedJson : parsedJson?.verdicts ?? [];
  } catch (e) {
    throw new UsageError(`--apply ${values.apply} is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    throw new UsageError("--apply contained no verdicts \u2014 expected [{osmId, siret, merge, why}, ...]");
  }
  const places = readPlaces(runDir);
  const before = places.length;
  const result = applyVerdicts(places, verdicts);
  writePlaces(runDir, places);
  const manifest = requireManifest(runDir);
  manifest.counts.places = places.length;
  manifest.counts.merged += result.merged;
  manifest.counts.undecided = Math.max(0, manifest.counts.undecided - verdicts.length);
  manifest.notes.push(`match: folded ${verdicts.length} adjudication(s) \u2014 ${result.merged} merged, ${result.skipped} kept apart`);
  writeRunManifest(runDir, manifest);
  if (bools.has("json")) out(jsonLine({ run: runDir, ...result, places: places.length }));
  say(`match: ${result.merged} merged, ${result.skipped} kept apart, ${before} -> ${places.length} places`);
  if (result.unknown.length) {
    say(`match: ${result.unknown.length} verdict(s) named a pair this run does not have:`);
    for (const u of result.unknown.slice(0, 10)) say(`    ${u}`);
    say(`next: check that --apply matches ${runDir}/MATCH.todo.json`);
    return EXIT_FAILURE;
  }
  say(`next: ultraprospect resolve --run ${runDir}`);
  return EXIT_OK;
}
async function main(argv) {
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
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    if (!e?.handled) process.stderr.write(`ultraprospect: ${e?.message ?? e}
`);
    process.exitCode = typeof e?.exitCode === "number" ? e.exitCode : EXIT_FAILURE;
  });
}
export {
  BOOL_FLAGS,
  COMMANDS,
  HELP,
  VALUE_FLAGS,
  main
};
