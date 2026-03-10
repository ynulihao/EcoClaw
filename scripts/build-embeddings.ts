#!/usr/bin/env tsx
/**
 * build-embeddings.ts
 *
 * Reads task_00..task_22 .md files, extracts ## Prompt content, calls the
 * OpenRouter embedding API, and writes pre-computed vectors to
 * src/router/embedding-data.gen.ts.
 *
 * Usage:
 *   npm run build:embeddings
 *
 * Reads the OpenRouter API key from secrets.local.json (preferred) or OPENROUTER_API_KEY.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENROUTER_API_KEY } from "../src/config.js";
import { request } from "../src/http-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = resolve(__dirname, "../../skill/tasks");
const OUTPUT_PATH = resolve(__dirname, "../src/router/embedding-data.gen.ts");

const API_KEY = OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("ERROR: OpenRouter API key is required (secrets.local.json or OPENROUTER_API_KEY).");
  process.exit(1);
}

const API_BASE = "https://openrouter.ai/api/v1";
const MODEL = process.env.ECOCLAW_EMBEDDING_MODEL || "openai/text-embedding-3-small";

// ---------------------------------------------------------------------------
// 23 categories — 1:1 mapping to tasks
// ---------------------------------------------------------------------------

type TaskCategory =
  | "sanity" | "calendar" | "stock" | "blog" | "tool_use"
  | "summary" | "events" | "email" | "memory" | "files" | "workflow"
  | "clawdhub" | "skill_search" | "image_gen" | "humanizer"
  | "daily_summary" | "email_triage" | "email_search"
  | "market_research" | "spreadsheet" | "eli5_pdf"
  | "comprehension" | "second_brain";

const CATEGORY_TASK_MAP: Record<TaskCategory, string> = {
  sanity:          "task_00_sanity",
  calendar:        "task_01_calendar",
  stock:           "task_02_stock",
  blog:            "task_03_blog",
  tool_use:        "task_04_weather",
  summary:         "task_05_summary",
  events:          "task_06_events",
  email:           "task_07_email",
  memory:          "task_08_memory",
  files:           "task_09_files",
  workflow:        "task_10_workflow",
  clawdhub:        "task_11_clawdhub",
  skill_search:    "task_12_skill_search",
  image_gen:       "task_13_image_gen",
  humanizer:       "task_14_humanizer",
  daily_summary:   "task_15_daily_summary",
  email_triage:    "task_16_email_triage",
  email_search:    "task_17_email_search",
  market_research: "task_18_market_research",
  spreadsheet:     "task_19_spreadsheet_summary",
  eli5_pdf:        "task_20_eli5_pdf_summary",
  comprehension:   "task_21_openclaw_comprehension",
  second_brain:    "task_22_second_brain",
};

// Reverse map
const TASK_TO_CATEGORY = new Map<string, TaskCategory>();
for (const [cat, taskId] of Object.entries(CATEGORY_TASK_MAP)) {
  TASK_TO_CATEGORY.set(taskId, cat as TaskCategory);
}

// categoryToTasks for the output (each category has exactly one task)
const categoryToTasks: Record<string, string[]> = {};
for (const [cat, taskId] of Object.entries(CATEGORY_TASK_MAP)) {
  categoryToTasks[cat] = [taskId];
}

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body: match[2] };
}

function extractSection(body: string, heading: string): string {
  const sections = body.split(/\n(?=## )/);
  const section = sections.find(s => s.startsWith(`## ${heading}`));
  if (!section) return "";
  let text = section.replace(/^## .+\n/, "");
  text = text.replace(/```[\s\S]*?```/g, "");
  return text.trim();
}

// ---------------------------------------------------------------------------
// Embedding API call
// ---------------------------------------------------------------------------

async function fetchEmbedding(text: string): Promise<number[]> {
  const url = `${API_BASE}/embeddings`;
  const res = await request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ input: text, model: MODEL }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  if (!json.data?.[0]?.embedding) {
    throw new Error("Unexpected embedding API response shape");
  }

  return json.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface TaskEmbedding {
  taskId: string;
  category: string;
  embedding: number[];
}

async function main() {
  console.log(`Model: ${MODEL}`);
  console.log(`Reading tasks from: ${TASKS_DIR}`);
  console.log();

  const tasks: TaskEmbedding[] = [];
  let dimensions = 0;

  for (const [category, taskId] of Object.entries(CATEGORY_TASK_MAP)) {
    const filePath = join(TASKS_DIR, `${taskId}.md`);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      console.error(`  ERROR: Cannot read ${filePath}`);
      process.exit(1);
    }

    const { frontmatter, body } = parseFrontmatter(content);

    // Build text for embedding: name + Prompt section + Expected Behavior
    const parts: string[] = [];
    if (frontmatter.name) parts.push(frontmatter.name);
    const prompt = extractSection(body, "Prompt");
    if (prompt) parts.push(prompt);
    const expected = extractSection(body, "Expected Behavior");
    if (expected) parts.push(expected);

    const text = parts.join("\n\n");
    if (!text.trim()) {
      console.error(`  ERROR: No text extracted for ${taskId}`);
      process.exit(1);
    }

    console.log(`  ${taskId} (${category}): ${text.length} chars`);

    const embedding = await fetchEmbedding(text);
    dimensions = embedding.length;

    tasks.push({ taskId, category, embedding });

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nDimensions: ${dimensions}`);
  console.log(`Tasks embedded: ${tasks.length}`);

  // Write output
  const model = {
    model: MODEL,
    dimensions,
    tasks,
    categoryToTasks,
  };

  const json = JSON.stringify(model);
  const output = `// AUTO-GENERATED by scripts/build-embeddings.ts — do not edit manually
import type { SerializedEmbeddingModel } from "./embedding-engine.js";

export const EMBEDDING_MODEL_DATA: SerializedEmbeddingModel = ${json} as const;
`;

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, output, "utf-8");

  console.log(`\nWrote ${OUTPUT_PATH} (${(Buffer.byteLength(output) / 1024).toFixed(1)} KB)`);
  console.log("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
