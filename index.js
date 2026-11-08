#!/usr/bin/env node
// luneos-mcp — MCP server exposing the LuneOS GSI/GKI porting & debugging
// knowledge base (modelled on webOSArchive/webos-mcp).
//
// Resources:  luneos://knowledge/<topic>   one markdown topic file
//             luneos://knowledge/all       every topic concatenated
// Tools:      luneos_list_topics, luneos_get_topic, luneos_search
// Prompts:    luneos-session-start, luneos-port-device, luneos-debug-boot

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWLEDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "knowledge");

// ---------------------------------------------------------------------------
// Knowledge base discovery
// ---------------------------------------------------------------------------

function loadTopics() {
  const topics = new Map();
  let entries = [];
  try {
    entries = readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return topics;
  }
  for (const file of entries) {
    const name = file.replace(/\.md$/, "");
    let content = "";
    try {
      content = readFileSync(join(KNOWLEDGE_DIR, file), "utf8");
    } catch {
      continue;
    }
    // Title = first heading; description = first non-empty paragraph after it.
    const lines = content.split("\n");
    const title = (lines.find((l) => l.startsWith("# ")) || `# ${name}`).replace(/^#\s*/, "");
    // A paragraph may be hard-wrapped: join its lines up to the next blank line.
    const para = [];
    let pastTitle = false;
    for (const line of lines) {
      if (!pastTitle) { pastTitle = line.startsWith("# "); continue; }
      if (!line.trim()) { if (para.length) break; continue; }
      if (line.startsWith("#") && !para.length) continue;
      para.push(line.trim());
    }
    const description = para.join(" ");
    topics.set(name, { name, file, title, description, content });
  }
  return topics;
}

// Topics that were renamed, merged or split keep answering under their old name,
// so a client (or an older prompt) asking for one still gets the right text.
// Value: the topic that now holds the content, optionally with the section.
const TOPIC_ALIASES = {
  "device-bringup-yocto": "yocto",
  "kernel-porting": "kernel-build",
};

// Look a topic up by name or old name. Returns { topic, movedTo } or undefined.
function resolveTopic(topics, requested) {
  const name = String(requested || "").replace(/\.md$/, "");
  if (topics.has(name)) return { topic: topics.get(name) };
  const alias = TOPIC_ALIASES[name];
  if (!alias) return undefined;
  const [target] = alias.split(" § ");
  const topic = topics.get(target);
  return topic ? { topic, movedTo: alias } : undefined;
}

function movedNote(requested, movedTo) {
  return `<!-- "${requested}" has moved: see ${movedTo}. -->\n\n`;
}

// luneos_list_topics groups topics by name; the first matching rule wins.
const TOPIC_GROUPS = [
  ["SoC families", (n) => n.startsWith("soc-")],
  ["Kernel", (n) => /^(kernel-|kmi-)/.test(n) || n === "boot-images"],
  ["Userspace components", (n) =>
    ["yocto", "nyx-modules", "gsi-building", "installing", "hal-userspace", "graphics",
      "audio-media", "connectivity", "deviceinfo-reference"].includes(n)],
  ["Devices", (n) => n.startsWith("device-")],
  ["General", () => true],
];
const GROUP_ORDER = ["General", "SoC families", "Kernel", "Userspace components", "Devices"];
TOPIC_GROUPS.sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]));

function topicGroup(name) {
  // General is the fallback, so test it last regardless of display order.
  for (const [g, test] of TOPIC_GROUPS) if (g !== "General" && test(name)) return g;
  return "General";
}

function allTopicsConcatenated(topics) {
  const parts = [];
  for (const t of topics.values()) {
    parts.push(`<!-- ===== luneos://knowledge/${t.name} ===== -->\n\n${t.content.trim()}\n`);
  }
  return parts.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "luneos-mcp", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {}, prompts: {} } }
);

// ----- Resources -----------------------------------------------------------

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const topics = loadTopics();
  const resources = [
    {
      uri: "luneos://knowledge/all",
      name: "All LuneOS porting knowledge",
      description:
        "Every LuneOS GSI/GKI porting, bring-up and debugging topic concatenated (very large). " +
        "Prefer luneos://knowledge/architecture plus luneos_search / individual topics.",
      mimeType: "text/markdown",
    },
  ];
  for (const t of topics.values()) {
    resources.push({
      uri: `luneos://knowledge/${t.name}`,
      name: t.title,
      description: t.description,
      mimeType: "text/markdown",
    });
  }
  return { resources };
});

function resolvedText(topics, requested) {
  const r = resolveTopic(topics, requested);
  if (!r) return undefined;
  return (r.movedTo ? movedNote(requested, r.movedTo) : "") + r.topic.content;
}

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const m = /^luneos:\/\/knowledge\/(.+)$/.exec(uri);
  if (!m) throw new Error(`Unknown resource URI: ${uri}`);
  const topics = loadTopics();
  const text =
    m[1] === "all" ? allTopicsConcatenated(topics) : resolvedText(topics, m[1]);
  if (text === undefined) {
    const known = [...topics.keys()].join(", ");
    throw new Error(`Unknown topic "${m[1]}". Known topics: ${known}`);
  }
  return { contents: [{ uri, mimeType: "text/markdown", text }] };
});

// ----- Tools ---------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "luneos_list_topics",
      description:
        "List all LuneOS knowledge-base topics with a one-line description of each. " +
        "Use this first to see what porting/debugging knowledge is available.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "luneos_get_topic",
      description:
        "Return the full markdown content of one LuneOS knowledge topic " +
        "(e.g. 'kernel-build', 'debugging', 'device-bluejay'). " +
        "Use luneos_list_topics to see valid names.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic name (filename without .md)" },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
    {
      name: "luneos_search",
      description:
        "Case-insensitive search across the whole LuneOS knowledge base. Returns matching " +
        "lines with surrounding context and the topic they came from. Good for symptoms " +
        "('wait_for_prop', 'EGL_BAD_ALLOC', 'FMP self test'), config options, file names, tools.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring or word(s) to search for" },
          context_lines: {
            type: "integer",
            description: "Lines of context around each match (default 2)",
            minimum: 0,
            maximum: 10,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const topics = loadTopics();

  if (name === "luneos_list_topics") {
    const groups = new Map(TOPIC_GROUPS.map(([g]) => [g, []]));
    for (const t of topics.values()) {
      groups.get(topicGroup(t.name)).push(
        `- **${t.name}** — ${t.title}${t.description ? `: ${t.description}` : ""}`
      );
    }
    const text = [...groups].filter(([, l]) => l.length)
      .map(([g, l]) => `## ${g}\n${l.join("\n")}`).join("\n\n");
    return { content: [{ type: "text", text: text || "No topics found." }] };
  }

  if (name === "luneos_get_topic") {
    const text = resolvedText(topics, String(args.topic || "").replace(/\.md$/, ""));
    if (text === undefined) {
      return {
        content: [{
          type: "text",
          text: `Unknown topic "${args.topic}". Known topics:\n` +
            [...topics.keys()].map((k) => `- ${k}`).join("\n"),
        }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text }] };
  }

  if (name === "luneos_search") {
    const query = String(args.query || "").toLowerCase();
    if (!query) {
      return { content: [{ type: "text", text: "Empty query." }], isError: true };
    }
    const ctx = Number.isInteger(args.context_lines) ? args.context_lines : 2;
    const results = [];
    for (const t of topics.values()) {
      const lines = t.content.split("\n");
      const hits = [];
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(query)) hits.push(i);
      });
      if (!hits.length) continue;
      // Merge overlapping context windows.
      const windows = [];
      for (const i of hits) {
        const start = Math.max(0, i - ctx);
        const end = Math.min(lines.length - 1, i + ctx);
        const last = windows[windows.length - 1];
        if (last && start <= last.end + 1) last.end = end;
        else windows.push({ start, end });
      }
      // At most 8 snippets per topic; the match count says how many more there are.
      const snippets = windows
        .slice(0, 8)
        .map((w) => lines.slice(w.start, w.end + 1).join("\n"))
        .join("\n    …\n");
      results.push(`## ${t.name} (${hits.length} match${hits.length > 1 ? "es" : ""})\n${snippets}`);
    }
    if (!results.length) {
      return { content: [{ type: "text", text: `No matches for "${args.query}" in ${topics.size} topics.` }] };
    }
    // Keep responses bounded: whole topic blocks up to MAX characters, then name
    // the topics that did not fit instead of cutting one off mid-snippet.
    const MAX = 40000;
    const kept = [];
    let size = 0;
    for (const r of results) {
      if (kept.length && size + r.length > MAX) break;
      kept.push(r.length > MAX ? r.slice(0, MAX) + "\n[…]" : r);
      size += r.length + 2;
    }
    const omitted = results.slice(kept.length).map((r) => /^## (\S+)/.exec(r)[1]);
    const note = omitted.length
      ? `\n\n[truncated: also matched in ${omitted.join(", ")} — narrow the query or use luneos_get_topic]`
      : "";
    return { content: [{ type: "text", text: kept.join("\n\n") + note }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

// ----- Prompts -------------------------------------------------------------

// Every topic and "topic § Heading" the prompts below send a reader to. Checked
// at startup (a warning on stderr) and by `npm test` (scripts/check-refs.mjs), so
// a rename or a moved section cannot leave a prompt pointing at nothing.
const PROMPT_TOPICS = {
  general: ["architecture", "debugging", "tools", "deviceinfo-reference"],
  kernel: ["kernel-config", "kernel-build", "kmi-crc-matching", "kernel-modules", "boot-images"],
  userspace: ["yocto", "nyx-modules", "gsi-building", "installing", "hal-userspace", "graphics",
    "audio-media", "connectivity"],
  soc: ["soc-mediatek", "soc-qualcomm"],
  sections: [
    "architecture § Devices",
    "architecture § Glossary",
    "kernel-config § The config delta",
    "kernel-config § Poison options",
    "kmi-crc-matching § Step 5",
    "gsi-building § Before deriving",
    "debugging § Method",
    "debugging § Debug channels",
    "debugging § Symptom",
  ],
};

function headingsOf(content) {
  let fence = false;
  const out = [];
  for (const l of content.split("\n")) {
    if (l.startsWith("```")) { fence = !fence; continue; }
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(l);
    if (m) out.push(m[1].replace(/[`*_]/g, "").toLowerCase());
  }
  return out;
}

// "topic" or "topic § Heading prefix" → error string, or "" when it resolves.
function checkRef(topics, ref) {
  const [name, heading] = ref.split(" § ");
  const t = topics.get(name);
  if (!t) return `no topic "${name}"`;
  if (heading && !headingsOf(t.content).some((h) => h.startsWith(heading.toLowerCase())))
    return `no heading "${heading}" in ${name}`;
  return "";
}

const ref = (list) => list.join(", ");

const PROMPTS = {
  "luneos-session-start": {
    description:
      "Orient a session on the LuneOS porting knowledge base: read the architecture overview, then pull topics as needed.",
    messages: () => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "You are helping with LuneOS (webOS) development on Halium/GSI/GKI Android devices. " +
            "Read luneos://knowledge/architecture now (overview, device index, glossary), then use " +
            "luneos_search and luneos_get_topic for what the task needs; luneos://knowledge/all is " +
            "very large, load it only when the task spans the whole base.\n\n" +
            "The ground rules are listed in templates/CLAUDE.md of the luneos-porting-mcp repository " +
            "and explained in architecture: in short, pick the GSI by the vendor API level, derive " +
            "device configuration at runtime, verify the KMI host-side before flashing, and when a " +
            "device does not come up, follow the debugging topic stage by stage.",
        },
      },
    ],
  },
  "luneos-port-device": {
    description:
      "Start porting LuneOS to a new Android device — walks kernel, boot image, Yocto machine and bring-up.",
    args: [
      { name: "codename", description: "Device codename (e.g. bluejay, panther)", required: false },
      { name: "details", description: "What is known: SoC, Android version, kernel version, launch year…", required: false },
    ],
    messages: (a) => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `I want to port LuneOS to a new device${a.codename ? ` (codename: ${a.codename})` : ""}.` +
            (a.details ? ` Known details: ${a.details}.` : "") +
            "\n\nUse the luneos-mcp knowledge base. Read these topics first: " +
            `${ref(PROMPT_TOPICS.general)}; kernel: ${ref(PROMPT_TOPICS.kernel)}; ` +
            `userspace: ${ref(PROMPT_TOPICS.userspace)}; and ${ref(PROMPT_TOPICS.soc)} when the device ` +
            "is on one of those SoC families. Then find the closest existing port in architecture § Devices " +
            "(same SoC first, then same SoC family and tier, then same vendor Android version) and read its " +
            "device-<codename> topic" + (a.codename ? `, or device-${a.codename} if it already exists` : "") + ". " +
            "Then guide me through, in order:\n" +
            "1. Classify the device: Tier A or Tier B, boot-image layout, 32- or 64-bit, anti-rollback state " +
            "(architecture, boot-images).\n" +
            "2. Get the stock images and the stock kernel config, and plan the config fragment " +
            "(kernel-config § The config delta; the poison list is re-derived per KMI, kernel-config § Poison " +
            "options; BTF, kmi-crc-matching § Step 5).\n" +
            "3. Build the kernel and verify the KMI host-side before flashing anything (kernel-build, " +
            "kmi-crc-matching, tools).\n" +
            "4. Build the boot image(s) with the LuneOS initramfs and a debug variant (boot-images, kernel-modules).\n" +
            "5. Create the Yocto machine and the GSI pin for the right GSI generation (yocto, nyx-modules, " +
            "gsi-building).\n" +
            "5a. Legacy vendor converted by halium-legacy-vendor: work through gsi-building § Before deriving " +
            "before the first derive, then decide which vendor services to skip or stub (hal-userspace).\n" +
            "6. Assemble the flash kit and install (installing); then follow the debugging playbook for bring-up.",
        },
      },
    ],
  },
  "luneos-debug-boot": {
    description:
      "Debug a LuneOS device that does not come up — staged triage from kernel panic to UI.",
    args: [
      { name: "symptom", description: "What you see: bootloop, stuck on splash, black screen, no adb…", required: false },
      { name: "device", description: "Device codename", required: false },
    ],
    messages: (a) => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `A LuneOS device${a.device ? ` (${a.device})` : ""} is not coming up.` +
            (a.symptom ? ` Symptom: ${a.symptom}.` : "") +
            "\n\nUse the luneos-mcp knowledge base: read the 'debugging' topic (debugging § Method first, " +
            "and the symptom table when there is a symptom) and the matching device-<codename> topic if one " +
            "exists, plus soc-mediatek or soc-qualcomm for the device's SoC. Triage stage by stage:\n" +
            "Stage 0 — does the kernel boot (pstore, expdb on MediaTek, debugging § Debug channels).\n" +
            "Stage 1 — initramfs.\n" +
            "Stage 2 — Android container.\n" +
            "Stage 3 — display and UI.\n" +
            "Stage 4 — subsystems.\n" +
            "Stage 5 — idle health.\n" +
            "At each stage state what evidence to collect before changing anything.",
        },
      },
    ],
  },
};

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.entries(PROMPTS).map(([name, p]) => ({
    name,
    description: p.description,
    arguments: p.args || [],
  })),
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const p = PROMPTS[request.params.name];
  if (!p) throw new Error(`Unknown prompt: ${request.params.name}`);
  return {
    description: p.description,
    messages: p.messages(request.params.arguments || {}),
  };
});

// ---------------------------------------------------------------------------

{
  const topics = loadTopics();
  const refs = [...Object.values(TOPIC_ALIASES),
    ...Object.entries(PROMPT_TOPICS).flatMap(([, v]) => v)];
  for (const r of refs) {
    const err = checkRef(topics, r);
    if (err) console.error(`luneos-mcp: warning: prompt/alias reference "${r}": ${err}`);
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`luneos-mcp running (knowledge dir: ${KNOWLEDGE_DIR})`);
