/**
 * File cache for PinchBench benchmark data
 *
 * Caches benchmark data to disk so we don't hit the API on every startup.
 * Uses a 6-hour TTL with background refresh.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";

import type {
  BenchmarkCacheData,
  BenchmarkData,
  ModelBenchmark,
} from "./types.js";
import { buildBenchmarkData } from "./fetcher.js";
import snapshotData from "./snapshot.json";

const CACHE_VERSION = 1;
const CACHE_DIR = join(homedir(), ".openclaw", "ecoclaw");
const CACHE_FILE = join(CACHE_DIR, "benchmark-cache.json");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class BenchmarkCache {
  private data: BenchmarkData | null = null;
  private refreshPromise: Promise<void> | null = null;

  /**
   * Load benchmark data, using cache when available.
   *
   * 1. Try loading from cache file
   * 2. If cache is valid (within TTL), return it and schedule background refresh
   * 3. If cache is stale or missing, try fetching from API
   * 4. If API fails and no cache exists, return fallback from snapshot.json
   */
  async load(): Promise<BenchmarkData> {
    if (this.data) {
      return this.data;
    }

    // 1. Try loading from cache file
    const cached = await this.loadCache();

    if (cached) {
      const age = Date.now() - cached.fetchedAt;

      if (age < CACHE_TTL_MS) {
        // 2. Cache is fresh - use it and schedule background refresh
        this.data = cached.data;
        this.scheduleRefresh();
        return this.data;
      }

      // Cache is stale - try API first, fall back to stale cache
      try {
        await this.refresh();
        return this.data!;
      } catch {
        // API failed, use stale cache
        this.data = cached.data;
        return this.data;
      }
    }

    // 3. No cache - try API
    try {
      await this.refresh();
      return this.data!;
    } catch {
      // 4. API failed and no cache - use hardcoded fallback
      this.data = this.getFallbackData();
      return this.data;
    }
  }

  /**
   * Fetch fresh data from the API and save to cache file.
   */
  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._doRefresh();
    return this.refreshPromise;
  }

  private async _doRefresh(): Promise<void> {
    try {
      const data = await buildBenchmarkData();
      this.data = data;
      await this.saveCache(data);
    } finally {
      this.refreshPromise = null;
    }
  }

  private scheduleRefresh(): void {
    // Fire-and-forget background refresh
    setTimeout(() => {
      this.refresh().catch(() => {
        // Silently ignore background refresh failures
      });
    }, 100);
  }

  private async saveCache(data: BenchmarkData): Promise<void> {
    const cacheData: BenchmarkCacheData = {
      version: CACHE_VERSION,
      fetchedAt: Date.now(),
      models: Array.from(data.values()).map((m) => ({
        model: m.model,
        provider: m.provider,
        overallScore: m.overallScore,
        speed: m.speed,
        cost: m.cost,
        taskScores: m.taskScores,
        submissionId: m.submissionId,
      })),
    };

    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(cacheData), "utf-8");
    } catch (err) {
      console.warn(
        `[EcoClaw] Failed to write benchmark cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async loadCache(): Promise<{
    data: BenchmarkData;
    fetchedAt: number;
  } | null> {
    try {
      const raw = await readFile(CACHE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as BenchmarkCacheData;

      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.models)) {
        return null;
      }

      const data: BenchmarkData = new Map();
      for (const entry of parsed.models) {
        const benchmark: ModelBenchmark = {
          model: entry.model,
          provider: entry.provider,
          overallScore: entry.overallScore,
          speed: entry.speed,
          cost: entry.cost,
          taskScores: entry.taskScores,
          submissionId: entry.submissionId,
        };
        data.set(entry.model, benchmark);
      }

      return { data, fetchedAt: parsed.fetchedAt };
    } catch {
      return null;
    }
  }

  /**
   * Fallback data from snapshot.json for when the API is unreachable and no cache exists.
   * All models in the snapshot have been validated against OpenRouter during pull:snapshot.
   */
  getFallbackData(): BenchmarkData {
    const data: BenchmarkData = new Map();

    for (const entry of (snapshotData as { models: Array<Record<string, unknown>> }).models) {
      const cost = entry.cost as number | null;
      if (cost === null || cost === undefined || cost <= 0) continue;

      const benchmark: ModelBenchmark = {
        model: entry.model as string,
        provider: entry.provider as string,
        overallScore: entry.overallScore as number,
        speed: (entry.speed as number | null) ?? null,
        cost,
        taskScores: (entry.taskScores as Array<{ taskId: string; score: number; maxScore: number }>),
        submissionId: entry.submissionId as string,
      };

      data.set(benchmark.model, benchmark);
    }

    return data;
  }
}
