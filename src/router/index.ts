import type { BenchmarkData } from "../data/types.js";
import type { SelectionResult, RoutingProfileName } from "./types.js";
import { classifyPrompt } from "./classifier.js";
import { selectModel } from "./selector.js";
import { normalizePromptForClassification } from "./prompt-normalizer.js";
import { ROUTING_PROFILES } from "./profiles.js";

export async function route(
  prompt: string,
  benchmarkData: BenchmarkData,
  profileName: RoutingProfileName = "balanced",
): Promise<SelectionResult> {
  const classification = await classifyPrompt(normalizePromptForClassification(prompt));
  return selectModel(benchmarkData, classification.category, profileName);
}

export { classifyPrompt } from "./classifier.js";
export { normalizePromptForClassification } from "./prompt-normalizer.js";
export { selectModel } from "./selector.js";
export { ROUTING_PROFILES } from "./profiles.js";
export type * from "./types.js";
