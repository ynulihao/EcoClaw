/**
 * PinchBench data types
 *
 * API response shapes match the PinchBench leaderboard API.
 * Computed types are used internally by the router.
 */

// ---------------------------------------------------------------------------
// API response types (from PinchBench API)
// ---------------------------------------------------------------------------

export interface ApiLeaderboardEntry {
  model: string;
  provider: string;
  best_score_percentage: number;
  latest_submission: string;
  best_submission_id: string;
  average_execution_time_seconds?: number | null;
  best_execution_time_seconds?: number | null;
  average_cost_usd?: number | null;
  best_cost_usd?: number | null;
  submission_count?: number;
  average_score_percentage?: number | null;
}

export interface LeaderboardResponse {
  leaderboard: ApiLeaderboardEntry[];
}

export interface ApiTaskResult {
  task_id: string;
  score: number;
  max_score: number;
  breakdown: Record<string, number>;
  grading_type: "automated" | "llm_judge" | "hybrid";
  timed_out: boolean;
  notes?: string;
  execution_time_seconds?: number | null;
  frontmatter?: {
    id?: string;
    name?: string;
    category?: string;
  };
}

export interface ApiSubmissionDetail {
  id: string;
  model: string;
  provider: string;
  tasks: ApiTaskResult[];
  total_score: number;
  max_score: number;
  usage_summary?: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_requests: number;
    total_cost_usd: number;
  };
}

export interface SubmissionDetailResponse {
  submission: ApiSubmissionDetail;
}

// ---------------------------------------------------------------------------
// Computed types (used by the router)
// ---------------------------------------------------------------------------

export interface ModelTaskScore {
  taskId: string;
  score: number;       // 0-100 percentage
  maxScore: number;
}

export interface ModelBenchmark {
  model: string;        // e.g. "anthropic/claude-sonnet-4.6"
  provider: string;
  overallScore: number; // 0-100 percentage
  speed: number | null; // avg execution time in seconds (lower is better)
  cost: number | null;  // avg cost in USD (lower is better)
  taskScores: ModelTaskScore[]; // per-task scores
  submissionId: string;
}

// Map of model ID -> benchmark data
export type BenchmarkData = Map<string, ModelBenchmark>;

export interface BenchmarkCacheData {
  version: number;
  fetchedAt: number; // timestamp ms
  models: Array<{
    model: string;
    provider: string;
    overallScore: number;
    speed: number | null;
    cost: number | null;
    taskScores: ModelTaskScore[];
    submissionId: string;
    openrouterId?: string;
  }>;
}
