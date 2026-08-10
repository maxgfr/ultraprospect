#!/usr/bin/env node
// Install-bundle gate: prove the repo is shaped so that `npx skills add
// maxgfr/ultraprospect` installs a WORKING skill — engine + references
// included, not just a lone SKILL.md.
//
// The `skills` CLI (skills.sh) early-returns the moment it sees a SKILL.md at
// the repository ROOT and then installs that file ALONE — the sibling scripts/
// and references/ are dropped. A skill is only bundled whole when its SKILL.md
// lives in a SUBDIRECTORY (skills/<name>/). This script asserts that shape, that
// the embedded engine is byte-identical to the tested bundle, and that the docs
// have not drifted from the CLI they describe.
//
// Run by CI and by `pnpm run verify:bundle`. Pure Node, no deps, no network.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Claude Code matches skill descriptions at <=1024 chars; 1000 leaves a safety
// margin so a future edit can't silently cross the cap.
const DESC_MAX = 1000;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = pkg.name;
const skillDir = join(root, "skills", name);
const errors = [];
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  errors.push(m);
  console.log(`  FAIL ${m}`);
};

// 1. No SKILL.md at the repo root (would make `skills add` install it alone).
existsSync(join(root, "SKILL.md"))
  ? bad(`a SKILL.md exists at the repo ROOT — \`skills add\` would install it alone, dropping the engine. Move it to skills/${name}/SKILL.md`)
  : ok("no root SKILL.md");

// 2. The packaged SKILL.md exists with valid, installable frontmatter.
const skillMd = join(skillDir, "SKILL.md");
let skillText = "";
if (!existsSync(skillMd)) {
  bad(`missing ${skillMd} — the skill package has no SKILL.md`);
} else {
  skillText = readFileSync(skillMd, "utf8");
  const fm = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!fm) bad(`skills/${name}/SKILL.md has no frontmatter block`);
  else {
    ok("packaged SKILL.md present with frontmatter");
    const nameLine = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    nameLine === name ? ok(`frontmatter name "${name}" matches package`) : bad(`frontmatter name "${nameLine}" != package name "${name}"`);
    const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!desc) bad("frontmatter has no description");
    else {
      const len = desc.replace(/^["']|["']$/g, "").length;
      len <= DESC_MAX ? ok(`description ${len} chars (<= ${DESC_MAX} headroom cap)`) : bad(`description ${len} chars exceeds the ${DESC_MAX}-char headroom cap`);
    }
    const version = fm[1].match(/\n[ \t]+version:[ \t]*(.+)/)?.[1]?.trim();
    version === pkg.version ? ok(`frontmatter version ${version} matches package`) : bad(`frontmatter version "${version}" != package version "${pkg.version}"`);
  }

  // 3. Every references/*.md mentioned exists, and every file is mentioned.
  const refsDir = join(skillDir, "references");
  if (existsSync(refsDir)) {
    const mentioned = new Set(skillText.match(/references\/[a-z0-9-]+\.md/g) ?? []);
    for (const ref of mentioned) existsSync(join(skillDir, ref)) ? ok(`mentioned ${ref} exists`) : bad(`${ref} is mentioned in SKILL.md but missing from the package`);
    const files = readdirSync(refsDir).filter((f) => f.endsWith(".md"));
    for (const f of files) if (!skillText.includes(`references/${f}`)) bad(`references/${f} exists but SKILL.md never mentions it`);
    ok(`references/ present (${files.length} playbooks)`);
  }
}

// 4. The embedded engine is byte-identical to the committed root bundle.
const engine = `scripts/${name}.mjs`;
const rootEngine = join(root, engine);
const pkgEngine = join(skillDir, engine);
if (!existsSync(rootEngine)) bad(`missing ${engine} at repo root — run \`pnpm run build\``);
else if (!existsSync(pkgEngine)) bad(`missing skills/${name}/${engine} — run \`node scripts/copy-bundle.mjs\``);
else
  readFileSync(rootEngine).equals(readFileSync(pkgEngine))
    ? ok(`embedded engine skills/${name}/${engine} is byte-identical to ${engine}`)
    : bad(`skills/${name}/${engine} differs from ${engine} — run \`node scripts/copy-bundle.mjs\` and commit`);

// 5. Docs <-> CLI drift gate.
//
// SKILL.md promises `--help` is the full surface, and an agent that reads a
// flag which the CLI rejects wastes a turn on a usage error it cannot diagnose.
// Both directions are checked. The bundle exports its flag tables for this;
// importing it is side-effect-free (main() is guarded by isInvokedDirectly).
if (existsSync(pkgEngine) && existsSync(skillMd)) {
  let cli = null;
  try {
    cli = await import(pathToFileURL(pkgEngine).href);
  } catch (e) {
    bad(`cannot import skills/${name}/${engine} for the drift gate: ${e.message}`);
  }
  if (cli && !(cli.VALUE_FLAGS && cli.BOOL_FLAGS && cli.HELP && cli.COMMANDS)) {
    bad("the bundle no longer exports VALUE_FLAGS/BOOL_FLAGS/HELP/COMMANDS — the drift gate needs them");
    cli = null;
  }
  if (cli) {
    // Flags belonging to OTHER tools that the docs legitimately quote.
    const ALLOWED_FOREIGN_FLAGS = new Set(["skill", "agent", "copy", "frozen-lockfile"]);
    const cliFlags = new Set([...cli.VALUE_FLAGS, ...cli.BOOL_FLAGS]);
    const universe = new Set([...cliFlags, "help", "version", "h", "v", ...ALLOWED_FOREIGN_FLAGS]);
    const refs = join(skillDir, "references");
    const docs = [
      ["SKILL.md", skillText],
      ...(existsSync(refs)
        ? readdirSync(refs)
            .filter((f) => f.endsWith(".md"))
            .map((f) => [`references/${f}`, readFileSync(join(refs, f), "utf8")])
        : []),
    ];

    // A. docs ⊆ CLI. The lookbehind keeps bold/parenthesised/backticked flags
    // visible while skipping `--` glued to a word tail (foo--bar, ---).
    const flagRe = /(?<![\w-])--([a-z][a-z0-9-]*)\b/g;
    let unknown = 0;
    for (const [file, text] of docs) {
      for (const m of text.matchAll(flagRe)) {
        if (!universe.has(m[1])) {
          bad(`${file} documents unknown flag --${m[1]} (add it to ALLOWED_FOREIGN_FLAGS only if it belongs to another tool)`);
          unknown++;
        }
      }
    }
    if (!unknown) ok(`every --flag documented across ${docs.length} skill file(s) exists in the CLI`);

    // B. CLI ⊆ --help.
    const missing = [...cliFlags].filter((f) => !new RegExp(`--${f}\\b`).test(cli.HELP));
    missing.length === 0 ? ok("--help covers the whole flag surface") : bad(`--help omits: ${missing.map((f) => `--${f}`).join(", ")}`);

    // C. Every command is both in --help and named in SKILL.md. A command the
    // skill never mentions is a command no agent will ever run.
    const undocumented = [...cli.COMMANDS].filter((c) => !new RegExp(`\\b${c}\\b`).test(cli.HELP));
    undocumented.length === 0 ? ok("--help lists every command") : bad(`--help omits commands: ${undocumented.join(", ")}`);
    const unmentioned = [...cli.COMMANDS].filter((c) => c !== "version" && !new RegExp(`\\b${c}\\b`).test(skillText));
    unmentioned.length === 0 ? ok("SKILL.md mentions every command") : bad(`SKILL.md never mentions: ${unmentioned.join(", ")}`);

    // D. The refusals are the product. A SKILL.md that documents the commands
    // but not the gates produces an agent that runs the tool and ignores what
    // it refuses to say — which is the whole failure this skill is built
    // against. These three must be spelled out somewhere in the package.
    const allDocs = docs.map(([, t]) => t).join("\n");
    for (const [needle, why] of [
      ["truncated", "a partial territory must never be presented as a whole one"],
      ["MATCH.todo.json", "the matcher's refusal to guess is the agent's job to resolve"],
      ["ODbL", "the OSM attribution is a licence obligation, not a nicety"],
    ]) {
      allDocs.includes(needle) ? ok(`the skill package documents ${needle} (${why})`) : bad(`no skill file mentions ${needle} — ${why}`);
    }
  }
}

if (errors.length) {
  console.error(`\nverify-skill-bundle: ${errors.length} problem(s) — the published skill would not install correctly.`);
  process.exit(1);
}
console.log(`\nverify-skill-bundle: ok — skills/${name}/ installs as a complete skill.`);
