import type { BenchmarkData, ModelBenchmark } from "../data/types.js";
import type {
  RoutingProfile,
  RoutingProfileName,
  TaskCategory,
  ModelScore,
  SelectionResult,
} from "./types.js";
import { ROUTING_PROFILES } from "./profiles.js";
import { TASK_CATEGORIES } from "./classifier.js";
import { toOpenRouterId } from "../models.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const warnedMissingTasks = new Set<string>();

function getTaskScore(model: ModelBenchmark, taskId: string): number {
  const ts = model.taskScores.find((t) => t.taskId === taskId);
  if (ts != null) return ts.score;
  const key = `${model.model}:${taskId}`;
  if (!warnedMissingTasks.has(key)) {
    warnedMissingTasks.add(key);
    console.warn(`[EcoClaw] No task-specific score for "${taskId}" on model "${model.model}". Using overallScore (${model.overallScore}).`);
  }
  return model.overallScore;
}

function normalize(
  value: number,
  min: number,
  max: number,
  invert: boolean,
): number {
  if (max === min) return 1;
  const norm = (value - min) / (max - min);
  return invert ? 1 - norm : norm;
}

function scoreModel(
  model: ModelBenchmark,
  taskId: string,
  profile: RoutingProfile,
  costMin: number,
  costMax: number,
): ModelScore {
  const taskScore = getTaskScore(model, taskId);

  // Cost: lower cost is better -> invert; default to mid-range if null
  const costVal = model.cost ?? (costMin + costMax) / 2;
  const costScore = normalize(costVal, costMin, costMax, true);

  const compositeScore =
    profile.qualityWeight * (taskScore / 100) +
    profile.costWeight * costScore;

  return {
    model: model.model,
    provider: model.provider,
    openrouterId: toOpenRouterId(model.model),
    taskScore,
    costScore,
    compositeScore,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Models that cannot be mapped to a valid OpenRouter ID
const INVALID_OPENROUTER_IDS = new Set(["gemini"]);

export function selectModel(
  benchmarkData: BenchmarkData,
  category: TaskCategory,
  profileName: RoutingProfileName,
): SelectionResult {
  const profile = ROUTING_PROFILES[profileName];

  // Filter out models that cannot be mapped to a valid OpenRouter ID
  const models = Array.from(benchmarkData.values()).filter((m) => {
    const orId = toOpenRouterId(m.model);
    if (!orId.includes("/") || INVALID_OPENROUTER_IDS.has(orId)) return false;
    if (m.cost === null || m.cost <= 0) return false;
    return true;
  });

  // Single task ID for the category (1:1 mapping)
  const taskId = TASK_CATEGORIES[category].taskId;

  // Compute min/max for cost normalization
  const costs = models.map((m) => m.cost).filter((c): c is number => c != null);
  const costMin = costs.length > 0 ? costs.reduce((a, b) => Math.min(a, b), Infinity) : 0;
  const costMax = costs.length > 0 ? costs.reduce((a, b) => Math.max(a, b), -Infinity) : 1;

  // Score each model and sort by composite score
  const scored: ModelScore[] = models
    .map((m) => scoreModel(m, taskId, profile, costMin, costMax))
    .sort((a, b) => b.compositeScore - a.compositeScore);

  if (scored.length === 0) {
    throw new Error(
      `No eligible models found for category "${category}" with profile "${profileName}". ` +
      `All ${Array.from(benchmarkData.values()).length} models were filtered out.`,
    );
  }

  return {
    primary: scored[0],
    fallbacks: scored.slice(1, 3),
    category,
    profile: profileName,
  };
}
