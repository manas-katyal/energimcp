// HTTP entry point. Energi Data Service is public data, so unlike a server that
// reaches into someone's own accounts there is nothing here to put behind a
// login: the MCP endpoint is stateless and open, and each request gets its own
// transport so instances can be scaled horizontally without sticky sessions.
import express from "express";
import { fileURLToPath } from "node:url";
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

  // Clients such as claude.ai pick a connector's icon from the server's own
  // origin, so the favicon has to live here and not only on the website.
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  app.use(express.static(publicDir, { index: false, maxAge: "1d" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: VERSION, api: config.apiBase, problems: setupProblems() });
  });

  app.get("/", (_req, res) => {
    res
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>${config.appName}</title>` +
          `<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="48x48">` +
          `<pre>${config.appName} ${VERSION}\n\nRead-only MCP server for Energi Data Service (Danish energy data).\nMCP endpoint: POST ${config.baseUrl}/mcp\nHealth: ${config.baseUrl}/healthz\n</pre>`,
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
