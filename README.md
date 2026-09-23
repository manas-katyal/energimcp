# EnergiMCP

Read-only MCP server for Danish energy data: electricity prices, carbon intensity, consumption, production, grid capacity, balancing markets and gas — the 100 datasets Energinet publishes through [Energi Data Service](https://www.energidataservice.dk/).

No API key, no account, no registration. It is open public data.

```
You   When should I run the dishwasher today?
      → get_electricity_prices · DK2 · today
AI    Wait until the afternoon. The cheapest quarter-hour is 14:15 at 0.91 kr/kWh;
      the morning peak at 07:15 is 2.96 kr/kWh. Average across the day is 1.43 kr/kWh.
```

## Add it to Claude

**[Add to Claude](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=EnergiMCP&connectorUrl=https%3A%2F%2Fenergimcp-production.up.railway.app%2Fmcp)** opens Claude with the connector filled in; confirm and it is added. By hand: Settings → Connectors → Add custom connector, and paste `https://energimcp-production.up.railway.app/mcp`. There is no login. Once added on claude.ai or the desktop app, it shows up in the Claude mobile app too.

## Install

Needs Node 24 or newer. Add it to your MCP client:

```json
{
  "mcpServers": {
    "energi": { "command": "npx", "args": ["-y", "energimcp"] }
  }
}
```

That is the whole setup.

From a clone instead:

```bash
npm install
npm test          # stubs fetch; never touches the API
npm run stdio     # the server an MCP client launches
npm run check     # config + a live call
npm run datasets  # the catalogue, one line per dataset
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_datasets` | Search the catalogue by text or publisher. Hides the 22 discontinued datasets unless asked. |
| `describe_dataset` | Every column with type and unit, the time column `start`/`end` filter on, resolution, update frequency, and the first and last timestamp that exist. |
| `query_dataset` | Any dataset, with `start`, `end`, `columns`, `filter`, `sort`, `offset`, `limit`. `summary: true` returns per-column statistics instead of rows. |
| `download_url` | A CSV, JSON or Excel link for extracts too large to read into a conversation. Builds the URL without fetching it. |
| `get_electricity_prices` | Day-ahead prices in 15-minute resolution with the cheapest and dearest periods worked out. |
| `get_carbon_intensity` | g CO₂/kWh in 5-minute resolution, with the forecast and the greenest upcoming window. |
| `get_power_system_now` | One-minute snapshot: production by source, wind and solar share, carbon intensity, every interconnector. |
| `get_projections` | Looks forward instead of back: the Danish Energy Agency's official projection to 2050 (Analyseforudsætninger til Energinet) — demand by use including heat pumps, EVs and data centres, wind, solar and battery capacity, fuel and CO₂ prices. Planning assumptions, not measurements. |

Every result names its source: Energinet's Energi Data Service dataset for the tools that look back, or the Energy Agency's table for projections, so an answer never blends the two without saying so.

Three prompts ship with it: `when-to-run`, `find-dataset` and `grid-snapshot`.

## What this API does that the code works around

Four things about Energi Data Service shaped the implementation, and all four are easy to get wrong:

**Rate limits are per dataset and tight.** The platform expects roughly one request per dataset update interval and answers `429 Rate limit is exceeded. Try again in N seconds.` otherwise — in testing, the third request inside two minutes was refused. So every response is cached for that dataset's own update interval, identical in-flight calls are shared, outbound calls are spaced, and a 429 is reported to the model as something to wait out rather than retry.

**22 of the 100 datasets are discontinued and still answer `200`.** `Elspotprices` stopped updating on 2025-09-30 and happily returns year-old rows. Retirement is recorded only in the title, and the replacement only as a markdown link in the description. `query_dataset` detects both and returns a warning naming the successor, so stale prices are not presented as current.

**The metadata endpoint emits invalid JSON.** Descriptions contain raw unescaped newlines, which `JSON.parse` rejects. `parseLenientJson` repairs the control characters inside strings.

**Errors are plain text.** `404 dataset not found X`, `400 Invalid column X` — and `/meta/dataset/{unknown}` answers `204` with an empty body rather than 404. A 400 is enriched with the dataset's actual column list, since the model cannot guess them.

One correctness note worth stating: in `PowerSystemRightNow`, **positive exchange values are imports into Denmark**, not exports. The metadata does not say so. It is verifiable in `ProductionConsumptionSettlement`, where production plus exchange equals gross consumption exactly.

## Refreshing the projections

The Energy Agency publishes the dataset as an Excel workbook, not an API, and updates it about once a year. `npm run projections` downloads it and rewrites `data/projections.json`; pass a path to read a local copy instead. The script reads the heading levels from the workbook's fonts, so check the table list it prints after a new edition.

## Hosting it

`npm start` serves stateless streamable HTTP on `/mcp`, with `/healthz` for a probe. There is no auth, because there is nothing private behind it — do not put anything private behind it. The `Dockerfile` builds a container; `CACHE_DIR` is the only volume worth mounting, and only to keep the catalogue warm across restarts.

Hosting it is optional. The stdio server above is enough for a desktop client; deploy only if you want the tools on claude.ai or your phone, where a client cannot launch a local process.

### Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Fmanas-katyal%2Fenergimcp)

One click creates the container, the build and a public domain in your own Railway account. There is nothing to configure afterwards: no API key, no volume, no environment variables. When it is up, add `https://<your-domain>/mcp` as a custom connector in claude.ai.

Or from a clone:

`.railway/railway.ts` declares the service and health-checks `/healthz`; the build comes from the `Dockerfile` at the repository root, which Railway picks up automatically. From a clone:

```bash
npm i -g @railway/cli
railway login
railway init            # creates the project
railway up              # builds and deploys
railway domain          # gives it a public URL
```

Then add `https://<your-domain>/mcp` as a custom connector in your assistant. Nothing else to configure: there are no secrets, and `BASE_URL` is detected from `RAILWAY_PUBLIC_DOMAIN`.

The same container runs anywhere — Fly, Render, a VPS. It is stateless, so scale it to as many replicas as you like; the only cost of losing the cache is one extra catalogue fetch per instance.

## Layout

```
src/eds.ts       API client: caching, request spacing, lenient JSON, typed errors
src/catalog.ts   the 100 datasets: search, name resolution, retirement, successors
src/data.ts      response shaping: dataset cards, freshness, per-column summaries
src/tools.ts     the seven tools
src/mcp.ts       server factory and the instructions the model reads first
src/stdio.ts     local entry point
src/server.ts    hosted entry point
data/catalog.json  catalogue snapshot, so discovery works on a cold start
docs/            the landing page (GitHub Pages)
```

Refresh the snapshot with `npm run catalog`.

## Not affiliated

An independent open-source client for a public API. Not affiliated with Energinet, Energi Data Service or Anthropic. Data is published by Energinet under their own terms. Spot prices exclude tariffs, taxes and VAT, which roughly double a Danish household bill — `DatahubPricelist` has the tariffs if you want the real number. MIT licence.
