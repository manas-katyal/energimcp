import { test } from "node:test";
import assert from "node:assert/strict";
import { EdsError, parseLenientJson, queryString } from "../src/eds.ts";

test("the metadata endpoint's raw newlines are repaired, not rejected", () => {
  // Energi Data Service really does send literal newlines inside JSON strings;
  // JSON.parse refuses this, and every /meta/dataset call would otherwise fail.
  const broken = '{"description":"Line one\nLine two","tab":"a\tb"}';
  assert.throws(() => JSON.parse(broken), "precondition: this is not valid JSON");
  const parsed = parseLenientJson<{ description: string; tab: string }>(broken);
  assert.equal(parsed.description, "Line one\nLine two");
  assert.equal(parsed.tab, "a\tb");
});

test("well-formed JSON is untouched, including escaped quotes", () => {
  const ok = '{"a":"he said \\"hi\\"","b":[1,2,3]}';
  assert.deepEqual(parseLenientJson(ok), { a: 'he said "hi"', b: [1, 2, 3] });
});

test("a quote inside an escaped sequence does not flip the string state", () => {
  const broken = '{"a":"back\\\\slash","b":"new\nline"}';
  assert.deepEqual(parseLenientJson(broken), { a: "back\\slash", b: "new\nline" });
});

test("query strings match the documented parameter names", () => {
  const qs = queryString({ start: "now-P1D", end: "now", columns: ["HourUTC", "PriceArea"], filter: { PriceArea: ["DK1", "DK2"] }, sort: "HourUTC desc", limit: 4 });
  const params = new URLSearchParams(qs);
  assert.equal(params.get("start"), "now-P1D");
  assert.equal(params.get("columns"), "HourUTC,PriceArea");
  assert.equal(params.get("filter"), '{"PriceArea":["DK1","DK2"]}');
  assert.equal(params.get("sort"), "HourUTC desc");
  assert.equal(params.get("limit"), "4");
});

test("a future-dated relative time survives URL encoding", () => {
  // "+" in a query string means a space; the API guide insists on %2B.
  const qs = queryString({ end: "now+P2D" });
  assert.ok(qs.includes("now%2BP2D"), qs);
  assert.equal(new URLSearchParams(qs).get("end"), "now+P2D");
});

test("empty parameters are left out entirely", () => {
  assert.equal(queryString({ filter: {}, columns: [] }), "");
});

test("a rate limit reports how long to wait", () => {
  const err = new EdsError(429, '{"statusCode":429,"message":"Rate limit is exceeded. Try again in 292 seconds."}', "https://example.test");
  assert.equal(err.isRateLimit, true);
  assert.equal(err.retryAfterSeconds, 292);
  assert.equal(new EdsError(404, "dataset not found Foo", "u").isNotFound, true);
  assert.equal(new EdsError(400, "Invalid column X", "u").retryAfterSeconds, undefined);
});
