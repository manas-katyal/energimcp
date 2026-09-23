import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.ts";
import { registerPrompts } from "./prompts.ts";

export const VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "energi",
      title: "EnergiMCP",
      version: VERSION,
      websiteUrl: "https://energimcp.dk",
      icons: [
        { src: "https://energimcp.dk/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
        { src: "https://energimcp.dk/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
      ],
    },
    {
      instructions: [
        "Read-only access to Energi Data Service, Energinet's open data platform for the Danish energy system: electricity prices, carbon intensity, consumption, production, grid capacity, balancing markets and gas. It has no write tools and needs no credentials.",
        "Two directions of time, two sources. Every tool except get_projections looks back, or at most a day ahead, at data Energinet has measured or published. get_projections looks forward to 2050 with the Danish Energy Agency's planning assumptions. Never blend the two without saying which number came from where, and cite the `source` each result carries.",
        "Column names differ per dataset and cannot be guessed. Call describe_dataset before query_dataset, and use the `time_column` it reports when reasoning about the period; `start` and `end` filter on that column only.",
        "Times are Danish local time unless a column name says UTC. Relative expressions work: now, StartOfDay, StartOfMonth, StartOfYear, with ISO 8601 offsets such as now-P1D or now-PT15M.",
        "22 of the 100 datasets are discontinued and still answer with old rows. If a tool warns that a dataset is discontinued, say so and use the replacement it names rather than presenting stale numbers as current.",
        "Rate limits are per dataset and tight. Responses are cached for roughly one update interval, so asking the same thing twice is free, but varying a query to retry after a 429 is not. If a tool reports a rate limit, wait or answer from what you have.",
        "Prefer summary=true over fetching long ranges of five-minute data, and download_url for anything a person needs as a file.",
        "Spot prices are per MWh excluding tariffs, taxes and VAT; do not present them as what a household pays.",
      ].join(" "),
    },
  );
  registerTools(server);
  registerPrompts(server);
  return server;
}
