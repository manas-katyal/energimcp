// Local entry point for Claude Desktop, Claude Code, Cursor and other stdio
// MCP clients. Nothing may write to stdout except the transport, so warnings
// go to stderr.
process.env.ENERGIMCP_LOCAL ??= "1";
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer } = await import("./mcp.ts");
const { setupProblems } = await import("./config.ts");

for (const problem of setupProblems()) console.error(`[energi] ${problem}`);

const transport = new StdioServerTransport();
transport.onclose = () => process.exit(0);
process.stdin.on("end", () => process.exit(0));
await createServer().connect(transport);
