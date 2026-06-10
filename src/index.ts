#!/usr/bin/env node
// veris — provenance-first web + SEC data for AI agents.
//   veris-mcp        → stdio MCP server (default, for local clients)
//   veris-mcp http   → Streamable HTTP server (remote/hosted; see http.ts)

if (process.argv[2] === "http") {
  await import("./http.js");
} else {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { buildServer } = await import("./tools.js");
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("veris MCP server running on stdio");
}
