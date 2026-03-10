/**
 * Embedding-based prompt classifier.
 *
 * 23 categories, each mapping 1:1 to a single PinchBench task.
 * Classification = nearest-neighbor search against pre-computed embeddings.
 */

import type { TaskCategory, ClassificationResult } from "./types.js";
import { fetchEmbedding, cosineSimilarity } from "./embedding-engine.js";
import { EMBEDDING_MODEL_DATA } from "./embedding-data.gen.js";
import { OPENROUTER_API_KEY, OPENROUTER_API_BASE, EMBEDDING_MODEL } from "../config.js";

// ---------------------------------------------------------------------------
// 23 categories — 1:1 mapping to tasks
// ---------------------------------------------------------------------------

interface CategoryConfig {
  taskId: string;
}

export const TASK_CATEGORIES: Record<TaskCategory, CategoryConfig> = {
  sanity:          { taskId: "task_00_sanity" },
  calendar:        { taskId: "task_01_calendar" },
  stock:           { taskId: "task_02_stock" },
  blog:            { taskId: "task_03_blog" },
  tool_use:        { taskId: "task_04_weather" },  // PinchBench task_04 tests tool-use / API calling (weather API)
  summary:         { taskId: "task_05_summary" },
  events:          { taskId: "task_06_events" },
  email:           { taskId: "task_07_email" },
  memory:          { taskId: "task_08_memory" },
  files:           { taskId: "task_09_files" },
  workflow:        { taskId: "task_10_workflow" },
  clawdhub:        { taskId: "task_11_clawdhub" },
  skill_search:    { taskId: "task_12_skill_search" },
  image_gen:       { taskId: "task_13_image_gen" },
  humanizer:       { taskId: "task_14_humanizer" },
  daily_summary:   { taskId: "task_15_daily_summary" },
  email_triage:    { taskId: "task_16_email_triage" },
  email_search:    { taskId: "task_17_email_search" },
  market_research: { taskId: "task_18_market_research" },
  spreadsheet:     { taskId: "task_19_spreadsheet_summary" },
  eli5_pdf:        { taskId: "task_20_eli5_pdf_summary" },
  comprehension:   { taskId: "task_21_openclaw_comprehension" },
  second_brain:    { taskId: "task_22_second_brain" },
};

// All category names
const ALL_CATEGORIES = Object.keys(TASK_CATEGORIES) as TaskCategory[];

// Pre-index: taskId → category for fast lookup
const TASK_TO_CATEGORY = new Map<string, TaskCategory>();
for (const cat of ALL_CATEGORIES) {
  TASK_TO_CATEGORY.set(TASK_CATEGORIES[cat].taskId, cat);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a prompt by embedding it and finding the nearest task vector.
 *
 * On API failure, falls back to "sanity" category.
 */
export async function classifyPrompt(prompt: string): Promise<ClassificationResult> {
  // Guard: if embeddings are empty, classification is impossible
  if (EMBEDDING_MODEL_DATA.tasks.length === 0 || EMBEDDING_MODEL_DATA.tasks[0].embedding.length === 0) {
    console.warn("[EcoClaw] Embedding vectors are empty — run `npm run build:embeddings` to populate them. Falling back to 'sanity'.");
    return { category: "sanity", similarity: 0 };
  }

  let queryEmbedding: number[];
  try {
    queryEmbedding = await fetchEmbedding(
      prompt,
      OPENROUTER_API_BASE,
      OPENROUTER_API_KEY,
      EMBEDDING_MODEL,
    );
  } catch {
    // Fallback on API failure
    return { category: "sanity", similarity: 0 };
  }

  // Find nearest neighbor among 23 task embeddings
  let bestCategory: TaskCategory = "sanity";
  let bestSimilarity = -Infinity;

  for (const task of EMBEDDING_MODEL_DATA.tasks) {
    const sim = cosineSimilarity(queryEmbedding, task.embedding);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestCategory = (TASK_TO_CATEGORY.get(task.taskId) ?? "sanity") as TaskCategory;
    }
  }

  return {
    category: bestCategory,
    similarity: bestSimilarity,
  };
}
