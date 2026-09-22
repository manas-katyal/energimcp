import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const text = (t: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "when-to-run",
    {
      title: "When should I run this?",
      description: "Pick the cheapest or greenest window in the next day or two for something power-hungry: the dishwasher, the car, a heat pump, a compute job.",
      argsSchema: {
        what: z.string().optional().describe("What you want to run, e.g. 'charge the car for 4 hours'"),
        area: z.string().optional().describe("DK1 or DK2"),
      },
    },
    ({ what, area }) =>
      text(
        `Find the best window to ${what ?? "run something power-hungry"}${area ? ` in ${area}` : ""} over the next 24-48 hours.

1. Call get_electricity_prices for the area (ask me which if you do not know it: DK1 is west of the Great Belt, DK2 is east). If tomorrow's prices are not published yet, say so and work with what exists rather than guessing.
2. Call get_carbon_intensity with include_forecast for the same area.
3. If I named a duration, find the cheapest contiguous block of that length, not just the single cheapest quarter-hour. Do the same for carbon.
4. Answer with one recommended window in Danish local time, what it costs per kWh at spot, and what the carbon intensity is then. If the cheapest and the greenest windows differ, give both in one line each and say which I would pick for which reason.
5. Be honest about the size of the difference. If the spread across the day is small, say that waiting is not worth it.
6. Spot price is not my bill: tariffs, taxes and VAT roughly double it, and grid tariffs are themselves time-of-day dependent. Mention this once, briefly, and do not invent the tariff numbers.`,
      ),
  );

  server.registerPrompt(
    "find-dataset",
    {
      title: "Find the right dataset",
      description: "Work out which of the 100 datasets answers a question, and what it would take to query it.",
      argsSchema: { question: z.string().optional().describe("What you want to find out") },
    },
    ({ question }) =>
      text(
        `Work out which Energi Data Service dataset answers this: ${question ?? "(ask me what I want to know)"}

1. Call list_datasets with two or three different search terms; the catalogue's wording often differs from mine (consumption vs. load, day-ahead vs. spot, declaration vs. emissions).
2. Shortlist at most three candidates and call describe_dataset on each. Compare on: does it have the column I need, at what resolution, over what period, and is it still updated.
3. Reject candidates out loud and briefly, so I learn the catalogue. Flag any discontinued ones and name their replacement.
4. Recommend one, and show the exact query_dataset call you would make — dataset, time column, columns, filter — before running it.
5. Then run it with a short range and show me the shape of the data, not a wall of rows.`,
      ),
  );

  server.registerPrompt(
    "grid-snapshot",
    {
      title: "Grid snapshot",
      description: "What the Danish power system is doing right now, in plain language.",
    },
    () =>
      text(
        `Give me a short readout of the Danish power system right now.

1. Call get_power_system_now.
2. Call get_electricity_prices for DK1 and DK2 with include_periods false.
3. Write at most six lines: how much is being produced and from what, the wind and solar share, whether Denmark is importing or exporting overall and with which neighbours, the current carbon intensity, and the current spot price in each area.
4. Add one sentence of interpretation only if something is genuinely unusual — a very high renewable share, negative prices, an interconnector at an extreme. Otherwise stop.`,
      ),
  );
}
