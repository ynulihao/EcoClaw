/**
 * EcoClaw HTTP Proxy
 *
 * Sits between OpenClaw and OpenRouter, routing requests to the best model
 * based on PinchBench benchmark data.
 *
 * Flow:
 *   OpenClaw -> http://localhost:8403/v1/chat/completions
 *            -> classify task, select best model
 *            -> forward to https://openrouter.ai/api/v1/chat/completions
 *            -> stream response back to OpenClaw
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BenchmarkData } from "./data/types.js";
import { route } from "./router/index.js";
import type { RoutingProfileName, SelectionResult } from "./router/types.js";
import { isRoutingProfile, getProfileFromModel } from "./models.js";
import { request, isTimeoutError, type OutboundResponse } from "./http-client.js";
import { OPENROUTER_API_KEY, OPENROUTER_API_BASE, PROXY_PORT } from "./config.js";

const HEARTBEAT_INTERVAL_MS = 2_000;
const UPSTREAM_TIMEOUT_MS = 120_000; // 120 seconds
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

export interface ProxyOptions {
  benchmarkData: BenchmarkData;
  defaultProfile?: RoutingProfileName;
  onReady?: (port: number) => void;
  onError?: (error: Error) => void;
  onRouted?: (decision: SelectionResult & { originalModel: string }) => void;
}

export interface ProxyHandle {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Check if response socket is writable.
 */
function canWrite(res: ServerResponse): boolean {
  return (
    !res.writableEnded &&
    !res.destroyed &&
    res.socket !== null &&
    !res.socket.destroyed &&
    res.socket.writable
  );
}

/**
 * Safe write with writable check.
 */
function safeWrite(res: ServerResponse, data: string | Buffer): boolean {
  if (!canWrite(res)) return false;
  return res.write(data);
}

/**
 * Check if an HTTP status code is retryable (429 rate-limit or 5xx server errors).
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Try fetching from upstream with fallback models.
 * Attempts each model in order; returns the first successful or non-retryable response.
 * On retryable errors (429, 5xx) or network/timeout errors, tries the next model.
 */
async function fetchWithFallbacks(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  url: string,
  models: string[],
  timeout: number,
): Promise<{ response: OutboundResponse; modelUsed: string; isFallback: boolean }> {
  let lastError: Error | null = null;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    body.model = model;

    try {
      const response = await request(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        timeoutMs: timeout,
      });

      if (response.ok || !isRetryableStatus(response.status)) {
        // Success or non-retryable error (e.g. 400, 401, 403) — return immediately
        return { response, modelUsed: model, isFallback: i > 0 };
      }

      // Retryable error — consume body to prevent resource leak, then try next
      await response.text().catch(() => {});
      console.warn(
        `[EcoClaw] Model "${model}" returned ${response.status}, trying next fallback...`,
      );
    } catch (err) {
      lastError = isTimeoutError(err)
        ? new Error("Request timed out")
        : err instanceof Error ? err : new Error(String(err));

      if (i < models.length - 1) {
        const reason = isTimeoutError(err) ? "timeout" : "network error";
        console.warn(
          `[EcoClaw] Model "${model}" failed (${reason}), trying next fallback...`,
        );
      }
    }
  }

  // All models exhausted — re-throw or synthesize error
  if (lastError) {
    throw lastError;
  }
  // Should not reach here, but just in case
  throw new Error("All models exhausted with retryable errors");
}

/**
 * Read the full request body from an IncomingMessage.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_BODY_SIZE) {
        if (!settled) {
          settled = true;
          req.destroy();
          reject(new Error("Request body too large"));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf-8")); } });
    req.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

/**
 * Extract the last user message from an OpenAI chat completions request body.
 */
function extractUserPrompt(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!Array.isArray(messages) || messages.length === 0) return "";

  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      // Handle array content (multimodal)
      if (Array.isArray(msg.content)) {
        const textParts = (msg.content as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!);
        return textParts.join(" ");
      }
    }
  }
  return "";
}

/**
 * Start the EcoClaw proxy server.
 */
export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  const { benchmarkData, defaultProfile = "balanced", onReady, onError, onRouted } = options;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Health endpoint
      if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          plugin: "eco-claw",
          models: benchmarkData.size,
          profile: defaultProfile,
        }));
        return;
      }

      // Only handle POST /v1/chat/completions
      if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      // Check for API key
      if (!OPENROUTER_API_KEY) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: "OPENROUTER_API_KEY environment variable not set",
            type: "configuration_error",
          },
        }));
        return;
      }

      // Read and parse request body
      let rawBody: string;
      try {
        rawBody = await readBody(req);
      } catch (err) {
        if (err instanceof Error && err.message === "Request body too large") {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          return;
        }
        throw err;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }

      const originalModel = (body.model as string) || "";
      const isStreaming = body.stream === true;
      let routingDecision: SelectionResult | null = null;

      // Route if the model is a virtual routing profile
      if (isRoutingProfile(originalModel)) {
        const profileName = getProfileFromModel(originalModel);
        const userPrompt = extractUserPrompt(body);

        routingDecision = await route(userPrompt, benchmarkData, profileName);

        // Rewrite model field to the selected OpenRouter model ID
        body.model = routingDecision.primary.openrouterId;

        if (onRouted) {
          onRouted({ ...routingDecision, originalModel });
        }
      }

      // Forward to OpenRouter
      const upstreamUrl = `${OPENROUTER_API_BASE}/chat/completions`;
      const upstreamHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://pinchbench.com",
        "X-Title": "EcoClaw",
      };

      // Build models to try: primary + fallbacks (if routing was used)
      const modelsToTry: string[] = routingDecision
        ? [
            routingDecision.primary.openrouterId,
            ...routingDecision.fallbacks.map((f) => f.openrouterId),
          ]
        : [body.model as string];

      let upstreamRes: OutboundResponse;
      let actualModel: string;
      let usedFallback: boolean;
      try {
        const result = await fetchWithFallbacks(
          body,
          upstreamHeaders,
          upstreamUrl,
          modelsToTry,
          UPSTREAM_TIMEOUT_MS,
        );
        upstreamRes = result.response;
        actualModel = result.modelUsed;
        usedFallback = result.isFallback;
      } catch (err) {
        if (err instanceof Error && err.message === "Request timed out") {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: {
              message: "Upstream request timed out",
              type: "timeout_error",
            },
          }));
          return;
        }
        throw err;
      }

      if (usedFallback) {
        console.log(`[EcoClaw] Used fallback model: ${actualModel}`);
      }

      // Forward status and headers
      const responseHeaders: Record<string, string> = {
        "Content-Type": upstreamRes.getHeader("content-type") || "application/json",
      };

      // Add routing info headers
      if (routingDecision) {
        responseHeaders["X-EcoClaw-Model"] = actualModel;
        responseHeaders["X-EcoClaw-Category"] = routingDecision.category;
        responseHeaders["X-EcoClaw-Profile"] = routingDecision.profile;
        if (usedFallback) {
          responseHeaders["X-EcoClaw-Fallback"] = "true";
        }
      }

      if (isStreaming && upstreamRes.ok) {
        // Stream SSE response back
        res.writeHead(upstreamRes.status, {
          ...responseHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        // Heartbeat to prevent timeout
        const heartbeat = setInterval(() => {
          if (canWrite(res)) {
            safeWrite(res, ": heartbeat\n\n");
          } else {
            clearInterval(heartbeat);
          }
        }, HEARTBEAT_INTERVAL_MS);

        try {
          for await (const chunk of upstreamRes.stream) {
            if (!safeWrite(res, chunk)) {
              upstreamRes.stream.destroy();
              break;
            }
          }
        } catch (err) {
          // Stream error - client likely disconnected
          if (onError && err instanceof Error) {
            onError(err);
          }
        } finally {
          clearInterval(heartbeat);
          if (canWrite(res)) {
            res.end();
          }
        }
      } else {
        // Non-streaming response (or error)
        const responseBody = await upstreamRes.text();
        res.writeHead(upstreamRes.status, responseHeaders);
        res.end(responseBody);
      }
    } catch (err) {
      // Unhandled error
      if (onError && err instanceof Error) {
        onError(err);
      }
      if (canWrite(res) && !res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: err instanceof Error ? err.message : "Internal proxy error",
            type: "proxy_error",
          },
        }));
      } else if (canWrite(res)) {
        res.end();
      }
    }
  });

  // Handle client disconnects
  server.on("clientError", (_err, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  return new Promise<ProxyHandle>((resolve, reject) => {
    server.on("error", (err) => {
      if (onError) onError(err);
      reject(err);
    });

    server.listen(PROXY_PORT, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      const baseUrl = `http://127.0.0.1:${port}`;

      if (onReady) onReady(port);

      resolve({
        port,
        baseUrl,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) rejectClose(err);
              else resolveClose();
            });
          }),
      });
    });
  });
}

export function getProxyPort(): number {
  return PROXY_PORT;
}
