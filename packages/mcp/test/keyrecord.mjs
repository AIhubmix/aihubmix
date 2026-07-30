// H4 unit: normalizeKeyRecord must return the PLAINTEXT full_key (gateway-core masks
// `key`), so keys-create hands back a usable sk- value instead of sk-abcd****wxyz.
// Pure transform over synthetic records — no network, no live account, no credential.
// (The live create->disable->delete round-trip lives in keyadmin.mjs, opt-in.)
import { AihubmixClient } from "../dist/aihubmix.js";

let passed = 0;
let failed = 0;
const report = (n, ok, d) => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${n}${d ? ` — ${d}` : ""}`);
  ok ? passed++ : failed++;
};

// Unreachable base so quotaPerUnit() fails fast to its documented fallback — stays offline.
const client = new AihubmixClient({
  apiBases: ["http://127.0.0.1:1"],
  publicBases: ["https://aihubmix.com"],
  docsBase: "https://docs.aihubmix.com",
  enableKeyAdmin: true,
  timeoutMs: 800,
});

const FULL = "sk-abcdEFGH1234ijklMNOP5678wxyz90";

// create path (revealKey=true): gateway-core returns masked `key` + plaintext `full_key`
const created = await client.normalizeKeyRecord({ id: 1, name: "t", status: 1, key: "sk-abcd****wxyz90", full_key: FULL, unlimited_quota: true }, true);
report("H4 create returns the unmasked full_key", created.key === FULL, `key=${created.key}`);
report("H4 returned key carries no mask char", typeof created.key === "string" && !created.key.includes("*"));
report("H4 last4 derived correctly", created.key_last4 === "yz90", `last4=${created.key_last4}`);

// backward-compat: a gateway that puts plaintext in `key` with no full_key still works
const legacy = await client.normalizeKeyRecord({ id: 2, status: 1, key: "sk-PLAINlegacy1234" }, true);
report("H4 falls back to key when no full_key", legacy.key === "sk-PLAINlegacy1234");

// list path (revealKey=false): never exposes the key value, but last4 is still shown
const listed = await client.normalizeKeyRecord({ id: 3, status: 2, key: "sk-abcd****wxyz90", full_key: FULL }, false);
report("list mode hides the key value", listed.key === undefined);
// corroborates H5's premise: gateway-core status 2 == disabled (what keys-update now sends)
report("status 2 reports enabled=false", listed.enabled === false && listed.status === 2);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
