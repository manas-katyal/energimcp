// Helpers for checking a deployment and exploring the catalogue from a terminal:
//   node src/cli.ts check                → verifies config and reaches the API
//   node src/cli.ts datasets [search]    → the catalogue, one line per dataset
//   node src/cli.ts describe <dataset>   → columns, resolution, coverage
import { config, setupProblems } from "./config.ts";
import { eds, EdsError } from "./eds.ts";
import { datasets, describeDataset, isDiscontinued, searchDatasets } from "./catalog.ts";
import { datasetCard, freshness } from "./data.ts";

const [command, ...args] = process.argv.slice(2);

function reportEdsError(err: unknown): never {
  if (err instanceof EdsError) {
    console.error(`API call failed: ${err.status} ${err.body.slice(0, 200)}`);
    if (err.isRateLimit) console.error(`Rate limited. Wait ${err.retryAfterSeconds ?? "a few minutes"} seconds.`);
  } else {
    console.error(`Failed: ${(err as Error).message}`);
  }
  process.exit(1);
}

switch (command) {
  case "check": {
    const problems = setupProblems();
    for (const p of problems) console.log(`warning: ${p}`);
    console.log(`API: ${config.apiBase}`);
    console.log(`Cache: ${config.cacheDir} (${config.cacheTtlSeconds}s default TTL, catalogue ${config.catalogTtlSeconds}s)`);
    try {
      const all = await datasets();
      const retired = all.filter(isDiscontinued).length;
      console.log(`Catalogue: ${all.length} datasets, ${retired} discontinued`);
      const meta = await describeDataset("PowerSystemRightNow");
      const f = freshness(meta);
      console.log(`Live check: PowerSystemRightNow last updated ${f.last_data_update ?? "unknown"} (${f.hours_behind ?? "?"}h ago)`);
      console.log("OK");
    } catch (err) {
      reportEdsError(err);
    }
    break;
  }
  case "datasets": {
    try {
      const { total, datasets: found } = await searchDatasets({ query: args.join(" ") || undefined, includeDiscontinued: true });
      for (const d of found) console.log(`${isDiscontinued(d) ? "×" : " "} ${d.datasetName.padEnd(44)} ${d.organizationName.padEnd(20)} ${d.title.slice(0, 60)}`);
      console.log(`\n${total} dataset(s). × = discontinued.`);
    } catch (err) {
      reportEdsError(err);
    }
    break;
  }
  case "describe": {
    if (!args[0]) {
      console.error("Usage: energimcp describe <dataset>");
      process.exit(1);
    }
    try {
      console.log(JSON.stringify(datasetCard(await describeDataset(args[0]), await datasets()), null, 2));
    } catch (err) {
      reportEdsError(err);
    }
    break;
  }
  default:
    console.log("Usage: energimcp <check | datasets [search] | describe <dataset>>");
    process.exit(command ? 1 : 0);
}

eds.clearCache();
