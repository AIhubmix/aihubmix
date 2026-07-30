#!/usr/bin/env node
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, SERVER_NAME, SERVER_VERSION } from "./config.js";
import { AihubmixClient } from "./aihubmix.js";
import { buildServer } from "./server.js";

const HELP = `${SERVER_NAME} v${SERVER_VERSION} — official AIHubMix MCP server

Usage:
  aihubmix-mcp                 stdio transport (for Claude Code / Codex / Cursor local config)
  aihubmix-mcp --http          Streamable HTTP transport on http://127.0.0.1:7300/mcp
  aihubmix-mcp --http --port N custom port
  aihubmix-mcp --help

Environment:
  AIHUBMIX_API_KEY    API key for credits-get / chat-send (HTTP mode also accepts
                      an "Authorization: Bearer <key>" header per request)
  AIHUBMIX_API_BASE   gateway origin(s), comma-separated failover chain
                      (default https://aihubmix.com,https://api.inferera.com —
                      same backend; fails over automatically, sticky, primary
                      re-probed every 10 min; a single custom value disables failover)
  AIHUBMIX_DOCS_BASE  docs origin (default https://docs.aihubmix.com)
  AIHUBMIX_ACCESS_TOKEN     Manage Key (系统访问令牌, fd***) for the account tools
                            (account-get / keys-list / account-models) — a different
                            credential from the sk- API key
  AIHUBMIX_ENABLE_KEY_ADMIN set to 1 to also register the key-admin WRITE tools
                            (keys-create / keys-update / keys-delete); off by default
  AIHUBMIX_APP_CODE   optional APP-Code header for billable calls
  AIHUBMIX_TIMEOUT_MS upstream timeout (default 30000)
`;

function parseArgs(argv: string[]): { http: boolean; port: number; host: string; help: boolean } {
  const out = { http: false, port: 7300, host: "127.0.0.1", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") out.http = true;
    else if (a === "--port") out.port = Number(argv[++i]) || out.port;
    else if (a === "--host") out.host = argv[++i] || out.host;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

async function runStdio(): Promise<void> {
  const cfg = loadConfig();
  const server = buildServer(cfg, () => cfg.apiKey);
  await server.connect(new StdioServerTransport());
  // never write to stdout in stdio mode — it would corrupt the JSON-RPC stream
  console.error(`${SERVER_NAME} v${SERVER_VERSION} on stdio (gateway chain: ${cfg.apiBases.join(" -> ")})`);
}

function bearerFrom(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== "string") return undefined;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

/** 1 MiB body ceiling — MCP JSON-RPC requests are tiny; cap before auth so an oversized
 *  or slow POST can't buffer unbounded in the transport (H2). */
const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}

/**
 * Read a request body into a string with a hard byte ceiling enforced on the actual
 * stream — so a chunked client, or one that lies in Content-Length, is caught too.
 * Rejects with BodyTooLargeError once the cap is exceeded; the caller responds 413.
 */
function readBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      fn();
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(() => reject(new BodyTooLargeError()));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    const onError = (e: Error) => finish(() => reject(e));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Hostname of a Host header ("localhost:7300") or an Origin ("http://localhost:7300"). */
function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = value.includes("://") ? new URL(value) : new URL(`http://${value}`);
    return u.hostname;
  } catch {
    return null;
  }
}

function setCors(res: http.ServerResponse, allowOrigin?: string): void {
  if (allowOrigin) res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Aihubmix-Manage-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

/**
 * Stateless Streamable HTTP host: one fresh server+transport pair per POST, so a single
 * hosted instance can serve many users, each authenticated by their own Authorization header.
 * This is the same shape the hosted deployment (mcp.aihubmix.com/mcp) would use, with OAuth
 * in front issuing the per-user keys.
 *
 * When bound to loopback (the dev default) Origin and Host headers are validated against
 * localhost, per the MCP spec's DNS-rebinding guidance: a malicious web page must not be
 * able to reach the server (and its env-key fallback) from the user's browser. Non-loopback
 * binds skip this (hosted mode sits behind a reverse proxy and uses per-request keys).
 */
async function runHttp(host: string, port: number): Promise<void> {
  const cfg = loadConfig();
  const loopbackBind = LOOPBACK_NAMES.has(host);
  if (!loopbackBind && cfg.apiKey) {
    console.error(
      "warning: non-loopback bind with AIHUBMIX_API_KEY set — any unauthenticated request " +
        "will bill this key; hosted deployments should rely on per-request Authorization headers only",
    );
  }
  const sharedClient = new AihubmixClient(cfg); // keeps catalog/status caches across requests
  const httpServer = http.createServer(async (req, res) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (loopbackBind) {
      const originHost = hostnameOf(origin);
      if (origin && (!originHost || !LOOPBACK_NAMES.has(originHost))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden origin (loopback server accepts localhost origins only)" }));
        return;
      }
      const hostHeader = hostnameOf(req.headers.host);
      if (req.headers.host && (!hostHeader || !LOOPBACK_NAMES.has(hostHeader))) {
        res.writeHead(421, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "misdirected request (unexpected Host header)" }));
        return;
      }
    }
    // loopback: echo the validated localhost origin; hosted: public API, any origin
    setCors(res, loopbackBind ? origin : "*");
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found; MCP endpoint is POST /mcp" }));
      return;
    }
    if (req.method !== "POST") {
      // stateless mode: no SSE resumption stream, no server-side sessions to delete
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST, OPTIONS" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed: stateless server, use POST" },
          id: null,
        }),
      );
      return;
    }

    const requestKey = bearerFrom(req) ?? cfg.apiKey;
    // Manage Key for account tools via a dedicated header (Authorization is the sk- key);
    // remote counterpart of stdio's env / CLI-login sources
    const mk = req.headers["x-aihubmix-manage-key"];
    const manageKey = (typeof mk === "string" && mk.trim()) || undefined;
    // which public entrance this call arrived through (LB forwards the original Host)
    const fwdHost = req.headers["x-forwarded-host"];
    const rawHost = (typeof fwdHost === "string" && fwdHost) || req.headers.host || "";
    const entrance = rawHost.split(",")[0].trim().replace(/:\d+$/, "") || undefined;
    // H2: read + size-cap the body ourselves, then hand the parsed JSON to the transport
    // (the SDK uses parsedBody instead of re-reading the stream). Bounds memory before auth.
    const declaredLen = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "request body too large" }, id: null }));
      return;
    }
    let parsedBody: unknown;
    try {
      const raw = await readBodyCapped(req, MAX_BODY_BYTES);
      parsedBody = raw.length ? JSON.parse(raw) : undefined;
    } catch (e) {
      const tooLarge = e instanceof BodyTooLargeError;
      res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json", Connection: "close" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: tooLarge ? -32000 : -32700,
            message: tooLarge ? "request body too large" : "parse error: body is not valid JSON",
          },
          id: null,
        }),
      );
      return;
    }
    const server = buildServer(cfg, () => requestKey, sharedClient, () => entrance, () => manageKey);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (e) {
      console.error("request handling failed:", e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "internal server error" },
            id: null,
          }),
        );
      }
    }
  });

  // H2: bound slow-header / slow-body attacks. requestTimeout covers full request receipt
  // (not response streaming, so long image/video generations are unaffected — the request
  // itself is tiny); headersTimeout caps the header phase.
  httpServer.requestTimeout = 30_000;
  httpServer.headersTimeout = 15_000;

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} on http://${host}:${port}/mcp (gateway chain: ${cfg.apiBases.join(" -> ")}, auth: Authorization header${cfg.apiKey ? " or env key" : ""}${loopbackBind ? ", dns-rebinding protection on" : ""})`,
  );
  const shutdown = () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
} else if (args.http) {
  runHttp(args.host, args.port).catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
} else {
  runStdio().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}
