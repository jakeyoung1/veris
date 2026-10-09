#!/usr/bin/env node
// veris — provenance-first web + SEC data for AI agents.
//   veris-mcp          → stdio MCP server (default, for local clients)
//   veris-mcp http     → Streamable HTTP server (remote/hosted; see http.ts)
//   veris-mcp digest   → run every watch, summarize what's new, email it
//   veris-mcp mailtest → verify SMTP credentials without sending
//   veris-mcp ledger   → print the attribution ledger [--kind K] [--url U] [--limit N] [--verify]

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
} else if (cmd === "ledger") {
  const { listLedger, verifyLedger, ledgerPath } = await import("./cache.js");
  const args = process.argv.slice(3);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes("--verify")) {
    const v = await verifyLedger();
    console.error(
      v.ok
        ? `OK: ${v.entries} entries, hash chain intact (${ledgerPath()})`
        : `FAIL: chain broken at seq ${v.brokenAt} of ${v.entries} (${ledgerPath()})`,
    );
    if (!v.ok) process.exitCode = 1;
  } else {
    const limit = opt("limit");
    const rows = await listLedger({
      kind: opt("kind") as never,
      url: opt("url"),
      since: opt("since"),
      limit: limit ? Number(limit) : undefined,
    });
    for (const r of rows) console.log(JSON.stringify(r));
  }
} else {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { buildServer } = await import("./tools.js");
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error("veris MCP server running on stdio");
}
