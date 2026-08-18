// Deterministic endpoint-failover test: the primary base points at a dead local
// port (instant ECONNREFUSED), the fallback is the real api.inferera.com. Verifies
// the self-healing behavior end-to-end: ping reports per-endpoint health, GETs fail
// over transparently (with endpoint_note), stickiness avoids repeat penalties, and
// chat-send (billable POST) fails over on connect-phase errors as its FIRST call.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEAD_PRIMARY = "http://127.0.0.1:59999"; // closed port → instant ECONNREFUSED (NB: low ports like 9 sit on the fetch-spec bad-port list and error without dialing)
const CHAIN = `${DEAD_PRIMARY},https://api.inferera.com`;
const skipPaid = process.env.SKIP_PAID === "1" || !process.env.AIHUBMIX_API_KEY;

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

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env: { ...process.env, AIHUBMIX_API_BASE: CHAIN, ...extraEnv },
    stderr: "pipe",
  });
  const client = new Client({ name: "failover-test", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

// --- server A: ping first, then GET failover + stickiness
{
  const client = await connect();

  try {
    const r = await client.callTool({ name: "ping", arguments: {} });
    const data = parseJson(r);
    const dead = data.endpoints?.find((e) => e.endpoint === DEAD_PRIMARY);
    const alive = data.endpoints?.find((e) => e.endpoint !== DEAD_PRIMARY && e.roles?.includes("upstream"));
    const ok =
      data.ok === true && dead?.reachable === false && alive?.reachable === true && data.active_upstream === alive.endpoint;
    report("ping per-endpoint health", ok, `dead=${dead?.reachable} alive=${alive?.reachable} active=${data.active_upstream}`);
  } catch (e) {
    report("ping per-endpoint health", false, e.message);
  }

  try {
    const t0 = Date.now();
    const r = await client.callTool({ name: "models-list", arguments: { search: "gpt-5-nano", limit: 2 } });
    const data = parseJson(r);
    const ok = !r.isError && data.returned > 0 && typeof data.endpoint_note === "string";
    report("models-list via fallback + endpoint_note", ok, `${Date.now() - t0}ms note=${(data.endpoint_note || "").slice(0, 40)}…`);
  } catch (e) {
    report("models-list via fallback + endpoint_note", false, e.message);
  }

  try {
    const t0 = Date.now();
    const r = await client.callTool({ name: "model-get", arguments: { model_id: "gpt-5-nano" } });
    const data = parseJson(r);
    const elapsed = Date.now() - t0;
    // sticky: no dead-primary penalty on subsequent calls (generous bound for slow networks)
    const ok = !r.isError && data.found === true && elapsed < 9_000;
    report("sticky fallback (no repeat penalty)", ok, `${elapsed}ms`);
  } catch (e) {
    report("sticky fallback (no repeat penalty)", false, e.message);
  }

  await client.close();
}

// --- server B: fresh process, GET failover without a prior ping
{
  const client = await connect();
  try {
    const r = await client.callTool({ name: "models-list", arguments: { limit: 1 } });
    const data = parseJson(r);
    const ok = !r.isError && data.returned > 0 && typeof data.endpoint_note === "string";
    report("cold-start GET failover (no ping first)", ok, (data.endpoint_note || "").slice(0, 50));
  } catch (e) {
    report("cold-start GET failover (no ping first)", false, e.message);
  }
  await client.close();
}

// --- server C: fresh process, chat-send as the FIRST call (connect-phase POST failover)
if (skipPaid) {
  console.log("[SKIP] chat-send connect-phase failover (SKIP_PAID=1 or no key)");
} else {
  const client = await connect();
  try {
    const r = await client.callTool({
      name: "chat-send",
      arguments: { model: "gpt-4o-mini", prompt: "Reply with exactly one word: pong", max_tokens: 32, temperature: 0 },
    });
    const data = parseJson(r);
    const ok = !r.isError && typeof data.content === "string" && data.content.length > 0 && typeof data.endpoint_note === "string";
    report("chat-send connect-phase failover", ok, `reply=${JSON.stringify(data.content).slice(0, 24)} note=${(data.endpoint_note || "").slice(0, 30)}…`);
  } catch (e) {
    report("chat-send connect-phase failover", false, e.message);
  }
  await client.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
