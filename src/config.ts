// Energi Data Service is a public, unauthenticated API, so there is no secret
// to configure and no first-run setup. Everything here is a knob with a working
// default; environment variables only exist to move the cache or to point the
// server at a different host (the test01 staging site, say).
import { accessSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const env = process.env;
// Local mode: the server was launched by an MCP client on the user's own
// machine over stdio. The only difference is where the cache lives.
const localMode = env.ENERGIMCP_LOCAL === "1";
const port = Number(env.PORT ?? 8080);

function detectBaseUrl(): string {
  if (env.BASE_URL) return env.BASE_URL.replace(/\/+$/, "");
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  if (env.FLY_APP_NAME) return `https://${env.FLY_APP_NAME}.fly.dev`;
  if (env.RENDER_EXTERNAL_URL) return env.RENDER_EXTERNAL_URL.replace(/\/+$/, "");
  return `http://localhost:${port}`;
}

export const config = {
  localMode,
  apiBase: (env.EDS_API_BASE ?? "https://api.energidataservice.dk").replace(/\/+$/, ""),
  /** Where the browsable dataset pages live, for links back to the source. */
  siteBase: (env.EDS_SITE_BASE ?? "https://www.energidataservice.dk").replace(/\/+$/, ""),
  port,
  baseUrl: detectBaseUrl(),
  cacheDir: env.CACHE_DIR ?? (localMode ? join(homedir(), ".energimcp") : "./cache"),
  appName: env.APP_NAME ?? "EnergiMCP",
  // Energi Data Service rate-limits per dataset and expects roughly one request
  // per dataset update interval. Responses are therefore cached and the cache
  // is what keeps an agent's repeated questions from earning a 429.
  cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS ?? 300),
  catalogTtlSeconds: Number(env.CATALOG_TTL_SECONDS ?? 86_400),
  cacheMaxEntries: Number(env.CACHE_MAX_ENTRIES ?? 200),
  /** Minimum spacing between two outbound calls, so a burst of tool calls trickles instead of stampeding. */
  minRequestIntervalMs: Number(env.MIN_REQUEST_INTERVAL_MS ?? 300),
  requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 30_000),
  // Row caps exist for the model's context, not for the API. A dataset can
  // return hundreds of thousands of rows and nothing good comes of that.
  defaultLimit: Number(env.DEFAULT_LIMIT ?? 200),
  maxLimit: Number(env.MAX_LIMIT ?? 5000),
  userAgent: env.USER_AGENT ?? "EnergiMCP (+https://github.com/manas-katyal/energimcp)",
};

/** What is stopping the server from working. Normally empty: there is nothing to configure. */
export function setupProblems(): string[] {
  const problems: string[] = [];
  if (!/^https?:\/\//.test(config.apiBase)) problems.push("EDS_API_BASE must start with http:// or https://");
  if (!/^https?:\/\//.test(config.baseUrl)) problems.push("BASE_URL must start with http:// or https://");
  try {
    mkdirSync(config.cacheDir, { recursive: true });
    accessSync(config.cacheDir, constants.W_OK);
  } catch {
    // A read-only cache directory is survivable: the in-memory cache still
    // works, it just does not outlive the process. Say so rather than refuse.
    problems.push(`CACHE_DIR ${config.cacheDir} is not writable, so the dataset catalogue is re-fetched on every start`);
  }
  return problems;
}
