// HTTP-mode smoke test: boots the Streamable HTTP server on a scratch port and
// talks to it with the SDK client, passing the API key via the Authorization
// header exactly as a hosted deployment would.
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_HTTP_PORT || 7391);
const apiKey = process.env.AIHUBMIX_API_KEY || "";

let passed = 0;
let failed = 0;
function report(name, ok, detail) {
  const mark = ok ? "PASS" : "FAIL";
  if (ok) passed++;
  else failed++;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function parseJson(result) {
  const block = (result.content || []).find((c) => c.type === "text");
  return JSON.parse(block ? block.text : "{}");
}

// boot the server WITHOUT the env key: the Authorization header must be the
// only credential path, proving per-request auth works for hosted mode
const env = { ...process.env };
delete env.AIHUBMIX_API_KEY;
const proc = spawn(process.execPath, [path.join(root, "dist", "index.js"), "--http", "--port", String(PORT)], {
  env,
  stdio: ["ignore", "ignore", "pipe"],
});
let bootLog = "";
proc.stderr.on("data", (d) => (bootLog += d.toString()));

// wait for /healthz
const deadline = Date.now() + 15_000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}
report("http boot (/healthz)", healthy, healthy ? `port ${PORT}` : bootLog.slice(0, 200));
if (!healthy) {
  proc.kill();
  process.exit(1);
}

// DNS-rebinding / CSRF protection on loopback binds:
// a browser-originated cross-site request must be rejected before any tool runs
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
  });
  report("http rejects foreign Origin", res.status === 403, `status=${res.status}`);
} catch (e) {
  report("http rejects foreign Origin", false, e.message);
}

// rebinding via Host header (evil.com resolving to 127.0.0.1) must also be rejected
try {
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const r = request(
      { host: "127.0.0.1", port: PORT, path: "/healthz", method: "GET", headers: { Host: "evil.example.com" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    r.on("error", reject);
    r.end();
  });
  report("http rejects foreign Host", status === 421, `status=${status}`);
} catch (e) {
  report("http rejects foreign Host", false, e.message);
}

// a localhost origin (e.g. a local web-based MCP inspector) must still be allowed
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, {
    headers: { Origin: `http://localhost:${PORT}` },
  });
  const acao = res.headers.get("access-control-allow-origin");
  report("http allows localhost Origin", res.ok && acao === `http://localhost:${PORT}`, `ACAO=${acao}`);
} catch (e) {
  report("http allows localhost Origin", false, e.message);
}

// H2: body-size cap — an oversized POST is rejected (413) before auth or buffering
try {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: "a".repeat(1_100_000), // > 1 MiB
  });
  report("http rejects oversized body (413)", res.status === 413, `status=${res.status}`);
} catch (e) {
  report("http rejects oversized body (413)", false, e.message);
}

try {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
  });
  const client = new Client({ name: "smoke-http", version: "0.0.1" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  report("http tools/list", tools.length === 12, `${tools.length} tools`);

  const ping = await client.callTool({ name: "ping", arguments: {} });
  report("http ping", !ping.isError && parseJson(ping).ok === true);

  const models = await client.callTool({ name: "models-list", arguments: { search: "claude", limit: 3 } });
  const md = parseJson(models);
  report("http models-list", !models.isError && md.returned > 0, `first=${md.models?.[0]?.model_id}`);

  // H2: zod length cap — an over-long docs-search query is refused by input validation
  // (before any docs fetch), so an unauthenticated caller can't drive the content scan
  let capRejected = false;
  try {
    const r = await client.callTool({ name: "docs-search", arguments: { query: "x".repeat(400) } });
    capRejected = r.isError === true;
  } catch {
    capRejected = true; // SDK surfaces a schema violation as a thrown JSON-RPC error
  }
  report("http docs-search query length cap (max 300)", capRejected);

  if (apiKey) {
    // key arrives via Authorization header only (env was stripped at boot)
    const credits = await client.callTool({ name: "credits-get", arguments: {} });
    const cd = parseJson(credits);
    report("http credits-get (header auth)", !credits.isError && typeof cd.remaining_usd === "number", `remaining=$${cd.remaining_usd}`);
  } else {
    // no header, no env → must fail with a clear message
    const credits = await client.callTool({ name: "credits-get", arguments: {} });
    report("http credits-get (no key → clear error)", credits.isError === true);
  }

  await client.close();
} catch (e) {
  report("http client flow", false, e.message);
}

// account tools accept the Manage Key via the X-Aihubmix-Manage-Key header (remote mode).
// A bogus token must reach the gateway and come back labeled with that source.
try {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
    requestInit: { headers: { "X-Aihubmix-Manage-Key": "fd-bogus-smoke-token" } },
  });
  const client = new Client({ name: "smoke-http-mk", version: "0.0.1" });
  await client.connect(transport);
  const r = await client.callTool({ name: "account-get", arguments: {} });
  const text = (r.content || []).find((c) => c.type === "text")?.text || "";
  report("http account-get (manage-key header channel)", r.isError === true && /request header/.test(text), text.slice(0, 60));
  await client.close();
} catch (e) {
  report("http account-get (manage-key header channel)", false, e.message);
}

proc.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
