import { BenchmarkCache } from "../src/data/cache.js";
import { toOpenRouterId } from "../src/models.js";

async function main() {
  const cache = new BenchmarkCache();
  const data = await cache.load();

  console.log("PinchBench ID → OpenRouter ID mapping:\n");
  for (const [, m] of data) {
    const orId = toOpenRouterId(m.model);
    const flag = orId === m.model ? " (pass-through)" : "";
    console.log(`  ${m.model.padEnd(42)} → ${orId}${flag}`);
  }
}

main().catch(console.error);
