// veris over Streamable HTTP — the remote/hosted surface.
// Stateless mode: each POST /mcp gets a fresh server + transport (tools are
// stateless; watch state is on disk). Self-hosting is free and open; set
// VERIS_API_KEYS to gate access — that's the metering switch for a hosted
// instance. x402/AP2 agentic payments slot in at the same checkpoint later.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, VERSION } from "./tools.js";

const PORT = Number(process.env.VERIS_PORT ?? process.env.PORT ?? 8787);
const HOST = process.env.VERIS_HTTP_HOST ?? "127.0.0.1";
const KEYS = new Set(
  (process.env.VERIS_API_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
const RATE_PER_MIN = Number(process.env.VERIS_RATE_LIMIT ?? 60);
const MAX_BODY = 1_000_000; // 1MB

const buckets = new Map<string, { n: number; reset: number }>();
function underRateLimit(ip: string): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.reset) {
    buckets.set(ip, { n: 1, reset: now + 60_000 });
    return true;
  }
  b.n++;
  return b.n <= RATE_PER_MIN;
}

function authed(req: IncomingMessage): boolean {
  if (!KEYS.size) return true; // no keys configured → open (self-host default)
  const h = req.headers.authorization ?? "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const alt = (req.headers["x-api-key"] as string | undefined)?.trim() ?? "";
  return KEYS.has(bearer) || KEYS.has(alt);
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-api-key, mcp-session-id, mcp-protocol-version",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

function rpcError(res: ServerResponse, http: number, code: number, message: string): void {
  res.writeHead(http, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const httpServer = createServer(async (req, res) => {
  try {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "veris", version: VERSION, auth: KEYS.size > 0 }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("veris MCP server — POST /mcp (GET /healthz)");
      return;
    }
    if (req.method !== "POST") {
      rpcError(res, 405, -32000, "Stateless server: POST /mcp only.");
      return;
    }

    if (!authed(req)) {
      rpcError(res, 401, -32001, "Unauthorized: send 'Authorization: Bearer <key>' or 'x-api-key'.");
      return;
    }
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "?";
    if (!underRateLimit(ip)) {
      rpcError(res, 429, -32002, `Rate limit exceeded (${RATE_PER_MIN}/min).`);
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      rpcError(res, 400, -32700, "Parse error (invalid or oversized JSON).");
      return;
    }

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    if (!res.headersSent) {
      rpcError(res, 500, -32603, e instanceof Error ? e.message : String(e));
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(
    `veris ${VERSION} HTTP MCP listening on http://${HOST}:${PORT}/mcp ` +
      `(auth: ${KEYS.size ? `${KEYS.size} API key(s)` : "open"}; rate: ${RATE_PER_MIN}/min/IP)`,
  );
});
