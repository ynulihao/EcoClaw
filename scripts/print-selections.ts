import { BenchmarkCache } from "../src/data/cache.js";
import { selectModel } from "../src/router/selector.js";
import { TASK_CATEGORIES } from "../src/router/classifier.js";
import type { TaskCategory, RoutingProfileName } from "../src/router/types.js";

const profileNames: RoutingProfileName[] = ["best", "balanced", "eco"];
const categories = Object.keys(TASK_CATEGORIES) as TaskCategory[];

async function main() {
  const cache = new BenchmarkCache();
  const data = await cache.load();

  // Print available models
  console.log(`\n=== Available Models (${data.size} total) ===\n`);
  for (const [, m] of data) {
    console.log(
      `  ${m.model.padEnd(35)} overall=${m.overallScore.toFixed(1).padStart(5)}  cost=${m.cost != null ? m.cost.toFixed(4) : "null"}`
    );
  }

  // Selection table
  console.log(`\n=== Model Selection per Category × Profile ===\n`);

  const catWidth = 16;
  const colWidth = 40;
  const header =
    "Category".padEnd(catWidth) +
    profileNames.map((p) => p.toUpperCase().padEnd(colWidth)).join("");
  console.log(header);
  console.log("─".repeat(catWidth + colWidth * profileNames.length));

  for (const cat of categories) {
    let line = cat.padEnd(catWidth);
    for (const profile of profileNames) {
      const result = selectModel(data, cat, profile);
      const m = result.primary;
      const cell = `${m.model} (q=${m.taskScore.toFixed(0)} c=${m.costScore.toFixed(2)} s=${m.compositeScore.toFixed(3)})`;
      line += cell.padEnd(colWidth);
    }
    console.log(line);
  }

  console.log();
}

main().catch(console.error);
