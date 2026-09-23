import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "./config.ts";
import { eds, EdsError, type DatasetMeta, type QueryParams } from "./eds.ts";
import { CatalogError, datasets, describeDataset, isDiscontinued, resolveDataset, searchDatasets, successors } from "./catalog.ts";
import { cacheTtlFor, datasetCard, freshness, round3, summarize } from "./data.ts";
import { projections, searchProjections, shapeTable, topics } from "./projections.ts";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

class ToolError extends Error {}

/**
 * Every answer says where it came from, so a model can cite it and a reader
 * can tell Energinet's published data from the Energy Agency's projections.
 */
const edsSource = (meta: Pick<DatasetMeta, "datasetName" | "organizationName">) =>
  `Energinet, Energi Data Service, dataset ${meta.datasetName}: ${config.siteBase}/${meta.organizationName}/${meta.datasetName}`;

const PUBLISHERS = ["tso-electricity", "tso-gas", "dso-electricity", "gas-storage-denmark"] as const;

/** Shared description for the time parameters, which are the same on every tool. */
const TIME_HINT =
  "Danish local time. Either a timestamp (2026-01-01 or 2026-01-01T00:00) or a relative expression: now, StartOfDay, StartOfMonth, StartOfYear, optionally with an ISO 8601 offset such as now-P1D, now-PT15M, StartOfYear, now+P1D.";

function guard<A extends unknown[]>(fn: (...args: A) => Promise<ReturnType<typeof json> | ReturnType<typeof fail>>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ToolError || err instanceof CatalogError) return fail(err.message);
      if (err instanceof EdsError && err.isRateLimit) {
        const wait = err.retryAfterSeconds;
        return fail(
          `Energi Data Service rate-limited this request${wait ? `; it asks for ${wait} seconds` : ""}. The limit is per dataset and deliberately tight: it expects about one request per dataset update interval. ` +
            `Answer from what you already have, wait${wait ? ` ${wait} seconds` : ""} before asking again, or use download_url to fetch the data outside this conversation. Repeating the call now will fail the same way.`,
        );
      }
      if (err instanceof EdsError && err.isNotFound) {
        return fail(`${err.body.trim() || "Not found"}. Call list_datasets with a search term to find the exact datasetName.`);
      }
      if (err instanceof EdsError) return fail(err.message);
      if (err instanceof Error && err.name === "TimeoutError") return fail(`Energi Data Service did not answer within ${config.requestTimeoutMs / 1000}s. Try a narrower time range or fewer columns.`);
      return fail(`Error: ${(err as Error).message}`);
    }
  };
}

/** Warns, rather than refuses, when a dataset has been retired: the history is still real. */
async function retirementWarning(meta: DatasetMeta): Promise<{ warning?: string; use_instead?: string[] }> {
  if (!isDiscontinued(meta)) return {};
  const use = successors(meta, await datasets());
  return {
    warning: `${meta.datasetName} is discontinued and no longer updated${meta.dataTo ? ` (last data ${meta.dataTo.slice(0, 10)})` : ""}. Historical rows are still valid; do not present them as current.`,
    ...(use.length ? { use_instead: use } : {}),
  };
}

/**
 * A 400 from this API names the offending column but not the valid ones, and
 * the model cannot guess them. Since the metadata has already been fetched to
 * work out the cache TTL, spend it on an error the model can act on.
 */
function explainQueryError(err: unknown, meta: DatasetMeta): unknown {
  if (!(err instanceof EdsError) || err.status !== 400) return err;
  const names = (meta.columns ?? []).map((c) => c.dbColumn);
  if (!names.length) return err;
  return new ToolError(
    `${err.body.trim()}. ${meta.datasetName} has these columns: ${names.join(", ")}. ` +
      `start and end filter on ${meta.filterColumn ?? "its time column"}.`,
  );
}

function checkLimit(limit: number | undefined): void {
  if (limit === 0) {
    throw new ToolError(`limit=0 means "every row" to this API, which can be millions. Use download_url for a full extract, or set summary=true with a limit up to ${config.maxLimit}.`);
  }
}

export function registerTools(server: McpServer): void {
  // --- Discovery ---

  server.registerTool(
    "list_datasets",
    {
      title: "List datasets",
      description:
        "Search the Energi Data Service catalogue (100 datasets covering Danish electricity, gas and grid data). Returns dataset names and titles; call describe_dataset before querying one. Discontinued datasets are hidden unless asked for.",
      inputSchema: {
        search: z.string().optional().describe("Free text matched against name, title and description, e.g. 'price', 'wind', 'consumption', 'gas quality'"),
        publisher: z.enum(PUBLISHERS).optional().describe("tso-electricity (71, transmission), tso-gas (15), dso-electricity (10, distribution), gas-storage-denmark (4)"),
        include_discontinued: z.boolean().default(false).describe("Include the 22 retired datasets, which still hold history but no new rows"),
        limit: z.number().int().min(1).max(100).default(40),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ search, publisher, include_discontinued, limit }) => {
      const { total, datasets: found } = await searchDatasets({ query: search, organization: publisher, includeDiscontinued: include_discontinued, limit });
      if (!found.length) {
        return json({ total: 0, datasets: [], hint: `Nothing matched${search ? ` "${search}"` : ""}. Try a broader term, or call list_datasets without a search to see everything.` });
      }
      return json({
        total,
        shown: found.length,
        ...(total > found.length ? { hint: `${total - found.length} more match; narrow the search or raise limit.` } : {}),
        datasets: found.map((d) => ({
          dataset: d.datasetName,
          title: d.title,
          publisher: d.organizationName,
          ...(isDiscontinued(d) ? { discontinued: true } : {}),
        })),
      });
    }),
  );

  server.registerTool(
    "describe_dataset",
    {
      title: "Describe a dataset",
      description:
        "Full metadata for one dataset: every column with type and unit, the time column that start/end filter on, the resolution, the update frequency, and the first and last timestamp that actually exist. Call this before query_dataset — column names cannot be guessed and the coverage window is different for every dataset.",
      inputSchema: { dataset: z.string().describe("Exact datasetName from list_datasets, e.g. DayAheadPrices") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ dataset }) => json(datasetCard(await describeDataset(dataset), await datasets()))),
  );

  // --- Querying ---

  server.registerTool(
    "query_dataset",
    {
      title: "Query a dataset",
      description:
        "Fetch rows from any dataset. start/end filter on the dataset's own time column (see describe_dataset). Keep results small: name the columns you need, and use summary=true to get per-column statistics instead of rows when the range is long. Amounts and units are whatever the dataset documents; this tool does not convert them.",
      inputSchema: {
        dataset: z.string().describe("Exact datasetName from list_datasets"),
        start: z.string().optional().describe(`Start of the period, included. ${TIME_HINT}`),
        end: z.string().optional().describe(`End of the period, excluded. ${TIME_HINT}`),
        columns: z.array(z.string()).optional().describe("Columns to return. Omitting this returns all of them, which is often far more than you need."),
        filter: z.record(z.string(), z.array(z.union([z.string(), z.number()]))).optional().describe('Column to allowed values, e.g. {"PriceArea": ["DK1", "DK2"]}. Values within a column are OR-ed, columns are AND-ed.'),
        sort: z.string().optional().describe("e.g. 'HourUTC desc' or 'PriceArea,HourUTC'. Defaults to newest first."),
        offset: z.number().int().min(0).optional().describe("Rows to skip, for paging through a large result"),
        limit: z.number().int().min(0).max(config.maxLimit).optional().describe(`Maximum rows (default ${config.defaultLimit}, or ${config.maxLimit} when summary=true). 0 is rejected here: to this API it means every row ever.`),
        summary: z.boolean().default(false).describe("Return min/max/mean/sum per numeric column and the distinct values of category columns, instead of the rows themselves"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ dataset, start, end, columns, filter, sort, offset, limit, summary }) => {
      checkLimit(limit);
      const meta = await describeDataset(dataset);
      const effectiveLimit = limit ?? (summary ? config.maxLimit : config.defaultLimit);
      const params: QueryParams = { start, end, columns, filter, sort, offset, limit: effectiveLimit };
      const res = await eds.query(meta.datasetName, params, cacheTtlFor(meta)).catch((err: unknown) => {
        throw explainQueryError(err, meta);
      });
      const records = res.records ?? [];
      const fresh = freshness(meta);
      return json({
        dataset: meta.datasetName,
        title: meta.title,
        time_column: meta.filterColumn,
        resolution: meta.resolution,
        ...(await retirementWarning(meta)),
        ...(fresh.stale && !isDiscontinued(meta) ? { note: `Newest row is about ${fresh.hours_behind} hours old; this dataset updates every ${meta.updateFrequency}.` } : {}),
        query: { start, end, columns, filter, sort, offset, limit: effectiveLimit },
        returned: records.length,
        ...(records.length === effectiveLimit
          ? { truncated: `Hit the ${effectiveLimit}-row limit, so there is probably more. Narrow the range, page with offset, use summary=true, or use download_url.` }
          : {}),
        ...(summary ? { summary: summarize(records) } : { records }),
        coverage: { data_from: fresh.data_from, data_to: fresh.data_to },
        source: edsSource(meta),
      });
    }),
  );

  server.registerTool(
    "download_url",
    {
      title: "Build a download link",
      description:
        "A URL that returns the whole result as CSV, JSON or Excel, for extracts too large to pass through a conversation. Nothing is fetched or rate-limited here; give the URL to the user or to a shell.",
      inputSchema: {
        dataset: z.string().describe("Exact datasetName from list_datasets"),
        format: z.enum(["csv", "json", "XL"]).default("csv").describe("XL is Excel"),
        start: z.string().optional().describe(TIME_HINT),
        end: z.string().optional().describe(TIME_HINT),
        columns: z.array(z.string()).optional(),
        filter: z.record(z.string(), z.array(z.union([z.string(), z.number()]))).optional(),
        sort: z.string().optional(),
        limit: z.number().int().min(0).optional().describe("0 means every row in the range"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ dataset, format, start, end, columns, filter, sort, limit }) => {
      const meta = await resolveDataset(dataset);
      return json({
        dataset: meta.datasetName,
        format,
        url: eds.downloadUrl(meta.datasetName, { start, end, columns, filter, sort, limit }, format),
        note: "Open in a browser or fetch with curl. This link counts against the same per-dataset rate limit when it is called.",
      });
    }),
  );

  // --- The questions people actually ask ---

  server.registerTool(
    "get_electricity_prices",
    {
      title: "Electricity prices",
      description:
        "Day-ahead electricity spot prices in 15-minute resolution, with the cheapest and most expensive periods worked out. Covers today and, once published in the early afternoon, tomorrow. Prices are per MWh excluding tariffs, taxes and VAT — a household bill is roughly double this.",
      inputSchema: {
        price_areas: z.array(z.string()).default(["DK1", "DK2"]).describe("DK1 (west of the Great Belt), DK2 (east), or a neighbouring area such as DE, SE3, SE4, NO2"),
        start: z.string().optional().describe(`Default StartOfDay. ${TIME_HINT}`),
        end: z.string().optional().describe(`Default now+P2D, which includes tomorrow once it is published. ${TIME_HINT}`),
        include_periods: z.boolean().default(true).describe("Include every 15-minute price. Turn off for just the summary."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ price_areas, start, end, include_periods }) => {
      const meta = await describeDataset("DayAheadPrices");
      const res = await eds.query(
        "DayAheadPrices",
        {
          start: start ?? "StartOfDay",
          end: end ?? "now+P2D",
          filter: { PriceArea: price_areas },
          sort: "TimeDK",
          limit: config.maxLimit,
        },
        cacheTtlFor(meta),
      );
      const rows = (res.records ?? []).map((r) => ({
        time_dk: String(r.TimeDK ?? "").replace("T", " ").slice(0, 16),
        area: String(r.PriceArea ?? ""),
        dkk_per_mwh: typeof r.DayAheadPriceDKK === "number" ? round3(r.DayAheadPriceDKK) : null,
        eur_per_mwh: typeof r.DayAheadPriceEUR === "number" ? round3(r.DayAheadPriceEUR) : null,
        dkk_per_kwh: typeof r.DayAheadPriceDKK === "number" ? round3(r.DayAheadPriceDKK / 1000) : null,
      }));
      if (!rows.length) return json({ areas: price_areas, periods: [], note: "No prices in that window. Tomorrow's prices are published in the early afternoon Danish time." });
      const byArea = price_areas.map((area) => {
        const mine = rows.filter((r) => r.area === area && r.dkk_per_mwh !== null);
        if (!mine.length) return { area, note: "no data — check the area code with describe_dataset DayAheadPrices" };
        const cheapest = mine.reduce((a, b) => (b.dkk_per_mwh! < a.dkk_per_mwh! ? b : a));
        const dearest = mine.reduce((a, b) => (b.dkk_per_mwh! > a.dkk_per_mwh! ? b : a));
        const mean = mine.reduce((s, r) => s + r.dkk_per_mwh!, 0) / mine.length;
        return {
          area,
          periods: mine.length,
          from: mine[0]!.time_dk,
          to: mine[mine.length - 1]!.time_dk,
          mean_dkk_per_kwh: round3(mean / 1000),
          cheapest: { time_dk: cheapest.time_dk, dkk_per_kwh: cheapest.dkk_per_kwh },
          most_expensive: { time_dk: dearest.time_dk, dkk_per_kwh: dearest.dkk_per_kwh },
        };
      });
      return json({
        unit: "DKK and EUR per MWh, plus DKK per kWh for convenience. Spot price only: no tariffs, taxes or VAT.",
        timezone: "Danish local time",
        summary: byArea,
        ...(include_periods ? { periods: rows } : {}),
        source: edsSource(meta),
      });
    }),
  );

  server.registerTool(
    "get_carbon_intensity",
    {
      title: "Carbon intensity",
      description:
        "Grams of CO2 per kWh on the Danish grid, in 5-minute resolution, with an optional forecast. Use it to answer when to run something power-hungry. Returns the latest reading, the range over the window, and the greenest upcoming period when the forecast is included.",
      inputSchema: {
        price_area: z.enum(["DK1", "DK2"]).default("DK1").describe("DK1 is west of the Great Belt, DK2 is east"),
        start: z.string().optional().describe(`Default now-PT1H. ${TIME_HINT}`),
        end: z.string().optional().describe(`Default now. ${TIME_HINT}`),
        include_forecast: z.boolean().default(true).describe("Also read CO2EmisProg for the hours ahead"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ price_area, start, end, include_forecast }) => {
      const meta = await describeDataset("CO2Emis");
      const actual = await eds.query(
        "CO2Emis",
        { start: start ?? "now-PT1H", end: end ?? "now", filter: { PriceArea: [price_area] }, sort: "Minutes5DK", limit: config.maxLimit },
        cacheTtlFor(meta),
      );
      const shape = (r: Record<string, unknown>) => ({
        time_dk: String(r.Minutes5DK ?? "").replace("T", " ").slice(0, 16),
        g_co2_per_kwh: typeof r.CO2Emission === "number" ? round3(r.CO2Emission) : null,
      });
      const rows = (actual.records ?? []).map(shape).filter((r) => r.g_co2_per_kwh !== null);
      const out: Record<string, unknown> = {
        price_area,
        unit: "g CO2 per kWh",
        timezone: "Danish local time",
        latest: rows.at(-1) ?? null,
        window: rows.length
          ? {
              from: rows[0]!.time_dk,
              to: rows.at(-1)!.time_dk,
              min: Math.min(...rows.map((r) => r.g_co2_per_kwh!)),
              max: Math.max(...rows.map((r) => r.g_co2_per_kwh!)),
              mean: round3(rows.reduce((s, r) => s + r.g_co2_per_kwh!, 0) / rows.length),
            }
          : null,
        readings: rows,
        source: [edsSource(meta)],
      };
      if (!rows.length) out.note = "No readings in that window.";
      if (include_forecast) {
        const progMeta = await describeDataset("CO2EmisProg");
        const prog = await eds.query(
          "CO2EmisProg",
          { start: "now", end: "now+P1D", filter: { PriceArea: [price_area] }, sort: "Minutes5DK", limit: config.maxLimit },
          cacheTtlFor(progMeta),
        );
        const forecast = (prog.records ?? []).map(shape).filter((r) => r.g_co2_per_kwh !== null);
        (out.source as string[]).push(edsSource(progMeta));
        out.forecast = forecast.length
          ? { periods: forecast.length, greenest: forecast.reduce((a, b) => (b.g_co2_per_kwh! < a.g_co2_per_kwh! ? b : a)), dirtiest: forecast.reduce((a, b) => (b.g_co2_per_kwh! > a.g_co2_per_kwh! ? b : a)), values: forecast }
          : { note: "No forecast available for that area right now." };
      }
      return json(out);
    }),
  );

  server.registerTool(
    "get_power_system_now",
    {
      title: "Power system right now",
      description:
        "A one-minute snapshot of the Danish power system: production by source, wind and solar output, carbon intensity, and the flow on every interconnector. Positive exchange values are imports into Denmark; production plus net import equals consumption.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => {
      const meta = await describeDataset("PowerSystemRightNow");
      const res = await eds.query("PowerSystemRightNow", { start: "now-PT15M", sort: "Minutes1DK desc", limit: 1 }, cacheTtlFor(meta));
      const r = res.records?.[0];
      if (!r) return json({ note: "No reading in the last 15 minutes. The dataset updates every minute; this may be a temporary outage." });
      const num = (k: string) => (typeof r[k] === "number" ? round3(r[k] as number) : null);
      const production = {
        central_plants_mw: num("ProductionGe100MW"),
        local_plants_mw: num("ProductionLt100MW"),
        offshore_wind_mw: num("OffshoreWindPower"),
        onshore_wind_mw: num("OnshoreWindPower"),
        solar_mw: num("SolarPower"),
      };
      const total = Object.values(production).reduce<number>((s, v) => s + (v ?? 0), 0);
      const renewable = (production.offshore_wind_mw ?? 0) + (production.onshore_wind_mw ?? 0) + (production.solar_mw ?? 0);
      return json({
        time_dk: String(r.Minutes1DK ?? "").replace("T", " ").slice(0, 16),
        source: edsSource(meta),
        co2_g_per_kwh: num("CO2Emission"),
        production_mw: production,
        total_production_mw: round3(total),
        wind_and_solar_share_pct: total > 0 ? round3((renewable / total) * 100) : null,
        exchange_mw: {
          net_import: num("Exchange_Sum"),
          dk1_germany: num("Exchange_DK1_DE"),
          dk1_netherlands: num("Exchange_DK1_NL"),
          dk1_great_britain: num("Exchange_DK1_GB"),
          dk1_norway: num("Exchange_DK1_NO"),
          dk1_sweden: num("Exchange_DK1_SE"),
          dk1_dk2: num("Exchange_DK1_DK2"),
          dk2_germany: num("Exchange_DK2_DE"),
          dk2_sweden: num("Exchange_DK2_SE"),
          bornholm_sweden: num("Exchange_Bornholm_SE"),
        },
        // Verified against ProductionConsumptionSettlement, where production plus
        // exchange equals gross consumption to the decimal: the sign is import-positive.
        note: "Positive exchange is power flowing into Denmark (import); negative is export. Danish consumption is production plus net import, so it is higher than production alone whenever net import is positive.",
      });
    }),
  );

  // --- Looking forward ---

  const topicNames = topics();
  server.registerTool(
    "get_projections",
    {
      title: "Projections to 2050",
      description:
        "The forward-looking counterpart to every other tool here. Those read what Energinet has measured or published, at most a day ahead; this reads the Danish Energy Agency's official projection of the Danish energy system year by year to 2050 (Analyseforudsætninger til Energinet): electricity demand by use (households, heat pumps, EVs and other transport, data centres, hydrogen), wind, solar and battery capacity, power plants, interconnectors, gas, district heating, fuel prices and CO2 allowance prices. " +
        "They are planning assumptions, not measurements and not a market price forecast, so say which it is when you answer and cite the source each table carries. " +
        "Call it with no arguments for the table of contents, then narrow with query (Danish words work best: varmepumper, elbiler, datacentre, solceller, havmøller, batterier) or topic.",
      inputSchema: {
        query: z.string().optional().describe("Words that must all appear in the table's headings, title or row labels, e.g. 'varmepumper', 'datacentre Østdanmark', 'solceller kapacitet'. Danish; accents optional."),
        topic: z.enum(topicNames as [string, ...string[]]).optional().describe("One sheet of the dataset"),
        table_id: z.string().optional().describe("An id such as af-026 from an earlier call, to fetch exactly that table"),
        years: z.array(z.number().int().min(2000).max(2100)).optional().describe("Years to include. Default: the first year, every fifth year, and 2050."),
        limit: z.number().int().min(1).max(20).default(6).describe("Maximum tables to return in full"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ query, topic, table_id, years, limit }) => {
      const { source, tables } = projections();
      const about = {
        kind: "projection (planning assumptions), not measured data",
        source: source.name,
        published: source.published,
        dataset_url: source.url,
        page: source.page,
        note: "This is the base scenario (grundforløb); its assumptions are set out in the summary note on the source page. Capacities marked 'primo år' are at the start of the year.",
      };
      if (table_id) {
        const t = tables.find((x) => x.id === table_id.trim().toLowerCase());
        if (!t) throw new ToolError(`No table ${table_id}. Call get_projections without arguments for the list of ids.`);
        return json({ ...about, tables: [shapeTable(t, years)] });
      }
      if (!query && !topic) {
        const contents = topicNames.map((name) => ({
          topic: name,
          tables: tables.filter((t) => t.topic === name).map((t) => ({ id: t.id, table: [...t.context, t.title].join(" > ") })),
        }));
        return json({ ...about, how: "Pick a table_id, or pass query/topic to get matching tables with their numbers.", contents });
      }
      const found = searchProjections(query, topic);
      if (!found.length) {
        return json({ ...about, tables: [], hint: `Nothing matched${query ? ` "${query}"` : ""}. Try one Danish word (varmepumper, elbiler, solceller, datacentre, batterier), or call without arguments for the table of contents.` });
      }
      return json({
        ...about,
        matched: found.length,
        tables: found.slice(0, limit).map((t) => shapeTable(t, years)),
        ...(found.length > limit ? { more: found.slice(limit).map((t) => ({ id: t.id, table: [...t.context, t.title].join(" > ") })) } : {}),
      });
    }),
  );
}
