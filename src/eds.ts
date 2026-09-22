// Client for Energi Data Service (https://www.energidataservice.dk/guides/api-guides).
// Three things about this API shape the code below:
//   1. Rate limits are per dataset and tight — the platform expects about one
//      request per dataset update interval, and answers 429 otherwise. So every
//      GET goes through a cache, identical in-flight calls are shared, and
//      outbound calls are spaced out.
//   2. Errors are plain text with a real status code (404 "dataset not found",
//      400 "Invalid column"), except 429 which is JSON. /meta/dataset/{unknown}
//      answers 204 with an empty body rather than 404.
//   3. The metadata endpoint emits raw newlines inside JSON strings, which is
//      not valid JSON. JSON.parse rejects it, so it is repaired first.
import { config } from "./config.ts";

export interface DatasetSummary {
  datasetId: number;
  datasetName: string;
  title: string;
  description: string;
  organizationName: string;
  lastMetadataUpdate?: string;
  active: boolean;
}

export interface DatasetColumn {
  dbColumn: string;
  dataType: string;
  displayName?: string;
  unit?: string;
  description?: string;
  comment?: string;
  sortOrder?: number;
  primaryKeyIndex?: number;
}

export interface DatasetMeta extends DatasetSummary {
  updateFrequency?: string;
  resolution?: string;
  /** The column `start` and `end` filter on. Differs per dataset (HourUTC, TimeUTC, Minutes5UTC, …). */
  filterColumn?: string;
  columns?: DatasetColumn[];
  tags?: string[];
  comment?: string;
  caution?: string;
  author?: string;
  dataFrom?: string;
  dataTo?: string;
  lastDataUpdate?: string;
  published?: string;
}

export interface QueryParams {
  start?: string;
  end?: string;
  columns?: string[];
  filter?: Record<string, unknown>;
  sort?: string;
  offset?: number;
  limit?: number;
}

export interface QueryResponse {
  total: number;
  limit: number;
  dataset: string;
  filters?: string;
  sort?: string;
  records: Record<string, unknown>[];
}

export class EdsError extends Error {
  readonly status: number;
  readonly body: string;
  readonly url: string;

  constructor(status: number, body: string, url: string) {
    super(`Energi Data Service returned ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Seconds the API asked us to wait, from "Rate limit is exceeded. Try again in 292 seconds." */
  get retryAfterSeconds(): number | undefined {
    const m = /try again in (\d+)/i.exec(this.body);
    return m ? Number(m[1]) : undefined;
  }
}

/**
 * JSON.parse, but tolerant of the raw control characters Energi Data Service
 * leaves inside description strings. Only used as a fallback, so well-formed
 * payloads take the fast path.
 */
export function parseLenientJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through and escape the control characters that live inside strings.
  }
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (inString && code < 0x20) {
      out += code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out) as T;
}

/** Builds the query string exactly the way the API guide documents it. */
export function queryString(params: QueryParams): string {
  const qs = new URLSearchParams();
  if (params.start) qs.set("start", params.start);
  if (params.end) qs.set("end", params.end);
  if (params.columns?.length) qs.set("columns", params.columns.join(","));
  if (params.filter && Object.keys(params.filter).length) qs.set("filter", JSON.stringify(params.filter));
  if (params.sort) qs.set("sort", params.sort);
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  return qs.toString();
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

/** Runs fetches one at a time, never closer together than minRequestIntervalMs. */
function spaced<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastCallAt + config.minRequestIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  // Keep the chain alive even when a call rejects, or every later call fails too.
  queue = run.catch(() => undefined);
  return run;
}

function remember(key: string, value: unknown, ttlSeconds: number): void {
  if (cache.size >= config.cacheMaxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expires: Date.now() + ttlSeconds * 1000, value });
}

async function getJson<T>(path: string, ttlSeconds: number): Promise<T> {
  const url = `${config.apiBase}${path}`;
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  const pending = inflight.get(url);
  if (pending) return pending as Promise<T>;

  const task = spaced(async () => {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": config.userAgent },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new EdsError(res.status, text, url);
    // An unknown dataset name comes back as 204 with no body.
    const value = text.trim() ? parseLenientJson<T>(text) : (undefined as T);
    remember(url, value, ttlSeconds);
    return value;
  }).finally(() => inflight.delete(url));

  inflight.set(url, task);
  return task;
}

export const eds = {
  /** Every dataset in the catalogue. One call, cached for a day: it changes rarely. */
  listDatasets(): Promise<DatasetSummary[]> {
    return getJson<DatasetSummary[]>("/meta/dataset", config.catalogTtlSeconds);
  },

  /** Full metadata including the column list. Resolves to undefined for an unknown name (the API answers 204). */
  describeDataset(name: string): Promise<DatasetMeta | undefined> {
    return getJson<DatasetMeta | undefined>(`/meta/dataset/${encodeURIComponent(name)}`, config.catalogTtlSeconds);
  },

  query(name: string, params: QueryParams, ttlSeconds = config.cacheTtlSeconds): Promise<QueryResponse> {
    const qs = queryString(params);
    return getJson<QueryResponse>(`/dataset/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`, ttlSeconds);
  },

  /** A URL the user can open or curl to get the whole result as a file, without it passing through the model. */
  downloadUrl(name: string, params: QueryParams, format: "csv" | "json" | "XL"): string {
    const qs = queryString(params);
    return `${config.apiBase}/dataset/${encodeURIComponent(name)}/download?format=${format}${qs ? `&${qs}` : ""}`;
  },

  /** Test seam and a way for the CLI to force a fresh read. */
  clearCache(): void {
    cache.clear();
  },
};
