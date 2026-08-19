#!/usr/bin/env node
// veris — provenance-first web + SEC data for AI agents.
//   veris-mcp          → stdio MCP server (default, for local clients)
//   veris-mcp http     → Streamable HTTP server (remote/hosted; see http.ts)
//   veris-mcp digest   → run every watch, summarize what's new, email it
//   veris-mcp mailtest → verify SMTP credentials without sending

const cmd = process.argv[2];

if (cmd === "http") {
  await import("./http.js");
} else if (cmd === "digest") {
  const { runDigestCli } = await import("./digest.js");
  await runDigestCli(process.argv.slice(3));
} else if (cmd === "mailtest") {
  const { verifyMail } = await import("./notify.js");
  const { ok, detail } = await verifyMail();
  console.error(`${ok ? "OK" : "FAIL"}: ${detail}`);
  if (!ok) process.exitCode = 1;
} else {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { buildServer } = await import("./tools.js");
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("veris MCP server running on stdio");
}
