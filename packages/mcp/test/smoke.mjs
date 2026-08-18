// End-to-end smoke test: spawns the stdio server and exercises every tool
// against the live AIHubMix gateway. Requires network; credits-get/chat-send
// additionally need a key (AIHUBMIX_API_KEY, or set SKIP_PAID=1 to skip both).
// chat-send performs one tiny billable completion (SMOKE_CHAT_MODEL, default gpt-4o-mini).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skipPaid = process.env.SKIP_PAID === "1";
const chatModel = process.env.SMOKE_CHAT_MODEL || "gpt-4o-mini";

let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  const mark = ok ? "PASS" : "FAIL";
  if (ok) passed++;
  else failed++;
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function firstText(result) {
  const block = (result.content || []).find((c) => c.type === "text");
  return block ? block.text : "";
}

function parseJson(result) {
  return JSON.parse(firstText(result));
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env },
  stderr: "pipe",
});
const client = new Client({ name: "smoke-test", version: "0.0.1" });
await client.connect(transport);

// tools/list — key-admin write tools must NOT be registered without the opt-in env
try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = [
    "account-get",
    "account-models",
    "chat-send",
    "credits-get",
    "docs-get",
    "docs-search",
    "image-generate",
    "keys-list",
    "model-get",
    "models-list",
    "ping",
    "video-generate",
  ];
  const okNames = JSON.stringify(names) === JSON.stringify(expected);
  report("tools/list (no key-admin)", okNames, `${tools.length} tools: ${names.join(", ")}`);
} catch (e) {
  report("tools/list (no key-admin)", false, e.message);
}

// ping — per-endpoint health across the default failover chain (v0.5 shape:
// endpoint/roles fields, serving_entrance says stdio for local transport)
try {
  const r = await client.callTool({ name: "ping", arguments: {} });
  const data = parseJson(r);
  const ok =
    !r.isError &&
    data.ok === true &&
    Array.isArray(data.endpoints) &&
    data.endpoints.length >= 2 &&
    typeof data.serving_entrance?.host === "string" &&
    data.serving_entrance.host.includes("stdio");
  const summary = (data.endpoints || []).map((e) => `${String(e.endpoint).replace(/^https?:\/\//, "")}:${e.reachable ? `${e.latency_ms}ms` : "down"}`).join(" ");
  report("ping", ok, `entrance=${data.serving_entrance?.host} active=${data.active_upstream} | ${summary}`);
} catch (e) {
  report("ping", false, e.message);
}

// models-list
try {
  const r = await client.callTool({ name: "models-list", arguments: { search: "gpt-5", limit: 5 } });
  const data = parseJson(r);
  const ok = !r.isError && data.returned > 0 && data.models.every((m) => m.model_id);
  report("models-list", ok, `matched=${data.total_matched} first=${data.models?.[0]?.model_id} price_in=${data.models?.[0]?.pricing_usd_per_1m_tokens?.input}`);
} catch (e) {
  report("models-list", false, e.message);
}

// models-list with filters — context_length must be re-sorted numerically
// (upstream sorts it lexicographically, see docs/design.md §5)
try {
  const r = await client.callTool({
    name: "models-list",
    arguments: { type: "llm", features: "function_calling", sort_by: "context_length", sort_order: "desc", limit: 10 },
  });
  const data = parseJson(r);
  const lengths = (data.models || []).map((m) => m.context_length ?? 0);
  const monotonic = lengths.every((v, i) => i === 0 || lengths[i - 1] >= v);
  report(
    "models-list (numeric context sort)",
    !r.isError && data.returned > 0 && monotonic,
    `top: ${data.models?.[0]?.model_id} (${lengths[0]}) … (${lengths[lengths.length - 1]})`,
  );
} catch (e) {
  report("models-list (numeric context sort)", false, e.message);
}

// model-get exact
try {
  const r = await client.callTool({ name: "model-get", arguments: { model_id: "gpt-5-nano" } });
  const data = parseJson(r);
  report("model-get", !r.isError && data.found === true && data.model.model_id === "gpt-5-nano", `context=${data.model?.context_length} out_price=${data.model?.pricing_usd_per_1m_tokens?.output}`);
} catch (e) {
  report("model-get", false, e.message);
}

// model-get miss → suggestions
try {
  const r = await client.callTool({ name: "model-get", arguments: { model_id: "gpt-5-nanoo" } });
  const data = parseJson(r);
  const ok = !r.isError && data.found === false && (data.suggestions || []).length > 0;
  report("model-get (miss→suggestions)", ok, `suggestions=${(data.suggestions || []).slice(0, 3).join(",")}`);
} catch (e) {
  report("model-get (miss→suggestions)", false, e.message);
}

// models-list full-text search: 'reasoning' only appears in descriptions, not model ids
try {
  const r = await client.callTool({ name: "models-list", arguments: { search: "reasoning", limit: 5 } });
  const data = parseJson(r);
  report("models-list (full-text over desc)", !r.isError && data.returned > 0, `matched=${data.total_matched} first=${data.models?.[0]?.model_id}`);
} catch (e) {
  report("models-list (full-text over desc)", false, e.message);
}

// models-list exposes gateway protocol entry points
try {
  const r = await client.callTool({ name: "models-list", arguments: { search: "claude-sonnet-5", limit: 1 } });
  const data = parseJson(r);
  const ep = data.models?.[0]?.endpoints;
  report("models-list (endpoints field)", !r.isError && typeof ep === "string" && ep.includes("claude_api"), `endpoints=${ep}`);
} catch (e) {
  report("models-list (endpoints field)", false, e.message);
}

// account tools, three legitimate states: no credential → setup guidance;
// stale/rejected credential → fix-it guidance naming the source; valid → account data
try {
  const r = await client.callTool({ name: "account-get", arguments: {} });
  if (r.isError) {
    const text = firstText(r);
    const guided = text.includes("aihubmix login") || text.includes("AIHUBMIX_ACCESS_TOKEN");
    report("account-get (error carries guidance)", guided, text.slice(0, 80));
  } else {
    const data = parseJson(r);
    report("account-get (via shared credential)", typeof data.balance_usd === "number", `user=${data.username} balance=$${data.balance_usd} src=${data.credential_source}`);
  }
} catch (e) {
  report("account-get", false, e.message);
}

// docs-search content mode returns snippets from page bodies
try {
  const r = await client.callTool({
    name: "docs-search",
    arguments: { query: "备用域名", lang: "cn", limit: 3, search_content: true },
  });
  const data = parseJson(r);
  const ok = !r.isError && data.mode === "content" && data.returned > 0 && typeof data.results?.[0]?.snippet === "string";
  report("docs-search (content mode)", ok, `top: ${data.results?.[0]?.title} | ${(data.results?.[0]?.snippet || "").slice(0, 50)}…`);
} catch (e) {
  report("docs-search (content mode)", false, e.message);
}

// docs-search
let docUrl;
try {
  const r = await client.callTool({ name: "docs-search", arguments: { query: "claude code", lang: "cn", limit: 5 } });
  const data = parseJson(r);
  docUrl = data.results?.[0]?.url;
  report("docs-search", !r.isError && data.returned > 0, `top: ${data.results?.[0]?.title} → ${docUrl}`);
} catch (e) {
  report("docs-search", false, e.message);
}

// docs-get
try {
  if (!docUrl) throw new Error("no url from docs-search");
  const r = await client.callTool({ name: "docs-get", arguments: { url: docUrl } });
  const text = firstText(r);
  report("docs-get", !r.isError && text.length > 200, `${text.length} chars`);
} catch (e) {
  report("docs-get", false, e.message);
}

// docs-get SSRF guard
try {
  const r = await client.callTool({ name: "docs-get", arguments: { url: "https://example.com/x.md" } });
  report("docs-get (origin guard)", r.isError === true, firstText(r).slice(0, 80));
} catch (e) {
  report("docs-get (origin guard)", false, e.message);
}

if (skipPaid) {
  console.log("[SKIP] credits-get, chat-send (SKIP_PAID=1)");
} else {
  // credits-get
  try {
    const r = await client.callTool({ name: "credits-get", arguments: {} });
    const data = parseJson(r);
    const ok = !r.isError && (typeof data.remaining_usd === "number" || typeof data.used_usd === "number");
    report("credits-get", ok, `remaining=$${data.remaining_usd} used=$${data.used_usd}`);
  } catch (e) {
    report("credits-get", false, e.message);
  }

  // chat-send
  try {
    const r = await client.callTool({
      name: "chat-send",
      arguments: { model: chatModel, prompt: "Reply with exactly one word: pong", max_tokens: 64, temperature: 0 },
    });
    const data = parseJson(r);
    // the tool's contract is transport + parsing, not model obedience: any non-empty
    // reply with usage attached counts as a pass
    const ok =
      !r.isError &&
      typeof data.content === "string" &&
      data.content.length > 0 &&
      data.usage != null &&
      typeof data.estimated_cost_usd === "number";
    report("chat-send", ok, `model=${data.model} reply=${JSON.stringify(data.content).slice(0, 30)} cost=$${data.estimated_cost_usd}`);
  } catch (e) {
    report("chat-send", false, e.message);
  }

  // multi-turn messages form
  try {
    const r = await client.callTool({
      name: "chat-send",
      arguments: {
        model: chatModel,
        messages: [
          { role: "user", content: "My name is YOYO." },
          { role: "assistant", content: "Hi YOYO!" },
          { role: "user", content: "Reply with exactly my name." },
        ],
        max_tokens: 24,
        temperature: 0,
      },
    });
    const data = parseJson(r);
    const ok = !r.isError && typeof data.content === "string" && data.content.toLowerCase().includes("yoyo");
    report("chat-send (multi-turn messages)", ok, `reply=${JSON.stringify(data.content).slice(0, 30)}`);
  } catch (e) {
    report("chat-send (multi-turn messages)", false, e.message);
  }

  // chat-send on a reasoning model with a tiny cap: either visible text came back,
  // or the empty reply must carry the explanatory note
  try {
    const r = await client.callTool({
      name: "chat-send",
      arguments: { model: "gpt-5-nano", prompt: "Reply with exactly one word: pong", max_tokens: 24 },
    });
    const data = parseJson(r);
    const ok = !r.isError && (data.content !== "" || typeof data.note === "string");
    report("chat-send (reasoning-model empty-reply note)", ok, data.note ? `note present, finish=${data.finish_reason}` : `reply=${JSON.stringify(data.content).slice(0, 30)}`);
  } catch (e) {
    report("chat-send (reasoning-model empty-reply note)", false, e.message);
  }
}

await client.close();

// key-admin opt-in: a second server WITH the flag must expose the 3 write tools
try {
  const t2 = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    env: { ...process.env, AIHUBMIX_ENABLE_KEY_ADMIN: "1" },
    stderr: "pipe",
  });
  const c2 = new Client({ name: "smoke-admin", version: "0.0.1" });
  await c2.connect(t2);
  const { tools } = await c2.listTools();
  const names = tools.map((t) => t.name);
  const hasWrites = ["keys-create", "keys-update", "keys-delete"].every((n) => names.includes(n));
  report("tools/list (key-admin opt-in)", tools.length === 15 && hasWrites, `${tools.length} tools`);
  const del = tools.find((t) => t.name === "keys-delete");
  report("keys-delete destructiveHint", del?.annotations?.destructiveHint === true);
  await c2.close();
} catch (e) {
  report("tools/list (key-admin opt-in)", false, e.message);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
