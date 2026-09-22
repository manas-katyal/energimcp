import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheTtlFor, durationSeconds, freshness, summarize } from "../src/data.ts";
import type { DatasetMeta } from "../src/eds.ts";

test("ISO 8601 durations cover the frequencies this API actually uses", () => {
  assert.equal(durationSeconds("PT1M"), 60);
  assert.equal(durationSeconds("PT5M"), 300);
  assert.equal(durationSeconds("PT15M"), 900);
  assert.equal(durationSeconds("PT1H"), 3600);
  assert.equal(durationSeconds("P1D"), 86_400);
  assert.equal(durationSeconds("P1M"), 2_592_000);
  assert.equal(durationSeconds("N/A"), undefined, "the API writes N/A for datasets that no longer update");
  assert.equal(durationSeconds(undefined), undefined);
});

test("cache TTL follows the update frequency, clamped to a day", () => {
  assert.equal(cacheTtlFor({ updateFrequency: "PT5M" }), 300);
  assert.equal(cacheTtlFor({ updateFrequency: "P1Y" }), 86_400, "a yearly dataset is still re-checked daily");
  assert.equal(cacheTtlFor({ updateFrequency: "PT1S" }), 60, "never hammer, whatever the dataset claims");
});

test("freshness flags a dataset that has stopped moving", () => {
  const base = { datasetName: "X", title: "X", description: "", organizationName: "tso-electricity", active: true, datasetId: 1 };
  const live: DatasetMeta = { ...base, updateFrequency: "PT5M", dataTo: new Date(Date.now() - 10 * 60_000).toISOString() };
  assert.equal(freshness(live).stale, false);
  const dead: DatasetMeta = { ...base, updateFrequency: "PT5M", dataTo: new Date(Date.now() - 400 * 3_600_000).toISOString() };
  const f = freshness(dead);
  assert.equal(f.stale, true);
  assert.ok(f.hours_behind! > 300);
});

test("summarize reduces rows to per-column statistics", () => {
  const stats = summarize([
    { HourDK: "2026-01-01T00:00:00", PriceArea: "DK1", SpotPriceDKK: 100 },
    { HourDK: "2026-01-01T01:00:00", PriceArea: "DK1", SpotPriceDKK: 300 },
    { HourDK: "2026-01-01T02:00:00", PriceArea: "DK2", SpotPriceDKK: null },
  ]);
  const price = stats.find((s) => s.column === "SpotPriceDKK")!;
  assert.equal(price.min, 100);
  assert.equal(price.max, 300);
  assert.equal(price.mean, 200);
  assert.equal(price.sum, 400);
  assert.equal(price.nulls, 1);
  const area = stats.find((s) => s.column === "PriceArea")!;
  assert.deepEqual(area.distinct, ["DK1", "DK2"], "a category column lists its values");
});

test("summarize treats a long timestamp column as a range, not a value list", () => {
  const records = Array.from({ length: 20 }, (_, i) => ({ Minutes5DK: `2026-01-01T00:${String(i).padStart(2, "0")}:00` }));
  const stats = summarize(records)[0]!;
  assert.equal(stats.first, "2026-01-01T00:00:00");
  assert.equal(stats.last, "2026-01-01T00:19:00");
  assert.equal(stats.distinct, undefined);
});

test("summarize of nothing is nothing", () => {
  assert.deepEqual(summarize([]), []);
});
