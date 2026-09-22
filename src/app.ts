// HTTP entry point. Energi Data Service is public data, so unlike a server that
// reaches into someone's own accounts there is nothing here to put behind a
// login: the MCP endpoint is stateless and open, and each request gets its own
// transport so instances can be scaled horizontally without sticky sessions.
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, setupProblems } from "./config.ts";
import { createServer, VERSION } from "./mcp.ts";

export function createApp() {
  const log = (msg: string, extra?: unknown) => console.log(`[energi ${new Date().toISOString()}] ${msg}`, extra ?? "");

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    res.set({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: VERSION, api: config.apiBase, problems: setupProblems() });
  });

  app.get("/", (_req, res) => {
    res
      .type("text/plain")
      .send(
        `${config.appName} ${VERSION}\n\nRead-only MCP server for Energi Data Service (Danish energy data).\nMCP endpoint: POST ${config.baseUrl}/mcp\nHealth: ${config.baseUrl}/healthz\n`,
      );
  });

  app.post("/mcp", async (req, res) => {
    // Stateless: a fresh server and transport per request, closed when the
    // response ends. No session ids to keep in sync across instances.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createServer();
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log("request failed:", (err as Error).message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });

  // GET and DELETE exist in the spec for session-based servers. This one is
  // stateless, so say that plainly instead of failing with a confusing error.
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", (_req, res) => {
      res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "This server is stateless; use POST /mcp." }, id: null });
    });
  }

  return app;
}
