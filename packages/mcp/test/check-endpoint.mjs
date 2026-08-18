// Check any deployed Streamable HTTP endpoint end-to-end:
//   node test/check-endpoint.mjs http://127.0.0.1:3000/mcp
//   AIHUBMIX_API_KEY=sk-xxx node test/check-endpoint.mjs https://mcp.example.com/mcp
// Runs: /healthz, initialize+tools/list, ping (per-endpoint health), models-list;
// with a key also credits-get (proves per-request Authorization pass-through).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: node test/check-endpoint.mjs <mcp-endpoint-url>");
  process.exit(2);
}
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

// 1) /healthz (derive from the /mcp URL). On shared-hostname path deployments
// /healthz is deliberately NOT exposed publicly — skip with SKIP_HEALTHZ=1.
if (process.env.SKIP_HEALTHZ === "1") {
  console.log("[SKIP] healthz (not publicly routed on this deployment)");
} else {
  try {
    const healthz = new URL(url);
    healthz.pathname = "/healthz";
    const res = await fetch(healthz, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    report("healthz", res.ok && body.ok === true, `${body.name} v${body.version}`);
  } catch (e) {
    report("healthz", false, e.message);
  }
}

// 2) MCP client flow
try {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
  });
  const client = new Client({ name: "endpoint-check", version: "0.0.1" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  report("initialize + tools/list", tools.length >= 10, `${tools.length} tools`);

  const ping = await client.callTool({ name: "ping", arguments: {} });
  const pd = parseJson(ping);
  const up = (pd.endpoints || []).filter((e) => e.reachable).length;
  report("ping (upstream reachability)", pd.ok === true, `entrance=${pd.serving_entrance?.host} active=${pd.active_upstream} up=${up}/${(pd.endpoints || []).length}`);

  const models = await client.callTool({ name: "models-list", arguments: { search: "gpt-5", limit: 3 } });
  const md = parseJson(models);
  report("models-list", !models.isError && md.returned > 0, `matched=${md.total_matched} first=${md.models?.[0]?.model_id}`);

  if (apiKey) {
    const credits = await client.callTool({ name: "credits-get", arguments: {} });
    const cd = parseJson(credits);
    report("credits-get (header auth)", !credits.isError && typeof cd.remaining_usd === "number", `remaining=$${cd.remaining_usd}`);
  } else {
    console.log("[SKIP] credits-get (set AIHUBMIX_API_KEY to test header auth)");
  }

  await client.close();
} catch (e) {
  report("mcp client flow", false, e.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
