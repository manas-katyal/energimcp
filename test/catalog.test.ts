import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bundledCatalog, datasets, isDiscontinued, resolveDataset, searchDatasets, successors } from "../src/catalog.ts";
import { eds } from "../src/eds.ts";

// Every test here runs with the network refused, which is also the point:
// discovery must keep working from the bundled snapshot when the API is down.
const realFetch = globalThis.fetch;
beforeEach(() => {
  eds.clearCache();
  globalThis.fetch = (() => Promise.reject(new Error("network disabled in tests"))) as typeof fetch;
});
process.on("exit", () => void (globalThis.fetch = realFetch));

test("the bundled snapshot ships a full catalogue", () => {
  const all = bundledCatalog();
  assert.equal(all.length, 100);
  assert.ok(all.every((d) => d.datasetName && d.title && d.organizationName));
});

test("the catalogue falls back to the snapshot when the API is unreachable", async () => {
  const all = await datasets();
  assert.equal(all.length, 100);
});

test("retirement is read out of the title, because there is no field for it", async () => {
  const all = await datasets();
  const retired = all.filter(isDiscontinued);
  assert.equal(retired.length, 22);
  assert.ok(retired.some((d) => d.datasetName === "Elspotprices"));
});

test("a retired dataset points at its replacement, ignoring links to other organisations", async () => {
  const all = await datasets();
  const elspot = all.find((d) => d.datasetName === "Elspotprices")!;
  assert.deepEqual(successors(elspot, all), ["DayAheadPrices"]);
  // CountertradeIntraday links to both its successor and to ENTSO-E; only the
  // one that names a real dataset may survive.
  const ct = all.find((d) => d.datasetName === "CountertradeIntraday")!;
  assert.deepEqual(successors(ct, all), ["CountertradeIntraday_v2"]);
});

test("dataset names resolve whatever the casing", async () => {
  assert.equal((await resolveDataset("dayaheadprices")).datasetName, "DayAheadPrices");
  assert.equal((await resolveDataset("CO2Emis")).datasetName, "CO2Emis");
});

test("an ambiguous reference names the candidates instead of guessing", async () => {
  await assert.rejects(resolveDataset("declaration"), (err: Error) => /matches \d+ datasets/.test(err.message) && err.message.includes("Declaration"));
  await assert.rejects(resolveDataset("definitely not a dataset"), /No dataset/);
});

test("search hides discontinued datasets unless asked", async () => {
  const visible = await searchDatasets({ query: "spot" });
  assert.ok(!visible.datasets.some((d) => d.datasetName === "Elspotprices"), "a retired dataset must not be offered by default");
  const withRetired = await searchDatasets({ query: "spot", includeDiscontinued: true });
  assert.ok(withRetired.datasets.some((d) => d.datasetName === "Elspotprices"));
});

test("search can be scoped to one publisher and reports what it left out", async () => {
  const gas = await searchDatasets({ organization: "tso-gas", includeDiscontinued: true });
  assert.equal(gas.total, 15);
  assert.ok(gas.datasets.every((d) => d.organizationName === "tso-gas"));
  const capped = await searchDatasets({ organization: "tso-electricity", limit: 5 });
  assert.equal(capped.datasets.length, 5);
  assert.ok(capped.total > 5);
});
