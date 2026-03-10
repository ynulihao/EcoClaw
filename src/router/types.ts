export type TaskCategory =
  | "sanity"
  | "calendar"
  | "stock"
  | "blog"
  | "tool_use"
  | "summary"
  | "events"
  | "email"
  | "memory"
  | "files"
  | "workflow"
  | "clawdhub"
  | "skill_search"
  | "image_gen"
  | "humanizer"
  | "daily_summary"
  | "email_triage"
  | "email_search"
  | "market_research"
  | "spreadsheet"
  | "eli5_pdf"
  | "comprehension"
  | "second_brain";

export interface ClassificationResult {
  category: TaskCategory;   // always present (nearest-neighbor always returns a result)
  similarity: number;        // cosine similarity (for debug)
}

export type RoutingProfileName = "best" | "balanced" | "eco";

export interface RoutingProfile {
  name: RoutingProfileName;
  qualityWeight: number;
  costWeight: number;
}

export interface ModelScore {
  model: string;
  provider: string;
  openrouterId: string; // OpenRouter model ID
  taskScore: number; // task-specific or overall score (0-100)
  costScore: number; // normalized 0-1 (1 = cheapest)
  compositeScore: number; // weighted composite
}

export interface SelectionResult {
  primary: ModelScore;
  fallbacks: ModelScore[]; // up to 2 fallback models
  category: TaskCategory;   // never null
  profile: RoutingProfileName;
}
