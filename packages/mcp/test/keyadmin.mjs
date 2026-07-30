// H4/H5 write-tool round-trip — the 3 key-admin tools the smoke test only checks
// for *registration*. Opt-in and self-cleaning: it creates a throwaway low-quota key,
// verifies the fixes, then deletes it.
//
//   H4 (keys-create): the returned key must be the PLAINTEXT full_key (usable), not
//       the gateway's masked `sk-abcd****wxyz`.
//   H5 (keys-update): enabled:false must actually disable the key (status -> 2), not
//       silently no-op (the old `status = 0` was read by gateway-core as "unchanged").
//
// Requires a real Manage Key and an explicit opt-in, since it mutates a live account:
//   RUN_KEY_ADMIN=1  AIHUBMIX_ACCESS_TOKEN=<manage key>  [AIHUBMIX_API_BASE=<subsite>]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

if (process.env.RUN_KEY_ADMIN !== "1" || !process.env.AIHUBMIX_ACCESS_TOKEN) {
  console.log("[SKIP] key-admin round-trip — set RUN_KEY_ADMIN=1 and AIHUBMIX_ACCESS_TOKEN (mutates a live account)");
  process.exit(0);
}

let passed = 0;
let failed = 0;
const report = (name, ok, detail) => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};
const parseJson = (r) => JSON.parse((r.content || []).find((c) => c.type === "text")?.text || "{}");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env, AIHUBMIX_ENABLE_KEY_ADMIN: "1" },
  stderr: "pipe",
});
const client = new Client({ name: "keyadmin-test", version: "0.0.1" });
await client.connect(transport);

const keyName = `mcp-h4h5-test-${Date.now().toString(36)}`;
let createdId;
try {
  // H4 — create returns the usable plaintext key
  const cr = await client.callTool({
    name: "keys-create",
    arguments: { name: keyName, quota_usd: 0.1, expires_in_days: 1 },
  });
  if (cr.isError) throw new Error(`keys-create failed: ${parseJson(cr) || (cr.content?.[0]?.text ?? "")}`);
  const created = parseJson(cr);
  createdId = created.id;
  const key = created.key;
  const h4ok = typeof key === "string" && key.startsWith("sk-") && !key.includes("*") && key.length >= 20;
  report("H4 keys-create returns unmasked full_key", h4ok, `key=${key ? `${key.slice(0, 6)}…${key.slice(-4)} (len ${key.length}, mask=${key.includes("*")})` : key}  id=${createdId}`);

  // H5 — disable must take effect (not a silent no-op)
  const up = await client.callTool({ name: "keys-update", arguments: { id: createdId, enabled: false } });
  report("keys-update disable call ok", !up.isError, up.isError ? parseJson(up) : "");
  const after = parseJson(await client.callTool({ name: "keys-list", arguments: {} }));
  const row = (after.keys || []).find((k) => k.id === createdId);
  const h5ok = row && row.enabled === false;
  report("H5 keys-update enabled:false actually disables", !!h5ok, row ? `enabled=${row.enabled} status=${row.status} (expect status 2)` : "key not found in list");

  // sanity: re-enable works too
  await client.callTool({ name: "keys-update", arguments: { id: createdId, enabled: true } });
  const rerow = (parseJson(await client.callTool({ name: "keys-list", arguments: {} })).keys || []).find((k) => k.id === createdId);
  report("keys-update re-enable", rerow && rerow.enabled === true, rerow ? `enabled=${rerow.enabled} status=${rerow.status}` : "not found");
} catch (e) {
  report("key-admin round-trip", false, e.message);
} finally {
  // self-clean: delete the throwaway key
  if (createdId != null) {
    try {
      const del = await client.callTool({ name: "keys-delete", arguments: { id: createdId } });
      report("keys-delete cleanup", !del.isError && parseJson(del).deleted === true, `id=${createdId}`);
    } catch (e) {
      report("keys-delete cleanup", false, `LEFTOVER key id=${createdId} name=${keyName} — delete manually: ${e.message}`);
    }
  }
  await client.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
