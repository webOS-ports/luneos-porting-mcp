#!/usr/bin/env node
// Cross-reference check for knowledge/*.md, README.md and index.js.
//
//   - every `<topic>.md` named exists in knowledge/ (or is an alias in index.js);
//   - every `<topic>.md § <Heading>` names a heading of that file (prefix or
//     substring match, ignoring case and markdown punctuation);
//   - every TOPIC_ALIASES target and PROMPT_TOPICS entry in index.js is a real
//     topic (and heading, when it names one);
//   - every topic has a "# Title" and a first paragraph of at most 200 characters
//     (the description luneos_list_topics shows).
//
// Exit status 1 on any miss. Run: npm test
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KDIR = join(ROOT, "knowledge");
const files = readdirSync(KDIR).filter((f) => f.endsWith(".md")).sort();
const text = Object.fromEntries(files.map((f) => [f, readFileSync(join(KDIR, f), "utf8")]));

// Old topic names that index.js still answers for.
const indexJs = readFileSync(join(ROOT, "index.js"), "utf8");
const aliasBlock = /const TOPIC_ALIASES = \{([\s\S]*?)\n\};/.exec(indexJs);
const aliases = new Set(
  aliasBlock ? [...aliasBlock[1].matchAll(/^\s*"?([a-z0-9-]+)"?\s*:/gm)].map((m) => m[1]) : []
);

const norm = (s) =>
  s.replace(/[`*_"'“”‘’]/g, "").replace(/[—–]/g, "-").toLowerCase().replace(/\s+/g, " ")
    .replace(/^[\s.,;:()-]+|[\s.,;:()-]+$/g, "");

const headings = {};
for (const f of files) {
  let fence = false;
  headings[f] = [];
  for (const l of text[f].split("\n")) {
    if (l.startsWith("```")) { fence = !fence; continue; }
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(l);
    if (m) headings[f].push(norm(m[1]));
  }
}

function headingFound(file, cand) {
  const words = norm(cand).split(" ").map((w) => w.replace(/[,;:]+$/, "")).filter(Boolean);
  for (let k = words.length; k >= Math.min(2, words.length); k--) {
    const n = words.slice(0, k).join(" ");
    if (headings[file].some((h) => h.startsWith(n) || (n.length >= 4 && h.includes(n)))) return true;
  }
  return false;
}

// Join hard-wrapped paragraphs so a reference split across lines is still seen.
function paragraphs(src) {
  const out = [];
  let cur = [], start = 1, fence = false;
  src.split("\n").forEach((l, i) => {
    if (l.startsWith("```")) fence = !fence;
    if (!l.trim()) { if (cur.length) out.push([start, cur.join(" ")]); cur = []; return; }
    if (!cur.length) start = i + 1;
    cur.push(l.trim());
  });
  if (cur.length) out.push([start, cur.join(" ")]);
  return out;
}

const problems = [];
const sources = [...files.map((f) => [f, text[f]]),
  ["README.md", readFileSync(join(ROOT, "README.md"), "utf8")],
  ["index.js", indexJs]];

for (const [name, src] of sources) {
  for (const [line, para] of paragraphs(src)) {
    // <topic>.md must exist
    for (const m of para.matchAll(/(?<![\w/.-])([a-z0-9][a-z0-9-]*)\.md\b/g)) {
      const f = `${m[1]}.md`;
      if (["README", "CLAUDE"].includes(m[1].toUpperCase())) continue;
      if (!text[f] && !aliases.has(m[1])) problems.push(`${name}:${line}: no topic ${f}`);
    }
    // <topic>.md § Heading must resolve; a bare § Heading resolves against this
    // file or the topic named last before it in the same paragraph.
    for (const m of para.matchAll(/§\s*/g)) {
      const before = para.slice(0, m.index);
      const direct = /(?<![\w/.-])([a-z0-9][a-z0-9-]*)\.md\s*$/.exec(before);
      const rest = para.slice(m.index + m[0].length);
      const cand = rest.split(/\)|;|\s§|, and |\. |, |\||:\s/)[0].trim();
      if (!cand) continue;
      if (direct) {
        const f = `${direct[1]}.md`;
        if (text[f] && !headingFound(f, cand)) problems.push(`${name}:${line}: ${f} § "${cand.slice(0, 70)}" not found`);
        continue;
      }
      if (name === "index.js" || name === "README.md") continue;
      const named = [...before.matchAll(/(?<![\w/.-])([a-z0-9][a-z0-9-]*)\.md\b/g)].map((x) => `${x[1]}.md`).filter((f) => text[f]);
      const candidates = [name, ...named.slice(-1)];
      if (!candidates.some((f) => headingFound(f, cand)))
        problems.push(`${name}:${line}: § "${cand.slice(0, 70)}" not found in ${candidates.join(" or ")}`);
    }
  }
}

// Alias targets and PROMPT_TOPICS entries in index.js: "topic" or "topic § Heading".
const aliasTargets = aliasBlock ? [...aliasBlock[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]) : [];
const promptBlock = /const PROMPT_TOPICS = \{([\s\S]*?)\n\};/.exec(indexJs);
if (!promptBlock) problems.push("index.js: no PROMPT_TOPICS block found");
const promptRefs = promptBlock ? [...promptBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
for (const [kind, r] of [...aliasTargets.map((r) => ["TOPIC_ALIASES", r]), ...promptRefs.map((r) => ["PROMPT_TOPICS", r])]) {
  const [topic, heading] = r.split(" § ");
  const f = `${topic}.md`;
  if (!text[f]) problems.push(`index.js: ${kind} target "${r}": no topic ${f}`);
  else if (heading && !headingFound(f, heading)) problems.push(`index.js: ${kind} target "${r}": heading not found`);
}

for (const f of files) {
  const lines = text[f].split("\n");
  if (!lines[0].startsWith("# ")) { problems.push(`${f}:1: does not start with "# Title"`); continue; }
  const para = [];
  for (const l of lines.slice(1)) {
    if (!l.trim()) { if (para.length) break; continue; }
    para.push(l.trim());
  }
  const desc = para.join(" ");
  if (desc.length > 200) problems.push(`${f}: first paragraph is ${desc.length} characters (max 200)`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log(`${files.length} topics; all references and descriptions OK.`);
