// Text from outside, written into the markdown deliverables.
//
// Every name, title, verdict, note and URL in REPORT.md, DELTA.md and AWARDS.md
// is upstream text nobody here controls: a mapper's tag, a register's record, a
// buyer's notice, a server's error message, an agent's verdict. Written raw, a
// newline in a company name ends its heading and starts a paragraph of the
// name's choosing, `[x](javascript:…)` becomes a link, `<script>` becomes HTML
// in a renderer that allows it, and a pipe splits a table row. So every such
// value goes through ONE escaper, wherever in the document it lands — a table
// cell, a heading or a bullet — and the document's structure is the tool's.

/**
 * One value, made inert on a line of markdown.
 *
 * Line breaks fold to a space, since nothing from outside may start a line.
 * The characters that open a construct inline — emphasis, code, links, raw
 * HTML, table cells — are backslash-escaped, the backslash itself FIRST: a
 * value already holding `\|` used to come out as `\\|`, an escaped backslash
 * followed by a live pipe. A leading `#`, `>`, `-`, `+` or `1.` is escaped
 * too, for the places a value does begin a line.
 */
export function mdInline(value: unknown): string {
  return String(value ?? "")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>|]/g, "\\$&")
    .replace(/^([#>+=-])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

/**
 * A link whose destination came from outside.
 *
 * Only http and https become a link; anything else (`javascript:`, `data:`)
 * is printed as text. The destination is written in angle brackets, so a `)`
 * or a space in the URL cannot end it early.
 */
export function mdLink(text: unknown, url: string | undefined): string {
  const label = mdInline(text);
  if (!url) return label;
  let href: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return label;
    href = u.href.replace(/</g, "%3C").replace(/>/g, "%3E");
  } catch {
    return label;
  }
  return `[${label}](<${href}>)`;
}
