import {
  Agent as HttpAgent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { HAS_OUTBOUND_PROXY, HTTP_PROXY, HTTPS_PROXY, NO_PROXY } from "./config.js";

export interface OutboundRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OutboundResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
  getHeader: (name: string) => string | null;
  text: () => Promise<string>;
  json: <T>() => Promise<T>;
}

function supportsCoreProxyEnv(): boolean {
  const [major, minor] = process.versions.node.split(".").map((part) => parseInt(part, 10));
  return major > 24 || (major === 24 && minor >= 5);
}

if (HAS_OUTBOUND_PROXY && !supportsCoreProxyEnv()) {
  throw new Error(
    "Outbound proxy configuration requires Node.js 24.5+ because it relies on core proxyEnv support.",
  );
}

const proxyEnv = HAS_OUTBOUND_PROXY
  ? {
      HTTP_PROXY,
      HTTPS_PROXY: HTTPS_PROXY || HTTP_PROXY,
      NO_PROXY,
    }
  : undefined;

const httpAgent = proxyEnv ? new HttpAgent({ proxyEnv }) : undefined;
const httpsAgent = proxyEnv ? new HttpsAgent({ proxyEnv }) : undefined;

function createError(message: string, name = "Error"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function getHeaderValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : null;
}

function readStream(stream: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function toResponse(stream: IncomingMessage): OutboundResponse {
  const status = stream.statusCode ?? 0;
  let bodyPromise: Promise<Buffer> | null = null;
  const loadBody = () => {
    if (!bodyPromise) {
      bodyPromise = readStream(stream);
    }
    return bodyPromise;
  };

  return {
    status,
    statusText: stream.statusMessage ?? "",
    ok: status >= 200 && status < 300,
    headers: stream.headers,
    stream,
    getHeader: (name: string) => getHeaderValue(stream.headers, name),
    text: async () => (await loadBody()).toString("utf-8"),
    json: async <T>() => JSON.parse((await loadBody()).toString("utf-8")) as T,
  };
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export async function request(
  urlString: string,
  options: OutboundRequestOptions = {},
): Promise<OutboundResponse> {
  const url = new URL(urlString);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const agent = url.protocol === "https:" ? httpsAgent : httpAgent;

  return new Promise<OutboundResponse>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      req.destroy(createError("Request aborted", "AbortError"));
    };
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (response: IncomingMessage) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(toResponse(response));
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const req = send(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        agent,
      },
      succeed,
    );

    req.on("error", fail);

    if (options.timeoutMs && options.timeoutMs > 0) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(createError("Request timed out", "TimeoutError"));
      });
    }

    if (options.signal?.aborted) {
      req.destroy(createError("Request aborted", "AbortError"));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}
