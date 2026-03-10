/**
 * PinchBench API client
 *
 * Fetches leaderboard and submission data from the PinchBench API
 * and builds a structured BenchmarkData map for the router.
 */

import type {
  ApiLeaderboardEntry,
  BenchmarkData,
  LeaderboardResponse,
  ModelBenchmark,
  ModelTaskScore,
  SubmissionDetailResponse,
} from "./types.js";
import { request } from "../http-client.js";
import { toOpenRouterId } from "../models.js";

const API_BASE = "https://api.pinchbench.com/api";
const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch the full leaderboard from PinchBench.
 */
export async function fetchLeaderboard(): Promise<LeaderboardResponse> {
  const res = await request(`${API_BASE}/leaderboard`, { timeoutMs: FETCH_TIMEOUT_MS });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch leaderboard: ${res.status} ${res.statusText}`,
    );
  }
  return res.json<LeaderboardResponse>();
}

/**
 * Fetch a single submission's details by ID.
 */
export async function fetchSubmission(
  id: string,
): Promise<SubmissionDetailResponse> {
  const res = await request(`${API_BASE}/submissions/${encodeURIComponent(id)}`, {
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch submission ${id}: ${res.status} ${res.statusText}`,
    );
  }
  return res.json<SubmissionDetailResponse>();
}

/**
 * Fetch the latest submission ID for a given model.
 */
async function fetchLatestSubmissionId(
  model: string,
): Promise<string | null> {
  const url = `${API_BASE}/submissions?model=${encodeURIComponent(model)}&limit=1`;
  const res = await request(url, { timeoutMs: FETCH_TIMEOUT_MS });
  if (!res.ok) return null;
  const data = await res.json<{
    submissions: Array<{ id: string }>;
  }>();
  return data.submissions[0]?.id ?? null;
}

/**
 * Run an async function over an array with a concurrency limit.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, items.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

/**
 * Build a complete BenchmarkData map from the PinchBench API.
 *
 * 1. Fetch the leaderboard
 * 2. Fetch each model's best submission (concurrency-limited)
 * 3. Filter out models with no cost data or zero cost
 * 4. Extract per-task scores and build ModelBenchmark entries
 * 5. Return as Map<model, ModelBenchmark>
 */
export async function buildBenchmarkData(): Promise<BenchmarkData> {
  // 1. Fetch leaderboard
  const { leaderboard } = await fetchLeaderboard();

  // 2. Fetch latest submissions in parallel (concurrency-limited)
  const submissions = await mapWithConcurrency(
    leaderboard,
    async (entry: ApiLeaderboardEntry) => {
      try {
        const latestId = await fetchLatestSubmissionId(entry.model);
        if (!latestId) return { entry, detail: null, submissionId: entry.best_submission_id };
        const detail = await fetchSubmission(latestId);
        return { entry, detail, submissionId: latestId };
      } catch {
        return { entry, detail: null, submissionId: entry.best_submission_id };
      }
    },
    FETCH_CONCURRENCY,
  );

  // 3, 4 & 5. Build the benchmark map
  const data: BenchmarkData = new Map();

  for (const { entry, detail, submissionId } of submissions) {
    if (!detail) continue;

    // Skip models with no cost data or zero cost (free/self-hosted/missing billing)
    const cost = entry.average_cost_usd ?? null;
    if (cost === null || cost <= 0) continue;

    const tasks = detail.submission.tasks;

    const taskScores: ModelTaskScore[] = tasks.map(task => ({
      taskId: task.task_id,
      score: ((task.score / (task.max_score || 1)) * 100),
      maxScore: task.max_score,
    }));

    const sumScore = tasks.reduce((s, t) => s + t.score, 0);
    const sumMax = tasks.reduce((s, t) => s + t.max_score, 0);

    const benchmark: ModelBenchmark = {
      model: entry.model,
      provider: entry.provider,
      overallScore: sumMax > 0 ? (sumScore / sumMax) * 100 : 0,
      speed: entry.average_execution_time_seconds ?? null,
      cost,
      taskScores,
      submissionId,
    };

    data.set(entry.model, benchmark);
  }

  // Deduplicate: when multiple PinchBench models map to the same OpenRouter ID,
  // keep the one with the higher (more credible) cost
  const seen = new Map<string, string>(); // openRouterId → pinchBenchId
  for (const [pbId, model] of data) {
    const orId = toOpenRouterId(pbId);
    const existing = seen.get(orId);
    if (existing) {
      const existingModel = data.get(existing)!;
      if ((model.cost ?? 0) > (existingModel.cost ?? 0)) {
        data.delete(existing);
        seen.set(orId, pbId);
      } else {
        data.delete(pbId);
      }
    } else {
      seen.set(orId, pbId);
    }
  }

  return data;
}
