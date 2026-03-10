import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface SecretsConfig {
  openrouterApiKey?: string;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

function loadSecrets(): SecretsConfig {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(__dirname, "../secrets.local.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
const secrets = loadSecrets();

function pickConfigValue(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

export const OPENROUTER_API_KEY = pickConfigValue(
  secrets.openrouterApiKey,
  process.env.OPENROUTER_API_KEY,
);
const parsedPort = parseInt(process.env.ECOCLAW_PROXY_PORT || "8403", 10);
export const PROXY_PORT = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 8403;
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
export const CACHE_DIR = join(homedir(), ".openclaw", "ecoclaw");
export const EMBEDDING_MODEL = process.env.ECOCLAW_EMBEDDING_MODEL || "openai/text-embedding-3-small";
export const HTTP_PROXY = pickConfigValue(secrets.httpProxy, process.env.HTTP_PROXY);
export const HTTPS_PROXY = pickConfigValue(secrets.httpsProxy, process.env.HTTPS_PROXY, HTTP_PROXY);
export const HAS_OUTBOUND_PROXY = Boolean(HTTP_PROXY || HTTPS_PROXY);
export const NO_PROXY = pickConfigValue(
  secrets.noProxy,
  process.env.NO_PROXY,
  HAS_OUTBOUND_PROXY ? "127.0.0.1,localhost" : undefined,
);

export function applyProxyEnvironment(): void {
  if (!HAS_OUTBOUND_PROXY) return;
  if (HTTP_PROXY) process.env.HTTP_PROXY = HTTP_PROXY;
  if (HTTPS_PROXY) process.env.HTTPS_PROXY = HTTPS_PROXY;
  if (NO_PROXY) process.env.NO_PROXY = NO_PROXY;
}

applyProxyEnvironment();
