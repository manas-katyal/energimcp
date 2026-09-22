#!/usr/bin/env node
// Runs EnergiMCP locally over stdio for an MCP client. Requires Node 24 or newer.
const [major] = process.versions.node.split(".").map(Number);
if (major < 24) {
  console.error(`EnergiMCP needs Node 24 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
// A bare `energimcp` is the stdio server an MCP client launches. Anything with
// arguments is a command for the person at the keyboard.
if (process.argv.length > 2) {
  process.env.ENERGIMCP_LOCAL ??= "1";
  await import("../dist/lib/cli.js");
} else {
  await import("../dist/lib/stdio.js");
}
