// Shapes API responses into what an assistant actually needs: a dataset card
// it can read in one go, per-column statistics instead of ten thousand rows,
// and an honest statement of how fresh the data is.
import type { DatasetColumn, DatasetMeta, DatasetSummary } from "./eds.ts";
import { isDiscontinued, successors } from "./catalog.ts";
import { config } from "./config.ts";

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Seconds in an ISO 8601 duration such as PT5M, PT15M, P1D, P1M. Undefined for "N/A" and anything unparseable. */
export function durationSeconds(iso?: string): number | undefined {
  if (!iso) return undefined;
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
  if (!m) return undefined;
  const [, y, mo, w, d, h, mi, s] = m.map((v) => (v === undefined ? undefined : Number(v))) as (number | undefined)[];
  const total =
    (y ?? 0) * 31_536_000 + (mo ?? 0) * 2_592_000 + (w ?? 0) * 604_800 + (d ?? 0) * 86_400 + (h ?? 0) * 3600 + (mi ?? 0) * 60 + (s ?? 0);
  return total || undefined;
}

/**
 * How long a query on this dataset may be served from cache. The platform asks
 * for roughly one request per update interval, so that is exactly the TTL —
 * clamped so a yearly dataset is not cached for a year within one session.
 */
export function cacheTtlFor(meta?: Pick<DatasetMeta, "updateFrequency">): number {
  const seconds = durationSeconds(meta?.updateFrequency);
  if (!seconds) return config.cacheTtlSeconds;
  return Math.min(Math.max(seconds, 60), 86_400);
}

export interface Freshness {
  data_from?: string;
  data_to?: string;
  last_data_update?: string;
  /** Hours between the newest row and now. Large numbers mean the dataset has stopped moving. */
  hours_behind?: number;
  stale: boolean;
}

export function freshness(meta: DatasetMeta): Freshness {
  const newest = meta.dataTo ?? meta.lastDataUpdate;
  const hours = newest ? Math.round((Date.now() - Date.parse(newest)) / 3_600_000) : undefined;
  const expected = durationSeconds(meta.updateFrequency);
  // Allow three update intervals (and at least a day) before calling it stale,
  // so a daily dataset published this morning is not flagged every afternoon.
  const budgetHours = Math.max(24, ((expected ?? 86_400) * 3) / 3600);
  return {
    data_from: meta.dataFrom ?? undefined,
    data_to: meta.dataTo ?? undefined,
    last_data_update: meta.lastDataUpdate ?? undefined,
    hours_behind: hours,
    stale: hours !== undefined && hours > budgetHours,
  };
}

export function slimColumn(c: DatasetColumn) {
  return {
    name: c.dbColumn,
    type: c.dataType,
    unit: c.unit || undefined,
    key: c.primaryKeyIndex ? true : undefined,
    description: c.description?.replace(/\s+/g, " ").trim().slice(0, 200) || undefined,
  };
}

/** Everything the model needs before it can write a sensible query, and nothing else. */
export function datasetCard(meta: DatasetMeta, all: DatasetSummary[]) {
  const retired = isDiscontinued(meta);
  const replacements = retired ? successors(meta, all) : [];
  return {
    dataset: meta.datasetName,
    title: meta.title,
    publisher: meta.organizationName,
    description: meta.description?.replace(/\s+/g, " ").trim().slice(0, 600),
    discontinued: retired,
    ...(replacements.length ? { use_instead: replacements } : {}),
    resolution: meta.resolution || undefined,
    update_frequency: meta.updateFrequency && meta.updateFrequency !== "N/A" ? meta.updateFrequency : undefined,
    /** `start` and `end` filter on this column, not on whatever column you were thinking of. */
    time_column: meta.filterColumn || undefined,
    coverage: freshness(meta),
    columns: (meta.columns ?? []).map(slimColumn),
    caution: meta.caution?.replace(/\s+/g, " ").trim() || undefined,
    source: `${config.siteBase}/${meta.organizationName}/${meta.datasetName}`,
  };
}

export interface ColumnStats {
  column: string;
  count: number;
  nulls: number;
  min?: number;
  max?: number;
  mean?: number;
  sum?: number;
  first?: string;
  last?: string;
  distinct?: string[];
}

/**
 * Per-column statistics for a result set. This is what makes a year of
 * five-minute data answerable: the model asks for a summary, not 105,000 rows.
 */
export function summarize(records: Record<string, unknown>[]): ColumnStats[] {
  if (!records.length) return [];
  const columns = [...new Set(records.flatMap((r) => Object.keys(r)))];
  return columns.map((column) => {
    const values = records.map((r) => r[column]);
    const nulls = values.filter((v) => v === null || v === undefined).length;
    const numbers = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const stats: ColumnStats = { column, count: values.length - nulls, nulls };
    if (numbers.length) {
      const sum = numbers.reduce((a, b) => a + b, 0);
      stats.min = round3(Math.min(...numbers));
      stats.max = round3(Math.max(...numbers));
      stats.mean = round3(sum / numbers.length);
      stats.sum = round3(sum);
      return stats;
    }
    const strings = values.filter((v): v is string => typeof v === "string");
    if (!strings.length) return stats;
    const unique = [...new Set(strings)];
    // A timestamp column is a range; a category column is a list of values.
    if (unique.length > 12 && /^\d{4}-\d{2}-\d{2}/.test(strings[0]!)) {
      const sorted = [...unique].sort();
      stats.first = sorted[0];
      stats.last = sorted[sorted.length - 1];
      return stats;
    }
    stats.distinct = unique.sort().slice(0, 25);
    return stats;
  });
}
