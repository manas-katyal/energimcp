// The dataset catalogue. Discovery is the expensive part of this API — there
// are 100 datasets and the model cannot guess column names — so the catalogue
// is fetched once, cached for a day, and shipped as a snapshot in the package
// so that list/search/describe cost no API calls on a cold start.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eds, type DatasetMeta, type DatasetSummary } from "./eds.ts";

export class CatalogError extends Error {}

let snapshot: DatasetSummary[] | undefined;

/** The catalogue as it looked when the package was built. Fallback only. */
export function bundledCatalog(): DatasetSummary[] {
  if (snapshot) return snapshot;
  try {
    snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", "catalog.json"), "utf8")) as DatasetSummary[];
  } catch {
    snapshot = [];
  }
  return snapshot;
}

/** Live catalogue, falling back to the bundled snapshot if the API cannot be reached. */
export async function datasets(): Promise<DatasetSummary[]> {
  try {
    const live = await eds.listDatasets();
    if (live?.length) return live;
  } catch {
    // The snapshot is months stale at worst and still beats answering nothing.
  }
  const fallback = bundledCatalog();
  if (!fallback.length) throw new CatalogError("The dataset catalogue could not be fetched and no bundled snapshot is available.");
  return fallback;
}

/** Energi Data Service marks retirement in the title rather than in a field. */
export function isDiscontinued(ds: Pick<DatasetSummary, "title">): boolean {
  return /discontinued/i.test(ds.title);
}

/**
 * Datasets a retired one points at, taken from the markdown links in its
 * description. Only links that name a real dataset count, which filters out
 * the links to ENTSO-E, JAO and other external sites.
 */
export function successors(ds: Pick<DatasetSummary, "datasetName" | "description">, all: DatasetSummary[]): string[] {
  const byLower = new Map(all.map((d) => [d.datasetName.toLowerCase(), d.datasetName]));
  const out = new Set<string>();
  for (const [, url] of (ds.description ?? "").matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)) {
    const tail = url!.replace(/[#?].*$/, "").replace(/\/+$/, "").split("/").pop();
    const hit = tail && byLower.get(tail.toLowerCase());
    if (hit && hit !== ds.datasetName) out.add(hit);
  }
  return [...out];
}

/** Accepts the exact dataset name, any casing of it, or an unambiguous partial name. */
export async function resolveDataset(ref: string): Promise<DatasetSummary> {
  const all = await datasets();
  const needle = ref.trim().toLowerCase();
  const exact = all.find((d) => d.datasetName.toLowerCase() === needle);
  if (exact) return exact;
  const partial = all.filter((d) => d.datasetName.toLowerCase().includes(needle) || d.title.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    const names = partial.slice(0, 8).map((d) => d.datasetName);
    throw new CatalogError(`"${ref}" matches ${partial.length} datasets (${names.join(", ")}${partial.length > names.length ? ", …" : ""}). Use the exact datasetName from list_datasets.`);
  }
  throw new CatalogError(`No dataset "${ref}". Call list_datasets with a search term to find the exact datasetName.`);
}

export interface SearchOptions {
  query?: string;
  organization?: string;
  includeDiscontinued?: boolean;
  limit?: number;
}

export async function searchDatasets(opts: SearchOptions): Promise<{ total: number; shown: number; datasets: DatasetSummary[] }> {
  const all = await datasets();
  const q = opts.query?.trim().toLowerCase();
  const org = opts.organization?.trim().toLowerCase();
  const matched = all
    .filter((d) => opts.includeDiscontinued || !isDiscontinued(d))
    .filter((d) => !org || d.organizationName.toLowerCase() === org)
    .filter((d) => !q || `${d.datasetName} ${d.title} ${d.description}`.toLowerCase().includes(q))
    .sort((a, b) => a.datasetName.localeCompare(b.datasetName));
  const limit = opts.limit ?? matched.length;
  return { total: matched.length, shown: Math.min(limit, matched.length), datasets: matched.slice(0, limit) };
}

/** Full metadata for one dataset, with the catalogue entry as a backstop. */
export async function describeDataset(ref: string): Promise<DatasetMeta> {
  const summary = await resolveDataset(ref);
  const meta = await eds.describeDataset(summary.datasetName);
  return meta ?? summary;
}
