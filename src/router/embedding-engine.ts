/**
 * Embedding engine — calls OpenRouter embedding API and computes cosine similarity.
 *
 * No third-party dependencies: uses Node core HTTP clients.
 */

import { request } from "../http-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmbeddingVector = number[];

export interface TaskEmbedding {
  taskId: string;
  category: string;
  embedding: EmbeddingVector;
}

export interface SerializedEmbeddingModel {
  model: string;
  dimensions: number;
  tasks: TaskEmbedding[];
  categoryToTasks: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

/**
 * Fetch an embedding vector for a single text from the OpenRouter
 * /embeddings endpoint.
 */
export async function fetchEmbedding(
  text: string,
  apiBase: string,
  apiKey: string,
  model: string,
): Promise<EmbeddingVector> {
  const url = `${apiBase}/embeddings`;
  const res = await request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding API ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };

  if (!json.data?.[0]?.embedding) {
    throw new Error("Unexpected embedding API response shape");
  }

  return json.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two dense vectors.
 * Returns dot(a, b) / (|a| * |b|).
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    console.warn(`[EcoClaw] Embedding dimension mismatch: ${a.length} vs ${b.length}. Truncating to shorter vector.`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
