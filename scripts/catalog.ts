// Refreshes data/catalog.json, the snapshot the server falls back to when the
// API cannot be reached on a cold start. Run it before publishing a release.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eds } from "../src/eds.ts";

const all = await eds.listDatasets();
all.sort((a, b) => a.datasetName.localeCompare(b.datasetName));
const path = join(import.meta.dirname, "..", "data", "catalog.json");
writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
console.log(`Wrote ${all.length} datasets to ${path}`);
