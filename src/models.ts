import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.js";

// Mapping from PinchBench model IDs to OpenRouter model IDs
// PinchBench uses format like "moonshotai/kimi-k2.5", OpenRouter might use "moonshotai/kimi-k2.5" too
// This mapping handles known differences
export const PINCHBENCH_TO_OPENROUTER: Record<string, string> = {
  // PinchBench 供应商/名称与 OpenRouter 不同的模型
  "maas-openai/glm-5": "z-ai/glm-5",
  "openai-codex/gpt-5.3-codex": "openai/gpt-5.3-codex",
  "anthropic/claude-sonnet-4.5": "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4": "anthropic/claude-sonnet-4.6",
  "vllm/kimi-k2.5": "moonshotai/kimi-k2.5",
  "qwen3.5:27b": "qwen/qwen3.5-27b",
  "moonshot/kimi-k2.5": "moonshotai/kimi-k2.5",
  "xai/grok-3": "x-ai/grok-3",
  // 以下在 OpenRouter 上直接存在，保留直传映射以便文档清晰
  "openai/gpt-5.2": "openai/gpt-5.2",
  "openai/gpt-4o": "openai/gpt-4o",
  "openai/o3": "openai/o3",
  "openai/o1": "openai/o1",
  "google/gemini-2.5-pro": "google/gemini-2.5-pro",
  "google/gemini-2.5-flash": "google/gemini-2.5-flash",
  "deepseek/deepseek-chat": "deepseek/deepseek-chat",
  "deepseek/deepseek-reasoner": "deepseek/deepseek-reasoner",
  "moonshotai/kimi-k2.5": "moonshotai/kimi-k2.5",
  "minimax/minimax-m2.5": "minimax/minimax-m2.5",
};

export function toOpenRouterId(pinchBenchId: string): string {
  return PINCHBENCH_TO_OPENROUTER[pinchBenchId] || pinchBenchId;
}

export function fromOpenRouterId(openRouterId: string): string {
  for (const [pb, or] of Object.entries(PINCHBENCH_TO_OPENROUTER)) {
    if (or === openRouterId) return pb;
  }
  return openRouterId;
}

// Virtual routing model definitions for OpenClaw
type EcoClawModel = {
  id: string;
  name: string;
  inputPrice: number;
  outputPrice: number;
  contextWindow: number;
  maxOutput: number;
  reasoning?: boolean;
  vision?: boolean;
};

const ECOCLAW_MODELS: EcoClawModel[] = [
  {
    id: "auto",
    name: "Auto (Benchmark Router - Balanced)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  {
    id: "best",
    name: "Best (Benchmark Router - Quality Priority)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  {
    id: "eco",
    name: "Eco (Benchmark Router - Cost Priority)",
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
];

function toOpenClawModel(m: EcoClawModel): ModelDefinitionConfig {
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    reasoning: m.reasoning ?? false,
    input: m.vision ? ["text", "image"] : ["text"],
    cost: {
      input: m.inputPrice,
      output: m.outputPrice,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: m.contextWindow,
    maxTokens: m.maxOutput,
  };
}

export const OPENCLAW_MODELS: ModelDefinitionConfig[] = ECOCLAW_MODELS.map(toOpenClawModel);

// Check if a model is a virtual routing profile
const ROUTING_PROFILES = new Set(["auto", "best", "eco"]);
export function isRoutingProfile(modelId: string): boolean {
  const stripped = modelId.startsWith("ecoclaw/")
    ? modelId.slice("ecoclaw/".length)
    : modelId;
  return ROUTING_PROFILES.has(stripped);
}

// Get the routing profile name from model ID
export function getProfileFromModel(modelId: string): "best" | "balanced" | "eco" {
  const stripped = modelId.startsWith("ecoclaw/")
    ? modelId.slice("ecoclaw/".length)
    : modelId;
  if (stripped === "best") return "best";
  if (stripped === "eco") return "eco";
  return "balanced"; // "auto" -> balanced
}

export function buildProviderModels(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    models: OPENCLAW_MODELS,
  };
}
