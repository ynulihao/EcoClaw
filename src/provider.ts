import type { ProviderPlugin } from "./types.js";
import { buildProviderModels } from "./models.js";
import { PROXY_PORT } from "./config.js";

export const ecoClawProvider: ProviderPlugin = {
  id: "ecoclaw",
  label: "EcoClaw",
  docsPath: "https://pinchbench.com",
  aliases: ["ec"],
  envVars: ["OPENROUTER_API_KEY"],

  get models() {
    return buildProviderModels(`http://127.0.0.1:${PROXY_PORT}`);
  },

  // No special auth needed - uses OPENROUTER_API_KEY env var
  auth: [],
};
