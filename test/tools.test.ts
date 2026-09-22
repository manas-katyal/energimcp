import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp.ts";
import { eds } from "../src/eds.ts";

const catalog = JSON.parse(readFileSync(new URL("../data/catalog.json", import.meta.url), "utf8")) as { datasetName: string; title: string; description: string; organizationName: string }[];
const entry = (name: string) => catalog.find((d) => d.datasetName === name)!;

const dayAheadMeta = {
  ...entry("DayAheadPrices"),
  updateFrequency: "P1D",
  resolution: "15 minutes (PT15M)",
  filterColumn: "TimeUTC",
  dataFrom: "2025-10-01T00:00:00",
  dataTo: new Date(Date.now() + 86_400_000).toISOString(),
  lastDataUpdate: new Date().toISOString(),
  columns: [
    { dbColumn: "TimeUTC", dataType: "datetime", primaryKeyIndex: 1, description: "Start of the period in UTC" },
    { dbColumn: "TimeDK", dataType: "datetime" },
    { dbColumn: "PriceArea", dataType: "string" },
    { dbColumn: "DayAheadPriceEUR", dataType: "number", unit: "EUR/MWh" },
    { dbColumn: "DayAheadPriceDKK", dataType: "number", unit: "DKK/MWh" },
  ],
};

const elspotMeta = { ...entry("Elspotprices"), updateFrequency: "N/A", filterColumn: "HourUTC", dataTo: "2025-09-30T22:00:00", columns: [{ dbColumn: "HourDK", dataType: "datetime" }] };

const priceRows = [
  { TimeDK: "2026-09-23T00:00:00", PriceArea: "DK1", DayAheadPriceDKK: 400, DayAheadPriceEUR: 53.6 },
  { TimeDK: "2026-09-23T00:15:00", PriceArea: "DK1", DayAheadPriceDKK: 120, DayAheadPriceEUR: 16.1 },
  { TimeDK: "2026-09-23T00:30:00", PriceArea: "DK1", DayAheadPriceDKK: 900, DayAheadPriceEUR: 120.6 },
  { TimeDK: "2026-09-23T00:00:00", PriceArea: "DK2", DayAheadPriceDKK: 500, DayAheadPriceEUR: 67 },
];

/** URLs the stub was asked for, so a test can assert that nothing was fetched. */
let requested: string[] = [];
let handler: (url: string) => { status: number; body: string } = () => ({ status: 404, body: "not stubbed" });

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request) => {
  const url = String(input);
  requested.push(url);
  const { status, body } = handler(url);
  return Promise.resolve(new Response(body, { status }));
}) as typeof fetch;
after(() => void (globalThis.fetch = realFetch));

/** True for a data query, false for the /meta/ lookup of the same dataset. */
const isQuery = (url: string, dataset: string) => !url.includes("/meta/") && url.includes(`/dataset/${dataset}`);

function defaultHandler(url: string): { status: number; body: string } {
  if (url.endsWith("/meta/dataset")) return { status: 200, body: JSON.stringify(catalog) };
  if (url.includes("/meta/dataset/DayAheadPrices")) return { status: 200, body: JSON.stringify(dayAheadMeta) };
  if (url.includes("/meta/dataset/Elspotprices")) return { status: 200, body: JSON.stringify(elspotMeta) };
  if (url.includes("/dataset/DayAheadPrices")) return { status: 200, body: JSON.stringify({ total: priceRows.length, limit: 5000, dataset: "DayAheadPrices", records: priceRows }) };
  if (url.includes("/dataset/Elspotprices")) return { status: 200, body: JSON.stringify({ total: 1, limit: 200, dataset: "Elspotprices", records: [{ HourDK: "2025-09-30T23:00:00", SpotPriceDKK: 690.7 }] }) };
  return { status: 404, body: "dataset not found" };
}

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

/** Tool results are JSON text; this is what an assistant would parse. */
async function call(name: string, args: Record<string, unknown> = {}) {
  const { client, close } = await connect();
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0]!.text;
    return { isError: res.isError ?? false, text, data: res.isError ? undefined : JSON.parse(text) };
  } finally {
    await close();
  }
}

beforeEach(() => {
  eds.clearCache();
  requested = [];
  handler = defaultHandler;
});

test("the server advertises the tools it documents", async () => {
  const { client, close } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["describe_dataset", "download_url", "get_carbon_intensity", "get_electricity_prices", "get_power_system_now", "list_datasets", "query_dataset"]);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
  assert.deepEqual(prompts, ["find-dataset", "grid-snapshot", "when-to-run"]);
  await close();
});

test("list_datasets hides retired datasets and can scope to a publisher", async () => {
  const visible = await call("list_datasets", { search: "price" });
  assert.ok(!visible.data.datasets.some((d: { dataset: string }) => d.dataset === "Elspotprices"));
  const gas = await call("list_datasets", { publisher: "gas-storage-denmark" });
  assert.equal(gas.data.total, 4);
});

test("describe_dataset reports the time column, the columns and the coverage", async () => {
  const { data } = await call("describe_dataset", { dataset: "dayaheadprices" });
  assert.equal(data.dataset, "DayAheadPrices");
  assert.equal(data.time_column, "TimeUTC", "start/end filter on this column, not on TimeDK");
  assert.deepEqual(
    data.columns.map((c: { name: string }) => c.name),
    ["TimeUTC", "TimeDK", "PriceArea", "DayAheadPriceEUR", "DayAheadPriceDKK"],
  );
  assert.equal(data.columns[4].unit, "DKK/MWh");
  assert.equal(data.coverage.data_from, "2025-10-01T00:00:00");
  assert.equal(data.discontinued, false);
});

test("querying a discontinued dataset still returns the rows, but says so and names the replacement", async () => {
  const { data } = await call("query_dataset", { dataset: "Elspotprices", limit: 10 });
  assert.equal(data.returned, 1, "history is real data and is not withheld");
  assert.match(data.warning, /discontinued/i);
  assert.deepEqual(data.use_instead, ["DayAheadPrices"]);
});

test("summary=true returns statistics instead of rows", async () => {
  const { data } = await call("query_dataset", { dataset: "DayAheadPrices", summary: true });
  assert.equal(data.records, undefined);
  const price = data.summary.find((s: { column: string }) => s.column === "DayAheadPriceDKK");
  assert.equal(price.min, 120);
  assert.equal(price.max, 900);
  assert.equal(data.query.limit, 5000, "a summary reads the whole window, not the default page");
});

test("limit=0 is refused, because to this API it means every row ever", async () => {
  const res = await call("query_dataset", { dataset: "DayAheadPrices", limit: 0 });
  assert.equal(res.isError, true);
  assert.match(res.text, /download_url/);
});

test("a rate limit is reported as something to wait out, not to retry", async () => {
  handler = (url) => (isQuery(url, "DayAheadPrices") ? { status: 429, body: '{"statusCode":429,"message":"Rate limit is exceeded. Try again in 292 seconds."}' } : defaultHandler(url));
  const res = await call("query_dataset", { dataset: "DayAheadPrices" });
  assert.equal(res.isError, true);
  assert.match(res.text, /292 seconds/);
  assert.match(res.text, /Repeating the call now will fail/);
});

test("an unknown dataset points back at the catalogue", async () => {
  const res = await call("describe_dataset", { dataset: "SpotPricesPlease" });
  assert.equal(res.isError, true);
  assert.match(res.text, /list_datasets/);
});

test("download_url builds a link without spending the rate limit on the data", async () => {
  const { data } = await call("download_url", { dataset: "DayAheadPrices", format: "csv", start: "2026-01-01", end: "2026-02-01", limit: 0 });
  const url = new URL(data.url);
  assert.equal(url.pathname, "/dataset/DayAheadPrices/download");
  assert.equal(url.searchParams.get("format"), "csv");
  assert.equal(url.searchParams.get("limit"), "0");
  assert.ok(
    !requested.some((u) => u.includes("/download")),
    "building a link must not fetch it",
  );
});

test("get_electricity_prices finds the cheapest and dearest period per area", async () => {
  const { data } = await call("get_electricity_prices", { price_areas: ["DK1", "DK2"] });
  const dk1 = data.summary.find((s: { area: string }) => s.area === "DK1");
  assert.equal(dk1.cheapest.dkk_per_kwh, 0.12);
  assert.equal(dk1.cheapest.time_dk, "2026-09-23 00:15");
  assert.equal(dk1.most_expensive.dkk_per_kwh, 0.9);
  assert.equal(dk1.mean_dkk_per_kwh, round3((400 + 120 + 900) / 3 / 1000));
  assert.equal(data.periods.length, 4);
  const withoutRows = await call("get_electricity_prices", { include_periods: false });
  assert.equal(withoutRows.data.periods, undefined);
});

const round3 = (n: number) => Math.round(n * 1000) / 1000;

test("identical calls are answered from cache, so an agent's repetition is free", async () => {
  await call("describe_dataset", { dataset: "DayAheadPrices" });
  const before = requested.length;
  await call("describe_dataset", { dataset: "DayAheadPrices" });
  assert.equal(requested.length, before, "the second call must not reach the API");
});

test("a wrong column name is answered with the right ones", async () => {
  handler = (url) => (isQuery(url, "DayAheadPrices") ? { status: 400, body: "Invalid column HourDK" } : defaultHandler(url));
  const res = await call("query_dataset", { dataset: "DayAheadPrices", columns: ["HourDK"] });
  assert.equal(res.isError, true);
  assert.match(res.text, /Invalid column HourDK/);
  assert.match(res.text, /TimeUTC, TimeDK, PriceArea/, "the model cannot guess these, so they are handed over");
  assert.match(res.text, /start and end filter on TimeUTC/);
});

test("exchange is reported import-positive, the way the energy balance actually works", async () => {
  // Production + exchange = gross consumption in ProductionConsumptionSettlement,
  // so a positive Exchange_Sum is power flowing into Denmark, not out of it.
  handler = (url) =>
    url.includes("/meta/dataset/PowerSystemRightNow")
      ? { status: 200, body: JSON.stringify({ ...entry("PowerSystemRightNow"), updateFrequency: "PT1M", filterColumn: "Minutes1UTC", columns: [] }) }
      : isQuery(url, "PowerSystemRightNow")
        ? {
            status: 200,
            body: JSON.stringify({
              total: 1,
              limit: 1,
              dataset: "PowerSystemRightNow",
              records: [{ Minutes1DK: "2026-09-23T00:46:00", CO2Emission: 154, ProductionGe100MW: 820, ProductionLt100MW: 340, OffshoreWindPower: 160, OnshoreWindPower: 240, SolarPower: 0, Exchange_Sum: 2168 }],
            }),
          }
        : defaultHandler(url);
  const { data } = await call("get_power_system_now");
  assert.equal(data.exchange_mw.net_import, 2168);
  assert.match(data.note, /into Denmark \(import\)/);
  assert.equal(data.total_production_mw, 1560);
  assert.equal(data.wind_and_solar_share_pct, round3((400 / 1560) * 100));
});
