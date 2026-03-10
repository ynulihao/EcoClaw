#!/usr/bin/env tsx
/**
 * pull-snapshot.ts
 *
 * Fetches the PinchBench leaderboard, validates each model against
 * OpenRouter, and saves a verified snapshot for development/production.
 *
 * Pipeline:
 *   Phase 1: Fetch PinchBench leaderboard
 *   Phase 2: Fetch per-model submission details (concurrency 5)
 *   Phase 3: Filter cost>0, map to OpenRouter IDs, deduplicate
 *   Phase 4: Pre-filter against OpenRouter /v1/models catalog
 *   Phase 5: Live-validate each model with max_tokens=32 request (concurrency 3)
 *   Phase 6: Write verified snapshot.json
 *
 * Usage:
 *   npm run pull:snapshot
 *
 * API key is read from secrets.local.json (preferred) or OPENROUTER_API_KEY env var.
 * If neither is set, phases 4-5 are skipped (catalog-only mode).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "../src/http-client.js";
import { toOpenRouterId } from "../src/models.js";
import { OPENROUTER_API_KEY } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, "../src/data/snapshot.json");

const API_BASE = "https://api.pinchbench.com/api";
const OPENROUTER_BASE = "https://openrouter.ai/api";
const CONCURRENCY_FETCH = 5;
const CONCURRENCY_VALIDATE = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeaderboardEntry {
  model: string;
  provider: string;
  best_score_percentage: number;
  best_submission_id: string;
  latest_submission: string;
  average_execution_time_seconds?: number | null;
  average_cost_usd?: number | null;
  submission_count?: number;
}

interface TaskResult {
  task_id: string;
  score: number;
  max_score: number;
  grading_type: string;
  timed_out: boolean;
  frontmatter?: Record<string, unknown>;
}

interface SubmissionDetail {
  id: string;
  model: string;
  provider: string;
  tasks: TaskResult[];
  total_score: number;
  max_score: number;
}

interface ModelRecord {
  model: string;
  openrouterId: string;
  provider: string;
  overallScore: number;
  speed: number | null;
  cost: number | null;
  submissionId: string;
  taskScores: Array<{
    taskId: string;
    score: number;
    maxScore: number;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await request(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json<T>();
}

async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Phase 4: Fetch OpenRouter model catalog
// ---------------------------------------------------------------------------

async function fetchOpenRouterModelIds(): Promise<Set<string>> {
  console.log("  Fetching OpenRouter model catalog...");
  const res = await request(`${OPENROUTER_BASE}/v1/models`, {
    headers: OPENROUTER_API_KEY
      ? { Authorization: `Bearer ${OPENROUTER_API_KEY}` }
      : {},
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /v1/models: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data: Array<{ id: string }> };
  const ids = new Set(body.data.map((m) => m.id));
  console.log(`  OpenRouter catalog: ${ids.size} models`);
  return ids;
}

// ---------------------------------------------------------------------------
// Phase 5: Live-validate a single model
// ---------------------------------------------------------------------------

async function validateModel(openRouterId: string): Promise<boolean> {
  try {
    const res = await request(`${OPENROUTER_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: openRouterId,
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (res.ok) return true;
    const body = await res.text();
    console.warn(`    ${openRouterId}: HTTP ${res.status} - ${body.slice(0, 200)}`);
    return false;
  } catch (err) {
    console.warn(`    ${openRouterId}: Network error - ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  // ── Phase 1: Fetch leaderboard ──────────────────────────────────────
  console.log("Phase 1: Fetching leaderboard...");
  const { leaderboard } = await fetchJson<{ leaderboard: LeaderboardEntry[] }>(
    `${API_BASE}/leaderboard`,
  );
  console.log(`  ${leaderboard.length} models on leaderboard`);

  // ── Phase 2: Fetch submission details ───────────────────────────────
  console.log("Phase 2: Fetching submissions (concurrency %d)...", CONCURRENCY_FETCH);
  const submissionResults = await mapConcurrent(
    leaderboard,
    async (entry) => {
      try {
        const list = await fetchJson<{ submissions: Array<{ id: string }> }>(
          `${API_BASE}/submissions?model=${encodeURIComponent(entry.model)}&limit=1`,
        );
        const latestId = list.submissions[0]?.id;
        if (!latestId) {
          console.warn(`  ${entry.model}: no submissions found`);
          return { entry, submission: null, submissionId: entry.best_submission_id };
        }
        const { submission } = await fetchJson<{ submission: SubmissionDetail }>(
          `${API_BASE}/submissions/${encodeURIComponent(latestId)}`,
        );
        console.log(`  ${entry.model}: ${submission.tasks.length} tasks`);
        return { entry, submission, submissionId: latestId };
      } catch (err) {
        console.warn(`  ${entry.model}: FAILED - ${err}`);
        return { entry, submission: null, submissionId: entry.best_submission_id };
      }
    },
    CONCURRENCY_FETCH,
  );

  // ── Phase 3: Filter, map OpenRouter IDs, deduplicate ────────────────
  console.log("Phase 3: Filtering and deduplicating...");

  const candidates: ModelRecord[] = [];
  for (const { entry, submission, submissionId } of submissionResults) {
    if (!submission) continue;

    const cost = entry.average_cost_usd ?? null;
    if (cost === null || cost <= 0) continue;

    const openrouterId = toOpenRouterId(entry.model);
    if (!openrouterId.includes("/")) {
      console.log(`  SKIP ${entry.model}: invalid OpenRouter ID "${openrouterId}"`);
      continue;
    }

    const tasks = submission.tasks;
    const sumScore = tasks.reduce((s, t) => s + t.score, 0);
    const sumMax = tasks.reduce((s, t) => s + t.max_score, 0);

    candidates.push({
      model: entry.model,
      openrouterId,
      provider: entry.provider,
      overallScore: sumMax > 0 ? (sumScore / sumMax) * 100 : 0,
      speed: entry.average_execution_time_seconds ?? null,
      cost,
      submissionId,
      taskScores: tasks.map((t) => ({
        taskId: t.task_id,
        score: t.max_score > 0 ? (t.score / t.max_score) * 100 : 0,
        maxScore: t.max_score,
      })),
    });
  }

  // Deduplicate: multiple PinchBench IDs → same OpenRouter ID, keep higher cost
  const deduped = new Map<string, ModelRecord>();
  for (const model of candidates) {
    const existing = deduped.get(model.openrouterId);
    if (existing) {
      if ((model.cost ?? 0) > (existing.cost ?? 0)) {
        deduped.set(model.openrouterId, model);
      }
    } else {
      deduped.set(model.openrouterId, model);
    }
  }

  let verified = Array.from(deduped.values());
  console.log(`  ${candidates.length} after cost/ID filter → ${verified.length} after dedup`);

  // ── Phase 4: Pre-filter against OpenRouter catalog ──────────────────
  if (OPENROUTER_API_KEY) {
    console.log("Phase 4: Pre-filtering against OpenRouter catalog...");
    const catalogIds = await fetchOpenRouterModelIds();

    const beforeCount = verified.length;
    verified = verified.filter((m) => {
      const inCatalog = catalogIds.has(m.openrouterId);
      if (!inCatalog) {
        console.log(`  SKIP ${m.openrouterId}: not in OpenRouter catalog`);
      }
      return inCatalog;
    });
    console.log(`  ${beforeCount} → ${verified.length} after catalog filter`);
  } else {
    console.log("Phase 4: SKIPPED (no OPENROUTER_API_KEY)");
  }

  // ── Phase 5: Live validation ────────────────────────────────────────
  if (OPENROUTER_API_KEY) {
    console.log("Phase 5: Live-validating models (concurrency %d)...", CONCURRENCY_VALIDATE);
    const validationResults = await mapConcurrent(
      verified,
      async (model) => {
        const pass = await validateModel(model.openrouterId);
        console.log(`  ${model.openrouterId}: ${pass ? "PASS" : "FAIL"}`);
        return { model, pass };
      },
      CONCURRENCY_VALIDATE,
    );
    verified = validationResults.filter((r) => r.pass).map((r) => r.model);
    console.log(`  ${validationResults.length} tested → ${verified.length} passed`);
  } else {
    console.log("Phase 5: SKIPPED (no OPENROUTER_API_KEY)");
  }

  // ── Phase 6: Write snapshot ─────────────────────────────────────────
  console.log("Phase 6: Writing snapshot...");

  const snapshot = {
    fetchedAt: new Date().toISOString(),
    minScore: 0,
    models: verified.map((m) => ({
      model: m.model,
      openrouterId: m.openrouterId,
      provider: m.provider,
      overallScore: m.overallScore,
      speed: m.speed,
      cost: m.cost,
      submissionId: m.submissionId,
      taskScores: m.taskScores,
    })),
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot, null, 2), "utf-8");

  console.log(`\nWrote ${OUTPUT_PATH}`);
  console.log(`${snapshot.models.length} verified models, ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
