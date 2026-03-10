/**
 * EcoClaw — Benchmark-Driven LLM Router
 *
 * Routes each request to the model that actually performs best on the user's
 * task type, using real benchmark scores from PinchBench.
 *
 * Usage:
 *   # Install the plugin
 *   openclaw plugins install @ecoclaw/claw
 *
 *   # Set OPENROUTER_API_KEY in your environment
 *   export OPENROUTER_API_KEY=sk-or-v1-...
 *
 *   # Use smart routing (auto-picks best model by benchmark)
 *   openclaw models set ecoclaw/balance
 */

import type {
  OpenClawPluginDefinition,
  OpenClawPluginApi,
  PluginCommandContext,
  OpenClawPluginCommandDefinition,
} from "./types.js";
import { ecoClawProvider } from "./provider.js";
import { request } from "./http-client.js";
import { startProxy, getProxyPort, type ProxyHandle } from "./proxy.js";
import { BenchmarkCache } from "./data/cache.js";
import type { BenchmarkData } from "./data/types.js";
import { OPENCLAW_MODELS, isRoutingProfile, getProfileFromModel } from "./models.js";
import { route, classifyPrompt, ROUTING_PROFILES } from "./router/index.js";
import { OPENROUTER_API_KEY, PROXY_PORT } from "./config.js";
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Global state
const benchmarkCache = new BenchmarkCache();
let activeBenchmarkData: BenchmarkData | null = null;
let activeProxyHandle: ProxyHandle | null = null;
const MAX_LOGGED_PROMPT_CHARS = 160;

function formatPromptForLog(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > MAX_LOGGED_PROMPT_CHARS
    ? `${normalized.slice(0, MAX_LOGGED_PROMPT_CHARS)}...`
    : normalized;
}

/**
 * Detect if we're running in gateway mode.
 */
function isGatewayMode(): boolean {
  return process.argv.includes("gateway");
}

/**
 * Detect if we're running in shell completion mode.
 */
function isCompletionMode(): boolean {
  return process.argv.some((arg, i) => arg === "completion" && i >= 1 && i <= 3);
}

/**
 * Wait for proxy health check.
 */
async function waitForProxyHealth(port: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request(`http://127.0.0.1:${port}/health`, {
        timeoutMs: Math.min(1000, timeoutMs),
      });
      if (res.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Inject EcoClaw models config into OpenClaw config file.
 */
function injectModelsConfig(logger: { info: (msg: string) => void }): void {
  const configDir = join(homedir(), ".openclaw");
  const configPath = join(configDir, "openclaw.json");

  let config: Record<string, unknown> = {};
  let needsWrite = false;

  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
    } catch (err) {
      logger.info(`Failed to create config dir: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8").trim();
      if (content) {
        config = JSON.parse(content);
      } else {
        needsWrite = true;
      }
    } catch (err) {
      // Corrupt config — backup and skip
      const backupPath = `${configPath}.backup.${Date.now()}`;
      try {
        copyFileSync(configPath, backupPath);
        logger.info(`Config parse failed, backed up to ${backupPath}`);
      } catch {
        logger.info("Config parse failed, could not create backup");
      }
      return;
    }
  } else {
    needsWrite = true;
  }

  // Initialize config structure
  if (!config.models) {
    config.models = {};
    needsWrite = true;
  }
  const models = config.models as Record<string, unknown>;
  if (!models.providers) {
    models.providers = {};
    needsWrite = true;
  }

  const proxyPort = getProxyPort();
  const expectedBaseUrl = `http://127.0.0.1:${proxyPort}/v1`;
  const providers = models.providers as Record<string, unknown>;

  if (!providers.ecoclaw) {
    providers.ecoclaw = {
      baseUrl: expectedBaseUrl,
      api: "openai-completions",
      apiKey: "openrouter-proxy-handles-auth",
      models: OPENCLAW_MODELS,
    };
    logger.info("Injected EcoClaw provider config");
    needsWrite = true;
  } else {
    const ecoclaw = providers.ecoclaw as Record<string, unknown>;
    let fixed = false;

    if (!ecoclaw.baseUrl || ecoclaw.baseUrl !== expectedBaseUrl) {
      ecoclaw.baseUrl = expectedBaseUrl;
      fixed = true;
    }
    if (!ecoclaw.api) {
      ecoclaw.api = "openai-completions";
      fixed = true;
    }
    if (!ecoclaw.apiKey) {
      ecoclaw.apiKey = "openrouter-proxy-handles-auth";
      fixed = true;
    }

    const currentModels = ecoclaw.models as Array<{ id?: string }>;
    const currentModelIds = new Set(
      Array.isArray(currentModels) ? currentModels.map((m) => m?.id).filter(Boolean) : [],
    );
    const expectedModelIds = OPENCLAW_MODELS.map((m) => m.id);
    const needsModelUpdate =
      !currentModels ||
      !Array.isArray(currentModels) ||
      currentModels.length !== OPENCLAW_MODELS.length ||
      expectedModelIds.some((id) => !currentModelIds.has(id));

    if (needsModelUpdate) {
      ecoclaw.models = OPENCLAW_MODELS;
      fixed = true;
    }

    if (fixed) {
      logger.info("Fixed EcoClaw provider config");
      needsWrite = true;
    }
  }

  // Write config if changed (atomic write)
  if (needsWrite) {
    try {
      const tmpPath = `${configPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      renameSync(tmpPath, configPath);
      logger.info("EcoClaw config injected");
    } catch (err) {
      logger.info(`Failed to write config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Initialize benchmark data and start proxy.
 */
async function initializeAsync(api: OpenClawPluginApi): Promise<void> {
  // Load benchmark data
  api.logger.info("Loading PinchBench benchmark data...");
  activeBenchmarkData = await benchmarkCache.load();
  api.logger.info(`Loaded benchmark data for ${activeBenchmarkData.size} models`);

  // Start proxy
  const proxy = await startProxy({
    benchmarkData: activeBenchmarkData,
    defaultProfile: "balanced",
    onReady: (port) => {
      api.logger.info(`EcoClaw proxy listening on port ${port}`);
    },
    onError: (error) => {
      api.logger.error(`Proxy error: ${error.message}`);
    },
    onRequestCompleted: (event) => {
      if (event.routingDecision) {
        api.logger.info(
          `[${event.routingDecision.profile}] ${event.routingDecision.category} ` +
          `original=${event.originalModel} selected=${event.selectedModel} actual=${event.actualModel}` +
          `${event.usedFallback ? " fallback=true" : ""}`,
        );
        api.logger.info(`classified_prompt=${formatPromptForLog(event.classifiedPrompt)}`);
        return;
      }

      api.logger.info(
        `[direct] original=${event.originalModel} actual=${event.actualModel}`,
      );
    },
  });

  activeProxyHandle = proxy;
  api.logger.info(`EcoClaw ready — benchmark-driven routing enabled`);

  if (!OPENROUTER_API_KEY) {
    api.logger.warn("OPENROUTER_API_KEY not set! Requests will fail. Set it in your environment.");
  }
}

/**
 * /route command — show which model would be selected.
 */
function createRouteCommand(): OpenClawPluginCommandDefinition {
  return {
    name: "route",
    description: "Show which model would be selected for a given prompt",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: PluginCommandContext) => {
      const prompt = ctx.args?.trim() || "";

      if (!prompt) {
        return { text: "Usage: `/route <prompt>` — Show which model would handle this request" };
      }

      if (!activeBenchmarkData || activeBenchmarkData.size === 0) {
        return { text: "Benchmark data not loaded yet." };
      }

      // Derive profile from the user's currently selected model
      const agents = ctx.config.agents as Record<string, unknown> | undefined;
      const defaults = (agents?.defaults ?? {}) as Record<string, unknown>;
      const modelCfg = (defaults.model ?? {}) as Record<string, string>;
      const currentModel = modelCfg.primary || "";

      const profileName = isRoutingProfile(currentModel)
        ? getProfileFromModel(currentModel)
        : "balanced";

      const result = await route(prompt, activeBenchmarkData, profileName);

      const lines = [
        "**Routing Decision**",
        "",
        `**Prompt:** ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
        `**Profile:** ${result.profile}`,
        "",
        `**Selected Model:** ${result.primary.model}`,
        `  OpenRouter ID: ${result.primary.openrouterId}`,
        `  Task Score: ${result.primary.taskScore.toFixed(1)}%`,
        `  Composite Score: ${result.primary.compositeScore.toFixed(3)}`,
        "",
      ];

      if (result.fallbacks.length > 0) {
        lines.push("**Fallbacks:**");
        for (const fb of result.fallbacks) {
          lines.push(`  - ${fb.model} (task: ${fb.taskScore.toFixed(1)}%, composite: ${fb.compositeScore.toFixed(3)})`);
        }
      }

      return { text: lines.join("\n") };
    },
  };
}

// ─── Plugin Definition ───

const plugin: OpenClawPluginDefinition = {
  id: "eco-claw",
  name: "EcoClaw",
  description: "Benchmark-driven LLM router — routes to the best model per task using PinchBench data",
  version: "0.1.0",

  register(api: OpenClawPluginApi) {
    // Skip in completion mode
    if (isCompletionMode()) {
      api.registerProvider(ecoClawProvider);
      return;
    }

    // Register provider
    api.registerProvider(ecoClawProvider);

    // Inject models config
    injectModelsConfig(api.logger);

    // Set runtime config for immediate availability
    if (!api.config.models) {
      api.config.models = { providers: {} };
    }
    if (!api.config.models.providers) {
      api.config.models.providers = {};
    }
    api.config.models.providers.ecoclaw = {
      baseUrl: `http://127.0.0.1:${getProxyPort()}/v1`,
      api: "openai-completions",
      apiKey: "openrouter-proxy-handles-auth",
      models: OPENCLAW_MODELS,
    };

    api.logger.info("EcoClaw provider registered (benchmark-driven routing)");

    // Register slash commands
    api.registerCommand(createRouteCommand());

    // Register service with lifecycle management
    api.registerService({
      id: "ecoclaw-proxy",
      start: () => {
        // No-op: proxy is started below
      },
      stop: async () => {
        if (activeProxyHandle) {
          try {
            await activeProxyHandle.close();
            api.logger.info("EcoClaw proxy closed");
          } catch (err) {
            api.logger.warn(
              `Failed to close proxy: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          activeProxyHandle = null;
        }
      },
    });

    // Only start proxy in gateway mode
    if (!isGatewayMode()) {
      api.logger.info("Not in gateway mode — proxy will start when gateway runs");
      return;
    }

    // Start proxy in background (don't block register)
    initializeAsync(api)
      .then(async () => {
        const port = getProxyPort();
        const healthy = await waitForProxyHealth(port, 5000);
        if (!healthy) {
          api.logger.warn("Proxy health check timed out");
        }
      })
      .catch((err) => {
        api.logger.error(
          `Failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  },
};

export default plugin;

// Re-export for programmatic use
export { startProxy, getProxyPort } from "./proxy.js";
export type { ProxyOptions, ProxyHandle, ProxyRequestCompletedEvent } from "./proxy.js";
export { ecoClawProvider } from "./provider.js";
export { OPENCLAW_MODELS, isRoutingProfile, getProfileFromModel, toOpenRouterId } from "./models.js";
export { route, classifyPrompt, selectModel, ROUTING_PROFILES } from "./router/index.js";
export type { SelectionResult, RoutingProfileName, TaskCategory, ModelScore } from "./router/types.js";
export { BenchmarkCache } from "./data/cache.js";
export { buildBenchmarkData, fetchLeaderboard, fetchSubmission } from "./data/fetcher.js";
export type { BenchmarkData, ModelBenchmark, ModelTaskScore } from "./data/types.js";
